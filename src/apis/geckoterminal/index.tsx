import { chainById } from '../../services/chains'
import { moneyCompact, percent, usdPrice } from '../../lib/format'
import { getJson, makeApiCard, num, type ApiCardProps, type ApiResult, type Row } from '../shared/makeApiCard'

/**
 * GeckoTerminal (CoinGecko's DEX data): OHLCV candles for a token's pool — open, high, low, close and
 * volume per period. `list` is one dated row per candle, oldest first, in the same shape as a Storage's
 * history ({ at, data }), so it wires straight into a Chart (Candles style draws the real candles).
 * Free, no key — but only a few requests a minute, so the card spaces them out.
 */
type Props = ApiCardProps & {
  /** The pool to chart ('' = the token's deepest pool). DexScreener rows bring theirs. */
  pair: string
  /** Candle size. */
  candle: string
  /** How many candles. */
  count: number
}

const API = 'https://api.geckoterminal.com/api/v2'

const CANDLES: { value: string; label: string; tf: 'minute' | 'hour' | 'day'; aggregate: number }[] = [
  { value: '1m', label: '1 minute', tf: 'minute', aggregate: 1 },
  { value: '5m', label: '5 minutes', tf: 'minute', aggregate: 5 },
  { value: '15m', label: '15 minutes', tf: 'minute', aggregate: 15 },
  { value: '1h', label: '1 hour', tf: 'hour', aggregate: 1 },
  { value: '4h', label: '4 hours', tf: 'hour', aggregate: 4 },
  { value: '12h', label: '12 hours', tf: 'hour', aggregate: 12 },
  { value: '1d', label: '1 day', tf: 'day', aggregate: 1 },
]

// GeckoTerminal's free tier allows only a few calls a minute: one request at a time, a few seconds apart,
// and after a rate-limit answer everything waits half a minute and tries once more.
const GAP_MS = 4000
const BACKOFF_MS = 30_000
let queue: Promise<unknown> = Promise.resolve()
let pausedUntil = 0
function spaced<T>(job: () => Promise<T>): Promise<T> {
  const attempt = async (retry: boolean): Promise<T> => {
    const wait = pausedUntil - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    try {
      return await job()
    } catch (e) {
      if (!retry || !/rate limit/i.test((e as Error).message)) throw e
      pausedUntil = Date.now() + BACKOFF_MS
      return attempt(false)
    }
  }
  const run = queue.then(() => attempt(true))
  const next = () => new Promise((r) => setTimeout(r, GAP_MS))
  queue = run.then(next, next)
  return run
}

/** The deepest pool of a token, per network + token (pools don't change often). */
const poolCache = new Map<string, { address: string; name: string }>()

interface PoolList {
  data: { attributes: { address: string; name: string; reserve_in_usd: string | null } }[]
}
interface Ohlcv {
  data: { attributes: { ohlcv_list: [number, number, number, number, number, number][] } }
  meta?: { base?: { symbol?: string; name?: string } }
}

export const geckoterminal = makeApiCard<Props>({
  type: 'geckoterminal',
  label: 'GeckoTerminal',
  description: 'OHLCV candles for a DEX token — wire into a Chart',
  icon: '🦎',
  source: 'GeckoTerminal',
  defaultProps: { token: '', chain: 'solana', label: '', refreshSec: 0, pair: '', candle: '15m', count: 100 },
  chains: ['solana', 'ethereum', 'bsc', 'base', 'arbitrum', 'polygon', 'avalanche', 'optimism'],
  needsToken: () => true,
  tokenHelp: 'a token address (its deepest pool is used), or a token row from a card (DexScreener rows bring their pool)',
  dataLabel: 'data — the range: last close, change over the candles, total volume, high / low, the pool',
  listLabel: 'list — the candles, oldest first: one dated row each with open, high, low, close, volume (price = close) — wire into a Chart',
  settings: () => [
    { key: 'candle', label: 'Candle size', type: 'select', options: CANDLES.map(({ value, label }) => ({ value, label })) },
    { key: 'count', label: 'Candles', type: 'number', min: 2, max: 1000, help: 'How many candles back from now (up to 1000).' },
    { key: 'pair', label: 'Pool', type: 'text', placeholder: 'empty = the token’s deepest pool', help: 'A specific pool / pair address to chart. Filled in by a DexScreener row.' },
  ],
  fetch: async ({ token, chain, pair }, props): Promise<ApiResult> => {
    const c = chainById(chain)
    if (!c) throw new Error(`GeckoTerminal doesn't cover ${chain}`)
    const candle = CANDLES.find((x) => x.value === props.candle) ?? CANDLES[2]
    const limit = Math.min(1000, Math.max(2, Math.floor(Number(props.count) || 100)))

    // The pool: the one given (a DexScreener pair), else the token's deepest.
    let pool = pair ? { address: pair, name: '' } : poolCache.get(`${c.gecko}:${token}`)
    if (!pool) {
      const pools = await spaced(() => getJson<PoolList>(`${API}/networks/${c.gecko}/tokens/${token}/pools?page=1`, 'GeckoTerminal'))
      const best = [...pools.data].sort((a, b) => Number(b.attributes.reserve_in_usd ?? 0) - Number(a.attributes.reserve_in_usd ?? 0))[0]
      if (!best) throw new Error('GeckoTerminal has no pool for this token')
      pool = { address: best.attributes.address, name: best.attributes.name }
      poolCache.set(`${c.gecko}:${token}`, pool)
    }

    const o = await spaced(() =>
      getJson<Ohlcv>(`${API}/networks/${c.gecko}/pools/${pool!.address}/ohlcv/${candle.tf}?aggregate=${candle.aggregate}&limit=${limit}&currency=usd`, 'GeckoTerminal'),
    )
    // Newest first from the API → oldest first, like a history.
    const rows = [...o.data.attributes.ohlcv_list].reverse()
    if (!rows.length) throw new Error('No candles for this pool yet')
    const list: Row[] = rows.map(([t, open, high, low, close, volume]) => ({
      at: new Date(t * 1000).toISOString(),
      type: 'table',
      data: { price: close, open, high, low, close, volume },
    }))
    const first = rows[0][1]
    const last = rows[rows.length - 1][4]
    const data: Row = {
      source: 'geckoterminal',
      symbol: o.meta?.base?.symbol ?? null,
      name: o.meta?.base?.name ?? null,
      chain,
      address: token,
      pool: pool.address,
      poolName: pool.name || null,
      candle: candle.value,
      candles: rows.length,
      price: last,
      change: first ? (last / first - 1) * 100 : null,
      high: Math.max(...rows.map((r) => r[2])),
      low: Math.min(...rows.map((r) => r[3])),
      volume: rows.reduce((n, r) => n + r[5], 0),
      from: list[0].at,
      to: list[list.length - 1].at,
    }
    return { data, list }
  },
  headline: ({ data }) =>
    data ? { text: `${data.symbol ?? 'Token'} · ${data.candles} × ${data.candle} candles`, tone: (num(data.change) ?? 0) >= 0 ? 'good' : 'bad' } : null,
  lines: ({ data }) => {
    if (!data) return []
    const change = num(data.change)
    return [
      ['Last close', usdPrice(num(data.price))],
      ['Change over the range', percent(change), (change ?? 0) >= 0 ? 'good' : 'bad'],
      ['High', usdPrice(num(data.high))],
      ['Low', usdPrice(num(data.low))],
      ['Volume', moneyCompact(num(data.volume))],
      ['Pool', String(data.poolName || data.pool)],
    ]
  },
})
