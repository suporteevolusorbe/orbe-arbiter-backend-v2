/**
 * 🚀 PRODUCTION READY BACKEND SERVER (Node.js)
 * CORRIGIDO: Tratamento de WBNB como Nativo e Proteção contra Dupes
 */

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { ethers } = require("ethers");
const helmet = require("helmet");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// Security Middleware
app.use(helmet());
app.use(cors({
  origin: "*", 
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// 🔐 Environment Variables Check
const PRIVATE_KEY = process.env.ARBITER_PRIVATE_KEY;
const API_SECRET = process.env.API_SECRET_KEY;

if (!PRIVATE_KEY || !API_SECRET) {
  console.error("❌ CRITICAL ERROR: Missing Environment Variables (ARBITER_PRIVATE_KEY or API_SECRET_KEY)");
  process.exit(1);
}

// 🌍 Network Configurations
const NETWORKS = {
  "BSC": "https://bsc-dataseed.binance.org/",
  "Ethereum": "https://mainnet.infura.io/v3/YOUR_INFURA_KEY", 
  "Polygon": "https://polygon-rpc.com",
  "Solana": "https://api.mainnet-beta.solana.com"
};

// 🏦 WBNB/WETH Addresses to treat as NATIVE
const WRAPPED_NATIVE_TOKENS = {
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": true, // WBNB (BSC)
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": true  // WETH (ETH)
};

// 🛡️ Memory Cache to prevent double spending in short timeframe
const processedSwaps = new Set();

// 🛠️ Helper: Authenticate Request
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
};

// 🔄 QUEUE SYSTEM
let isProcessing = false;
const swapQueue = [];

const processQueue = async () => {
  if (isProcessing || swapQueue.length === 0) return;
  isProcessing = true;

  const task = swapQueue.shift();
  try {
    console.log(`🔄 Processing queue item: swap for ${task.inviteCode}`);
    await executeSwapLogic(task.req, task.res);
  } catch (error) {
    console.error(`❌ Queue Error:`, error);
    if (!task.res.headersSent) {
      task.res.status(500).json({ success: false, error: error.message });
    }
  } finally {
    isProcessing = false;
    processQueue(); // Next item
  }
};

/**
 * ⚙️ CORE SWAP LOGIC
 */
async function executeSwapLogic(req, res) {
  const {
    buyerAddress, sellerAddress,
    buyerAmount, buyerToken, 
    sellerAmount, sellerToken, 
    network,
    feePercent = 5.0,
    treasuryAddress,
    inviteCode
  } = req.body;

  // 🛡️ Idempotency Check
  if (processedSwaps.has(inviteCode)) {
    console.warn(`⚠️ Swap ${inviteCode} already processed recently. Skipping.`);
    return res.json({ success: false, error: "Swap already processed (idempotency)" });
  }

  const rpcUrl = NETWORKS[network];
  if (!rpcUrl) throw new Error(`Network ${network} not supported`);

  // Setup Provider & Wallet
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log(`🔐 Wallet: ${wallet.address}`);

  // Helper: Send Token or Native
  const sendAsset = async (tokenAddress, amount, recipient, label) => {
    try {
      // Check if Amount is valid
      if (!amount || parseFloat(amount) <= 0) {
        console.log(`⚠️ No amount to send to ${label}`);
        return null;
      }

      // Check if token is Wrapped Native (WBNB/WETH)
      const isNative = WRAPPED_NATIVE_TOKENS[tokenAddress.toLowerCase()];
      
      let decimals = 18;
      let contract = null;

      if (!isNative) {
        contract = new ethers.Contract(tokenAddress, ["function decimals() view returns (uint8)", "function transfer(address, uint256) returns (bool)"], wallet);
        try { decimals = await contract.decimals(); } catch (e) { 
            console.warn("Decimals fetch failed, using 18"); 
        }
      }

      const amountWei = ethers.parseUnits(amount.toString(), decimals);

      console.log(`📤 Sending ${amount} ${isNative ? 'NATIVE (unwrap)' : tokenAddress} to ${label}...`);

      let tx;
      if (isNative) {
        // 🟢 SEND NATIVE (BNB/ETH) instead of WBNB/WETH
        tx = await wallet.sendTransaction({
          to: recipient,
          value: amountWei
        });
      } else {
        // 🔵 SEND ERC20/BEP20
        // Estimate gas first to catch errors early
        try {
           await contract.transfer.estimateGas(recipient, amountWei);
        } catch (estError) {
           console.error(`❌ Gas Estimate Failed for ${label}: ${estError.message}`);
           // Critical error if we can't send funds
           throw new Error(`Insufficient funds or error sending to ${label}`);
        }
        
        tx = await contract.transfer(recipient, amountWei);
      }

      console.log(`   ✅ ${label} TX sent: ${tx.hash}`);
      await tx.wait(1); // Wait for 1 confirmation
      return tx.hash;

    } catch (error) {
      console.error(`❌ Failed to transfer to ${label}: ${error.message}`);
      throw error;
    }
  };

  try {
    // 1. Send to Buyer (Seller's Token)
    const tx1 = await sendAsset(buyerToken, buyerAmount, buyerAddress, "Buyer");

    // 2. Send to Seller (Buyer's Token)
    const tx2 = await sendAsset(sellerToken, sellerAmount, sellerAddress, "Seller");

    // ✅ Success
    processedSwaps.add(inviteCode);
    
    // Clear from cache after 10 minutes
    setTimeout(() => processedSwaps.delete(inviteCode), 600000);

    res.json({
      success: true,
      transactions: {
        transfer1: tx1,
        transfer2: tx2
      }
    });

  } catch (error) {
    console.error(`❌ Swap Logic Error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * 📡 API ENDPOINTS
 */

app.get("/", (req, res) => {
  res.send("✅ Arbiter Backend Online v2.1 (Native Fix)");
});

app.post("/api/arbiter/execute-swap", authenticate, (req, res) => {
  swapQueue.push({ req, res, inviteCode: req.body.inviteCode });
  processQueue();
});

// Refund Endpoint
app.post("/api/arbiter/refund", authenticate, async (req, res) => {
    const { sellerAddress, buyerAddress, sellerAmount, sellerToken, buyerAmount, buyerToken, network } = req.body;
    // Implement similar logic to executeSwapLogic but sending back to origin
    // For now, return not implemented to avoid errors
    res.status(501).json({ success: false, message: "Refund logic needs update to match Native Fix" });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
