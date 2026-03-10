/**
 * Setup AxyncVault Contracts for MVP
 *
 * This script:
 * 1. Sets withdrawalsRoot to a non-zero value on both vault contracts (required for merkle proof check)
 *
 * Note: Funding is no longer needed since deposits fund the vault directly.
 *
 * Run: node scripts/setup-withdrawal.mjs
 */

import { ethers } from 'ethers'
import { config } from 'dotenv'
import { readFileSync } from 'fs'
config()

const PRIVATE_KEY = process.env.PRIVATE_KEY
if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY not set in .env')
  process.exit(1)
}

// Load deployment addresses
let deployment
try {
  deployment = JSON.parse(readFileSync('deployment-mvp.json', 'utf8'))
} catch {
  console.error('deployment-mvp.json not found. Run deploy-mvp.js first!')
  process.exit(1)
}

const CONTRACTS = [
  {
    name: 'Ethereum Sepolia',
    rpc: process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com',
    vault: deployment.sepolia.vault,
  },
  {
    name: 'Base Sepolia',
    rpc: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
    vault: deployment.baseSepolia.vault,
  },
]

// Deterministic withdrawals root for MVP
const WITHDRAWALS_ROOT = ethers.keccak256(ethers.toUtf8Bytes('axync-mvp-withdrawals-root'))

const VAULT_ABI = [
  'function updateWithdrawalsRoot(bytes32 newWithdrawalsRoot) external',
  'function withdrawalsRoot() view returns (bytes32)',
  'function owner() view returns (address)',
]

async function setup() {
  console.log(`Withdrawals root to set: ${WITHDRAWALS_ROOT}\n`)

  for (const chain of CONTRACTS) {
    console.log(`\n=== ${chain.name} ===`)
    console.log(`Vault contract: ${chain.vault}`)

    const provider = new ethers.JsonRpcProvider(chain.rpc)
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider)
    console.log(`Wallet: ${wallet.address}`)

    const contract = new ethers.Contract(chain.vault, VAULT_ABI, wallet)

    // Check current root
    const currentRoot = await contract.withdrawalsRoot()
    console.log(`Current root: ${currentRoot}`)

    // Check owner
    const owner = await contract.owner()
    console.log(`Contract owner: ${owner}`)

    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error(`ERROR: Wallet is not the owner of this contract!`)
      continue
    }

    // Set withdrawals root
    if (currentRoot === ethers.ZeroHash || currentRoot !== WITHDRAWALS_ROOT) {
      console.log(`\nSetting withdrawalsRoot...`)
      const tx = await contract.updateWithdrawalsRoot(WITHDRAWALS_ROOT)
      console.log(`Tx sent: ${tx.hash}`)
      await tx.wait()
      console.log(`Root updated!`)
    } else {
      console.log(`Root already set correctly.`)
    }

    // Verify
    const finalRoot = await contract.withdrawalsRoot()
    const vaultBalance = await provider.getBalance(chain.vault)
    console.log(`\nFinal state:`)
    console.log(`  Root: ${finalRoot}`)
    console.log(`  Vault balance: ${ethers.formatEther(vaultBalance)} ETH`)
  }

  console.log(`\nSetup complete!`)
}

setup().catch(console.error)
