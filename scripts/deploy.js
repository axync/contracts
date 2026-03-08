const { deployContracts, verifyContracts } = require("./deploy-helpers");

async function main() {
  const deployment = await deployContracts();

  console.log("\n=== Deployment Summary ===");
  console.log("Chain ID:", deployment.chainId);
  console.log("DepositContract:", deployment.depositAddress);
  console.log("VerifierContract:", deployment.verifierAddress);
  console.log("WithdrawalContract:", deployment.withdrawalAddress);
  console.log("Deployer:", deployment.deployer);

  await verifyContracts(deployment);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
