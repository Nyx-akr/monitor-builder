import { useEffect } from 'react'
import type { BlockContext, BlockDefinition, Message } from '../../types'
import { carryFetchedAt, fetchedAt, FRESH_ENOUGH_MS, getCoin, getGlobal, getMarkets, getTrending, resolveCoin, type CoinDetail } from '../../../lib/coingecko'
import { usePolling } from '../../../lib/usePolling'
import { track } from '../../../lib/fetchState'
import { forgetSent } from '../../../lib/lastSent'
import { FetchBadge } from '../../../builder/FetchBadge'
import { compactNumber, money, moneyCompact, percent, shortDate } from '../../../lib/format'
import { emitOnce, errorMessage, isBang, isTokenItem, type TokenItem } from '../../../lib/messages'
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
  /** Which list a bang sends out of the `list` outlet. */
  listSource: string
  /** Send the coin's details out of `data` every time they load or refresh. */
  outputOnUpdate: boolean
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

// ---------- messages this card sends ----------

/** The selected coin's details, as sent out of the `data` outlet. */
function coinItem(coin: CoinDetail, cur: string): TokenItem {
  const m = coin.market_data as MarketData
  return {
    source: 'coingecko',
    id: coin.id,
    symbol: coin.symbol.toUpperCase(),
    name: coin.name,
    rank: coin.market_cap_rank,
    currency: cur,
    price: m.current_price?.[cur] ?? null,
    change24h: m.price_change_percentage_24h_in_currency?.[cur] ?? m.price_change_percentage_24h ?? null,
    change7d: m.price_change_percentage_7d_in_currency?.[cur] ?? m.price_change_percentage_7d ?? null,
    change30d: m.price_change_percentage_30d_in_currency?.[cur] ?? m.price_change_percentage_30d ?? null,
    change1y: m.price_change_percentage_1y_in_currency?.[cur] ?? m.price_change_percentage_1y ?? null,
    marketCap: m.market_cap?.[cur] ?? null,
    volume24h: m.total_volume?.[cur] ?? null,
    ath: m.ath?.[cur] ?? null,
    athChange: m.ath_change_percentage?.[cur] ?? null,
    circulatingSupply: m.circulating_supply ?? null,
    maxSupply: m.max_supply ?? null,
    categories: coin.categories.filter(Boolean),
    url: `https://www.coingecko.com/en/coins/${coin.id}`,
  }
}

/** Every token in the chosen list, each as one list item (prices in USD). */
async function loadList(source: string, maxAgeMs?: number): Promise<TokenItem[]> {
  if (source === 'trending') {
    const trending = await getTrending(maxAgeMs)
    return carryFetchedAt(trending, trending.map((c) => ({
      source: 'coingecko',
      id: c.id,
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      rank: c.market_cap_rank,
      price: c.data.price,
      change24h: c.data.price_change_percentage_24h?.usd ?? null,
      url: `https://www.coingecko.com/en/coins/${c.id}`,
    })) as TokenItem[])
  }
  const markets = await getMarkets({ perPage: 250 }, maxAgeMs)
  return carryFetchedAt(markets, markets.map((c) => ({
    source: 'coingecko',
    id: c.id,
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    rank: c.market_cap_rank,
    price: c.current_price,
    change24h: c.price_change_percentage_24h,
    marketCap: c.market_cap,
    volume24h: c.total_volume,
    url: `https://www.coingecko.com/en/coins/${c.id}`,
  })) as TokenItem[])
}

/**
 * bang: send everything that doesn't need a selected coin — `info` (market-wide stats, coin count)
 * and `list` (each token as an item) — plus `data` if a coin is selected. Right-to-left, like Max.
 */
