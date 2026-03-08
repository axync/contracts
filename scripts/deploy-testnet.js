// Deploy contracts to testnet (hardhat local network)
// Usage: npx hardhat run scripts/deploy-testnet.js --network hardhat

const { deployContracts } = require("./deploy-helpers");

async function main() {
  console.log("=== Deploying ZKClear Contracts to Testnet ===\n");

  const deployment = await deployContracts();

  console.log("\n=== Deployment Summary ===");
  console.log("Chain ID:", deployment.chainId);
  console.log("Deployer:", deployment.deployer);
  console.log("\nContract Addresses:");
  console.log("  DepositContract:", deployment.depositAddress);
  console.log("  Groth16Verifier:", deployment.groth16VerifierAddress);
  console.log("  VerifierContract:", deployment.verifierAddress);
  console.log("  WithdrawalContract:", deployment.withdrawalAddress);

  console.log("\n=== Next Steps ===");
  console.log("1. Set verifying key in Groth16Verifier:");
  console.log(`   GROTH16_VERIFIER_ADDRESS=${deployment.groth16VerifierAddress} npx hardhat run scripts/set-verifying-key.js --network hardhat`);
  console.log("\n2. Run tests:");
  console.log("   npx hardhat test");

  // Save addresses to file for easy access
  const fs = require("fs");
  const addresses = {
    chainId: deployment.chainId,
    deployer: deployment.deployer,
    deposit: deployment.depositAddress,
    groth16Verifier: deployment.groth16VerifierAddress,
    verifier: deployment.verifierAddress,
    withdrawal: deployment.withdrawalAddress,
  };
  fs.writeFileSync(
    "deployment-addresses.json",
    JSON.stringify(addresses, null, 2)
  );
  console.log("\n✅ Addresses saved to deployment-addresses.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

