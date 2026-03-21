/**
 * End-to-end cross-chain flow test with EIP-712 signatures
 */

const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

const SELLER_KEY = process.env.PRIVATE_KEY;
const BUYER_KEY = "0x37b08ddf875bbba8e770e24c854c8fc561587a1ef55f2fd106472e4fa61138c3";
const API_URL = "http://204.168.130.135:8080";
const SEPOLIA_RPC = "https://sepolia.drpc.org";
const BASE_RPC = "https://sepolia.base.org";

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

// EIP-712 domain matching Rust sequencer
const EIP712_DOMAIN = {
  name: "Axync",
  version: "1",
};

// BuyNft EIP-712 type
const BUYNFT_TYPES = {
  BuyNft: [
    { name: "from", type: "address" },
    { name: "nonce", type: "uint64" },
    { name: "listingId", type: "uint64" },
  ],
};

async function main() {
  console.log("=== AXYNC CROSS-CHAIN FLOW TEST ===\n");

  const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);

  // Seller = deployer (owns NFTs)
  const sellerSepolia = new ethers.Wallet(SELLER_KEY, sepoliaProvider);
  // Buyer = separate wallet (deposits on Base, buys NFT)
  const buyerBase = new ethers.Wallet(BUYER_KEY, baseProvider);
  const buyerSepolia = new ethers.Wallet(BUYER_KEY, sepoliaProvider);

  console.log(`Seller: ${sellerSepolia.address}`);
  console.log(`Buyer:  ${buyerBase.address}`);
  console.log(`Seller Sepolia ETH: ${ethers.formatEther(await sepoliaProvider.getBalance(sellerSepolia.address))}`);
  console.log(`Buyer Base ETH: ${ethers.formatEther(await baseProvider.getBalance(buyerBase.address))}`);

  const escrowABI = loadABI("AxyncEscrow");
  const vaultABI = loadABI("AxyncVault");
  const mockABI = loadABI("ERC721Mock");

  const escrow = new ethers.Contract(deployment.sepolia.escrow, escrowABI, sellerSepolia);
  const vault = new ethers.Contract(deployment.baseSepolia.vault, vaultABI, buyerBase);
  const mock = new ethers.Contract(deployment.sepolia.erc721Mock, mockABI, sellerSepolia);

  // ═══════════════════════════════════════
  // STEP 1: List NFT on Sepolia
  // ═══════════════════════════════════════
  const TOKEN_ID = 1;
  const PRICE = ethers.parseEther("0.001");
  const PAYMENT_CHAIN = 84532; // Base Sepolia

  console.log(`\n── STEP 1: List NFT #${TOKEN_ID} on Sepolia ──`);

  const owner = await mock.ownerOf(TOKEN_ID);
  console.log(`Token #${TOKEN_ID} owner: ${owner}`);
  if (owner.toLowerCase() !== sellerSepolia.address.toLowerCase()) {
    console.log("ERROR: We don't own this token!");
    return;
  }

  console.log("Approving NFT to escrow...");
  let tx = await mock.approve(deployment.sepolia.escrow, TOKEN_ID);
  await tx.wait();
  console.log("Approved ✓");

  console.log("Listing NFT...");
  tx = await escrow.list(deployment.sepolia.erc721Mock, TOKEN_ID, PRICE, PAYMENT_CHAIN);
  const listReceipt = await tx.wait();

  const listEvent = listReceipt.logs.find(l => escrow.interface.parseLog(l)?.name === "NftListed");
  const listingId = escrow.interface.parseLog(listEvent).args.listingId;
  console.log(`Listed! On-chain listing ID: ${listingId}`);

  // ═══════════════════════════════════════
  // STEP 2: Wait for watcher to detect listing
  // ═══════════════════════════════════════
  console.log("\n── STEP 2: Waiting for watcher to detect listing ──");

  const listings = await pollAPI("/api/v1/nft-listings", (data) => {
    return data.listings && data.listings.some(
      l => l.on_chain_listing_id === Number(listingId) && l.status === "Active"
    );
  });

  const seqListing = listings.listings.find(l => l.on_chain_listing_id === Number(listingId));
  console.log(`\nWatcher detected! Sequencer listing ID: ${seqListing.id}`);

  // ═══════════════════════════════════════
  // STEP 3: Deposit ETH on Base Sepolia
  // ═══════════════════════════════════════
  console.log("\n── STEP 3: Deposit ETH on Base AxyncVault ──");

  tx = await vault.depositNative(0, { value: PRICE });
  await tx.wait();
  console.log(`Deposited ${ethers.formatEther(PRICE)} ETH ✓`);

  // ═══════════════════════════════════════
  // STEP 4: Wait for deposit to be credited
  // ═══════════════════════════════════════
  console.log("\n── STEP 4: Waiting for deposit in sequencer ──");

  const account = await pollAPI(
    `/api/v1/account/${buyerBase.address}`,
    (data) => data.balances && data.balances.some(b => b.amount > 0),
    60, 2000
  );
  console.log(`\nBalance credited ✓`);

  // ═══════════════════════════════════════
  // STEP 5: Submit BuyNft TX with EIP-712 signature
  // ═══════════════════════════════════════
  console.log("\n── STEP 5: Submit BuyNft (EIP-712 signed) ──");

  // Get current nonce from sequencer
  const accountData = await fetch(`${API_URL}/api/v1/account/${buyerBase.address}`).then(r => r.json());
  const nonce = accountData.nonce || 0;
  console.log(`Buyer sequencer nonce: ${nonce}`);

  // Sign EIP-712 typed data with buyer key
  const buyNftMessage = {
    from: buyerBase.address,
    nonce: nonce,
    listingId: seqListing.id,
  };

  const signature = await buyerSepolia.signTypedData(EIP712_DOMAIN, BUYNFT_TYPES, buyNftMessage);
  console.log(`Signature: ${signature.slice(0, 20)}...`);

  // Submit to API
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
  const submitText = await submitRes.text();
  console.log(`Submit response (${submitRes.status}): ${submitText}`);

  if (!submitRes.ok) {
    console.log("\n❌ BuyNft submission failed. Debug info:");
    console.log("Listing:", JSON.stringify(seqListing));
    console.log("Nonce:", nonce);
    return;
  }

  // ═══════════════════════════════════════
  // STEP 6: Wait for block execution
  // ═══════════════════════════════════════
  console.log("\n── STEP 6: Waiting for block with BuyNft ──");

  await pollAPI("/api/v1/nft-listings", (data) => {
    return data.listings && data.listings.some(
      l => l.id === seqListing.id && l.status === "Sold"
    );
  }, 30, 2000);
  console.log("Listing sold in sequencer ✓");

  // ═══════════════════════════════════════
  // STEP 7: Get merkle proof
  // ═══════════════════════════════════════
  console.log("\n── STEP 7: Get merkle proof ──");

  const proofRes = await fetch(`${API_URL}/api/v1/nft-release-proof/${seqListing.id}`);
  const proofData = await proofRes.json();
  console.log("Proof:", JSON.stringify(proofData, null, 2));

  // ═══════════════════════════════════════
  // STEP 8: Claim NFT on Sepolia
  // ═══════════════════════════════════════
  console.log("\n── STEP 8: Claim NFT on Sepolia (buyer) ──");

  // Buyer claims — need to connect escrow with buyer wallet
  const escrowAsBuyer = new ethers.Contract(deployment.sepolia.escrow, escrowABI, buyerSepolia);
  tx = await escrowAsBuyer.claimNft(
    listingId,
    proofData.buyer,
    proofData.merkle_proof,
    proofData.nullifier
  );
  const claimReceipt = await tx.wait();
  console.log(`NFT claimed! TX: ${claimReceipt.hash}`);

  // Verify
  const newOwner = await mock.ownerOf(TOKEN_ID);
  console.log(`Token #${TOKEN_ID} new owner: ${newOwner}`);

  console.log("\n=== ✅ FULL CROSS-CHAIN FLOW COMPLETE ===");
}

main().catch(e => {
  console.error("\nError:", e.message || e);
  process.exit(1);
});
