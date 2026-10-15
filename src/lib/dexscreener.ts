const API = 'https://api.dexscreener.com'

export interface DexPair {
  chainId: string
  dexId: string
  url: string
  pairAddress: string
  labels?: string[]
  baseToken: { address: string; name: string; symbol: string }
  quoteToken: { address: string; name: string; symbol: string }
  priceNative: string
  priceUsd?: string
  txns?: Record<'m5' | 'h1' | 'h6' | 'h24', { buys: number; sells: number }>
  volume?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>
  priceChange?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>
  liquidity?: { usd?: number; base: number; quote: number }
  fdv?: number
  marketCap?: number
  pairCreatedAt?: number
  info?: {
    imageUrl?: string
    header?: string
    websites?: { url: string; label: string }[]
    socials?: { url: string; type: string }[]
  }
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

const isTokenAddress = (q: string) => EVM_ADDRESS.test(q) || BASE58_ADDRESS.test(q)

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(API + path, { signal })
  if (!res.ok) throw new Error(`DexScreener responded ${res.status}`)
  return res.json()
}

const byLiquidity = (a: DexPair, b: DexPair) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)

/** Pairs matching a symbol, name or address, most liquid first. `chain` narrows results ('' = any). */
export async function searchPairs(query: string, chain: string, signal?: AbortSignal): Promise<DexPair[]> {
  const q = query.trim()
  if (!q) return []
  const data = await getJson<{ pairs: DexPair[] | null }>(`/latest/dex/search?q=${encodeURIComponent(q)}`, signal)
  const pairs = data.pairs ?? []
  return (chain ? pairs.filter((p) => p.chainId === chain) : pairs).sort(byLiquidity)
}

/** All pairs for up to 30 tokens on one chain, in a single request. */
export async function getPairsForTokens(chain: string, addresses: string[], signal?: AbortSignal): Promise<DexPair[]> {
  const chunks: string[][] = []
  for (let i = 0; i < addresses.length; i += 30) chunks.push(addresses.slice(i, i + 30))
  const results = await Promise.all(chunks.map((c) => getJson<DexPair[]>(`/tokens/v1/${chain}/${c.join(',')}`, signal)))
  return results.flat()
}

/** One exact pair, as picked from search results. */
export async function getPair(chain: string, pairAddress: string, signal?: AbortSignal): Promise<DexPair | null> {
  const data = await getJson<{ pairs: DexPair[] | null; pair?: DexPair | null }>(
    `/latest/dex/pairs/${chain}/${pairAddress}`,
    signal,
  )
  return data.pairs?.[0] ?? data.pair ?? null
}

/**
 * Resolve the pair a block should show. A pair picked from search (`pairAddress`) wins;
 * otherwise the token address or free-text `query` resolves to its most liquid pair.
 * `chain` narrows results to one chain ('' = any).
 */
export async function findPair(
  query: string,
  chain: string,
  pairAddress = '',
  signal?: AbortSignal,
): Promise<DexPair | null> {
  if (pairAddress && chain) {
    const pair = await getPair(chain, pairAddress, signal)
    if (pair) return pair
  }

  const q = query.trim()
  if (!q) return null

  let pairs: DexPair[] = []
  if (isTokenAddress(q)) {
    const data = await getJson<{ pairs: DexPair[] | null }>(`/latest/dex/tokens/${q}`, signal)
    pairs = data.pairs ?? []
  }
  if (pairs.length === 0) {
    const data = await getJson<{ pairs: DexPair[] | null }>(
      `/latest/dex/search?q=${encodeURIComponent(q)}`,
      signal,
    )
    pairs = data.pairs ?? []
  }

  let filtered = chain ? pairs.filter((p) => p.chainId === chain) : pairs
  // For an address query, prefer pairs where it is the base token (e.g. SOL/USDC over BONK/SOL).
  const asBase = filtered.filter((p) => p.baseToken.address.toLowerCase() === q.toLowerCase())
  if (asBase.length) filtered = asBase
  return filtered.sort(byLiquidity)[0] ?? null
}

export const CHAINS = [
  { value: '', label: 'Any chain' },
  { value: 'solana', label: 'Solana' },
  { value: 'ethereum', label: 'Ethereum' },
  { value: 'base', label: 'Base' },
  { value: 'bsc', label: 'BNB Chain' },
  { value: 'arbitrum', label: 'Arbitrum' },
  { value: 'polygon', label: 'Polygon' },
  { value: 'avalanche', label: 'Avalanche' },
  { value: 'sui', label: 'Sui' },
  { value: 'ton', label: 'TON' },
]
