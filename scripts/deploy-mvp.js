/**
 * Deploy all Axync contracts fresh for MVP
 * Deploys to BOTH Sepolia and Base Sepolia
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
  const VerifierArtifact = JSON.parse(fs.readFileSync("./artifacts/contracts/AxyncVerifier.sol/AxyncVerifier.json"));
  const VaultArtifact = JSON.parse(fs.readFileSync("./artifacts/contracts/AxyncVault.sol/AxyncVault.json"));

  // 1. Deploy AxyncVerifier (NO groth16 verifier - use placeholder)
  console.log("\n1. Deploying AxyncVerifier (placeholder mode)...");
  const VerifierFactory = new ethers.ContractFactory(VerifierArtifact.abi, VerifierArtifact.bytecode, wallet);
  const verifier = await VerifierFactory.deploy(
    wallet.address,                    // sequencer = deployer
    ethers.ZeroHash,                   // initial state root = 0
    wallet.address,                    // owner = deployer
    ethers.ZeroAddress                 // NO groth16 verifier → placeholder mode
  );
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log(`   AxyncVerifier: ${verifierAddr}`);

  // 2. Deploy AxyncVault (unified deposit + withdrawal)
  console.log("2. Deploying AxyncVault...");
  const VaultFactory = new ethers.ContractFactory(VaultArtifact.abi, VaultArtifact.bytecode, wallet);
  const vault = await VaultFactory.deploy(verifierAddr, wallet.address);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log(`   AxyncVault: ${vaultAddr}`);

  // 3. Link AxyncVault in AxyncVerifier
  console.log("3. Linking AxyncVault to AxyncVerifier...");
  const setVaultTx = await verifier.setVaultContract(vaultAddr);
  await setVaultTx.wait();
  console.log("   Linked");

  return {
    chainName,
    chainId,
    deployer: wallet.address,
    vault: vaultAddr,
    verifier: verifierAddr,
  };
}

async function main() {
  console.log("Axync MVP - Full Deployment\n");

  // Compile contracts first
  console.log("Compiling contracts...");
  await hre.run("compile");
  console.log("Compiled\n");

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
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log(`\nDeployer: ${sepolia.deployer}`);
  console.log(`\nEthereum Sepolia:`);
  console.log(`  Vault:    ${sepolia.vault}`);
  console.log(`  Verifier: ${sepolia.verifier}`);
  console.log(`\nBase Sepolia:`);
  console.log(`  Vault:    ${baseSepolia.vault}`);
  console.log(`  Verifier: ${baseSepolia.verifier}`);

  // Generate .env updates
  console.log("\nUpdate your ui/.env with:");
  console.log(`NEXT_PUBLIC_ETHEREUM_VAULT_CONTRACT=${sepolia.vault}`);
  console.log(`NEXT_PUBLIC_BASE_VAULT_CONTRACT=${baseSepolia.vault}`);
  console.log(`NEXT_PUBLIC_ETHEREUM_VERIFIER_CONTRACT=${sepolia.verifier}`);
  console.log(`NEXT_PUBLIC_BASE_VERIFIER_CONTRACT=${baseSepolia.verifier}`);

  // Auto-update UI .env
  const uiEnvPath = "../ui/.env";
  if (fs.existsSync(uiEnvPath)) {
    let envContent = fs.readFileSync(uiEnvPath, "utf8");

    const updates = {
      NEXT_PUBLIC_ETHEREUM_VAULT_CONTRACT: sepolia.vault,
      NEXT_PUBLIC_BASE_VAULT_CONTRACT: baseSepolia.vault,
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

    // Remove old separate deposit/withdrawal vars
    envContent = envContent.replace(/^NEXT_PUBLIC_ETHEREUM_DEPOSIT_CONTRACT=.*\n?/m, "");
    envContent = envContent.replace(/^NEXT_PUBLIC_BASE_DEPOSIT_CONTRACT=.*\n?/m, "");
    envContent = envContent.replace(/^NEXT_PUBLIC_ETHEREUM_WITHDRAWAL_CONTRACT=.*\n?/m, "");
    envContent = envContent.replace(/^NEXT_PUBLIC_BASE_WITHDRAWAL_CONTRACT=.*\n?/m, "");

    fs.writeFileSync(uiEnvPath, envContent);
    console.log("\nAuto-updated ui/.env");
  }

  // Auto-update UI config.ts defaults
  const configPath = "../ui/src/constants/config.ts";
  if (fs.existsSync(configPath)) {
    let configContent = fs.readFileSync(configPath, "utf8");

    // Update vault contract defaults
    configContent = configContent.replace(
      /vaultContract: process\.env\.NEXT_PUBLIC_ETHEREUM_VAULT_CONTRACT \|\| '[^']+'/,
      `vaultContract: process.env.NEXT_PUBLIC_ETHEREUM_VAULT_CONTRACT || '${sepolia.vault}'`
    );
    configContent = configContent.replace(
      /vaultContract: process\.env\.NEXT_PUBLIC_BASE_VAULT_CONTRACT \|\| '[^']+'/,
      `vaultContract: process.env.NEXT_PUBLIC_BASE_VAULT_CONTRACT || '${baseSepolia.vault}'`
    );

    fs.writeFileSync(configPath, configContent);
    console.log("Auto-updated ui/src/constants/config.ts");
  }

  console.log("\nDeployment complete! Now:");
  console.log("1. Clear backend data: rm -rf core/data/");
  console.log("2. Restart backend: cd core && cargo run --release -p axync-api");
  console.log("3. Start relayer: cd relayer && node relayer.js");
  console.log("4. Start UI: cd ui && npm run dev");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
