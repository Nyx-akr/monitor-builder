/**
 * The Feed's sources, shared by the server (which fetches each on its own timer, see server/collector.ts)
 * and the Feed block (which shows the ones you tick and sets the timers).
 *
 * Default timers come from each API's documentation:
 * - GeckoTerminal (free): 10 calls/min in total — lists *and* candles; data updates every 60 s; at most 10
 *   pages of 20. The three lists together use ≈4 calls/min by default, leaving the rest for candles.
 * - DexScreener: 60 requests/min per list endpoint, 300/min for token lookups; lists change live.
 * - CoinGecko (keyless / demo key): roughly 10–30 calls/min; markets update every 60 s, trending every 10 min.
 */
export type Api = 'gt' | 'ds' | 'cg' | 'jup' | 'llama' | 'goplus' | 'honeypot' | 'none'

export interface FeedSource {
  key: string
  /** 'list' = a token list the Feed can show; 'enrich' = adds values to stored tokens in the background. */
  kind?: 'list' | 'enrich'
  label: string
  short: string
  api: Api
  /** Seconds between fetches (0 = off). */
  every: number
  /** Pages per fetch, for paged lists. */
  pages?: number
  maxPages?: number
  /** Tokens per page (for the panel's help). */
  perPage?: number
  /** What "pages" means in the panel (default: pages of `perPage` tokens). */
  pagesLabel?: string
  /** API calls one fetch makes: pages × networks, a list + its token lookups… `n` = tokens it covers now. */
  calls: (pages: number, n: number) => number
  note: string
}

