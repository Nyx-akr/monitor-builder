import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { CHAINS, chainById } from '../src/services/chains'
import { createCollector, type FetchContext, type SourceDef } from './collector'
import { createTape, type TapeTrade } from './tape'
import { DEFAULT_RULES, ENGINES, RULES, TIME_FRAMES, applyRules, evaluate, frameOf, resetRules, walletIndex, type Evaluation, type Sample } from './rotation'
import { createSmart, type PriceSeries } from './smart'
import { createCallLog } from './calls'
import { FEED_SOURCES } from '../src/core/feedSources'
import type { DetailSource, DetailsAnswer } from '../src/core/tokenDetails'
import { SAFETY_SOURCES, type CheckResult, type SafetySource, type SourceResult } from '../src/core/safetyChecks'

/**
 * The data engine. Every block's data comes from here — the browser never calls an API itself — so:
 * API keys stay on the server, there's no CORS, requests from all blocks are shared and cached, batched
 * (DexScreener: 30 tokens per call), queued and backed off on rate limits (GeckoTerminal), and the
 * metrics of every token that's being watched are **recorded once a minute** into data/history, so a
 * token's history is simply there.
 *
 *   GET /api/engine/search?q=…&chain=…           tokens matching a name / symbol / address
 *   GET /api/engine/market?ids=chain:addr,…      standard metrics for tokens (marks them as watched)
 *   GET /api/engine/feed?sources=a,b&chain=…&limit=…   the Feed's stored lists (see collector.ts), plus timers and storage
 *   GET /api/engine/feed/events                  live: an event each time a source has fetched
 *   POST /api/engine/feed/config                 each source's timer / pages, history retention
 *   GET /api/engine/candles?id=…&interval=…&limit=…[&pool=…]   OHLCV candles
 *   GET /api/engine/safety?id=…                  one safety report from GoPlus, RugCheck, honeypot.is
 *   GET /api/engine/history?id=…&metric=…&hours=…   a metric over time, from the recordings
 *   GET /api/engine/details?id=…[&pool=…]        every detail of a token, by source (see core/tokenDetails)
 */

// ---------- shared shapes (the app reads these; see src/core/values) ----------

interface Token {
  kind: 'token'
  id: string
  chain: string
  address: string
  symbol: string
  name: string
  logo?: string | null
  pool?: string | null
}
type Metrics = Record<string, number | null>
interface MarketRow {
  token: Token
  metrics: Metrics
  /** Text values (the rotation engine's phase, call and its reason). */
  tags?: Record<string, string>
  dex?: string
  url?: string
  at: number
  source: string
}

// ---------- plumbing ----------

async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, headers: { accept: 'application/json', ...(init.headers ?? {}) } })
    if (res.status === 429) throw new RateLimited(new URL(url).host)
    const body = (await res.json().catch(() => null)) as T & { status?: { error_code?: number } }
    if (body && (body as { status?: { error_code?: number } }).status?.error_code === 429) throw new RateLimited(new URL(url).host)
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
    return body
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`${new URL(url).host} didn't answer in time`)
    if ((e as Error).message === 'fetch failed') throw new Error(`couldn't reach ${new URL(url).host}`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

class RateLimited extends Error {
  constructor(host: string) {
    super(`${host} rate limit hit — trying again shortly`)
  }
}

/** A tiny cache: the same request within `ttl` gets the same answer (and requests in flight are shared). */
const cache = new Map<string, { at: number; value: Promise<unknown> }>()
function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>
  const value = load()
  cache.set(key, { at: Date.now(), value })
  value.catch(() => cache.delete(key))
  return value
}

/**
 * One request at a time to a rate-limited API, a gap apart. The gap adapts: a rate-limit answer pauses the
 * queue (`backoffMs`), retries once, and doubles the gap (up to a minute); each success shrinks it back
 * toward the documented pace. So the queue settles at whatever the API really allows right now.
 */
function makeQueue(gapMs: number | (() => number), backoffMs: number) {
  let queue: Promise<unknown> = Promise.resolve()
  let pausedUntil = 0
  const base = () => (typeof gapMs === 'function' ? gapMs() : gapMs)
  let gap = base()
  return function run<T>(job: () => Promise<T>): Promise<T> {
    const attempt = async (retry: boolean): Promise<T> => {
      const wait = pausedUntil - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      try {
        const out = await job()
        gap = Math.max(base(), gap * 0.9)
        return out
      } catch (e) {
        if (!(e instanceof RateLimited)) throw e
        gap = Math.min(60_000, gap * 2)
        pausedUntil = Date.now() + backoffMs
        if (!retry) throw e
        return attempt(false)
      }
    }
    const result = queue.then(() => attempt(true))
    const next = () => new Promise((r) => setTimeout(r, gap))
    queue = result.then(next, next)
    return result
  }
}

const splitId = (id: string) => {
  const i = id.indexOf(':')
  return { chain: id.slice(0, i), address: id.slice(i + 1) }
}

// ---------- DexScreener: tokens, pairs, lists ----------

const DS = 'https://api.dexscreener.com'

interface DexPair {
  chainId: string
  dexId: string
  url: string
  pairAddress: string
  baseToken: { address: string; name: string; symbol: string }
  priceUsd?: string
  txns?: Record<string, { buys: number; sells: number }>
  volume?: Record<string, number>
  priceChange?: Record<string, number>
  liquidity?: { usd?: number }
  fdv?: number
  marketCap?: number
  pairCreatedAt?: number
  info?: { imageUrl?: string }
}

// Real trading first: fake pools show huge "liquidity" but cents of volume. Liquidity only breaks ties.
const activity = (p: DexPair) => (p.volume?.h24 ?? 0) + (p.liquidity?.usd ?? 0) * 1e-9

function rowFromPair(p: DexPair): MarketRow {
  const n = (v: number | undefined | null) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const t = p.txns ?? {}
  return {
    token: {
      kind: 'token',
      id: `${p.chainId}:${p.baseToken.address}`,
      chain: p.chainId,
      address: p.baseToken.address,
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      logo: p.info?.imageUrl ?? null,
      pool: p.pairAddress,
    },
    metrics: {
      price: p.priceUsd ? Number(p.priceUsd) : null,
      change5m: n(p.priceChange?.m5),
      change1h: n(p.priceChange?.h1),
      change6h: n(p.priceChange?.h6),
      change24h: n(p.priceChange?.h24),
      volume5m: n(p.volume?.m5),
      volume1h: n(p.volume?.h1),
      volume24h: n(p.volume?.h24),
      liquidity: n(p.liquidity?.usd),
      marketCap: n(p.marketCap),
      fdv: n(p.fdv),
      buys1h: n(t.h1?.buys),
      sells1h: n(t.h1?.sells),
      buys24h: n(t.h24?.buys),
      sells24h: n(t.h24?.sells),
      txns24h: t.h24 ? t.h24.buys + t.h24.sells : null,
      ageHours: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : null,
    },
    dex: p.dexId,
    url: p.url,
    at: Date.now(),
    source: 'DexScreener',
  }
}

/** The most traded pair of each token. */
function bestPairs(pairs: DexPair[]): Map<string, DexPair> {
  const best = new Map<string, DexPair>()
  for (const p of pairs) {
    const k = `${p.chainId}:${p.baseToken.address}`.toLowerCase()
    const prev = best.get(k)
    if (!prev || activity(p) > activity(prev)) best.set(k, p)
  }
  return best
}

/** The pool each token is priced from (see dexMarket). */
const poolOf = new Map<string, string>()

/** Market rows for DEX tokens (chain:address), 30 per request, cached 5 s. */
async function dexMarket(ids: string[]): Promise<Map<string, MarketRow>> {
  const byChain = new Map<string, string[]>()
  for (const id of ids) {
    const { chain, address } = splitId(id)
    byChain.set(chain, [...(byChain.get(chain) ?? []), address])
  }
  const out = new Map<string, MarketRow>()
  await Promise.all(
    [...byChain].flatMap(([chain, addrs]) => {
      const chunks: string[][] = []
      for (let i = 0; i < addrs.length; i += 30) chunks.push(addrs.slice(i, i + 30))
      return chunks.map(async (chunk) => {
        const key = `ds:${chain}:${[...chunk].sort().join(',')}`
        const pairs = await cached(key, 5_000, () => getJson<DexPair[]>(`${DS}/tokens/v1/${chain}/${chunk.join(',')}`))
        const list = Array.isArray(pairs) ? pairs : []
        const best = bestPairs(list)
        for (const a of chunk) {
          const k = `${chain}:${a}`.toLowerCase()
          // Stay on the pool a token was first priced from (answers can include different pools), so
          // its stored history doesn't jump between pools' prices.
          const kept = poolOf.get(k)
          const keptPair = kept ? list.find((x) => x.pairAddress === kept && `${x.chainId}:${x.baseToken.address}`.toLowerCase() === k) : undefined
          const top = best.get(k)
          // Stay on it while it's still a real market (at least a fifth of the best pool's activity); a junk
          // pool picked once mustn't price the token for good.
          const p = keptPair && top && activity(keptPair) >= activity(top) * 0.2 ? keptPair : top
          if (!p) continue
          poolOf.set(k, p.pairAddress)
          out.set(`${chain}:${a}`, rowFromPair(p))
        }
      })
    }),
  )
  return out
}

async function dexSearch(q: string, chain: string): Promise<MarketRow[]> {
  const res = await cached(`ds:search:${q}`, 30_000, () => getJson<{ pairs: DexPair[] }>(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`))
  const pairs = (res.pairs ?? []).filter((p) => !chain || p.chainId === chain)
  const best = bestPairs(pairs)
  const query = q.trim().toLowerCase()
  // Exact symbol / address matches first, then by activity.
  const rank = (p: DexPair) =>
    p.baseToken.address.toLowerCase() === query ? 3 : p.baseToken.symbol.toLowerCase() === query ? 2 : p.baseToken.name.toLowerCase().includes(query) ? 1 : 0
  return [...best.values()].sort((a, b) => rank(b) - rank(a) || activity(b) - activity(a)).slice(0, 25).map(rowFromPair)
}

const POPULAR = [
  'solana:So11111111111111111111111111111111111111112',
  'solana:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  'solana:JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'ethereum:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  'ethereum:0x6982508145454Ce325dDbE47a25d4ec3d2311933',
  'base:0x532f27101965dd16442E59d40670FaF5eBB142E4',
  'bsc:0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
]

const DS_LISTS: Record<string, string> = {
  dsTrending: '/token-boosts/top/v1',
  dsBoosted: '/token-boosts/latest/v1',
  dsProfiles: '/token-profiles/latest/v1',
  dsTakeovers: '/community-takeovers/latest/v1',
  dsAds: '/ads/latest/v1',
}

/** A DexScreener list (≈30 tokens), completed with market data. */
async function dsList(source: string, chain: string): Promise<MarketRow[]> {
  const ids =
    source === 'popular'
      ? POPULAR
      : (await getJson<{ chainId: string; tokenAddress: string }[]>(DS + DS_LISTS[source])).map((r) => `${r.chainId}:${r.tokenAddress}`)
  const unique = [...new Set(ids)].filter((id) => !chain || id.startsWith(`${chain}:`))
  const rows = await dexMarket(unique)
  return unique.map((id) => rows.get(id)).filter((r): r is MarketRow => Boolean(r))
}

// GeckoTerminal pool lists: 20 pools a page, every metric included — the way to get hundreds of tokens.
interface GtPool {
  attributes: {
    address: string
    name: string
    pool_created_at?: string
    base_token_price_usd?: string
    fdv_usd?: string | null
    market_cap_usd?: string | null
    reserve_in_usd?: string
    price_change_percentage?: Record<string, string | null>
    volume_usd?: Record<string, string | null>
    transactions?: Record<string, { buys: number; sells: number; buyers?: number; sellers?: number }>
  }
  relationships: { base_token: { data: { id: string } }; network?: { data: { id: string } }; dex?: { data: { id: string } } }
}
interface GtToken {
  id: string
  attributes: { address: string; name: string; symbol: string; image_url?: string | null }
}

const chainOfGecko = (net: string) => CHAINS.find((c) => c.gecko === net)?.id ?? net

function rowFromGt(pool: GtPool, tokens: Map<string, GtToken>): MarketRow | null {
  const a = pool.attributes
  const tokenRef = pool.relationships.base_token.data.id
  const net = pool.relationships.network?.data.id ?? tokenRef.slice(0, tokenRef.indexOf('_'))
  const t = tokens.get(tokenRef)
  const address = t?.attributes.address ?? tokenRef.slice(net.length + 1)
  if (!address) return null
  const n = (v: string | null | undefined) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const tx = a.transactions ?? {}
  const chain = chainOfGecko(net)
  return {
    token: {
      kind: 'token',
      id: `${chain}:${address}`,
      chain,
      address,
      symbol: t?.attributes.symbol ?? a.name.split(' / ')[0],
      name: t?.attributes.name ?? a.name,
      logo: t?.attributes.image_url && !t.attributes.image_url.includes('missing') ? t.attributes.image_url : null,
      pool: a.address,
    },
    metrics: {
      price: n(a.base_token_price_usd),
      change5m: n(a.price_change_percentage?.m5),
      change1h: n(a.price_change_percentage?.h1),
      change6h: n(a.price_change_percentage?.h6),
      change24h: n(a.price_change_percentage?.h24),
      volume5m: n(a.volume_usd?.m5),
      volume1h: n(a.volume_usd?.h1),
      volume24h: n(a.volume_usd?.h24),
      liquidity: n(a.reserve_in_usd),
      marketCap: n(a.market_cap_usd),
      fdv: n(a.fdv_usd),
      buys1h: tx.h1?.buys ?? null,
      sells1h: tx.h1?.sells ?? null,
      buys24h: tx.h24?.buys ?? null,
      sells24h: tx.h24?.sells ?? null,
      txns24h: tx.h24 ? tx.h24.buys + tx.h24.sells : null,
      buyers5m: tx.m5?.buyers ?? null,
      buyers24h: tx.h24?.buyers ?? null,
      ageHours: a.pool_created_at ? (Date.now() - Date.parse(a.pool_created_at)) / 3.6e6 : null,
    },
    dex: pool.relationships.dex?.data.id,
    url: `https://www.geckoterminal.com/${net}/pools/${a.address}`,
    at: Date.now(),
    source: 'GeckoTerminal',
  }
}

const GT_LISTS: Record<string, (net: string) => string> = {
  gtTrending: (net) => (net ? `/networks/${net}/trending_pools` : '/networks/trending_pools'),
  gtNew: (net) => (net ? `/networks/${net}/new_pools` : '/networks/new_pools'),
  // "Top pools" only exists per network: without a chain, the big meme chains share it.
  gtTop: (net) => `/networks/${net || 'solana'}/pools`,
}

/** A GeckoTerminal pool list: `pages` pages of 20 (per network), one at a time through the queue. */
async function gtFetch(source: string, pages: number): Promise<MarketRow[]> {
  const nets = source === 'gtTop' ? ['solana', 'base', 'bsc', 'eth'] : ['']
  const out: MarketRow[] = []
  for (const net of nets)
    for (let page = 1; page <= pages; page++) {
      const url = `${GT}${GT_LISTS[source](net)}?page=${page}&include=base_token`
      let body: { data: GtPool[]; included?: GtToken[] }
      try {
        body = await gtQueue(() => getJson<{ data: GtPool[]; included?: GtToken[] }>(url))
      } catch (e) {
        if (!out.length) throw e
        break // keep the pages already fetched; the next run tries the rest
      }
      const tokens = new Map((body.included ?? []).map((t) => [t.id, t]))
      const pools = body.data ?? []
      out.push(...pools.map((p) => rowFromGt(p, tokens)).filter((r): r is MarketRow => Boolean(r)))
      if (pools.length < 20) break // the last page
    }
  // One row per token (a token can have several trending pools): the first, i.e. the higher ranked.
  const seen = new Set<string>()
  return out.filter((r) => !seen.has(r.token.id) && seen.add(r.token.id))
}

/** CoinGecko's trending coins (≈15), with market data. */
async function cgTrending(): Promise<MarketRow[]> {
  const res = await cgGet<{ coins: { item: { id: string } }[] }>('/search/trending')
  return cgMarkets(res.coins.map((c) => c.item.id))
}

const SOURCES: SourceDef[] = FEED_SOURCES.map(({ key, kind, api, every, pages, maxPages, calls }) => ({ key, kind, api, every, pages, maxPages, calls }))

// ---------- enrichment: values added to every stored token, in the background ----------

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const chunks = <T,>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size))
const enrichRow = (token: Token, metrics: Metrics, source: string): MarketRow => ({ token, metrics, at: Date.now(), source })
const numOrNull = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const llamaKeyOf = (t: Token) => (t.chain === 'coingecko' ? `coingecko:${t.address}` : chainById(t.chain) ? `${chainById(t.chain)!.llama}:${t.address}` : null)
const HONEYPOT_CHAINS = [1, 56, 8453]

/** Jupiter, 100 Solana tokens a call: organic score and volume, holders and their 1h change, top-10 share. */
async function enrichJupiter(tokens: Token[]): Promise<MarketRow[]> {
  const out: MarketRow[] = []
  for (const group of chunks(tokens.filter((t) => t.chain === 'solana'), 100)) {
    type J = { id: string; decimals?: number; holderCount?: number; organicScore?: number; audit?: { topHoldersPercentage?: number; freezeAuthorityDisabled?: boolean; mintAuthorityDisabled?: boolean }; stats1h?: { holderChange?: number }; stats24h?: { buyOrganicVolume?: number; sellOrganicVolume?: number } }
    const list = await getJson<J[]>(`https://lite-api.jup.ag/tokens/v2/search?query=${group.map((t) => t.address).join(',')}`)
    const byMint = new Map((Array.isArray(list) ? list : []).map((j) => [j.id, j]))
    for (const t of group) {
      const j = byMint.get(t.address)
      if (!j) continue
      const org = j.stats24h?.buyOrganicVolume != null ? (j.stats24h.buyOrganicVolume ?? 0) + (j.stats24h.sellOrganicVolume ?? 0) : null
      out.push(
        enrichRow(
          t,
          {
            holders: numOrNull(j.holderCount),
            top10: numOrNull(j.audit?.topHoldersPercentage),
            holdersDelta1h: numOrNull(j.stats1h?.holderChange),
            organicScore: j.organicScore != null ? Math.round(j.organicScore) : null,
            organicVol24h: org,
            freezable: j.audit?.freezeAuthorityDisabled == null ? null : j.audit.freezeAuthorityDisabled ? 0 : 1,
            decimals: numOrNull(j.decimals),
          },
          'Jupiter',
        ),
      )
    }
    await pause(1000)
  }
  return out
}

/** DefiLlama, 50 tokens a call: a reference price (the Feed compares it with the DEX price). */
async function enrichLlama(tokens: Token[]): Promise<MarketRow[]> {
  const out: MarketRow[] = []
  const keyed = tokens.map((t) => [llamaKeyOf(t), t] as const).filter((x): x is readonly [string, Token] => Boolean(x[0]))
  for (const group of chunks(keyed, 50)) {
    const r = await getJson<{ coins: Record<string, { price?: number }> }>(`https://coins.llama.fi/prices/current/${group.map(([k]) => k).join(',')}`)
    for (const [k, t] of group) {
      const p = r.coins?.[k]?.price
      if (p != null) out.push(enrichRow(t, { priceLlama: p }, 'DefiLlama'))
    }
    await pause(1000)
  }
  return out
}

