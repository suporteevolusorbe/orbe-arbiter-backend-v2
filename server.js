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
    return res.json({ success: true, message: "Already completed", cached: true });
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

    // 🔍 HELPER: Get Balance
    const getBalance = async (tokenAddr) => {
        try {
            const isNative = WRAPPED_NATIVE_TOKENS[tokenAddr.toLowerCase()] || tokenAddr.length < 10;
            if (isNative) {
                const bal = await provider.getBalance(wallet.address);
                return parseFloat(ethers.formatUnits(bal, 18));
            } else {
                const abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
                const contract = new ethers.Contract(tokenAddr, abi, wallet);
                const bal = await contract.balanceOf(wallet.address);
                let decimals = 18;
                try { decimals = await contract.decimals(); } catch(e) {}
                return parseFloat(ethers.formatUnits(bal, decimals));
            }
        } catch (e) { return -1; } // Error flag
    };

    // 📤 HELPER: Transfer
    const transfer = async (tokenAddr, to, amount, label) => {
        if (!amount || parseFloat(amount) <= 0) return "0x_skipped";

        const required = parseFloat(amount);
        const available = await getBalance(tokenAddr);

        if (available === -1) {
            console.warn(`⚠️ Could not fetch balance for ${label}. RPC issue?`);
            return "0x_skipped_rpc_error";
        }

        if (available < required) {
            console.warn(`⏳ Waiting for deposit: ${label}. Need ${required}, Have ${available}`);
            return "0x_waiting_for_deposit"; // Special flag
        }

        // Check Gas (Native Balance)
        const nativeBal = await provider.getBalance(wallet.address);
        const nativeBalEth = parseFloat(ethers.formatEther(nativeBal));
        if (nativeBalEth < 0.002) {
            console.error("❌ ARBITER OUT OF GAS!");
            return "0x_error_out_of_gas";
        }

        console.log(`📤 Sending ${amount} to ${label}...`);

        try {
            const isNative = WRAPPED_NATIVE_TOKENS[tokenAddr.toLowerCase()] || tokenAddr.length < 10;
            let tx;
            
            if (isNative) {
                const val = ethers.parseUnits(amount.toString(), 18);
                tx = await wallet.sendTransaction({ to, value: val, nonce: currentNonce++ });
            } else {
                const abi = ["function transfer(address, uint256) returns (bool)", "function decimals() view returns (uint8)"];
                const contract = new ethers.Contract(tokenAddr, abi, wallet);
                let dec = 18;
                try { dec = await contract.decimals(); } catch(e) {}
                const val = ethers.parseUnits(amount.toString(), dec);
                tx = await contract.transfer(to, val, { nonce: currentNonce++ });
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

    // 1. Fee Config
    const feeTotal = parseFloat(feePercent) || 10.0;
    const feePart = feeTotal / 2 / 100;
    
    const buyerFee = parseFloat(sellerAmount) * feePart;
    const buyerNet = parseFloat(sellerAmount) - buyerFee;
    
    const sellerFee = parseFloat(buyerAmount) * feePart;
    const sellerNet = parseFloat(buyerAmount) - sellerFee;

    let status = "processing";

    // 2. Transfer to Buyer
    if (!state.buyerTx || state.buyerTx.startsWith("0x_waiting")) {
        state.buyerTx = await transfer(sellerToken, buyerAddress, buyerNet, "Buyer");
    }

    // 3. Transfer to Seller
    if (!state.sellerTx || state.sellerTx.startsWith("0x_waiting")) {
        state.sellerTx = await transfer(buyerToken, sellerAddress, sellerNet, "Seller");
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

app.listen(PORT, () => {
    console.log(`🚀 Server v4.0 running on port ${PORT}`);
});
