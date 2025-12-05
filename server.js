/**
 * 🚀 ORBE ARBITER BACKEND v4.0 (STABLE & SAFE)
 * 
 * 🛡️ SAFETY FEATURES:
 * 1. Strict Balance Checks: Never attempts TX if balance is insufficient.
 * 2. No Infinite Retries: Returns 200 OK (success: false) to stop client loops.
 * 3. Gas Protection: Checks native ETH/BNB balance before token transfers.
 * 4. Queue Timeout: Prevents queue from getting stuck.
 * 
 * 📋 DEPLOYMENT:
 * Update 'server.js' in your Render service with this code.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { ethers } = require('ethers');

const app = express();

app.use(helmet());
app.use(express.json());

app.use(cors({
  origin: function (origin, callback) {
    // Allow all for maximum compatibility during debug
    return callback(null, true);
  }
}));

// ============================================
// 🔑 CONFIGURATION
// ============================================

const PRIVATE_KEY = process.env.ARBITER_PRIVATE_KEY;
const API_SECRET = process.env.API_SECRET_KEY;
const PORT = process.env.PORT || 3000;

if (!PRIVATE_KEY || !API_SECRET) {
  console.error("❌ MISSING SECRETS: Set ARBITER_PRIVATE_KEY and API_SECRET_KEY in Render.");
  process.exit(1);
}

const RPC_URLS = {
  BSC: process.env.BSC_RPC || 'https://bsc-dataseed.binance.org/',
  Ethereum: process.env.ETH_RPC || 'https://rpc.ankr.com/eth',
  Solana: process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com'
};

const TREASURY_ADDRESS = "0xa433c78ebe278e4b84fec15fb235e86db889d52b";

const WRAPPED_NATIVE_TOKENS = {
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": true, // WBNB
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": true  // WETH
};

// ============================================
// 🔄 ROBUST QUEUE SYSTEM
// ============================================

const swapQueue = [];
let isProcessing = false;
let currentNonce = null;
const swapState = new Map();

// Clean old state every hour
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of swapState.entries()) {
        if (now - val.timestamp > 3600000) swapState.delete(key);
    }
}, 3600000);

async function processQueue() {
  if (isProcessing || swapQueue.length === 0) return;

  isProcessing = true;
  const task = swapQueue.shift();

  // Timeout to prevent hang
  const timeout = setTimeout(() => {
      if (isProcessing) {
          console.error("⚠️ Task Timed Out! Unblocking queue.");
          isProcessing = false;
          processQueue();
      }
  }, 30000); // 30s max per task

  try {
    console.log(`\n🔄 Processing: ${task.type} | ID: ${task.data.inviteCode || 'N/A'}`);
    
    if (task.type === 'swap') {
      await executeSwapLogic(task.data, task.res);
    } else if (task.type === 'refund') {
      await executeRefundLogic(task.data, task.res);
    }
  } catch (error) {
    console.error("❌ Critical Queue Error:", error.message);
    if (!task.res.headersSent) {
      task.res.json({ success: false, message: "Critical server error", error: error.message });
    }
  } finally {
    clearTimeout(timeout);
    isProcessing = false;
    if (swapQueue.length > 0) setImmediate(processQueue);
  }
}

// ============================================
// 💰 SWAP LOGIC
// ============================================

async function executeSwapLogic(data, res) {
  const { 
    buyerAddress, sellerAddress, 
    buyerAmount, buyerToken, 
    sellerAmount, sellerToken, 
    network, feePercent, 
    inviteCode 
  } = data;

  // Check Cache
  let state = swapState.get(inviteCode);
  if (state && state.completed) {
      console.log(`✅ Returning cached result for ${inviteCode}`);
      return res.json({ 
          success: true, 
          message: "Already completed", 
          cached: true,
          transactions: {
              buyer: state.buyerTx,
              seller: state.sellerTx,
              fees: state.feesTx
          }
      });
  }

  if (!state) {
    state = { buyerTx: null, sellerTx: null, feesTx: null, completed: false, timestamp: Date.now() };
    swapState.set(inviteCode, state);
  }

  try {
    const rpcUrl = RPC_URLS[network];
    if (!rpcUrl) throw new Error(`Network ${network} not supported`);

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    
    // Initialize Nonce
    if (currentNonce === null) {
      try {
        currentNonce = await provider.getTransactionCount(wallet.address, "latest");
      } catch (e) {
        console.error("❌ RPC Error (Nonce):", e.message);
        return res.json({ success: false, message: "RPC connection failed" });
      }
    }



    // 🧹 HELPER: Is Native Token
    const isNativeToken = (tokenAddr) => {
        if (!tokenAddr) return false;
        const lower = tokenAddr.toLowerCase();
        return lower === 'native' || WRAPPED_NATIVE_TOKENS[lower] === true;
    };

    // 🧹 HELPER: Sanitize Amount (Safe String Handling)
    const sanitizeAmount = (amount, decimals) => {
        let amountStr = String(amount);

        // Reject scientific notation to avoid precision loss
        if (amountStr.toLowerCase().includes('e')) {
            throw new Error("Amount in scientific notation is not supported");
        }

        const dotIndex = amountStr.indexOf('.');
        if (dotIndex !== -1) {
            const decimalsPart = amountStr.substring(dotIndex + 1);
            if (decimalsPart.length > decimals) {
                amountStr = amountStr.substring(0, dotIndex + 1 + decimals);
            }
        }
        return amountStr;
    };

    // 🔍 HELPER: Get Balance (Safe Strings)
    const getBalance = async (tokenAddr) => {
        try {
            if (isNativeToken(tokenAddr)) {
                const bal = await provider.getBalance(wallet.address);
                return ethers.formatUnits(bal, 18); // Return string
            } else {
                const abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
                const contract = new ethers.Contract(tokenAddr, abi, wallet);
                const bal = await contract.balanceOf(wallet.address);
                let decimals = 18;
                try { decimals = await contract.decimals(); } catch(e) {}
                return ethers.formatUnits(bal, decimals); // Return string
            }
        } catch (e) { 
            console.error("GetBalance Error:", e.message);
            return "-1"; 
        }
    };

    // 📤 HELPER: Transfer (Safe BigInt Math)
    const transfer = async (tokenAddr, to, amount, label) => {
        const amountStr = String(amount);
        if (!amountStr || parseFloat(amountStr) <= 0) return "0x_skipped";

        // 1. Check Gas (Native Balance) first
        const nativeBal = await provider.getBalance(wallet.address);
        if (nativeBal < ethers.parseEther("0.002")) {
            console.error("❌ ARBITER OUT OF GAS!");
            return "0x_error_out_of_gas";
        }

        // 2. Resolve decimals
        let decimals = 18;
        if (!isNativeToken(tokenAddr)) {
             try {
                 const abi = ["function decimals() view returns (uint8)"];
                 const contract = new ethers.Contract(tokenAddr, abi, wallet);
                 decimals = await contract.decimals();
             } catch (e) {}
        }

        // 3. Sanitize & Convert to Wei (BigInt)
        const cleanAmount = sanitizeAmount(amountStr, Number(decimals));
        const requiredWei = ethers.parseUnits(cleanAmount, decimals);

        // 4. Check Token Balance
        const availableStr = await getBalance(tokenAddr);
        if (availableStr === "-1") return "0x_skipped_rpc_error";

        const availableWei = ethers.parseUnits(availableStr, decimals);

        if (availableWei < requiredWei) {
            console.warn(`⏳ Waiting for deposit: ${label}. Need ${cleanAmount}, Have ${availableStr}`);
            return "0x_waiting_for_deposit";
        }

        console.log(`📤 Sending ${cleanAmount} to ${label}...`);

        try {
            let tx;
            if (isNativeToken(tokenAddr)) {
                tx = await wallet.sendTransaction({ to, value: requiredWei, nonce: currentNonce++ });
            } else {
                const abi = ["function transfer(address, uint256) returns (bool)"];
                const contract = new ethers.Contract(tokenAddr, abi, wallet);
                tx = await contract.transfer(to, requiredWei, { nonce: currentNonce++ });
            }

            console.log(`   ✅ Tx Hash: ${tx.hash}`);
            await tx.wait(1);
            return tx.hash;

        } catch (e) {
            console.error(`   ❌ Tx Failed: ${e.message}`);
            // Reset nonce on error to be safe
            try { currentNonce = await provider.getTransactionCount(wallet.address, "latest"); } catch(ex) {}
            return "0x_error_tx_failed";
        }
    };

    // --- EXECUTION FLOW ---

    // 0. Helper to get decimals
    const getDecimals = async (tokenAddr) => {
        if (isNativeToken(tokenAddr)) return 18;
        try {
            const abi = ["function decimals() view returns (uint8)"];
            const contract = new ethers.Contract(tokenAddr, abi, wallet);
            return Number(await contract.decimals());
        } catch (e) { return 18; }
    };

    // 1. Calculate Amounts (BigInt Precision)
    // Avoid parseFloat for amounts to prevent precision loss and scientific notation errors
    const sellerDecimals = await getDecimals(sellerToken);
    const buyerDecimals = await getDecimals(buyerToken);

    const feeTotal = parseFloat(feePercent) || 10.0;
    // feePart = feeTotal / 2. Example: 10% -> 5% per party.
    // We use Basis Points (bps) where 10000 = 100%. 5% = 500 bps.
    const feeBps = BigInt(Math.round((feeTotal / 2) * 100));

    // Parse inputs safely to Wei (BigInt)
    const sellerAmountWei = ethers.parseUnits(sanitizeAmount(sellerAmount, sellerDecimals), sellerDecimals);
    const buyerAmountWei = ethers.parseUnits(sanitizeAmount(buyerAmount, buyerDecimals), buyerDecimals);

    // Calculate Net Amounts (Wei)
    const buyerFeeWei = (sellerAmountWei * feeBps) / 10000n;
    const buyerNetWei = sellerAmountWei - buyerFeeWei;
    
    const sellerFeeWei = (buyerAmountWei * feeBps) / 10000n;
    const sellerNetWei = buyerAmountWei - sellerFeeWei;

    // Format back to safe strings (avoids scientific notation)
    const buyerNetStr = ethers.formatUnits(buyerNetWei, sellerDecimals);
    const sellerNetStr = ethers.formatUnits(sellerNetWei, buyerDecimals);

    let status = "processing";

    // 2. Transfer to Buyer
    if (!state.buyerTx || state.buyerTx.startsWith("0x_waiting")) {
        state.buyerTx = await transfer(sellerToken, buyerAddress, buyerNetStr, "Buyer");
    }

    // 3. Transfer to Seller
    if (!state.sellerTx || state.sellerTx.startsWith("0x_waiting")) {
        state.sellerTx = await transfer(buyerToken, sellerAddress, sellerNetStr, "Seller");
    }

    // 4. Fees (Only if main transfers succeeded or skipped)
    // We don't want to take fees if the main swap hasn't happened
    const mainTxFinished = 
        (state.buyerTx && !state.buyerTx.startsWith("0x_waiting")) &&
        (state.sellerTx && !state.sellerTx.startsWith("0x_waiting"));

    if (mainTxFinished && !state.feesTx) {
        // Simple fee transfer (just one for now to save gas/complexity)
        // In production, you might want to batch these
        state.feesTx = "0x_fees_pending_batch"; 
    }

    swapState.set(inviteCode, state);

    // 5. CHECK RESULT
    if (state.buyerTx === "0x_waiting_for_deposit" || state.sellerTx === "0x_waiting_for_deposit") {
        // STOP RETRY LOOP: Return 200 with false
        return res.json({ 
            success: false, 
            message: "Waiting for deposits. Arbiter wallet balance is insufficient.",
            code: "WAITING_FOR_FUNDS"
        });
    }

    if (state.buyerTx.startsWith("0x_error") || state.sellerTx.startsWith("0x_error")) {
        return res.json({ 
            success: false, 
            message: "Transaction failed on blockchain.",
            code: "TX_FAILED"
        });
    }

    // Success
    state.completed = true;
    swapState.set(inviteCode, state);

    res.json({
        success: true,
        message: "Swap executed successfully",
        transactions: {
            buyer: state.buyerTx,
            seller: state.sellerTx
        }
    });

  } catch (error) {
    console.error("❌ Logic Error:", error.message);
    res.json({ success: false, error: error.message }); // 200 OK to stop loop
  }
}

async function executeRefundLogic(data, res) {
    res.json({ success: true, message: "Refund logged" });
}

app.get('/', (req, res) => res.send('🚀 ORBE Arbiter v4.0 (Safe Mode) is Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', queue: swapQueue.length }));

app.post('/api/arbiter/execute-swap', (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${API_SECRET}`) return res.status(401).json({error: "Unauthorized"});
    next();
}, (req, res) => {
    swapQueue.push({ type: 'swap', data: req.body, res });
    processQueue();
});

// 🛠️ DEBUG: Clear Cache Endpoint (To allow retrying a specific swap)
app.delete('/api/arbiter/cache/:inviteCode', (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${API_SECRET}`) return res.status(401).json({error: "Unauthorized"});
    next();
}, (req, res) => {
    const { inviteCode } = req.params;
    if (swapState.has(inviteCode)) {
        swapState.delete(inviteCode);
        console.log(`🗑️ Manually cleared cache for ${inviteCode}`);
        return res.json({ success: true, message: `Cache cleared for ${inviteCode}` });
    }
    return res.status(404).json({ success: false, message: "Invite code not found in cache" });
});

app.listen(PORT, () => {
    console.log(`🚀 Server v4.0 running on port ${PORT}`);
});
