/**
 * End-to-end cross-chain ERC-20 flow test
 * Seller lists ERC-20 tokens on Sepolia → Buyer pays on Base → Buyer claims tokens
 */

const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

const SELLER_KEY = process.env.PRIVATE_KEY;
const BUYER_KEY = "0x37b08ddf875bbba8e770e24c854c8fc561587a1ef55f2fd106472e4fa61138c3";
const API_URL = "http://204.168.130.135:8080";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const BASE_RPC = "https://base-sepolia-rpc.publicnode.com";

const deployment = JSON.parse(fs.readFileSync("deployment-marketplace.json"));

function loadABI(name) {
  return JSON.parse(fs.readFileSync(`./artifacts/contracts/${name}.sol/${name}.json`)).abi;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollAPI(path, check, maxAttempts = 60, interval = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${API_URL}${path}`);
      const data = await res.json();
      if (check(data)) return data;
    } catch (e) {}
    process.stdout.write(".");
    await sleep(interval);
  }
  throw new Error(`Timeout waiting for ${path}`);
}

const EIP712_DOMAIN = { name: "Axync", version: "1" };
const BUYNFT_TYPES = {
  BuyNft: [
    { name: "from", type: "address" },
    { name: "nonce", type: "uint64" },
    { name: "listingId", type: "uint64" },
  ],
};

async function main() {
  console.log("=== AXYNC CROSS-CHAIN ERC-20 FLOW TEST ===\n");

  const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);

  const sellerSepolia = new ethers.Wallet(SELLER_KEY, sepoliaProvider);
  const buyerBase = new ethers.Wallet(BUYER_KEY, baseProvider);
  const buyerSepolia = new ethers.Wallet(BUYER_KEY, sepoliaProvider);

  console.log(`Seller: ${sellerSepolia.address}`);
  console.log(`Buyer:  ${buyerBase.address}`);

  const escrowABI = loadABI("AxyncEscrow");
  const vaultABI = loadABI("AxyncVault");
  const erc20ABI = loadABI("ERC20Mock");

  const escrow = new ethers.Contract(deployment.sepolia.escrow, escrowABI, sellerSepolia);
  const vault = new ethers.Contract(deployment.baseSepolia.vault, vaultABI, buyerBase);
  const token = new ethers.Contract(deployment.sepolia.erc20Mock, erc20ABI, sellerSepolia);

  const TOKEN_AMOUNT = ethers.parseEther("1000"); // 1000 tokens
  const PRICE = ethers.parseEther("0.0001"); // 0.0001 ETH
  const PAYMENT_CHAIN = 84532;

  // ═══════════════════════════════════════
  // STEP 1: List ERC-20 tokens on Sepolia
  // ═══════════════════════════════════════
  console.log(`\n── STEP 1: List ${ethers.formatEther(TOKEN_AMOUNT)} MOCK tokens on Sepolia ──`);

  const balance = await token.balanceOf(sellerSepolia.address);
  console.log(`Seller token balance: ${ethers.formatEther(balance)}`);

  // Approve escrow to transfer tokens
  let tx = await token.approve(deployment.sepolia.escrow, TOKEN_AMOUNT);
  await tx.wait();
  console.log("Approved ✓");

  // List tokens
  tx = await escrow.listToken(deployment.sepolia.erc20Mock, TOKEN_AMOUNT, PRICE, PAYMENT_CHAIN);
  const listReceipt = await tx.wait();

  const listEvent = listReceipt.logs.find(l => {
    try { return escrow.interface.parseLog(l)?.name === "TokenListed"; } catch { return false; }
  });
  const listingId = escrow.interface.parseLog(listEvent).args.listingId;
  console.log(`Listed! On-chain listing ID: ${listingId}`);

  // ═══════════════════════════════════════
  // STEP 2: Wait for watcher
  // ═══════════════════════════════════════
  console.log("\n── STEP 2: Waiting for watcher to detect listing ──");

  const listings = await pollAPI("/api/v1/nft-listings", (data) => {
    return data.listings && data.listings.some(
      l => l.on_chain_listing_id === Number(listingId) && l.status === "Active"
    );
  });

  const seqListing = listings.listings.find(l => l.on_chain_listing_id === Number(listingId));
  console.log(`\nWatcher detected! Sequencer listing ID: ${seqListing.id}, asset_type: ${seqListing.asset_type}`);

  // ═══════════════════════════════════════
  // STEP 3: Deposit ETH on Base
  // ═══════════════════════════════════════
  console.log("\n── STEP 3: Deposit ETH on Base AxyncVault ──");

  tx = await vault.depositNative(0, { value: PRICE });
  await tx.wait();
  console.log(`Deposited ${ethers.formatEther(PRICE)} ETH ✓`);

  // ═══════════════════════════════════════
  // STEP 4: Wait for deposit
  // ═══════════════════════════════════════
  console.log("\n── STEP 4: Waiting for deposit in sequencer ──");

  await pollAPI(
    `/api/v1/account/${buyerBase.address}`,
    (data) => data.balances && data.balances.some(b => b.amount > 0),
    60, 2000
  );
  console.log(`\nBalance credited ✓`);

  // ═══════════════════════════════════════
  // STEP 5: Submit BuyNft TX
  // ═══════════════════════════════════════
  console.log("\n── STEP 5: Submit BuyNft (EIP-712 signed) ──");

  const accountData = await fetch(`${API_URL}/api/v1/account/${buyerBase.address}`).then(r => r.json());
  const nonce = accountData.nonce || 0;

  const signature = await buyerSepolia.signTypedData(EIP712_DOMAIN, BUYNFT_TYPES, {
    from: buyerBase.address,
    nonce: nonce,
    listingId: seqListing.id,
  });

  const submitRes = await fetch(`${API_URL}/api/v1/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "BuyNft",
      from: buyerBase.address,
      listing_id: seqListing.id,
      nonce: nonce,
      signature: signature,
    }),
  });
  console.log(`Submit response: ${submitRes.status}`);

  if (!submitRes.ok) {
    console.log("❌ BuyNft failed:", await submitRes.text());
    return;
  }

  // ═══════════════════════════════════════
  // STEP 6: Wait for block
  // ═══════════════════════════════════════
  console.log("\n── STEP 6: Waiting for block ──");

  await pollAPI("/api/v1/nft-listings", (data) => {
    return data.listings && data.listings.some(
      l => l.id === seqListing.id && l.status === "Sold"
    );
  }, 30, 2000);
  console.log("Listing sold ✓");

  // ═══════════════════════════════════════
  // STEP 7: Get merkle proof
  // ═══════════════════════════════════════
  console.log("\n── STEP 7: Get merkle proof ──");

  const proofData = await fetch(`${API_URL}/api/v1/nft-release-proof/${seqListing.id}`).then(r => r.json());
  console.log("Proof:", JSON.stringify(proofData, null, 2));

  // ═══════════════════════════════════════
  // STEP 7.5: Wait for relayer
  // ═══════════════════════════════════════
  console.log("\n── STEP 7.5: Wait for relayer ──");

  const escrowReadOnly = new ethers.Contract(deployment.sepolia.escrow, escrowABI, sepoliaProvider);
  for (let i = 0; i < 120; i++) {
    const root = await escrowReadOnly.withdrawalsRoot();
    if (root === proofData.leaf) {
      console.log(`\nwithdrawalsRoot matches! ${root.slice(0, 18)}...`);
      break;
    }
    if (i % 10 === 0 && i > 0) console.log(`\n  root: ${root.slice(0,18)}... waiting for ${proofData.leaf.slice(0,18)}...`);
    process.stdout.write(".");
    await sleep(3000);
  }

  // ═══════════════════════════════════════
  // STEP 8: Claim tokens on Sepolia
  // ═══════════════════════════════════════
  console.log("\n── STEP 8: Claim tokens on Sepolia (buyer) ──");

  const escrowAsBuyer = new ethers.Contract(deployment.sepolia.escrow, escrowABI, buyerSepolia);
  tx = await escrowAsBuyer.claim(
    listingId,
    proofData.buyer,
    proofData.merkle_proof,
    proofData.nullifier
  );
  const claimReceipt = await tx.wait();
  console.log(`Tokens claimed! TX: ${claimReceipt.hash}`);

  // Verify
  const buyerBalance = await token.balanceOf(buyerSepolia.address);
  console.log(`Buyer token balance: ${ethers.formatEther(buyerBalance)}`);

  console.log("\n=== ✅ FULL CROSS-CHAIN ERC-20 FLOW COMPLETE ===");
}

main().catch(e => {
  console.error("\nError:", e.message || e);
  process.exit(1);
});
