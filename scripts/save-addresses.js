const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployContracts } = require("./deploy-helpers");

async function main() {
  const deployment = await deployContracts();
  const network = await hre.ethers.provider.getNetwork();

  const addresses = {
    chainId: deployment.chainId,
    network: network.name,
    deployer: deployment.deployer,
    contracts: {
      deposit: deployment.depositAddress,
      verifier: deployment.verifierAddress,
      withdrawal: deployment.withdrawalAddress,
    },
    timestamp: new Date().toISOString(),
  };

  const filename = `deployments-${deployment.chainId}.json`;
  const filepath = path.join(__dirname, "..", filename);

  fs.writeFileSync(filepath, JSON.stringify(addresses, null, 2));
  console.log(`\nAddresses saved to ${filename}`);
  console.log(JSON.stringify(addresses, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
