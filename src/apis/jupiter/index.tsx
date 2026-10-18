import { listItem } from '../../core/messages'
import { isSolanaAddress } from '../../services/chains'
import { moneyCompact, percent, usdPrice } from '../../lib/format'
import { getJson, makeApiCard, num, pct, yesNo, type ApiCardProps, type Line, type Row } from '../shared/makeApiCard'

/**
 * Jupiter (Solana): token info and price — holders, liquidity, market cap, verified / organic score, mint
 * and freeze authority — and optionally a swap quote: how much USDC selling $X of the token gets, and its
 * price impact (can a position of that size actually be exited?). Free, no key: lite-api.jup.ag.
 */
type Props = ApiCardProps & {
  /** Sell this many dollars' worth of the token in a quote (0 = no quote). */
  quoteUsd: number
}

const API = 'https://lite-api.jup.ag'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

interface JupToken {
  id: string
  name: string
  symbol: string
  decimals: number
  usdPrice?: number
  liquidity?: number
  mcap?: number
  fdv?: number
  holderCount?: number
  isVerified?: boolean
  organicScore?: number
  organicScoreLabel?: string
  stats24h?: { priceChange?: number; buyVolume?: number; sellVolume?: number; numTraders?: number }
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; topHoldersPercentage?: number }
}

interface JupQuote {
  outAmount: string
  priceImpactPct: string
  routePlan: { swapInfo: { label: string } }[]
}

const tokenRow = (t: JupToken): Row => ({
  ...listItem({
    source: 'jupiter',
    symbol: t.symbol,
    name: t.name,
    price: t.usdPrice ?? null,
    change24h: t.stats24h?.priceChange ?? null,
    marketCap: t.mcap ?? null,
    volume24h: t.stats24h ? (t.stats24h.buyVolume ?? 0) + (t.stats24h.sellVolume ?? 0) : null,
    liquidity: t.liquidity ?? null,
    chain: 'solana',
    address: t.id,
    url: `https://jup.ag/tokens/${t.id}`,
  }),
  fdv: t.fdv ?? null,
  holders: t.holderCount ?? null,
  verified: t.isVerified ?? null,
  organicScore: t.organicScore ?? null,
  mintAuthorityDisabled: t.audit?.mintAuthorityDisabled ?? null,
  freezeAuthorityDisabled: t.audit?.freezeAuthorityDisabled ?? null,
  topHoldersPercent: t.audit?.topHoldersPercentage ?? null,
  traders24h: t.stats24h?.numTraders ?? null,
})

export const jupiter = makeApiCard<Props>({
  type: 'jupiter',
  label: 'Jupiter',
  description: 'Solana token info, price, holders · swap quotes',
  icon: '🪐',
  source: 'Jupiter',
  defaultProps: { token: '', chain: 'solana', label: '', refreshSec: 0, quoteUsd: 0 },
  chains: ['solana'],
  searchesBySymbol: true,
  needsToken: () => true,
  tokenHelp: 'a Solana mint or symbol (e.g. BONK), or a token row from a card',
  dataLabel: 'data — the token: price, 24h change, liquidity, market cap, holders, verified, organic score, authorities (+ the swap quote)',
  listLabel: 'list — every token matching the search, best first',
  settings: () => [
    {
      key: 'quoteUsd',
      label: 'Sell quote ($)',
      type: 'number',
      min: 0,
      help: 'Also ask Jupiter how much USDC selling this many dollars of the token gets, and the price impact. 0 = no quote.',
    },
  ],
  fetch: async ({ token, symbol }, props) => {
    const query = token || symbol || ''
    const found = await getJson<JupToken[]>(`${API}/tokens/v2/search?query=${encodeURIComponent(query)}`, 'Jupiter')
    // A mint matches itself; a symbol takes the exact match with the most liquidity.
    const best = isSolanaAddress(query)
      ? found.find((t) => t.id === query)
      : [...found].filter((t) => t.symbol.toUpperCase() === query.toUpperCase()).sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0))[0] ?? found[0]
    if (!best) throw new Error(`No token matching "${query}" on Jupiter`)
    const data = tokenRow(best)

    const usd = Math.max(0, Number(props.quoteUsd) || 0)
    if (usd > 0 && best.usdPrice) {
      const amount = Math.round((usd / best.usdPrice) * 10 ** best.decimals)
      try {
        const q = await getJson<JupQuote>(`${API}/swap/v1/quote?inputMint=${best.id}&outputMint=${USDC}&amount=${amount}&slippageBps=100`, 'Jupiter')
        Object.assign(data, {
          quoteSellUsd: usd,
          quoteReceivesUsdc: Number(q.outAmount) / 1e6,
          quotePriceImpact: Number(q.priceImpactPct) * 100,
          quoteRoute: q.routePlan.map((r) => r.swapInfo.label).join(' → '),
        })
      } catch (e) {
        data.quoteError = (e as Error).message
      }
    }
    return { data, list: found.map(tokenRow) }
  },
  headline: ({ data }) =>
    data
      ? data.verified
        ? { text: `${data.symbol} · verified on Jupiter`, tone: 'good' }
        : { text: `${data.symbol} · not verified`, tone: 'warn' }
      : null,
  lines: ({ data }) => {
    if (!data) return []
    const lines: Line[] = [
      ['Price', usdPrice(num(data.price))],
      ['24h', percent(num(data.change24h)), (num(data.change24h) ?? 0) >= 0 ? 'good' : 'bad'],
      ['Liquidity', moneyCompact(num(data.liquidity))],
      ['Market cap', moneyCompact(num(data.marketCap))],
      ['Holders', num(data.holders)?.toLocaleString('en-US') ?? '—'],
      ['Organic score', num(data.organicScore)?.toFixed(0) ?? '—'],
      ['Mint authority off', ...yesNo(data.mintAuthorityDisabled as boolean | null, false)],
      ['Freeze authority off', ...yesNo(data.freezeAuthorityDisabled as boolean | null, false)],
      ['Top holders own', pct(num(data.topHoldersPercent))],
    ]
    if (data.quoteSellUsd != null) {
      const impact = num(data.quotePriceImpact)
      lines.push([`Sell $${data.quoteSellUsd} → USDC`, `$${num(data.quoteReceivesUsdc)?.toFixed(2)}`])
      lines.push(['Price impact', pct(impact, 2), impact == null ? undefined : impact < 1 ? 'good' : impact < 5 ? 'warn' : 'bad'])
    }
    if (data.quoteError) lines.push(['Quote', String(data.quoteError), 'bad'])
    return lines
  },
})
