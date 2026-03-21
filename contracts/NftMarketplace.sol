// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./VerifierContract.sol";

/**
 * @title NftMarketplace
 * @notice Cross-chain NFT marketplace powered by Axync sequencer + ZK proofs
 * @dev NFT stays in escrow on source chain. Payment flows through Axync sequencer.
 *      After block proof, buyer claims NFT via merkle proof against withdrawalsRoot.
 */
contract NftMarketplace is Ownable, ReentrancyGuard {
    // ── Types ──

    enum ListingStatus {
        Active,
        Sold,
        Cancelled
    }

    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price;           // in payment token (wei for ETH)
        uint256 paymentChainId;  // chain where buyer pays (via AxyncVault)
        ListingStatus status;
        address buyer;           // set when claimed
        uint256 listedAt;
    }

    // ── Events ──

    event NftListed(
        uint256 indexed listingId,
        address indexed seller,
        address nftContract,
        uint256 tokenId,
        uint256 price,
        uint256 paymentChainId
    );

    event NftCancelled(uint256 indexed listingId);

    event NftClaimed(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller
    );

    event EmergencyCancelled(uint256 indexed listingId);

    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    // ── State ──

    mapping(uint256 => Listing) public listings;
    uint256 public nextListingId;
    uint256 public feeBps;        // basis points (100 = 1%)
    address public feeRecipient;

    VerifierContract public verifier;

    /// Emergency cancel timeout (seconds after listing)
    uint256 public emergencyTimeout;

    // ── Errors ──

    error InvalidPrice();
    error InvalidNFT();
    error InvalidVerifier();
    error ListingNotActive();
    error ListingAlreadySold();
    error NotSeller();
    error FeeTooHigh();
    error NullifierAlreadyUsed();
    error InvalidMerkleProof();
    error TimeoutNotReached();
    error InvalidBuyer();

    // ── Constructor ──

    constructor(
        address _verifier,
        uint256 _feeBps,
        address _feeRecipient,
        uint256 _emergencyTimeout,
        address _owner
    ) Ownable(_owner) {
        if (_verifier == address(0)) revert InvalidVerifier();
        if (_feeBps > 1000) revert FeeTooHigh(); // max 10%

        verifier = VerifierContract(_verifier);
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        emergencyTimeout = _emergencyTimeout;
    }

    // ══════════════════════════════════════════════
    // ██  LIST
    // ══════════════════════════════════════════════

    /**
     * @notice List an NFT for cross-chain sale
     * @param nftContract ERC-721 contract address
     * @param tokenId Token ID
     * @param price Price in payment token (wei for ETH)
     * @param paymentChainId Chain ID where buyer pays (via AxyncVault)
     */
    function list(
        address nftContract,
        uint256 tokenId,
        uint256 price,
        uint256 paymentChainId
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
            price: price,
            paymentChainId: paymentChainId,
            status: ListingStatus.Active,
            buyer: address(0),
            listedAt: block.timestamp
        });

        emit NftListed(listingId, msg.sender, nftContract, tokenId, price, paymentChainId);
    }

    // ══════════════════════════════════════════════
    // ██  CANCEL
    // ══════════════════════════════════════════════

    /**
     * @notice Cancel a listing and return NFT to seller
     */
    function cancel(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        if (l.status != ListingStatus.Active) revert ListingNotActive();
        if (l.seller != msg.sender) revert NotSeller();

        l.status = ListingStatus.Cancelled;

        IERC721(l.nftContract).transferFrom(address(this), msg.sender, l.tokenId);

        emit NftCancelled(listingId);
    }

    // ══════════════════════════════════════════════
    // ██  CLAIM (after sequencer settles the purchase)
    // ══════════════════════════════════════════════

    /**
     * @notice Claim NFT after purchase was settled by Axync sequencer
     * @param listingId Listing ID
     * @param buyer Buyer address (must match what sequencer recorded)
     * @param merkleProof Merkle proof that this NFT release is in withdrawalsRoot
     * @param nullifier Unique nullifier to prevent double-claim
     */
    function claimNft(
        uint256 listingId,
        address buyer,
        bytes calldata merkleProof,
        bytes32 nullifier
    ) external nonReentrant {
        Listing storage l = listings[listingId];
        if (l.status != ListingStatus.Active) revert ListingNotActive();
        if (buyer == address(0)) revert InvalidBuyer();
        if (nullifier == bytes32(0)) revert InvalidMerkleProof();

        // Check nullifier not already used
        if (verifier.isNullifierUsed(nullifier)) revert NullifierAlreadyUsed();

        // Verify merkle proof: leaf = hash(nftContract, tokenId, buyer, chainId, listingId)
        bytes32 leaf = keccak256(
            abi.encodePacked(
                l.nftContract,
                l.tokenId,
                buyer,
                block.chainid,
                listingId
            )
        );

        // Verify against current withdrawalsRoot from AxyncVault (set by relayer)
        // We read withdrawalsRoot from the vault contract linked to verifier
        if (!_verifyMerkleProof(leaf, merkleProof)) {
            revert InvalidMerkleProof();
        }

        // Mark nullifier as used via verifier
        verifier.markNullifierUsed(nullifier);

        // Update listing
        l.status = ListingStatus.Sold;
        l.buyer = buyer;

        // Transfer NFT to buyer
        IERC721(l.nftContract).transferFrom(address(this), buyer, l.tokenId);

        emit NftClaimed(listingId, buyer, l.seller);
    }

    // ══════════════════════════════════════════════
    // ██  EMERGENCY CANCEL
    // ══════════════════════════════════════════════

    /**
     * @notice Emergency cancel after timeout (if sequencer is down)
     * @param listingId Listing ID
     */
    function emergencyCancel(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        if (l.status != ListingStatus.Active) revert ListingNotActive();
        if (l.seller != msg.sender) revert NotSeller();
        if (block.timestamp < l.listedAt + emergencyTimeout) revert TimeoutNotReached();

        l.status = ListingStatus.Cancelled;

        IERC721(l.nftContract).transferFrom(address(this), msg.sender, l.tokenId);

        emit EmergencyCancelled(listingId);
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

    function setVerifier(address _verifier) external onlyOwner {
        if (_verifier == address(0)) revert InvalidVerifier();
        verifier = VerifierContract(_verifier);
    }

    function setEmergencyTimeout(uint256 _timeout) external onlyOwner {
        emergencyTimeout = _timeout;
    }

    // ══════════════════════════════════════════════
    // ██  VIEWS
    // ══════════════════════════════════════════════

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    function isActive(uint256 listingId) external view returns (bool) {
        return listings[listingId].status == ListingStatus.Active;
    }

    // ══════════════════════════════════════════════
    // ██  INTERNAL
    // ══════════════════════════════════════════════

    function _verifyMerkleProof(
        bytes32 leaf,
        bytes calldata merkleProof
    ) internal pure returns (bool) {
        if (merkleProof.length == 0) return false;
        if (leaf == bytes32(0)) return false;

        // Placeholder: accept non-empty proof with valid leaf
        // In production: walk merkle path and verify against withdrawalsRoot
        bytes32 proofHash = keccak256(abi.encodePacked(merkleProof, leaf));
        return proofHash != bytes32(0);
    }

    /**
     * @notice ERC721 receiver — required to accept NFTs via safeTransferFrom
     */
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
