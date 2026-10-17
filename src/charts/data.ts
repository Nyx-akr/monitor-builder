import type { Message } from '../blocks/types'
import { isObject } from '../core/messages'
import { parseNumber } from '../lib/parseNumber'
import { CANDLE_SIZES, MAX_LINES } from './options'
import type { Candle, Point, Series } from './types'

/** How many tokens get a line when no tokens are named: the first ones of the newest list. */
export const DEFAULT_TOKENS = 3
/** Points kept per line (the oldest go first). */
export const MAX_POINTS = 1000

/** Saved points (JSON) → lines. Older saves had one array per input. */
export function parseSeries(json: string, inletId: (i: number) => string): Series {
  try {
    const v = JSON.parse(json || '{}')
    if (Array.isArray(v)) return Object.fromEntries(v.map((pts, i) => [inletId(i), pts ?? []]))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** The number to plot from one value: a number, number text ("$1.02M"), or a dict's chosen field. */
export function valueOf(data: Message | undefined, field: string): number | null {
  if (data === undefined || data === null) return null
  if (isObject(data)) return parseNumber((data as Record<string, Message>)[field || 'price'])
  return parseNumber(data)
}

type TokenRow = { symbol: string; [k: string]: Message | undefined }
const isRecord = (m: Message): m is { at: string; data: Message } => isObject(m) && typeof (m as { at?: unknown }).at === 'string' && 'data' in (m as object)
const isTokenList = (m: Message | undefined): m is TokenRow[] =>
  Array.isArray(m) && m.length > 0 && m.every((x) => isObject(x) && typeof (x as TokenRow).symbol === 'string')

/** Which tokens to draw: the named ones ("NUBI, DAWG"), or the first few of the newest list. */
function wantedTokens(named: string, newest: TokenRow[] | undefined): string[] {
  const list = named.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
  if (list.length) return list.slice(0, MAX_LINES)
  return (newest ?? []).slice(0, DEFAULT_TOKENS).map((t) => t.symbol.toUpperCase())
}

/**
 * Lines from what arrived on one input (`inlet`):
 * - a Storage's history (list of { at, data }) → one point per batch, at the time it was stored. A batch
 *   that's a number / dict feeds the input's own line (or its token's line); a list of tokens, one line per token.
 * - a list of tokens (e.g. a card's live list) → one point now for each chosen token
 * - a list of numbers → evenly spaced, one second apart, ending now
 * - a single number / dict → one new point now
 * Returns [lines, replace?]: a history (or list of numbers) replaces this input's lines; anything else is added.
 */
export function toLines(inlet: string, msg: Message, field: string, tokens: string): [Series, boolean] {
  const now = Date.now()
  const out: Series = {}
  const push = (key: string, t: number, v: number | null, ohl?: [number, number, number]) => {
    if (v === null || !Number.isFinite(t)) return
    ;(out[key] ??= []).push(ohl ? [t, v, ...ohl] : [t, v])
  }
  /** A row with open / high / low (an OHLCV candle) keeps them, so the chart can draw the real candle. */
  const ohlOf = (data: Message | undefined): [number, number, number] | undefined => {
    if (!isObject(data as Message)) return undefined
    const r = data as Record<string, Message>
    const [o, h, l] = [parseNumber(r.open), parseNumber(r.high), parseNumber(r.low)]
    return o !== null && h !== null && l !== null ? [o, h, l] : undefined
  }
  // One token's details (a card's data) is drawn under its symbol — the same line as that token from a list.
  // When tokens are chosen (named, or the first ones of the lists), other tokens are left out.
  let only: string[] = []
  const pushValue = (t: number, data: Message | undefined) => {
    const sym = isObject(data as Message) && typeof (data as TokenRow).symbol === 'string' ? (data as TokenRow).symbol.toUpperCase() : null
    if (sym && only.length && !only.includes(sym)) return
    push(sym ? `${inlet}:${sym}` : inlet, t, valueOf(data, field), ohlOf(data))
  }
  const pickTokens = (t: number, list: TokenRow[], wanted: string[]) => {
    for (const sym of wanted) push(`${inlet}:${sym}`, t, valueOf(list.find((x) => x.symbol.toUpperCase() === sym), field))
  }

  if (isTokenList(msg)) {
    pickTokens(now, msg, wantedTokens(tokens, msg))
    return [out, false]
  }
  if (Array.isArray(msg)) {
    const records = msg.filter(isRecord)
    if (records.length) {
      const newestList = [...records].reverse().find((r) => isTokenList(r.data))?.data as TokenRow[] | undefined
      const wanted = wantedTokens(tokens, newestList)
      only = wanted
      for (const r of records) {
        const t = Date.parse(r.at)
        if (isTokenList(r.data)) pickTokens(t, r.data, wanted)
        else pushValue(t, r.data)
      }
    } else msg.forEach((item, i) => push(inlet, now - (msg.length - 1 - i) * 1000, valueOf(item, field)))
    for (const k of Object.keys(out)) out[k].sort((a, b) => a[0] - b[0])
    return [out, true]
  }
  only = wantedTokens(tokens, undefined)
  pushValue(now, msg)
  return [out, false]
}

/**
 * Merge what arrived on one input into the chart's lines. A history replaces that input's lines — unless
 * it starts after everything the input already has (e.g. a Storage sending just its newest batch): then
 * it's added on, so the older history stays.
 */
export function mergeLines(current: Series, inlet: string, incoming: Series, replace: boolean): Series {
  const next: Series = { ...current }
  const ownKeys = Object.keys(next).filter((k) => k === inlet || k.startsWith(`${inlet}:`))
  const newestHeld = Math.max(-Infinity, ...ownKeys.flatMap((k) => next[k].map((p) => p[0])))
  const oldestIncoming = Math.min(Infinity, ...Object.values(incoming).flatMap((pts) => pts.map((p) => p[0])))
  // (An empty history still replaces: the Storage has nothing in that span, so neither does the chart.)
  if (replace && Number.isFinite(oldestIncoming) && oldestIncoming > newestHeld) replace = false
  if (replace) for (const k of ownKeys) delete next[k]
  for (const [k, pts] of Object.entries(incoming)) next[k] = (replace ? pts : [...(next[k] ?? []), ...pts]).slice(-MAX_POINTS)
  return next
}

/**
 * The candle period: the chosen one, or (auto) one giving up to 40 candles with about 4 points each —
 * so each candle has a real open / high / low / close rather than a single value.
 */
export function candlePeriod(size: string, spanMs: number, pointsPerLine = 160): number {
  const chosen = CANDLE_SIZES.find((c) => c.value === size && c.ms > 0)
  if (chosen) return chosen.ms
  const count = Math.min(40, Math.max(5, Math.round(pointsPerLine / 4)))
  const target = spanMs / count
  const fits = CANDLE_SIZES.filter((c) => c.ms > 0)
  return fits.reduce((best, c) => (Math.abs(Math.log(c.ms / target)) < Math.abs(Math.log(best.ms / target)) ? c : best), fits[0]).ms
}

/** Points → candles: one per period that has points, from its first, highest, lowest and last value. */
export function toCandles(points: Point[], periodMs: number): Candle[] {
  const candles: Candle[] = []
  for (const [t, v] of points) {
    const start = Math.floor(t / periodMs) * periodMs
    const last = candles[candles.length - 1]
    if (last && last.t === start) {
      last.high = Math.max(last.high, v)
      last.low = Math.min(last.low, v)
      last.close = v
    } else candles.push({ t: start, open: v, high: v, low: v, close: v })
  }
  return candles
}
