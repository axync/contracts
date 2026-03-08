const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

describe("Groth16Verifier", function () {
  let groth16Verifier;
  let deployer;

  // Helper functions to parse verifying key
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
    return gammaAbc.filter((p) => p !== undefined);
  }

  beforeEach(async function () {
    [deployer] = await ethers.getSigners();

    const Groth16Verifier = await ethers.getContractFactory("Groth16Verifier");
    groth16Verifier = await Groth16Verifier.deploy();
    await groth16Verifier.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should deploy successfully", async function () {
      expect(await groth16Verifier.getAddress()).to.be.properAddress;
    });

    it("Should have empty verifying key initially", async function () {
      // Check that verifying key is not set by trying to verify (should revert)
      const invalidProof = {
        a: { X: "0x0", Y: "0x0" },
        b: { X: ["0x0", "0x0"], Y: ["0x0", "0x0"] },
        c: { X: "0x0", Y: "0x0" },
      };
      const publicInputs = Array(24).fill("0x0");

      await expect(
        groth16Verifier.verifyProof(invalidProof, publicInputs)
      ).to.be.revertedWithCustomError(groth16Verifier, "InvalidVerifyingKey");
    });
  });

  describe("setVerifyingKey", function () {
    it("Should set verifying key successfully", async function () {
      // Read verifying key from file
      const keyPath = path.join(__dirname, "../scripts/verifying_key.txt");
      if (!fs.existsSync(keyPath)) {
        this.skip(); // Skip if key file doesn't exist
      }

      const keyContent = fs.readFileSync(keyPath, "utf-8");

      const alphaX = extractValue(keyContent, "alpha_X:");
      const alphaY = extractValue(keyContent, "alpha_Y:");

      const betaX = extractArray(keyContent, "beta_X:");
      const betaY = extractArray(keyContent, "beta_Y:");

      const gammaX = extractArray(keyContent, "gamma_X:");
      const gammaY = extractArray(keyContent, "gamma_Y:");

      const deltaX = extractArray(keyContent, "delta_X:");
      const deltaY = extractArray(keyContent, "delta_Y:");

      const gammaAbc = extractGammaAbc(keyContent);

      // Set verifying key
      const tx = await groth16Verifier.setVerifyingKey(
        { X: alphaX, Y: alphaY },
        { X: betaX, Y: betaY },
        { X: gammaX, Y: gammaY },
        { X: deltaX, Y: deltaY },
        gammaAbc
      );

      await tx.wait();

      // Verify key was set by checking that verifyProof doesn't revert with InvalidVerifyingKey
      // (it will revert with InvalidProof for invalid proof, but not InvalidVerifyingKey)
      const invalidProof = {
        a: { X: "0x0", Y: "0x0" },
        b: { X: ["0x0", "0x0"], Y: ["0x0", "0x0"] },
        c: { X: "0x0", Y: "0x0" },
      };
      const publicInputs = Array(24).fill("0x0");

      // Should not revert with InvalidVerifyingKey (key is set)
      // Will revert with InvalidProof or return false, but not InvalidVerifyingKey
      await expect(
        groth16Verifier.verifyProof(invalidProof, publicInputs)
      ).to.not.be.revertedWithCustomError(groth16Verifier, "InvalidVerifyingKey");
    });

    it("Should revert if gamma_abc has less than 25 elements", async function () {
      const invalidGammaAbc = Array(24).fill({ X: "0x0", Y: "0x0" });

      await expect(
        groth16Verifier.setVerifyingKey(
          { X: "0x0", Y: "0x0" },
          { X: ["0x0", "0x0"], Y: ["0x0", "0x0"] },
          { X: ["0x0", "0x0"], Y: ["0x0", "0x0"] },
          { X: ["0x0", "0x0"], Y: ["0x0", "0x0"] },
          invalidGammaAbc
        )
      ).to.be.revertedWithCustomError(groth16Verifier, "InvalidVerifyingKey");
    });

    it("Should emit VerifyingKeySet event", async function () {
      const keyPath = path.join(__dirname, "../scripts/verifying_key.txt");
      if (!fs.existsSync(keyPath)) {
        this.skip();
      }

      const keyContent = fs.readFileSync(keyPath, "utf-8");
      const alphaX = extractValue(keyContent, "alpha_X:");
      const alphaY = extractValue(keyContent, "alpha_Y:");
      const betaX = extractArray(keyContent, "beta_X:");
      const betaY = extractArray(keyContent, "beta_Y:");
      const gammaX = extractArray(keyContent, "gamma_X:");
      const gammaY = extractArray(keyContent, "gamma_Y:");
      const deltaX = extractArray(keyContent, "delta_X:");
      const deltaY = extractArray(keyContent, "delta_Y:");
      const gammaAbc = extractGammaAbc(keyContent);

      await expect(
        groth16Verifier.setVerifyingKey(
          { X: alphaX, Y: alphaY },
          { X: betaX, Y: betaY },
          { X: gammaX, Y: gammaY },
          { X: deltaX, Y: deltaY },
          gammaAbc
        )
      ).to.emit(groth16Verifier, "VerifyingKeySet");
    });
  });

  describe("verifyProof", function () {
    beforeEach(async function () {
      // Set verifying key before verification tests
      const keyPath = path.join(__dirname, "../scripts/verifying_key.txt");
      if (!fs.existsSync(keyPath)) {
        this.skip();
      }

      const keyContent = fs.readFileSync(keyPath, "utf-8");
      const alphaX = extractValue(keyContent, "alpha_X:");
      const alphaY = extractValue(keyContent, "alpha_Y:");
      const betaX = extractArray(keyContent, "beta_X:");
      const betaY = extractArray(keyContent, "beta_Y:");
      const gammaX = extractArray(keyContent, "gamma_X:");
      const gammaY = extractArray(keyContent, "gamma_Y:");
      const deltaX = extractArray(keyContent, "delta_X:");
      const deltaY = extractArray(keyContent, "delta_Y:");
      const gammaAbc = extractGammaAbc(keyContent);

      await groth16Verifier.setVerifyingKey(
        { X: alphaX, Y: alphaY },
        { X: betaX, Y: betaY },
        { X: gammaX, Y: gammaY },
        { X: deltaX, Y: deltaY },
        gammaAbc
      );
    });

    it("Should revert if public inputs length is not 24", async function () {
      const invalidProof = {
        a: { X: "0x0", Y: "0x0" },
        b: { X: ["0x0", "0x0"], Y: ["0x0", "0x0"] },
        c: { X: "0x0", Y: "0x0" },
      };

      await expect(
        groth16Verifier.verifyProof(invalidProof, [])
      ).to.be.revertedWithCustomError(groth16Verifier, "InvalidPublicInputs");
    });

    it("Should revert if verifying key is not set", async function () {
      // Deploy new verifier without setting key
      const Groth16Verifier = await ethers.getContractFactory("Groth16Verifier");
      const newVerifier = await Groth16Verifier.deploy();
      await newVerifier.waitForDeployment();

      const invalidProof = {
        a: { X: "0x0", Y: "0x0" },
        b: { X: ["0x0", "0x0"], Y: ["0x0", "0x0"] },
        c: { X: "0x0", Y: "0x0" },
      };
      const publicInputs = Array(24).fill("0x0");

      await expect(
        newVerifier.verifyProof(invalidProof, publicInputs)
      ).to.be.revertedWithCustomError(newVerifier, "InvalidVerifyingKey");
    });

    // Note: Testing with actual valid proofs requires generating real Groth16 proofs
    // This would require integration with the Rust prover service
    // For now, we test the contract structure and error handling
  });
});