export const FEED_SOURCES: FeedSource[] = [
  { key: 'gtTrending', label: 'GeckoTerminal · Trending pools', short: 'GT trending', api: 'gt', every: 120, pages: 3, maxPages: 10, perPage: 20, calls: (p) => p, note: 'All chains. Updates every 60 s.' },
  { key: 'gtNew', label: 'GeckoTerminal · New pools', short: 'GT new', api: 'gt', every: 180, pages: 2, maxPages: 10, perPage: 20, calls: (p) => p, note: 'Just launched, all chains. Updates every 60 s.' },
  { key: 'gtTop', label: 'GeckoTerminal · Top pools by volume', short: 'GT top', api: 'gt', every: 600, pages: 1, maxPages: 10, perPage: 20, calls: (p) => p * 4, note: 'Solana, Base, BNB and Ethereum — 4 calls per page.' },
  { key: 'dsTrending', label: 'DexScreener · Trending (most boosted)', short: 'DS trending', api: 'ds', every: 60, calls: () => 3, note: '≈30 tokens.' },
  { key: 'dsBoosted', label: 'DexScreener · Latest boosts', short: 'DS boosts', api: 'ds', every: 30, calls: () => 3, note: '≈30 tokens, changes live.' },
  { key: 'dsProfiles', label: 'DexScreener · New token profiles', short: 'DS profiles', api: 'ds', every: 30, calls: () => 3, note: '≈30 tokens, changes live.' },
  { key: 'dsTakeovers', label: 'DexScreener · Community takeovers', short: 'DS CTO', api: 'ds', every: 60, calls: () => 2, note: 'A few tokens.' },
  { key: 'dsAds', label: 'DexScreener · Advertised', short: 'DS ads', api: 'ds', every: 60, calls: () => 3, note: '≈30 tokens.' },
  { key: 'popular', label: 'Majors & blue-chip memes', short: 'Popular', api: 'ds', every: 30, calls: () => 4, note: 'A short fixed list, via DexScreener.' },
  { key: 'cgTop', label: 'CoinGecko · Top by market cap', short: 'CG top', api: 'cg', every: 120, pages: 2, maxPages: 4, perPage: 250, calls: (p) => p, note: 'Not per chain. Updates every 60 s.' },
  { key: 'cgTrending', label: 'CoinGecko · Trending searches', short: 'CG trending', api: 'cg', every: 600, calls: () => 2, note: '≈15 coins. Updates every 10 min.' },

  // Enrichment: values added to every stored token (and its history), in the background.
  { key: 'enrichJupiter', kind: 'enrich', label: 'Jupiter · organic score, holders, top-10 (Solana)', short: 'Jupiter', api: 'jup', every: 300, calls: (_p, n) => Math.ceil(n / 100), note: '100 tokens per call, every Solana token.' },
  { key: 'enrichLlama', kind: 'enrich', label: 'DefiLlama · reference price', short: 'DefiLlama', api: 'llama', every: 300, calls: (_p, n) => Math.ceil(n / 50), note: '50 tokens per call, every token.' },
  { key: 'enrichGoplus', kind: 'enrich', label: 'GoPlus · holders, top-10, taxes', short: 'GoPlus', api: 'goplus', every: 60, pages: 10, maxPages: 30, pagesLabel: 'tokens per run', calls: (p) => p, note: 'One call per token: each is re-checked every 6 h, oldest first.' },
  { key: 'enrichHoneypot', kind: 'enrich', label: 'honeypot.is · sell simulation (Ethereum, BNB, Base)', short: 'honeypot.is', api: 'honeypot', every: 60, pages: 5, maxPages: 20, pagesLabel: 'tokens per run', calls: (p) => p, note: 'One call per token: each is re-checked daily, oldest first.' },
  { key: 'tradeTape', kind: 'enrich', label: 'Trade tape · pools on every chain, wallet by wallet', short: 'Trade tape', api: 'gt', every: 60, pages: 4, maxPages: 8, pagesLabel: 'pools per run', calls: (p) => p, note: 'The rotation engine’s raw material: each pool’s last 300 trades (wallet, buy/sell, $), kept 6 h, one file per chain. Chains: Solana, Base, BNB, Ethereum (TAPE_CHAINS in .env) plus your watchlist’s; each chain’s tracked pools, then its 10 most-traded, chains taking turns.' },
  { key: 'sellCheck', kind: 'enrich', label: 'Sell check · Jupiter sell route (Solana)', short: 'Sell check', api: 'jup', every: 60, pages: 5, maxPages: 20, pagesLabel: 'tokens per run', calls: (p) => p, note: 'Quotes a $100 sell of each Solana tape token (each every 30 min): the “sellable” gate where honeypot.is can’t reach.' },
  { key: 'smartLearn', kind: 'enrich', label: 'Smart wallets · learned from the tape', short: 'Smart', api: 'none', every: 600, calls: () => 0, note: 'No API calls: judges each $20+ buy once its 6 h are over (+10% before −7% wins); 3+ buys on 2+ tokens winning 40%+ makes a wallet smart.' },
  { key: 'grading', kind: 'enrich', label: 'Evaluation · grades every call', short: 'Grading', api: 'none', every: 600, calls: () => 0, note: 'No API calls: each BUY / SELL’s return after 1 h, 6 h, 24 h, and its trade plan’s outcome, from the stored prices.' },
  { key: 'rotation', kind: 'enrich', label: 'Rotation engine · scores and calls (every chain)', short: 'Rotation', api: 'none', every: 60, calls: () => 0, note: 'No API calls: worked out from the trade tape, the stored history and the enrichment. Vibe-MM’s rotation engines, a call per token.' },
  { key: 'tracked', kind: 'enrich', label: 'Full details · watchlist and selected token', short: 'Tracked', api: 'none', every: 120, calls: () => 0, note: 'Quotes, Jupiter, GoPlus, DefiLlama for the tokens you watch; their trade analysis reads the trade tape (no GeckoTerminal calls).' },
]

export const isList = (s: FeedSource) => (s.kind ?? 'list') === 'list'

export const API_NAMES: Record<Api, string> = { gt: 'GeckoTerminal', ds: 'DexScreener', cg: 'CoinGecko', jup: 'Jupiter', llama: 'DefiLlama', goplus: 'GoPlus', honeypot: 'honeypot.is', none: 'No API' }

/**
 * Per-minute limits the timers are planned against. GeckoTerminal (10, for everything it does), DexScreener
 * and CoinGecko are documented; Jupiter's lite API, DefiLlama, GoPlus and honeypot.is publish no free limit,
 * so these are cautious assumptions.
 */
export const API_LIMITS: Record<Api, number> = { gt: 10, ds: 60, cg: 10, jup: 30, llama: 30, goplus: 20, honeypot: 10, none: Infinity }

export const feedSource = (key: string) => FEED_SOURCES.find((s) => s.key === key)