/** The tokens due for a slow check: never checked, or checked longer ago than `everyMs` — oldest first. */
const due = (key: string, tokens: Token[], ctx: FetchContext<MarketRow>, everyMs: number, n: number) =>
  tokens
    .map((t) => [t, ctx.checkedAt(key, t.id)] as const)
    .filter(([, at]) => Date.now() - at > everyMs)
    .sort((a, b) => a[1] - b[1])
    .slice(0, n)
    .map(([t]) => t)

/** GoPlus, one token a call (its free API takes one): holders, top-10 share, buy / sell tax. Each every 6 h. */
async function enrichGoplus(tokens: Token[], ctx: FetchContext<MarketRow>, n: number): Promise<MarketRow[]> {
  const out: MarketRow[] = []
  const covered = tokens.filter((t) => t.chain === 'solana' || chainById(t.chain)?.evmId)
  for (const t of due('enrichGoplus', covered, ctx, 6 * 3600e3, n)) {
    const c = chainById(t.chain)!
    const url = t.chain === 'solana' ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${t.address}` : `https://api.gopluslabs.io/api/v1/token_security/${c.evmId}?contract_addresses=${t.address}`
    try {
      const r = await getJson<{ result: Record<string, { holder_count?: string; holders?: { percent: string }[]; buy_tax?: string; sell_tax?: string }> }>(url)
      const g = r.result?.[t.address] ?? r.result?.[t.address.toLowerCase()]
      out.push(
        enrichRow(
          t,
          g
            ? {
                holders: numOrNull(g.holder_count),
                top10: g.holders?.length ? g.holders.slice(0, 10).reduce((s, h) => s + Number(h.percent || 0), 0) * 100 : null,
                buyTax: g.buy_tax ? Number(g.buy_tax) * 100 : null,
                sellTax: g.sell_tax ? Number(g.sell_tax) * 100 : null,
              }
            : {},
          'GoPlus',
        ),
      )
    } catch (e) {
      if (e instanceof RateLimited) break // try the rest next run
    }
    await pause(2000)
  }
  return out
}

/** honeypot.is, one token a call: does a simulated sell go through? Ethereum, BNB, Base; each once a day. */
async function enrichHoneypot(tokens: Token[], ctx: FetchContext<MarketRow>, n: number): Promise<MarketRow[]> {
  const out: MarketRow[] = []
  const covered = tokens.filter((t) => HONEYPOT_CHAINS.includes(chainById(t.chain)?.evmId ?? 0))
  for (const t of due('enrichHoneypot', covered, ctx, 24 * 3600e3, n)) {
    try {
      const r = await getJson<{ honeypotResult?: { isHoneypot: boolean } }>(`https://api.honeypot.is/v2/IsHoneypot?address=${t.address}&chainID=${chainById(t.chain)!.evmId}`)
      out.push(enrichRow(t, { honeypot: r.honeypotResult ? (r.honeypotResult.isHoneypot ? 1 : 0) : null }, 'honeypot.is'))
    } catch (e) {
      if (e instanceof RateLimited) break
    }
    await pause(3000)
  }
  return out
}

/** The tokens you watch, in full: every source, the trade sample and the $10K quotes (see details()). */
async function enrichTracked(tokens: Token[]): Promise<MarketRow[]> {
  const out: MarketRow[] = []
  for (const t of tokens) {
    // Every source but GeckoTerminal (quotes, Jupiter, GoPlus…); the trade analysis reads the trade tape, which
    // samples tracked pools first — so GeckoTerminal's 10 calls a minute aren't spent twice.
    const d = await details(t.id, t.pool ?? '', 60_000, true)
    const held = t.pool ? tape?.pool(t.chain, t.pool) : null
    const fromTape = held ? analyseTrades(held.trades.map((x) => ({ at: x.at, buy: x.kind === 'buy', usd: x.usd, wallet: x.wallet }))) : null
    const first = (key: string, srcs?: DetailSource[]) => {
      if (fromTape && key === 'netBuy5m') return fromTape.netBuy5m
      if (fromTape && key === 'organicScore' && srcs?.includes('trades')) return fromTape.organic
      if (fromTape && key === 'washProb') return fromTape.organic == null ? null : 100 - fromTape.organic
      const v = d.values[key] ?? {}
      for (const s of srcs ?? (Object.keys(v) as DetailSource[])) if (typeof v[s] === 'number') return v[s] as number
      return null
    }
    out.push(
      enrichRow(
        t,
        {
          netBuy5m: first('netBuy5m'),
          organicTrades: first('organicScore', ['trades']),
          washProb: first('washProb'),
          impact10k: first('impact10k'),
          buyers5m: first('buyers5m'),
          buyers24h: first('buyers24h'),
        },
        'Tracked',
      ),
    )
  }
  return out
}

// ---------- the trade tape: wallet-level trades of many pools (the rotation engine's input) ----------

let tape: ReturnType<typeof createTape> | null = null
/** Pools the tape keeps sampled per chain (the most traded in the lists), plus every tracked token's. */
const TAPE_PER_CHAIN = 10
/**
 * The chains the tape covers (plus any chain a tracked token is on). Every chain listed costs GeckoTerminal
 * calls, and its 10 a minute are shared: covering a few chains well beats covering every chain thinly.
 */
const TAPE_CHAINS = (process.env.TAPE_CHAINS || 'solana,base,bsc,ethereum').split(',').map((c) => c.trim()).filter(Boolean)

/** GeckoTerminal's network id for a chain (our ids where they differ, else the same id). */
const geckoNet = (chain: string) => chainById(chain)?.gecko ?? chain

/**
 * Sample `n` pools' last trades (GeckoTerminal: up to 300 each, one call per pool) into the tape, on every
 * chain. Candidates: the watchlist's and selected token's pools, then each chain's most-traded pools in the
 * lists; each run takes the ones sampled longest ago, whatever their chain.
 */
async function sampleTape(ctx: FetchContext<MarketRow>, n: number): Promise<MarketRow[]> {
  if (!tape) return []
  const DEX = (t: Token) => t.chain !== 'coingecko' && Boolean(t.pool)
  const tracked = (ctx.tracked() as Token[]).filter(DEX)
  const byChain = new Map<string, MarketRow[]>()
  for (const r of ctx.rows() as MarketRow[])
    if (DEX(r.token) && TAPE_CHAINS.includes(r.token.chain) && (r.metrics.volume24h ?? 0) > 0) (byChain.get(r.token.chain) ?? byChain.set(r.token.chain, []).get(r.token.chain)!).push(r)
  // Each chain's candidates: its tracked pools first, then its busiest — a stable set, re-sampled in turn.
  const perChain = new Map<string, Token[]>()
  const add = (t: Token) => {
    const list = perChain.get(t.chain) ?? perChain.set(t.chain, []).get(t.chain)!
    if (!list.some((x) => x.pool === t.pool)) list.push(t)
  }
  tracked.forEach(add)
  for (const rows of byChain.values()) rows.sort((a, b) => (b.metrics.volume24h ?? 0) - (a.metrics.volume24h ?? 0)).slice(0, TAPE_PER_CHAIN).forEach((r) => add(r.token))
  for (const list of perChain.values()) list.sort((a, b) => tape!.sampledAt(a.chain, a.pool!) - tape!.sampledAt(b.chain, b.pool!))
  // Chains take turns (the one waiting longest first), so none is starved by another's churn.
  const chainsByWait = [...perChain.keys()].sort((a, b) => tape!.sampledAt(a, perChain.get(a)![0].pool!) - tape!.sampledAt(b, perChain.get(b)![0].pool!))
  const due: Token[] = []
  for (let i = 0; due.length < n && chainsByWait.some((c) => perChain.get(c)!.length > i); i++)
    for (const c of chainsByWait) {
      const t = perChain.get(c)![i]
      if (t && due.length < n) due.push(t)
    }
  const out: MarketRow[] = []
  for (const t of due) {
    const chain = t.chain
    try {
      const body = await gtQueue(() =>
        getJson<{ data: { attributes: { block_timestamp: string; kind: string; volume_in_usd: string; tx_from_address: string; tx_hash: string; price_to_in_usd?: string; price_from_in_usd?: string } }[] }>(
          `${GT}/networks/${geckoNet(chain)}/pools/${t.pool}/trades`,
        ),
      )
      const trades = (body.data ?? []).map(({ attributes: a }) => ({
        price: Number(a.kind === 'buy' ? a.price_to_in_usd : a.price_from_in_usd) || null,
        at: Date.parse(a.block_timestamp),
        pool: t.pool!,
        token: t.id,
        symbol: t.symbol,
        kind: a.kind === 'buy' ? ('buy' as const) : ('sell' as const),
        usd: Number(a.volume_in_usd) || 0,
        wallet: String(a.tx_from_address || '').toLowerCase(),
        tx: a.tx_hash,
      }))
      const added = tape.add(chain, { pool: t.pool!, token: t.id, symbol: t.symbol }, trades.filter((x) => x.wallet && Number.isFinite(x.at)))
      smart?.record(chain, added) // every new buy waits to be judged, for the smart-wallet list
      const held = tape.pool(chain, t.pool!)!
      const recent = held.trades.filter((x) => Date.now() - x.at <= 2 * 3600e3)
      out.push(enrichRow(t, { tapeTrades2h: recent.length, tapeWallets2h: new Set(recent.map((x) => x.wallet)).size }, 'Trade tape'))
    } catch (e) {
      if (e instanceof RateLimited) break // GeckoTerminal is full: the rest wait for the next run
    }
  }
  tape.prune()
  await tape.save()
  return out
}

// ---------- the rotation engine (server/rotation.ts), every minute, from the tape ----------

/** The last full evaluation of each token (for /api/engine/rotation and Token details). */
const rotationDetail = new Map<string, Evaluation & { token: Token }>()

/** A token's stored price / 5-minute volume / buyers since `since` (from its history file). */
async function historySamples(id: string, since: number): Promise<Sample[]> {
  const text = await fs.readFile(historyFile(id), 'utf8').catch(() => '')
  const out: Sample[] = []
  for (const line of text.split('\n')) {
    if (!line || line.length < 10) continue
    try {
      const r = JSON.parse(line) as { at: number; m: Metrics }
      if (r.at < since) continue
      if (r.m.price == null && r.m.volume5m == null && r.m.buyers5m == null) continue
      out.push({ t: r.at, price: r.m.price, volume5m: r.m.volume5m, buyers5m: r.m.buyers5m })
    } catch {
      /* a cut line */
    }
  }
  // A stray price from a junk pool (10× off the median) would wreck the 6h range: leave it out.
  const prices = out.map((x) => x.price).filter((v): v is number => typeof v === 'number' && v > 0).sort((a, b) => a - b)
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null
  return median ? out.map((x) => (x.price && (x.price > median * 10 || x.price < median / 10) ? { ...x, price: null } : x)) : out
}

async function runRotation(ctx: FetchContext<MarketRow>): Promise<MarketRow[]> {
  if (!tape || !collector) return []
  const out: MarketRow[] = []
  // Rotation is measured within one chain, never across: each chain's tape on its own.
  for (const chain of tape.chains()) out.push(...(await rotateChain(ctx, chain)))
  await callLog?.save()
  return out
}

// ---------- smart wallets, the calls log, the sell check ----------

let smart: ReturnType<typeof createSmart> | null = null
let callLog: ReturnType<typeof createCallLog> | null = null

/** A token's stored prices from `from` to `to` (stray prices from junk pools left out). */
const priceSeries: PriceSeries = async (token, from, to) =>
  (await historySamples(token, from)).filter((s) => s.t <= to && typeof s.price === 'number').map((s) => [s.t, s.price!] as [number, number])

/** Jupiter: can a $100 sell of this token be routed to USDC? (Solana's "sellable", each token every 30 min.) */
async function sellCheck(ctx: FetchContext<MarketRow>, n: number): Promise<MarketRow[]> {
  if (!tape || !collector) return []
  const tokens = new Map<string, Token>()
  for (const t of ctx.tracked() as Token[]) if (t.chain === 'solana') tokens.set(t.id, t)
  for (const tr of tape.trades('solana', Date.now() - 2 * 3600e3)) if (!tokens.has(tr.token)) tokens.set(tr.token, { kind: 'token', id: tr.token, chain: 'solana', address: tr.token.slice(7), symbol: tr.symbol, name: tr.symbol })
  const rowsById = new Map((ctx.rows() as MarketRow[]).map((r) => [r.token.id, r]))
  const out: MarketRow[] = []
  for (const t of due('sellCheck', [...tokens.values()], ctx, 30 * 60_000, n)) {
    const x = collector.extras(t.id)
    const price = rowsById.get(t.id)?.metrics.price ?? null
    const decimals = x.decimals
    if (!price || decimals == null) continue
    const amount = Math.max(1, Math.round((100 / price) * 10 ** decimals))
    try {
      // Jupiter answers "no route" with an error status and a JSON reason: read it as it is.
      const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${t.address}&outputMint=${SOL_USDC}&amount=${amount}&slippageBps=300`, { signal: AbortSignal.timeout(15_000) })
      if (res.status === 429) break
      const q = (await res.json().catch(() => ({}))) as { outAmount?: string; error?: string; errorCode?: string }
      const routed = Boolean(q.outAmount && Number(q.outAmount) > 0)
      // "No route" is evidence; any other failure isn't (try again next run).
      if (!routed && !/route|liquidity|could not find/i.test(`${q.error ?? ''} ${q.errorCode ?? ''}`)) continue
      out.push(enrichRow(t, { sellRoute: routed ? 1 : 0 }, 'Jupiter'))
    } catch {
      /* next run */
    }
    await pause(1000)
  }
  return out
}

async function fetchSource(key: string, pages: number, ctx: FetchContext<MarketRow>): Promise<MarketRow[]> {
  if (key === 'sellCheck') return sellCheck(ctx, pages)
  if (key === 'smartLearn') {
    await smart?.resolve(priceSeries)
    await smart?.save()
    return []
  }
  if (key === 'grading') {
    await callLog?.grade(priceSeries)
    return []
  }
  return fetchSourceRest(key, pages, ctx)
}

async function rotateChain(ctx: FetchContext<MarketRow>, chain: string): Promise<MarketRow[]> {
  if (!tape || !collector) return []
  const now = Date.now()
  const all = tape.trades(chain, now - 6 * 3600e3)
  const index = walletIndex(all)
  const byPool = new Map<string, TapeTrade[]>()
  for (const t of all) (byPool.get(t.pool) ?? byPool.set(t.pool, []).get(t.pool)!).push(t)
  const rowsById = new Map((ctx.rows() as MarketRow[]).map((r) => [r.token.id, r]))
  const smartSet = smart?.setFor(chain) ?? null
  const out: MarketRow[] = []
  for (const [pool, own] of byPool) {
    const first = own[0]
    const row = rowsById.get(first.token)
    const x = collector.extras(first.token)
    const token: Token = row?.token ?? { kind: 'token', id: first.token, chain, address: first.token.slice(chain.length + 1), symbol: first.symbol, name: first.symbol, pool }
    const ev = evaluate(own, index, pool, await historySamples(first.token, now - 6 * 3600e3), {
      token: first.token,
      price: row?.metrics.price ?? x.price ?? null,
      liquidity: row?.metrics.liquidity ?? null,
      poolAgeHours: row?.metrics.ageHours ?? null,
      holders: x.holders ?? null,
      organicScore: x.organicScore ?? null,
      honeypot: x.honeypot ?? null,
      freezable: x.freezable ?? null,
      sellRoute: x.sellRoute ?? null,
      buyTax: x.buyTax ?? null,
      sellTax: x.sellTax ?? null,
      impact10k: x.impact10k ?? null,
      smart: smartSet,
    }, now)
    rotationDetail.set(first.token, { ...ev, token })
    // Every engine's call, written down when it changes (graded later: see server/calls.ts).
    const price = row?.metrics.price ?? null
    callLog?.log(
      Object.entries(ev.calls)
        .filter(([, c]) => c.call)
        .map(([engine, c]) => ({ at: now, chain, token: first.token, symbol: token.symbol, engine, call: c.call!, score: ev.scores[engine as keyof typeof ev.scores].score, price, why: c.why, plan: c.call === 'BUY' ? { targetPct: frameOf(RULES.plan.holdHours).targetPct, stopPct: frameOf(RULES.plan.holdHours).stopPct, holdHours: RULES.plan.holdHours } : null })),
    )
    const call = ev.calls[ev.engine]
    out.push({
      ...enrichRow(token, {
        rotIn1h: ev.rotation?.inWallets ?? null,
        rotOut1h: ev.rotation?.outWallets ?? null,
        rotNetUsd: ev.rotation ? ev.rotation.inUsd - ev.rotation.outUsd : null,
        flow2h: ev.market?.net ?? null,
        connectedPools: ev.market?.connected ?? null,
        qualityScore: ev.scores.quality.score,
        rotationScore: ev.scores.rotation.score,
        rotationPlusScore: ev.scores.rotationPlus.score,
        tideScore: ev.scores.tide.score,
        momentumScore: ev.scores.momentum.score,
        flowScore: ev.scores.flow.score,
        executionCost: ev.costPct,
        aboveLow6h: ev.measures.aboveLow6h,
        cycleScore: ev.scores.cycle.score,
        smartScore: ev.scores.smart.score,
        smartBuyers1h: ev.smart.buyers,
        smartSellers1h: ev.smart.sellers,
        blendScore: ev.scores.blend.score,
        consensusScore: ev.scores.consensus.score,
        rotationMidLiqScore: ev.scores.rotationMidLiq.score,
        smartRotationScore: ev.scores.smartRotation.score,
      }, 'Rotation'),
      tags: { ...(ev.phase.phase ? { phase: ev.phase.phase } : {}), ...(call.call ? { call: call.call, callWhy: call.why } : {}) },
    })
  }
  return out
}

async function fetchSourceRest(key: string, pages: number, ctx: FetchContext<MarketRow>): Promise<MarketRow[]> {
  if (key === 'tradeTape') return sampleTape(ctx, pages)
  if (key === 'rotation') return runRotation(ctx)
  if (key === 'enrichJupiter') return enrichJupiter(ctx.tokens() as Token[])
  if (key === 'enrichLlama') return enrichLlama(ctx.tokens() as Token[])
  if (key === 'enrichGoplus') return enrichGoplus(ctx.tokens() as Token[], ctx, pages)
  if (key === 'enrichHoneypot') return enrichHoneypot(ctx.tokens() as Token[], ctx, pages)
  if (key === 'tracked') return enrichTracked(ctx.tracked() as Token[])
  if (key in GT_LISTS) return gtFetch(key, pages)
  if (key in DS_LISTS || key === 'popular') return dsList(key, '')
  if (key === 'cgTop') {
    const all: MarketRow[] = []
    for (let page = 1; page <= pages; page++) all.push(...(await cgMarkets([], 250, page, 0)))
    return all
  }
  if (key === 'cgTrending') return cgTrending()
  throw new Error(`Unknown source: ${key}`)
}

let collector: ReturnType<typeof createCollector<MarketRow>> | null = null

/** The tokens of the sources shown, taken in turns (so each is represented), without duplicates. */
function feed(sources: string[], chain: string, limit: number, selected: string) {
  const chains = chain.split(',').filter(Boolean)
  const lists = sources.map((k) => (collector?.rows(k) ?? []).filter((r) => !chains.length || chains.includes(r.token.chain)))
  const seen = new Set<string>()
  const rows: MarketRow[] = []
  for (let i = 0; rows.length < limit && lists.some((l) => i < l.length); i++)
    for (const l of lists) {
      const r = l[i]
      if (!r || seen.has(r.token.id.toLowerCase())) continue
      seen.add(r.token.id.toLowerCase())
      rows.push(r)
      if (rows.length >= limit) break
    }
  // The selected token keeps being watched (so it updates even after it drops out of every list), and
  // comes back with its newest values from whichever source — or the watch — has them.
  if (selected) watched.set(selected, Date.now())
  const pick = selected ? (watchedRows.get(selected)?.at ?? 0) > (collector?.find(selected)?.at ?? 0) ? watchedRows.get(selected) : collector?.find(selected) : undefined
  // Each row with what the enrichment knows about its token (holders, organic score, taxes…).
  const enriched = (r: MarketRow): MarketRow => {
    const x = collector!.extras(r.token.id)
    const { priceLlama, ...rest } = x
    const vsLlama = priceLlama && r.metrics.price ? (r.metrics.price / priceLlama - 1) * 100 : null
    const tags = collector!.extraTags(r.token.id)
    return { ...r, metrics: { ...r.metrics, ...rest, ...(vsLlama != null ? { priceVsLlama: vsLlama } : {}) }, ...(Object.keys(tags).length ? { tags: { ...r.tags, ...tags } } : {}) }
  }
  return { rows: rows.map(enriched), selectedRow: pick ? enriched(pick) : null, ...collector!.status(), tape: tape?.stats() ?? {} }
}

// ---------- CoinGecko: big coins (no contract needed), and their candles ----------

const CG = 'https://api.coingecko.com/api/v3'
const cgKey = () => process.env.COINGECKO_KEY || process.env.VITE_COINGECKO_KEY || ''
// CoinGecko: ≈30 calls/min with a demo key, fewer without — one every 2 s / 6 s.
const cgQueue = makeQueue(() => (cgKey() ? 2000 : 6000), 60_000)
const cgGet = <T>(pathAndQuery: string) =>
  cgQueue(() => getJson<T>(`${CG}${pathAndQuery}`, cgKey() ? { headers: { 'x-cg-demo-api-key': cgKey() } } : {}))

interface CgMarket {
  id: string
  symbol: string
  name: string
  image: string
  current_price: number | null
  market_cap: number | null
  fully_diluted_valuation: number | null
  total_volume: number | null
  price_change_percentage_1h_in_currency?: number | null
  price_change_percentage_24h_in_currency?: number | null
}

function rowFromCg(c: CgMarket): MarketRow {
  return {
    token: { kind: 'token', id: `coingecko:${c.id}`, chain: 'coingecko', address: c.id, symbol: c.symbol.toUpperCase(), name: c.name, logo: c.image },
    metrics: {
      price: c.current_price,
      change1h: c.price_change_percentage_1h_in_currency ?? null,
      change24h: c.price_change_percentage_24h_in_currency ?? null,
      volume24h: c.total_volume,
      marketCap: c.market_cap,
      fdv: c.fully_diluted_valuation,
    },
    at: Date.now(),
    source: 'CoinGecko',
  }
}

/** CoinGecko markets: these coin ids, or (no ids) the top N by market cap. Cached a minute. */
async function cgMarkets(ids: string[], top = 100, page = 1, ttlMs = 60_000): Promise<MarketRow[]> {
  const q = ids.length
    ? `/coins/markets?vs_currency=usd&ids=${ids.join(',')}&price_change_percentage=1h,24h`
    : `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${Math.min(250, top)}&page=${page}&price_change_percentage=1h,24h`
  const list = ttlMs ? await cached(`cg:${q}`, ttlMs, () => cgGet<CgMarket[]>(q)) : await cgGet<CgMarket[]>(q)
  return list.map(rowFromCg)
}

// ---------- market (any token) + recording ----------

/** Tokens asked about recently: their metrics are recorded every 20 s. */
const watched = new Map<string, number>()
const WATCH_MS = 30 * 60_000
/** The last row the watch fetched of each token. */
const watchedRows = new Map<string, MarketRow>()

async function market(ids: string[]): Promise<Record<string, MarketRow>> {
  const now = Date.now()
  ids.forEach((id) => watched.set(id, now))
  const dex = ids.filter((id) => !id.startsWith('coingecko:'))
  const cg = ids.filter((id) => id.startsWith('coingecko:')).map((id) => id.slice('coingecko:'.length))
  const [d, c] = await Promise.all([dex.length ? dexMarket(dex) : new Map<string, MarketRow>(), cg.length ? cgMarkets(cg) : []])
  const out: Record<string, MarketRow> = {}
  d.forEach((row, id) => (out[id] = row))
  for (const row of c) out[row.token.id] = row
  return out
}

let historyDir = ''
let feedDir = ''
const historyFile = (id: string) => path.join(historyDir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`)

async function recordWatched() {
  const now = Date.now()
  const ids = [...watched].filter(([, at]) => now - at < WATCH_MS).map(([id]) => id)
  for (const [id, at] of watched) if (now - at >= WATCH_MS) watched.delete(id)
  if (!ids.length) return
  const dex = ids.filter((id) => !id.startsWith('coingecko:'))
  const cg = ids.filter((id) => id.startsWith('coingecko:')).map((id) => id.slice('coingecko:'.length))
  const rows = [...(dex.length ? (await dexMarket(dex)).values() : []), ...(cg.length ? await cgMarkets(cg) : [])]
  for (const r of rows) watchedRows.set(r.token.id, r)
  await collector?.record(rows, 'watch') // the same storage as the Feed's; the app is told, like after any fetch
}

async function history(id: string, metric: string, since: number): Promise<[number, number][]> {
  const text = await fs.readFile(historyFile(id), 'utf8').catch(() => '')
  const points: [number, number][] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line) as { at: number; m: Metrics }
      const v = r.m[metric]
      if (r.at >= since && typeof v === 'number') points.push([r.at, v])
    } catch {
      /* a line cut short: skip */
    }
  }
  return points
}

// ---------- candles: GeckoTerminal (DEX pools), CoinGecko OHLC (big coins) ----------

const GT = 'https://api.geckoterminal.com/api/v2'
// GeckoTerminal's free API: 10 calls a minute in all. One every 7 s (≈8.5/min) leaves headroom — at exactly
// 10/min a backlog trips its limit — and a 429 pauses the queue for a minute.
const gtQueue = makeQueue(7000, 60_000)
const INTERVALS: Record<string, { tf: string; agg: number; ms: number }> = {
  '1m': { tf: 'minute', agg: 1, ms: 60e3 },
  '5m': { tf: 'minute', agg: 5, ms: 5 * 60e3 },
  '15m': { tf: 'minute', agg: 15, ms: 15 * 60e3 },
  '1h': { tf: 'hour', agg: 1, ms: 3600e3 },
  '4h': { tf: 'hour', agg: 4, ms: 4 * 3600e3 },
  '12h': { tf: 'hour', agg: 12, ms: 12 * 3600e3 },
  '1d': { tf: 'day', agg: 1, ms: 86400e3 },
}

async function candles(id: string, interval: string, limit: number, pool: string) {
  const iv = INTERVALS[interval] ?? INTERVALS['15m']
  const { chain, address } = splitId(id)
  if (chain === 'coingecko') {
    const days = iv.ms <= 30 * 60e3 ? 1 : iv.ms <= 4 * 3600e3 ? 30 : 90
    const rows = await cached(`cg:ohlc:${address}:${days}`, 5 * 60_000, () => cgGet<[number, number, number, number, number][]>(`/coins/${address}/ohlc?vs_currency=usd&days=${days}`))
    return { interval, pool: null, bars: rows.map(([t, o, h, l, c]) => [t, o, h, l, c, 0]) }
  }
  const network = chainById(chain)?.gecko
  if (!network) throw new Error(`No candles for ${chain} yet`)
  let poolAddress = pool
  if (!poolAddress) {
    const pools = await cached(`gt:pools:${network}:${address}`, 30 * 60_000, () =>
      gtQueue(() => getJson<{ data: { attributes: { address: string; reserve_in_usd: string | null } }[] }>(`${GT}/networks/${network}/tokens/${address}/pools?page=1`)),
    )
    const best = [...pools.data].sort((a, b) => Number(b.attributes.reserve_in_usd ?? 0) - Number(a.attributes.reserve_in_usd ?? 0))[0]
    if (!best) throw new Error('No pool with candles for this token')
    poolAddress = best.attributes.address
  }
  const ttl = Math.min(60_000, Math.max(20_000, iv.ms / 3))
  const res = await cached(`gt:ohlcv:${network}:${poolAddress}:${interval}:${limit}`, ttl, () =>
    gtQueue(() =>
      getJson<{ data: { attributes: { ohlcv_list: [number, number, number, number, number, number][] } } }>(
        `${GT}/networks/${network}/pools/${poolAddress}/ohlcv/${iv.tf}?aggregate=${iv.agg}&limit=${limit}&currency=usd`,
      ),
    ),
  )
  const bars = [...res.data.attributes.ohlcv_list].reverse().map(([t, o, h, l, c, v]) => [t * 1000, o, h, l, c, v])
  return { interval, pool: poolAddress, bars }
}

// ---------- safety: GoPlus + RugCheck (Solana) + honeypot.is (ETH / BNB / Base) ----------

type Level = 'good' | 'warn' | 'bad'

