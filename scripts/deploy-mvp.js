/**
 * Deploy all Axync contracts fresh for MVP
 * Deploys to BOTH Sepolia and Base Sepolia
 * Funds WithdrawalContracts with testnet ETH
 *
 * Usage:
 *   node scripts/deploy-mvp.js
 */

const hre = require("hardhat");
const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";

async function deployToChain(chainName, rpcUrl, chainId) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Deploying to ${chainName} (Chain ID: ${chainId})`);
  console.log("=".repeat(60));

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error(`No balance on ${chainName}! Fund ${wallet.address} first.`);
  }

  // Read compiled artifacts
  const DepositArtifact = JSON.parse(fs.readFileSync("./artifacts/contracts/DepositContract.sol/DepositContract.json"));
  const VerifierArtifact = JSON.parse(fs.readFileSync("./artifacts/contracts/VerifierContract.sol/VerifierContract.json"));
  const WithdrawalArtifact = JSON.parse(fs.readFileSync("./artifacts/contracts/WithdrawalContract.sol/WithdrawalContract.json"));

  // 1. Deploy DepositContract
  console.log("\n1. Deploying DepositContract...");
  const DepositFactory = new ethers.ContractFactory(DepositArtifact.abi, DepositArtifact.bytecode, wallet);
  const deposit = await DepositFactory.deploy();
  await deposit.waitForDeployment();
  const depositAddr = await deposit.getAddress();
  console.log(`   DepositContract: ${depositAddr}`);

  // 2. Deploy VerifierContract (NO groth16 verifier - use placeholder)
  console.log("2. Deploying VerifierContract (placeholder mode)...");
  const VerifierFactory = new ethers.ContractFactory(VerifierArtifact.abi, VerifierArtifact.bytecode, wallet);
  const verifier = await VerifierFactory.deploy(
    wallet.address,                    // sequencer = deployer
    ethers.ZeroHash,                   // initial state root = 0
    wallet.address,                    // owner = deployer
    ethers.ZeroAddress                 // NO groth16 verifier → placeholder mode
  );
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log(`   VerifierContract: ${verifierAddr}`);

  // 3. Deploy WithdrawalContract
  console.log("3. Deploying WithdrawalContract...");
  const WithdrawalFactory = new ethers.ContractFactory(WithdrawalArtifact.abi, WithdrawalArtifact.bytecode, wallet);
  const withdrawal = await WithdrawalFactory.deploy(verifierAddr, wallet.address);
  await withdrawal.waitForDeployment();
  const withdrawalAddr = await withdrawal.getAddress();
  console.log(`   WithdrawalContract: ${withdrawalAddr}`);

  // 4. Link WithdrawalContract in VerifierContract
  console.log("4. Linking WithdrawalContract to VerifierContract...");
  const setWdTx = await verifier.setWithdrawalContract(withdrawalAddr);
  await setWdTx.wait();
  console.log("   ✅ Linked");

  // 5. Fund WithdrawalContract with ETH for withdrawals
  const fundAmount = ethers.parseEther("0.01"); // 0.01 ETH for testing
  if (balance > fundAmount * 2n) {
    console.log(`5. Funding WithdrawalContract with ${ethers.formatEther(fundAmount)} ETH...`);
    const fundTx = await wallet.sendTransaction({
      to: withdrawalAddr,
      value: fundAmount,
    });
    await fundTx.wait();
    const wdBalance = await provider.getBalance(withdrawalAddr);
    console.log(`   ✅ WithdrawalContract balance: ${ethers.formatEther(wdBalance)} ETH`);
  } else {
    console.log("5. Skipping funding (low balance)");
  }

  return {
    chainName,
    chainId,
    deployer: wallet.address,
    deposit: depositAddr,
    verifier: verifierAddr,
    withdrawal: withdrawalAddr,
  };
}

async function main() {
  console.log("🚀 Axync MVP - Full Deployment\n");

  // Compile contracts first
  console.log("Compiling contracts...");
  await hre.run("compile");
  console.log("✅ Compiled\n");

  // Deploy to both chains
  const sepolia = await deployToChain("Ethereum Sepolia", SEPOLIA_RPC, 11155111);
  const baseSepolia = await deployToChain("Base Sepolia", BASE_SEPOLIA_RPC, 84532);

  // Save deployment info
  const deployment = {
    timestamp: new Date().toISOString(),
    deployer: sepolia.deployer,
    sepolia,
    baseSepolia,
  };

  fs.writeFileSync("deployment-mvp.json", JSON.stringify(deployment, null, 2));

  console.log("\n" + "=".repeat(60));
  console.log("📋 DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log(`\nDeployer: ${sepolia.deployer}`);
  console.log(`\nEthereum Sepolia:`);
  console.log(`  Deposit:    ${sepolia.deposit}`);
  console.log(`  Verifier:   ${sepolia.verifier}`);
  console.log(`  Withdrawal: ${sepolia.withdrawal}`);
  console.log(`\nBase Sepolia:`);
  console.log(`  Deposit:    ${baseSepolia.deposit}`);
  console.log(`  Verifier:   ${baseSepolia.verifier}`);
  console.log(`  Withdrawal: ${baseSepolia.withdrawal}`);

  // Generate .env updates
  console.log("\n📝 Update your ui/.env with:");
  console.log(`NEXT_PUBLIC_ETHEREUM_DEPOSIT_CONTRACT=${sepolia.deposit}`);
  console.log(`NEXT_PUBLIC_BASE_DEPOSIT_CONTRACT=${baseSepolia.deposit}`);
  console.log(`NEXT_PUBLIC_ETHEREUM_WITHDRAWAL_CONTRACT=${sepolia.withdrawal}`);
  console.log(`NEXT_PUBLIC_BASE_WITHDRAWAL_CONTRACT=${baseSepolia.withdrawal}`);
  console.log(`NEXT_PUBLIC_ETHEREUM_VERIFIER_CONTRACT=${sepolia.verifier}`);
  console.log(`NEXT_PUBLIC_BASE_VERIFIER_CONTRACT=${baseSepolia.verifier}`);

  // Auto-update UI .env
  const uiEnvPath = "../ui/.env";
  if (fs.existsSync(uiEnvPath)) {
    let envContent = fs.readFileSync(uiEnvPath, "utf8");

    // Update or add contract addresses
    const updates = {
      NEXT_PUBLIC_ETHEREUM_DEPOSIT_CONTRACT: sepolia.deposit,
      NEXT_PUBLIC_BASE_DEPOSIT_CONTRACT: baseSepolia.deposit,
      NEXT_PUBLIC_ETHEREUM_WITHDRAWAL_CONTRACT: sepolia.withdrawal,
      NEXT_PUBLIC_BASE_WITHDRAWAL_CONTRACT: baseSepolia.withdrawal,
      NEXT_PUBLIC_ETHEREUM_VERIFIER_CONTRACT: sepolia.verifier,
      NEXT_PUBLIC_BASE_VERIFIER_CONTRACT: baseSepolia.verifier,
    };

    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (envContent.match(regex)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }

    fs.writeFileSync(uiEnvPath, envContent);
    console.log("\n✅ Auto-updated ui/.env");
  }

  // Auto-update UI config.ts defaults
  const configPath = "../ui/src/constants/config.ts";
  if (fs.existsSync(configPath)) {
    let configContent = fs.readFileSync(configPath, "utf8");

    // Update deposit contract defaults
    configContent = configContent.replace(
      /depositContract: process\.env\.NEXT_PUBLIC_ETHEREUM_DEPOSIT_CONTRACT \|\| '[^']+'/,
      `depositContract: process.env.NEXT_PUBLIC_ETHEREUM_DEPOSIT_CONTRACT || '${sepolia.deposit}'`
    );
    configContent = configContent.replace(
      /withdrawalContract: process\.env\.NEXT_PUBLIC_ETHEREUM_WITHDRAWAL_CONTRACT \|\| '[^']+'/,
      `withdrawalContract: process.env.NEXT_PUBLIC_ETHEREUM_WITHDRAWAL_CONTRACT || '${sepolia.withdrawal}'`
    );
    configContent = configContent.replace(
      /depositContract: process\.env\.NEXT_PUBLIC_BASE_DEPOSIT_CONTRACT \|\| '[^']+'/,
      `depositContract: process.env.NEXT_PUBLIC_BASE_DEPOSIT_CONTRACT || '${baseSepolia.deposit}'`
    );
    configContent = configContent.replace(
      /withdrawalContract: process\.env\.NEXT_PUBLIC_BASE_WITHDRAWAL_CONTRACT \|\| '[^']+'/,
      `withdrawalContract: process.env.NEXT_PUBLIC_BASE_WITHDRAWAL_CONTRACT || '${baseSepolia.withdrawal}'`
    );

    fs.writeFileSync(configPath, configContent);
    console.log("✅ Auto-updated ui/src/constants/config.ts");
  }

  console.log("\n🎉 Deployment complete! Now:");
  console.log("1. Clear backend data: rm -rf core/data/");
  console.log("2. Restart backend: cd core && cargo run --release -p axync-api");
  console.log("3. Start relayer: cd contracts && node scripts/relayer.js");
  console.log("4. Start UI: cd ui && npm run dev");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });
