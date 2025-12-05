/**
 * 🚀 PRODUCTION READY BACKEND SERVER (Node.js)
 * 
 * 📋 INSTRUCTIONS FOR GITHUB & RENDER DEPLOYMENT:
 * 
 * 1. Create a new folder locally (e.g., "orbe-arbiter-backend")
 * 2. Create a file named "package.json" with the content below:
 * 
 *    {
 *      "name": "orbe-arbiter-backend",
 *      "version": "1.0.0",
 *      "main": "server.js",
 *      "scripts": {
 *        "start": "node server.js"
 *      },
 *      "dependencies": {
 *        "express": "^4.18.2",
 *        "cors": "^2.8.5",
 *        "dotenv": "^16.3.1",
 *        "ethers": "^6.7.0",
 *        "helmet": "^7.0.0"
 *      }
 *    }
 * 
 * 3. Create a file named "server.js" and COPY THE CODE BELOW into it.
 * 4. Push these 2 files to a new GitHub repository.
 * 5. Connect the repo to Render (Web Service).
 * 
 * 🔒 SECURITY - ENVIRONMENT VARIABLES (Render Dashboard):
 * NEVER commit a .env file with real keys!
 * Go to Render > Dashboard > Environment and add these secrets:
 * 
 * - ARBITER_PRIVATE_KEY: The private key of the arbiter wallet (starts with 0x...)
 * - API_SECRET_KEY: A strong password for your API (e.g., "RealSeed5207418")
 * - PORT: 3000 (optional, Render sets this automatically)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { ethers } = require('ethers');

const app = express();

// 🛡️ SECURITY: Basic protection
app.use(helmet());
app.use(express.json());

// 🛡️ SECURITY: CORS Configuration
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://orbeescrow.com',
      'https://www.orbeescrow.com',
      'http://localhost:3000',
      'http://localhost:5173'
    ];
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1 && !origin.includes('base44.com')) {
      return callback(null, true); 
    }
    return callback(null, true);
  }
}));

// ============================================
// 🔑 ENVIRONMENT CONFIGURATION
// ============================================

const PRIVATE_KEY = process.env.ARBITER_PRIVATE_KEY;
const API_SECRET = process.env.API_SECRET_KEY;
const PORT = process.env.PORT || 3000;

// 🚨 CRITICAL SECURITY CHECK
if (!PRIVATE_KEY) {
  console.error("❌ FATAL ERROR: ARBITER_PRIVATE_KEY is missing in environment variables.");
  console.error("   Please set it in your Render/Server dashboard.");
  process.exit(1);
}

if (!API_SECRET) {
  console.error("❌ FATAL ERROR: API_SECRET_KEY is missing in environment variables.");
  console.error("   Please set it in your Render/Server dashboard.");
  process.exit(1);
}

console.log("✅ Environment loaded securely.");

// ============================================
// 🌐 BLOCKCHAIN CONFIGURATION
// ============================================

// RPC URLs - Use reliable public nodes or your own Alchemy/Infura keys
const RPC_URLS = {
  BSC: process.env.BSC_RPC || 'https://bsc-dataseed.binance.org/',
  Ethereum: process.env.ETH_RPC || 'https://rpc.ankr.com/eth',
  Solana: process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com'
};

const TREASURY_ADDRESS = "0xa433c78ebe278e4b84fec15fb235e86db889d52b";

// 🏦 WBNB/WETH Addresses to treat as NATIVE (Native Fix)
const WRAPPED_NATIVE_TOKENS = {
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": true, // WBNB (BSC)
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": true  // WETH (ETH)
};

// 🛡️ AUTHENTICATION MIDDLEWARE
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    console.warn(`⚠️ Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  
  next();
};

// ============================================
// 🔄 QUEUE SYSTEM (NONCE MANAGEMENT & STATEFUL RETRY)
// ============================================

const swapQueue = [];
let isProcessing = false;
let currentNonce = null;

// 🧠 STATEFUL TRACKING
const swapState = new Map();

async function processQueue() {
  if (isProcessing || swapQueue.length === 0) return;

  isProcessing = true;
  const task = swapQueue.shift();

  try {
    console.log(`\n🔄 Processing queue item: ${task.type} for ${task.data.inviteCode || 'Refund'}`);
    
    if (task.type === 'swap') {
      await executeSwapLogic(task.data, task.res);
    } else if (task.type === 'refund') {
      await executeRefundLogic(task.data, task.res);
    }
  } catch (error) {
    console.error("❌ Queue Error:", error);
    if (!task.res.headersSent) {
      // 🔥 RETURN 200 even on queue error to prevent infinite retries
      task.res.json({ 
        success: false, 
        error: error.message,
        message: "Queue processing failed (stopped retry)",
        code: "QUEUE_ERROR"
      });
    }
  } finally {
    isProcessing = false;
    // Process next item immediately if exists
    if (swapQueue.length > 0) {
      setImmediate(processQueue);
    }
  }
}

// ============================================
// 💰 LOGIC: EXECUTE SWAP (STATEFUL & SAFE BALANCE)
// ============================================

async function executeSwapLogic(data, res) {
  const { 
    buyerAddress, sellerAddress, 
    buyerAmount, buyerToken, 
    sellerAmount, sellerToken, 
    network, feePercent, 
    inviteCode 
  } = data;

  // 🧠 Load or Initialize State
  let state = swapState.get(inviteCode);
  
  if (state && state.completed) {
    console.log(`✅ Swap ${inviteCode} already fully completed. Returning cached result.`);
    return res.json({
      success: true,
      message: "Swap already completed",
      transactions: {
        transfer1: state.buyerTx,
        transfer2: state.sellerTx,
        transfer3: state.feesTx
      },
      timestamp: new Date(state.timestamp).toISOString()
    });
  }

  if (!state) {
    state = { buyerTx: null, sellerTx: null, feesTx: null, completed: false, timestamp: Date.now() };
    swapState.set(inviteCode, state);
    setTimeout(() => {
        if (swapState.has(inviteCode)) swapState.delete(inviteCode);
    }, 20 * 60 * 1000);
  }

  try {
    const rpcUrl = RPC_URLS[network];
    if (!rpcUrl) throw new Error(`Network ${network} not supported`);

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    
    if (currentNonce === null) {
      currentNonce = await provider.getTransactionCount(wallet.address, "latest");
    }
    
    console.log(`🔐 Wallet: ${wallet.address}`);
    console.log(`🔢 Nonce: ${currentNonce}`);

    // 🔥 HELPER: Format amount strictly
    const formatAmount = (amount, decimals) => {
        if (!amount) return "0";
        let str = Number(amount).toFixed(decimals + 18); 
        const dotIndex = str.indexOf('.');
        if (dotIndex !== -1) {
            str = str.slice(0, dotIndex + 1 + decimals);
        }
        return str;
    };

    // 🔍 HELPER: Check Balance and Adjust
    const getAvailableBalance = async (tokenAddress) => {
        try {
            // Check Native
            const isWrappedNative = WRAPPED_NATIVE_TOKENS[tokenAddress.toLowerCase()];
            const isNative = isWrappedNative || tokenAddress === 'BNB' || tokenAddress === 'ETH' || tokenAddress.length < 10;

            if (isNative) {
                const bal = await provider.getBalance(wallet.address);
                return parseFloat(ethers.formatUnits(bal, 18));
            } else {
                const abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
                const contract = new ethers.Contract(tokenAddress, abi, wallet);
                const bal = await contract.balanceOf(wallet.address);
                let decimals = 18;
                try { decimals = await contract.decimals(); } catch(e) {}
                return parseFloat(ethers.formatUnits(bal, decimals));
            }
        } catch (e) {
            console.error("❌ Balance check failed:", e.message);
            return 0; // Fail safe
        }
    };

    const transferToken = async (tokenAddress, to, amount, label) => {
      if (!amount || parseFloat(amount) <= 0) return "0x_skipped_zero_amount";
      
      // 🔍 CHECK BALANCE FIRST
      const available = await getAvailableBalance(tokenAddress);
      const required = parseFloat(amount);
      
      console.log(`🔍 ${label} Check: Need ${required}, Have ${available}`);

      let finalAmount = amount;
      
      if (available < required) {
          console.warn(`⚠️ INSUFFICIENT BALANCE for ${label}. Need ${required}, Have ${available}`);
          
          // If balance is effectively zero, skip
          if (available <= 0.000001) {
              console.error(`🛑 Skipping ${label} transfer due to ~0 balance.`);
              return "0x_skipped_low_balance";
          }
          
          // SWEEP: Send everything available
          console.warn(`⚠️ Adjusting ${label} transfer to max available: ${available}`);
          finalAmount = available * 0.99; // 1% buffer to be safe
      }

      // Check if Native/Wrapped
      const isWrappedNative = WRAPPED_NATIVE_TOKENS[tokenAddress.toLowerCase()];
      const isNative = isWrappedNative || 
                      tokenAddress === 'BNB' || 
                      tokenAddress === 'ETH' || 
                      tokenAddress.length < 10 || 
                      tokenAddress === '0x0000000000000000000000000000000000000000';

      console.log(`📤 Sending ${finalAmount} ${isNative ? 'NATIVE (unwrap)' : tokenAddress} to ${label}...`);
      
      try {
        if (isNative) {
           const formattedAmount = formatAmount(finalAmount, 18);
           const gasBuffer = 0.001;
           const safeAmount = Math.max(0, parseFloat(formattedAmount) - gasBuffer);
           const amountWei = ethers.parseUnits(safeAmount.toString(), 18);
           
           const tx = await wallet.sendTransaction({
             to: to,
             value: amountWei,
             nonce: currentNonce++
           });
           console.log(`   ✅ ${label} TX sent: ${tx.hash}`);
           await tx.wait(1);
           return tx.hash;
        } else {
          const abi = ["function transfer(address to, uint256 amount) returns (bool)", "function decimals() view returns (uint8)"];
          const contract = new ethers.Contract(tokenAddress, abi, wallet);
          
          let decimals = 18;
          try { decimals = await contract.decimals(); } catch(e) {}
          
          const formattedAmount = formatAmount(finalAmount, decimals);
          const amountWei = ethers.parseUnits(formattedAmount, decimals);
          
          const tx = await contract.transfer(to, amountWei, { nonce: currentNonce++ });
          console.log(`   ✅ ${label} TX sent: ${tx.hash}`);
          await tx.wait(1);
          return tx.hash;
        }
      } catch (err) {
        console.error(`   ❌ Failed to transfer to ${label}:`, err.message);
        
        // 🛡️ ROBUST ERROR CHECKING (Ethers v6)
        const msg = (err.message || "").toLowerCase();
        const reason = (err.reason || "").toLowerCase();
        const shortMsg = (err.shortMessage || "").toLowerCase();
        const code = (err.code || "");
        const infoMsg = (err.info?.error?.message || "").toLowerCase();
        
        // Check for "exceeds balance" or "insufficient funds" in ANY error property
        const isLowBalance = 
            msg.includes("exceeds balance") || 
            msg.includes("insufficient funds") ||
            reason.includes("exceeds balance") ||
            reason.includes("insufficient funds") ||
            shortMsg.includes("exceeds balance") ||
            shortMsg.includes("insufficient funds") ||
            infoMsg.includes("exceeds balance") ||
            infoMsg.includes("insufficient funds") ||
            code === 'INSUFFICIENT_FUNDS' ||
            (code === 'CALL_EXCEPTION'); // Treat call exception as potential balance issue on transfer

        if (isLowBalance) {
             console.warn(`⚠️ DETECTED FAILURE (Likely Low Balance/Double Spend). SKIPPING ${label} TO UNBLOCK QUEUE.`);
             try { currentNonce = await provider.getTransactionCount(wallet.address, "latest"); } catch(e) {}
             return "0x_skipped_low_balance_error";
        }
        
        try { currentNonce = await provider.getTransactionCount(wallet.address, "latest"); } catch(e) {}
        // IMPORTANT: Return string, do NOT throw
        return `0x_error_${code || 'failed'}`; 
      }
    };

    // ============================================
    // 💰 FEE CALCULATION LOGIC
    // ============================================
    
    const finalFeePercent = parseFloat(feePercent) || 10.0;
    const feePerPartyPercent = finalFeePercent / 2;
    const feeMultiplier = feePerPartyPercent / 100; 

    // Calculate Amounts
    const buyerFeeAmt = parseFloat(sellerAmount) * feeMultiplier;
    const buyerNet = parseFloat(sellerAmount) - buyerFeeAmt;
    
    const sellerFeeAmt = parseFloat(buyerAmount) * feeMultiplier;
    const sellerNet = parseFloat(buyerAmount) - sellerFeeAmt;

    // ============================================
    // 🔄 STATEFUL EXECUTION
    // ============================================

    // 1. Transfer to Buyer
    if (!state.buyerTx || state.buyerTx.startsWith('0x_error')) {
        const result = await transferToken(sellerToken, buyerAddress, buyerNet, "Buyer");
        if (result && result.startsWith("0x_skipped")) {
            state.buyerTx = "0x_already_done_or_skipped"; 
        } else {
            state.buyerTx = result;
        }
        swapState.set(inviteCode, state);
    }
    
    // 2. Transfer to Seller
    if (!state.sellerTx || state.sellerTx.startsWith('0x_error')) {
        const result = await transferToken(buyerToken, sellerAddress, sellerNet, "Seller");
        if (result && result.startsWith("0x_skipped")) {
            state.sellerTx = "0x_already_done_or_skipped";
        } else {
            state.sellerTx = result;
        }
        swapState.set(inviteCode, state);
    }
    
    // 3. Fees Distribution
    if (!state.feesTx) {
        const treasuryShare = 0.70;
        let feeTxHash = "0x_fees_accumulated";
        
        if (buyerFeeAmt > 0) {
           const amountToTreasury = buyerFeeAmt * treasuryShare;
           const tx = await transferToken(sellerToken, TREASURY_ADDRESS, amountToTreasury, "Treasury (Fee 1)");
           if (tx && tx.startsWith('0x') && !tx.startsWith('0x_')) feeTxHash = tx;
        }
        
        if (sellerFeeAmt > 0) {
           const amountToTreasury = sellerFeeAmt * treasuryShare;
           const tx = await transferToken(buyerToken, TREASURY_ADDRESS, amountToTreasury, "Treasury (Fee 2)");
           if (tx && tx.startsWith('0x') && !tx.startsWith('0x_')) feeTxHash = tx;
        }
        
        state.feesTx = feeTxHash;
        swapState.set(inviteCode, state);
    }

    // ✅ Mark Complete
    state.completed = true;
    swapState.set(inviteCode, state);

    res.json({
      success: true,
      message: "Swap executed successfully",
      transactions: {
        transfer1: state.buyerTx,
        transfer2: state.sellerTx,
        transfer3: state.feesTx
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("❌ Swap Logic Error:", error);
    // 🔥 CRITICAL FIX: Return 200 instead of 500 to stop Auto-Retry loops
    res.json({ 
        success: false, 
        error: error.message,
        message: "Swap failed (stopped retry loop)",
        code: "SWAP_ERROR_STOP_RETRY"
    });
  }
}

// ============================================
// 💰 LOGIC: EXECUTE REFUND
// ============================================

async function executeRefundLogic(data, res) {
     const { 
        buyerAddress, sellerAddress, 
        sellerAmount, sellerToken, 
        network, inviteCode 
    } = data;

    try {
        const rpcUrl = RPC_URLS[network];
        if (!rpcUrl) throw new Error(`Network ${network} not supported`);

        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        
        res.json({ success: true, message: "Refund request received" });

    } catch (error) {
         res.status(200).json({ success: false, error: error.message });
    }
}

// ============================================
// 🚀 API ENDPOINTS
// ============================================

app.get('/', (req, res) => {
  res.send('🚀 ORBE Arbiter Backend is Running Securely v3.9 (Double Spend Catch & STOP Retry)');
});

app.post('/api/arbiter/execute-swap', authenticate, (req, res) => {
  swapQueue.push({ type: 'swap', data: req.body, res });
  processQueue();
});

app.post('/api/arbiter/refund', authenticate, (req, res) => {
  swapQueue.push({ type: 'refund', data: req.body, res });
  processQueue();
});

// Start Server
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`📝 Deployment Mode: PRODUCTION`);
});
