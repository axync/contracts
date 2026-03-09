/**
 * Deploy Axync contracts to a single chain
 * Usage: CHAIN=sepolia node scripts/deploy-single-chain.js
 *        CHAIN=base_sepolia node scripts/deploy-single-chain.js
 */
const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

const CHAIN = process.env.CHAIN || "sepolia";

const CHAINS = {
  sepolia: {
    name: "Ethereum Sepolia",
    rpc: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
    chainId: 11155111,
  },
  base_sepolia: {
    name: "Base Sepolia",
    rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    chainId: 84532,
  },
};

async function main() {
  const chain = CHAINS[CHAIN];
  if (!chain) {
    console.error(`Unknown chain: ${CHAIN}. Use: sepolia or base_sepolia`);
    process.exit(1);
  }

  console.log(`\nDeploying to ${chain.name} (${chain.chainId})...\n`);

  const provider = new ethers.JsonRpcProvider(chain.rpc);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  console.log(`Nonce: ${nonce}\n`);

  // Get current gas price and bump it
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ? feeData.maxFeePerGas * 2n : undefined;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas * 2n : undefined;
  const gasOpts = maxFeePerGas ? { maxFeePerGas, maxPriorityFeePerGas } : {};

  const DepositArtifact = JSON.parse(fs.readFileSync("./artifacts/contracts/DepositContract.sol/DepositContract.json"));
  const VerifierArtifact = JSON.parse(fs.readFileSync("./artifacts/contracts/VerifierContract.sol/VerifierContract.json"));
  const WithdrawalArtifact = JSON.parse(fs.readFileSync("./artifacts/contracts/WithdrawalContract.sol/WithdrawalContract.json"));

  // 1. DepositContract
  console.log("1. Deploying DepositContract...");
  const DepositFactory = new ethers.ContractFactory(DepositArtifact.abi, DepositArtifact.bytecode, wallet);
  const deposit = await DepositFactory.deploy({ nonce: nonce, ...gasOpts });
  await deposit.waitForDeployment();
  const depositAddr = await deposit.getAddress();
  console.log(`   ✅ ${depositAddr}`);

  // 2. VerifierContract (placeholder mode - no groth16)
  console.log("2. Deploying VerifierContract...");
  const VerifierFactory = new ethers.ContractFactory(VerifierArtifact.abi, VerifierArtifact.bytecode, wallet);
  const verifier = await VerifierFactory.deploy(
    wallet.address, ethers.ZeroHash, wallet.address, ethers.ZeroAddress,
    { nonce: nonce + 1, ...gasOpts }
  );
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log(`   ✅ ${verifierAddr}`);

  // 3. WithdrawalContract
  console.log("3. Deploying WithdrawalContract...");
  const WithdrawalFactory = new ethers.ContractFactory(WithdrawalArtifact.abi, WithdrawalArtifact.bytecode, wallet);
  const withdrawal = await WithdrawalFactory.deploy(
    verifierAddr, wallet.address,
    { nonce: nonce + 2, ...gasOpts }
  );
  await withdrawal.waitForDeployment();
  const withdrawalAddr = await withdrawal.getAddress();
  console.log(`   ✅ ${withdrawalAddr}`);

  // 4. Link
  console.log("4. Linking WithdrawalContract → VerifierContract...");
  const linkTx = await verifier.setWithdrawalContract(withdrawalAddr, { nonce: nonce + 3, ...gasOpts });
  await linkTx.wait();
  console.log("   ✅ Linked");

  // 5. Fund
  const fundAmount = ethers.parseEther("0.005");
  if (balance > fundAmount * 3n) {
    console.log(`5. Funding WithdrawalContract with 0.005 ETH...`);
    const fundTx = await wallet.sendTransaction({
      to: withdrawalAddr, value: fundAmount, nonce: nonce + 4, ...gasOpts,
    });
    await fundTx.wait();
    console.log("   ✅ Funded");
  } else {
    console.log("5. Skipping funding (low balance)");
  }

  const result = {
    chainName: chain.name,
    chainId: chain.chainId,
    deployer: wallet.address,
    deposit: depositAddr,
    verifier: verifierAddr,
    withdrawal: withdrawalAddr,
  };

  // Save per-chain results
  const filename = `deployment-${CHAIN}.json`;
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`\n📋 Saved to ${filename}`);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("Error:", e.message); process.exit(1); });