async function safety(id: string, skip: string[] = []) {
  const { chain, address } = splitId(id)
  const c = chainById(chain)
  if (!c) throw new Error(`No safety checks for ${chain}`)
  const flags: { label: string; level: Level }[] = []
  const facts: { label: string; value: string; level?: Level }[] = []
  const checks: CheckResult[] = []
  const answered: SourceResult[] = []
  const on = (v: unknown) => v === '1' || v === 1 || v === true
  const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)
  const taxLevel = (v: number): Level => (v === 0 ? 'good' : v <= 10 ? 'warn' : 'bad')
  /** Record a check of a known source (see core/safetyChecks), flagging it when hit. */
  const check = (src: SafetySource, key: string, hit: boolean, detail?: string) => {
    const def = src.checks.find((x) => x.key === key)!
    checks.push({ source: src.id, key, label: def.label, level: def.level, hit, detail })
    if (hit) flags.push({ label: def.label, level: def.level })
  }

  const run: Record<string, (src: SafetySource) => Promise<void>> = {
    'goplus-solana': async (src) => {
      const r = await getJson<{ result: Record<string, Record<string, unknown>> }>(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`)
      const g = r.result?.[address]
      if (!g) throw new Error('GoPlus doesn’t know this token yet')
      for (const k of src.checks) check(src, k.key, on((g[k.key] as { status?: string } | undefined)?.status))
      if (g.holder_count) facts.push({ label: 'Holders', value: Number(g.holder_count).toLocaleString('en-US') })
    },
    rugcheck: async (src) => {
      const r = await getJson<{ score_normalised?: number; lpLockedPct?: number; risks?: { name: string; level: string; description?: string }[] }>(
        `https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`,
      )
      // RugCheck's names for risks GoPlus already reports, so they count once.
      const SAME: Record<string, string> = { 'Mutable metadata': 'Metadata can be changed', 'Freeze Authority still enabled': 'Freezable', 'Mint Authority still enabled': 'Mintable' }
      for (const k of r.risks ?? []) {
        const level: Level = k.level === 'danger' ? 'bad' : 'warn'
        const label = SAME[k.name] ?? k.name
        checks.push({ source: src.id, key: k.level === 'danger' ? 'danger' : 'warn', label, level: level === 'bad' ? 'bad' : 'warn', hit: true, detail: k.description })
        flags.push({ label, level })
      }
      const locked = r.lpLockedPct ?? null
      facts.push({ label: 'Liquidity locked', value: pct(locked), level: locked == null ? undefined : locked >= 90 ? 'good' : locked >= 50 ? 'warn' : 'bad' })
      if (r.score_normalised != null)
        facts.push({ label: 'RugCheck score', value: `${r.score_normalised} / 100 (lower is safer)`, level: r.score_normalised <= 10 ? 'good' : r.score_normalised <= 50 ? 'warn' : 'bad' })
    },
    'goplus-evm': async (src) => {
      const r = await getJson<{ result: Record<string, Record<string, string>> }>(`https://api.gopluslabs.io/api/v1/token_security/${c.evmId}?contract_addresses=${address}`)
      const g = r.result?.[address.toLowerCase()]
      if (!g) throw new Error('GoPlus doesn’t know this token yet')
      for (const k of src.checks) check(src, k.key, k.key === 'is_open_source' ? g.is_open_source === '0' : on(g[k.key]))
      const buy = g.buy_tax ? Number(g.buy_tax) * 100 : null
      const sell = g.sell_tax ? Number(g.sell_tax) * 100 : null
      if (buy != null) facts.push({ label: 'Buy tax', value: pct(buy), level: taxLevel(buy) })
      if (sell != null) facts.push({ label: 'Sell tax', value: pct(sell), level: taxLevel(sell) })
      if (g.holder_count) facts.push({ label: 'Holders', value: Number(g.holder_count).toLocaleString('en-US') })
    },
    'honeypot-is': async (src) => {
      const r = await getJson<{ honeypotResult?: { isHoneypot: boolean; honeypotReason?: string }; summary?: { risk?: string } }>(
        `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${c.evmId}`,
      )
      check(src, 'isHoneypot', Boolean(r.honeypotResult?.isHoneypot), r.honeypotResult?.honeypotReason)
      if (r.summary?.risk) facts.push({ label: 'Simulated risk', value: r.summary.risk.replace(/_/g, ' '), level: ['low', 'very_low'].includes(r.summary.risk) ? 'good' : 'warn' })
    },
  }

  const asked = SAFETY_SOURCES.filter((src) => src.appliesTo(chain, c.evmId) && !skip.includes(src.id))
  if (!asked.length) throw new Error('Every safety service for this chain is switched off')
  await Promise.all(
    asked.map((src) =>
      run[src.id](src).then(
        () => void answered.push({ id: src.id, ok: true }),
        (e) => void answered.push({ id: src.id, ok: false, error: (e as Error).message }),
      ),
    ),
  )
  if (!answered.some((a) => a.ok)) throw new Error(answered[0]?.error ?? 'No safety data')
  // Sources answer in parallel and often report the same risk: keep one per label, the worse level.
  const unique = new Map<string, { label: string; level: Level }>()
  for (const f of flags) if (unique.get(f.label)?.level !== 'bad') unique.set(f.label, f)
  const merged = [...unique.values()]
  const verdict = merged.some((f) => f.level === 'bad') ? 'danger' : merged.length ? 'caution' : 'safe'
  const sources = asked.filter((src) => answered.find((a) => a.id === src.id)?.ok).map((src) => src.name)
  return { kind: 'report', title: 'Safety', verdict, flags: merged, facts, sources, checks, answered }
}

// ---------- token details: every source at once (see src/core/tokenDetails.ts) ----------

const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/** A token's most liquid GeckoTerminal pool (cached half an hour; shared with candles). */
async function gtTopPool(network: string, address: string): Promise<string> {
  const pools = await cached(`gt:pools:${network}:${address}`, 30 * 60_000, () =>
    gtQueue(() => getJson<{ data: { attributes: { address: string; reserve_in_usd: string | null } }[] }>(`${GT}/networks/${network}/tokens/${address}/pools?page=1`)),
  )
  const best = [...pools.data].sort((a, b) => Number(b.attributes.reserve_in_usd ?? 0) - Number(a.attributes.reserve_in_usd ?? 0))[0]
  if (!best) throw new Error('GeckoTerminal has no pool for this token')
  return best.attributes.address
}

interface Trade {
  at: number
  buy: boolean
  usd: number
  wallet: string
}

/**
 * Our read of a trade sample (GeckoTerminal's last ≤300 trades): how organic the flow looks. Bots and wash
 * trading show as few distinct wallets, wallets that both buy and sell, the same sizes over and over, and
 * dust-sized trades. 100 = all organic; wash probability is its inverse.
 */
function analyseTrades(trades: Trade[]) {
  const now = Date.now()
  const recent = trades.filter((t) => now - t.at <= 5 * 60_000)
  const netBuy5m = recent.reduce((s, t) => s + (t.buy ? t.usd : -t.usd), 0)
  if (trades.length < 10) return { netBuy5m, organic: null }
  const wallets = new Map<string, { buy: boolean; sell: boolean }>()
  for (const t of trades) {
    const w = wallets.get(t.wallet) ?? { buy: false, sell: false }
    if (t.buy) w.buy = true
    else w.sell = true
    wallets.set(t.wallet, w)
  }
  const diversity = Math.min(1, wallets.size / trades.length / 0.6)
  const roundTrip = trades.filter((t) => {
    const w = wallets.get(t.wallet)!
    return w.buy && w.sell
  }).length / trades.length
  const size = (v: number) => (v > 0 ? Number(v.toPrecision(2)) : 0)
  const counts = new Map<number, number>()
  for (const t of trades) counts.set(size(t.usd), (counts.get(size(t.usd)) ?? 0) + 1)
  const repeated = trades.filter((t) => (counts.get(size(t.usd)) ?? 0) >= 3).length / trades.length
  const dust = trades.filter((t) => t.usd < 5).length / trades.length
  const organic = 100 * (0.35 * diversity + 0.3 * (1 - roundTrip) + 0.2 * (1 - repeated) + 0.15 * (1 - dust))
  return { netBuy5m, organic: Math.round(organic) }
}

