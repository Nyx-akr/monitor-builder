import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BlockContext, BlockDefinition, Query } from '../types'
import { num, type SeriesValue, type Token } from '../../core/values'
import { metricByKey, metricOptions } from '../../core/metrics'
import { API_NAMES, FEED_SOURCES, feedSource, isList, type Api, type FeedSource } from '../../core/feedSources'
import { ask } from '../../engine/client'
import { formatValue } from '../../core/show'
import { CHAINS } from '../../services/chains'
import { CLOCK_IN, DataStatus, Empty, MiniTable, TokenLine, marketTable, refreshMs, trackTokens, type MarketRow } from '../shared'

// ---------- a token search box ----------

export function TokenSearchBox({ onPick, placeholder = 'Search a token — name, symbol or address' }: { onPick: (t: Token) => void; placeholder?: string }) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<MarketRow[]>([])
  const [open, setOpen] = useState(false)
  const seq = useRef(0)
  useEffect(() => {
    if (q.trim().length < 2) return setRows([])
    const n = ++seq.current
    const t = setTimeout(() => {
      ask<{ rows: MarketRow[] }>('search', { q: q.trim() })
        .then((r) => n === seq.current && setRows(r.rows))
        .catch(() => n === seq.current && setRows([]))
    }, 300)
    return () => clearTimeout(t)
  }, [q])
  return (
    <div className="bx-search">
      <input value={q} onChange={(e) => (setQ(e.target.value), setOpen(true))} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} placeholder={placeholder} />
      {open && rows.length > 0 && (
        <div className="bx-results scroll-y">
          {rows.map((r) => (
            <button
              key={r.token.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(r.token)
                setQ('')
                setOpen(false)
              }}
            >
              <TokenLine token={r.token} extra={<span className="dim" style={{ marginLeft: 'auto' }}>Vol {formatValue(r.metrics.volume24h, 'usd')}</span>} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const parseToken = (json: unknown): Token | null => {
  try {
    const t = JSON.parse(String(json || 'null'))
    return t && t.kind === 'token' ? t : null
  } catch {
    return null
  }
}

// ---------- Token ----------

type TokenProps = { query: string; chain: string; pairAddress: string; pairLabel: string; token: string }

/** The selected token: the one wired in (it follows it), or the one picked here. */
function selected(props: TokenProps, wired?: Token): Token | null {
  if (wired) return wired
  const saved = parseToken(props.token)
  if (saved && saved.address === props.query) return saved
  if (!props.query || !props.chain) return saved
  const symbol = String(props.pairLabel || '').split('/')[0] || props.query.slice(0, 6)
  return { kind: 'token', id: `${props.chain}:${props.query}`, chain: props.chain, address: props.query, symbol, name: symbol, pool: props.pairAddress || null }
}

function TokenView({ ctx, big }: { props: TokenProps; ctx: BlockContext<TokenProps>; big?: boolean }) {
  const t = ctx.outputs.token?.kind === 'token' ? ctx.outputs.token : null
  const row = (ctx.data[0]?.data as { rows?: Record<string, MarketRow> } | undefined)?.rows?.[t?.id ?? '']
  const pick = (tok: Token) => ctx.update({ token: JSON.stringify(tok), query: tok.address, chain: tok.chain, pairAddress: tok.pool ?? '', pairLabel: tok.symbol })
  const list = ctx.inputs.list?.kind === 'table' ? ctx.inputs.list : null
  return (
    <div className={`bx${big ? ' fill' : ''}`}>
      <div className="bx-head">
        <span className="bx-icon">🪙</span>
        <span className="bx-title">
          {t ? <TokenLine token={row?.token ?? t} /> : <strong>Token</strong>}
          {!t && <small>{ctx.inputs.list ? 'Pick one from the list' : 'Pick one in the right panel'}</small>}
        </span>
        <DataStatus states={ctx.data} />
      </div>
      {(big || !ctx.inputs.in) && (
        <div className="bx-body">
          {!ctx.inputs.in &&
            (list ? (
              <div className="bx-list scroll-y">
                <MiniTable table={list} columns={['price', 'change24h']} max={1000} selectedId={t?.id} onPick={pick} />
              </div>
            ) : (
              !t && <Empty>Wire a Feed (or any token list) into “list” to pick from it — or search in the right panel.</Empty>
            ))}
          {row && (
            <div className="bx-row" style={{ marginTop: 6 }}>
              <span>Price</span>
              <b>
                {formatValue(row.metrics.price, 'usd')}{' '}
                <span className={(row.metrics.change24h ?? 0) >= 0 ? 'up' : 'down'}>{formatValue(row.metrics.change24h, 'pct')}</span>
              </b>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const token: BlockDefinition<TokenProps> = {
  type: 'token',
  label: 'Token',
  description: 'Pick a token — everything wired to it follows it',
  icon: '🪙',
  category: 'pick',
  defaultProps: { query: '', chain: '', pairAddress: '', pairLabel: '', token: '' },
  settings: [{ key: 'query', label: 'Token', type: 'tokenSearch', help: 'Search by name, symbol or contract address, any chain. Or wire a Feed into “list” and pick in the box.' }],
  inlets: [
    { id: 'list', label: 'A token list to pick from (e.g. a Feed)', types: ['table'] },
    { id: 'in', label: 'A token wired in replaces the picked one (e.g. a Feed’s “selected”)', types: ['token'] },
    CLOCK_IN,
  ],
  outlets: [{ id: 'token', label: 'The selected token: chain, address, symbol, name, logo', types: ['token'] }],
  // Its own market row: name, logo and price for the box (and it keeps the token recorded).
  query: (props, inputs) => {
    const t = selected(props, inputs.in?.kind === 'token' ? inputs.in : undefined)
    return t ? { kind: 'market', params: { ids: t.id }, refreshMs: refreshMs(inputs, {}, 30, 1) } : null
  },
  compute: ({ props, inputs, data }) => {
    const t = selected(props, inputs.in?.kind === 'token' ? inputs.in : undefined)
    if (!t) return {}
    const row = (data[0]?.data as { rows?: Record<string, MarketRow> } | undefined)?.rows?.[t.id]
    return { token: row ? { ...row.token, pool: t.pool ?? row.token.pool } : t }
  },
  Render: (p) => <TokenView {...p} />,
  Widget: (p) => <TokenView {...p} big />,
}

// ---------- the Feed's selected token (followed by Token details) ----------

let feedSelected: Token | null = null
const selectedListeners = new Set<() => void>()
const publishSelected = (t: Token | null) => {
  if (t?.id === feedSelected?.id) return
  feedSelected = t
  selectedListeners.forEach((l) => l())
}
/** Make a token the selected one (from the Watchlist, a dashboard click…): the Feed holds the selection. */
let selectHandler: ((t: Token) => void) | null = null
export const selectToken = (t: Token) => selectHandler?.(t)

/** The token selected in the Feed right now. */
export const useFeedSelected = () =>
  useSyncExternalStore(
    (l) => (selectedListeners.add(l), () => void selectedListeners.delete(l)),
    () => feedSelected,
  )

/** A saved list of tokens (the Feed's watchlist). */
const parseList = (json: string): Token[] => {
  try {
    const v = JSON.parse(json || '[]')
    return Array.isArray(v) ? v.filter((t) => t?.kind === 'token') : []
  } catch {
    return []
  }
}

// ---------- Feed ----------

/*
 * The Feed shows lists from the server's storage (server/collector.ts): every source is fetched on its own
 * timer in the background whether it's ticked or not, and every token is recorded. Ticking a source only
 * shows or hides it. When a source has fetched, the list — and the selected token's history — update at once.
 */

type FeedProps = { chain: string; limit: number; selected: string; metric: string; hours: number; keepDays: number } & Record<string, string | number | boolean>

const shownSources = (props: FeedProps) => FEED_SOURCES.filter((s) => isList(s) && props[s.key] === true).map((s) => s.key)
const everyOf = (props: FeedProps, s: FeedSource) => Math.max(0, Number(props[`every_${s.key}`] ?? s.every))
const pagesOf = (props: FeedProps, s: FeedSource) => (s.pages ? Math.min(s.maxPages ?? 10, Math.max(1, Number(props[`pages_${s.key}`] ?? s.pages))) : undefined)


/** The chains the Feed shows (none = all). Older flows have a single `chain`. */
const chainsOf = (props: FeedProps): string[] => String(props.chains ?? props.chain ?? '').split(',').filter(Boolean)
const CHAIN_CHOICES = [...CHAINS.map((c) => ({ id: c.id, label: c.label })), { id: 'coingecko', label: 'CoinGecko coins' }]
const CHAIN_LABEL: Record<string, string> = Object.fromEntries(CHAIN_CHOICES.map((c) => [c.id, c.label]))

/** The last answer, for the right panel (it gets only the block's inputs and outputs). */
let lastFeedAnswer: FeedAnswer | null = null

/** The Feed's right panel: chains, the lists and their timers, enrichment, the API budget, storage. */
function FeedPanel({ props, update }: { props: FeedProps; update: (p: Partial<FeedProps>) => void }) {
  const answer = lastFeedAnswer
  const status = new Map((answer?.sources ?? []).map((s) => [s.key, s]))
  const chains = chainsOf(props)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const toggleChain = (id: string) => update({ chains: (chains.includes(id) ? chains.filter((c) => c !== id) : [...chains, id]).join(','), chain: '' })
  const num = (key: string, value: number, min: number, max?: number) => (
    <input type="number" className="fp-num" value={value} min={min} max={max} onChange={(e) => update({ [key]: Number(e.target.value) })} />
  )
  const row = (s: FeedSource) => {
    const st = status.get(s.key)
    const every = everyOf(props, s)
    return (
      <div key={s.key} className={`fp-src${every === 0 ? ' off' : ''}`}>
        <div className="fp-src-head">
          {isList(s) && <input type="checkbox" className="sf-switch" checked={props[s.key] === true} onChange={(e) => update({ [s.key]: e.target.checked })} title="Show it in the Feed" />}
          <b>{s.label}</b>
          <span className={`fp-state${st?.error ? ' down' : ''}`} title={st?.error}>
            {every === 0 ? 'off' : st?.running ? 'fetching…' : st?.error ? 'error' : st?.lastAt ? `${ago(now - st.lastAt)} ago` : 'waiting'}
          </span>
        </div>
        <div className="fp-src-ctl">
          <span className="dim">{st ? `${st.count.toLocaleString()} tokens` : '—'}</span>
          <label>
            every {num(`every_${s.key}`, every, 0)} s
          </label>
          {s.pages && (
            <label>
              {num(`pages_${s.key}`, pagesOf(props, s)!, 1, s.maxPages)} {s.pagesLabel ?? `× ${s.perPage}`}
            </label>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="fp">
      <section>
        <h3>Chains</h3>
        <div className="fp-chips">
          <button className={chains.length === 0 ? 'on' : ''} onClick={() => update({ chains: '', chain: '' })}>
            All
          </button>
          {CHAIN_CHOICES.map((c) => (
            <button key={c.id} className={chains.includes(c.id) ? 'on' : ''} onClick={() => toggleChain(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>Lists</h3>
        <p className="fp-help">Tick to show a list here. Every list is fetched and stored in the background on its timer (0 = off), shown or not.</p>
        {FEED_SOURCES.filter(isList).map(row)}
        <label className="fp-line">
          Show up to {num('limit', Number(props.limit) || 200, 1, 2000)} tokens
        </label>
      </section>
      <section>
        <h3>Enrichment</h3>
        <p className="fp-help">Values added to every stored token (and its history) — the Feed’s columns and Filter can use them.</p>
        {FEED_SOURCES.filter((s) => !isList(s)).map(row)}
        {Object.entries(answer?.tape ?? {}).map(([chain, t]) => (
          <p key={chain} className="fp-help">
            Trade tape · {CHAIN_LABEL[chain] ?? chain}: {t.pools} pools ({t.freshPools} sampled in the last 30 min) · {t.trades.toLocaleString()} trades · {t.wallets.toLocaleString()} wallets,{' '}
            <b>{t.sharedWallets.toLocaleString()} seen in 2+ pools</b>
            {t.from && t.to ? ` · covers ${ago(t.to - t.from)}` : ''}
          </p>
        ))}
      </section>
      {answer && (
        <section>
          <h3>API budget</h3>
          {(Object.entries(answer.budget) as [Api, { used: number; limit: number }][]).map(([api, b]) => {
            const share = Math.min(1, b.used / b.limit)
            return (
              <div key={api} className="fp-budget">
                <span>{API_NAMES[api]}</span>
                <div className="fp-bar">
                  <div style={{ width: `${share * 100}%` }} className={share > 0.8 ? 'hot' : share > 0.5 ? 'warm' : ''} />
                </div>
                <small>
                  {b.used.toFixed(1)} / {b.limit} a min
                </small>
              </div>
            )
          })}
        </section>
      )}
      <section>
        <h3>Selected token</h3>
        <p className="fp-help">Its stored history goes out of “history”, updated each time a source fetches it.</p>
        <label className="fp-line">
          History of
          <select className="fp-select" value={String(props.metric || 'price')} onChange={(e) => update({ metric: e.target.value })}>
            {metricOptions().map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          over the last {num('hours', Number(props.hours) || 24, 1)} h
        </label>
      </section>
      <section>
        <h3>Storage</h3>
        {answer && (
          <p className="fp-help">
            {answer.storage.files.toLocaleString()} tokens stored · {size(answer.storage.bytes)} in data/history
          </p>
        )}
        <label className="fp-line">
          Keep tokens not seen for {num('keepDays', Number(props.keepDays ?? 7), 0)} days (0 = forever)
        </label>
      </section>
    </div>
  )
}


interface SourceStatus {
  key: string
  count: number
  every: number
  lastAt?: number
  lastMs?: number
  nextAt?: number
  running: boolean
  error?: string
}
interface FeedAnswer {
  rows: MarketRow[]
  /** The selected token's newest values, from any source (or the watch that keeps it updated). */
  selectedRow?: MarketRow | null
  sources: SourceStatus[]
  storage: { files: number; bytes: number; keepDays: number }
  /** The trade tape, per chain (the rotation engine's input). */
  tape?: Record<string, { pools: number; trades: number; wallets: number; sharedWallets: number; from: number | null; to: number | null; freshPools: number }>
  /** API calls per minute the timers use now, against each API's limit (from the server, which knows the token counts). */
  budget: Record<Api, { used: number; limit: number }>
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`)
const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`)

function FeedView({ props, ctx, big }: { props: FeedProps; ctx: BlockContext<FeedProps>; big?: boolean }) {
  const table = ctx.outputs.tokens?.kind === 'table' ? ctx.outputs.tokens : null
  const picked = ctx.outputs.selected?.kind === 'token' ? ctx.outputs.selected : null
  const answer = ctx.data[0]?.data as FeedAnswer | undefined
  const shown = shownSources(props)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // The timers live on the server (one storage for every Feed): send them when they change.
  const config = JSON.stringify({
    sources: Object.fromEntries(FEED_SOURCES.map((s) => [s.key, { every: everyOf(props, s), ...(s.pages ? { pages: pagesOf(props, s) } : {}) }])),
    keepDays: Number(props.keepDays ?? 7),
  })
  useEffect(() => {
    const t = setTimeout(() => void fetch('/api/engine/feed/config', { method: 'POST', body: config }).catch(() => {}), 500)
    return () => clearTimeout(t)
  }, [config])

  // The watchlist lives in the Feed: ☆ on a row adds or removes it; the toggle shows only it.
  const watchList = parseList(String(props.watch ?? '[]'))
  const watchIds = new Set(watchList.map((t) => t.id))
  const toggleWatch = (t: Token) =>
    ctx.update({ watch: JSON.stringify(watchIds.has(t.id) ? watchList.filter((x) => x.id !== t.id) : [...watchList, { kind: 'token', id: t.id, chain: t.chain, address: t.address, symbol: t.symbol, name: t.name, logo: t.logo ?? null, pool: t.pool ?? null }]) })
  const watchOnly = props.watchOnly === true
  // The server tracks the watchlist in full (trade sample, quotes, every source), every 2 minutes.
  const watchKey = watchList.map((t) => t.id).join(',')
  useEffect(() => trackTokens('watchlist', watchList), [watchKey])
  useEffect(() => publishSelected(picked), [picked])
  // Others (the Watchlist) can select a token too: it becomes the Feed's selection.
  const updateRef = useRef(ctx.update)
  updateRef.current = ctx.update
  useEffect(() => {
    selectHandler = (t) => updateRef.current({ selected: JSON.stringify(t) })
    return () => void (selectHandler = null)
  }, [])
  // Search: filters the list, and finds tokens on any chain that aren't in it.
  const [q, setQ] = useState('')
  const [found, setFound] = useState<MarketRow[]>([])
  const term = q.trim().toLowerCase()
  useEffect(() => {
    if (term.length < 2) return setFound([])
    let live = true
    const t = setTimeout(() => {
      ask<{ rows: MarketRow[] }>('search', { q: term })
        .then((r) => live && setFound(r.rows))
        .catch(() => live && setFound([]))
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [term])
  const matches = (r: { token?: Token }) =>
    !term || Boolean(r.token && (r.token.symbol.toLowerCase().includes(term) || r.token.name.toLowerCase().includes(term) || r.token.address.toLowerCase() === term))
  const listed = table ? { ...table, rows: table.rows.filter(matches) } : null
  const elsewhere = found.filter((r) => !table?.rows.some((x) => x.token?.id === r.token.id))
  const pick = (t: Token) => ctx.update({ selected: JSON.stringify(t) })
  const status = new Map((answer?.sources ?? []).map((s) => [s.key, s]))
  const background = FEED_SOURCES.filter((s) => isList(s) && !shown.includes(s.key) && everyOf(props, s) > 0).length
  const enrich = FEED_SOURCES.filter((s) => !isList(s)).map((s) => ({ def: s, st: status.get(s.key) }))
  const busy = answer ? (Object.entries(answer.budget) as [Api, { used: number; limit: number }][]).filter(([, b]) => b.used > b.limit * 0.8) : []
  return (
    <div className={`bx${big ? ' fill' : ''}`}>
      <div className="bx-head">
        <button className={`fd-watch${watchOnly ? ' on' : ''}`} onClick={() => ctx.update({ watchOnly: !watchOnly })} title={watchOnly ? 'Showing your watchlist — click to show the lists' : 'Show only your watchlist'}>
          {watchOnly ? '★' : '☆'} Watchlist <span>{watchList.length}</span>
        </button>
        <span className="bx-title">
          <small>
            {table ? `${table.rows.length} tokens · ` : ''}
            {chainsOf(props).length ? chainsOf(props).map((c) => CHAIN_LABEL[c] ?? c).join(', ') : 'All chains'}
          </small>
        </span>
        <DataStatus states={ctx.data.slice(0, 1)} />
      </div>
      <div className="bx-body">
        <div className="bx-sources" style={watchOnly ? { display: 'none' } : undefined}>
          {shown.map((k) => {
            const s = status.get(k)
            const def = feedSource(k)!
            return (
              <div key={k} className={`bx-source${s?.error ? ' err' : ''}`} title={s?.error}>
                <b>{def.short}</b>
                <span>{s ? s.count : '…'}</span>
                <span className="dim">
                  {s?.running ? 'fetching…' : s?.lastAt ? `${ago(now - s.lastAt)} ago` : 'waiting'}
                  {s?.every ? ` · next ${s.nextAt && s.nextAt > now ? ago(s.nextAt - now) : 'now'}` : ' · off'}
                </span>
              </div>
            )
          })}
        </div>
        <input className="bx-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search — symbol, name or address, any chain" />
        {watchOnly && !watchList.length ? (
          <Empty>Star ☆ tokens in the list to add them to your watchlist.</Empty>
        ) : !watchOnly && !shown.length ? (
          <Empty>Tick the sources to show in the right panel.</Empty>
        ) : listed && listed.rows.length ? (
          <div className="bx-list scroll-y">
            <MiniTable
              table={listed}
              columns={['price', 'change24h', 'volume24h', 'liquidity']}
              max={2000}
              selectedId={picked?.id}
              onPick={pick}
              starred={watchIds}
              onStar={toggleWatch}
            />
          </div>
        ) : term ? (
          <div className="bx-note">Nothing in the list matches “{q.trim()}”.</div>
        ) : (
          <Empty>{ctx.data[0]?.loading ? 'Loading…' : 'Nothing yet — the sources are fetching.'}</Empty>
        )}
        {term.length >= 2 && elsewhere.length > 0 && (
          <>
            <div className="bx-section">Other tokens matching “{q.trim()}”</div>
            <div className="bx-list scroll-y">
              <MiniTable table={marketTable(elsewhere)} columns={['price', 'change24h', 'volume24h', 'liquidity']} max={25} selectedId={picked?.id} onPick={pick} starred={watchIds} onStar={toggleWatch} />
            </div>
          </>
        )}
        <div className="bx-note">
          {background > 0 && `${background} more source${background === 1 ? '' : 's'} fetching in the background · `}
          {answer && `Stored: ${answer.storage.files.toLocaleString()} tokens, ${size(answer.storage.bytes)}`}
        </div>
        <div className="bx-note">
          Enriched: {enrich.map(({ def, st }) => `${def.short} ${st ? st.count.toLocaleString() : '…'}`).join(' · ')}
          {busy.map(([api, b]) => (
            <span key={api} className="down">
              {' '}
              · {API_NAMES[api]} near its limit: {b.used.toFixed(1)} of {b.limit} calls/min
            </span>
          ))}
        </div>
        {table && table.rows.length > 0 && <div className="bx-note">Click a token: it goes out of “selected”, its stored history out of “history”.</div>}
      </div>
    </div>
  )
}

export const feed: BlockDefinition<FeedProps> = {
  type: 'feed',
  label: 'Feed',
  description: 'Token lists from many sources — stored, and live',
  icon: '📡',
  category: 'pick',
  // One Feed per flow, always there: it can be moved (or dropped onto the Page), not deleted or duplicated.
  permanent: true,
  width: 380,
  defaultProps: {
    gtTrending: true,
    dsTrending: true,
    chain: '',
    chains: '',
    limit: 200,
    selected: '',
    watch: '[]',
    watchOnly: false,
    metric: 'price',
    hours: 24,
    keepDays: 7,
    // Each source's documented timer and pages (see core/feedSources).
    ...Object.fromEntries(FEED_SOURCES.flatMap((s) => [[`every_${s.key}`, s.every], ...(s.pages ? [[`pages_${s.key}`, s.pages]] : [])])),
  },
  settings: [],
  Info: FeedPanel,
  outlets: [
    { id: 'tokens', label: 'The list shown (the watchlist when it’s on): one row per token, every standard metric as a column', types: ['table'] },
    { id: 'watchlist', label: 'Your watchlist (the starred tokens), live', types: ['table'] },
    { id: 'selected', label: 'The token you clicked, with its latest values', types: ['token'] },
    { id: 'history', label: 'The selected token’s stored history (live)', types: ['series'] },
    { id: 'value', label: 'The selected token’s latest value of that metric', types: ['number'] },
  ],
  query: (props) => {
    const shown = shownSources(props)
    const picked = parseToken(props.selected)
    // No timer here: the sources' fetches push updates; these slow re-asks are only a safety net.
    const qs: Query[] = [
      { kind: 'feed', params: { sources: shown.join(','), chain: chainsOf(props).join(','), limit: Math.min(2000, Number(props.limit) || 200), selected: picked?.id ?? '' }, refreshMs: 60_000 },
    ]
    // The watchlist's live values (its tokens may not be in any list).
    const watch = parseList(String(props.watch ?? '[]'))
    if (watch.length) qs.push({ kind: 'market', params: { ids: watch.map((t) => t.id).join(',') }, refreshMs: 30_000 })
    if (picked) qs.push({ kind: 'history', params: { id: picked.id, metric: String(props.metric || 'price'), hours: Math.max(1, Number(props.hours) || 24) }, refreshMs: 60_000 })
    return qs
  },
  compute: ({ props, data }) => {
    const answer = data[0]?.data as FeedAnswer | undefined
    if (answer) lastFeedAnswer = answer
    const picked = parseToken(props.selected)
    // The picked token with its latest values: from the list, or from any source that has it.
    const freshRow = picked ? (answer?.selectedRow?.token.id === picked.id ? answer.selectedRow : answer?.rows.find((r) => r.token.id === picked.id)) : undefined
    const m = metricByKey(String(props.metric || 'price'))
    const watch = parseList(String(props.watch ?? '[]'))
    const historyAt = watch.length ? 2 : 1
    const points = (data[historyAt]?.data as { points?: [number, number][] } | undefined)?.points
    const marketRows = watch.length ? (data[1]?.data as { rows?: Record<string, MarketRow> } | undefined)?.rows ?? {} : {}
    // Each starred token with its live values (from the lists when it's there, so it carries the enrichment).
    const watchRows = watch
      .map((t) => answer?.rows.find((r) => r.token.id === t.id) ?? marketRows[t.id])
      .filter((r): r is MarketRow => Boolean(r))
    const chains = chainsOf(props)
    const watchShown = watchRows.filter((r) => !chains.length || chains.includes(r.token.chain))
    const label = `${picked?.symbol ?? ''} ${m?.label ?? props.metric}`.trim()
    const latest = freshRow?.metrics[String(props.metric || 'price')] ?? points?.[points.length - 1]?.[1] ?? null
    return {
      ...(props.watchOnly === true ? { tokens: marketTable(watchShown) } : answer ? { tokens: marketTable(answer.rows) } : {}),
      watchlist: marketTable(watchRows),
      ...(picked ? { selected: freshRow?.token ?? picked } : {}),
      ...(picked && points ? { history: { kind: 'series', label, unit: m?.unit ?? 'none', points } satisfies SeriesValue } : {}),
      ...(picked ? { value: num(latest, m?.unit ?? 'none', label) } : {}),
    }
  },
  Render: (p) => <FeedView {...p} />,
  Widget: (p) => <FeedView {...p} big />,
}

export const pickBlocks = [token, feed]
