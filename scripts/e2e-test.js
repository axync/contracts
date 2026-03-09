/**
 * E2E Test: Full cross-chain swap flow via Axync API
 *
 * Flow:
 * 1. Account A deposits ETH on Sepolia chain
 * 2. Account B deposits ETH on Base Sepolia chain
 * 3. Account A creates a cross-chain deal (Sell ETH on Sepolia, Buy ETH on Base Sepolia)
 * 4. Account B accepts the deal
 * 5. Verify final balances
 */

const { ethers } = require("ethers");

const API_URL = "http://localhost:8080";

// Test accounts
const ACCOUNT_A_KEY = "59639cd231645561b58a8ff8e7a6c53c0d52172c1836d2d8a3fba33f0b34a774";
const ACCOUNT_B_KEY = "d7c855a98914be00bbcb812e6b7bac4355d64121073914a09dff48ad8d091ad1";

const walletA = new ethers.Wallet(ACCOUNT_A_KEY);
const walletB = new ethers.Wallet(ACCOUNT_B_KEY);

console.log("Account A:", walletA.address);
console.log("Account B:", walletB.address);

// Constants
const SEPOLIA_CHAIN_ID = 11155111;
const BASE_SEPOLIA_CHAIN_ID = 84532;
const ETH_ASSET_ID = 0;
const DEPOSIT_AMOUNT = ethers.parseEther("0.01"); // 0.01 ETH

// Transaction kind bytes (matching Rust TxKind enum)
function getKindByte(kind) {
  switch (kind) {
    case "Deposit": return 0;
    case "Withdraw": return 1;
    case "CreateDeal": return 2;
    case "AcceptDeal": return 3;
    case "CancelDeal": return 4;
    default: throw new Error(`Unknown kind: ${kind}`);
  }
}

/**
 * Build the raw message bytes matching the Rust tx_hash function exactly.
 * Format: from(20) + nonce(8 LE) + kind_byte(1) + payload_bytes(variable)
 *
 * Types:
 *   DealId = u64 (8 bytes LE)
 *   AssetId = u16 (2 bytes LE)
 *   ChainId = u64 (8 bytes LE)
 *   Amount = u128 (16 bytes LE)
 *   Address = [u8; 20]
 */
