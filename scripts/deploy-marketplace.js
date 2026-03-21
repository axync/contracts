/**
 * Deploy AxyncEscrow + ERC721Mock to both Sepolia and Base Sepolia
 *
 * Usage:
 *   npx hardhat run scripts/deploy-marketplace.js
 */

const hre = require("hardhat");
const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC || "https://1rpc.io/sepolia";
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";

const FEE_BPS = 100; // 1%
const EMERGENCY_TIMEOUT = 7 * 24 * 60 * 60; // 7 days

// Existing deployment
const MVP_DEPLOYMENT = JSON.parse(fs.readFileSync("deployment-mvp.json"));

async function deployToChain(chainName, rpcUrl, verifierAddr) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Deploying to ${chainName}`);
  console.log("=".repeat(60));

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error(`No balance on ${chainName}!`);
  }

  // Deploy AxyncEscrow
  const EscrowArtifact = JSON.parse(
    fs.readFileSync("./artifacts/contracts/AxyncEscrow.sol/AxyncEscrow.json")
  );

  console.log(`\nDeploying AxyncEscrow (fee: ${FEE_BPS / 100}%, timeout: 7 days)...`);
  const EscrowFactory = new ethers.ContractFactory(
    EscrowArtifact.abi,
    EscrowArtifact.bytecode,
    wallet
  );

  const escrowContract = await EscrowFactory.deploy(
    verifierAddr,
    FEE_BPS,
    wallet.address,      // fee recipient
    EMERGENCY_TIMEOUT,
    wallet.address       // owner
  );
  await escrowContract.waitForDeployment();
  const escrowAddr = await escrowContract.getAddress();
  console.log(`AxyncEscrow: ${escrowAddr}`);

  // Register escrow in AxyncVerifier
  const VerifierArtifact = JSON.parse(
    fs.readFileSync("./artifacts/contracts/AxyncVerifier.sol/AxyncVerifier.json")
  );
  const verifier = new ethers.Contract(verifierAddr, VerifierArtifact.abi, wallet);

  console.log("Setting escrow contract in AxyncVerifier...");
  const tx = await verifier.setEscrowContract(escrowAddr);
  await tx.wait();
  console.log("Done");

  // Deploy ERC721Mock (for testing)
  const MockArtifact = JSON.parse(
    fs.readFileSync("./artifacts/contracts/ERC721Mock.sol/ERC721Mock.json")
  );

  console.log("\nDeploying ERC721Mock...");
  const MockFactory = new ethers.ContractFactory(
    MockArtifact.abi,
    MockArtifact.bytecode,
    wallet
  );

  const mock = await MockFactory.deploy();
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();
  console.log(`ERC721Mock: ${mockAddr}`);

  // Mint 5 test NFTs
  console.log("Minting 5 test NFTs...");
  const mintTx = await mock.mintBatch(wallet.address, 5);
  await mintTx.wait();
  console.log(`Minted tokens 0-4 to ${wallet.address}`);

  return {
    chainName,
    escrow: escrowAddr,
    erc721Mock: mockAddr,
    verifier: verifierAddr,
  };
}

async function main() {
  console.log("Axync AxyncEscrow Deployment\n");

  console.log("Compiling contracts...");
  await hre.run("compile");
  console.log("Compiled\n");

  const sepolia = await deployToChain(
    "Ethereum Sepolia",
    SEPOLIA_RPC,
    MVP_DEPLOYMENT.sepolia.verifier
  );

  const baseSepolia = await deployToChain(
    "Base Sepolia",
    BASE_SEPOLIA_RPC,
    MVP_DEPLOYMENT.baseSepolia.verifier
  );

  // Save deployment
  const deployment = {
    timestamp: new Date().toISOString(),
    deployer: MVP_DEPLOYMENT.deployer,
    feeBps: FEE_BPS,
    emergencyTimeout: EMERGENCY_TIMEOUT,
    sepolia,
    baseSepolia,
  };

  fs.writeFileSync("deployment-marketplace.json", JSON.stringify(deployment, null, 2));

  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log(`\nEthereum Sepolia:`);
  console.log(`  AxyncEscrow: ${sepolia.escrow}`);
  console.log(`  ERC721Mock:  ${sepolia.erc721Mock}`);
  console.log(`  Verifier:    ${sepolia.verifier}`);
  console.log(`\nBase Sepolia:`);
  console.log(`  AxyncEscrow: ${baseSepolia.escrow}`);
  console.log(`  ERC721Mock:  ${baseSepolia.erc721Mock}`);
  console.log(`  Verifier:    ${baseSepolia.verifier}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
