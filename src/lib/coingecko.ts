/**
 * CoinGecko API client (https://docs.coingecko.com/v3.0.1/reference/introduction).
 *
 * Works without a key, but the keyless tier allows only a few requests per minute per IP.
 * A free Demo key (30 req/min, 10k/month) can be set via VITE_COINGECKO_KEY in .env.local
 * or at runtime with setCoinGeckoKey(). Responses are cached and in-flight requests deduped.
 */

const API = 'https://api.coingecko.com/api/v3'
const KEY_STORAGE = 'dex-builder:coingecko-key'

let apiKey: string = (() => {
  try {
    return localStorage.getItem(KEY_STORAGE) || import.meta.env.VITE_COINGECKO_KEY || ''
  } catch {
    return import.meta.env.VITE_COINGECKO_KEY || ''
  }
})()

export function setCoinGeckoKey(key: string) {
  apiKey = key.trim()
  try {
    if (apiKey) localStorage.setItem(KEY_STORAGE, apiKey)
    else localStorage.removeItem(KEY_STORAGE)
  } catch {
    /* key still applies for this session */
  }
  cache.clear()
}

export const hasCoinGeckoKey = () => Boolean(apiKey)

export class RateLimitError extends Error {
  constructor(public retryAfterSec: number) {
    super(`CoinGecko rate limit hit — try again in ~${retryAfterSec}s${apiKey ? '' : ' (a free Demo API key raises the limit)'}`)
    this.name = 'RateLimitError'
  }
}

const cache = new Map<string, { at: number; ttl: number; data: Promise<unknown> }>()

const PERSIST_PREFIX = 'dex-builder:cg:'

/** Keyless CoinGecko blocks bursts, and retrying while blocked extends the block — so requests are spaced out. */
const MIN_GAP_MS = 2500
let nextSlot = 0

/** After a 429, every CoinGecko call fails fast until this time instead of hitting the API again. */
let blockedUntil = 0

const waitForSlot = async () => {
  const now = Date.now()
  const at = Math.max(now, nextSlot)
  nextSlot = at + MIN_GAP_MS
  if (at > now) await new Promise((r) => setTimeout(r, at - now))
}

const blockedError = () => new RateLimitError(Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000)))

const buildUrl = (path: string, params: Record<string, string | number | boolean | undefined>) => {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
  return `${API}${path}${qs.size ? `?${qs}` : ''}`
}

/**
 * A cached response (memory, then localStorage) younger than `ttlMs`, or undefined. Never hits the network.
 * `remember: false` peeks without promoting a lenient-ttl hit into the memory cache.
 */
function cached<T>(url: string, ttlMs: number, persist: boolean, remember = true): Promise<T> | undefined {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data as Promise<T>
  if (!persist) return undefined
  try {
    const saved = JSON.parse(localStorage.getItem(PERSIST_PREFIX + url) || 'null') as { at: number; data: T } | null
    if (saved && Date.now() - saved.at < ttlMs) {
      const data = Promise.resolve(saved.data)
      if (remember) cache.set(url, { at: saved.at, ttl: ttlMs, data })
      return data
    }
  } catch {
    /* not cached */
  }
  return undefined
}

/**
 * GET with an in-memory cache. With `persist`, the response is also kept in localStorage for `ttlMs`,
 * so reloading the page within that window costs no request at all.
 */