async function bang(ctx: BlockContext<Props>) {
  const { listSource, coinId, currency } = ctx.props
  const [global, list, coin] = await Promise.allSettled([
    // An input asked for data: ask CoinGecko again unless its answer is under a minute old (its free data
    // doesn't change faster, and asking more gets the network rate-limited). The badge shows the real time.
    track(ctx.id, getGlobal(FRESH_ENOUGH_MS), fetchedAt),
    track(ctx.id, loadList(listSource || 'top', FRESH_ENOUGH_MS), fetchedAt),
    coinId ? track(ctx.id, getCoin(coinId, FRESH_ENOUGH_MS), fetchedAt) : Promise.resolve(null),
  ])
  const failed = [global, list, coin].find((r): r is PromiseRejectedResult => r.status === 'rejected')

  const info: Record<string, Message> = {
    source: 'coingecko',
    list: listSource === 'trending' ? 'trending' : 'top 250',
    listCount: list.status === 'fulfilled' ? list.value.length : null,
    selected: coinId || null,
  }
  if (global.status === 'fulfilled') {
    const g = global.value
    Object.assign(info, {
      coinsTracked: g.active_cryptocurrencies,
      markets: g.markets,
      totalMarketCap: g.total_market_cap.usd,
      totalVolume24h: g.total_volume.usd,
      marketCapChange24h: g.market_cap_change_percentage_24h_usd,
      btcDominance: g.market_cap_percentage.btc,
      ethDominance: g.market_cap_percentage.eth,
    })
  }
  if (failed) info.error = (failed.reason as Error).message

  ctx.send('info', info)
  if (list.status === 'fulfilled') ctx.send('list', list.value)
  if (coin.status === 'fulfilled' && coin.value) emitOnce(ctx, 'data', coin.value.id, coinItem(coin.value, currency || 'usd'), true)
  else if (coin.status === 'rejected') {
    const why = (coin.reason as Error).message
    emitOnce(ctx, 'error', why, errorMessage('coingecko', coinId, why), true)
  }
}

/** A token arrived on the (hot) inlet: send the coin's details out of `data`, even if unchanged. */
async function sendData(ctx: BlockContext<Props>) {
  const { coinId, currency } = ctx.props
  if (!coinId) return
  try {
    const coin = await track(ctx.id, getCoin(coinId, FRESH_ENOUGH_MS), fetchedAt)
    // An input always gets an answer (force); only the card's own reload is de-duplicated against it.
    emitOnce(ctx, 'data', coin.id, coinItem(coin, currency || 'usd'), true)
  } catch (e) {
    // Not found / rate-limited: the card goes blank and says why; the same goes out of `error`.
    const why = describeFailure(e as Error, coinId)
    emitOnce(ctx, 'error', why, errorMessage('coingecko', coinId, why))
  }
}

/** CoinGecko answers 404 for an unknown coin id — say that plainly. */
const describeFailure = (e: Error, coinId: string) =>
  /responded 404/.test(e.message) ? `"${coinId}" isn't a coin on CoinGecko` : e.message

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

