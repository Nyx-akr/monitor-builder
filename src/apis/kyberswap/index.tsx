import { chainById } from '../../services/chains'
import { getJson, makeApiCard, num, pct, type ApiCardProps, type Line } from '../shared/makeApiCard'

/**
 * KyberSwap (EVM): the best swap route for buying a token with USDC — how much of the token $X buys, what
 * that's worth, the price impact, gas, and the route's hops. A token whose route loses a lot is thin.
 * Free, no key: aggregator-api.kyberswap.com.
 */
type Props = ApiCardProps & {
  /** Buy with this many USDC. */
  amountUsd: number
}

interface Route {
  data?: {
    routeSummary: {
      amountInUsd: string
      amountOut: string
      amountOutUsd: string
      gasUsd: string
      route: { exchange: string }[][]
    }
  }
  message?: string
}

export const kyberswap = makeApiCard<Props>({
  type: 'kyberswap',
  label: 'KyberSwap',
  description: 'Best EVM swap route: price impact, gas',
  icon: '🔀',
  source: 'KyberSwap',
  defaultProps: { token: '', chain: 'ethereum', label: '', refreshSec: 0, amountUsd: 1000 },
  chains: ['ethereum', 'bsc', 'base', 'arbitrum', 'polygon', 'avalanche', 'optimism'],
  needsToken: () => true,
  tokenHelp: 'an EVM contract address — the token to buy — or a token row from a card',
  dataLabel: 'data — the quote: USDC paid and its value, what the tokens received are worth, price impact %, gas $, the DEXes on the route',
  settings: () => [{ key: 'amountUsd', label: 'Buy with (USDC)', type: 'number', min: 1, help: 'The size of the quoted buy. A bigger buy shows how deep the liquidity is.' }],
  fetch: async ({ token, chain }, props) => {
    const c = chainById(chain)
    if (!c?.kyber || !c.usdc) throw new Error(`KyberSwap doesn't cover ${chain}`)
    const usd = Math.max(1, Number(props.amountUsd) || 1000)
    const amountIn = BigInt(Math.round(usd * 100)) * 10n ** BigInt(c.usdc.decimals) / 100n
    const r = await getJson<Route>(
      `https://aggregator-api.kyberswap.com/${c.kyber}/api/v1/routes?tokenIn=${c.usdc.address}&tokenOut=${token}&amountIn=${amountIn}`,
      'KyberSwap',
      { headers: { 'x-client-id': 'dex-builder' } },
    )
    const s = r.data?.routeSummary
    if (!s) throw new Error(r.message || 'KyberSwap found no route')
    const inUsd = num(s.amountInUsd) ?? usd
    const outUsd = num(s.amountOutUsd)
    const dexes = [...new Set(s.route.flat().map((h) => h.exchange))]
    return {
      data: {
        source: 'kyberswap',
        chain,
        address: token,
        payUsdc: usd,
        paidUsd: inUsd,
        receivedUsd: outUsd,
        priceImpact: outUsd == null ? null : ((inUsd - outUsd) / inUsd) * 100,
        gasUsd: num(s.gasUsd),
        amountOutRaw: s.amountOut,
        hops: s.route.reduce((n, path) => Math.max(n, path.length), 0),
        dexes: dexes.join(', '),
      },
    }
  },
  headline: ({ data }) => {
    if (!data) return null
    const impact = num(data.priceImpact)
    if (impact == null) return null
    return { text: `Buying $${data.payUsdc}: ${pct(impact, 2)} lost to price impact`, tone: impact < 1 ? 'good' : impact < 5 ? 'warn' : 'bad' }
  },
  lines: ({ data }) => {
    if (!data) return []
    const impact = num(data.priceImpact)
    const lines: Line[] = [
      ['Pay', `${data.payUsdc} USDC`],
      ['Tokens received are worth', `$${num(data.receivedUsd)?.toFixed(2) ?? '—'}`],
      ['Price impact', pct(impact, 2), impact == null ? undefined : impact < 1 ? 'good' : impact < 5 ? 'warn' : 'bad'],
      ['Gas', `$${num(data.gasUsd)?.toFixed(2) ?? '—'}`],
      ['Hops', String(data.hops)],
      ['DEXes', String(data.dexes || '—')],
    ]
    return lines
  },
})
