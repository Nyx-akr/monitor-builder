import { chainById } from '../../services/chains'
import { listItem } from '../../core/messages'
import { moneyCompact, percent, usdPrice } from '../../lib/format'
import { getJson, makeApiCard, num, type ApiCardProps, type ApiResult, type Line, type Row } from '../shared/makeApiCard'

/**
 * DefiLlama: a token's price with its price history (ready to wire into a Chart), or the market's big
 * picture — chains by TVL, protocols by TVL, DEXes by 24h volume. Free, no key: coins.llama.fi, api.llama.fi.
 */
type Props = ApiCardProps & {
  /** 'price' (a token) · 'chains' · 'protocols' · 'dexs'. */
  mode: string
  /** How many rows the rankings send. */
  top: number
  /** How far back the price history goes, in days. */
  historyDays: number
}

const MODES = [
  { value: 'price', label: 'Token price + history' },
  { value: 'chains', label: 'Chains by TVL' },
  { value: 'protocols', label: 'Protocols by TVL' },
  { value: 'dexs', label: 'DEXes by 24h volume' },
]

/** A token as DefiLlama names it: chain:address, or coingecko:<id> for a CoinGecko row. */
function coinKey(token: string, chain: string): string {
  if (token.includes(':')) return token
  const c = chainById(chain)
  if (/^0x[0-9a-fA-F]{40}$/.test(token) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)) return `${c?.llama ?? chain}:${token}`
  return `coingecko:${token.toLowerCase()}`
}

