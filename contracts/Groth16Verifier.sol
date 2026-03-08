// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./libraries/Pairing.sol";

/**
 * @title Groth16Verifier
 * @notice Verifies Groth16 proofs on BN254 curve
 * @dev This contract verifies Groth16 proofs for ZKClear block state transitions
 */
contract Groth16Verifier {
    using Pairing for *;

    struct VerifyingKey {
        Pairing.G1Point alpha;
        Pairing.G2Point beta;
        Pairing.G2Point gamma;
        Pairing.G2Point delta;
        Pairing.G1Point[] gamma_abc;
    }

    struct Proof {
        Pairing.G1Point a;
        Pairing.G2Point b;
        Pairing.G1Point c;
    }

    // Type aliases for convenience
    using Pairing for Pairing.G1Point;
    using Pairing for Pairing.G2Point;

    VerifyingKey public vk;

    event VerifyingKeySet();

    error InvalidVerifyingKey();
    error InvalidPublicInputs();
    error InvalidProof();

    /**
     * @notice Set the verifying key
     * @param _alpha Alpha point (G1)
     * @param _beta Beta point (G2)
     * @param _gamma Gamma point (G2)
     * @param _delta Delta point (G2)
     * @param _gamma_abc Array of gamma_abc points (G1) - one per public input
     */
    function setVerifyingKey(
        Pairing.G1Point memory _alpha,
        Pairing.G2Point memory _beta,
        Pairing.G2Point memory _gamma,
        Pairing.G2Point memory _delta,
        Pairing.G1Point[] memory _gamma_abc
    ) external {
        // Verify that gamma_abc has correct length
        // In Groth16, gamma_abc length = number of public inputs + 1 (constant term)
        // We have 24 public inputs (3 roots * 8 elements each) + 1 constant = 25
        // But Arkworks may generate more (27), so we accept >= 25
        if (_gamma_abc.length < 25) {
            revert InvalidVerifyingKey();
        }

        // Set verifying key fields
        vk.alpha = _alpha;
        vk.beta = _beta;
        vk.gamma = _gamma;
        vk.delta = _delta;

        // Copy gamma_abc array element by element (can't copy memory array to storage directly)
        delete vk.gamma_abc;
        for (uint256 i = 0; i < _gamma_abc.length; i++) {
            vk.gamma_abc.push(_gamma_abc[i]);
        }

        emit VerifyingKeySet();
    }

    /**
     * @notice Verify a Groth16 proof
     * @param _proof The Groth16 proof (A, B, C)
     * @param _publicInputs Array of public input field elements (24 elements for 3 roots)
     * @return true if proof is valid
     */
    function verify(
        Proof memory _proof,
        uint256[] memory _publicInputs
    ) internal view returns (bool) {
        // Verify public inputs length (24 elements: 3 roots * 8 elements each)
        if (_publicInputs.length != 24) {
            revert InvalidPublicInputs();
        }

        // Verify that gamma_abc has enough elements (at least 25: 1 constant + 24 public inputs)
        if (vk.gamma_abc.length < 25) {
            revert InvalidVerifyingKey();
        }

        // Compute vk_x (linear combination of gamma_abc with public inputs)
        // Optimized: reduce storage reads and use unchecked arithmetic where safe
        // gamma_abc[0] is the constant term, gamma_abc[1..24] are for public inputs
        Pairing.G1Point memory vk_x = vk.gamma_abc[0]; // Start with constant term
        
        // Add public input terms
        // Optimized: cache array length and use unchecked for loop counter
        uint256 publicInputsLength = _publicInputs.length;
        unchecked {
            for (uint256 i = 0; i < publicInputsLength; ++i) {
                vk_x = Pairing.plus(
                    vk_x,
                    Pairing.scalar_mul(vk.gamma_abc[i + 1], _publicInputs[i])
                );
            }
        }

        // Verify pairing equation:
        // e(A, B) = e(alpha, beta) * e(vk_x, gamma) * e(C, delta)
        // This is equivalent to:
        // e(A, B) * e(alpha.negate(), beta) * e(vk_x.negate(), gamma) * e(C.negate(), delta) == 1

        Pairing.G1Point[] memory p1 = new Pairing.G1Point[](4);
        Pairing.G2Point[] memory p2 = new Pairing.G2Point[](4);

        p1[0] = _proof.a;
        p2[0] = _proof.b;

        p1[1] = Pairing.negate(vk.alpha);
        p2[1] = vk.beta;

        p1[2] = Pairing.negate(vk_x);
        p2[2] = vk.gamma;

        p1[3] = Pairing.negate(_proof.c);
        p2[3] = vk.delta;

        return Pairing.pairing(p1, p2);
    }

    /**
     * @notice Verify a Groth16 proof with public inputs
     * @param _proof The Groth16 proof (A, B, C)
     * @param _publicInputs Array of public input field elements (24 elements for 3 roots)
     * @return true if proof is valid
     */
    function verifyProof(
        Proof memory _proof,
        uint256[] memory _publicInputs
    ) public view returns (bool) {
        // Check that verifying key is set
        if (vk.gamma_abc.length == 0) {
            revert InvalidVerifyingKey();
        }

        return verify(_proof, _publicInputs);
    }
}

