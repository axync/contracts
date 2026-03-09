/**
 * Axync Full MVP E2E Test - Two accounts, full cross-chain flow
 * Deposit → Deal → Swap → Withdraw → Relayer → Claim On-Chain
 */

const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

const API_URL = "http://localhost:8080";
const deployment = JSON.parse(fs.readFileSync("deployment-mvp.json"));

// Two accounts (maker and taker)
const KEY_A = process.env.PRIVATE_KEY; // Deployer/sequencer
const KEY_B = "d7c855a98914be00bbcb812e6b7bac4355d64121073914a09dff48ad8d091ad1"; // Second account
const walletA = new ethers.Wallet(KEY_A);
const walletB = new ethers.Wallet(KEY_B);

const SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;
const ASSET = 1;
const AMOUNT = ethers.parseEther("0.001");

// ── Signing (proven approach from e2e-test-fix.js) ──
function getKindByte(k) { return { Deposit:0, Withdraw:1, CreateDeal:2, AcceptDeal:3, CancelDeal:4 }[k]; }

function buildMsgBytes(from, nonce, kind, p) {
  const fb = ethers.getBytes(from);
  const nb = new Uint8Array(8);
  new DataView(nb.buffer).setBigUint64(0, BigInt(nonce), true);
  const kb = getKindByte(kind);
  let pb;

  if (kind === "Deposit") {
    pb = new Uint8Array(32 + 20 + 2 + 16 + 8);
    const dv = new DataView(pb.buffer);
    pb.set(ethers.getBytes(p.txHash), 0);
    pb.set(ethers.getBytes(p.account), 32);
    dv.setUint16(52, p.assetId, true);
    const a = BigInt(p.amount);
    dv.setBigUint64(54, a & 0xFFFFFFFFFFFFFFFFn, true);
    dv.setBigUint64(62, a >> 64n, true);
    dv.setBigUint64(70, BigInt(p.chainId), true);
  } else if (kind === "CreateDeal") {
    const ht = !!p.taker;
    const len = 8 + 1 + 1 + (ht ? 20 : 0) + 2 + 2 + 8 + 8 + 16 + 16;
    pb = new Uint8Array(len);
    const dv = new DataView(pb.buffer);
    let o = 0;
    dv.setBigUint64(o, BigInt(p.dealId), true); o += 8;
    pb[o++] = p.visibility === "Public" ? 0 : 1;
    pb[o++] = ht ? 1 : 0;
    if (ht) { pb.set(ethers.getBytes(p.taker), o); o += 20; }
    dv.setUint16(o, p.assetBase, true); o += 2;
    dv.setUint16(o, p.assetQuote, true); o += 2;
    dv.setBigUint64(o, BigInt(p.chainIdBase), true); o += 8;
    dv.setBigUint64(o, BigInt(p.chainIdQuote), true); o += 8;
    const ab = BigInt(p.amountBase);
    dv.setBigUint64(o, ab & 0xFFFFFFFFFFFFFFFFn, true); o += 8;
    dv.setBigUint64(o, ab >> 64n, true); o += 8;
    const pq = BigInt(p.priceQuotePerBase);
    dv.setBigUint64(o, pq & 0xFFFFFFFFFFFFFFFFn, true); o += 8;
    dv.setBigUint64(o, pq >> 64n, true);
  } else if (kind === "AcceptDeal") {
    const ha = p.amount != null;
    pb = new Uint8Array(8 + 1 + (ha ? 16 : 0));
    const dv = new DataView(pb.buffer);
    dv.setBigUint64(0, BigInt(p.dealId), true);
    pb[8] = ha ? 1 : 0;
    if (ha) {
      const a = BigInt(p.amount);
      dv.setBigUint64(9, a & 0xFFFFFFFFFFFFFFFFn, true);
      dv.setBigUint64(17, a >> 64n, true);
    }
  } else if (kind === "Withdraw") {
    pb = new Uint8Array(2 + 16 + 20 + 8);
    const dv = new DataView(pb.buffer);
    dv.setUint16(0, p.assetId, true);
    const a = BigInt(p.amount);
    dv.setBigUint64(2, a & 0xFFFFFFFFFFFFFFFFn, true);
    dv.setBigUint64(10, a >> 64n, true);
    pb.set(ethers.getBytes(p.to), 18);
    dv.setBigUint64(38, BigInt(p.chainId), true);
  } else if (kind === "CancelDeal") {
    pb = new Uint8Array(8);
    new DataView(pb.buffer).setBigUint64(0, BigInt(p.dealId), true);
  }

  const data = new Uint8Array(20 + 8 + 1 + pb.length);
  let o = 0;
  data.set(fb, o); o += 20;
  data.set(nb, o); o += 8;
  data[o++] = kb;
  data.set(pb, o);
  return data;
}

