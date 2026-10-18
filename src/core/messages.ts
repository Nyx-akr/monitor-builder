import type { Message } from '../blocks/types'
import { compactNumber, money, moneyCompact, percent } from '../lib/format'

/**
 * One token as a list item — the shape cards send on their `data` and `list` outlets, and accept on
 * their `token` inlet, so a list from one card can drive another.
 */
/** The APIs whose rows are tokens (other cards can take them as a token). */
export const TOKEN_SOURCES = ['coingecko', 'dexscreener', 'jupiter', 'defillama', 'geckoterminal'] as const
export type TokenSource = (typeof TOKEN_SOURCES)[number]

export interface TokenItem {
  [key: string]: Message | undefined
  /** Every token row is a Token (see Token below). */
  kind?: 'token'
  source: TokenSource
  symbol: string
  name: string
  /** CoinGecko coin id */
  id?: string | null
  /** Contract address (null for native coins like BTC) */
  address?: string | null
  chain?: string | null
  /** Pair address (DexScreener) */
  pair?: string
  dex?: string
  rank?: number | null
  price?: number | null
  change24h?: number | null
  marketCap?: number | null
  volume24h?: number | null
  liquidity?: number | null
  url?: string
}

export type ListItemFields = Pick<TokenItem, 'source' | 'symbol' | 'name'> &
  Partial<Pick<TokenItem, 'price' | 'change24h' | 'marketCap' | 'volume24h' | 'liquidity' | 'chain' | 'address' | 'pair' | 'id' | 'url' | 'logo'>>

/**
 * The one shape every card's `list` item has — DexScreener and CoinGecko alike: the same fields in the
 * same order, null where a source has no value (CoinGecko has no chain or liquidity, DexScreener no coin id).
 * So a Get, Condition or the Page's token selector works the same whichever card the list came from.
 */
export function listItem(f: ListItemFields): TokenItem {
  return {
    kind: 'token',
    source: f.source,
    symbol: f.symbol.toUpperCase(),
    name: f.name,
    price: f.price ?? null,
    change24h: f.change24h ?? null,
    marketCap: f.marketCap ?? null,
    volume24h: f.volume24h ?? null,
    liquidity: f.liquidity ?? null,
    chain: f.chain ?? null,
    address: f.address ?? null,
    pair: f.pair ?? null,
    id: f.id ?? null,
    url: f.url ?? null,
    logo: f.logo ?? null,
  } as TokenItem
}

export const isBang = (msg: Message) => msg === 'bang'

/** What a card sends out of its `error` outlet when a lookup fails. */
export const errorMessage = (source: TokenItem['source'], token: string, error: string): Message => ({ source, token, error })

export const isObject = (msg: Message): msg is { [key: string]: Message | undefined } =>
  typeof msg === 'object' && msg !== null && !Array.isArray(msg)

/**
 * A Token: which token, with what it takes to look it up anywhere — chain + contract address (plus symbol,
 * name, pool, logo, and a market snapshot when a card sent it). Marked kind: 'token'.
 */
export interface Token {
  [key: string]: Message | undefined
  kind: 'token'
  chain: string
  address: string
  symbol: string
  name: string
  pool?: string | null
  logo?: string | null
  /** CoinGecko's id, when known (CoinGecko rows). */
  id?: string | null
  source?: string
}

export const isToken = (msg: Message | undefined): msg is Token =>
  isObject(msg as Message) && (msg as Token).kind === 'token' && typeof (msg as Token).symbol === 'string'

/** OHLCV candles: a history whose rows' data has open / high / low / close (+ volume) — GeckoTerminal, CoinGecko OHLC. */
export const isOhlcv = (msg: Message | undefined): boolean =>
  isHistory(msg) &&
  (msg as { data: Message }[]).every((r) => {
    const d = r.data as Record<string, unknown> | null
    return isObject(r.data) && typeof d?.open === 'number' && typeof d?.high === 'number' && typeof d?.low === 'number' && typeof d?.close === 'number'
  })

