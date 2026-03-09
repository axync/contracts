# Axync Contracts

Solidity smart contracts for the Axync cross-chain settlement protocol. These contracts handle deposits, zero-knowledge proof verification (Groth16 on BN254), state root management, and withdrawals on Ethereum and Base.

## Architecture

The contract suite consists of four core contracts and one supporting library:

| Contract | Description |
|---|---|
| **DepositContract** | Accepts user deposits of ERC-20 tokens and native ETH on each supported EVM chain. Emits indexed events consumed by the off-chain watcher. |
| **Groth16Verifier** | On-chain Groth16 proof verifier operating over the BN254 curve. Stores a configurable verifying key and exposes `verifyProof` for state-transition proofs (24 public inputs derived from three 256-bit roots). |
| **VerifierContract** | Rollup-style state manager. Accepts block proofs from the sequencer, delegates cryptographic verification to `Groth16Verifier`, updates the on-chain state root, and tracks nullifiers to prevent double-spending. |
| **WithdrawalContract** | Processes user withdrawals by verifying Merkle inclusion proofs and ZK proofs against the current withdrawals root, then releasing funds. |
| **Pairing** (library) | BN254 elliptic-curve pairing utilities used internally by `Groth16Verifier`. |

### Data Flow

```
User Deposit --> DepositContract (on-chain event)
                        |
                    Watcher (off-chain) --> Sequencer
                        |
                  Sequencer produces block proof
                        |
              VerifierContract.submitBlockProof()
                        |
                Groth16Verifier.verifyProof()
                        |
                  State root updated
                        |
              WithdrawalContract.withdraw()
```

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Hardhat** (installed via npm)

For testnet or mainnet deployments you will also need:

- A funded deployer wallet (private key)
- RPC endpoint URLs for the target networks
- Block explorer API keys for contract verification (Etherscan, Basescan)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

3. Configure `.env` with your credentials:

```env
PRIVATE_KEY=0x...
ETHEREUM_RPC=https://eth.llamarpc.com
SEPOLIA_RPC=https://rpc.sepolia.org
BASE_RPC=https://mainnet.base.org
BASE_SEPOLIA_RPC=https://sepolia.base.org
ETHERSCAN_API_KEY=your_etherscan_api_key
BASESCAN_API_KEY=your_basescan_api_key
```

## Compilation

```bash
npm run compile
```

The compiler is configured for Solidity 0.8.20 with the optimizer enabled (200 runs) and IR-based code generation (`viaIR: true`).

## Deployment

### Local (Hardhat network)

No credentials are required. Deploys to an in-process Hardhat node:

```bash
npm run deploy:testnet
```

Addresses are saved to `deployment-addresses.json`.

### Testnets

Obtain testnet ETH from a faucet before deploying:

- **Sepolia** -- https://sepoliafaucet.com/
- **Base Sepolia** -- https://www.coinbase.com/faucets/base-ethereum-goerli-faucet

```bash
npm run deploy:sepolia
npm run deploy:base-sepolia
```

### Mainnet

```bash
npm run deploy:ethereum
npm run deploy:base
```

### Post-deployment: Set Verifying Key

After deploying, configure the Groth16 verifying key so that on-chain proof verification is active:

```bash
GROTH16_VERIFIER_ADDRESS=<address> npm run set-verifying-key -- --network <network>
```

Without a verifying key the `VerifierContract` falls back to placeholder verification, which accepts any non-empty proof. This mode is intended for development only.

## Testing

```bash
# Run all tests
npm test

# Run a specific test file
npx hardhat test test/VerifierContract.test.js
npx hardhat test test/Groth16Verifier.test.js
npx hardhat test test/DepositContract.test.js
npx hardhat test test/WithdrawalContract.test.js

# Coverage report
npm run test:coverage
```

Test suites cover:

- Deposit flows (ERC-20 and native ETH)
- Asset registration and access control
- Block proof submission and state root transitions
- Groth16 proof verification with real and placeholder keys
- Withdrawal with Merkle inclusion and nullifier checks
- On-chain end-to-end verification

## Contract Addresses

### Local Hardhat (chain ID 31337)

| Contract | Address |
|---|---|
| DepositContract | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| Groth16Verifier | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| VerifierContract | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| WithdrawalContract | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |

For testnet and mainnet addresses, see the `deployments-{chainId}.json` files generated after deployment.

## Supported Networks

| Network | Chain ID |
|---|---|
| Ethereum Mainnet | 1 |
| Sepolia (Ethereum testnet) | 11155111 |
| Base | 8453 |
| Base Sepolia (Base testnet) | 84532 |
| Hardhat (local) | 31337 |

## Security Considerations

- **Sequencer access control** -- Only the designated sequencer address can submit block proofs via `submitBlockProof`. The sequencer address is set at deployment and can be rotated by the current sequencer.
- **Nullifier tracking** -- Each withdrawal nullifier is recorded on-chain to prevent double-spending. `WithdrawalContract` marks nullifiers as used through `VerifierContract.markNullifierUsed`.
- **Replay protection** -- Block IDs are tracked in `processedBlocks` to ensure each block proof is accepted at most once.
- **Reentrancy guards** -- Critical state-changing functions use OpenZeppelin's `ReentrancyGuard`.
- **Placeholder verification** -- If the Groth16 verifying key is not configured, the system falls back to a placeholder verifier that accepts any non-empty proof. This must never be used in production.
- **Proof format** -- Groth16 proofs are 256 bytes (A: 64 bytes G1, B: 128 bytes G2, C: 64 bytes G1) with 24 public input field elements (3 roots decomposed into 8 little-endian `u32` values each).
- **Owner privileges** -- The contract owner can register assets, set the Groth16 verifier address, and withdraw funds from `DepositContract`. Ownership should be transferred to a multisig or governance contract before mainnet launch.

## License

MIT
