/**
 * E2E Test Fix: Cancel the broken deal and retry with correct price
 *
 * The price_quote_per_base is a simple integer multiplier, NOT in wei.
 * For 1:1 ETH→ETH rate, use price=1.
 */

const { ethers } = require("ethers");

const API_URL = "http://localhost:8080";

const ACCOUNT_A_KEY = "59639cd231645561b58a8ff8e7a6c53c0d52172c1836d2d8a3fba33f0b34a774";
const ACCOUNT_B_KEY = "d7c855a98914be00bbcb812e6b7bac4355d64121073914a09dff48ad8d091ad1";
const walletA = new ethers.Wallet(ACCOUNT_A_KEY);
const walletB = new ethers.Wallet(ACCOUNT_B_KEY);

const SEPOLIA_CHAIN_ID = 11155111;
const BASE_SEPOLIA_CHAIN_ID = 84532;
const ETH_ASSET_ID = 0;
const DEPOSIT_AMOUNT = ethers.parseEther("0.01");
const OLD_DEAL_ID = 1773067061485;

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

function buildMessageBytes(from, nonce, kind, payload) {
  const fromBytes = ethers.getBytes(from);
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce), true);
  const kindByte = getKindByte(kind);

  let payloadBytes;
  switch (kind) {
    case "Deposit": {
      const txHashBytes = ethers.getBytes(payload.txHash);
      const accountBytes = ethers.getBytes(payload.account);
      const assetIdBytes = new Uint8Array(2);
      new DataView(assetIdBytes.buffer).setUint16(0, payload.assetId, true);
      const amountBytes = new Uint8Array(16);
      const av = new DataView(amountBytes.buffer);
      const amt = BigInt(payload.amount);
      av.setBigUint64(0, amt & BigInt("0xFFFFFFFFFFFFFFFF"), true);
      av.setBigUint64(8, amt >> BigInt(64), true);
      const chainIdBytes = new Uint8Array(8);
      new DataView(chainIdBytes.buffer).setBigUint64(0, BigInt(payload.chainId), true);
      payloadBytes = new Uint8Array(32 + 20 + 2 + 16 + 8);
      let o = 0;
      payloadBytes.set(txHashBytes, o); o += 32;
      payloadBytes.set(accountBytes, o); o += 20;
      payloadBytes.set(assetIdBytes, o); o += 2;
      payloadBytes.set(amountBytes, o); o += 16;
      payloadBytes.set(chainIdBytes, o);
      break;
    }
    case "CreateDeal": {
      const dealIdBytes = new Uint8Array(8);
      new DataView(dealIdBytes.buffer).setBigUint64(0, BigInt(payload.dealId), true);
      const vis = payload.visibility === "Public" ? 0 : 1;
      const hasTaker = !!payload.taker;
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
      const abv = new DataView(amountBaseBytes.buffer);
      const amtB = BigInt(payload.amountBase);
      abv.setBigUint64(0, amtB & BigInt("0xFFFFFFFFFFFFFFFF"), true);
      abv.setBigUint64(8, amtB >> BigInt(64), true);
      const priceBytes = new Uint8Array(16);
      const pv = new DataView(priceBytes.buffer);
      const prc = BigInt(payload.priceQuotePerBase);
      pv.setBigUint64(0, prc & BigInt("0xFFFFFFFFFFFFFFFF"), true);
      pv.setBigUint64(8, prc >> BigInt(64), true);
      const totalLen = 8 + 1 + 1 + (hasTaker ? 20 : 0) + 2 + 2 + 8 + 8 + 16 + 16;
      payloadBytes = new Uint8Array(totalLen);
      let o = 0;
      payloadBytes.set(dealIdBytes, o); o += 8;
      payloadBytes[o++] = vis;
      if (hasTaker) { payloadBytes[o++] = 1; payloadBytes.set(takerBytes, o); o += 20; }
      else { payloadBytes[o++] = 0; }
      payloadBytes.set(assetBaseBytes, o); o += 2;
      payloadBytes.set(assetQuoteBytes, o); o += 2;
      payloadBytes.set(chainIdBaseBytes, o); o += 8;
      payloadBytes.set(chainIdQuoteBytes, o); o += 8;
      payloadBytes.set(amountBaseBytes, o); o += 16;
      payloadBytes.set(priceBytes, o);
      break;
    }
    case "AcceptDeal": {
      const dealIdBytes = new Uint8Array(8);
      new DataView(dealIdBytes.buffer).setBigUint64(0, BigInt(payload.dealId), true);
      const hasAmount = payload.amount !== null && payload.amount !== undefined;
      const amountBytes = hasAmount ? new Uint8Array(16) : null;
      if (hasAmount) {
        const av = new DataView(amountBytes.buffer);
        const amt = BigInt(payload.amount);
        av.setBigUint64(0, amt & BigInt("0xFFFFFFFFFFFFFFFF"), true);
        av.setBigUint64(8, amt >> BigInt(64), true);
      }
      const totalLen = 8 + 1 + (hasAmount ? 16 : 0);
      payloadBytes = new Uint8Array(totalLen);
      let o = 0;
      payloadBytes.set(dealIdBytes, o); o += 8;
      if (hasAmount) { payloadBytes[o++] = 1; payloadBytes.set(amountBytes, o); }
      else { payloadBytes[o++] = 0; }
      break;
    }
    case "CancelDeal": {
      const dealIdBytes = new Uint8Array(8);
      new DataView(dealIdBytes.buffer).setBigUint64(0, BigInt(payload.dealId), true);
      payloadBytes = dealIdBytes;
      break;
    }
    default: throw new Error(`Unsupported kind: ${kind}`);
  }

  const data = new Uint8Array(20 + 8 + 1 + payloadBytes.length);
  let o = 0;
  data.set(fromBytes, o); o += 20;
  data.set(nonceBytes, o); o += 8;
  data[o++] = kindByte;
  data.set(payloadBytes, o);
  return data;
}