export const defillama = makeApiCard<Props>({
  type: 'defillama',
  label: 'DefiLlama',
  description: 'Token prices + history · TVL and DEX volume rankings',
  icon: '🦙',
  source: 'DefiLlama',
  defaultProps: { token: '', chain: 'ethereum', label: '', refreshSec: 0, mode: 'price', top: 25, historyDays: 1 },
  chains: ['ethereum', 'solana', 'bsc', 'base', 'arbitrum', 'polygon', 'avalanche', 'optimism'],
  needsToken: (props) => props.mode === 'price',
  tokenHelp: 'a contract address, a CoinGecko id (bitcoin), chain:address, or a token row from a card',
  dataLabel: 'data — Token price: the token (symbol, price, confidence) · rankings: a summary (rows, total)',
  listLabel: 'list — Token price: its price history as dated rows (wire it into a Chart) · rankings: one row per chain / protocol / DEX',
  settings: (props) => [
    { key: 'mode', label: 'What to fetch', type: 'select', options: MODES },
    ...(props.mode === 'price'
      ? [{ key: 'historyDays', label: 'History (days)', type: 'number' as const, min: 1, max: 365, help: 'How far back the price history in list goes (hourly up to 7 days, daily after).' }]
      : [{ key: 'top', label: 'Top', type: 'number' as const, min: 1, max: 500, help: 'How many rows the ranking sends.' }]),
  ],
  fetch: async ({ token, chain }, props): Promise<ApiResult> => {
    const top = Math.max(1, Math.floor(Number(props.top) || 25))
    if (props.mode === 'chains') {
      const chains = await getJson<{ name: string; tokenSymbol: string | null; tvl: number }[]>('https://api.llama.fi/v2/chains', 'DefiLlama')
      const list = [...chains].sort((a, b) => b.tvl - a.tvl).slice(0, top).map((c) => ({ name: c.name, symbol: c.tokenSymbol, tvl: c.tvl }))
      return { data: { source: 'defillama', ranking: 'chains', rows: list.length, totalTvl: list.reduce((n, c) => n + c.tvl, 0) }, list }
    }
    if (props.mode === 'protocols') {
      const ps = await getJson<{ name: string; symbol: string; category: string; tvl: number; change_1d?: number; change_7d?: number; chains: string[] }[]>(
        'https://api.llama.fi/protocols',
        'DefiLlama',
      )
      const list = ps
        .filter((p) => p.category !== 'CEX')
        .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
        .slice(0, top)
        .map((p) => ({ name: p.name, symbol: p.symbol === '-' ? null : p.symbol, category: p.category, tvl: p.tvl, change1d: p.change_1d ?? null, change7d: p.change_7d ?? null, chains: p.chains.length }))
      return { data: { source: 'defillama', ranking: 'protocols', rows: list.length, totalTvl: list.reduce((n, p) => n + (p.tvl ?? 0), 0) }, list }
    }
    if (props.mode === 'dexs') {
      const d = await getJson<{ protocols: { name: string; total24h: number | null; change_1d: number | null; chains: string[] }[]; total24h: number }>(
        'https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true',
        'DefiLlama',
      )
      const list = d.protocols
        .filter((p) => p.total24h)
        .sort((a, b) => (b.total24h ?? 0) - (a.total24h ?? 0))
        .slice(0, top)
        .map((p) => ({ name: p.name, volume24h: p.total24h, change1d: p.change_1d, chains: p.chains.length }))
      return { data: { source: 'defillama', ranking: 'dexs', rows: list.length, totalVolume24h: d.total24h }, list }
    }

    // Token price, and its history as dated rows — the shape a Storage's history has, so a Chart draws it.
    const key = coinKey(token, chain)
    const days = Math.min(365, Math.max(1, Math.floor(Number(props.historyDays) || 1)))
    const [now, chart] = await Promise.all([
      getJson<{ coins: Record<string, { symbol: string; price: number; confidence: number; timestamp: number }> }>(`https://coins.llama.fi/prices/current/${key}`, 'DefiLlama'),
      getJson<{ coins: Record<string, { prices: { timestamp: number; price: number }[] }> }>(
        `https://coins.llama.fi/chart/${key}?span=${days <= 7 ? days * 24 : days}&period=${days <= 7 ? '1h' : '1d'}`,
        'DefiLlama',
      ),
    ])
    const coin = now.coins[key]
    if (!coin) throw new Error(`DefiLlama has no price for ${key}`)
    const history = chart.coins[key]?.prices ?? []
    const first = history[0]?.price
    const data: Row = {
      ...listItem({
        source: 'defillama',
        symbol: coin.symbol,
        name: coin.symbol,
        price: coin.price,
        change24h: first ? (coin.price / first - 1) * 100 : null,
        chain: key.split(':')[0],
        address: key.split(':')[1] ?? null,
        id: key,
      }),
      confidence: coin.confidence,
      historyFrom: history[0] ? new Date(history[0].timestamp * 1000).toISOString() : null,
    }
    const list: Row[] = history.map((p) => ({ at: new Date(p.timestamp * 1000).toISOString(), type: 'number', data: p.price }))
    return { data, list }
  },
  headline: ({ data }, props) => {
    if (!data) return null
    if (props.mode === 'price') return { text: `${data.symbol} ${usdPrice(num(data.price))}` }
    return { text: `${MODES.find((m) => m.value === props.mode)?.label} · top ${data.rows}` }
  },
  lines: ({ data, list }, props) => {
    if (!data) return []
    if (props.mode === 'price') {
      const change = num(data.change24h)
      return [
        ['Price', usdPrice(num(data.price))],
        [`Change (${props.historyDays}d)`, percent(change), (change ?? 0) >= 0 ? 'good' : 'bad'],
        ['Confidence', String(data.confidence ?? '—')],
        ['History points', String(list?.length ?? 0)],
        ['Id', String(data.id)],
      ] as Line[]
    }
    const value = (r: Row) => moneyCompact(num(r.tvl ?? r.volume24h))
    return (list ?? []).slice(0, 12).map((r, i): Line => {
      const ch = num(r.change1d)
      return [`${i + 1}. ${r.name}`, `${value(r)}${ch != null ? `  ${percent(ch)}` : ''}`, ch == null ? undefined : ch >= 0 ? 'good' : 'bad']
    })
  },
})
