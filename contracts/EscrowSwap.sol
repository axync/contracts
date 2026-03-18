// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title EscrowSwap
 * @notice Trustless marketplace for trading vesting/locked token NFTs (Sablier, Hedgey, etc.)
 * @dev Atomic swap: seller lists NFT in escrow, buyer pays, NFT transfers to buyer
 */
contract EscrowSwap is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Types ──

    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        address paymentToken; // address(0) = ETH
        uint256 price;
        bool active;
    }

    // ── Events ──

    event Listed(uint256 indexed listingId, address indexed seller, address nftContract, uint256 tokenId, address paymentToken, uint256 price);
    event Bought(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price, uint256 fee);
    event Canceled(uint256 indexed listingId);
    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    // ── State ──

    mapping(uint256 => Listing) public listings;
    uint256 public nextListingId;
    uint256 public feeBps; // basis points, e.g. 100 = 1%
    address public feeRecipient;

    // ── Errors ──

    error InvalidPrice();
    error InvalidNFT();
    error ListingNotActive();
    error NotSeller();
    error InsufficientPayment();
    error FeeTooHigh();
    error TransferFailed();

    // ── Constructor ──

    constructor(uint256 _feeBps, address _feeRecipient, address _owner) Ownable(_owner) {
        if (_feeBps > 1000) revert FeeTooHigh(); // max 10%
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
    }

    // ══════════════════════════════════════════════
    // ██  LISTING
    // ══════════════════════════════════════════════

    function list(
        address nftContract,
        uint256 tokenId,
        address paymentToken,
        uint256 price
    ) external nonReentrant returns (uint256 listingId) {
        if (price == 0) revert InvalidPrice();
        if (nftContract == address(0)) revert InvalidNFT();

        // Transfer NFT to escrow
        IERC721(nftContract).transferFrom(msg.sender, address(this), tokenId);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            paymentToken: paymentToken,
            price: price,
            active: true
        });

        emit Listed(listingId, msg.sender, nftContract, tokenId, paymentToken, price);
    }

    // ══════════════════════════════════════════════
    // ██  BUYING
    // ══════════════════════════════════════════════

    function buy(uint256 listingId) external payable nonReentrant {
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive();

        l.active = false;

        uint256 fee = (l.price * feeBps) / 10000;
        uint256 sellerAmount = l.price - fee;

        if (l.paymentToken == address(0)) {
            // ETH payment
            if (msg.value < l.price) revert InsufficientPayment();

            // Pay seller
            (bool ok, ) = payable(l.seller).call{value: sellerAmount}("");
            if (!ok) revert TransferFailed();

            // Pay fee
            if (fee > 0) {
                (bool feeOk, ) = payable(feeRecipient).call{value: fee}("");
                if (!feeOk) revert TransferFailed();
            }

            // Refund excess
            uint256 excess = msg.value - l.price;
            if (excess > 0) {
                (bool refundOk, ) = payable(msg.sender).call{value: excess}("");
                if (!refundOk) revert TransferFailed();
            }
        } else {
            // ERC-20 payment
            IERC20 token = IERC20(l.paymentToken);
            token.safeTransferFrom(msg.sender, l.seller, sellerAmount);
            if (fee > 0) {
                token.safeTransferFrom(msg.sender, feeRecipient, fee);
            }
        }

        // Transfer NFT to buyer
        IERC721(l.nftContract).transferFrom(address(this), msg.sender, l.tokenId);

        emit Bought(listingId, msg.sender, l.seller, l.price, fee);
    }

    // ══════════════════════════════════════════════
    // ██  CANCEL
    // ══════════════════════════════════════════════

    function cancel(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive();
        if (l.seller != msg.sender) revert NotSeller();

        l.active = false;

        // Return NFT to seller
        IERC721(l.nftContract).transferFrom(address(this), msg.sender, l.tokenId);

        emit Canceled(listingId);
    }

    // ══════════════════════════════════════════════
    // ██  ADMIN
    // ══════════════════════════════════════════════

    function setFee(uint256 _feeBps) external onlyOwner {
        if (_feeBps > 1000) revert FeeTooHigh();
        uint256 old = feeBps;
        feeBps = _feeBps;
        emit FeeUpdated(old, _feeBps);
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "Invalid address");
        feeRecipient = _feeRecipient;
    }

    // ══════════════════════════════════════════════
    // ██  VIEWS
    // ══════════════════════════════════════════════

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    function isActive(uint256 listingId) external view returns (bool) {
        return listings[listingId].active;
    }
}
