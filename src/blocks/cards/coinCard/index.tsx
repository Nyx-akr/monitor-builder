import type { BlockDefinition } from '../../types'
import { getCoin, resolveCoin, type CoinDetail } from '../../../lib/coingecko'
import { usePolling } from '../../../lib/usePolling'
import { compactNumber, money, moneyCompact, percent, shortDate } from '../../../lib/format'
import '../tokenCard/tokenCard.css'
import './coinCard.css'

type Props = {
  coinId: string
  coinLabel: string
  currency: string
  refreshSec: number
  showChart: boolean
  showChanges: boolean
  showAth: boolean
  showSupply: boolean
  showAbout: boolean
  showLinks: boolean
}

/** CoinGecko's keyless tier allows only a few requests a minute, so refreshes are capped. */
const MIN_REFRESH_SEC = 180

type MarketData = CoinDetail['market_data'] & {
  [k: `price_change_percentage_${string}_in_currency`]: Record<string, number> | undefined
}

const WINDOWS = [
  ['24h', '24h'],
  ['7d', '7d'],
  ['30d', '30d'],
  ['1y', '1y'],
] as const

const trend = (v: number | null | undefined) => (v == null ? '' : v >= 0 ? 'up' : 'down')

function Sparkline({ prices, up }: { prices: number[]; up: boolean }) {
  const W = 520
  const H = 72
  if (prices.length < 2) return <svg className="cc-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" />
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = max - min || 1
  const pts = prices.map((p, i) => [(i / (prices.length - 1)) * W, H - 4 - ((p - min) / span) * (H - 8)])
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const color = up ? 'var(--up)' : 'var(--down)'
  return (
    <svg className="cc-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`cc-fill-${up}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.25" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#cc-fill-${up})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="tc-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

function CoinCard({ props }: { props: Props }) {
  const cur = props.currency || 'usd'
  const { data: coin, loading, error, updatedAt } = usePolling(
    props.coinId,
    () => getCoin(props.coinId),
    props.refreshSec,
    MIN_REFRESH_SEC,
  )

  // Same as the Token Card: with no data the full layout stays, with blank values.
  const m = coin?.market_data as MarketData | undefined
  const status = !props.coinId
    ? 'No coin selected — pick one in Settings'
    : loading && !coin
      ? 'Loading from CoinGecko…'
      : error && !coin
        ? error
        : null

  const change = (w: string): number | undefined =>
    m?.[`price_change_percentage_${w}_in_currency`]?.[cur] ??
    (m?.[`price_change_percentage_${w}` as keyof MarketData] as number | undefined)

  const change24 = change('24h')
  const change7d = change('7d')
  const low = m?.low_24h?.[cur]
  const high = m?.high_24h?.[cur]
  const price = m?.current_price?.[cur]
  const rangePos = low != null && high != null && price != null && high > low ? ((price - low) / (high - low)) * 100 : 50
  const supplyPct = m?.max_supply && m.circulating_supply ? (m.circulating_supply / m.max_supply) * 100 : null
  const about = coin ? stripHtml(coin.description.en) : ''
  const links = coin
    ? [
        coin.links.homepage.find(Boolean) && { label: 'Website', url: coin.links.homepage.find(Boolean)! },
        coin.links.twitter_screen_name && { label: 'Twitter', url: `https://x.com/${coin.links.twitter_screen_name}` },
        coin.links.telegram_channel_identifier && { label: 'Telegram', url: `https://t.me/${coin.links.telegram_channel_identifier}` },
        { label: 'CoinGecko ↗', url: `https://www.coingecko.com/en/coins/${coin.id}` },
      ].filter((l): l is { label: string; url: string } => Boolean(l))
    : []

  return (
    <div className={`tc cc${coin ? '' : ' tc-empty'}`}>
      <div className="tc-head">
        {coin ? <img className="tc-logo" src={coin.image.large} alt="" /> : <div className="tc-logo tc-logo-fallback">?</div>}
        <div className="tc-title">
          <div className="tc-name">
            {coin?.name ?? 'Coin'}
            <span className="tc-quote"> {coin?.symbol.toUpperCase() ?? '—'}</span>
          </div>
          <div className={`tc-sub${error && !coin ? ' tc-error' : ''}`}>
            {coin ? (
              <>
                <span className="tc-chip cc-rank">#{coin.market_cap_rank ?? '—'}</span>
                {coin.categories.filter(Boolean).slice(0, 2).map((c) => (
                  <span key={c} className="tc-chip">{c}</span>
                ))}
              </>
            ) : (
              <>
                {loading && <span className="spinner" />} {status}
              </>
            )}
          </div>
        </div>
        <div className="tc-price">
          <div className="tc-usd">{money(price, cur)}</div>
          <div className={`tc-change ${trend(change24)}`}>{percent(change24)} 24h</div>
        </div>
      </div>

      {props.showChart && (
        <div className="cc-chart">
          <div className="cc-chart-head">
            <span>7 days</span>
            <strong className={trend(change7d)}>{percent(change7d)}</strong>
          </div>
          <Sparkline prices={m?.sparkline_7d?.price ?? []} up={(change7d ?? 0) >= 0} />
        </div>
      )}

      <div className="tc-stats">
        <Stat label="Market cap" value={moneyCompact(m?.market_cap?.[cur], cur)} />
        <Stat label="FDV" value={moneyCompact(m?.fully_diluted_valuation?.[cur], cur)} />
        <Stat label="Volume 24h" value={moneyCompact(m?.total_volume?.[cur], cur)} />
        <Stat label="Vol / MCap" value={m?.total_volume?.[cur] && m.market_cap?.[cur] ? (m.total_volume[cur] / m.market_cap[cur]).toFixed(3) : '—'} />
      </div>

      <div className="cc-range">
        <div className="tc-txns-labels">
          <span className="muted">Low {money(low, cur)}</span>
          <span className="muted">24h range</span>
          <span className="muted">High {money(high, cur)}</span>
        </div>
        <div className={`cc-range-bar${m ? '' : ' blank'}`}>
          {m && <span style={{ left: `${rangePos}%` }} />}
        </div>
      </div>

      {props.showChanges && (
        <div className="tc-windows">
          {WINDOWS.map(([key, label]) => {
            const v = change(key)
            return (
              <div key={key} className="tc-window">
                <span>{label}</span>
                <strong className={trend(v)}>{percent(v)}</strong>
              </div>
            )
          })}
        </div>
      )}

      {props.showAth && (
        <div className="cc-extremes">
          <div className="tc-stat">
            <span>All-time high</span>
            <strong>{money(m?.ath?.[cur], cur)}</strong>
            <small className={trend(m?.ath_change_percentage?.[cur])}>
              {percent(m?.ath_change_percentage?.[cur])} · {shortDate(m?.ath_date?.[cur])}
            </small>
          </div>
          <div className="tc-stat">
            <span>All-time low</span>
            <strong>{money(m?.atl?.[cur], cur)}</strong>
            <small className={trend(m?.atl_change_percentage?.[cur])}>
              {percent(m?.atl_change_percentage?.[cur])} · {shortDate(m?.atl_date?.[cur])}
            </small>
          </div>
        </div>
      )}

      {props.showSupply && (
        <div className="cc-supply">
          <div className="tc-txns-labels">
            <span>Circulating {compactNumber(m?.circulating_supply)}</span>
            <span className="muted">
              {m?.max_supply ? `Max ${compactNumber(m.max_supply)}` : m ? `Total ${compactNumber(m.total_supply)} · no max` : 'Max —'}
            </span>
          </div>
          <div className={`tc-bar cc-supply-bar${supplyPct == null ? ' blank' : ''}`}>
            <div style={{ width: `${supplyPct ?? 0}%` }} />
          </div>
          {supplyPct != null && <small className="muted">{supplyPct.toFixed(1)}% of max supply in circulation</small>}
        </div>
      )}

      {props.showAbout && (
        <div className="cc-about">
          <span>About</span>
          <p className={about ? '' : 'muted'}>{about || '—'}</p>
        </div>
      )}

      <div className="tc-foot">
        <span className="muted">
          {coin?.genesis_date ? `Launched ${shortDate(coin.genesis_date)}` : 'Launched —'}
          {coin?.sentiment_votes_up_percentage != null && ` · ${Math.round(coin.sentiment_votes_up_percentage)}% bullish`}
        </span>
        {props.showLinks && (
          <span className="tc-links">
            {coin ? (
              links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label}</a>
              ))
            ) : (
              <span className="muted">Website · Twitter · CoinGecko</span>
            )}
          </span>
        )}
      </div>
      {coin && (
        <div className="tc-live">
          {error ? (
            <span className="tc-error">{error}</span>
          ) : (
            updatedAt &&
            props.refreshSec > 0 && (
              <>
                <span className="dot" /> Live · updated {new Date(updatedAt).toLocaleTimeString()}
              </>
            )
          )}
        </div>
      )}
    </div>
  )
}