async function details(id: string, poolHint: string, waitMs = 10_000, skipGecko = false): Promise<DetailsAnswer> {
  const { chain, address } = splitId(id)
  const c = chainById(chain)
  const values: DetailsAnswer['values'] = {}
  const errors: DetailsAnswer['errors'] = {}
  const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const put = (key: string, src: DetailSource, v: number | string | null | undefined) => {
    if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return
    ;(values[key] ??= {})[src] = v
  }
  const ratio = (a: number | null, b: number | null) => (a != null && b ? a / b : null)
  const hours = (ms: number | null) => (ms ? (Date.now() - ms) / 3.6e6 : null)
  // Each source gets 10 s (the background tracking waits longer): a slow one (GeckoTerminal waits its turn in a queue shared with the Feed) is
  // left out of this answer — its request carries on into the cache, so the next refresh has it.
  const run = async (src: DetailSource, job: () => Promise<void>) => {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        job(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('still queued — it comes with the next refresh')), waitMs))),
      ])
    } catch (e) {
      errors[src] = (e as Error).message
    } finally {
      clearTimeout(timer)
    }
  }

  // DexScreener first: it's quick, and its pair is the pool the others use.
  let pool = poolHint
  if (c)
    await run('dexscreener', async () => {
      const pairs = await cached(`ds:token:${id}`, 10_000, () => getJson<DexPair[]>(`${DS}/tokens/v1/${chain}/${address}`))
      const k = id.toLowerCase()
      const mine = (Array.isArray(pairs) ? pairs : []).filter((p) => `${p.chainId}:${p.baseToken.address}`.toLowerCase() === k)
      const p = mine.find((x) => x.pairAddress === (poolHint || poolOf.get(k))) ?? bestPairs(mine).get(k)
      if (!p) throw new Error('DexScreener has no pair for this token')
      pool ||= p.pairAddress
      const t = p.txns ?? {}
      put('price', 'dexscreener', num(p.priceUsd))
      put('marketCap', 'dexscreener', num(p.marketCap ?? p.fdv))
      put('liquidity', 'dexscreener', num(p.liquidity?.usd))
      put('volume5m', 'dexscreener', num(p.volume?.m5))
      put('volume24h', 'dexscreener', num(p.volume?.h24))
      put('bsRatio24h', 'dexscreener', ratio(num(t.h24?.buys), num(t.h24?.sells)))
      put('volLiq24h', 'dexscreener', ratio(num(p.volume?.h24), num(p.liquidity?.usd)))
      put('poolAge', 'dexscreener', hours(p.pairCreatedAt ?? null))
    })

  // The background tracking skips GeckoTerminal: its trades come from the trade tape instead (no double fetch).
  const net = skipGecko ? undefined : c?.gecko
  const jobs: Promise<void>[] = []
  if (net) {
    const poolP = pool ? Promise.resolve(pool) : gtTopPool(net, address)
    jobs.push(
      run('geckoterminal', async () => {
        const pa = await poolP
        const body = await cached(`gt:pool:${net}:${pa}`, 60_000, () =>
          gtQueue(() => getJson<{ data: { attributes: GtPool['attributes']; relationships: GtPool['relationships'] } }>(`${GT}/networks/${net}/pools/${pa}`)),
        )
        const a = body.data.attributes
        const tx = (a.transactions ?? {}) as Record<string, { buys: number; sells: number; buyers?: number }>
        put('price', 'geckoterminal', num(a.base_token_price_usd))
        put('marketCap', 'geckoterminal', num(a.market_cap_usd ?? a.fdv_usd))
        put('liquidity', 'geckoterminal', num(a.reserve_in_usd))
        put('volume5m', 'geckoterminal', num(a.volume_usd?.m5))
        put('volume24h', 'geckoterminal', num(a.volume_usd?.h24))
        put('buyers5m', 'geckoterminal', num(tx.m5?.buyers))
        put('buyers24h', 'geckoterminal', num(tx.h24?.buyers))
        put('bsRatio24h', 'geckoterminal', ratio(num(tx.h24?.buys), num(tx.h24?.sells)))
        put('volLiq24h', 'geckoterminal', ratio(num(a.volume_usd?.h24), num(a.reserve_in_usd)))
        put('poolAge', 'geckoterminal', hours(a.pool_created_at ? Date.parse(a.pool_created_at) : null))
      }),
      run('trades', async () => {
        const pa = await poolP
        const body = await cached(`gt:trades:${net}:${pa}`, 60_000, () =>
          gtQueue(() =>
            getJson<{ data: { attributes: { block_timestamp: string; kind: string; volume_in_usd: string; tx_from_address: string } }[] }>(`${GT}/networks/${net}/pools/${pa}/trades`),
          ),
        )
        const trades: Trade[] = body.data.map(({ attributes: t }) => ({ at: Date.parse(t.block_timestamp), buy: t.kind === 'buy', usd: Number(t.volume_in_usd) || 0, wallet: t.tx_from_address }))
        const r = analyseTrades(trades)
        put('netBuy5m', 'trades', r.netBuy5m)
        put('organicScore', 'trades', r.organic)
        put('washProb', 'trades', r.organic == null ? null : 100 - r.organic)
      }),
    )
  }
  if (c && (chain === 'solana' || c.evmId))
    jobs.push(
      run('goplus', async () => {
        const url = chain === 'solana' ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}` : `https://api.gopluslabs.io/api/v1/token_security/${c.evmId}?contract_addresses=${address}`
        const r = await cached(`goplus:${id}`, 10 * 60_000, () => getJson<{ result: Record<string, { holder_count?: string; holders?: { percent: string }[] }> }>(url))
        const g = r.result?.[address] ?? r.result?.[address.toLowerCase()]
        if (!g) throw new Error('GoPlus doesn’t know this token yet')
        put('holders', 'goplus', num(g.holder_count))
        if (g.holders?.length) put('top10', 'goplus', g.holders.slice(0, 10).reduce((s, h) => s + Number(h.percent || 0), 0) * 100)
      }),
    )
  if (c?.evmId && [1, 56, 8453].includes(c.evmId))
    jobs.push(
      run('honeypot', async () => {
        const r = await cached(`honeypot:${id}`, 10 * 60_000, () =>
          getJson<{ honeypotResult?: { isHoneypot: boolean } }>(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${c.evmId}`),
        )
        if (!r.honeypotResult) throw new Error('honeypot.is couldn’t simulate a sell')
        put('sellSim', 'honeypot', r.honeypotResult.isHoneypot ? 'fails' : 'passes')
      }),
    )
  if (chain === 'solana') {
    jobs.push(
      run('jupiter', async () => {
        type Stats = { holderChange?: number; buyVolume?: number; sellVolume?: number; buyOrganicVolume?: number; sellOrganicVolume?: number; numBuys?: number; numSells?: number }
        const list = await cached(`jup:${address}`, 30_000, () =>
          getJson<
            {
              id: string
              usdPrice?: number
              mcap?: number
              liquidity?: number
              holderCount?: number
              organicScore?: number
              circSupply?: number
              launchpad?: string
              audit?: { topHoldersPercentage?: number; devMigrations?: number }
              stats1h?: Stats
              stats24h?: Stats
            }[]
          >(`https://lite-api.jup.ag/tokens/v2/search?query=${address}`),
        )
        const t = list.find((x) => x.id === address)
        if (!t) throw new Error('Jupiter doesn’t list this token')
        const d = t.stats24h ?? {}
        put('price', 'jupiter', num(t.usdPrice))
        put('marketCap', 'jupiter', num(t.mcap))
        put('liquidity', 'jupiter', num(t.liquidity))
        put('volume24h', 'jupiter', d.buyVolume != null ? (d.buyVolume ?? 0) + (d.sellVolume ?? 0) : null)
        put('bsRatio24h', 'jupiter', ratio(num(d.numBuys), num(d.numSells)))
        put('organicScore', 'jupiter', num(t.organicScore) != null ? Math.round(t.organicScore!) : null)
        put('organicVol24h', 'jupiter', d.buyOrganicVolume != null ? (d.buyOrganicVolume ?? 0) + (d.sellOrganicVolume ?? 0) : null)
        put('holders', 'jupiter', num(t.holderCount))
        put('top10', 'jupiter', num(t.audit?.topHoldersPercentage))
        put('holdersDelta1h', 'jupiter', num(t.stats1h?.holderChange))
        put('circSupply', 'jupiter', num(t.circSupply))
        put('launchpad', 'jupiter', t.launchpad ?? null)
        put('devMigrations', 'jupiter', num(t.audit?.devMigrations))
      }),
      run('jupiter', async () => {
        // Price impact of a $10,000 USDC buy, routed by Jupiter.
        const q = await cached(`jup:quote:${address}`, 60_000, () =>
          getJson<{ priceImpactPct?: string }>(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_USDC}&outputMint=${address}&amount=10000000000&slippageBps=100`),
        )
        put('impact10k', 'jupiter', num(q.priceImpactPct) != null ? Number(q.priceImpactPct) * 100 : null)
      }),
    )
  }
  if (c?.kyber && c.usdc)
    jobs.push(
      run('kyberswap', async () => {
        // A $10,000 USDC buy, routed by KyberSwap: what comes out vs what went in (price impact and fees).
        const amount = (10_000n * 10n ** BigInt(c.usdc!.decimals)).toString()
        const r = await cached(`kyber:${id}`, 60_000, () =>
          getJson<{ data?: { routeSummary?: { amountInUsd?: string; amountOutUsd?: string } } }>(
            `https://aggregator-api.kyberswap.com/${c.kyber}/api/v1/routes?tokenIn=${c.usdc!.address}&tokenOut=${address}&amountIn=${amount}`,
            { headers: { 'x-client-id': 'dex-builder' } },
          ),
        )
        const s = r.data?.routeSummary
        if (!s?.amountInUsd || !s.amountOutUsd) throw new Error('KyberSwap found no route')
        put('impact10k', 'kyberswap', (1 - Number(s.amountOutUsd) / Number(s.amountInUsd)) * 100)
      }),
    )
  const llamaKey = chain === 'coingecko' ? `coingecko:${address}` : c ? `${c.llama}:${address}` : null
  if (llamaKey)
    jobs.push(
      run('defillama', async () => {
        const r = await cached(`llama:${llamaKey}`, 60_000, () => getJson<{ coins: Record<string, { price?: number }> }>(`https://coins.llama.fi/prices/current/${llamaKey}`))
        const p = Object.values(r.coins ?? {})[0]?.price
        if (p == null) throw new Error('DefiLlama has no price for this token')
        put('price', 'defillama', p)
      }),
    )
  await Promise.all(jobs)
  // How far the DEX price is from DefiLlama's (a stale or manipulated price shows here).
  const llama = values.price?.defillama as number | undefined
  const dex = (values.price?.dexscreener ?? values.price?.geckoterminal ?? values.price?.jupiter) as number | undefined
  if (llama && dex) put('priceVsLlama', 'defillama', (dex / llama - 1) * 100)
  return { id, at: Date.now(), values, errors }
}

// ---------- the rotation engine's rules (saved), market rotation, Telegram ----------

const rulesFile = () => path.resolve(feedDir, 'rotation.json')
async function loadRules() {
  try {
    applyRules(JSON.parse(await fs.readFile(rulesFile(), 'utf8')))
  } catch {
    /* defaults */
  }
}
async function saveRules() {
  await fs.mkdir(feedDir, { recursive: true })
  await fs.writeFile(rulesFile(), JSON.stringify(RULES, null, 2))
}

