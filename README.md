# Axync Contracts

Solidity smart contracts for [Axync](https://axync.xyz) — cross-chain marketplace for tokens and vesting positions.

## Contracts

Three contracts are deployed on each supported chain:

| Contract | Description |
|----------|-------------|
| **AxyncEscrow** | Holds listed assets (ERC-20 tokens and ERC-721 NFTs). Releases them to buyers via merkle proof verification. |
| **AxyncVault** | Accepts ETH deposits from buyers. Processes withdrawals with merkle proofs. |
| **AxyncVerifier** | Receives state roots and withdrawals roots from the relayer. Tracks nullifiers to prevent double-claims. |

Supporting contracts:

| Contract | Description |
|----------|-------------|
| **Groth16Verifier** | On-chain Groth16 proof verifier on BN254 curve |
| **ERC20Mock** | Test ERC-20 token (testnet only) |
| **ERC721Mock** | Test ERC-721 NFT (testnet only) |

## Flow

```
Seller ──> AxyncEscrow.listToken() or listNft()
                    │
              Watcher detects event
                    │
Buyer ──> AxyncVault.depositNative() ──> Sequencer credits balance
                    │
Buyer ──> Sequencer API (BuyNft TX, EIP-712 signed)
                    │
              Sequencer builds block
                    │
Relayer ──> AxyncVerifier.submitBlockProof()
                    │
Buyer ──> AxyncEscrow.claim() with merkle proof
```

## Deployed Addresses

### Ethereum Sepolia (11155111)

| Contract | Address |
|----------|---------|
| AxyncVault | `0xC0659E7a7b4E81AFe607A7aECd57A7E8E23Ba164` |
| AxyncEscrow | `0x58b91CCB7F4DC0f749573f55f13f8892A5189f53` |
| AxyncVerifier | `0xa7678aAa71E016A3b31D993aDdC6bfE579413d9D` |

### Base Sepolia (84532)

| Contract | Address |
|----------|---------|
| AxyncVault | `0xE047A68aaB75C479aF21bA34F5fE931c13ed770a` |
| AxyncEscrow | `0xa0654945B0d571c78Bf3D1cE4d3cfF45B76FCF99` |
| AxyncVerifier | `0x80dF1a4c753B162aDd23751B4D670c3Ee88e2D1D` |

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with PRIVATE_KEY and RPC URLs
```

## Deploy

```bash
# Full deployment (both chains)
npx hardhat run scripts/deploy-full-marketplace.js

# E2E test
node scripts/test-flow-erc20.js
```

## Test

```bash
npm test
```

## Security

- **ReentrancyGuard** on all state-changing functions
- **Nullifier tracking** prevents double-claims
- **Merkle verification** (keccak256 sorted pairs) matches off-chain computation
- **Ownable** access control for admin functions
- **Not audited** — audit planned before mainnet

## License

MIT