async function signTx(wallet, from, nonce, kind, payload) {
  const data = buildMessageBytes(from, nonce, kind, payload);
  return wallet.signMessage(data);
}

async function submitTx(request) {
  const response = await fetch(`${API_URL}/api/v1/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`API error ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function getAccount(address) {
  return fetch(`${API_URL}/api/v1/account/${address}`).then(r => r.json());
}

async function wait(ms = 3000) {
  console.log(`  Waiting ${ms}ms...`);
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("\n========================================");
  console.log("  AXYNC E2E FIX: Correct Price & Retry");
  console.log("========================================\n");

  // Current state
  let stateA = await getAccount(walletA.address);
  let stateB = await getAccount(walletB.address);
  console.log("Account A nonce:", stateA.nonce, "balances:", JSON.stringify(stateA.balances));
  console.log("Account B nonce:", stateB.nonce, "balances:", JSON.stringify(stateB.balances));

  // Step 1: Cancel old deal
  console.log("\n=== 1. Cancel old deal (ID:", OLD_DEAL_ID, ") ===");
  const cancelPayload = { dealId: OLD_DEAL_ID };
  const cancelSig = await signTx(walletA, walletA.address, stateA.nonce, "CancelDeal", cancelPayload);
  try {
    const result = await submitTx({
      kind: "CancelDeal",
      from: walletA.address,
      deal_id: OLD_DEAL_ID,
      nonce: stateA.nonce,
      signature: cancelSig,
    });
    console.log("  Cancelled! TX:", result.tx_hash.slice(0, 40) + "...");
  } catch (err) {
    console.error("  Cancel failed:", err.message);
  }
  await wait();

  // Refresh state
  stateA = await getAccount(walletA.address);
  console.log("  Account A nonce after cancel:", stateA.nonce);

  // Check deal status
  const dealCheck = await fetch(`${API_URL}/api/v1/deal/${OLD_DEAL_ID}`).then(r => r.json());
  console.log("  Old deal status:", dealCheck.status);

  // Step 2: Create new deal with price=1 (1:1 rate, simple integer)
  console.log("\n=== 2. Create new deal with price=1 ===");
  stateA = await getAccount(walletA.address);
  const newDealId = Date.now();

  // CRITICAL FIX: price_quote_per_base = 1 means 1 unit of quote per 1 unit of base
  // Since both are ETH in wei, 1 means 1:1 rate
  const createDealPayload = {
    dealId: newDealId,
    visibility: "Public",
    taker: null,
    assetBase: ETH_ASSET_ID,
    assetQuote: ETH_ASSET_ID,
    chainIdBase: SEPOLIA_CHAIN_ID,
    chainIdQuote: BASE_SEPOLIA_CHAIN_ID,
    amountBase: DEPOSIT_AMOUNT.toString(),
    priceQuotePerBase: "1", // FIXED! Simple integer multiplier, 1:1 rate
  };

  const createSig = await signTx(walletA, walletA.address, stateA.nonce, "CreateDeal", createDealPayload);
  console.log("  Deal ID:", newDealId);
  console.log("  Amount: 0.01 ETH, Price: 1 (1:1 rate)");
  console.log("  amount_quote will be:", DEPOSIT_AMOUNT.toString(), "* 1 =", DEPOSIT_AMOUNT.toString(), "wei");
  console.log("  That's", ethers.formatEther(DEPOSIT_AMOUNT * BigInt(1)), "ETH - matches B's balance!");

  try {
    const result = await submitTx({
      kind: "CreateDeal",
      from: walletA.address,
      deal_id: newDealId,
      visibility: "Public",
      taker: null,
      asset_base: ETH_ASSET_ID,
      asset_quote: ETH_ASSET_ID,
      chain_id_base: SEPOLIA_CHAIN_ID,
      chain_id_quote: BASE_SEPOLIA_CHAIN_ID,
      amount_base: DEPOSIT_AMOUNT.toString(),
      price_quote_per_base: "1", // FIXED
      expires_at: null,
      external_ref: null,
      nonce: stateA.nonce,
      signature: createSig,
    });
    console.log("  Created! TX:", result.tx_hash.slice(0, 40) + "...");
  } catch (err) {
    console.error("  Create failed:", err.message);
  }
  await wait();

  // Verify deal
  stateA = await getAccount(walletA.address);
  console.log("  Account A nonce:", stateA.nonce, "open_deals:", stateA.open_deals);

  const newDealCheck = await fetch(`${API_URL}/api/v1/deal/${newDealId}`).then(r => r.json());
  console.log("  New deal status:", newDealCheck.status, "amount_remaining:", newDealCheck.amount_remaining);

  // Step 3: Account B accepts the deal
  console.log("\n=== 3. Account B accepts the deal ===");
  stateB = await getAccount(walletB.address);
  console.log("  Account B nonce:", stateB.nonce);
  console.log("  Account B balances:", JSON.stringify(stateB.balances));

  const acceptPayload = { dealId: newDealId, amount: null };
  const acceptSig = await signTx(walletB, walletB.address, stateB.nonce, "AcceptDeal", acceptPayload);

  try {
    const result = await submitTx({
      kind: "AcceptDeal",
      from: walletB.address,
      deal_id: newDealId,
      amount: null,
      nonce: stateB.nonce,
      signature: acceptSig,
    });
    console.log("  Accepted! TX:", result.tx_hash.slice(0, 40) + "...");
  } catch (err) {
    console.error("  Accept failed:", err.message);
  }
  await wait(5000); // wait a bit longer

  // Step 4: Verify final state
  console.log("\n=== 4. Final Verification ===");
  stateA = await getAccount(walletA.address);
  stateB = await getAccount(walletB.address);

  const dealFinal = await fetch(`${API_URL}/api/v1/deal/${newDealId}`).then(r => r.json());
  console.log("  Deal status:", dealFinal.status);
  console.log("  Deal amount_remaining:", dealFinal.amount_remaining);

  const findBal = (st, cid, aid) => {
    if (!st.balances) return "0";
    const b = st.balances.find(b => b.chain_id === cid && b.asset_id === aid);
    return b ? b.amount.toString() : "0";
  };

  console.log("\n  Account A (", walletA.address.slice(0, 10), "):");
  console.log("    Sepolia ETH:      ", ethers.formatEther(findBal(stateA, SEPOLIA_CHAIN_ID, ETH_ASSET_ID)));
  console.log("    Base Sepolia ETH: ", ethers.formatEther(findBal(stateA, BASE_SEPOLIA_CHAIN_ID, ETH_ASSET_ID)));
  console.log("    Nonce:", stateA.nonce, "Open deals:", stateA.open_deals);

  console.log("\n  Account B (", walletB.address.slice(0, 10), "):");
  console.log("    Sepolia ETH:      ", ethers.formatEther(findBal(stateB, SEPOLIA_CHAIN_ID, ETH_ASSET_ID)));
  console.log("    Base Sepolia ETH: ", ethers.formatEther(findBal(stateB, BASE_SEPOLIA_CHAIN_ID, ETH_ASSET_ID)));
  console.log("    Nonce:", stateB.nonce);

  // Expected:
  // A: 0 Sepolia, 0.01 Base (received from B)
  // B: 0.01 Sepolia (received from A), 0 Base
  const aBase = BigInt(findBal(stateA, BASE_SEPOLIA_CHAIN_ID, ETH_ASSET_ID));
  const bSepolia = BigInt(findBal(stateB, SEPOLIA_CHAIN_ID, ETH_ASSET_ID));
  const aSepolia = BigInt(findBal(stateA, SEPOLIA_CHAIN_ID, ETH_ASSET_ID));
  const bBase = BigInt(findBal(stateB, BASE_SEPOLIA_CHAIN_ID, ETH_ASSET_ID));

  console.log("\n  === RESULT ===");
  if (dealFinal.status === "Settled" &&
      aBase === DEPOSIT_AMOUNT && bSepolia === DEPOSIT_AMOUNT &&
      aSepolia === BigInt(0) && bBase === BigInt(0)) {
    console.log("  ✅ CROSS-CHAIN SWAP SUCCESSFUL!");
    console.log("  Account A: sold 0.01 ETH on Sepolia → received 0.01 ETH on Base Sepolia");
    console.log("  Account B: sold 0.01 ETH on Base Sepolia → received 0.01 ETH on Sepolia");
  } else if (dealFinal.status === "Settled") {
    console.log("  ⚠️  Deal settled but balances don't match expected values");
  } else {
    console.log("  ❌ SWAP NOT COMPLETED - Deal status:", dealFinal.status);
    console.log("  Debug: Check if AcceptDeal nonce was correct");
  }

  console.log("\n========================================\n");
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
