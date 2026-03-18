const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("EscrowSwap", function () {
  const FEE_BPS = 100; // 1%

  async function deployFixture() {
    const [owner, seller, buyer, other] = await ethers.getSigners();

    // Deploy EscrowSwap
    const EscrowSwap = await ethers.getContractFactory("EscrowSwap");
    const escrow = await EscrowSwap.deploy(FEE_BPS, owner.address, owner.address);
    await escrow.waitForDeployment();

    // Deploy mock NFT (simulates Sablier/Hedgey vesting NFT)
    const ERC721Mock = await ethers.getContractFactory("ERC721Mock");
    const nft = await ERC721Mock.deploy("Vesting NFT", "VNFT");
    await nft.waitForDeployment();

    // Deploy mock ERC20 (simulates USDC payment)
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const usdc = await ERC20Mock.deploy("USD Coin", "USDC", buyer.address, ethers.parseEther("100000"));
    await usdc.waitForDeployment();

    // Mint NFT to seller
    await nft.mint(seller.address); // tokenId 0
    await nft.mint(seller.address); // tokenId 1
    await nft.mint(seller.address); // tokenId 2

    const escrowAddr = await escrow.getAddress();
    const nftAddr = await nft.getAddress();
    const usdcAddr = await usdc.getAddress();

    // Approve escrow for NFTs
    await nft.connect(seller).setApprovalForAll(escrowAddr, true);

    // Approve escrow for USDC payments
    await usdc.connect(buyer).approve(escrowAddr, ethers.MaxUint256);

    return { escrow, nft, usdc, owner, seller, buyer, other, escrowAddr, nftAddr, usdcAddr };
  }

  let escrow, nft, usdc, owner, seller, buyer, other, escrowAddr, nftAddr, usdcAddr;

  beforeEach(async function () {
    ({ escrow, nft, usdc, owner, seller, buyer, other, escrowAddr, nftAddr, usdcAddr } =
      await loadFixture(deployFixture));
  });

  // ── Deployment ──

  describe("Deployment", function () {
    it("should set fee, feeRecipient, and owner", async function () {
      expect(await escrow.feeBps()).to.equal(FEE_BPS);
      expect(await escrow.feeRecipient()).to.equal(owner.address);
      expect(await escrow.owner()).to.equal(owner.address);
    });

    it("should reject fee > 10%", async function () {
      const EscrowSwap = await ethers.getContractFactory("EscrowSwap");
      await expect(
        EscrowSwap.deploy(1001, owner.address, owner.address)
      ).to.be.revertedWithCustomError(EscrowSwap, "FeeTooHigh");
    });
  });

  // ── Listing ──

  describe("Listing", function () {
    it("should list NFT for ETH", async function () {
      const price = ethers.parseEther("1");
      const tx = await escrow.connect(seller).list(nftAddr, 0, ethers.ZeroAddress, price);
      const receipt = await tx.wait();

      // NFT transferred to escrow
      expect(await nft.ownerOf(0)).to.equal(escrowAddr);

      // Listing stored correctly
      const listing = await escrow.getListing(0);
      expect(listing.seller).to.equal(seller.address);
      expect(listing.nftContract).to.equal(nftAddr);
      expect(listing.tokenId).to.equal(0);
      expect(listing.paymentToken).to.equal(ethers.ZeroAddress);
      expect(listing.price).to.equal(price);
      expect(listing.active).to.equal(true);
    });

    it("should list NFT for ERC-20", async function () {
      const price = ethers.parseEther("5000");
      await escrow.connect(seller).list(nftAddr, 0, usdcAddr, price);

      const listing = await escrow.getListing(0);
      expect(listing.paymentToken).to.equal(usdcAddr);
      expect(listing.price).to.equal(price);
    });

    it("should increment listing IDs", async function () {
      const price = ethers.parseEther("1");
      await escrow.connect(seller).list(nftAddr, 0, ethers.ZeroAddress, price);
      await escrow.connect(seller).list(nftAddr, 1, ethers.ZeroAddress, price);

      expect((await escrow.getListing(0)).tokenId).to.equal(0);
      expect((await escrow.getListing(1)).tokenId).to.equal(1);
      expect(await escrow.nextListingId()).to.equal(2);
    });

    it("should emit Listed event", async function () {
      const price = ethers.parseEther("1");
      await expect(escrow.connect(seller).list(nftAddr, 0, ethers.ZeroAddress, price))
        .to.emit(escrow, "Listed")
        .withArgs(0, seller.address, nftAddr, 0, ethers.ZeroAddress, price);
    });

    it("should reject price = 0", async function () {
      await expect(
        escrow.connect(seller).list(nftAddr, 0, ethers.ZeroAddress, 0)
      ).to.be.revertedWithCustomError(escrow, "InvalidPrice");
    });

    it("should reject zero NFT address", async function () {
      await expect(
        escrow.connect(seller).list(ethers.ZeroAddress, 0, ethers.ZeroAddress, 1)
      ).to.be.revertedWithCustomError(escrow, "InvalidNFT");
    });
  });

  // ── Buying with ETH ──

  describe("Buy with ETH", function () {
    const price = ethers.parseEther("1");

    beforeEach(async function () {
      await escrow.connect(seller).list(nftAddr, 0, ethers.ZeroAddress, price);
    });

    it("should transfer NFT to buyer and ETH to seller", async function () {
      const sellerBefore = await ethers.provider.getBalance(seller.address);

      await escrow.connect(buyer).buy(0, { value: price });

      // NFT goes to buyer
      expect(await nft.ownerOf(0)).to.equal(buyer.address);

      // Seller gets price minus fee
      const fee = price / 100n; // 1%
      const sellerAfter = await ethers.provider.getBalance(seller.address);
      expect(sellerAfter - sellerBefore).to.equal(price - fee);
    });

    it("should pay fee to feeRecipient", async function () {
      const ownerBefore = await ethers.provider.getBalance(owner.address);
      await escrow.connect(buyer).buy(0, { value: price });
      const ownerAfter = await ethers.provider.getBalance(owner.address);

      const fee = price / 100n;
      expect(ownerAfter - ownerBefore).to.equal(fee);
    });

    it("should refund excess ETH", async function () {
      const excess = ethers.parseEther("0.5");
      const buyerBefore = await ethers.provider.getBalance(buyer.address);

      const tx = await escrow.connect(buyer).buy(0, { value: price + excess });
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      // Buyer spent: price + gas (excess was refunded)
      expect(buyerBefore - buyerAfter - gasCost).to.equal(price);
    });

    it("should emit Bought event", async function () {
      const fee = price / 100n;
      await expect(escrow.connect(buyer).buy(0, { value: price }))
        .to.emit(escrow, "Bought")
        .withArgs(0, buyer.address, seller.address, price, fee);
    });

    it("should reject insufficient payment", async function () {
      await expect(
        escrow.connect(buyer).buy(0, { value: ethers.parseEther("0.5") })
      ).to.be.revertedWithCustomError(escrow, "InsufficientPayment");
    });

    it("should reject buying inactive listing", async function () {
      await escrow.connect(buyer).buy(0, { value: price });
      await expect(
        escrow.connect(other).buy(0, { value: price })
      ).to.be.revertedWithCustomError(escrow, "ListingNotActive");
    });
  });

  // ── Buying with ERC-20 ──

  describe("Buy with ERC-20", function () {
    const price = ethers.parseEther("5000");

    beforeEach(async function () {
      await escrow.connect(seller).list(nftAddr, 0, usdcAddr, price);
    });

    it("should transfer NFT to buyer and USDC to seller", async function () {
      const sellerBefore = await usdc.balanceOf(seller.address);
      await escrow.connect(buyer).buy(0);

      expect(await nft.ownerOf(0)).to.equal(buyer.address);

      const fee = price / 100n;
      const sellerAfter = await usdc.balanceOf(seller.address);
      expect(sellerAfter - sellerBefore).to.equal(price - fee);
    });

    it("should pay USDC fee to feeRecipient", async function () {
      const ownerBefore = await usdc.balanceOf(owner.address);
      await escrow.connect(buyer).buy(0);
      const ownerAfter = await usdc.balanceOf(owner.address);

      const fee = price / 100n;
      expect(ownerAfter - ownerBefore).to.equal(fee);
    });
  });

  // ── Cancel ──

  describe("Cancel", function () {
    beforeEach(async function () {
      await escrow.connect(seller).list(nftAddr, 0, ethers.ZeroAddress, ethers.parseEther("1"));
    });

    it("should return NFT to seller", async function () {
      await escrow.connect(seller).cancel(0);
      expect(await nft.ownerOf(0)).to.equal(seller.address);
      expect(await escrow.isActive(0)).to.equal(false);
    });

    it("should emit Canceled event", async function () {
      await expect(escrow.connect(seller).cancel(0)).to.emit(escrow, "Canceled").withArgs(0);
    });

    it("should reject cancel by non-seller", async function () {
      await expect(escrow.connect(buyer).cancel(0)).to.be.revertedWithCustomError(
        escrow,
        "NotSeller"
      );
    });

    it("should reject cancel of inactive listing", async function () {
      await escrow.connect(seller).cancel(0);
      await expect(escrow.connect(seller).cancel(0)).to.be.revertedWithCustomError(
        escrow,
        "ListingNotActive"
      );
    });
  });

  // ── Admin ──

  describe("Admin", function () {
    it("should update fee", async function () {
      await expect(escrow.connect(owner).setFee(200))
        .to.emit(escrow, "FeeUpdated")
        .withArgs(100, 200);
      expect(await escrow.feeBps()).to.equal(200);
    });

    it("should reject fee > 10%", async function () {
      await expect(escrow.connect(owner).setFee(1001)).to.be.revertedWithCustomError(
        escrow,
        "FeeTooHigh"
      );
    });

    it("should reject non-owner fee update", async function () {
      await expect(escrow.connect(seller).setFee(200)).to.be.reverted;
    });

    it("should update feeRecipient", async function () {
      await escrow.connect(owner).setFeeRecipient(other.address);
      expect(await escrow.feeRecipient()).to.equal(other.address);
    });

    it("should reject zero feeRecipient", async function () {
      await expect(escrow.connect(owner).setFeeRecipient(ethers.ZeroAddress)).to.be.reverted;
    });
  });

  // ── Zero fee ──

  describe("Zero fee", function () {
    it("should work with 0% fee", async function () {
      await escrow.connect(owner).setFee(0);

      const price = ethers.parseEther("1");
      await escrow.connect(seller).list(nftAddr, 0, ethers.ZeroAddress, price);

      const sellerBefore = await ethers.provider.getBalance(seller.address);
      await escrow.connect(buyer).buy(0, { value: price });
      const sellerAfter = await ethers.provider.getBalance(seller.address);

      expect(sellerAfter - sellerBefore).to.equal(price);
      expect(await nft.ownerOf(0)).to.equal(buyer.address);
    });
  });
});
