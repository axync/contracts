const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("WithdrawalContract", function () {
  async function deployFixture() {
    const [owner, user, sequencer] = await ethers.getSigners();

    const DepositContract = await ethers.getContractFactory("DepositContract");
    const depositContract = await DepositContract.deploy();
    await depositContract.waitForDeployment();

    // Deploy VerifierContract first (needed for WithdrawalContract)
    const VerifierContract = await ethers.getContractFactory("VerifierContract");
    const initialStateRoot = ethers.ZeroHash;
    const verifierContract = await VerifierContract.deploy(
      sequencer.address,
      initialStateRoot,
      owner.address,
      ethers.ZeroAddress // No Groth16Verifier for testing
    );
    await verifierContract.waitForDeployment();

    const WithdrawalContract = await ethers.getContractFactory("WithdrawalContract");
    const withdrawalContract = await WithdrawalContract.deploy(
      await verifierContract.getAddress(),
      owner.address
    );
    await withdrawalContract.waitForDeployment();

    return { depositContract, withdrawalContract, verifierContract, owner, user, sequencer };
  }

  let depositContract;
  let withdrawalContract;
  let verifierContract;
  let owner;
  let user;
  let sequencer;

  beforeEach(async function () {
    ({ depositContract, withdrawalContract, verifierContract, owner, user, sequencer } = await loadFixture(deployFixture));
  });

  describe("Withdrawal", function () {
    it("Should emit Withdrawal event", async function () {
      const withdrawalData = {
        user: user.address,
        assetId: 1,
        amount: ethers.parseEther("1.0"),
        chainId: 1,
      };
      const merkleProof = "0x" + "01".repeat(32); // Non-empty merkle proof
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifier"));
      const zkProof = "0x" + "01".repeat(256); // Non-empty ZK proof
      const withdrawalsRoot = ethers.keccak256(ethers.toUtf8Bytes("withdrawals"));

      // Set withdrawals root first
      await withdrawalContract.connect(owner).updateWithdrawalsRoot(withdrawalsRoot);

      const tx = await withdrawalContract.connect(user).withdraw(
        withdrawalData,
        merkleProof,
        nullifier,
        zkProof,
        withdrawalsRoot
      );

      await expect(tx)
        .to.emit(withdrawalContract, "Withdrawal")
        .withArgs(user.address, withdrawalData.assetId, withdrawalData.amount, nullifier, withdrawalsRoot);
    });

    it("Should reject zero amount", async function () {
      const withdrawalData = {
        user: user.address,
        assetId: 1,
        amount: 0,
        chainId: 1,
      };
      const merkleProof = "0x" + "01".repeat(32);
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifier"));
      const zkProof = "0x" + "01".repeat(256);
      const withdrawalsRoot = ethers.keccak256(ethers.toUtf8Bytes("withdrawals"));

      await withdrawalContract.connect(owner).updateWithdrawalsRoot(withdrawalsRoot);

      await expect(
        withdrawalContract.connect(user).withdraw(
          withdrawalData,
          merkleProof,
          nullifier,
          zkProof,
          withdrawalsRoot
        )
      ).to.be.revertedWithCustomError(withdrawalContract, "InvalidAmount");
    });

    it("Should reject invalid user", async function () {
      const withdrawalData = {
        user: owner.address, // Different user
        assetId: 1,
        amount: ethers.parseEther("1.0"),
        chainId: 1,
      };
      const merkleProof = "0x" + "01".repeat(32);
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifier"));
      const zkProof = "0x" + "01".repeat(256);
      const withdrawalsRoot = ethers.keccak256(ethers.toUtf8Bytes("withdrawals"));

      await withdrawalContract.connect(owner).updateWithdrawalsRoot(withdrawalsRoot);

      await expect(
        withdrawalContract.connect(user).withdraw(
          withdrawalData,
          merkleProof,
          nullifier,
          zkProof,
          withdrawalsRoot
        )
      ).to.be.revertedWithCustomError(withdrawalContract, "InvalidUser");
    });

    it("Should prevent duplicate withdrawals (nullifier)", async function () {
      const withdrawalData = {
        user: user.address,
        assetId: 1,
        amount: ethers.parseEther("1.0"),
        chainId: 1,
      };
      const merkleProof = "0x" + "01".repeat(32);
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifier"));
      const zkProof = "0x" + "01".repeat(256);
      const withdrawalsRoot = ethers.keccak256(ethers.toUtf8Bytes("withdrawals"));

      await withdrawalContract.connect(owner).updateWithdrawalsRoot(withdrawalsRoot);

      // First withdrawal
      await withdrawalContract.connect(user).withdraw(
        withdrawalData,
        merkleProof,
        nullifier,
        zkProof,
        withdrawalsRoot
      );

      // Second withdrawal with same nullifier should fail
      await expect(
        withdrawalContract.connect(user).withdraw(
          withdrawalData,
          merkleProof,
          nullifier, // Same nullifier
          zkProof,
          withdrawalsRoot
        )
      ).to.be.revertedWithCustomError(withdrawalContract, "NullifierAlreadyUsed");
    });

    it("Should reject empty proof", async function () {
      const withdrawalData = {
        user: user.address,
        assetId: 1,
        amount: ethers.parseEther("1.0"),
        chainId: 1,
      };
      const merkleProof = "0x" + "01".repeat(32);
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifier"));
      const zkProof = "0x"; // Empty ZK proof
      const withdrawalsRoot = ethers.keccak256(ethers.toUtf8Bytes("withdrawals"));

      await withdrawalContract.connect(owner).updateWithdrawalsRoot(withdrawalsRoot);

      await expect(
        withdrawalContract.connect(user).withdraw(
          withdrawalData,
          merkleProof,
          nullifier,
          zkProof,
          withdrawalsRoot
        )
      ).to.be.revertedWithCustomError(withdrawalContract, "InvalidProof");
    });
  });

  describe("Verifier Management", function () {
    it("Should allow owner to update withdrawals root", async function () {
      const newWithdrawalsRoot = ethers.keccak256(ethers.toUtf8Bytes("new"));

      await withdrawalContract.connect(owner).updateWithdrawalsRoot(newWithdrawalsRoot);

      expect(await withdrawalContract.withdrawalsRoot()).to.equal(newWithdrawalsRoot);
    });

    it("Should reject non-owner from updating withdrawals root", async function () {
      const newWithdrawalsRoot = ethers.keccak256(ethers.toUtf8Bytes("new"));

      await expect(
        withdrawalContract.connect(user).updateWithdrawalsRoot(newWithdrawalsRoot)
      ).to.be.revertedWithCustomError(withdrawalContract, "OwnableUnauthorizedAccount");
    });
  });

  describe("Constructor", function () {
    it("Should reject zero address for verifier in constructor", async function () {
      const WithdrawalContract = await ethers.getContractFactory("WithdrawalContract");
      await expect(
        WithdrawalContract.deploy(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(WithdrawalContract, "InvalidVerifierAddress");
    });
  });
});

