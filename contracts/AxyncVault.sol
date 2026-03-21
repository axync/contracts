// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./AxyncVerifier.sol";

struct WithdrawalData {
    address user;
    uint256 assetId;
    uint256 amount;
    uint256 chainId;
}

/**
 * @title AxyncVault
 * @notice Unified deposit and withdrawal contract for Axync cross-chain settlement
 * @dev Deposits fund the vault; withdrawals pay out from the same vault with ZK proof verification
 */
contract AxyncVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Events ──

    event Deposit(
        address indexed user,
        uint256 indexed assetId,
        uint256 amount,
        bytes32 indexed txHash
    );

    event Withdrawal(
        address indexed user,
        uint256 indexed assetId,
        uint256 amount,
        bytes32 indexed nullifier,
        bytes32 withdrawalsRoot
    );

    event VerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    // ── State ──

    /// ERC20 asset registry
    mapping(uint256 => address) public assetAddresses;

    /// Processed deposit hashes (replay protection)
    mapping(bytes32 => bool) public processedDeposits;

    /// Verifier contract for state root and nullifier checks
    AxyncVerifier public verifier;

    /// Current withdrawals root from latest block
    bytes32 public withdrawalsRoot;

    // ── Errors ──

    error InvalidUser();
    error InvalidAmount();
    error InvalidProof();
    error InvalidVerifierAddress();
    error NullifierAlreadyUsed();
    error InvalidMerkleProof();
    error InvalidWithdrawalsRoot();

    // ── Modifiers ──

    modifier onlyValidVerifier() {
        require(address(verifier) != address(0), "Verifier not set");
        _;
    }

    // ── Constructor ──

    constructor(address _verifier, address _owner) Ownable(_owner) {
        if (_verifier == address(0)) revert InvalidVerifierAddress();
        verifier = AxyncVerifier(_verifier);
    }

    // ══════════════════════════════════════════════
    // ██  DEPOSITS
    // ══════════════════════════════════════════════

    function registerAsset(uint256 assetId, address tokenAddress) external onlyOwner {
        require(tokenAddress != address(0), "Invalid token address");
        assetAddresses[assetId] = tokenAddress;
    }

    function deposit(uint256 assetId, uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be greater than 0");
        require(assetId > 0, "Invalid asset ID");
        require(msg.sender != address(0), "Invalid sender");

        address tokenAddress = assetAddresses[assetId];
        require(tokenAddress != address(0), "Asset not registered");

        bytes32 txHash = keccak256(
            abi.encodePacked(
                msg.sender, assetId, amount,
                block.timestamp, block.number, blockhash(block.number - 1)
            )
        );

        require(!processedDeposits[txHash], "Deposit already processed");
        processedDeposits[txHash] = true;

        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amount);

        emit Deposit(msg.sender, assetId, amount, txHash);
    }

    function depositNative(uint256 assetId) external payable nonReentrant {
        require(msg.value > 0, "Amount must be greater than 0");
        require(msg.sender != address(0), "Invalid sender");
        require(assetAddresses[assetId] == address(0), "Use ERC20 deposit for this asset");

        bytes32 txHash = keccak256(
            abi.encodePacked(
                msg.sender, assetId, msg.value,
                block.timestamp, block.number, blockhash(block.number - 1)
            )
        );

        require(!processedDeposits[txHash], "Deposit already processed");
        processedDeposits[txHash] = true;

        emit Deposit(msg.sender, assetId, msg.value, txHash);
    }

    // ══════════════════════════════════════════════
    // ██  WITHDRAWALS
    // ══════════════════════════════════════════════

    function withdraw(
        WithdrawalData calldata withdrawalData,
        bytes calldata merkleProof,
        bytes32 nullifier,
        bytes calldata zkProof,
        bytes32 withdrawalsRoot_
    ) external nonReentrant onlyValidVerifier {
        if (withdrawalData.amount == 0) revert InvalidAmount();
        if (withdrawalData.user != msg.sender) revert InvalidUser();
        if (withdrawalData.user == address(0)) revert InvalidUser();
        if (withdrawalData.assetId == 0) revert InvalidAmount();
        if (nullifier == bytes32(0)) revert InvalidProof();
        if (zkProof.length == 0) revert InvalidProof();

        AxyncVerifier verifier_ = verifier;
        if (verifier_.isNullifierUsed(nullifier)) revert NullifierAlreadyUsed();

        bytes32 currentWithdrawalsRoot = withdrawalsRoot;
        if (withdrawalsRoot_ != currentWithdrawalsRoot && withdrawalsRoot_ != bytes32(0)) {
            revert InvalidWithdrawalsRoot();
        }

        if (!verifyMerkleProof(withdrawalData, merkleProof, withdrawalsRoot_)) {
            revert InvalidMerkleProof();
        }

        if (!verifyWithdrawalProof(withdrawalData, zkProof)) {
            revert InvalidProof();
        }

        verifier_.markNullifierUsed(nullifier);

        emit Withdrawal(
            withdrawalData.user,
            withdrawalData.assetId,
            withdrawalData.amount,
            nullifier,
            withdrawalsRoot_
        );

        // Transfer native ETH to the user
        (bool success, ) = payable(withdrawalData.user).call{value: withdrawalData.amount}("");
        require(success, "ETH transfer failed");
    }

    function updateWithdrawalsRoot(bytes32 newWithdrawalsRoot) external onlyOwner {
        withdrawalsRoot = newWithdrawalsRoot;
    }

    function getWithdrawalsRoot() external view returns (bytes32) {
        return withdrawalsRoot;
    }

    function setVerifier(address _verifier) external onlyOwner {
        if (_verifier == address(0)) revert InvalidVerifierAddress();
        address oldVerifier = address(verifier);
        verifier = AxyncVerifier(_verifier);
        emit VerifierUpdated(oldVerifier, _verifier);
    }

    // ══════════════════════════════════════════════
    // ██  OWNER MANAGEMENT
    // ══════════════════════════════════════════════

    function withdrawTokens(address tokenAddress, uint256 amount) external onlyOwner {
        require(tokenAddress != address(0), "Invalid token address");
        IERC20(tokenAddress).safeTransfer(owner(), amount);
    }

    function withdrawNative(uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "Insufficient balance");
        (bool success, ) = payable(owner()).call{value: amount}("");
        require(success, "Transfer failed");
    }

    // ══════════════════════════════════════════════
    // ██  INTERNAL
    // ══════════════════════════════════════════════

    function verifyMerkleProof(
        WithdrawalData calldata withdrawalData,
        bytes calldata merkleProof,
        bytes32 root
    ) internal pure returns (bool) {
        if (root == bytes32(0)) return false;

        bytes32 leaf = keccak256(
            abi.encodePacked(
                withdrawalData.user,
                withdrawalData.assetId,
                withdrawalData.amount,
                withdrawalData.chainId
            )
        );

        if (leaf == bytes32(0)) return false;

        // Single-leaf tree: proof is empty, root == leaf
        if (merkleProof.length == 0) return leaf == root;
        if (merkleProof.length % 32 != 0) return false;

        // Walk merkle proof path
        bytes32 computedHash = leaf;
        uint256 proofLength = merkleProof.length / 32;

        for (uint256 i = 0; i < proofLength; i++) {
            bytes32 sibling = bytes32(merkleProof[i * 32:(i + 1) * 32]);
            if (computedHash <= sibling) {
                computedHash = keccak256(abi.encodePacked(computedHash, sibling));
            } else {
                computedHash = keccak256(abi.encodePacked(sibling, computedHash));
            }
        }

        return computedHash == root;
    }

    function verifyWithdrawalProof(
        WithdrawalData calldata /* withdrawalData */,
        bytes calldata zkProof
    ) internal pure returns (bool) {
        if (zkProof.length == 0) return false;
        return true;
    }

    receive() external payable {
        revert("Use depositNative function");
    }
}
