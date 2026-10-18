import { useEffect } from 'react'
import type { BlockContext, BlockDefinition, Message } from '../../blocks/types'
import { CHAINS, findPair, type DexPair } from '../../services/dexscreener'
import { getTokenList, LIST_SOURCES, type ListSource } from '../../services/tokenLists'
import { useDexPair } from '../../hooks/useDexPair'
import { track } from '../../core/fetchState'
import { forgetSent } from '../../core/lastSent'
import { FetchBadge } from '../../components/FetchBadge'
import { emitOnce, errorMessage, isBang, isToken, isTokenItem, listItem, type TokenItem } from '../../core/messages'
import { age, percent, shortAddress, usdCompact, usdPrice } from '../../lib/format'
import './tokenCard.css'

type Props = {
  query: string
  chain: string
  pairAddress: string
  pairLabel: string
  refreshSec: number
  showChanges: boolean
  showTxns: boolean
  showLinks: boolean
  /** Which DexScreener list a bang sends out of the `list` outlet. */
  listSource: string
  /** Send the pair's details out of `data` every time they load or refresh. */
  outputOnUpdate: boolean
}

// ---------- messages this card sends ----------

/** One pair as a token item with all its details — what `data` sends. */
function pairItem(p: DexPair): TokenItem {
  return {
    kind: 'token',
    source: 'dexscreener',
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    address: p.baseToken.address,
    chain: p.chainId,
    pair: p.pairAddress,
    quote: p.quoteToken.symbol,
    dex: p.dexId,
    price: p.priceUsd ? Number(p.priceUsd) : null,
    change24h: p.priceChange?.h24 ?? null,
    liquidity: p.liquidity?.usd ?? null,
    marketCap: p.marketCap ?? null,
    volume24h: p.volume?.h24 ?? null,
    buys24h: p.txns?.h24?.buys ?? null,
    sells24h: p.txns?.h24?.sells ?? null,
    url: p.url,
    pool: p.pairAddress,
    logo: p.info?.imageUrl ?? null,
  }
}

/** One pair as a `list` entry — the shape both cards' lists share (see listItem). */
function listEntry(p: DexPair): TokenItem {
  return listItem({
    source: 'dexscreener',
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    price: p.priceUsd ? Number(p.priceUsd) : null,
    change24h: p.priceChange?.h24 ?? null,
    marketCap: p.marketCap ?? null,
    volume24h: p.volume?.h24 ?? null,
    liquidity: p.liquidity?.usd ?? null,
    chain: p.chainId,
    address: p.baseToken.address,
    pair: p.pairAddress,
    url: p.url,
    logo: p.info?.imageUrl ?? null,
  })
}

/**
 * bang: send everything that doesn't need a selected token — `info` (list size, tokens per chain,
 * totals) and `list` (each token as an item) — plus `data` if a token is selected. Right-to-left, like Max.
 */
async function bang(ctx: BlockContext<Props>) {
  const { listSource, chain, query, pairAddress } = ctx.props
  const source = (LIST_SOURCES.some((s) => s.value === listSource) ? listSource : 'trending') as ListSource
  const [list, pair] = await Promise.allSettled([
    // An input asked for data: get the list fresh from DexScreener, not from the 60-second cache.
    track(ctx.id, getTokenList(source, true)),
    query || pairAddress ? track(ctx.id, findPair(query, chain, pairAddress)) : Promise.resolve(null),
  ])

  const items = list.status === 'fulfilled' ? list.value.filter((p) => !chain || p.chainId === chain).map(listEntry) : []
  const perChain: Record<string, number> = {}
  for (const i of items) perChain[i.chain!] = (perChain[i.chain!] ?? 0) + 1
  const info: Record<string, Message> = {
    source: 'dexscreener',
    list: LIST_SOURCES.find((s) => s.value === source)!.label.toLowerCase(),
    tokens: items.length,
    chains: perChain,
    totalLiquidity: items.reduce((n, i) => n + (i.liquidity ?? 0), 0),
    totalVolume24h: items.reduce((n, i) => n + (i.volume24h ?? 0), 0),
    chainFilter: chain || 'any',
    selected: ctx.props.pairLabel || query || null,
  }
  const failed = [list, pair].find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) info.error = (failed.reason as Error).message

  ctx.send('info', info)
  if (list.status === 'fulfilled') ctx.send('list', items)
  if (pair.status === 'fulfilled' && pair.value) emitOnce(ctx, 'data', pair.value.pairAddress, pairItem(pair.value), true)
  else if (query || pairAddress) {
    const why = pair.status === 'rejected' ? (pair.reason as Error).message : `No token matching "${query.trim()}" on DexScreener`
    emitOnce(ctx, 'error', why, errorMessage('dexscreener', query, why), true)
  }
}

