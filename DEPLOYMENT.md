# ZKClear Contracts Deployment Guide

## Quick Start for Testing

### 1. Deploy Contracts to Local Test Network (Hardhat)

```bash
npm run deploy:testnet
```

This will deploy all contracts to the local Hardhat network and save addresses to `deployment-addresses.json`.

### 2. Set Verifying Key

After deployment, you need to set the verifying key in Groth16Verifier:

```bash
# Set the Groth16Verifier address from deployment-addresses.json
export GROTH16_VERIFIER_ADDRESS=<address_from_deployment>

# Or use directly:
GROTH16_VERIFIER_ADDRESS=<address> npm run set-verifying-key
```

### 3. Run Tests

```bash
# All tests
npm test

# Specific test
npx hardhat test test/VerifierContract.test.js
npx hardhat test test/Groth16Verifier.test.js
```

## Contract Structure

1. **DepositContract** - Accepts deposits (ERC20 and native ETH)
2. **Groth16Verifier** - Verifies Groth16 proofs on BN254
3. **VerifierContract** - Main contract for verifying block proofs and updating state_root
4. **WithdrawalContract** - Handles withdrawals with Merkle inclusion and nullifier checks

## Deployment Process

### Local Test Network (Hardhat)

```bash
# 1. Deploy all contracts
npm run deploy:testnet

# 2. Set verifying key
GROTH16_VERIFIER_ADDRESS=<address> npm run set-verifying-key

# 3. Testing
npm test
```

### Test Networks (Sepolia, Base Sepolia)

```bash
# 1. Configure .env file with PRIVATE_KEY and RPC URL
# 2. Get testnet tokens from faucets
# 3. Deploy
npm run deploy:sepolia        # For Sepolia (Ethereum testnet)
npm run deploy:base-sepolia   # For Base Sepolia (Base testnet)

# 4. Set verifying key
GROTH16_VERIFIER_ADDRESS=<address> npm run set-verifying-key -- --network <network>
```

## Important Notes

1. **Verifying Key**: Must be set in Groth16Verifier before use. Without it, the contract will use placeholder verification (testing only).

2. **State Root**: Initial state root is set as `ZeroHash`. It will be updated after the first block.

3. **Sequencer**: Only the sequencer can submit block proofs. The sequencer address is set during deployment.

4. **Placeholder Verification**: If Groth16Verifier is not set or verifying key is not set, placeholder verification is used (accepts any non-empty proof). This is for testing only!

## Testing On-Chain Verification

For full on-chain verification testing, you need to:

1. Generate a real Groth16 proof in Rust (via prover service)
2. Serialize the proof to Solidity format (256 bytes: A + B + C)
3. Convert public inputs (3 roots * 8 field elements = 24 elements)
4. Submit to VerifierContract via `submitBlockProof`

Example proof structure:
- A (G1): 64 bytes (32 X + 32 Y)
- B (G2): 128 bytes (64 X + 64 Y)
- C (G1): 64 bytes (32 X + 32 Y)
- Total: 256 bytes

## Troubleshooting

### Error "InvalidVerifyingKey"
- Ensure verifying key is set in Groth16Verifier
- Check that gamma_abc has at least 25 elements

### Error "InvalidProof"
- Check that proof has correct size (minimum 256 bytes for Groth16)
- Ensure public inputs have correct format (24 elements)

### Error "OnlySequencer"
- Ensure transaction is sent from sequencer address
- Check that sequencer is set correctly
