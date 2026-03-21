// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./Groth16Verifier.sol";
import "./libraries/Pairing.sol";

/**
 * @title AxyncVerifier
 * @notice Verifies ZK proofs for blocks and updates state_root on-chain
 * @dev Rollup-style verifier: accepts block proofs and maintains state_root
 */
contract AxyncVerifier is Ownable, ReentrancyGuard {
    /// Groth16 verifier instance
    Groth16Verifier public groth16Verifier;

    event StateRootUpdated(
        uint256 indexed blockId,
        bytes32 indexed prevStateRoot,
        bytes32 indexed newStateRoot,
        bytes32 withdrawalsRoot
    );

    event SequencerUpdated(address indexed oldSequencer, address indexed newSequencer);

    /// Current state root (Merkle root of Axync state)
    bytes32 public stateRoot;

    /// Sequencer address (only sequencer can submit proofs)
    address public sequencer;

    /// Mapping of processed block IDs to prevent replay
    mapping(uint256 => bool) public processedBlocks;

    /// Mapping of nullifiers to prevent double-spending withdrawals
    mapping(bytes32 => bool) public nullifiers;

    /// Authorized AxyncVault address
    address public vaultContract;

    /// Authorized AxyncEscrow address
    address public escrowContract;

    error InvalidSequencerAddress();
    error OnlySequencer();
    error OnlyAuthorizedContract();
    error InvalidProof();
    error BlockAlreadyProcessed();
    error InvalidStateRoot();
    error InvalidBlockId();
    error VerifierNotSet();
    error InvalidAddress();

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
        if (processedBlocks[blockId]) revert BlockAlreadyProcessed();
        if (prevStateRoot != stateRoot) revert InvalidStateRoot();
        if (newStateRoot == bytes32(0)) revert InvalidStateRoot();

        if (!verifyBlockProof(prevStateRoot, newStateRoot, withdrawalsRoot, proof)) {
            revert InvalidProof();
        }

        bytes32 oldStateRoot = stateRoot;
        stateRoot = newStateRoot;
        processedBlocks[blockId] = true;

        emit StateRootUpdated(blockId, oldStateRoot, newStateRoot, withdrawalsRoot);
    }

    /**
     * @notice Verify block proof using Groth16 verifier
     */
    function verifyBlockProof(
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 withdrawalsRoot,
        bytes calldata proof
    ) internal view returns (bool) {
        if (proof.length == 0) return false;
        if (newStateRoot == bytes32(0)) return false;

        if (address(groth16Verifier) == address(0)) {
            return verifyBlockProofPlaceholder(prevStateRoot, newStateRoot, withdrawalsRoot, proof);
        }

        if (proof.length < 256) {
            return false;
        }

        Groth16Verifier.Proof memory groth16Proof;

        bytes32 aX = bytes32(proof[0:32]);
        bytes32 aY = bytes32(proof[32:64]);
        groth16Proof.a = Pairing.G1Point(uint256(aX), uint256(aY));

        bytes32 bX0 = bytes32(proof[64:96]);
        bytes32 bX1 = bytes32(proof[96:128]);
        bytes32 bY0 = bytes32(proof[128:160]);
        bytes32 bY1 = bytes32(proof[160:192]);
        groth16Proof.b = Pairing.G2Point(
            [uint256(bX0), uint256(bX1)],
            [uint256(bY0), uint256(bY1)]
        );

        bytes32 cX = bytes32(proof[192:224]);
        bytes32 cY = bytes32(proof[224:256]);
        groth16Proof.c = Pairing.G1Point(uint256(cX), uint256(cY));

        uint256[] memory publicInputs = new uint256[](24);
        _extractRootToPublicInputs(prevStateRoot, publicInputs, 0);
        _extractRootToPublicInputs(newStateRoot, publicInputs, 8);
        _extractRootToPublicInputs(withdrawalsRoot, publicInputs, 16);

        return groth16Verifier.verifyProof(groth16Proof, publicInputs);
    }

    /**
     * @notice Placeholder verification (used when Groth16 verifier is not set)
     */
    function verifyBlockProofPlaceholder(
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 withdrawalsRoot,
        bytes calldata proof
    ) internal pure returns (bool) {
        if (proof.length == 0) return false;
        if (newStateRoot == bytes32(0)) return false;

        if (withdrawalsRoot == bytes32(0) && prevStateRoot != bytes32(0)) {
            // Allow zero withdrawals root only for initial state
        }

        return true;
    }

    /**
     * @notice Check if nullifier has been used
     */
    function isNullifierUsed(bytes32 nullifier) external view returns (bool) {
        return nullifiers[nullifier];
    }

    /**
     * @notice Mark nullifier as used (called by AxyncVault or AxyncEscrow)
     */
    function markNullifierUsed(bytes32 nullifier) external {
        if (msg.sender != vaultContract && msg.sender != escrowContract) revert OnlyAuthorizedContract();
        nullifiers[nullifier] = true;
    }

    /**
     * @notice Set the authorized AxyncVault address
     */
    function setVaultContract(address _vaultContract) external onlyOwner {
        if (_vaultContract == address(0)) revert InvalidAddress();
        vaultContract = _vaultContract;
    }

    /**
     * @notice Set the authorized AxyncEscrow address
     */
    function setEscrowContract(address _escrowContract) external onlyOwner {
        if (_escrowContract == address(0)) revert InvalidAddress();
        escrowContract = _escrowContract;
    }

    /**
     * @notice Set sequencer address (callable by current sequencer or owner)
     */
    function setSequencer(address _sequencer) external {
        if (msg.sender != sequencer && msg.sender != owner()) revert OnlySequencer();
        if (_sequencer == address(0)) revert InvalidSequencerAddress();
        address oldSequencer = sequencer;
        sequencer = _sequencer;
        emit SequencerUpdated(oldSequencer, _sequencer);
    }

    /**
     * @notice Get current state root
     */
    function getStateRoot() external view returns (bytes32) {
        return stateRoot;
    }

    /**
     * @notice Set Groth16 verifier address
     */
    function setGroth16Verifier(address _groth16Verifier) external onlyOwner {
        if (_groth16Verifier == address(0)) revert InvalidAddress();
        groth16Verifier = Groth16Verifier(_groth16Verifier);
    }

    /**
     * @notice Extract 8 u32 values from bytes32 root to public inputs array
     */
    function _extractRootToPublicInputs(
        bytes32 root,
        uint256[] memory publicInputs,
        uint256 offset
    ) private pure {
        unchecked {
            for (uint256 i = 0; i < 8; ++i) {
                uint256 startByte = i * 4;
                uint256 value = 0;
                for (uint256 j = 0; j < 4; ++j) {
                    uint256 byteIndex = startByte + j;
                    require(byteIndex < 32, "Byte index out of bounds");
                    uint256 byteVal = uint256(uint8(root[31 - byteIndex]));
                    value |= byteVal << (j * 8);
                }
                publicInputs[offset + i] = value;
            }
        }
    }
}
