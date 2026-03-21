// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./AxyncVerifier.sol";

/**
 * @title AxyncEscrow
 * @notice Cross-chain escrow for ERC-721 and ERC-20 assets powered by Axync sequencer + ZK proofs
 * @dev Assets stay in escrow on source chain. Payment flows through Axync sequencer.
 *      After block proof, buyer claims via merkle proof against withdrawalsRoot.
 */
contract AxyncEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Types ──

    enum AssetType {
        ERC721,
        ERC20
    }

    enum ListingStatus {
        Active,
        Sold,
        Cancelled
    }

    struct Listing {
        address seller;
        AssetType assetType;
        address tokenContract;   // ERC-721 or ERC-20 contract
        uint256 tokenId;         // ERC-721 only (0 for ERC-20)
        uint256 amount;          // ERC-20 only (0 for ERC-721)
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

    event TokenListed(
        uint256 indexed listingId,
        address indexed seller,
        address tokenContract,
        uint256 amount,
        uint256 price,
        uint256 paymentChainId
    );

    event ListingCancelled(uint256 indexed listingId);

    event ListingClaimed(
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

    AxyncVerifier public verifier;

    /// Withdrawals root (set by relayer after block proof submission)
    bytes32 public withdrawalsRoot;

    /// Emergency cancel timeout (seconds after listing)
    uint256 public emergencyTimeout;

    // ── Errors ──

    error InvalidPrice();
    error InvalidNFT();
    error InvalidToken();
    error InvalidAmount();
    error InvalidVerifier();
    error ListingNotActive();
    error ListingAlreadySold();
    error NotSeller();
    error FeeTooHigh();
    error NullifierAlreadyUsed();
    error InvalidMerkleProof();
    error TimeoutNotReached();
    error InvalidBuyer();
    error InvalidWithdrawalsRoot();

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

        verifier = AxyncVerifier(_verifier);
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        emergencyTimeout = _emergencyTimeout;
    }

    // ══════════════════════════════════════════════
    // ██  LIST
    // ══════════════════════════════════════════════

    /**
     * @notice List an ERC-721 NFT for cross-chain sale
     */
    function list(
        address nftContract,
        uint256 tokenId,
        uint256 price,
        uint256 paymentChainId
    ) external nonReentrant returns (uint256 listingId) {
        if (price == 0) revert InvalidPrice();
        if (nftContract == address(0)) revert InvalidNFT();

        IERC721(nftContract).transferFrom(msg.sender, address(this), tokenId);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            assetType: AssetType.ERC721,
            tokenContract: nftContract,
            tokenId: tokenId,
            amount: 0,
            price: price,
            paymentChainId: paymentChainId,
            status: ListingStatus.Active,
            buyer: address(0),
            listedAt: block.timestamp
        });

        emit NftListed(listingId, msg.sender, nftContract, tokenId, price, paymentChainId);
    }

    /**
     * @notice List ERC-20 tokens for cross-chain sale
     */
    function listToken(
        address tokenContract,
        uint256 amount,
        uint256 price,
        uint256 paymentChainId
    ) external nonReentrant returns (uint256 listingId) {
        if (price == 0) revert InvalidPrice();
        if (tokenContract == address(0)) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();

        IERC20(tokenContract).safeTransferFrom(msg.sender, address(this), amount);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            assetType: AssetType.ERC20,
            tokenContract: tokenContract,
            tokenId: 0,
            amount: amount,
            price: price,
            paymentChainId: paymentChainId,
            status: ListingStatus.Active,
            buyer: address(0),
            listedAt: block.timestamp
        });

        emit TokenListed(listingId, msg.sender, tokenContract, amount, price, paymentChainId);
    }

    // ══════════════════════════════════════════════
    // ██  CANCEL
    // ══════════════════════════════════════════════

    /**
     * @notice Cancel a listing and return asset to seller
     */
    function cancel(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        if (l.status != ListingStatus.Active) revert ListingNotActive();
        if (l.seller != msg.sender) revert NotSeller();

        l.status = ListingStatus.Cancelled;
        _returnAsset(l, msg.sender);

        emit ListingCancelled(listingId);
    }

    // ══════════════════════════════════════════════
    // ██  CLAIM (after sequencer settles the purchase)
    // ══════════════════════════════════════════════

    /**
     * @notice Claim asset after purchase was settled by Axync sequencer
     * @param listingId Listing ID
     * @param buyer Buyer address (must match what sequencer recorded)
     * @param merkleProof Merkle proof path (32-byte sibling hashes concatenated)
     * @param nullifier Unique nullifier to prevent double-claim
     */
    function claim(
        uint256 listingId,
        address buyer,
        bytes calldata merkleProof,
        bytes32 nullifier
    ) external nonReentrant {
        Listing storage l = listings[listingId];
        if (l.status != ListingStatus.Active) revert ListingNotActive();
        if (buyer == address(0)) revert InvalidBuyer();
        if (nullifier == bytes32(0)) revert InvalidMerkleProof();

        if (verifier.isNullifierUsed(nullifier)) revert NullifierAlreadyUsed();

        // Leaf depends on asset type
        bytes32 leaf;
        if (l.assetType == AssetType.ERC721) {
            leaf = keccak256(abi.encodePacked(l.tokenContract, l.tokenId, buyer, block.chainid, listingId));
        } else {
            leaf = keccak256(abi.encodePacked(l.tokenContract, l.amount, buyer, block.chainid, listingId));
        }

        if (withdrawalsRoot == bytes32(0)) revert InvalidWithdrawalsRoot();
        if (!_verifyMerkleProof(leaf, merkleProof, withdrawalsRoot)) {
            revert InvalidMerkleProof();
        }

        verifier.markNullifierUsed(nullifier);

        l.status = ListingStatus.Sold;
        l.buyer = buyer;

        // Transfer asset to buyer
        if (l.assetType == AssetType.ERC721) {
            IERC721(l.tokenContract).transferFrom(address(this), buyer, l.tokenId);
        } else {
            IERC20(l.tokenContract).safeTransfer(buyer, l.amount);
        }

        emit ListingClaimed(listingId, buyer, l.seller);
    }

    /// @notice Backward-compatible alias
    function claimNft(
        uint256 listingId,
        address buyer,
        bytes calldata merkleProof,
        bytes32 nullifier
    ) external {
        this.claim(listingId, buyer, merkleProof, nullifier);
    }

    // ══════════════════════════════════════════════
    // ██  EMERGENCY CANCEL
    // ══════════════════════════════════════════════

    /**
     * @notice Emergency cancel after timeout (if sequencer is down)
     */
    function emergencyCancel(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        if (l.status != ListingStatus.Active) revert ListingNotActive();
        if (l.seller != msg.sender) revert NotSeller();
        if (block.timestamp < l.listedAt + emergencyTimeout) revert TimeoutNotReached();

        l.status = ListingStatus.Cancelled;
        _returnAsset(l, msg.sender);

        emit EmergencyCancelled(listingId);
    }

    function _returnAsset(Listing storage l, address to) internal {
        if (l.assetType == AssetType.ERC721) {
            IERC721(l.tokenContract).transferFrom(address(this), to, l.tokenId);
        } else {
            IERC20(l.tokenContract).safeTransfer(to, l.amount);
        }
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
        verifier = AxyncVerifier(_verifier);
    }

    function setEmergencyTimeout(uint256 _timeout) external onlyOwner {
        emergencyTimeout = _timeout;
    }

    /**
     * @notice Update withdrawals root (called by relayer after block proof submission)
     * @param _withdrawalsRoot New withdrawals root from the latest block
     */
    function updateWithdrawalsRoot(bytes32 _withdrawalsRoot) external onlyOwner {
        withdrawalsRoot = _withdrawalsRoot;
    }

    function getWithdrawalsRoot() external view returns (bytes32) {
        return withdrawalsRoot;
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

    /**
     * @notice Verify merkle proof against a root
     * @param leaf Leaf hash to verify
     * @param proof Concatenated 32-byte sibling hashes (bottom to top)
     * @param root Expected merkle root
     * @return true if proof is valid
     */
    function _verifyMerkleProof(
        bytes32 leaf,
        bytes calldata proof,
        bytes32 root
    ) internal pure returns (bool) {
        if (leaf == bytes32(0)) return false;

        // Single-leaf tree: proof is empty, root == leaf
        if (proof.length == 0) return leaf == root;
        if (proof.length % 32 != 0) return false;

        bytes32 computedHash = leaf;
        uint256 proofLength = proof.length / 32;

        for (uint256 i = 0; i < proofLength; i++) {
            bytes32 sibling = bytes32(proof[i * 32:(i + 1) * 32]);
            if (computedHash <= sibling) {
                computedHash = keccak256(abi.encodePacked(computedHash, sibling));
            } else {
                computedHash = keccak256(abi.encodePacked(sibling, computedHash));
            }
        }

        return computedHash == root;
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