function buildMessageBytes(from, nonce, kind, payload) {
  const fromBytes = ethers.getBytes(from); // 20 bytes

  // Nonce: u64 little-endian (8 bytes)
  const nonceBytes = new Uint8Array(8);
  const nonceView = new DataView(nonceBytes.buffer);
  nonceView.setBigUint64(0, BigInt(nonce), true);

  const kindByte = getKindByte(kind);

  let payloadBytes;
  switch (kind) {
    case "Deposit": {
      // tx_hash(32) + account(20) + asset_id(2 LE) + amount(16 LE) + chain_id(8 LE)
      const txHashBytes = ethers.getBytes(payload.txHash);       // 32 bytes
      const accountBytes = ethers.getBytes(payload.account);     // 20 bytes

      const assetIdBytes = new Uint8Array(2);
      new DataView(assetIdBytes.buffer).setUint16(0, payload.assetId, true);

      const amountBytes = new Uint8Array(16);
      const amountView = new DataView(amountBytes.buffer);
      const amountBigInt = BigInt(payload.amount);
      amountView.setBigUint64(0, amountBigInt & BigInt("0xFFFFFFFFFFFFFFFF"), true);
      amountView.setBigUint64(8, amountBigInt >> BigInt(64), true);

      const chainIdBytes = new Uint8Array(8);
      new DataView(chainIdBytes.buffer).setBigUint64(0, BigInt(payload.chainId), true);

      payloadBytes = new Uint8Array(32 + 20 + 2 + 16 + 8);
      let offset = 0;
      payloadBytes.set(txHashBytes, offset); offset += 32;
      payloadBytes.set(accountBytes, offset); offset += 20;
      payloadBytes.set(assetIdBytes, offset); offset += 2;
      payloadBytes.set(amountBytes, offset); offset += 16;
      payloadBytes.set(chainIdBytes, offset);
      break;
    }
    case "CreateDeal": {
      // deal_id(8 LE) + visibility(1) + taker_flag(1) + [taker(20)] +
      // asset_base(2 LE) + asset_quote(2 LE) + chain_id_base(8 LE) + chain_id_quote(8 LE) +
      // amount_base(16 LE) + price_quote_per_base(16 LE)
      const dealIdBytes = new Uint8Array(8);
      new DataView(dealIdBytes.buffer).setBigUint64(0, BigInt(payload.dealId), true);

      const visibilityByte = payload.visibility === "Public" ? 0 : 1;
      const hasTaker = payload.taker ? true : false;
      const takerBytes = hasTaker ? ethers.getBytes(payload.taker) : null;

      const assetBaseBytes = new Uint8Array(2);
      new DataView(assetBaseBytes.buffer).setUint16(0, payload.assetBase, true);

      const assetQuoteBytes = new Uint8Array(2);
      new DataView(assetQuoteBytes.buffer).setUint16(0, payload.assetQuote, true);

      const chainIdBaseBytes = new Uint8Array(8);
      new DataView(chainIdBaseBytes.buffer).setBigUint64(0, BigInt(payload.chainIdBase), true);

      const chainIdQuoteBytes = new Uint8Array(8);
      new DataView(chainIdQuoteBytes.buffer).setBigUint64(0, BigInt(payload.chainIdQuote), true);

      const amountBaseBytes = new Uint8Array(16);
      const amountBaseView = new DataView(amountBaseBytes.buffer);
      const amountBaseBigInt = BigInt(payload.amountBase);
      amountBaseView.setBigUint64(0, amountBaseBigInt & BigInt("0xFFFFFFFFFFFFFFFF"), true);
      amountBaseView.setBigUint64(8, amountBaseBigInt >> BigInt(64), true);

      const priceBytes = new Uint8Array(16);
      const priceView = new DataView(priceBytes.buffer);
      const priceBigInt = BigInt(payload.priceQuotePerBase);
      priceView.setBigUint64(0, priceBigInt & BigInt("0xFFFFFFFFFFFFFFFF"), true);
      priceView.setBigUint64(8, priceBigInt >> BigInt(64), true);

      const totalLen = 8 + 1 + 1 + (hasTaker ? 20 : 0) + 2 + 2 + 8 + 8 + 16 + 16;
      payloadBytes = new Uint8Array(totalLen);
      let offset = 0;
      payloadBytes.set(dealIdBytes, offset); offset += 8;
      payloadBytes[offset++] = visibilityByte;
      if (hasTaker) {
        payloadBytes[offset++] = 1;
        payloadBytes.set(takerBytes, offset); offset += 20;
      } else {
        payloadBytes[offset++] = 0;
      }
      payloadBytes.set(assetBaseBytes, offset); offset += 2;
      payloadBytes.set(assetQuoteBytes, offset); offset += 2;
      payloadBytes.set(chainIdBaseBytes, offset); offset += 8;
      payloadBytes.set(chainIdQuoteBytes, offset); offset += 8;
      payloadBytes.set(amountBaseBytes, offset); offset += 16;
      payloadBytes.set(priceBytes, offset);
      break;
    }
    case "AcceptDeal": {
      // deal_id(8 LE) + amount_flag(1) + [amount(16 LE)]
      const dealIdBytes = new Uint8Array(8);
      new DataView(dealIdBytes.buffer).setBigUint64(0, BigInt(payload.dealId), true);

      const hasAmount = payload.amount !== null && payload.amount !== undefined;
      const amountBytes = hasAmount ? new Uint8Array(16) : null;
      if (hasAmount) {
        const amountView = new DataView(amountBytes.buffer);
        const amountBigInt = BigInt(payload.amount);
        amountView.setBigUint64(0, amountBigInt & BigInt("0xFFFFFFFFFFFFFFFF"), true);
        amountView.setBigUint64(8, amountBigInt >> BigInt(64), true);
      }

      const totalLen = 8 + 1 + (hasAmount ? 16 : 0);
      payloadBytes = new Uint8Array(totalLen);
      let offset = 0;
      payloadBytes.set(dealIdBytes, offset); offset += 8;
      if (hasAmount) {
        payloadBytes[offset++] = 1;
        payloadBytes.set(amountBytes, offset);
      } else {
        payloadBytes[offset++] = 0;
      }
      break;
    }
    case "CancelDeal": {
      const dealIdBytes = new Uint8Array(8);
      new DataView(dealIdBytes.buffer).setBigUint64(0, BigInt(payload.dealId), true);
      payloadBytes = dealIdBytes;
      break;
    }
    default:
      throw new Error(`Unsupported kind: ${kind}`);
  }

  // Combine: from(20) + nonce(8) + kind(1) + payload
  const data = new Uint8Array(20 + 8 + 1 + payloadBytes.length);
  let offset = 0;
  data.set(fromBytes, offset); offset += 20;
  data.set(nonceBytes, offset); offset += 8;
  data[offset++] = kindByte;
  data.set(payloadBytes, offset);

  return data;
}

