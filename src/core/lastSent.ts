import type { Message } from '../blocks/types'
import { describeItem, describeValue, isHistory, isObject, isToken, isTokenItem } from './messages'

/**
 * What each outlet sent most recently — shown when hovering it, so you can see the data that's actually
 * coming out (e.g. "table · 250 rows: BTC, ETH, USDT…") rather than only a description.
 */
const sent = new Map<string, { msg: Message; at: number }>()
const key = (block: string, port: string) => `${block}|${port}`

export function recordSent(block: string, port: string, msg: Message) {
  sent.set(key(block, port), { msg, at: Date.now() })
}

/** Forget an outlet's last message — e.g. a card's data once its token is cleared, so hover doesn't show the old token. */
export function forgetSent(block: string, port: string) {
  sent.delete(key(block, port))
}

export function lastSent(block: string, port: string) {
  return sent.get(key(block, port))
}

const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A few readable lines describing a message. */
export function previewLines(msg: Message): string[] {
  if (msg === 'bang') return ['a signal (no data — a blank token)']
  if (typeof msg === 'number') return [describeValue(msg)]
  if (typeof msg === 'string') return [`“${short(msg)}”`]
  if (isHistory(msg)) {
    const rows = msg as { at: string }[]
    return [`history · ${rows.length} point${rows.length === 1 ? '' : 's'}`, `${timeOf(Date.parse(rows[0].at))} → ${timeOf(Date.parse(rows[rows.length - 1].at))}`]
  }
  if (isToken(msg)) return [`token · ${msg.symbol} · ${msg.name}${msg.chain ? ` · ${msg.chain}` : ''}`, msg.address ? String(msg.address) : 'no contract address']
  if (Array.isArray(msg)) {
    const names = msg.slice(0, 4).map((item) =>
      isTokenItem(item)
        ? item.symbol.toUpperCase()
        : // A storage's history record: show when it was stored.
          isObject(item) && typeof item.at === 'string' && 'data' in item
          ? timeOf(Date.parse(item.at))
          : short(describeItem(item), 16),
    )
    return [`table · ${msg.length} row${msg.length === 1 ? '' : 's'}`, names.length ? `${names.join(', ')}${msg.length > 4 ? ', …' : ''}` : '(empty)']
  }
  if (isObject(msg)) {
    const entries = Object.entries(msg).filter(([, v]) => v !== undefined && v !== null)
    const head = isTokenItem(msg) ? `${msg.symbol} · ${msg.name}${msg.chain ? ` · ${msg.chain}` : ''}` : `table · 1 row · ${entries.length} fields`
    const lines = entries
      .filter(([k]) => !['source', 'symbol', 'name', 'address', 'pair', 'url'].includes(k))
      .slice(0, 4)
      .map(([k, v]) => `${k}: ${short(describeValue(v, k), 30)}`)
    return [head, ...lines]
  }
  return [String(msg)]
}

export const timeOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
