/**
 * Full deployment: new AxyncVerifier + AxyncEscrow + ERC721Mock
 * Re-links Vault to new Verifier on both testnets
 *
 * Usage:
 *   npx hardhat run scripts/deploy-full-marketplace.js
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

const MVP_DEPLOYMENT = JSON.parse(fs.readFileSync("deployment-mvp.json"));

function loadArtifact(name) {
  return JSON.parse(
    fs.readFileSync(`./artifacts/contracts/${name}.sol/${name}.json`)
  );
}

async function deployToChain(chainName, rpcUrl, oldVaultAddr, chainKey) {
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

  const VerifierArtifact = loadArtifact("AxyncVerifier");
  const VaultArtifact = loadArtifact("AxyncVault");
  const EscrowArtifact = loadArtifact("AxyncEscrow");
  const MockArtifact = loadArtifact("ERC721Mock");

  // 1. Deploy new AxyncVerifier
  console.log("\n1. Deploying new AxyncVerifier...");
  const VerifierFactory = new ethers.ContractFactory(
    VerifierArtifact.abi,
    VerifierArtifact.bytecode,
    wallet
  );
  const verifier = await VerifierFactory.deploy(
    wallet.address,  // sequencer = deployer
    "0x" + "00".repeat(32), // initial state root = 0
    wallet.address,  // owner = deployer
    ethers.ZeroAddress // no groth16 verifier (placeholder mode)
  );
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log(`AxyncVerifier: ${verifierAddr}`);

  // 2. Link Vault to new Verifier
  console.log("\n2. Linking Vault to new Verifier...");
  const vault = new ethers.Contract(oldVaultAddr, VaultArtifact.abi, wallet);
  let tx = await vault.setVerifier(verifierAddr);
  await tx.wait();
  console.log("Vault.setVerifier done");

  // 3. Link Verifier to Vault
  tx = await verifier.setVaultContract(oldVaultAddr);
  await tx.wait();
  console.log("Verifier.setVaultContract done");

  // 4. Deploy AxyncEscrow
  console.log("\n3. Deploying AxyncEscrow...");
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

  // 5. Register escrow in Verifier
  console.log("Setting escrow contract in Verifier...");
  tx = await verifier.setEscrowContract(escrowAddr);
  await tx.wait();
  console.log("Verifier.setEscrowContract done");

  // 6. Deploy ERC721Mock
  console.log("\n4. Deploying ERC721Mock...");
  const MockFactory = new ethers.ContractFactory(
    MockArtifact.abi,
    MockArtifact.bytecode,
    wallet
  );
  const mock = await MockFactory.deploy();
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();
  console.log(`ERC721Mock: ${mockAddr}`);

  // 7. Mint test NFTs
  console.log("Minting 5 test NFTs...");
  const mintTx = await mock.mintBatch(wallet.address, 5);
  await mintTx.wait();
  console.log(`Minted tokens 0-4 to ${wallet.address}`);

  return {
    chainName,
    vault: oldVaultAddr,
    verifier: verifierAddr,
    escrow: escrowAddr,
    erc721Mock: mockAddr,
  };
}

async function main() {
  console.log("Axync Full Escrow Deployment\n");

  console.log("Compiling contracts...");
  await hre.run("compile");
  console.log("Compiled\n");

  const sepolia = await deployToChain(
    "Ethereum Sepolia",
    SEPOLIA_RPC,
    MVP_DEPLOYMENT.sepolia.vault,
    "sepolia"
  );

  const baseSepolia = await deployToChain(
    "Base Sepolia",
    BASE_SEPOLIA_RPC,
    MVP_DEPLOYMENT.baseSepolia.vault,
    "baseSepolia"
  );

  // Update deployment files
  const mvp = {
    ...MVP_DEPLOYMENT,
    timestamp: new Date().toISOString(),
    sepolia: {
      ...MVP_DEPLOYMENT.sepolia,
      verifier: sepolia.verifier,
    },
    baseSepolia: {
      ...MVP_DEPLOYMENT.baseSepolia,
      verifier: baseSepolia.verifier,
    },
  };
  fs.writeFileSync("deployment-mvp.json", JSON.stringify(mvp, null, 2));

  const marketplace = {
    timestamp: new Date().toISOString(),
    deployer: MVP_DEPLOYMENT.deployer,
    feeBps: FEE_BPS,
    emergencyTimeout: EMERGENCY_TIMEOUT,
    sepolia,
    baseSepolia,
  };
  fs.writeFileSync("deployment-marketplace.json", JSON.stringify(marketplace, null, 2));

  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log(`\nEthereum Sepolia:`);
  console.log(`  Vault:          ${sepolia.vault}`);
  console.log(`  Verifier (NEW): ${sepolia.verifier}`);
  console.log(`  AxyncEscrow:    ${sepolia.escrow}`);
  console.log(`  ERC721Mock:     ${sepolia.erc721Mock}`);
  console.log(`\nBase Sepolia:`);
  console.log(`  Vault:          ${baseSepolia.vault}`);
  console.log(`  Verifier (NEW): ${baseSepolia.verifier}`);
  console.log(`  AxyncEscrow:    ${baseSepolia.escrow}`);
  console.log(`  ERC721Mock:     ${baseSepolia.erc721Mock}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error.message || error);
    process.exit(1);
  });
