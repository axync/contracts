// Script to set verifying key in Groth16Verifier contract
// Usage: npx hardhat run scripts/set-verifying-key.js --network <network>

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Setting verifying key with account:", deployer.address);

  // Read verifying key from file
  const keyPath = path.join(__dirname, "verifying_key.txt");
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Verifying key file not found: ${keyPath}`);
  }

  const keyContent = fs.readFileSync(keyPath, "utf-8");
  
  // Parse verifying key
  const alphaX = extractValue(keyContent, "alpha_X:");
  const alphaY = extractValue(keyContent, "alpha_Y:");
  
  const betaX = extractArray(keyContent, "beta_X:");
  const betaY = extractArray(keyContent, "beta_Y:");
  
  const gammaX = extractArray(keyContent, "gamma_X:");
  const gammaY = extractArray(keyContent, "gamma_Y:");
  
  const deltaX = extractArray(keyContent, "delta_X:");
  const deltaY = extractArray(keyContent, "delta_Y:");
  
  const gammaAbc = extractGammaAbc(keyContent);

  // Get Groth16Verifier contract address from environment or deployment
  const verifierAddress = process.env.GROTH16_VERIFIER_ADDRESS;
  if (!verifierAddress) {
    throw new Error("GROTH16_VERIFIER_ADDRESS environment variable is required");
  }

  const Groth16Verifier = await hre.ethers.getContractFactory("Groth16Verifier");
  const verifier = Groth16Verifier.attach(verifierAddress);

  console.log("Setting verifying key...");
  const tx = await verifier.setVerifyingKey(
    { X: alphaX, Y: alphaY },
    { X: betaX, Y: betaY },
    { X: gammaX, Y: gammaY },
    { X: deltaX, Y: deltaY },
    gammaAbc
  );

  console.log("Transaction hash:", tx.hash);
  await tx.wait();
  console.log("Verifying key set successfully!");
}

function extractValue(content, key) {
  const regex = new RegExp(`${key}\\s+(0x[0-9a-fA-F]+)`);
  const match = content.match(regex);
  if (!match) {
    throw new Error(`Failed to extract ${key}`);
  }
  return match[1];
}

function extractArray(content, key) {
  const regex = new RegExp(`${key}\\s+\\[(0x[0-9a-fA-F]+),\\s+(0x[0-9a-fA-F]+)\\]`);
  const match = content.match(regex);
  if (!match) {
    throw new Error(`Failed to extract ${key}`);
  }
  return [match[1], match[2]];
}

function extractGammaAbc(content) {
  const gammaAbc = [];
  const regex = /gamma_abc\[(\d+)\]:\s+\((0x[0-9a-fA-F]+),\s+(0x[0-9a-fA-F]+)\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const index = parseInt(match[1]);
    const x = match[2];
    const y = match[3];
    gammaAbc[index] = { X: x, Y: y };
  }
  
  // Filter out undefined entries
  // In Groth16, gamma_abc should have at least 25 elements (1 constant + 24 public inputs)
  // But Arkworks may generate more (27), so we accept all
  const filtered = gammaAbc.filter(p => p !== undefined);
  if (filtered.length < 25) {
    throw new Error(`Invalid gamma_abc length: expected at least 25, got ${filtered.length}`);
  }
  console.log(`Found ${filtered.length} gamma_abc elements (expected at least 25)`);
  return filtered;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