/** Per chain: the pools gaining and losing capital, and the strongest flows between them (from the last evaluations). */
function marketRotation(chainFilter: string) {
  const byChain = new Map<string, (Evaluation & { token: Token })[]>()
  for (const e of rotationDetail.values()) if (!chainFilter || e.token.chain === chainFilter) (byChain.get(e.token.chain) ?? byChain.set(e.token.chain, []).get(e.token.chain)!).push(e)
  return {
    chains: [...byChain.entries()]
      .map(([chain, list]) => {
        const flows = new Map<string, { from: string; to: string; usd: number }>()
        for (const e of list)
          for (const peer of e.peers) {
            if (peer.inUsd > 0) flows.set(`${peer.symbol}>${e.token.symbol}`, { from: peer.symbol, to: e.token.symbol, usd: Math.max(flows.get(`${peer.symbol}>${e.token.symbol}`)?.usd ?? 0, peer.inUsd) })
            if (peer.outUsd > 0) flows.set(`${e.token.symbol}>${peer.symbol}`, { from: e.token.symbol, to: peer.symbol, usd: Math.max(flows.get(`${e.token.symbol}>${peer.symbol}`)?.usd ?? 0, peer.outUsd) })
          }
        const movers = list.filter((e) => e.market && e.market.net !== 0).map((e) => ({ token: e.token, net: e.market!.net, inUsd: e.market!.inUsd, outUsd: e.market!.outUsd }))
        return {
          chain,
          pools: list.length,
          rotatedUsd: list.reduce((s, e) => s + (e.market ? e.market.inUsd : 0), 0),
          gainers: movers.filter((m) => m.net > 0).sort((a, b) => b.net - a.net).slice(0, 8),
          losers: movers.filter((m) => m.net < 0).sort((a, b) => a.net - b.net).slice(0, 8),
          flows: [...flows.values()].sort((a, b) => b.usd - a.usd).slice(0, 12),
        }
      })
      .sort((a, b) => b.rotatedUsd - a.rotatedUsd),
  }
}

const telegramReady = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
async function telegram(text: string) {
  if (!telegramReady()) return { sent: false, error: 'Telegram isn’t set up: add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env' }
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    })
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string }
    return body.ok ? { sent: true } : { sent: false, error: body.description ?? `Telegram answered ${r.status}` }
  } catch (e) {
    return { sent: false, error: (e as Error).message }
  }
}

// ---------- the plugin ----------

const send = (res: ServerResponse, status: number, data: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

export function dataEngine(dir = 'data/history'): Plugin {
  return {
    name: 'data-engine',
    configResolved(config) {
      historyDir = path.resolve(config.root, dir)
      feedDir = path.resolve(config.root, path.dirname(dir), 'feed')
    },
    configureServer(server) {
      // Vite re-runs this file on every restart in the same process: stop the previous engine's timers
      // first, or every old collector keeps fetching and they share (and exhaust) the APIs' limits.
      const g = globalThis as { __dexEngineStop?: () => void }
      g.__dexEngineStop?.()
      // Watched tokens (on a Token / card, or selected in a Feed): DexScreener allows 300 lookups a minute.
      const timer = setInterval(() => recordWatched().catch((e) => console.warn('[engine] recording failed:', (e as Error).message)), 20_000)
      // The Feed's storage: every source on its own timer, from now until the server stops.
      tape = createTape(path.resolve(feedDir, '..', 'trades'))
      void tape.load()
      smart = createSmart(path.resolve(feedDir, '..', 'smart'))
      void smart.load()
      callLog = createCallLog(path.resolve(feedDir, '..', 'calls'))
      void callLog.load()
      void loadRules()
      const c = createCollector<MarketRow>({
        dir: feedDir,
        historyDir,
        sources: SOURCES,
        fetch: fetchSource,
        // How many tokens each enrichment covers now (the budget's "calls per minute" depends on it).
        count: (key, ctx) =>
          key === 'enrichJupiter' ? ctx.tokens().filter((t) => t.chain === 'solana').length : key === 'enrichLlama' ? ctx.tokens().length : key === 'tracked' ? ctx.tracked().length : 0,
      })
      collector = c
      void c.start()
      const stop = () => {
        clearInterval(timer)
        void c.stop()
        if (g.__dexEngineStop === stop) g.__dexEngineStop = undefined
      }
      g.__dexEngineStop = stop
      server.httpServer?.on('close', stop)
      server.middlewares.use('/api/engine', async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const p = url.searchParams
        const kind = url.pathname.replace(/^\//, '')
        try {
          if (kind === 'search') return send(res, 200, { rows: await dexSearch(p.get('q') ?? '', p.get('chain') ?? '') })
          if (kind === 'market') return send(res, 200, { rows: await market((p.get('ids') ?? '').split(',').filter(Boolean)) })
          if (kind === 'feed')
            return send(res, 200, feed((p.get('sources') ?? '').split(',').filter(Boolean), p.get('chain') ?? '', Math.min(2000, Number(p.get('limit')) || 100), p.get('selected') ?? ''))
          // Live: one event each time a source has fetched ({ source, at, ids }).
          if (kind === 'feed/events') return c.subscribe(res)
          // Tokens to track in full: { by: 'watchlist' | 'details', tokens: Token[] }.
          if (kind === 'feed/track' && req.method === 'POST') {
            let body = ''
            for await (const chunk of req) body += chunk
            const { by, tokens } = JSON.parse(body || '{}') as { by?: string; tokens?: Token[] }
            if (by) c.track(by, (tokens ?? []).filter((t) => t?.id && t.chain && t.address))
            return send(res, 200, { tracked: c.tracked().length })
          }
          if (kind === 'feed/config' && req.method === 'POST') {
            let body = ''
            for await (const chunk of req) body += chunk
            await c.configure(JSON.parse(body || '{}'))
            return send(res, 200, c.status())
          }
          if (kind === 'candles')
            return send(res, 200, await candles(p.get('id') ?? '', p.get('interval') ?? '15m', Math.min(1000, Number(p.get('limit')) || 100), p.get('pool') ?? ''))
          if (kind === 'safety') {
            // `skip`: services switched off in the Safety block's panel (they aren't asked).
            const skip = (p.get('skip') ?? '').split(',').filter(Boolean).sort()
            return send(res, 200, await cached(`safety:${p.get('id')}:${skip.join(',')}`, 10 * 60_000, () => safety(p.get('id') ?? '', skip)))
          }
          if (kind === 'history') {
            // `hours` back from now (so the request stays the same while time passes), or an exact `since`.
            const since = p.get('hours') ? Date.now() - Number(p.get('hours')) * 3600e3 : Number(p.get('since')) || 0
            return send(res, 200, { points: await history(p.get('id') ?? '', p.get('metric') ?? 'price', since) })
          }
          if (kind === 'details') return send(res, 200, await details(p.get('id') ?? '', p.get('pool') ?? ''))
          // The rotation engine's rules: GET them, POST a change (saved), POST {reset: true} for the defaults.
          if (kind === 'rotation/config') {
            if (req.method === 'POST') {
              let body = ''
              for await (const chunk of req) body += chunk
              const patch = JSON.parse(body || '{}')
              if (patch.reset) resetRules()
              else applyRules(patch)
              await saveRules()
            }
            return send(res, 200, { rules: RULES, defaults: DEFAULT_RULES, engines: ENGINES, frames: TIME_FRAMES })
          }
          // Market rotation, per chain: where capital is going between the sampled pools.
          if (kind === 'rotation/market') return send(res, 200, marketRotation(p.get('chain') ?? ''))
          // The evaluation: per engine, how its calls did; and the latest calls (one token's with ?id=).
          if (kind === 'evaluation') {
            const id = p.get('id') ?? undefined
            const recent = callLog?.recent(Number(p.get('n')) || 100, id) ?? []
            return send(res, 200, { token: id ?? null, summary: callLog?.summary(id) ?? {}, recent, logged: id ? recent.length : (callLog?.count() ?? 0) })
          }
          // Smart wallets: what's been learned, and a chain's list.
          if (kind === 'smart') return send(res, 200, { ...(smart?.stats() ?? {}), wallets: smart?.list(p.get('chain') ?? 'solana').slice(0, 200) ?? [] })
          // Telegram: POST { title, text } (needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID); GET says if it's set up.
          if (kind === 'notify') {
            if (req.method !== 'POST') return send(res, 200, { telegram: telegramReady() })
            let body = ''
            for await (const chunk of req) body += chunk
            const { title, text } = JSON.parse(body || '{}') as { title?: string; text?: string }
            return send(res, 200, await telegram(`${title ? `*${title}*\n` : ''}${text ?? ''}`))
          }
          // The rotation engine: one token's full evaluation, or every evaluated token, best first.
          if (kind === 'rotation') {
            if (p.get('id')) return send(res, 200, rotationDetail.get(p.get('id')!) ?? null)
            const list = [...rotationDetail.values()].sort((a, b) => (b.scores.quality.score ?? -1) - (a.scores.quality.score ?? -1))
            const chainFilter = p.get('chain')
            return send(res, 200, {
              engine: RULES.engine,
              engines: ENGINES,
              coverage: tape?.stats() ?? {},
              smart: smart?.stats() ?? null,
              tokens: list
                .filter((e) => !chainFilter || e.token.chain === chainFilter)
                .map((e) => ({ token: e.token, phase: e.phase.phase, call: e.calls[RULES.engine] ?? e.calls[e.engine], calls: Object.fromEntries(Object.entries(e.calls).map(([k, c]) => [k, c.call])), scores: Object.fromEntries(Object.entries(e.scores).map(([k, v]) => [k, v.score])), rotation: e.rotation, market: e.market, costPct: e.costPct, plan: e.plan, at: e.at })),
            })
          }
          // The trade tape: what's held per chain, or one pool's trades.
          if (kind === 'trades')
            return send(res, 200, p.get('pool') ? (tape?.pool(p.get('chain') ?? 'solana', p.get('pool')!) ?? null) : { chains: tape?.stats() ?? {} })
          if (kind === 'chains') return send(res, 200, { chains: CHAINS.map((c) => ({ id: c.id, label: c.label })) })
          send(res, 404, { error: `Unknown engine request: ${kind}` })
        } catch (e) {
          send(res, e instanceof RateLimited ? 429 : 502, { error: (e as Error).message })
        }
      })
    },
  }
}
