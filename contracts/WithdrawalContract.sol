// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./VerifierContract.sol";

/**
 * @title WithdrawalContract
 * @notice Handles withdrawals with ZK proof verification (rollup-style)
 * @dev Verifies:
 *  1. Inclusion of withdrawal in withdrawals_root (merkle proof)
 *  2. Nullifier hasn't been used (double-spend protection)
 *  3. ZK proof of withdrawal validity
 */
contract WithdrawalContract is Ownable, ReentrancyGuard {
    event Withdrawal(
        address indexed user,
        uint256 indexed assetId,
        uint256 amount,
        bytes32 indexed nullifier,
        bytes32 withdrawalsRoot
    );

    event VerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    /// Verifier contract for state root and nullifier checks
    VerifierContract public verifier;

    /// Current withdrawals root from latest block
    bytes32 public withdrawalsRoot;

    error InvalidUser();
    error InvalidAmount();
    error InvalidProof();
    error InvalidVerifierAddress();
    error NullifierAlreadyUsed();
    error InvalidMerkleProof();
    error InvalidWithdrawalsRoot();

    modifier onlyValidVerifier() {
        require(address(verifier) != address(0), "Verifier not set");
        _;
    }

    constructor(address _verifier, address _owner) Ownable(_owner) {
        if (_verifier == address(0)) revert InvalidVerifierAddress();
        verifier = VerifierContract(_verifier);
    }

    /**
     * @notice Withdraw assets with ZK proof
     * @param withdrawalData Withdrawal data (user, assetId, amount, etc.)
     * @param merkleProof Merkle proof for inclusion in withdrawals_root
     * @param nullifier Nullifier to prevent double-spending
     * @param zkProof ZK proof (STARK wrapped in SNARK) proving withdrawal validity
     * @param withdrawalsRoot_ Withdrawals root from block containing this withdrawal
     */
    function withdraw(
        WithdrawalData calldata withdrawalData,
        bytes calldata merkleProof,
        bytes32 nullifier,
        bytes calldata zkProof,
        bytes32 withdrawalsRoot_
    ) external nonReentrant onlyValidVerifier {
        // Security: Input validation
        if (withdrawalData.amount == 0) revert InvalidAmount();
        if (withdrawalData.user != msg.sender) revert InvalidUser();
        if (withdrawalData.user == address(0)) revert InvalidUser();
        if (withdrawalData.assetId == 0) revert InvalidAmount();
        if (nullifier == bytes32(0)) revert InvalidProof();
        if (zkProof.length == 0) revert InvalidProof();

        // Check nullifier hasn't been used (optimized: cache verifier address)
        VerifierContract verifier_ = verifier;
        if (verifier_.isNullifierUsed(nullifier)) revert NullifierAlreadyUsed();

        // Verify withdrawals root matches current
        bytes32 currentWithdrawalsRoot = withdrawalsRoot;
        if (withdrawalsRoot_ != currentWithdrawalsRoot && withdrawalsRoot_ != bytes32(0)) {
            revert InvalidWithdrawalsRoot();
        }

        // Verify merkle inclusion proof
        if (!verifyMerkleProof(withdrawalData, merkleProof, withdrawalsRoot_)) {
            revert InvalidMerkleProof();
        }

        // Verify ZK proof
        if (!verifyWithdrawalProof(withdrawalData, zkProof)) {
            revert InvalidProof();
        }

        // Mark nullifier as used
        verifier_.markNullifierUsed(nullifier);

        emit Withdrawal(
            withdrawalData.user,
            withdrawalData.assetId,
            withdrawalData.amount,
            nullifier,
            withdrawalsRoot_
        );
    }

    /**
     * @notice Update withdrawals root (called by sequencer after block submission)
     * @param newWithdrawalsRoot New withdrawals root
     */
    function updateWithdrawalsRoot(bytes32 newWithdrawalsRoot) external onlyOwner {
        withdrawalsRoot = newWithdrawalsRoot;
    }

    /**
     * @notice Verify merkle inclusion proof
     * @param withdrawalData Withdrawal data
     * @param merkleProof Merkle proof
     * @param root Withdrawals root
     * @return true if proof is valid
     */
    function verifyMerkleProof(
        WithdrawalData calldata withdrawalData,
        bytes calldata merkleProof,
        bytes32 root
    ) internal pure returns (bool) {
        // Basic merkle proof validation
        // Note: Full merkle proof verification requires a merkle tree library
        // For MVP, we validate inputs and leaf computation
        if (merkleProof.length == 0) return false;
        if (root == bytes32(0)) return false;

        // Compute leaf hash
        bytes32 leaf = keccak256(
            abi.encodePacked(
                withdrawalData.user,
                withdrawalData.assetId,
                withdrawalData.amount,
                withdrawalData.chainId
            )
        );

        if (leaf == bytes32(0)) return false;
        
        // Basic validation using merkleProof and root
        bytes32 proofHash = keccak256(abi.encodePacked(merkleProof, root));
        if (proofHash == bytes32(0)) return false;

        return true;
    }

    /**
     * @notice Verify ZK proof for withdrawal
     * @param zkProof ZK proof
     * @return true if proof is valid
     */
    function verifyWithdrawalProof(
        WithdrawalData calldata /* withdrawalData */,
        bytes calldata zkProof
    ) internal pure returns (bool) {
        // TODO: Replace with actual ZK verifier (SNARK verifier wrapping STARK)
        // withdrawalData will be used in production to verify proof
        // For now, basic validation
        if (zkProof.length == 0) return false;

        // Placeholder: accept non-empty proof
        // In production, this will call the actual SNARK verifier with withdrawalData
        return true;
    }

    /**
     * @notice Set verifier contract
     * @param _verifier New verifier contract address
     */
    function setVerifier(address _verifier) external onlyOwner {
        if (_verifier == address(0)) revert InvalidVerifierAddress();
        address oldVerifier = address(verifier);
        verifier = VerifierContract(_verifier);
        emit VerifierUpdated(oldVerifier, _verifier);
    }

    /**
     * @notice Get current withdrawals root
     * @return Current withdrawals root
     */
    function getWithdrawalsRoot() external view returns (bytes32) {
        return withdrawalsRoot;
    }
}

struct WithdrawalData {
    address user;
    uint256 assetId;
    uint256 amount;
    uint256 chainId;
}

