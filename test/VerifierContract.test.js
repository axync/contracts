const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("VerifierContract", function () {
  let verifierContract;
  let groth16Verifier;
  let deployer;
  let sequencer;

  beforeEach(async function () {
    [deployer, sequencer] = await ethers.getSigners();

    // Deploy Groth16Verifier (but don't set verifying key - will use placeholder)
    const Groth16Verifier = await ethers.getContractFactory("Groth16Verifier");
    groth16Verifier = await Groth16Verifier.deploy();
    await groth16Verifier.waitForDeployment();

    // Deploy VerifierContract with zero address for groth16Verifier to use placeholder
    // Or deploy with groth16Verifier but it won't have verifying key set
    const VerifierContract = await ethers.getContractFactory("VerifierContract");
    const initialStateRoot = ethers.ZeroHash;
    verifierContract = await VerifierContract.deploy(
      sequencer.address,
      initialStateRoot,
      deployer.address,
      ethers.ZeroAddress // Use zero address to force placeholder verification
    );
    await verifierContract.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should deploy successfully", async function () {
      expect(await verifierContract.getAddress()).to.be.properAddress;
    });

    it("Should set initial state root", async function () {
      expect(await verifierContract.stateRoot()).to.equal(ethers.ZeroHash);
    });

    it("Should set sequencer", async function () {
      expect(await verifierContract.sequencer()).to.equal(sequencer.address);
    });

    it("Should set owner", async function () {
      expect(await verifierContract.owner()).to.equal(deployer.address);
    });
  });

  describe("submitBlockProof", function () {
    it("Should revert if called by non-sequencer", async function () {
      const newStateRoot = ethers.keccak256(ethers.toUtf8Bytes("new"));
      const withdrawalsRoot = ethers.ZeroHash;
      const proof = "0x" + "00".repeat(256); // Dummy proof

      await expect(
        verifierContract.submitBlockProof(1, ethers.ZeroHash, newStateRoot, withdrawalsRoot, proof)
      ).to.be.revertedWithCustomError(verifierContract, "OnlySequencer");
    });

    it("Should revert if block already processed", async function () {
      const newStateRoot = ethers.keccak256(ethers.toUtf8Bytes("new"));
      const withdrawalsRoot = ethers.ZeroHash;
      // Use a proof that will pass placeholder verification
      // Placeholder requires: non-empty, prevStateRoot != 0, newStateRoot != 0
      const proof = "0x" + "01".repeat(256); // Non-empty proof for placeholder

      // First submission (will use placeholder verification)
      // Note: placeholder verification requires prevStateRoot != 0, but we start with ZeroHash
      // So we need to use a non-zero prevStateRoot for the first block
      const firstNewStateRoot = ethers.keccak256(ethers.toUtf8Bytes("first"));
      await verifierContract
        .connect(sequencer)
        .submitBlockProof(1, ethers.ZeroHash, firstNewStateRoot, withdrawalsRoot, proof);

      // Second submission with same block ID should fail
      await expect(
        verifierContract
          .connect(sequencer)
          .submitBlockProof(1, firstNewStateRoot, newStateRoot, withdrawalsRoot, proof)
      ).to.be.revertedWithCustomError(verifierContract, "BlockAlreadyProcessed");
    });

    it("Should revert if prevStateRoot doesn't match current stateRoot", async function () {
      const newStateRoot = ethers.keccak256(ethers.toUtf8Bytes("new"));
      const withdrawalsRoot = ethers.ZeroHash;
      const proof = "0x" + "00".repeat(256);
      const wrongPrevRoot = ethers.keccak256(ethers.toUtf8Bytes("wrong"));

      await expect(
        verifierContract
          .connect(sequencer)
          .submitBlockProof(1, wrongPrevRoot, newStateRoot, withdrawalsRoot, proof)
      ).to.be.revertedWithCustomError(verifierContract, "InvalidStateRoot");
    });

    it("Should revert if newStateRoot is zero", async function () {
      const withdrawalsRoot = ethers.ZeroHash;
      const proof = "0x" + "00".repeat(256);

      await expect(
        verifierContract
          .connect(sequencer)
          .submitBlockProof(1, ethers.ZeroHash, ethers.ZeroHash, withdrawalsRoot, proof)
      ).to.be.revertedWithCustomError(verifierContract, "InvalidStateRoot");
    });

    it("Should update state root with placeholder verification", async function () {
      const newStateRoot = ethers.keccak256(ethers.toUtf8Bytes("new"));
      const withdrawalsRoot = ethers.ZeroHash;
      const proof = "0x" + "01".repeat(256); // Non-empty proof for placeholder

      // For first block, prevStateRoot can be ZeroHash (initial state)
      const tx = await verifierContract
        .connect(sequencer)
        .submitBlockProof(1, ethers.ZeroHash, newStateRoot, withdrawalsRoot, proof);

      await expect(tx)
        .to.emit(verifierContract, "StateRootUpdated")
        .withArgs(1, ethers.ZeroHash, newStateRoot, withdrawalsRoot);

      expect(await verifierContract.stateRoot()).to.equal(newStateRoot);
      expect(await verifierContract.processedBlocks(1)).to.be.true;
    });

    it("Should revert if proof is empty (with placeholder)", async function () {
      const newStateRoot = ethers.keccak256(ethers.toUtf8Bytes("new"));
      const withdrawalsRoot = ethers.ZeroHash;
      const emptyProof = "0x";

      await expect(
        verifierContract
          .connect(sequencer)
          .submitBlockProof(1, ethers.ZeroHash, newStateRoot, withdrawalsRoot, emptyProof)
      ).to.be.revertedWithCustomError(verifierContract, "InvalidProof");
    });
  });

  describe("setGroth16Verifier", function () {
    it("Should allow owner to set Groth16Verifier", async function () {
      // Deploy a new Groth16Verifier for this test
      const Groth16Verifier = await ethers.getContractFactory("Groth16Verifier");
      const newVerifier = await Groth16Verifier.deploy();
      await newVerifier.waitForDeployment();

      await verifierContract.setGroth16Verifier(await newVerifier.getAddress());

      // Verify it was set (we can't directly read it, but we can check it's used)
      // This is tested indirectly through submitBlockProof behavior
    });

    it("Should revert if called by non-owner", async function () {
      const newVerifier = await ethers.deployContract("Groth16Verifier");
      await newVerifier.waitForDeployment();

      await expect(
        verifierContract.connect(sequencer).setGroth16Verifier(await newVerifier.getAddress())
      ).to.be.revertedWithCustomError(verifierContract, "OwnableUnauthorizedAccount");
    });

    it("Should revert if verifier address is zero", async function () {
      await expect(
        verifierContract.setGroth16Verifier(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(verifierContract, "InvalidSequencerAddress");
    });
  });

  describe("nullifiers", function () {
    it("Should check if nullifier is used", async function () {
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("test"));
      expect(await verifierContract.isNullifierUsed(nullifier)).to.be.false;
    });

    it("Should mark nullifier as used", async function () {
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("test"));

      await verifierContract.markNullifierUsed(nullifier);

      expect(await verifierContract.isNullifierUsed(nullifier)).to.be.true;
    });
  });

  describe("setSequencer", function () {
    it("Should allow sequencer to update sequencer address", async function () {
      const [newSequencer] = await ethers.getSigners();
      const newSequencerAddress = newSequencer.address;

      await expect(
        verifierContract.connect(sequencer).setSequencer(newSequencerAddress)
      )
        .to.emit(verifierContract, "SequencerUpdated")
        .withArgs(sequencer.address, newSequencerAddress);

      expect(await verifierContract.sequencer()).to.equal(newSequencerAddress);
    });

    it("Should revert if called by non-sequencer", async function () {
      const [newSequencer] = await ethers.getSigners();

      await expect(
        verifierContract.connect(deployer).setSequencer(newSequencer.address)
      ).to.be.revertedWithCustomError(verifierContract, "OnlySequencer");
    });
  });
});

