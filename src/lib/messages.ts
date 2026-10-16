import type { Message } from '../blocks/types'
import { compactNumber, money, moneyCompact, percent } from './format'

/**
 * One token as a list item — the shape cards send on their `data` and `list` outlets, and accept on
 * their `token` inlet, so a list from one card can drive another.
 */
export interface TokenItem {
  [key: string]: Message | undefined
  source: 'coingecko' | 'dexscreener'
  symbol: string
  name: string
  /** CoinGecko coin id */
  id?: string
  /** Contract address (DexScreener) */
  address?: string
  chain?: string
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

export const isBang = (msg: Message) => msg === 'bang'

/** What a card sends out of its `error` outlet when a lookup fails. */
export const errorMessage = (source: TokenItem['source'], token: string, error: string): Message => ({ source, token, error })

export const isObject = (msg: Message): msg is { [key: string]: Message | undefined } =>
  typeof msg === 'object' && msg !== null && !Array.isArray(msg)

export const isTokenItem = (msg: Message): msg is TokenItem =>
  isObject(msg) && (msg.source === 'coingecko' || msg.source === 'dexscreener') && typeof msg.symbol === 'string'

/** One line for a list row. */
export function describeItem(item: Message): string {
  if (isTokenItem(item)) {
    const rank = item.rank ? `#${item.rank} ` : ''
    const where = item.chain ? ` · ${item.chain}` : ''
    return `${rank}${item.symbol.toUpperCase()} ${item.name}${where}  ${money(item.price ?? null)}  ${percent(item.change24h ?? null)}`
  }
  if (isObject(item)) return Object.entries(item).map(([k, v]) => `${k}: ${describeValue(v)}`).join(' · ')
  if (Array.isArray(item)) return `list · ${item.length} items`
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
  if (Array.isArray(v)) return `list · ${v.length} items`
  if (isObject(v)) return Object.entries(v).map(([k, x]) => `${k} ${describeValue(x, k)}`).join(', ')
  return String(v)
}

/** Short summary used as a message box's text when it holds structured data. */
export function summarize(msg: Message): string {
  if (Array.isArray(msg)) return `list · ${msg.length} item${msg.length === 1 ? '' : 's'}`
  if (isTokenItem(msg)) return describeItem(msg)
  if (isObject(msg)) return `${Object.keys(msg).length} fields`
  return String(msg)
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
