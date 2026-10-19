import { useEffect, useState } from 'react'
import type { BlockContext, BlockDefinition, BlockProps, Query } from '../types'
import type { Column, Row, TableValue, Token } from '../../core/values'
import { formatValue } from '../../core/show'
import { ask, refresh } from '../../engine/client'
import { DataStatus, Empty } from '../shared'
import { selectToken, useFeedSelected } from '../pick'
import './engine.css'

/*
 * The rotation engine's tools (its logic lives on the server: server/rotation.ts, smart.ts, calls.ts):
 *   Rotation board  — every evaluated token, ranked by the chosen engine, with its phase and call; the rules
 *   Market rotation — per chain, where capital is going between the sampled pools
 *   Evaluation      — how each engine's calls did, graded from the stored prices; smart wallets learned
 */

// ---------- what the server answers ----------

interface EngineInfo {
  key: string
  label: string
  blurb: string
}
interface BoardToken {
  token: Token
  phase: string | null
  call: { call: string | null; why: string }
  calls: Record<string, string | null>
  scores: Record<string, number | null>
  rotation: { inWallets: number; outWallets: number; inUsd: number; outUsd: number } | null
  market: { inUsd: number; outUsd: number; net: number; connected: number } | null
  costPct: number | null
  plan: { entry: number; target: number; stop: number; targetPct: number; stopPct: number; holdHours: number } | null
  at: number
}
interface Coverage {
  pools: number
  trades: number
  wallets: number
  sharedWallets: number
  freshPools: number
}
interface BoardAnswer {
  engine: string
  engines: EngineInfo[]
  coverage: Record<string, Coverage>
  smart: { pending: number; judged: number; baseWinPct: number | null; chains: Record<string, { judgedWallets: number; smart: number }> } | null
  tokens: BoardToken[]
}

const CHAIN_NAMES: Record<string, string> = { solana: 'Solana', ethereum: 'Ethereum', bsc: 'BNB', base: 'Base', arbitrum: 'Arbitrum', polygon: 'Polygon', avalanche: 'Avalanche', optimism: 'Optimism' }
const chainName = (c: string) => CHAIN_NAMES[c] ?? c

export function CallBadge({ call }: { call: string | null | undefined }) {
  return <span className={`eg-call ${String(call ?? 'none').toLowerCase()}`}>{call ?? '—'}</span>
}
export function PhaseBadge({ phase }: { phase: string | null | undefined }) {
  return <span className={`eg-phase ${String(phase ?? 'none').toLowerCase()}`}>{phase ?? '—'}</span>
}

// ---------- following a token (wired in, or the Feed's selection) ----------

type FollowProps = { follow: boolean; token: string }

const parseToken = (json: unknown): Token | null => {
  try {
    const t = JSON.parse(String(json || 'null'))
    return t && t.kind === 'token' ? t : null
  } catch {
    return null
  }
}

/** The token a block looks at: the one wired in, else the Feed's selection when it follows it. */
const focusOf = (props: FollowProps, inputs: Record<string, unknown>): Token | null => {
  const wired = inputs.token as Token | undefined
  if (wired?.kind === 'token') return wired
  return props.follow ? parseToken(props.token) : null
}

/** Keep the followed token in the block (so it survives a reload and the query can read it). */
function useFollow(props: FollowProps, ctx: BlockContext<any>) {
  const selected = useFeedSelected()
  useEffect(() => {
    if (!props.follow || ctx.inputs.token) return
    const next = selected ? JSON.stringify(selected) : ''
    if (parseToken(props.token)?.id !== selected?.id) ctx.update({ token: next })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, props.follow, ctx.inputs.token])
}

const TOKEN_IN = { id: 'token', label: 'A token (optional): narrows the view to it', types: ['token' as const] }

