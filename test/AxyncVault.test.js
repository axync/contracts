const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// Helper: build merkle tree and generate proof
function buildMerkleTree(leaves) {
  if (leaves.length === 0) return { root: ethers.ZeroHash, proofs: [] };

  // Pad to power of 2
  let paddedLeaves = [...leaves];
  while (paddedLeaves.length & (paddedLeaves.length - 1)) {
    paddedLeaves.push(ethers.ZeroHash);
  }
  if (paddedLeaves.length === 1) {
    paddedLeaves.push(ethers.ZeroHash);
  }

  const layers = [paddedLeaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i];
      const right = prev[i + 1];
      const [a, b] = left <= right ? [left, right] : [right, left];
      next.push(ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [a, b])));
    }
    layers.push(next);
  }

  const root = layers[layers.length - 1][0];

  // Generate proofs for each original leaf
  const proofs = leaves.map((_, leafIndex) => {
    const siblings = [];
    let idx = leafIndex;
    for (let l = 0; l < layers.length - 1; l++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      siblings.push(layers[l][siblingIdx]);
      idx = Math.floor(idx / 2);
    }
    return "0x" + siblings.map(s => s.slice(2)).join("");
  });

  return { root, proofs };
}

describe("AxyncVault", function () {
  async function deployFixture() {
    const [owner, user, sequencer] = await ethers.getSigners();

    const AxyncVerifier = await ethers.getContractFactory("AxyncVerifier");
    const verifierContract = await AxyncVerifier.deploy(
      sequencer.address,
      ethers.ZeroHash,
      owner.address,
      ethers.ZeroAddress
    );
    await verifierContract.waitForDeployment();

    const AxyncVault = await ethers.getContractFactory("AxyncVault");
    const vault = await AxyncVault.deploy(
      await verifierContract.getAddress(),
      owner.address
    );
    await vault.waitForDeployment();

    await verifierContract.connect(owner).setVaultContract(await vault.getAddress());

    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const mockToken = await ERC20Mock.deploy(
      "Test Token",
      "TEST",
      owner.address,
      ethers.parseEther("1000000")
    );
    await mockToken.waitForDeployment();

    await vault.connect(owner).registerAsset(1, await mockToken.getAddress());
    await mockToken.transfer(user.address, ethers.parseEther("1000"));
    await mockToken.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);

    return { vault, verifierContract, mockToken, owner, user, sequencer };
  }

  let vault, verifierContract, mockToken, owner, user, sequencer;

  beforeEach(async function () {
    ({ vault, verifierContract, mockToken, owner, user, sequencer } = await loadFixture(deployFixture));
  });

  // Helper to create a valid withdrawal with merkle proof
  async function setupWithdrawal(withdrawalData) {
    const leaf = ethers.keccak256(
      ethers.solidityPacked(
        ["address", "uint256", "uint256", "uint256"],
        [withdrawalData.user, withdrawalData.assetId, withdrawalData.amount, withdrawalData.chainId]
      )
    );
    const { root, proofs } = buildMerkleTree([leaf]);
    await vault.connect(owner).updateWithdrawalsRoot(root);
    return { merkleProof: proofs[0], withdrawalsRoot: root };
  }

  // ══════════════════════════════════════════════
  // ██  DEPOSITS
  // ══════════════════════════════════════════════

  describe("ERC20 Deposits", function () {
    it("Should emit Deposit event", async function () {
      const tx = await vault.connect(user).deposit(1, ethers.parseEther("1.0"));
      const receipt = await tx.wait();
      const depositEvent = receipt.logs.find(
        log => vault.interface.parseLog(log)?.name === "Deposit"
      );
      expect(depositEvent).to.not.be.undefined;
      const parsed = vault.interface.parseLog(depositEvent);
      expect(parsed.args.user).to.equal(user.address);
      expect(parsed.args.assetId).to.equal(1);
      expect(parsed.args.amount).to.equal(ethers.parseEther("1.0"));
    });

    it("Should transfer tokens to vault", async function () {
      const vaultAddress = await vault.getAddress();
      const amount = ethers.parseEther("1.0");
      const balanceBefore = await mockToken.balanceOf(vaultAddress);
      await vault.connect(user).deposit(1, amount);
      const balanceAfter = await mockToken.balanceOf(vaultAddress);
      expect(balanceAfter - balanceBefore).to.equal(amount);
    });

    it("Should reject zero amount", async function () {
      await expect(
        vault.connect(user).deposit(1, 0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("Should reject unregistered asset", async function () {
      await expect(
        vault.connect(user).deposit(999, ethers.parseEther("1.0"))
      ).to.be.revertedWith("Asset not registered");
    });

    it("Should handle multiple deposits", async function () {
      const amount1 = ethers.parseEther("1.0");
      const amount2 = ethers.parseEther("2.0");
      await vault.connect(user).deposit(1, amount1);
      await vault.connect(user).deposit(1, amount2);
      const balance = await mockToken.balanceOf(await vault.getAddress());
      expect(balance).to.equal(amount1 + amount2);
    });
  });

  describe("Native ETH Deposits", function () {
    it("Should handle native ETH deposits", async function () {
      const amount = ethers.parseEther("1.0");
      const tx = await vault.connect(user).depositNative(0, { value: amount });
      const receipt = await tx.wait();
      const depositEvent = receipt.logs.find(
        log => vault.interface.parseLog(log)?.name === "Deposit"
      );
      expect(depositEvent).to.not.be.undefined;
      const parsed = vault.interface.parseLog(depositEvent);
      expect(parsed.args.user).to.equal(user.address);
      expect(parsed.args.amount).to.equal(amount);
    });

    it("Should reject native ETH deposit when asset is registered", async function () {
      await expect(
        vault.connect(user).depositNative(1, { value: ethers.parseEther("1.0") })
      ).to.be.revertedWith("Use ERC20 deposit for this asset");
    });

    it("Should reject zero native ETH amount", async function () {
      await expect(
        vault.connect(user).depositNative(0, { value: 0 })
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("Should reject direct ETH transfers", async function () {
      await expect(
        user.sendTransaction({
          to: await vault.getAddress(),
          value: ethers.parseEther("1.0"),
        })
      ).to.be.revertedWith("Use depositNative function");
    });
  });

  // ══════════════════════════════════════════════
  // ██  WITHDRAWALS
  // ══════════════════════════════════════════════

  describe("Withdrawals", function () {
    const zkProof = "0x" + "01".repeat(256);

    it("Should emit Withdrawal event", async function () {
      const withdrawalData = { user: user.address, assetId: 1, amount: ethers.parseEther("1.0"), chainId: 1 };
      const { merkleProof, withdrawalsRoot } = await setupWithdrawal(withdrawalData);
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifier"));

      await vault.connect(user).depositNative(0, { value: ethers.parseEther("2.0") });

      const tx = await vault.connect(user).withdraw(
        withdrawalData, merkleProof, nullifier, zkProof, withdrawalsRoot
      );
      await expect(tx)
        .to.emit(vault, "Withdrawal")
        .withArgs(user.address, 1, withdrawalData.amount, nullifier, withdrawalsRoot);
    });

    it("Should transfer ETH to user on withdrawal", async function () {
      const withdrawAmount = ethers.parseEther("1.0");
      const withdrawalData = { user: user.address, assetId: 1, amount: withdrawAmount, chainId: 1 };
      const { merkleProof, withdrawalsRoot } = await setupWithdrawal(withdrawalData);
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifier2"));

      await vault.connect(owner).depositNative(0, { value: ethers.parseEther("2.0") });

      const balanceBefore = await ethers.provider.getBalance(user.address);
      const tx = await vault.connect(user).withdraw(
        withdrawalData, merkleProof, nullifier, zkProof, withdrawalsRoot
      );
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(user.address);
      expect(balanceAfter - balanceBefore + gasUsed).to.equal(withdrawAmount);
    });

    it("Deposits fund withdrawals (unified vault)", async function () {
      const depositAmount = ethers.parseEther("5.0");
      await vault.connect(user).depositNative(0, { value: depositAmount });

      const vaultBalance = await ethers.provider.getBalance(await vault.getAddress());
      expect(vaultBalance).to.equal(depositAmount);

      const withdrawAmount = ethers.parseEther("1.0");
      const withdrawalData = { user: user.address, assetId: 1, amount: withdrawAmount, chainId: 1 };
      const { merkleProof, withdrawalsRoot } = await setupWithdrawal(withdrawalData);
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifier-unified"));

      await vault.connect(user).withdraw(
        withdrawalData, merkleProof, nullifier, zkProof, withdrawalsRoot
      );

      const vaultBalanceAfter = await ethers.provider.getBalance(await vault.getAddress());
      expect(vaultBalanceAfter).to.equal(depositAmount - withdrawAmount);
    });

    it("Should reject zero amount", async function () {
      const withdrawalData = { user: user.address, assetId: 1, amount: 0, chainId: 1 };
      await expect(
        vault.connect(user).withdraw(withdrawalData, "0x" + "00".repeat(32), ethers.keccak256(ethers.toUtf8Bytes("n")), zkProof, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    });

    it("Should reject invalid user", async function () {
      const withdrawalData = { user: owner.address, assetId: 1, amount: ethers.parseEther("1.0"), chainId: 1 };
      const { merkleProof, withdrawalsRoot } = await setupWithdrawal(withdrawalData);
      await expect(
        vault.connect(user).withdraw(withdrawalData, merkleProof, ethers.keccak256(ethers.toUtf8Bytes("n")), zkProof, withdrawalsRoot)
      ).to.be.revertedWithCustomError(vault, "InvalidUser");
    });

    it("Should prevent duplicate withdrawals (nullifier)", async function () {
      await vault.connect(owner).depositNative(0, { value: ethers.parseEther("5.0") });

      const withdrawalData = { user: user.address, assetId: 1, amount: ethers.parseEther("1.0"), chainId: 1 };
      const { merkleProof, withdrawalsRoot } = await setupWithdrawal(withdrawalData);
      const nullifier = ethers.keccak256(ethers.toUtf8Bytes("nullifier"));

      await vault.connect(user).withdraw(withdrawalData, merkleProof, nullifier, zkProof, withdrawalsRoot);

      await expect(
        vault.connect(user).withdraw(withdrawalData, merkleProof, nullifier, zkProof, withdrawalsRoot)
      ).to.be.revertedWithCustomError(vault, "NullifierAlreadyUsed");
    });

    it("Should reject empty proof", async function () {
      const withdrawalData = { user: user.address, assetId: 1, amount: ethers.parseEther("1.0"), chainId: 1 };
      const { merkleProof, withdrawalsRoot } = await setupWithdrawal(withdrawalData);
      await expect(
        vault.connect(user).withdraw(withdrawalData, merkleProof, ethers.keccak256(ethers.toUtf8Bytes("n")), "0x", withdrawalsRoot)
      ).to.be.revertedWithCustomError(vault, "InvalidProof");
    });
  });

  // ══════════════════════════════════════════════
  // ██  MANAGEMENT
  // ══════════════════════════════════════════════

  describe("Withdrawals Root Management", function () {
    it("Should allow owner to update withdrawals root", async function () {
      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("new"));
      await vault.connect(owner).updateWithdrawalsRoot(newRoot);
      expect(await vault.withdrawalsRoot()).to.equal(newRoot);
    });

    it("Should reject non-owner from updating withdrawals root", async function () {
      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("new"));
      await expect(
        vault.connect(user).updateWithdrawalsRoot(newRoot)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });

  describe("Asset Registration", function () {
    it("Should allow owner to register assets", async function () {
      const tokenAddress = await mockToken.getAddress();
      await vault.connect(owner).registerAsset(2, tokenAddress);
      expect(await vault.assetAddresses(2)).to.equal(tokenAddress);
    });

    it("Should reject non-owner from registering assets", async function () {
      await expect(
        vault.connect(user).registerAsset(2, await mockToken.getAddress())
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });

  describe("Constructor", function () {
    it("Should reject zero address for verifier", async function () {
      const AxyncVault = await ethers.getContractFactory("AxyncVault");
      await expect(
        AxyncVault.deploy(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(AxyncVault, "InvalidVerifierAddress");
    });
  });
});