export const coinCard: BlockDefinition<Props> = {
  type: 'coinCard',
  label: 'Coin Card',
  description: 'Market data & profile from CoinGecko',
  icon: '🦎',
  category: 'cards',
  inlets: [{ id: 'token', label: 'token — CoinGecko id, symbol or name (e.g. btc)' }],
  receive: async (ctx, inlet, msg) => {
    const token = String(msg).trim()
    if (inlet !== 'token' || !token || token === 'bang') return
    try {
      const coin = await resolveCoin(token)
      if (coin) return ctx.update({ coinId: coin.id, coinLabel: `${coin.name} (${coin.symbol.toUpperCase()})` })
    } catch {
      /* rate-limited: fall back to treating the token as a CoinGecko id */
    }
    ctx.update({ coinId: token.toLowerCase(), coinLabel: token })
  },
  defaultProps: {
    coinId: 'bitcoin',
    coinLabel: 'Bitcoin (BTC)',
    currency: 'usd',
    refreshSec: 300,
    showChart: true,
    showChanges: true,
    showAth: true,
    showSupply: true,
    showAbout: false,
    showLinks: true,
  },
  width: 560,
  settings: [
    { key: 'coinId', label: 'Coin', type: 'coinSearch' },
    {
      key: 'currency',
      label: 'Currency',
      type: 'select',
      options: [
        { value: 'usd', label: 'USD $' },
        { value: 'eur', label: 'EUR €' },
        { value: 'gbp', label: 'GBP £' },
        { value: 'jpy', label: 'JPY ¥' },
        { value: 'btc', label: 'BTC ₿' },
        { value: 'eth', label: 'ETH Ξ' },
      ],
    },
    { key: 'refreshSec', label: 'Auto-refresh (seconds)', type: 'number', min: 0, max: 3600, help: `Minimum ${MIN_REFRESH_SEC}s (CoinGecko rate limit) · 0 turns live updates off` },
    { key: 'showChart', label: 'Show 7-day chart', type: 'toggle' },
    { key: 'showChanges', label: 'Show price changes', type: 'toggle' },
    { key: 'showAth', label: 'Show all-time high / low', type: 'toggle' },
    { key: 'showSupply', label: 'Show supply', type: 'toggle' },
    { key: 'showAbout', label: 'Show description', type: 'toggle' },
    { key: 'showLinks', label: 'Show links', type: 'toggle' },
  ],
  Render: CoinCard,
}