/** A section of an explanation panel. */
function Explain({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ex">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

// ---------- Rotation board ----------

type BoardProps = { chain: string; onlyBuys: boolean; limit: number }

const boardTable = (tokens: BoardToken[], engine: string): TableValue => {
  const columns: Column[] = [
    { key: 'score', label: 'Score', unit: 'none' },
    { key: 'rotIn', label: 'Rot in', unit: 'count' },
    { key: 'rotOut', label: 'Rot out', unit: 'count' },
    { key: 'flow2h', label: 'Flow 2h', unit: 'usd' },
    { key: 'cost', label: 'Cost', unit: 'pct' },
    { key: 'phase', label: 'Phase', unit: 'none' },
    { key: 'call', label: 'Call', unit: 'none' },
  ]
  const rows: Row[] = tokens.map((t) => ({
    token: t.token,
    symbol: t.token.symbol,
    score: t.scores[engine] ?? null,
    rotIn: t.rotation?.inWallets ?? null,
    rotOut: t.rotation?.outWallets ?? null,
    flow2h: t.market?.net ?? null,
    cost: t.costPct,
    phase: t.phase ?? '',
    call: t.call.call ?? '',
  }))
  return { kind: 'table', columns, rows }
}

/** Ranked by the chosen engine's score, BUYs first. */
const ranked = (a: BoardAnswer | undefined, props: BoardProps) => {
  if (!a) return []
  const rank = (c: string | null) => (c === 'BUY' ? 0 : c === 'WATCH' ? 1 : c === 'SELL' ? 2 : 3)
  return a.tokens
    .filter((t) => !props.onlyBuys || t.call.call === 'BUY')
    .sort((x, y) => rank(x.call.call) - rank(y.call.call) || (y.scores[a.engine] ?? -1) - (x.scores[a.engine] ?? -1))
    .slice(0, Math.max(1, Number(props.limit) || 50))
}

function BoardView({ props, ctx, big }: { props: BoardProps; ctx: BlockContext<BoardProps>; big?: boolean }) {
  const a = ctx.data[0]?.data as BoardAnswer | undefined
  const selected = useFeedSelected()
  const engineLabel = a?.engines.find((e) => e.key === a.engine)?.label ?? 'Rotation'
  const list = ranked(a, props)
  const buys = a?.tokens.filter((t) => t.call.call === 'BUY').length ?? 0
  return (
    <div className={`bx${big ? ' fill' : ''} wide`}>
      <div className="bx-head">
        <span className="bx-icon">🔄</span>
        <span className="bx-title">
          <strong>{engineLabel}</strong>
          <small>
            {a ? `${a.tokens.length} tokens · ${buys} BUY` : 'Loading…'}
            {props.chain ? ` · ${chainName(props.chain)}` : ''}
          </small>
        </span>
        <button className={`fd-watch${props.onlyBuys ? ' on' : ''}`} onClick={() => ctx.update({ onlyBuys: !props.onlyBuys })} title="Show only BUY calls">
          BUY only
        </button>
        <DataStatus states={ctx.data} />
      </div>
      <div className="bx-body">
        {a && (
          <div className="eg-coverage">
            {Object.entries(a.coverage).map(([c, v]) => (
              <span key={c} title={`${v.pools} pools on the tape, ${v.freshPools} sampled in the last 30 min · ${v.trades.toLocaleString()} trades · ${v.wallets.toLocaleString()} wallets, ${v.sharedWallets} in 2+ pools`}>
                {chainName(c)} <b>{v.freshPools}</b>/{v.pools} pools · {v.sharedWallets} shared w.
                {a.smart?.chains[c] ? ` · ${a.smart.chains[c].smart} smart` : ''}
              </span>
            ))}
          </div>
        )}
        {!a ? (
          <Empty>Waiting for the rotation engine…</Empty>
        ) : !list.length ? (
          <Empty>{props.onlyBuys ? 'No BUY calls right now.' : 'No tokens evaluated yet — the trade tape is filling.'}</Empty>
        ) : (
          <div className="bx-list scroll-y">
            <table className="bx-table eg-board">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Phase</th>
                  <th>Call</th>
                  <th className="num">Score</th>
                  <th className="num">In / out</th>
                  <th className="num">Flow 2h</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.token.id} className={`pick${selected?.id === t.token.id ? ' sel' : ''}`} onClick={() => selectToken(t.token)} title={t.call.why}>
                    <td className="sym">
                      {t.token.symbol} <span className="dim">{chainName(t.token.chain)}</span>
                    </td>
                    <td>
                      <PhaseBadge phase={t.phase} />
                    </td>
                    <td>
                      <CallBadge call={t.call.call} />
                    </td>
                    <td className="num">{t.scores[a.engine] ?? '—'}</td>
                    <td className="num">{t.rotation ? `${t.rotation.inWallets} / ${t.rotation.outWallets}` : '—'}</td>
                    <td className={`num ${t.market ? (t.market.net >= 0 ? 'up' : 'down') : ''}`}>{t.market ? formatValue(t.market.net, 'usd') : '—'}</td>
                    <td className="num">{t.costPct != null ? `${t.costPct.toFixed(1)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="bx-note">Click a token to select it (Token details shows why). Hover a row for its call’s reason.</div>
      </div>
    </div>
  )
}

/** The right panel: the engine and its rules (shared by every board — they're the server's). */
function RulesPanel() {
  const [cfg, setCfg] = useState<{ rules: Record<string, any>; defaults: Record<string, any>; engines: EngineInfo[]; frames: { hours: number; targetPct: number; stopPct: number }[] } | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    void ask<typeof cfg>('rotation/config' as Query['kind'], {}).then(setCfg)
  }, [])
  const save = async (patch: Record<string, unknown>) => {
    const res = await fetch('/api/engine/rotation/config', { method: 'POST', body: JSON.stringify(patch) })
    setCfg(await res.json())
    setMsg('Saved — applies from the next run (within a minute).')
    refresh({ kind: 'rotation', params: {} })
  }
  if (!cfg) return <p className="fp-help">Loading the rules…</p>
  const r = cfg.rules
  const num = (path: string[], value: number, step = 1) => (
    <input
      type="number"
      className="fp-num"
      step={step}
      value={value}
      onChange={(e) => {
        const v = Number(e.target.value)
        const patch: Record<string, unknown> = {}
        let cur = patch
        path.slice(0, -1).forEach((k) => (cur = (cur[k] = {}) as Record<string, unknown>))
        cur[path[path.length - 1]] = v
        void save(patch)
      }}
    />
  )
  return (
    <div className="fp">
      <section>
        <h3>Engine</h3>
        <p className="fp-help">Whose call the Feed, the board and Token details show. Every engine is computed on every token, and the Evaluation grades all of them.</p>
        <select className="fp-select" value={r.engine} onChange={(e) => void save({ engine: e.target.value })}>
          {cfg.engines.map((e) => (
            <option key={e.key} value={e.key}>
              {e.label}
            </option>
          ))}
        </select>
        <p className="fp-help">{cfg.engines.find((e) => e.key === r.engine)?.blurb}</p>
      </section>
      <section>
        <h3>Lines (BUY at / HOLD while)</h3>
        <p className="fp-help">Each engine scores 0–100. Over its BUY line, in a WAKING phase, with the gates passing, it calls BUY; it holds while over its HOLD line.</p>
        {cfg.engines.map((e) => (
          <label key={e.key} className="fp-line">
            <span style={{ width: 120 }}>{e.label}</span>
            {num(['lines', e.key, 'buy'], r.lines[e.key].buy)} / {num(['lines', e.key, 'hold'], r.lines[e.key].hold)}
          </label>
        ))}
      </section>
      <section>
        <h3>Market rules</h3>
        <label className="fp-line">Liquidity band ${num(['liqLow'], r.liqLow, 10000)} – ${num(['liqHigh'], r.liqHigh, 10000)}</label>
        <label className="fp-line">TIDE veto: ${num(['rotVetoUsd'], r.rotVetoUsd, 50)} net leaving (2 h)</label>
        <label className="fp-line">Still buy a RUNNING token under {num(['lateUpPct'], r.lateUpPct)}% above its 6 h low</label>
      </section>
      <section>
        <h3>Safety and execution</h3>
        <label className="fp-line">Liquidity floor ${num(['safety', 'minLiquidity'], r.safety.minLiquidity, 5000)}</label>
        <label className="fp-line">Max tax {num(['safety', 'maxTaxPct'], r.safety.maxTaxPct)}%</label>
        <label className="fp-line">Trade size ${num(['execution', 'tradeUsd'], r.execution.tradeUsd, 100)}</label>
        <label className="fp-line">Max round-trip cost {num(['execution', 'maxCostPct'], r.execution.maxCostPct, 0.5)}%</label>
      </section>
      <section>
        <h3>Trade plan</h3>
        <label className="fp-line">
          Hold
          <select className="fp-select" value={r.plan.holdHours} onChange={(e) => void save({ plan: { holdHours: Number(e.target.value) } })}>
            {cfg.frames.map((f) => (
              <option key={f.hours} value={f.hours}>
                {f.hours} h (target +{f.targetPct}%, stop −{f.stopPct}%)
              </option>
            ))}
          </select>
        </label>
      </section>
      <button className="sf-reset" onClick={() => void save({ reset: true })}>
        Back to Vibe-MM’s defaults
      </button>
      {msg && <p className="fp-help">{msg}</p>}
    </div>
  )
}

export const rotationBoard: BlockDefinition<BoardProps> = {
  type: 'rotationBoard',
  label: 'Rotation board',
  description: 'Every token the engine evaluated, ranked, with its phase and call',
  icon: '🔄',
  category: 'engine',
  width: 560,
  defaultProps: { chain: '', onlyBuys: false, limit: 50 },
  settings: [
    { key: 'chain', label: 'Chain', type: 'select', options: [{ value: '', label: 'Every chain' }, ...Object.entries(CHAIN_NAMES).map(([value, label]) => ({ value, label }))] },
    { key: 'limit', label: 'Show up to (tokens)', type: 'number', min: 1 },
  ],
  Info: RulesPanel,
  outlets: [
    { id: 'tokens', label: 'The ranked tokens: score, rotation in / out, flow, cost, phase, call', types: ['table'] },
    { id: 'buys', label: 'Only the BUY calls', types: ['table'] },
  ],
  query: (props): Query => ({ kind: 'rotation', params: props.chain ? { chain: props.chain } : {}, refreshMs: 60_000 }),
  compute: ({ props, data }) => {
    const a = data[0]?.data as BoardAnswer | undefined
    if (!a) return {}
    const list = ranked(a, { ...props, onlyBuys: false })
    return { tokens: boardTable(list, a.engine), buys: boardTable(list.filter((t) => t.call.call === 'BUY'), a.engine) }
  },
  Render: (p) => <BoardView {...p} />,
  Widget: (p) => <BoardView {...p} big />,
}

// ---------- Market rotation ----------

interface MarketAnswer {
  chains: {
    chain: string
    pools: number
    rotatedUsd: number
    gainers: { token: Token; net: number }[]
    losers: { token: Token; net: number }[]
    flows: { from: string; to: string; usd: number }[]
  }[]
}

type MarketProps = FollowProps & { chain: string }

interface TokenRotation {
  peers: { pool: string; symbol: string; inUsd: number; outUsd: number; wallets: number }[]
  market: { inUsd: number; outUsd: number; net: number; connected: number } | null
}

function MarketView({ props, ctx, big }: { props: MarketProps; ctx: BlockContext<MarketProps>; big?: boolean }) {
  useFollow(props, ctx)
  const a = ctx.data[0]?.data as MarketAnswer | undefined
  const focus = focusOf(props, ctx.inputs)
  const mine = ctx.data[1]?.data as TokenRotation | null | undefined
  const maxPeer = Math.max(1, ...(mine?.peers ?? []).map((p) => Math.max(p.inUsd, p.outUsd)))
  return (
    <div className={`bx${big ? ' fill' : ''} wide`}>
      <div className="bx-head">
        <span className="bx-icon">🌊</span>
        <span className="bx-title">
          <strong>Market rotation{focus ? ` · ${focus.symbol}` : ''}</strong>
          <small>{focus ? `${chainName(focus.chain)} · where its capital came from and went, 2 h` : `Where capital moved between the sampled pools, 2 h${props.chain ? ` · ${chainName(props.chain)}` : ''}`}</small>
        </span>
        <DataStatus states={ctx.data} />
      </div>
      <div className="bx-body scroll-y">
        {focus && (
          <div className="eg-chain">
            <div className="dt-title">{focus.symbol}’s flows</div>
            {mine === null ? (
              <div className="bx-note">{focus.symbol} isn’t on the trade tape yet (the tape samples each chain’s busiest pools and your watchlist).</div>
            ) : !mine?.peers.length ? (
              <div className="bx-note">{mine?.market ? `No wallet moved capital between ${focus.symbol} and another sampled pool in the last 2 h.` : 'Loading…'}</div>
            ) : (
              <>
                <div className="bx-sub">
                  Net {formatValue(mine.market?.net ?? 0, 'usd')} · {formatValue(mine.market?.inUsd ?? 0, 'usd')} arrived · {formatValue(mine.market?.outUsd ?? 0, 'usd')} left · {mine.market?.connected ?? 0} connected pools
                </div>
                {mine.peers.map((p) => (
                  <div key={p.pool} className="rt-peer" title={`${p.wallets} shared wallets: ${formatValue(p.inUsd, 'usd')} came from ${p.symbol}, ${formatValue(p.outUsd, 'usd')} went to it`}>
                    <span className="sym">{p.symbol}</span>
                    <div className="eg-bar">
                      <div className="neg">{p.outUsd > 0 && <i style={{ width: `${(p.outUsd / maxPeer) * 100}%` }} />}</div>
                      <div className="pos">{p.inUsd > 0 && <i style={{ width: `${(p.inUsd / maxPeer) * 100}%` }} />}</div>
                    </div>
                    <b className={p.inUsd >= p.outUsd ? 'up' : 'down'}>{p.inUsd >= p.outUsd ? '+' : '−'}{formatValue(Math.abs(p.inUsd - p.outUsd), 'usd')}</b>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        {!a?.chains.length ? (
          <Empty>No rotation measured yet — the trade tape is filling.</Empty>
        ) : (
          a.chains.map((c) => {
            const max = Math.max(1, ...c.gainers.map((g) => g.net), ...c.losers.map((l) => -l.net))
            return (
              <div key={c.chain} className="eg-chain">
                <div className="dt-title">
                  {chainName(c.chain)} · {c.pools} pools · {formatValue(c.rotatedUsd, 'usd')} rotated
                </div>
                <div className="eg-movers">
                  {[...c.gainers, ...c.losers].map((m) => (
                    <div key={m.token.id} className={`eg-mover pick${focus?.id === m.token.id ? ' sel' : ''}`} onClick={() => selectToken(m.token)} title={`${m.token.symbol}: ${m.net >= 0 ? 'gained' : 'lost'} ${formatValue(Math.abs(m.net), 'usd')} net to other pools`}>
                      <span className="sym">{m.token.symbol}</span>
                      <div className="eg-bar">
                        <div className="neg">{m.net < 0 && <i style={{ width: `${(-m.net / max) * 100}%` }} />}</div>
                        <div className="pos">{m.net > 0 && <i style={{ width: `${(m.net / max) * 100}%` }} />}</div>
                      </div>
                      <b className={m.net >= 0 ? 'up' : 'down'}>{formatValue(m.net, 'usd')}</b>
                    </div>
                  ))}
                </div>
                {c.flows.length > 0 && (
                  <div className="eg-flows">
                    {c.flows.slice(0, big ? 12 : 5).map((f, i) => (
                      <span key={i}>
                        {f.from} → {f.to} <b>{formatValue(f.usd, 'usd')}</b>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** The right panel: how market rotation is worked out, from what, and how far to trust it. */
function MarketInfo() {
  const [cov, setCov] = useState<Record<string, Coverage> | null>(null)
  useEffect(() => {
    void ask<{ chains: Record<string, Coverage> }>('trades' as Query['kind'], {}).then((r) => setCov(r.chains))
  }, [])
  return (
    <div className="fp ex-panel">
      <Explain title="What it shows">
        <p>Where capital moved between the pools we sample, over the last 2 hours, per chain. With a token wired in (or followed), its own flows: which pools its capital came from and went to.</p>
      </Explain>
      <Explain title="How a flow is measured">
        <ol>
          <li>For every wallet that traded this pool in the last 2 h, its <b>net</b> here: buys minus sells, in $.</li>
          <li>The same wallet’s net in every other sampled pool on the chain, over the same 2 h.</li>
          <li>Net <b>buyer here and net seller there</b>: capital <b className="up">arrived</b> from that pool. Net seller here and buyer there: capital <b className="down">left</b> for it.</li>
          <li>The amount credited is the <b>smaller</b> of the two sides — min(sold there, bought here) — so the same dollars are never counted twice.</li>
          <li>A wallet that bought both, or sold both, is holding two positions, not moving money: <b>parallel</b>, and not counted.</li>
        </ol>
      </Explain>
      <Explain title="What the numbers mean">
        <ul>
          <li><b>Net</b> = arrived − left. <b>Gainers</b> are pools with the most net arriving, <b>losers</b> the most leaving (top 8 each).</li>
          <li><b>Flows</b> “A → B $x”: the largest amounts that moved from one pool to another.</li>
          <li><b>Rotated</b>: everything that arrived, summed over the chain’s pools.</li>
          <li>Rotation is measured <b>within one chain</b>, never across.</li>
        </ul>
      </Explain>
      <Explain title="Sources">
        <ul>
          <li><b>Trade tape</b> (data/trades/&lt;chain&gt;.json): each sampled pool’s last 300 trades from GeckoTerminal — wallet, buy / sell, $ — kept 6 h. Pools: your watchlist and selected token, then each chain’s 15 most-traded.</li>
          <li><b>Rotation engine</b> (server/rotation.ts): recomputes every pool’s flows each minute, without extra API calls.</li>
        </ul>
        {cov && (
          <ul className="ex-cov">
            {Object.entries(cov).map(([c, v]) => (
              <li key={c}>
                {chainName(c)}: {v.pools} pools on the tape, {v.freshPools} sampled in the last 30 min · {v.trades.toLocaleString()} trades · {v.wallets.toLocaleString()} wallets, {v.sharedWallets} in 2+ pools
              </li>
            ))}
          </ul>
        )}
      </Explain>
      <Explain title="How far to trust it">
        <p>Every figure is a <b>floor</b>: only pools on the tape can take part, so a flow to a pool we haven’t sampled is invisible. A busy pool’s 300 trades can cover only a few minutes, so its 2-hour picture is built from repeated samples. GeckoTerminal allows 10 calls a minute in all, which is what limits coverage.</p>
      </Explain>
    </div>
  )
}

export const marketRotation: BlockDefinition<MarketProps> = {
  type: 'marketRotation',
  label: 'Market rotation',
  description: 'Per chain: which pools gain or lose capital, and the strongest flows — or one token’s',
  icon: '🌊',
  category: 'engine',
  width: 460,
  defaultProps: { chain: '', follow: false, token: '' },
  settings: [
    { key: 'follow', label: 'Follow the token selected in the Feed', type: 'toggle', help: 'When nothing is wired into “token”.' },
    { key: 'chain', label: 'Chain (when no token)', type: 'select', options: [{ value: '', label: 'Every chain' }, ...Object.entries(CHAIN_NAMES).map(([value, label]) => ({ value, label }))] },
  ],
  Info: MarketInfo,
  inlets: [TOKEN_IN],
  outlets: [{ id: 'movers', label: 'Every pool that gained or lost capital: net $ (2 h)', types: ['table'] }],
  query: (props, inputs): Query[] => {
    const focus = focusOf(props, inputs)
    const chain = focus?.chain ?? props.chain
    return [
      { kind: 'rotation/market', params: chain ? { chain } : {}, refreshMs: 60_000 },
      ...(focus ? [{ kind: 'rotation' as const, params: { id: focus.id }, refreshMs: 60_000 }] : []),
    ]
  },
  compute: ({ data }) => {
    const a = data[0]?.data as MarketAnswer | undefined
    if (!a) return {}
    const rows: Row[] = a.chains.flatMap((c) => [...c.gainers, ...c.losers].map((m) => ({ token: m.token, symbol: m.token.symbol, net: m.net })))
    return { movers: { kind: 'table', columns: [{ key: 'net', label: 'Net 2h', unit: 'usd' }], rows } }
  },
  Render: (p) => <MarketView {...p} />,
  Widget: (p) => <MarketView {...p} big />,
}

// ---------- Evaluation ----------

interface EvalAnswer {
  summary: Record<string, { buys: number; sells: number; graded: number; avg1h: number | null; avg6h: number | null; avg24h: number | null; planAvg: number | null; planWinPct: number | null }>
  recent: { id: string; at: number; symbol: string; token: string; engine: string; call: string; price: number | null; why: string; grade: { r: Record<number, number | null>; plan: { outcome: string; returnPct: number } | null } | null }[]
  logged: number
}
interface SmartAnswer {
  pending: number
  judged: number
  baseWinPct: number | null
  chains: Record<string, { judgedWallets: number; smart: number }>
}

const pctCell = (v: number | null | undefined) => (v == null ? <td className="num dim">—</td> : <td className={`num ${v >= 0 ? 'up' : 'down'}`}>{formatValue(v, 'pct')}</td>)

type EvalProps = FollowProps

function EvalView({ props, ctx, big }: { props: EvalProps; ctx: BlockContext<EvalProps>; big?: boolean }) {
  useFollow(props, ctx)
  const focus = focusOf(props, ctx.inputs)
  const a = ctx.data[0]?.data as EvalAnswer | undefined
  const sm = ctx.data[1]?.data as SmartAnswer | undefined
  const engines = a ? Object.entries(a.summary).sort((x, y) => (y[1].planAvg ?? -99) - (x[1].planAvg ?? -99)) : []
  // For one token: its whole call history (WATCH included); otherwise the latest graded BUYs and SELLs.
  const graded = focus ? a?.recent ?? [] : a?.recent.filter((r) => r.grade && (r.call === 'BUY' || r.call === 'SELL')) ?? []
  return (
    <div className={`bx${big ? ' fill' : ''} wide`}>
      <div className="bx-head">
        <span className="bx-icon">🧪</span>
        <span className="bx-title">
          <strong>Evaluation{focus ? ` · ${focus.symbol}` : ''}</strong>
          <small>{!a ? 'Loading…' : focus ? `${a.logged} call changes on ${focus.symbol} · graded from stored prices` : `${a.logged} calls logged · graded from stored prices`}</small>
        </span>
        <DataStatus states={ctx.data} />
      </div>
      <div className="bx-body scroll-y">
        {!engines.length ? (
          <Empty>{focus ? `No BUY or SELL calls on ${focus.symbol} yet.` : 'No BUY or SELL calls yet.'} Each is graded after 1 h, 6 h and 24 h.</Empty>
        ) : (
          <table className="bx-table">
            <thead>
              <tr>
                <th>Engine</th>
                <th className="num">BUY</th>
                <th className="num">SELL</th>
                <th className="num">Graded</th>
                <th className="num">1h</th>
                <th className="num">6h</th>
                <th className="num">24h</th>
                <th className="num">Plan win</th>
                <th className="num">Plan avg</th>
              </tr>
            </thead>
            <tbody>
              {engines.map(([k, s]) => (
                <tr key={k}>
                  <td className="sym">{k}</td>
                  <td className="num">{s.buys}</td>
                  <td className="num">{s.sells}</td>
                  <td className="num">{s.graded}</td>
                  {pctCell(s.avg1h)}
                  {pctCell(s.avg6h)}
                  {pctCell(s.avg24h)}
                  <td className="num">{s.planWinPct == null ? '—' : `${s.planWinPct}%`}</td>
                  {pctCell(s.planAvg)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {graded.length > 0 && (
          <>
            <div className="dt-title" style={{ marginTop: 10 }}>
              {focus ? `${focus.symbol}’s calls` : 'Latest graded calls'}
            </div>
            <table className="bx-table">
              <tbody>
                {graded.slice(0, big ? 40 : 8).map((r) => (
                  <tr key={r.id} title={r.why}>
                    <td className="dim">{new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="sym">{r.symbol}</td>
                    <td>{r.engine}</td>
                    <td>
                      <CallBadge call={r.call} />
                    </td>
                    {r.call === 'BUY' || r.call === 'SELL' ? pctCell(r.grade?.r[6]) : <td />}
                    <td className="dim">{r.call !== 'BUY' && r.call !== 'SELL' ? r.why : r.grade?.plan ? `${r.grade.plan.outcome} ${formatValue(r.grade.plan.returnPct, 'pct')}` : 'open'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {sm && (
          <div className="bx-note">
            Smart wallets: {sm.judged.toLocaleString()} buys judged ({sm.baseWinPct ?? '—'}% won on average), {sm.pending.toLocaleString()} waiting for their 6 h ·{' '}
            {Object.entries(sm.chains)
              .map(([c, v]) => `${chainName(c)} ${v.smart} smart of ${v.judgedWallets}`)
              .join(' · ') || 'none learned yet'}
          </div>
        )}
      </div>
    </div>
  )
}

/** The right panel: what's graded, how, from what — and the rules in use right now. */
function EvalInfo() {
  const [cfg, setCfg] = useState<{ rules: { plan: { holdHours: number }; engine: string }; frames: { hours: number; targetPct: number; stopPct: number }[]; engines: EngineInfo[] } | null>(null)
  const [sm, setSm] = useState<(SmartAnswer & { rule?: { minBuyUsd: number; winPct: number; lossPct: number; minResolved: number; minTokens: number; minRate: number } }) | null>(null)
  useEffect(() => {
    void ask<NonNullable<typeof cfg>>('rotation/config' as Query['kind'], {}).then(setCfg)
    void ask<NonNullable<typeof sm>>('smart', {}).then(setSm)
  }, [])
  return (
    <div className="fp ex-panel">
      <Explain title="What it shows">
        <p>How good each engine’s calls have been — on every token, or on the one wired in (or followed). Every engine makes a call on every token each minute, so all twelve are graded side by side, whichever one the board shows.</p>
      </Explain>
      <Explain title="What gets logged">
        <p>Each time an engine’s call on a token <b>changes</b> (WATCH → BUY, BUY → SELL…), it’s written to data/calls/calls.jsonl with the time, the price, the score and the reason. Kept 14 days.</p>
      </Explain>
      <Explain title="How a call is graded">
        <ul>
          <li><b>1h / 6h / 24h</b>: the price that long after the call, against the price at the call, in %. The price is the token’s stored price nearest that moment (within 20 min); with none, it stays ungraded — never a guess.</li>
          <li>A <b>SELL</b> is graded as a short: a fall counts as a gain.</li>
          <li><b>Plan</b>: walking forward from the call, the trade plan’s <b>target</b> or <b>stop</b>, whichever the price touched first; if neither, the return at the end of the hold (“time”). <b>Plan win</b> = the share of graded calls that ended positive; <b>plan avg</b> their average return.</li>
        </ul>
      </Explain>
      {cfg && (
        <Explain title="Trade plan frames">
          <table className="bx-table">
            <tbody>
              {cfg.frames.map((f) => (
                <tr key={f.hours} className={f.hours === cfg.rules.plan.holdHours ? 'sel' : ''}>
                  <td>{f.hours} h hold</td>
                  <td className="num up">target +{f.targetPct}%</td>
                  <td className="num down">stop −{f.stopPct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="fp-help">In use: {cfg.rules.plan.holdHours} h (change it on the Rotation board). Costs aren’t subtracted here; the board’s “Cost” column is the round trip at your trade size.</p>
        </Explain>
      )}
      <Explain title="Smart wallets">
        {sm?.rule ? (
          <p>
            Every ${sm.rule.minBuyUsd}+ buy on the tape is judged once its 6 h are over: a <b>win</b> if the price went +{sm.rule.winPct}% before −{sm.rule.lossPct}%. A wallet is <b>smart</b> with {sm.rule.minResolved}+ judged buys, on {sm.rule.minTokens}+ tokens, winning {Math.round(sm.rule.minRate * 100)}%+.
          </p>
        ) : null}
        {sm && (
          <p className="fp-help">
            So far: {sm.judged.toLocaleString()} buys judged ({sm.baseWinPct ?? '—'}% won), {sm.pending.toLocaleString()} waiting for their 6 h · {Object.entries(sm.chains).map(([c, v]) => `${chainName(c)}: ${v.smart} smart of ${v.judgedWallets}`).join(' · ') || 'none learned yet'}
          </p>
        )}
      </Explain>
      <Explain title="Sources">
        <ul>
          <li><b>Calls</b>: the rotation engine (server/rotation.ts), every minute, on every token of the trade tape.</li>
          <li><b>Prices</b>: each token’s stored history (data/history), written by the Feed’s lists and the 20-second watch.</li>
          <li><b>Grading</b> runs every 10 minutes (the Feed’s “Evaluation” job), without API calls.</li>
        </ul>
      </Explain>
      <Explain title="How far to trust it">
        <p>Only tokens on the trade tape get calls, and a token that drops out of the lists may have gaps in its prices, which leaves its calls ungraded. Judge an engine only once it has dozens of graded calls — a handful proves nothing.</p>
      </Explain>
    </div>
  )
}

export const evaluation: BlockDefinition<EvalProps> = {
  type: 'evaluation',
  label: 'Evaluation',
  description: 'How each engine’s calls did — on every token, or one: returns after 1 h, 6 h, 24 h, and the trade plan',
  icon: '🧪',
  category: 'engine',
  width: 560,
  defaultProps: { follow: false, token: '' },
  settings: [{ key: 'follow', label: 'Follow the token selected in the Feed', type: 'toggle', help: 'When nothing is wired into “token”: grades only that token’s calls.' }],
  Info: EvalInfo,
  inlets: [TOKEN_IN],
  outlets: [{ id: 'engines', label: 'Per engine: calls, graded, average returns, plan win rate', types: ['table'] }],
  query: (props, inputs): Query[] => {
    const focus = focusOf(props, inputs)
    return [
      { kind: 'evaluation', params: focus ? { id: focus.id, n: 300 } : {}, refreshMs: 120_000 },
      { kind: 'smart', params: {}, refreshMs: 300_000 },
    ]
  },
  compute: ({ data }) => {
    const a = data[0]?.data as EvalAnswer | undefined
    if (!a) return {}
    const columns: Column[] = [
      { key: 'buys', label: 'BUY', unit: 'count' },
      { key: 'graded', label: 'Graded', unit: 'count' },
      { key: 'avg6h', label: '6h', unit: 'pct' },
      { key: 'planWinPct', label: 'Plan win', unit: 'pct' },
      { key: 'planAvg', label: 'Plan avg', unit: 'pct' },
    ]
    const rows: Row[] = Object.entries(a.summary).map(([k, s]) => ({ symbol: k, buys: s.buys, graded: s.graded, avg6h: s.avg6h, planWinPct: s.planWinPct, planAvg: s.planAvg }))
    return { engines: { kind: 'table', columns, rows } }
  },
  Render: (p) => <EvalView {...p} />,
  Widget: (p) => <EvalView {...p} big />,
}

export const engineBlocks = [rotationBoard, marketRotation, evaluation] as unknown as BlockDefinition<BlockProps>[]