function CoinCard({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const cur = props.currency || 'usd'
  const { data: coin, loading, error, updatedAt } = usePolling(
    props.coinId,
    () => getCoin(props.coinId),
    props.refreshSec,
    MIN_REFRESH_SEC,
  )

  // Live output: each load/refresh sends the coin's details out of `info`.
  useEffect(() => {
    if (coin && props.outputOnUpdate) emitOnce(ctx, 'data', coin.id, coinItem(coin, cur))
    // A failed load (e.g. a token picked in Settings that isn't on CoinGecko) goes out of `error`.
    if (!coin && error) {
      const why = describeFailure(new Error(error), props.coinId)
      emitOnce(ctx, 'error', why, errorMessage('coingecko', props.coinId, why))
    }
    // Only when new data arrives (or the currency changes), not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedAt, cur, error])

  // Same as the DexScreener card: with no data the full layout stays, with blank values.
  const m = coin?.market_data as MarketData | undefined
  const status = !props.coinId
    ? 'No coin selected — pick one in Settings'
    : loading && !coin
      ? 'Loading from CoinGecko…'
      : error && !coin
        ? describeFailure(new Error(error), props.coinId)
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
      <FetchBadge id={ctx.id} loading={loading} error={coin ? null : error} updatedAt={updatedAt} source="CoinGecko" />
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
  label: 'CoinGecko',
  description: 'Coin market data: rank, chart, ATH, supply',
  icon: '🦎',
  category: 'cards',
  // Older flows had separate trigger / refresh inlets; a signal on `token` does the same now.
  renamedInlets: { trigger: 'token', refresh: 'token' },
  inlets: [
    { id: 'token', label: 'token — CoinGecko id, symbol or name (e.g. btc) or a coin’s dict (e.g. a clicked list row) fetches it · a signal (blank token) clears the coin and fetches the list & info', types: ['string', 'dict', 'bang'] },
  ],
  outlets: [
    { id: 'data', label: 'data — the selected coin’s details (price, rank, market cap…)', types: ['dict'] },
    { id: 'list', label: 'list — each coin in the chosen list as an item', types: ['list'] },
    { id: 'info', label: 'info — the market summary: counts and totals (no coin needed)', types: ['dict'] },
    { id: 'error', label: 'error — the token and why the lookup failed (not on CoinGecko, rate limit…)', types: ['dict'], error: true },
  ],
  // Outlet descriptions follow the card's settings, so hovering shows exactly what comes out.
  ports: (props) => ({
    outlets: [
      {
        id: 'data',
        label: `data — ${props.coinLabel ? `${props.coinLabel}’s details` : 'the selected coin’s details (no coin selected yet)'}: price, rank, market cap, 24h / 7d / 30d / 1y change, ATH, supply`,
        types: ['dict'],
      },
      {
        id: 'list',
        label: `list — ${props.listSource === 'trending' ? 'Trending: the 15 most-searched coins on CoinGecko' : 'Top 250 coins by market cap'}, each with price, 24h change, market cap and volume`,
        types: ['list'],
      },
      { id: 'info', label: 'info — market summary: coins tracked, markets, total market cap and volume, BTC / ETH dominance', types: ['dict'] },
      { id: 'error', label: 'error — the token and why the lookup failed (not on CoinGecko, rate limit…)', types: ['dict'], error: true },
    ],
  }),
  receive: async (ctx, inlet, msg) => {
    if (inlet !== 'token') return
    // A plain signal (e.g. from a Timer, or an empty message box) is a blank token: clear the selected
    // coin, then fetch what needs no token (list & info). Right-click → Fetch now refreshes without clearing.
    if (isBang(msg) || (typeof msg === 'string' && !msg.trim())) {
      ctx.update({ coinId: '', coinLabel: '' })
      forgetSent(ctx.id, 'data')
      return bang(ctx)
    }
    // A token item from a list (e.g. another card's `list` outlet).
    if (isTokenItem(msg)) {
      if (msg.source === 'coingecko' && msg.id) {
        ctx.update({ coinId: msg.id, coinLabel: `${msg.name} (${msg.symbol.toUpperCase()})` })
        return sendData(ctx)
      }
      msg = msg.symbol
    }
    const token = typeof msg === 'string' || typeof msg === 'number' ? String(msg).trim() : ''
    if (!token) return
    try {
      const coin = await resolveCoin(token)
      if (coin) {
        ctx.update({ coinId: coin.id, coinLabel: `${coin.name} (${coin.symbol.toUpperCase()})` })
        return sendData(ctx)
      }
    } catch {
      /* rate-limited: fall back to treating the token as a CoinGecko id */
    }
    ctx.update({ coinId: token.toLowerCase(), coinLabel: token })
  },
  menu: [
    { label: 'Fetch now', run: (ctx) => bang(ctx) },
    {
      label: 'Clear token',
      run: (ctx) => {
        ctx.update({ coinId: '', coinLabel: '' })
        forgetSent(ctx.id, 'data')
      },
    },
  ],
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
    listSource: 'top',
    outputOnUpdate: true,
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
    {
      key: 'listSource',
      label: 'List to fetch',
      type: 'select',
      options: [
        { value: 'top', label: 'Top 250 by market cap' },
        { value: 'trending', label: 'Trending (15)' },
      ],
      help: 'Fetched and sent out of list when a signal arrives (or right-click → Fetch now)',
    },
    { key: 'outputOnUpdate', label: 'Send data out on every update', type: 'toggle' },
  ],
  Render: CoinCard,
}
