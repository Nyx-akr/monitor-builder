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
  // Always ask DexScreener — its responses would otherwise be reused from the browser's HTTP cache,
  // which hides how long a real answer takes and can show stale prices.
  const res = await fetch(API + path, { signal, cache: 'no-store' })
  if (!res.ok) throw new Error(`DexScreener responded ${res.status}`)
  return res.json()
}

const byLiquidity = (a: DexPair, b: DexPair) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)

/**
 * The real market for a token: most 24h volume first, liquidity as a tie-break. Liquidity alone is easy
 * to fake — copycat pairs claim $290M liquidity with zero trades, while the real BONK pair trades 13k times a day.
 */
export const byActivity = (a: DexPair, b: DexPair) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0) || byLiquidity(a, b)

/** Barely trading and barely any liquidity — too weak to accept on a loose (word / contains) match. */
const isDead = (p: DexPair) => (p.volume?.h24 ?? 0) < 1000 && (p.liquidity?.usd ?? 0) < 10_000

/** Pairs matching a symbol, name or address, best match then most traded first. `chain` narrows results ("" = any). */
/**
 * How well a pair matches what was typed, best first. DexScreener's search is fuzzy — it also matches
 * addresses and metadata, so "asdd" returns tokens with no "asdd" in their symbol or name at all.
 * Those get NO_MATCH and are dropped.
 */
const NO_MATCH = 99
function matchTier(p: DexPair, query: string): number {
  const q = query.trim().toLowerCase()
  const sym = p.baseToken.symbol.toLowerCase()
  const name = p.baseToken.name.toLowerCase()
  if (p.baseToken.address.toLowerCase() === q || p.pairAddress.toLowerCase() === q) return 0
  if (sym === q || sym === `$${q}`) return 1
  if (name === q) return 2
  if (sym.startsWith(q)) return 3
  if (name.startsWith(q) || name.split(/[\s_-]+/).some((w) => w.startsWith(q))) return 4
  if (sym.includes(q) || name.includes(q)) return 5
  return NO_MATCH
}

/** Best match first, then most traded — and only pairs that really match the query. */
function rank(pairs: DexPair[], query: string): DexPair[] {
  return (
    pairs
      .map((p) => ({ p, tier: matchTier(p, query) }))
      // Loose matches (word / contains) must at least be alive; exact and prefix matches are always kept.
      .filter((x) => x.tier !== NO_MATCH && !(x.tier >= 4 && isDead(x.p)))
      .sort((a, b) => a.tier - b.tier || byActivity(a.p, b.p))
      .map((x) => x.p)
  )
}

/** Pairs matching a symbol, name or address — best match, then most traded, first. `chain` narrows results ('' = any). */
export async function searchPairs(query: string, chain: string, signal?: AbortSignal): Promise<DexPair[]> {
  const q = query.trim()
  if (!q) return []
  const data = await getJson<{ pairs: DexPair[] | null }>(`/latest/dex/search?q=${encodeURIComponent(q)}`, signal)
  const pairs = data.pairs ?? []
  return rank(chain ? pairs.filter((p) => p.chainId === chain) : pairs, q)
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
 * otherwise the token address or free-text `query` resolves to its best-matching, most traded pair.
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

  const onChain = chain ? pairs.filter((p) => p.chainId === chain) : pairs
  if (isTokenAddress(q)) {
    // For an address, prefer pairs where it is the base token (e.g. SOL/USDC over BONK/SOL).
    const asBase = onChain.filter((p) => p.baseToken.address.toLowerCase() === q.toLowerCase())
    return (asBase.length ? asBase : onChain).sort(byActivity)[0] ?? null
  }
  // For text, only a real symbol/name match counts — otherwise it's "not found", not a random token.
  return rank(onChain, q)[0] ?? null
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
