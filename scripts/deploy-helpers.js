// Shared deployment logic for all scripts

const hre = require("hardhat");

/**
 * Deploy all Axync contracts to the current network
 * @returns {Promise<Object>} Deployment addresses and metadata
 */
async function deployContracts() {
  const chainId = await hre.ethers.provider.getNetwork().then((n) => Number(n.chainId));
  const signers = await hre.ethers.getSigners();

  if (!signers || signers.length === 0) {
    throw new Error(
      "No signers found! Please set PRIVATE_KEY in .env file.\n" +
      "Example: PRIVATE_KEY=0x1234567890abcdef..."
    );
  }

  const [deployer] = signers;

  if (!deployer) {
    throw new Error(
      "Deployer account not found! Please set PRIVATE_KEY in .env file.\n" +
      "Example: PRIVATE_KEY=0x1234567890abcdef..."
    );
  }

  console.log(`Deploying to chain ID: ${chainId}`);
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  // Deploy Groth16Verifier (can be set later with verifying key)
  const Groth16Verifier = await hre.ethers.getContractFactory("Groth16Verifier");
  const groth16Verifier = await Groth16Verifier.deploy();
  await groth16Verifier.waitForDeployment();
  const groth16VerifierAddress = await groth16Verifier.getAddress();
  console.log("Groth16Verifier deployed to:", groth16VerifierAddress);

  // Deploy AxyncVerifier
  const AxyncVerifier = await hre.ethers.getContractFactory("AxyncVerifier");
  const initialStateRoot = hre.ethers.ZeroHash; // Will be updated after first block
  const verifierContract = await AxyncVerifier.deploy(
    deployer.address, // sequencer
    initialStateRoot,
    deployer.address, // owner
    groth16VerifierAddress // groth16Verifier
  );
  await verifierContract.waitForDeployment();
  const verifierAddress = await verifierContract.getAddress();
  console.log("AxyncVerifier deployed to:", verifierAddress);

  // Deploy AxyncVault (unified deposit + withdrawal)
  const AxyncVault = await hre.ethers.getContractFactory("AxyncVault");
  const vault = await AxyncVault.deploy(verifierAddress, deployer.address);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("AxyncVault deployed to:", vaultAddress);

  // Set AxyncVault address on AxyncVerifier for access control
  const setVaultTx = await verifierContract.setVaultContract(vaultAddress);
  await setVaultTx.wait();
  console.log("AxyncVerifier: AxyncVault address set to:", vaultAddress);

  return {
    chainId,
    deployer: deployer.address,
    vaultAddress,
    groth16VerifierAddress,
    verifierAddress,
    contracts: {
      vault,
      groth16Verifier: groth16Verifier,
      verifier: verifierContract,
    },
  };
}

/**
 * Verify contracts on block explorer (Ethereum only)
 * @param {Object} deployment - Deployment result from deployContracts()
 */
async function verifyContracts(deployment) {
  const verifiableChains = [1]; // Only Ethereum for now
  if (!verifiableChains.includes(deployment.chainId)) {
    return;
  }

  console.log("\nWaiting for block confirmations...");
  const { contracts } = deployment;

  if (contracts.vault.deploymentTransaction()) {
    await contracts.vault.deploymentTransaction().wait(5);
  }
  if (contracts.verifier.deploymentTransaction()) {
    await contracts.verifier.deploymentTransaction().wait(5);
  }

  console.log("\nVerifying contracts on block explorer...");

  const initialStateRoot = hre.ethers.ZeroHash;

  try {
    await hre.run("verify:verify", {
      address: deployment.groth16VerifierAddress,
      constructorArguments: [],
    });
  } catch (error) {
    console.log("Error verifying Groth16Verifier:", error.message);
  }

  try {
    await hre.run("verify:verify", {
      address: deployment.verifierAddress,
      constructorArguments: [deployment.deployer, initialStateRoot, deployment.deployer, deployment.groth16VerifierAddress],
    });
  } catch (error) {
    console.log("Error verifying AxyncVerifier:", error.message);
  }

  try {
    await hre.run("verify:verify", {
      address: deployment.vaultAddress,
      constructorArguments: [deployment.verifierAddress, deployment.deployer],
    });
  } catch (error) {
    console.log("Error verifying AxyncVault:", error.message);
  }
}

module.exports = {
  deployContracts,
  verifyContracts,
};
