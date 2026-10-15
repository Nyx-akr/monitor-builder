import { getPairsForTokens, type DexPair } from './dexscreener'

export type ListSource = 'popular' | 'trending' | 'boosted' | 'new'

export const LIST_SOURCES: { value: ListSource; label: string; help: string }[] = [
  { value: 'popular', label: 'Popular', help: 'Major tokens' },
  { value: 'trending', label: 'Trending', help: 'Most boosted on DexScreener' },
  { value: 'boosted', label: 'Boosted', help: 'Latest boosted tokens' },
  { value: 'new', label: 'New', help: 'Latest token profiles' },
]

type TokenRef = { chainId: string; tokenAddress: string }

const POPULAR: TokenRef[] = [
  ['solana', 'So11111111111111111111111111111111111111112'],
  ['solana', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'],
  ['solana', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'],
  ['solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'],
  ['ethereum', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
  ['ethereum', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'],
  ['ethereum', '0x6982508145454Ce325dDbE47a25d4ec3d2311933'],
  ['ethereum', '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE'],
  ['ethereum', '0x514910771AF9Ca656af840dff83E8264EcF986CA'],
  ['bsc', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'],
  ['base', '0x532f27101965dd16442E59d40670FaF5eBB142E4'],
  ['base', '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed'],
].map(([chainId, tokenAddress]) => ({ chainId, tokenAddress }))

const ENDPOINTS: Record<Exclude<ListSource, 'popular'>, string> = {
  trending: '/token-boosts/top/v1',
  boosted: '/token-boosts/latest/v1',
  new: '/token-profiles/latest/v1',
}

const CACHE_MS = 60_000
const cache = new Map<ListSource, { at: number; pairs: Promise<DexPair[]> }>()

async function loadRefs(source: ListSource, signal?: AbortSignal): Promise<TokenRef[]> {
  if (source === 'popular') return POPULAR
  const res = await fetch('https://api.dexscreener.com' + ENDPOINTS[source], { signal })
  if (!res.ok) throw new Error(`DexScreener responded ${res.status}`)
  const refs: TokenRef[] = await res.json()
  // Boost lists repeat a token once per boost; keep the first.
  const seen = new Set<string>()
  return refs.filter((r) => {
    const k = `${r.chainId}:${r.tokenAddress}`
    return seen.has(k) ? false : (seen.add(k), true)
  })
}

/** One pair per token (its most liquid), with live price data, in the list's original order. */
async function load(source: ListSource): Promise<DexPair[]> {
  const refs = await loadRefs(source)
  const byChain = new Map<string, string[]>()
  refs.forEach((r) => byChain.set(r.chainId, [...(byChain.get(r.chainId) ?? []), r.tokenAddress]))

  const pairs = (await Promise.all([...byChain].map(([chain, addrs]) => getPairsForTokens(chain, addrs)))).flat()

  const best = new Map<string, DexPair>()
  for (const p of pairs) {
    const k = `${p.chainId}:${p.baseToken.address.toLowerCase()}`
    const prev = best.get(k)
    if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) best.set(k, p)
  }
  return refs
    .map((r) => best.get(`${r.chainId}:${r.tokenAddress.toLowerCase()}`))
    .filter((p): p is DexPair => Boolean(p))
}

/** Cached for a minute so reopening the dropdown is instant. */
export function getTokenList(source: ListSource): Promise<DexPair[]> {
  const hit = cache.get(source)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.pairs
  const pairs = load(source)
  cache.set(source, { at: Date.now(), pairs })
  pairs.catch(() => cache.delete(source))
  return pairs
}