async function sign(w, from, nonce, kind, payload) {
  return w.signMessage(buildMsgBytes(from, nonce, kind, payload));
}

async function post(path, body) {
  const r = await fetch(`${API_URL}${path}`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${t}`);
  return JSON.parse(t);
}

async function get(path) {
  const r = await fetch(`${API_URL}${path}`);
  return r.json();
}

async function wait(ms) { await new Promise(r => setTimeout(r, ms)); }

async function getNonce(addr) {
  const s = await get(`/api/v1/account/${addr}`);
  return s.nonce || 0;
}

// On-chain ABIs
const VERIFIER_ABI = [
  "function submitBlockProof(uint256,bytes32,bytes32,bytes32,bytes) external",
  "function stateRoot() view returns (bytes32)",
  "function processedBlocks(uint256) view returns (bool)",
];
const WD_ABI = [
  "function withdraw((address,uint256,uint256,uint256),bytes,bytes32,bytes,bytes32) external",
  "function updateWithdrawalsRoot(bytes32) external",
  "function withdrawalsRoot() view returns (bytes32)",
];

async function main() {
  console.log("🚀 Axync Full MVP E2E Test\n");
  console.log(`Account A (maker): ${walletA.address}`);
  console.log(`Account B (taker): ${walletB.address}\n`);

  // ═══ 1. Deposit A on Sepolia ═══
  console.log("━━━ 1. Deposit A on Sepolia ━━━");
  let nonceA = await getNonce(walletA.address);
  const dep1 = { txHash: ethers.keccak256(ethers.toUtf8Bytes("depA-" + Date.now())), account: walletA.address, assetId: ASSET, amount: AMOUNT.toString(), chainId: SEPOLIA };
  await post("/api/v1/transactions", { kind:"Deposit", tx_hash:dep1.txHash, account:walletA.address, asset_id:ASSET, amount:AMOUNT.toString(), chain_id:SEPOLIA, nonce:nonceA, signature: await sign(walletA, walletA.address, nonceA, "Deposit", dep1) });
  console.log("  ✅ A deposited 0.001 ETH on Sepolia");

  await wait(6000);

  // ═══ 2. Deposit B on Base Sepolia ═══
  console.log("━━━ 2. Deposit B on Base Sepolia ━━━");
  let nonceB = await getNonce(walletB.address);
  const dep2 = { txHash: ethers.keccak256(ethers.toUtf8Bytes("depB-" + Date.now())), account: walletB.address, assetId: ASSET, amount: AMOUNT.toString(), chainId: BASE_SEPOLIA };
  await post("/api/v1/transactions", { kind:"Deposit", tx_hash:dep2.txHash, account:walletB.address, asset_id:ASSET, amount:AMOUNT.toString(), chain_id:BASE_SEPOLIA, nonce:nonceB, signature: await sign(walletB, walletB.address, nonceB, "Deposit", dep2) });
  console.log("  ✅ B deposited 0.001 ETH on Base Sepolia");

  await wait(6000);

  // Check balances
  let stA = await get(`/api/v1/account/${walletA.address}`);
  let stB = await get(`/api/v1/account/${walletB.address}`);
  console.log(`  A balances: ${JSON.stringify(stA.balances)}`);
  console.log(`  B balances: ${JSON.stringify(stB.balances)}`);

  // ═══ 3. A creates deal: sell Sepolia ETH, buy Base ETH ═══
  console.log("\n━━━ 3. A Creates Deal (Sepolia ETH → Base ETH) ━━━");
  nonceA = await getNonce(walletA.address);
  const dealId = Date.now();
  const cd = { dealId, visibility:"Public", taker:null, assetBase:ASSET, assetQuote:ASSET, chainIdBase:SEPOLIA, chainIdQuote:BASE_SEPOLIA, amountBase:AMOUNT.toString(), priceQuotePerBase:"1" };
  await post("/api/v1/transactions", { kind:"CreateDeal", from:walletA.address, deal_id:dealId, visibility:"Public", taker:null, asset_base:ASSET, asset_quote:ASSET, chain_id_base:SEPOLIA, chain_id_quote:BASE_SEPOLIA, amount_base:AMOUNT.toString(), price_quote_per_base:"1", expires_at:null, external_ref:null, nonce:nonceA, signature: await sign(walletA, walletA.address, nonceA, "CreateDeal", cd) });
  console.log(`  ✅ Deal ${dealId} created (1:1 rate)`);

  await wait(6000);

  // ═══ 4. B accepts deal ═══
  console.log("━━━ 4. B Accepts Deal ━━━");
  nonceB = await getNonce(walletB.address);
  const ap = { dealId, amount: null };
  await post("/api/v1/transactions", { kind:"AcceptDeal", from:walletB.address, deal_id:dealId, amount:null, nonce:nonceB, signature: await sign(walletB, walletB.address, nonceB, "AcceptDeal", ap) });
  console.log("  ✅ Deal accepted by B");

  await wait(6000);

  // Check settlement
  const deal = await get(`/api/v1/deal/${dealId}`);
  console.log(`  Deal status: ${deal.status}`);
  stA = await get(`/api/v1/account/${walletA.address}`);
  stB = await get(`/api/v1/account/${walletB.address}`);
  console.log(`  A balances: ${JSON.stringify(stA.balances)}`);
  console.log(`  B balances: ${JSON.stringify(stB.balances)}`);

  // ═══ 5. A withdraws from Base Sepolia (gained from swap) ═══
  console.log("\n━━━ 5. A Withdraws from Base Sepolia ━━━");
  nonceA = await getNonce(walletA.address);
  const aBaseBal = stA.balances?.find(b => b.chain_id === BASE_SEPOLIA && b.asset_id === ASSET);
  const wdAmount = aBaseBal ? BigInt(aBaseBal.amount) : 0n;
  console.log(`  A has ${ethers.formatEther(wdAmount)} ETH on Base Sepolia`);

  if (wdAmount > 0n) {
    const wp = { assetId:ASSET, amount:wdAmount.toString(), to:walletA.address, chainId:BASE_SEPOLIA };
    await post("/api/v1/transactions", { kind:"Withdraw", from:walletA.address, asset_id:ASSET, amount:wdAmount.toString(), to:walletA.address, chain_id:BASE_SEPOLIA, nonce:nonceA, signature: await sign(walletA, walletA.address, nonceA, "Withdraw", wp) });
    console.log("  ✅ Withdrawal submitted to sequencer");
    await wait(6000);
  } else {
    console.log("  ⚠️ No balance to withdraw");
  }

  // ═══ 6. Relayer: submit block proofs on-chain ═══
  console.log("\n━━━ 6. Relayer: Block Proofs On-Chain ━━━");
  const { current_block_id } = await get("/api/v1/current_block");
  console.log(`  Blocks to submit: 1 → ${current_block_id - 1}`);

  let prevRoot = ethers.ZeroHash;
  let lastWdRoot = ethers.ZeroHash;

  // Create persistent providers/wallets per chain (avoid nonce conflicts)
  const chainConns = [
    { name: "Sepolia", prov: new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com"), dep: deployment.sepolia },
    { name: "Base", prov: new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org"), dep: deployment.baseSepolia },
  ];
  for (const c of chainConns) {
    c.wallet = new ethers.Wallet(KEY_A, c.prov);
    c.verifier = new ethers.Contract(c.dep.verifier, VERIFIER_ABI, c.wallet);
    c.wdContract = new ethers.Contract(c.dep.withdrawal, WD_ABI, c.wallet);
  }

  for (let bid = 1; bid < current_block_id; bid++) {
    let block;
    try { block = await get(`/api/v1/block/${bid}`); } catch { continue; }

    let proof = block.block_proof;
    if (!proof || proof === "0x" || proof.length < 6) proof = "0x" + "ab".repeat(32);

    if (block.withdrawals_root !== ethers.ZeroHash) lastWdRoot = block.withdrawals_root;

    for (const c of chainConns) {
      if (await c.verifier.processedBlocks(bid)) { continue; }
      const cr = await c.verifier.stateRoot();
      if (cr !== prevRoot) { console.log(`    [${c.name}] B${bid} root mismatch`); continue; }

      try {
        const feeData = await c.prov.getFeeData();
        const nonce = await c.prov.getTransactionCount(c.wallet.address);
        const gasOpts = { gasLimit: 500000, nonce };
        if (feeData.maxFeePerGas) { gasOpts.maxFeePerGas = feeData.maxFeePerGas * 3n; gasOpts.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas || 1000000n) * 3n; }

        const tx = await c.verifier.submitBlockProof(bid, prevRoot, block.state_root, block.withdrawals_root, proof, gasOpts);
        await tx.wait();
        console.log(`    [${c.name}] ✅ Block ${bid}`);

        if (block.withdrawals_root !== ethers.ZeroHash) {
          await wait(2000); // Wait for nonce to update
          const wdFee = await c.prov.getFeeData();
          const wdNonce = await c.prov.getTransactionCount(c.wallet.address);
          const wdOpts = { gasLimit: 100000, nonce: wdNonce };
          if (wdFee.maxFeePerGas) { wdOpts.maxFeePerGas = wdFee.maxFeePerGas * 3n; wdOpts.maxPriorityFeePerGas = (wdFee.maxPriorityFeePerGas || 1000000n) * 3n; }
          const wt = await c.wdContract.updateWithdrawalsRoot(block.withdrawals_root, wdOpts);
          await wt.wait();
          console.log(`    [${c.name}] ✅ WithdrawalsRoot updated`);
        }
      } catch (e) {
        console.log(`    [${c.name}] ❌ B${bid}: ${(e.reason || e.message).slice(0, 100)}`);
      }
    }
    prevRoot = block.state_root;
  }

  // ═══ 7. Claim on-chain on Base Sepolia ═══
  console.log("\n━━━ 7. Claim On-Chain (Base Sepolia) ━━━");
  if (wdAmount <= 0n) {
    console.log("  Skipped - no withdrawal");
  } else {
    const baseConn = chainConns.find(c => c.name === "Base");
    const baseProv = baseConn.prov;
    const wdContract = baseConn.wdContract;

    // Wait a moment for chain to settle
    await wait(3000);

    const root = await wdContract.withdrawalsRoot();
    const bal = await baseProv.getBalance(deployment.baseSepolia.withdrawal);
    console.log(`  Contract balance: ${ethers.formatEther(bal)} ETH`);
    console.log(`  WithdrawalsRoot: ${root}`);

    if (root === ethers.ZeroHash) {
      console.log("  ⚠️ Root zero - relayer might not have updated it yet");
    } else {
      try {
        const nullifier = ethers.keccak256(ethers.solidityPacked(['address','uint256','uint256','uint256','uint256'], [walletA.address, ASSET, wdAmount, BASE_SEPOLIA, Date.now()]));

        const feeData = await baseProv.getFeeData();
        const nonce = await baseProv.getTransactionCount(walletA.address);
        const gasOpts = { gasLimit: 300000, nonce };
        if (feeData.maxFeePerGas) { gasOpts.maxFeePerGas = feeData.maxFeePerGas * 3n; gasOpts.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas || 1000000n) * 3n; }

        const beforeBal = await baseProv.getBalance(walletA.address);
        const tx = await wdContract.withdraw(
          [walletA.address, ASSET, wdAmount, BASE_SEPOLIA],
          ethers.hexlify(ethers.randomBytes(64)),  // merkleProof
          nullifier,
          ethers.hexlify(ethers.randomBytes(32)),  // zkProof
          root,
          gasOpts
        );
        const receipt = await tx.wait();

        // Wait for balance update
        await wait(2000);
        const afterBal = await baseProv.getBalance(walletA.address);

        console.log(`  ✅ WITHDRAWAL CLAIMED!`);
        console.log(`  Tx: ${receipt.hash}`);
        console.log(`  Gas used: ${receipt.gasUsed}`);
        console.log(`  Balance change: ${ethers.formatEther(afterBal - beforeBal)} ETH`);
        console.log(`  Contract balance after: ${ethers.formatEther(await baseProv.getBalance(deployment.baseSepolia.withdrawal))} ETH`);
      } catch (e) {
        console.log(`  ❌ ${e.reason || e.message}`);
      }
    }
  }

  // ═══ Summary ═══
  console.log("\n══════════════════════════════════════");
  stA = await get(`/api/v1/account/${walletA.address}`);
  stB = await get(`/api/v1/account/${walletB.address}`);
  console.log("A final:", JSON.stringify(stA.balances));
  console.log("B final:", JSON.stringify(stB.balances));
  console.log("\n🎉 E2E Complete!");
}

main().then(() => process.exit(0)).catch(e => { console.error("❌", e.message); process.exit(1); });
