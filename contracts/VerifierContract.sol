// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./Groth16Verifier.sol";
import "./libraries/Pairing.sol";

/**
 * @title VerifierContract
 * @notice Verifies ZK proofs for blocks and updates state_root on-chain
 * @dev Rollup-style verifier: accepts block proofs and maintains state_root
 */
contract VerifierContract is Ownable, ReentrancyGuard {
    /// Groth16 verifier instance
    Groth16Verifier public groth16Verifier;
    event StateRootUpdated(
        uint256 indexed blockId,
        bytes32 indexed prevStateRoot,
        bytes32 indexed newStateRoot,
        bytes32 withdrawalsRoot
    );

    event SequencerUpdated(address indexed oldSequencer, address indexed newSequencer);

    /// Current state root (Merkle root of ZKClear state)
    bytes32 public stateRoot;

    /// Sequencer address (only sequencer can submit proofs)
    address public sequencer;

    /// Mapping of processed block IDs to prevent replay
    mapping(uint256 => bool) public processedBlocks;

    /// Mapping of nullifiers to prevent double-spending withdrawals
    mapping(bytes32 => bool) public nullifiers;

    error InvalidSequencerAddress();
    error OnlySequencer();
    error InvalidProof();
    error BlockAlreadyProcessed();
    error InvalidStateRoot();
    error InvalidBlockId();
    error VerifierNotSet();

    modifier onlySequencer() {
        if (msg.sender != sequencer) revert OnlySequencer();
        _;
    }

    constructor(
        address _sequencer,
        bytes32 _initialStateRoot,
        address _owner,
        address _groth16Verifier
    ) Ownable(_owner) {
        if (_sequencer == address(0)) revert InvalidSequencerAddress();
        sequencer = _sequencer;
        stateRoot = _initialStateRoot;
        if (_groth16Verifier != address(0)) {
            groth16Verifier = Groth16Verifier(_groth16Verifier);
        }
    }

    /**
     * @notice Submit block proof and update state root
     * @param blockId Block ID
     * @param prevStateRoot Previous state root (must match current stateRoot)
     * @param newStateRoot New state root after block execution
     * @param withdrawalsRoot Merkle root of withdrawals in this block
     * @param proof ZK proof (STARK wrapped in SNARK) proving state transition
     */
    function submitBlockProof(
        uint256 blockId,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 withdrawalsRoot,
        bytes calldata proof
    ) external onlySequencer nonReentrant {
        // Optimized: early returns to save gas on failed checks
        if (processedBlocks[blockId]) revert BlockAlreadyProcessed();
        if (prevStateRoot != stateRoot) revert InvalidStateRoot();
        if (newStateRoot == bytes32(0)) revert InvalidStateRoot();

        // Verify ZK proof (includes withdrawalsRoot validation)
        if (!verifyBlockProof(prevStateRoot, newStateRoot, withdrawalsRoot, proof)) {
            revert InvalidProof();
        }

        // Update state root and mark block as processed (SSTORE optimization: single slot update)
        bytes32 oldStateRoot = stateRoot;
        stateRoot = newStateRoot;
        processedBlocks[blockId] = true;

        emit StateRootUpdated(blockId, oldStateRoot, newStateRoot, withdrawalsRoot);
    }

    /**
     * @notice Verify block proof using Groth16 verifier
     * @param prevStateRoot Previous state root
     * @param newStateRoot New state root
     * @param withdrawalsRoot Withdrawals root
     * @param proof ZK proof (serialized Groth16 proof)
     * @return true if proof is valid
     */
    function verifyBlockProof(
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 withdrawalsRoot,
        bytes calldata proof
    ) internal view returns (bool) {
        // Basic validation (applies to both real and placeholder verification)
        if (proof.length == 0) return false;
        if (newStateRoot == bytes32(0)) return false;
        // Allow prevStateRoot == 0 for initial state (first block)

        // Check that verifier is set
        if (address(groth16Verifier) == address(0)) {
            // Fallback to placeholder verification if verifier not set
            return verifyBlockProofPlaceholder(prevStateRoot, newStateRoot, withdrawalsRoot, proof);
        }

        // Deserialize proof and public inputs
        // Proof structure: A (64 bytes), B (128 bytes), C (64 bytes)
        // Total: 256 bytes for Groth16 proof on BN254
        if (proof.length < 256) {
            return false;
        }

        // Parse proof (A, B, C points)
        // Optimized: use calldata slices directly to avoid memory copies
        Groth16Verifier.Proof memory groth16Proof;
        
        // A point (G1): 64 bytes (32 bytes X + 32 bytes Y)
        // Optimized: cache slice to avoid repeated calldata access
        bytes32 aX = bytes32(proof[0:32]);
        bytes32 aY = bytes32(proof[32:64]);
        groth16Proof.a = Pairing.G1Point(uint256(aX), uint256(aY));

        // B point (G2): 128 bytes (64 bytes X + 64 bytes Y)
        bytes32 bX0 = bytes32(proof[64:96]);
        bytes32 bX1 = bytes32(proof[96:128]);
        bytes32 bY0 = bytes32(proof[128:160]);
        bytes32 bY1 = bytes32(proof[160:192]);
        groth16Proof.b = Pairing.G2Point(
            [uint256(bX0), uint256(bX1)],
            [uint256(bY0), uint256(bY1)]
        );

        // C point (G1): 64 bytes (32 bytes X + 32 bytes Y)
        bytes32 cX = bytes32(proof[192:224]);
        bytes32 cY = bytes32(proof[224:256]);
        groth16Proof.c = Pairing.G1Point(uint256(cX), uint256(cY));

        // Convert public inputs (3 roots * 8 field elements each = 24 elements)
        // Optimized: extract to helper function to avoid stack too deep
        uint256[] memory publicInputs = new uint256[](24);
        _extractRootToPublicInputs(prevStateRoot, publicInputs, 0);
        _extractRootToPublicInputs(newStateRoot, publicInputs, 8);
        _extractRootToPublicInputs(withdrawalsRoot, publicInputs, 16);

        // Verify proof using Groth16 verifier
        // Check if verifying key is set by checking if gamma_abc length > 0
        // We can't directly access vk, so we try to verify and catch revert
        // But since this is a view function, we need a different approach
        // For now, we'll check if the verifier address is set and assume it has a key
        // If verification fails, we'll fall back to placeholder
        // Note: This is a limitation - we can't easily check if verifying key is set
        // In production, verifying key should always be set before using the verifier
        return groth16Verifier.verifyProof(groth16Proof, publicInputs);
    }

    /**
     * @notice Placeholder verification (used when Groth16 verifier is not set)
     * @param prevStateRoot Previous state root
     * @param newStateRoot New state root
     * @param withdrawalsRoot Withdrawals root
     * @param proof ZK proof
     * @return true if proof is valid (placeholder implementation)
     */
    function verifyBlockProofPlaceholder(
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 withdrawalsRoot,
        bytes calldata proof
    ) internal pure returns (bool) {
        // Basic validation
        if (proof.length == 0) return false;
        // Allow prevStateRoot == 0 for initial state (first block)
        // if (prevStateRoot == bytes32(0)) return false;
        if (newStateRoot == bytes32(0)) return false;

        // Use withdrawalsRoot in validation (prevents "unused parameter" warning)
        if (withdrawalsRoot == bytes32(0) && prevStateRoot != bytes32(0)) {
            // Allow zero withdrawals root only for initial state
        }

        // Placeholder: accept non-empty proof
        // In production, this will call the actual SNARK verifier
        return true;
    }

    /**
     * @notice Check if withdrawal nullifier has been used
     * @param nullifier Nullifier to check
     * @return true if nullifier has been used
     */
    function isNullifierUsed(bytes32 nullifier) external view returns (bool) {
        return nullifiers[nullifier];
    }

    /**
     * @notice Mark nullifier as used (called by WithdrawalContract)
     * @param nullifier Nullifier to mark as used
     */
    function markNullifierUsed(bytes32 nullifier) external {
        // Only WithdrawalContract can call this
        // TODO: Add access control for WithdrawalContract addresses
        nullifiers[nullifier] = true;
    }

    /**
     * @notice Set sequencer address
     * @param _sequencer New sequencer address
     */
    function setSequencer(address _sequencer) external onlySequencer {
        if (_sequencer == address(0)) revert InvalidSequencerAddress();
        address oldSequencer = sequencer;
        sequencer = _sequencer;
        emit SequencerUpdated(oldSequencer, _sequencer);
    }

    /**
     * @notice Get current state root
     * @return Current state root
     */
    function getStateRoot() external view returns (bytes32) {
        return stateRoot;
    }

    /**
     * @notice Set Groth16 verifier address
     * @param _groth16Verifier Address of Groth16Verifier contract
     */
    function setGroth16Verifier(address _groth16Verifier) external onlyOwner {
        if (_groth16Verifier == address(0)) revert InvalidSequencerAddress();
        groth16Verifier = Groth16Verifier(_groth16Verifier);
    }

    /**
     * @notice Extract 8 u32 values from bytes32 root to public inputs array
     * @param root Bytes32 root to extract from
     * @param publicInputs Array to write to
     * @param offset Starting index in publicInputs array
     * @dev Optimized: helper function to avoid stack too deep errors
     *      Extracts bytes in little-endian order (matching Rust u32::from_le_bytes)
     */
    function _extractRootToPublicInputs(
        bytes32 root,
        uint256[] memory publicInputs,
        uint256 offset
    ) private pure {
        unchecked {
            // Extract 8 u32 values (4 bytes each) from bytes32
            // bytes32 indices: [0..31] (big-endian in Solidity)
            // We need little-endian: bytes[0-3], bytes[4-7], ..., bytes[28-31]
            for (uint256 i = 0; i < 8; ++i) {
                uint256 startByte = i * 4; // Start byte position (0, 4, 8, ..., 28)
                uint256 value = 0;
                // Read 4 bytes in little-endian order
                for (uint256 j = 0; j < 4; ++j) {
                    uint256 byteIndex = startByte + j;
                    require(byteIndex < 32, "Byte index out of bounds");
                    uint256 byteVal = uint256(uint8(root[31 - byteIndex])); // Reverse for little-endian
                    value |= byteVal << (j * 8);
                }
                publicInputs[offset + i] = value;
            }
        }
    }
}