/** A token arrived on the (hot) inlet: look it up and send its details out of `data`, even if unchanged. */
async function sendData(ctx: BlockContext<Props>) {
  const { query, chain, pairAddress } = ctx.props
  if (!query && !pairAddress) return
  try {
    const pair = await track(ctx.id, findPair(query, chain, pairAddress))
    // An input always gets an answer (force); only the card's own reload is de-duplicated against it.
    if (pair) return emitOnce(ctx, 'data', pair.pairAddress, pairItem(pair), true)
    const why = `No token matching "${query.trim()}"${chain ? ` on ${chain}` : ''} on DexScreener`
    emitOnce(ctx, 'error', why, errorMessage('dexscreener', query, why))
  } catch (e) {
    emitOnce(ctx, 'error', (e as Error).message, errorMessage('dexscreener', query, (e as Error).message))
  }
}

const WINDOWS = ['m5', 'h1', 'h6', 'h24'] as const

function TokenCard({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const { pair, loading, error, updatedAt } = useDexPair(props.query, props.chain, props.pairAddress ?? '', props.refreshSec)

  // Live output: each load/refresh sends the pair's details out of `info`.
  useEffect(() => {
    if (pair && props.outputOnUpdate) emitOnce(ctx, 'data', pair.pairAddress, pairItem(pair))
    // A failed load (e.g. a token picked in Settings that has no pair) goes out of `error`.
    if (!pair && error) emitOnce(ctx, 'error', error, errorMessage('dexscreener', props.query, error))
    // Only when new data arrives, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedAt, error])

  // With no pair (nothing selected, loading or an error) the full layout still renders with blank values.
  const empty = !pair
  const status = !props.query.trim() && !props.pairAddress
    ? 'No token selected — pick one in Settings'
    : loading && !pair
      ? 'Loading from DexScreener…'
      : error && !pair
        ? error
        : null

  const change24 = pair?.priceChange?.h24
  const tx24 = pair?.txns?.h24
  const buyShare = tx24 && tx24.buys + tx24.sells > 0 ? (tx24.buys / (tx24.buys + tx24.sells)) * 100 : 50
  const trend = (v: number | undefined) => (v == null ? '' : v >= 0 ? 'up' : 'down')

  return (
    <div className={`tc${empty ? ' tc-empty' : ''}`}>
      <FetchBadge id={ctx.id} loading={loading} error={pair ? null : error} updatedAt={updatedAt} source="DexScreener" />
      {pair?.info?.header && <div className="tc-banner" style={{ backgroundImage: `url(${pair.info.header})` }} />}

      <div className="tc-head">
        {pair?.info?.imageUrl ? (
          <img className="tc-logo" src={pair.info.imageUrl} alt="" />
        ) : (
          <div className="tc-logo tc-logo-fallback">{pair ? pair.baseToken.symbol.slice(0, 2) : '?'}</div>
        )}
        <div className="tc-title">
          <div className="tc-name">
            {pair?.baseToken.symbol ?? 'TOKEN'}
            <span className="tc-quote">/{pair?.quoteToken.symbol ?? '—'}</span>
          </div>
          <div className={`tc-sub${error && !pair ? ' tc-error' : ''}`}>
            {pair ? (
              <>
                {pair.baseToken.name} · <span className="tc-chip">{pair.chainId}</span>
                <span className="tc-chip">{pair.dexId}</span>
              </>
            ) : (
              <>
                {loading && <span className="spinner" />} {status}
              </>
            )}
          </div>
        </div>
        <div className="tc-price">
          <div className="tc-usd">{usdPrice(pair?.priceUsd)}</div>
          <div className={`tc-change ${trend(change24)}`}>{percent(change24)} 24h</div>
        </div>
      </div>

      <div className="tc-stats">
        <Stat label="Liquidity" value={usdCompact(pair?.liquidity?.usd)} />
        <Stat label="Market cap" value={usdCompact(pair?.marketCap)} />
        <Stat label="FDV" value={usdCompact(pair?.fdv)} />
        <Stat label="Volume 24h" value={usdCompact(pair?.volume?.h24)} />
      </div>

      {props.showChanges && (
        <div className="tc-windows">
          {WINDOWS.map((w) => {
            const v = pair?.priceChange?.[w]
            return (
              <div key={w} className="tc-window">
                <span>{w.toUpperCase()}</span>
                <strong className={trend(v)}>{percent(v)}</strong>
              </div>
            )
          })}
        </div>
      )}

      {props.showTxns && (
        <div className="tc-txns">
          <div className="tc-txns-labels">
            <span className={tx24 ? 'up' : 'muted'}>{tx24 ? tx24.buys.toLocaleString() : '—'} buys</span>
            <span className="muted">24h txns</span>
            <span className={tx24 ? 'down' : 'muted'}>{tx24 ? tx24.sells.toLocaleString() : '—'} sells</span>
          </div>
          <div className={`tc-bar${tx24 ? '' : ' blank'}`}>
            <div style={{ width: `${buyShare}%` }} />
          </div>
        </div>
      )}

      <div className="tc-foot">
        <span className="muted">
          {pair ? shortAddress(pair.baseToken.address) : '—'} · pair age {age(pair?.pairCreatedAt)}
        </span>
        {props.showLinks && (
          <span className="tc-links">
            {pair ? (
              <>
                {pair.info?.websites?.slice(0, 1).map((w) => (
                  <a key={w.url} href={w.url} target="_blank" rel="noreferrer">{w.label || 'Website'}</a>
                ))}
                {pair.info?.socials?.slice(0, 2).map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.type}</a>
                ))}
                <a href={pair.url} target="_blank" rel="noreferrer">DexScreener ↗</a>
              </>
            ) : (
              <span className="muted">Website · Twitter · DexScreener</span>
            )}
          </span>
        )}
      </div>
      {updatedAt && pair && props.refreshSec > 0 && (
        <div className="tc-live"><span className="dot" /> Live · updated {new Date(updatedAt).toLocaleTimeString()}</div>
      )}
    </div>
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

export const tokenCard: BlockDefinition<Props> = {
  type: 'tokenCard',
  label: 'DexScreener',
  description: 'Live DEX pairs: price, liquidity, volume, trades',
  icon: '🪙',
  category: 'apis',
  // Older flows had separate trigger / refresh inlets; a signal on `token` does the same now.
  // Very old flows had a separate trigger inlet; signals now go to refresh.
  renamedInlets: { trigger: 'refresh' },
  inlets: [
    { id: 'token', label: 'token — a Token (from a Token block, the Page’s token selector, a card’s data): fetches its pair', types: ['token'] },
    { id: 'refresh', label: 'refresh — a signal (e.g. a Timer) fetches the list, the summary and the selected token again', types: ['bang'] },
  ],
  outlets: [
    { id: 'data', label: 'data — the selected token’s details, as a Token (price, liquidity, volume…)', types: ['token'] },
    { id: 'list', label: 'list — each token in the chosen list as an item', types: ['table'] },
    { id: 'info', label: 'info — the market summary: counts and totals (no token needed)', types: ['table'] },
    { id: 'error', label: 'error — the token and why the lookup failed (not found, network…)', types: ['table'], error: true },
  ],
  // Outlet descriptions follow the card's settings, so hovering shows exactly what comes out.
  ports: (props) => {
    const src = LIST_SOURCES.find((s) => s.value === props.listSource) ?? LIST_SOURCES.find((s) => s.value === 'trending')!
    const token = props.pairLabel || props.query
    return {
      outlets: [
        {
          id: 'data',
          label: `data — ${token ? `${token}${props.chain ? ` on ${props.chain}` : ''} — its` : 'the selected token’s (no token selected yet)'} details, as a Token: price, liquidity, market cap, volume, buys / sells`,
          types: ['token'],
        },
        { id: 'list', label: `list — ${src.label} (${src.help}, up to 30 tokens), each with price, 24h change, liquidity and volume`, types: ['table'] },
        { id: 'info', label: `info — summary of the ${src.label.toLowerCase()} list: token count, tokens per chain, total liquidity and volume`, types: ['table'] },
        { id: 'error', label: 'error — the token and why the lookup failed (not found, network…)', types: ['table'], error: true },
      ],
    }
  },
  receive: (ctx, inlet, msg) => {
    if (inlet === 'refresh') return bang(ctx)
    if (inlet !== 'token') return
    // A plain signal (e.g. from a Timer, or an empty message box) is a blank token: clear the selected
    // token, then fetch what needs no token (list & info). Right-click → Fetch now refreshes without clearing.
    if (isBang(msg) || (typeof msg === 'string' && !msg.trim())) {
      ctx.update({ query: '', pairAddress: '', pairLabel: '' })
      forgetSent(ctx.id, 'data')
      return bang(ctx)
    }
    // A table of many rows: its first row.
    if (Array.isArray(msg)) msg = msg[0] ?? ''
    // A Token (from a Token block, a list row, another card's data).
    if (isToken(msg) || isTokenItem(msg)) {
      if (msg.address && msg.chain) {
        ctx.update({
          query: msg.address,
          chain: msg.chain,
          pairAddress: typeof msg.pool === 'string' && msg.pool ? msg.pool : msg.source === 'dexscreener' && msg.pair ? String(msg.pair) : '',
          pairLabel: msg.quote ? `${msg.symbol}/${msg.quote}` : msg.symbol,
        })
        return sendData(ctx)
      }
      msg = msg.symbol
    }
    const text = typeof msg === 'string' || typeof msg === 'number' ? String(msg).trim() : ''
    if (!text) return
    // "<chain> <token>" pins a chain; a bare token searches every chain for its most traded pair.
    const [first, ...rest] = text.split(/\s+/)
    const pinned = rest.length > 0 && CHAINS.some((c) => c.value && c.value === first.toLowerCase())
    const token = pinned ? rest.join(' ') : text
    ctx.update({ query: token, chain: pinned ? first.toLowerCase() : '', pairAddress: '', pairLabel: token })
    return sendData(ctx)
  },
  menu: [
    { label: 'Fetch now', run: (ctx) => bang(ctx) },
    {
      label: 'Clear token',
      run: (ctx) => {
        ctx.update({ query: '', pairAddress: '', pairLabel: '' })
        forgetSent(ctx.id, 'data')
      },
    },
  ],
  defaultProps: {
    query: 'So11111111111111111111111111111111111111112',
    chain: 'solana',
    pairAddress: '',
    pairLabel: 'SOL/USDC',
    refreshSec: 30,
    showChanges: true,
    showTxns: true,
    showLinks: true,
    listSource: 'trending',
    outputOnUpdate: true,
  },
  width: 560,
  settings: [
    { key: 'chain', label: 'Chain', type: 'select', options: CHAINS },
    { key: 'query', label: 'Token', type: 'tokenSearch' },
    { key: 'refreshSec', label: 'Auto-refresh (seconds)', type: 'number', min: 0, max: 3600, help: '0 turns live updates off' },
    { key: 'showChanges', label: 'Show price changes', type: 'toggle' },
    { key: 'showTxns', label: 'Show buys / sells', type: 'toggle' },
    { key: 'showLinks', label: 'Show links', type: 'toggle' },
    {
      key: 'listSource',
      label: 'List to fetch',
      type: 'select',
      options: LIST_SOURCES.map((s) => ({ value: s.value, label: `${s.label} — ${s.help}` })),
      help: 'Fetched and sent out of list when a signal arrives (or right-click → Fetch now)',
    },
    { key: 'outputOnUpdate', label: 'Send data out on every update', type: 'toggle' },
  ],
  Render: TokenCard,
}