async function request<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  ttlMs: number,
  persist = false,
): Promise<T> {
  const url = buildUrl(path, params)
  const hit = cached<T>(url, ttlMs, persist)
  if (hit) return hit
  if (Date.now() < blockedUntil) throw blockedError()

  const data = (async () => {
    await waitForSlot()
    if (Date.now() < blockedUntil) throw blockedError()
    let res: Response
    try {
      res = await fetch(url, { headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : undefined })
    } catch {
      // CoinGecko's 429 responses carry no CORS headers, so the browser reports them as a network error.
      blockedUntil = Date.now() + 60_000
      throw blockedError()
    }
    if (res.status === 429) {
      blockedUntil = Date.now() + (Number(res.headers.get('retry-after')) || 60) * 1000
      throw blockedError()
    }
    if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`)
    return res.json() as Promise<T>
  })()
  cache.set(url, { at: Date.now(), ttl: ttlMs, data })
  data.then(
    (d) => {
      if (!persist) return
      try {
        localStorage.setItem(PERSIST_PREFIX + url, JSON.stringify({ at: Date.now(), data: d }))
      } catch {
        /* quota exceeded or storage blocked — the in-memory cache still applies */
      }
    },
    () => cache.delete(url),
  )
  return data
}

const MIN = 60_000

// ---------- Types ----------

export interface CoinListItem {
  id: string
  symbol: string
  name: string
  /** Contract address per chain, e.g. { ethereum: '0x…', solana: '…' } */
  platforms?: Record<string, string>
}

export interface CoinMarket {
  id: string
  symbol: string
  name: string
  image: string
  current_price: number | null
  market_cap: number | null
  market_cap_rank: number | null
  fully_diluted_valuation: number | null
  total_volume: number | null
  high_24h: number | null
  low_24h: number | null
  price_change_24h: number | null
  price_change_percentage_24h: number | null
  market_cap_change_percentage_24h: number | null
  circulating_supply: number | null
  total_supply: number | null
  max_supply: number | null
  ath: number | null
  ath_change_percentage: number | null
  ath_date: string | null
  atl: number | null
  atl_date: string | null
  last_updated: string
  sparkline_in_7d?: { price: number[] }
  price_change_percentage_1h_in_currency?: number | null
  price_change_percentage_24h_in_currency?: number | null
  price_change_percentage_7d_in_currency?: number | null
  price_change_percentage_30d_in_currency?: number | null
  price_change_percentage_1y_in_currency?: number | null
}

export interface SearchCoin {
  id: string
  name: string
  symbol: string
  market_cap_rank: number | null
  thumb: string
  large: string
}

export interface TrendingCoin {
  id: string
  coin_id: number
  name: string
  symbol: string
  market_cap_rank: number | null
  thumb: string
  small: string
  large: string
  score: number
  data: {
    price: number
    price_change_percentage_24h: Record<string, number>
    market_cap: string
    total_volume: string
    /** URL of a 7-day sparkline SVG */
    sparkline: string
  }
}

export interface CoinDetail {
  id: string
  symbol: string
  name: string
  categories: string[]
  description: { en: string }
  image: { thumb: string; small: string; large: string }
  genesis_date: string | null
  market_cap_rank: number | null
  platforms: Record<string, string>
  links: {
    homepage: string[]
    whitepaper?: string
    blockchain_site: string[]
    twitter_screen_name: string
    telegram_channel_identifier: string
    subreddit_url: string
    repos_url: { github: string[] }
  }
  sentiment_votes_up_percentage: number | null
  watchlist_portfolio_users?: number
  market_data: {
    current_price: Record<string, number>
    market_cap: Record<string, number>
    fully_diluted_valuation: Record<string, number>
    total_volume: Record<string, number>
    high_24h: Record<string, number>
    low_24h: Record<string, number>
    ath: Record<string, number>
    ath_date: Record<string, string>
    ath_change_percentage: Record<string, number>
    atl: Record<string, number>
    atl_date: Record<string, string>
    atl_change_percentage: Record<string, number>
    price_change_percentage_24h: number
    price_change_percentage_7d: number
    price_change_percentage_14d: number
    price_change_percentage_30d: number
    price_change_percentage_60d: number
    price_change_percentage_200d: number
    price_change_percentage_1y: number
    circulating_supply: number
    total_supply: number | null
    max_supply: number | null
    sparkline_7d?: { price: number[] }
    last_updated: string
  }
}

/** [timestamp ms, value] */
export type Point = [number, number]

export interface MarketChart {
  prices: Point[]
  market_caps: Point[]
  total_volumes: Point[]
}

/** [timestamp ms, open, high, low, close] */
export type Candle = [number, number, number, number, number]

export interface GlobalData {
  active_cryptocurrencies: number
  markets: number
  total_market_cap: Record<string, number>
  total_volume: Record<string, number>
  market_cap_percentage: Record<string, number>
  market_cap_change_percentage_24h_usd: number
  updated_at: number
}

export interface Category {
  id: string
  name: string
  market_cap: number | null
  market_cap_change_24h: number | null
  volume_24h: number | null
  top_3_coins: string[]
}

// ---------- Fetchers ----------

const ALL_COINS_STORAGE = 'dex-builder:coingecko-all-coins'
const DAY = 24 * 60 * MIN

/**
 * Every coin CoinGecko tracks (~22k). Without platforms (~1.5MB) it is also kept in localStorage
 * for a day, so the full list costs one request per day rather than one per page load.
 */
export async function listAllCoins(includePlatform = false): Promise<CoinListItem[]> {
  if (includePlatform) return request<CoinListItem[]>('/coins/list', { include_platform: true }, 60 * MIN)
  try {
    const saved = JSON.parse(localStorage.getItem(ALL_COINS_STORAGE) || 'null') as { at: number; coins: CoinListItem[] } | null
    if (saved && Date.now() - saved.at < DAY) return saved.coins
  } catch {
    /* fall through to the network */
  }
  const coins = await request<CoinListItem[]>('/coins/list', {}, 60 * MIN)
  try {
    localStorage.setItem(ALL_COINS_STORAGE, JSON.stringify({ at: Date.now(), coins }))
  } catch {
    /* quota exceeded or storage blocked — the in-memory cache still applies */
  }
  return coins
}

/** Ranked market data, up to 250 coins per page (CoinGecko's max). Optionally filter by category or specific ids. */
type MarketsOpts = { page?: number; perPage?: number; vsCurrency?: string; category?: string; ids?: string[]; sparkline?: boolean }

const marketsParams = (opts: MarketsOpts) => ({
  vs_currency: opts.vsCurrency ?? 'usd',
  order: 'market_cap_desc',
  per_page: opts.perPage ?? 100,
  page: opts.page ?? 1,
  category: opts.category,
  ids: opts.ids?.join(','),
  sparkline: opts.sparkline ?? false,
  price_change_percentage: '1h,24h,7d,30d,1y',
})

export const getMarkets = (opts: MarketsOpts = {}) => request<CoinMarket[]>('/coins/markets', marketsParams(opts), 10 * MIN, true)

/** Search coins by name or symbol. Results are kept for a day — a symbol's matches rarely change. */
export const searchCoins = (query: string) =>
  request<{ coins: SearchCoin[] }>('/search', { query: query.trim().toLowerCase() }, 24 * 60 * MIN, true).then((r) => r.coins)

/**
 * Best coin for a token string: exact id, then exact symbol (highest ranked), then the top search hit.
 * Checks the saved Top 250 first (any age — ids don't change), so common tokens cost no request at all.
 */
export async function resolveCoin(token: string): Promise<SearchCoin | null> {
  const q = token.trim().toLowerCase()
  const top = await cached<CoinMarket[]>(buildUrl('/coins/markets', marketsParams({ perPage: 250 })), 7 * 24 * 60 * MIN, true, false)
  const known = top?.find((c) => c.id === q) ?? top?.find((c) => c.symbol.toLowerCase() === q)
  if (known) {
    return { id: known.id, name: known.name, symbol: known.symbol, market_cap_rank: known.market_cap_rank, thumb: known.image, large: known.image }
  }
  const coins = await searchCoins(q)
  return coins.find((c) => c.id === q) ?? coins.find((c) => c.symbol.toLowerCase() === q) ?? coins[0] ?? null
}

/** Top 15 trending coins on CoinGecko in the last 24h. */
export const getTrending = () =>
  request<{ coins: { item: TrendingCoin }[] }>('/search/trending', {}, 5 * MIN, true).then((r) => r.coins.map((c) => c.item))

/** Full profile: description, links, categories, contract addresses and detailed market data. */
export const getCoin = (id: string) =>
  request<CoinDetail>(
    `/coins/${id}`,
    { localization: false, tickers: false, community_data: false, developer_data: false, sparkline: true },
    MIN,
    true,
  )

/**
 * Look up a coin by its contract address — bridges DexScreener tokens to CoinGecko.
 * `platform` is CoinGecko's chain id, e.g. 'ethereum', 'solana', 'base', 'binance-smart-chain'.
 */
export const getCoinByContract = (platform: string, address: string) =>
  request<CoinDetail>(`/coins/${platform}/contract/${address}`, {}, MIN)

/** Simple price lookup for many coins at once. */
export const getSimplePrices = (ids: string[], vsCurrencies = ['usd']) =>
  request<Record<string, Record<string, number>>>(
    '/simple/price',
    { ids: ids.join(','), vs_currencies: vsCurrencies.join(','), include_24hr_change: true, include_market_cap: true, include_24hr_vol: true },
    MIN,
  )

/** Price / market cap / volume history. days: 1 → 5-min points, 2–90 → hourly, >90 → daily. Keyless max 365. */
export const getMarketChart = (id: string, days: number | 'max' = 7, vsCurrency = 'usd') =>
  request<MarketChart>(`/coins/${id}/market_chart`, { vs_currency: vsCurrency, days }, 5 * MIN)

/** OHLC candles. days: 1, 7, 14, 30, 90, 180, 365. */
export const getOhlc = (id: string, days: 1 | 7 | 14 | 30 | 90 | 180 | 365 = 7, vsCurrency = 'usd') =>
  request<Candle[]>(`/coins/${id}/ohlc`, { vs_currency: vsCurrency, days }, 5 * MIN)

/** Whole-market stats: total market cap, volume, BTC/ETH dominance. */
export const getGlobal = () => request<{ data: GlobalData }>('/global', {}, 5 * MIN).then((r) => r.data)

/** Sectors (Meme, AI, DeFi, Layer 1…) with market cap and 24h change. */
export const getCategories = () => request<Category[]>('/coins/categories', {}, 10 * MIN)

/** DexScreener chain id → CoinGecko platform id, for getCoinByContract. */
export const DEX_TO_GECKO_PLATFORM: Record<string, string> = {
  ethereum: 'ethereum',
  solana: 'solana',
  base: 'base',
  bsc: 'binance-smart-chain',
  arbitrum: 'arbitrum-one',
  polygon: 'polygon-pos',
  avalanche: 'avalanche',
  sui: 'sui',
  ton: 'the-open-network',
}
