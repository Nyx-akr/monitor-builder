/**
 * The chains the API cards know, and what each API calls them. DexScreener's chain ids (solana, ethereum,
 * bsc…) are the common names: a token row from a DexScreener card carries one, and every card maps it here.
 */
export interface Chain {
  id: string
  label: string
  /** EVM chain id (GoPlus, honeypot.is). Absent for Solana. */
  evmId?: number
  /** DefiLlama's chain key. */
  llama: string
  /** KyberSwap's chain path. */
  kyber?: string
  /** GeckoTerminal's network id. */
  gecko: string
  /** USDC on this chain (what KyberSwap quotes are paid in). */
  usdc?: { address: string; decimals: number }
}

export const CHAINS: Chain[] = [
  { id: 'solana', label: 'Solana', gecko: 'solana', llama: 'solana' },
  { id: 'ethereum', label: 'Ethereum', evmId: 1, gecko: 'eth', llama: 'ethereum', kyber: 'ethereum', usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 } },
  { id: 'bsc', label: 'BNB Chain', evmId: 56, gecko: 'bsc', llama: 'bsc', kyber: 'bsc', usdc: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 } },
  { id: 'base', label: 'Base', evmId: 8453, gecko: 'base', llama: 'base', kyber: 'base', usdc: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 } },
  { id: 'arbitrum', label: 'Arbitrum', evmId: 42161, gecko: 'arbitrum', llama: 'arbitrum', kyber: 'arbitrum', usdc: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 } },
  { id: 'polygon', label: 'Polygon', evmId: 137, gecko: 'polygon_pos', llama: 'polygon', kyber: 'polygon', usdc: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 } },
  { id: 'avalanche', label: 'Avalanche', evmId: 43114, gecko: 'avax', llama: 'avax', kyber: 'avalanche', usdc: { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 } },
  { id: 'optimism', label: 'Optimism', evmId: 10, gecko: 'optimism', llama: 'optimism', kyber: 'optimism', usdc: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 } },
]

export const chainById = (id: string) => CHAINS.find((c) => c.id === id)

/** A Solana mint (base58, 32–44 chars) or an EVM address (0x + 40 hex). */
export const isSolanaAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)
export const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

/** The chain an address belongs to, when it can tell (an EVM address could be on any EVM chain). */
export const guessChain = (address: string, fallback: string) => (isSolanaAddress(address) ? 'solana' : isEvmAddress(address) && fallback === 'solana' ? 'ethereum' : fallback)
