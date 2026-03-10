import { ethers } from 'ethers'
import { config } from 'dotenv'
config()

const PRIVATE_KEY = process.env.PRIVATE_KEY
const CHAINS = [
  {
    name: 'Base Sepolia',
    rpc: 'https://sepolia.base.org',
    contract: '0x807d220AC80c59aC9F8C6C3d86211F04D80b9c53',
  },
  {
    name: 'Ethereum Sepolia',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    contract: '0x4E059D94012d494fBcFfC89C2E6ee4Ea853cA92F',
  },
]

const AMOUNT = ethers.parseEther('0.002')

async function main() {
  const wallet = new ethers.Wallet(PRIVATE_KEY)
  console.log(`Wallet: ${wallet.address}`)

  for (const chain of CHAINS) {
    console.log(`\n--- ${chain.name} ---`)
    const provider = new ethers.JsonRpcProvider(chain.rpc)
    const signer = wallet.connect(provider)

    const balance = await provider.getBalance(wallet.address)
    console.log(`Balance: ${ethers.formatEther(balance)} ETH`)

    if (balance < AMOUNT) {
      console.log(`Insufficient balance, skipping`)
      continue
    }

    const contract = new ethers.Contract(
      chain.contract,
      ['function depositNative(uint256 assetId) external payable'],
      signer
    )

    console.log(`Depositing ${ethers.formatEther(AMOUNT)} ETH...`)
    const tx = await contract.depositNative(1, { value: AMOUNT })
    console.log(`Tx: ${tx.hash}`)
    const receipt = await tx.wait()
    console.log(`Confirmed in block ${receipt.blockNumber}`)
  }

  console.log('\nDone!')
}

main().catch(console.error)
