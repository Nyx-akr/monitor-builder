import type { BlockDefinition } from '../../types'
import { CHAINS } from '../../../lib/dexscreener'
import { useDexPair } from '../../../lib/useDexPair'
import { age, percent, shortAddress, usdCompact, usdPrice } from '../../../lib/format'
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
}

const WINDOWS = ['m5', 'h1', 'h6', 'h24'] as const

function TokenCard({ props }: { props: Props }) {
  const { pair, loading, error, updatedAt } = useDexPair(props.query, props.chain, props.pairAddress ?? '', props.refreshSec)

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
  label: 'Token Card',
  description: 'Live price & stats from DexScreener',
  icon: '🪙',
  category: 'cards',
  inlets: [{ id: 'token', label: 'token — address or symbol (e.g. PEPE); "solana BONK" pins a chain' }],
  receive: (ctx, inlet, msg) => {
    const text = String(msg).trim()
    if (inlet !== 'token' || !text || text === 'bang') return
    // "<chain> <token>" pins a chain; a bare token searches every chain for its most liquid pair.
    const [first, ...rest] = text.split(/\s+/)
    const pinned = rest.length > 0 && CHAINS.some((c) => c.value && c.value === first.toLowerCase())
    const token = pinned ? rest.join(' ') : text
    ctx.update({ query: token, chain: pinned ? first.toLowerCase() : '', pairAddress: '', pairLabel: token })
  },
  defaultProps: {
    query: 'So11111111111111111111111111111111111111112',
    chain: 'solana',
    pairAddress: '',
    pairLabel: 'SOL/USDC',
    refreshSec: 30,
    showChanges: true,
    showTxns: true,
    showLinks: true,
  },
  width: 560,
  settings: [
    { key: 'chain', label: 'Chain', type: 'select', options: CHAINS },
    { key: 'query', label: 'Token', type: 'tokenSearch' },
    { key: 'refreshSec', label: 'Auto-refresh (seconds)', type: 'number', min: 0, max: 3600, help: '0 turns live updates off' },
    { key: 'showChanges', label: 'Show price changes', type: 'toggle' },
    { key: 'showTxns', label: 'Show buys / sells', type: 'toggle' },
    { key: 'showLinks', label: 'Show links', type: 'toggle' },
  ],
  Render: TokenCard,
}