/**
 * Sign a transaction matching the Rust validation format.
 * ethers.signMessage(data) adds the Ethereum prefix automatically:
 *   Keccak256("\x19Ethereum Signed Message:\n" + len(data) + data)
 * This matches the Rust tx_hash() function which does the same prefixing.
 */
async function signTx(wallet, from, nonce, kind, payload) {
  const data = buildMessageBytes(from, nonce, kind, payload);
  const signature = await wallet.signMessage(data);
  return signature;
}

/**
 * Submit a transaction to the API
 */
async function submitTx(request) {
  const response = await fetch(`${API_URL}/api/v1/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

/**
 * Get account state
 */
async function getAccount(address) {
  const response = await fetch(`${API_URL}/api/v1/account/${address}`);
  return response.json();
}

/**
 * Wait for transaction to be processed (give sequencer time to include in block)
 */
async function waitForProcessing(ms = 3000) {
  console.log(`  Waiting ${ms}ms for sequencer to process...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ MAIN TEST FLOW ============

async function main() {
  console.log("\n========================================");
  console.log("  AXYNC E2E TEST: Cross-Chain Swap Flow");
  console.log("========================================\n");

  // Step 0: Check health
  console.log("=== 0. Health Check ===");
  const health = await fetch(`${API_URL}/health`).then(r => r.json());
  console.log("  Status:", health.status);
  if (health.status !== "healthy") {
    throw new Error("Backend is not healthy!");
  }

  // Step 1: Check initial account states
  console.log("\n=== 1. Initial Account States ===");
  let stateA = await getAccount(walletA.address);
  let stateB = await getAccount(walletB.address);
  console.log("  Account A nonce:", stateA.nonce, "balances:", stateA.balances.length);
  console.log("  Account B nonce:", stateB.nonce, "balances:", stateB.balances.length);

  // Step 2: Deposit for Account A (ETH on Sepolia)
  console.log("\n=== 2. Deposit: Account A - 0.01 ETH on Sepolia ===");
  const fakeTxHashA = "0x" + "aa".repeat(32); // mock tx hash
  const depositPayloadA = {
    txHash: fakeTxHashA,
    account: walletA.address,
    assetId: ETH_ASSET_ID,
    amount: DEPOSIT_AMOUNT.toString(),
    chainId: SEPOLIA_CHAIN_ID,
  };

  const depositSigA = await signTx(
    walletA, walletA.address, stateA.nonce, "Deposit", depositPayloadA
  );
  console.log("  Signature:", depositSigA.slice(0, 20) + "...");

  const depositRequestA = {
    kind: "Deposit",
    tx_hash: fakeTxHashA,
    account: walletA.address,
    asset_id: ETH_ASSET_ID,
    amount: DEPOSIT_AMOUNT.toString(),
    chain_id: SEPOLIA_CHAIN_ID,
    nonce: stateA.nonce,
    signature: depositSigA,
  };

  try {
    const resultA = await submitTx(depositRequestA);
    console.log("  SUCCESS! TX Hash:", resultA.tx_hash);
  } catch (err) {
    console.error("  FAILED:", err.message);
    // Try to continue
  }

  await waitForProcessing();

  // Refresh account A state
  stateA = await getAccount(walletA.address);
  console.log("  Account A nonce now:", stateA.nonce, "balances:", JSON.stringify(stateA.balances));

  // Step 3: Deposit for Account B (ETH on Base Sepolia)
  console.log("\n=== 3. Deposit: Account B - 0.01 ETH on Base Sepolia ===");
  stateB = await getAccount(walletB.address);
  const fakeTxHashB = "0x" + "bb".repeat(32);
  const depositPayloadB = {
    txHash: fakeTxHashB,
    account: walletB.address,
    assetId: ETH_ASSET_ID,
    amount: DEPOSIT_AMOUNT.toString(),
    chainId: BASE_SEPOLIA_CHAIN_ID,
  };

  const depositSigB = await signTx(
    walletB, walletB.address, stateB.nonce, "Deposit", depositPayloadB
  );
  console.log("  Signature:", depositSigB.slice(0, 20) + "...");

  const depositRequestB = {
    kind: "Deposit",
    tx_hash: fakeTxHashB,
    account: walletB.address,
    asset_id: ETH_ASSET_ID,
    amount: DEPOSIT_AMOUNT.toString(),
    chain_id: BASE_SEPOLIA_CHAIN_ID,
    nonce: stateB.nonce,
    signature: depositSigB,
  };

  try {
    const resultB = await submitTx(depositRequestB);
    console.log("  SUCCESS! TX Hash:", resultB.tx_hash);
  } catch (err) {
    console.error("  FAILED:", err.message);
  }

  await waitForProcessing();

  // Refresh both states
  stateA = await getAccount(walletA.address);
  stateB = await getAccount(walletB.address);
  console.log("  Account A balances:", JSON.stringify(stateA.balances));
  console.log("  Account B balances:", JSON.stringify(stateB.balances));

  // Step 4: Create Deal - Account A sells 0.01 ETH on Sepolia for ETH on Base Sepolia
  console.log("\n=== 4. Create Deal: A sells 0.01 ETH (Sepolia → Base Sepolia) ===");
  stateA = await getAccount(walletA.address);
  const dealId = Date.now(); // use timestamp as deal ID
  const createDealPayload = {
    dealId: dealId,
    visibility: "Public",
    taker: null,
    assetBase: ETH_ASSET_ID,
    assetQuote: ETH_ASSET_ID,
    chainIdBase: SEPOLIA_CHAIN_ID,
    chainIdQuote: BASE_SEPOLIA_CHAIN_ID,
    amountBase: DEPOSIT_AMOUNT.toString(),
    priceQuotePerBase: ethers.parseEther("1.0").toString(), // 1:1 rate
  };

  const createDealSig = await signTx(
    walletA, walletA.address, stateA.nonce, "CreateDeal", createDealPayload
  );
  console.log("  Deal ID:", dealId);
  console.log("  Signature:", createDealSig.slice(0, 20) + "...");

  const createDealRequest = {
    kind: "CreateDeal",
    from: walletA.address,
    deal_id: dealId,
    visibility: "Public",
    taker: null,
    asset_base: ETH_ASSET_ID,
    asset_quote: ETH_ASSET_ID,
    chain_id_base: SEPOLIA_CHAIN_ID,
    chain_id_quote: BASE_SEPOLIA_CHAIN_ID,
    amount_base: DEPOSIT_AMOUNT.toString(),
    price_quote_per_base: ethers.parseEther("1.0").toString(),
    expires_at: null,
    external_ref: null,
    nonce: stateA.nonce,
    signature: createDealSig,
  };

  try {
    const resultDeal = await submitTx(createDealRequest);
    console.log("  SUCCESS! TX Hash:", resultDeal.tx_hash);
  } catch (err) {
    console.error("  FAILED:", err.message);
  }

  await waitForProcessing();

  // Check deal was created
  console.log("\n=== 5. Verify Deal Created ===");
  try {
    const dealsResp = await fetch(`${API_URL}/api/v1/deals`).then(r => r.json());
    console.log("  Total deals:", dealsResp.total);
    if (dealsResp.deals && dealsResp.deals.length > 0) {
      const latestDeal = dealsResp.deals[dealsResp.deals.length - 1];
      console.log("  Latest deal:", JSON.stringify(latestDeal, null, 2));
    }
  } catch (err) {
    console.error("  Error checking deals:", err.message);
  }

  // Step 5: Account B accepts the deal
  console.log("\n=== 6. Accept Deal: B accepts the deal ===");
  stateB = await getAccount(walletB.address);
  const acceptDealPayload = {
    dealId: dealId,
    amount: null, // accept full amount
  };

  const acceptDealSig = await signTx(
    walletB, walletB.address, stateB.nonce, "AcceptDeal", acceptDealPayload
  );
  console.log("  Signature:", acceptDealSig.slice(0, 20) + "...");

  const acceptDealRequest = {
    kind: "AcceptDeal",
    from: walletB.address,
    deal_id: dealId,
    amount: null,
    nonce: stateB.nonce,
    signature: acceptDealSig,
  };

  try {
    const resultAccept = await submitTx(acceptDealRequest);
    console.log("  SUCCESS! TX Hash:", resultAccept.tx_hash);
  } catch (err) {
    console.error("  FAILED:", err.message);
  }

  await waitForProcessing();

  // Step 6: Final verification
  console.log("\n=== 7. Final Account States ===");
  stateA = await getAccount(walletA.address);
  stateB = await getAccount(walletB.address);
  console.log("  Account A:", JSON.stringify(stateA, null, 2));
  console.log("  Account B:", JSON.stringify(stateB, null, 2));

  // Verify expected balances
  console.log("\n=== 8. Balance Verification ===");
  const findBalance = (state, chainId, assetId) => {
    if (!state.balances) return "0";
    const b = state.balances.find(b => b.chain_id === chainId && b.asset_id === assetId);
    return b ? b.amount.toString() : "0";
  };

  const aSepoliaBalance = findBalance(stateA, SEPOLIA_CHAIN_ID, ETH_ASSET_ID);
  const aBaseBalance = findBalance(stateA, BASE_SEPOLIA_CHAIN_ID, ETH_ASSET_ID);
  const bSepoliaBalance = findBalance(stateB, SEPOLIA_CHAIN_ID, ETH_ASSET_ID);
  const bBaseBalance = findBalance(stateB, BASE_SEPOLIA_CHAIN_ID, ETH_ASSET_ID);

  console.log(`  Account A - Sepolia ETH: ${ethers.formatEther(aSepoliaBalance)}`);
  console.log(`  Account A - Base ETH:    ${ethers.formatEther(aBaseBalance)}`);
  console.log(`  Account B - Sepolia ETH: ${ethers.formatEther(bSepoliaBalance)}`);
  console.log(`  Account B - Base ETH:    ${ethers.formatEther(bBaseBalance)}`);

  // After a successful cross-chain swap:
  // - Account A should have 0 ETH on Sepolia, 0.01 ETH on Base Sepolia (received from B)
  // - Account B should have 0.01 ETH on Sepolia (received from A), 0 ETH on Base Sepolia
  console.log("\n  Expected after swap:");
  console.log("  Account A: 0 ETH Sepolia → 0.01 ETH Base Sepolia");
  console.log("  Account B: 0.01 ETH Sepolia ← 0 ETH Base Sepolia");

  console.log("\n========================================");
  console.log("  E2E TEST COMPLETE");
  console.log("========================================\n");
}

main().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
