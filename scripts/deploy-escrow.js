/**
 * Deploy EscrowSwap contract for vesting token marketplace
 * Deploys to Ethereum Sepolia (and optionally Base Sepolia)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-escrow.js
 */

const hre = require("hardhat");
const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";

const FEE_BPS = 100; // 1% fee

async function deployToChain(chainName, rpcUrl) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Deploying EscrowSwap to ${chainName}`);
  console.log("=".repeat(60));

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error(`No balance on ${chainName}! Fund ${wallet.address} first.`);
  }

  const EscrowArtifact = JSON.parse(
    fs.readFileSync("./artifacts/contracts/EscrowSwap.sol/EscrowSwap.json")
  );

  console.log(`\nDeploying EscrowSwap (fee: ${FEE_BPS / 100}%)...`);
  const EscrowFactory = new ethers.ContractFactory(
    EscrowArtifact.abi,
    EscrowArtifact.bytecode,
    wallet
  );

  const escrow = await EscrowFactory.deploy(
    FEE_BPS,          // 1% fee
    wallet.address,    // fee recipient = deployer
    wallet.address     // owner = deployer
  );
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log(`EscrowSwap: ${escrowAddr}`);

  return {
    chainName,
    deployer: wallet.address,
    escrow: escrowAddr,
  };
}

async function main() {
  console.log("Axync EscrowSwap Deployment\n");

  console.log("Compiling contracts...");
  await hre.run("compile");
  console.log("Compiled\n");

  const sepolia = await deployToChain("Ethereum Sepolia", SEPOLIA_RPC);

  // Save deployment info
  const deployment = {
    timestamp: new Date().toISOString(),
    deployer: sepolia.deployer,
    feeBps: FEE_BPS,
    sepolia,
  };

  fs.writeFileSync("deployment-escrow.json", JSON.stringify(deployment, null, 2));

  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log(`\nDeployer: ${sepolia.deployer}`);
  console.log(`Fee: ${FEE_BPS / 100}%`);
  console.log(`\nEthereum Sepolia:`);
  console.log(`  EscrowSwap: ${sepolia.escrow}`);

  // Known vesting contracts on Sepolia
  console.log("\nKnown vesting contracts (Sepolia):");
  console.log("  Sablier Lockup:        0x6b0307b4338f2963A62106028E3B074C2c0510DA");
  console.log("  Hedgey TokenLockup:    0xb49d0CD3D5290adb4aF1eBA7A6B90CdE8B9265ff");
  console.log("  Hedgey TokenVesting:   0x68b6986416c7A38F630cBc644a2833A0b78b3631");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