/** A history: dated rows ({ at, data }), oldest first — a Storage's history, a price history. */
export const isHistory = (msg: Message | undefined): boolean =>
  Array.isArray(msg) && msg.length > 0 && msg.every((r) => isObject(r) && typeof (r as { at?: unknown }).at === 'string' && 'data' in (r as object))

export const isTokenItem = (msg: Message): msg is TokenItem =>
  isObject(msg) && TOKEN_SOURCES.includes(msg.source as TokenSource) && typeof msg.symbol === 'string'

/** One line for a list row. */
export function describeItem(item: Message): string {
  if (isTokenItem(item)) {
    const rank = item.rank ? `#${item.rank} ` : ''
    const where = item.chain ? ` · ${item.chain}` : ''
    return `${rank}${item.symbol.toUpperCase()} ${item.name}${where}  ${money(item.price ?? null)}  ${percent(item.change24h ?? null)}`
  }
  if (isObject(item)) return Object.entries(item).map(([k, v]) => `${k}: ${describeValue(v)}`).join(' · ')
  if (Array.isArray(item)) return tableSize(item)
  return String(item)
}

/** A value inside an object, formatted for reading (large numbers compacted, USD-ish keys as money). */
export function describeValue(v: Message | undefined, key = ''): string {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'number') {
    // Check percentages first: "marketCapChange24h" is a % even though it mentions "cap".
    if (/dominance/i.test(key)) return `${v.toFixed(2)}%`
    if (/change/i.test(key)) return percent(v)
    if (/price|cap|volume|liquidity|^ath$/i.test(key)) return Math.abs(v) >= 1e4 ? moneyCompact(v) : money(v)
    return Math.abs(v) >= 1e5 ? compactNumber(v) : v.toLocaleString('en-US', { maximumFractionDigits: 6 })
  }
  if (Array.isArray(v)) return tableSize(v)
  if (isObject(v)) return Object.entries(v).map(([k, x]) => `${k} ${describeValue(x, k)}`).join(', ')
  return String(v)
}

/** "table · 250 rows" — a table with many rows (a list). */
export const tableSize = (rows: Message[]) => `table · ${rows.length} row${rows.length === 1 ? '' : 's'}`

/** Short summary used as a message box's text when it holds a table: many rows, one token, or one row. */
export function summarize(msg: Message): string {
  if (isHistory(msg)) return `history · ${(msg as Message[]).length} points`
  if (Array.isArray(msg)) return tableSize(msg)
  if (isTokenItem(msg)) return describeItem(msg)
  if (isObject(msg)) return `table · 1 row · ${Object.keys(msg).length} fields`
  return String(msg)
}

/** Summaries from before tables (list / dict), so message boxes saved then still show their data. */
export function legacySummaries(msg: Message): string[] {
  if (Array.isArray(msg)) return [`list · ${msg.length} item${msg.length === 1 ? '' : 's'}`, tableSize(msg)]
  if (isObject(msg) && !isTokenItem(msg)) return [`${Object.keys(msg).length} fields`]
  return []
}

/** For logs: structured messages as JSON, truncated. */
export const logText = (msg: Message) => (typeof msg === 'object' && msg !== null ? JSON.stringify(msg).slice(0, 80) : String(msg))

const lastEmit = new Map<string, { key: string; at: number }>()

/**
 * Send `msg` out of `outlet`, unless this block already sent the same `key` there in the last
 * `windowMs` — a token arriving on an inlet and the card's own reload both report the same data,
 * and it should go down the wire once. `force` (e.g. on bang) always sends.
 */
export function emitOnce(
  ctx: { id: string; send: (outlet: string, msg: Message) => void },
  outlet: string,
  key: string,
  msg: Message,
  force = false,
  windowMs = 3000,
) {
  const id = `${ctx.id}:${outlet}`
  const last = lastEmit.get(id)
  if (!force && last && last.key === key && Date.now() - last.at < windowMs) return
  lastEmit.set(id, { key, at: Date.now() })
  ctx.send(outlet, msg)
}
