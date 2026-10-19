import { useEffect } from 'react'
import type { BlockContext, BlockDefinition, BlockProps, Query } from '../types'
import { num, type Column, type MarksValue, type Row, type TableValue, type Token, type Value } from '../../core/values'
import { formatValue } from '../../core/show'
import { DETAIL_FIELDS, SOURCE_NAMES, type DetailField, type DetailSource, type DetailsAnswer } from '../../core/tokenDetails'
import { DataStatus, Empty, TokenLine, trackTokens } from '../shared'
import { CallBadge, PhaseBadge } from '../engine'
import { useFeedSelected } from '../pick'

/*
 * Token details: one token, everything we know about it — market, flow, execution, holders, token facts and
 * a sell simulation — each value labelled with its source. It follows the token selected in the Feed (or a
 * token wired in). In the right panel each field can be shown or hidden, and where several sources have it,
 * the source picked. The shown values go out of `details` as a one-row table.
 */

type Props = Record<string, string | number | boolean>

const parseToken = (json: unknown): Token | null => {
  try {
    const t = JSON.parse(String(json || 'null'))
    return t && t.kind === 'token' ? t : null
  } catch {
    return null
  }
}

/** The token shown: the one wired in, or the one followed from the Feed. */
const tokenOf = (props: Props, inputs: Record<string, Value | undefined>): Token | null => (inputs.token?.kind === 'token' ? inputs.token : parseToken(props.token))

const shownOn = (props: Props, f: DetailField) => props[`hide_${f.key}`] !== true

/** A field's value: from the source picked for it, or the first source that has one. */
function pick(answer: DetailsAnswer | undefined, props: Props, f: DetailField): { value: number | string; source: DetailSource } | null {
  const have = answer?.values[f.key] ?? {}
  const chosen = props[`src_${f.key}`] as DetailSource | undefined
  const order = chosen && f.sources.includes(chosen) ? [chosen, ...f.sources.filter((s) => s !== chosen)] : f.sources
  for (const s of order) {
    const v = have[s]
    if (v != null) return { value: v, source: s }
  }
  return null
}

/** Fields that are a change (signed, green / red); other percentages are levels (impact, shares). */
const SIGNED = new Set(['netBuy5m', 'priceVsLlama', 'holdersDelta1h'])

const show = (f: DetailField, v: number | string) =>
  typeof v === 'string'
    ? v
    : f.key === 'organicScore'
      ? `${Math.round(v)}/100`
      : f.key === 'volLiq24h'
        ? `${v.toFixed(2)}×`
        : f.unit === 'pct' && !SIGNED.has(f.key)
          ? `${v.toFixed(Math.abs(v) < 10 ? 2 : 1)}%`
          : formatValue(v, f.unit === 'text' ? 'none' : f.unit)

// ---------- the rotation engine's read of this token (server/rotation.ts) ----------

interface RotationEval {
  engine: string
  phase: { phase: string | null; why: string }
  calls: Record<string, { call: string | null; why: string; held?: boolean }>
  scores: Record<string, { score: number | null; why: string }>
  rotation: { inWallets: number; outWallets: number; inUsd: number; outUsd: number } | null
  market: { inUsd: number; outUsd: number; net: number; connected: number } | null
  peers: { pool: string; symbol: string; inUsd: number; outUsd: number; wallets: number }[]
  gates: { key: string; label: string; ok: boolean | null; detail: string }[]
  smart: { buyers: number | null; sellers: number | null }
  costPct: number | null
  plan: { entry: number; target: number; stop: number; targetPct: number; stopPct: number; holdHours: number; sizeUsd: number } | null
  at: number
}
interface CallLogEntry {
  at: number
  engine: string
  call: string
  why: string
}

const ENGINE_LABELS: Record<string, string> = {
  quality: 'QUALITY',
  rotation: 'ROTATION',
  rotationPlus: 'ROT+',
  rotationMidLiq: 'MID-LIQ',
  smartRotation: 'SMART ROT',
  tide: 'TIDE',
  cycle: 'CYCLE',
  momentum: 'MOMENTUM',
  smart: 'SMART',
  flow: 'FLOW',
  blend: 'BLEND',
  consensus: 'CONSENSUS',
}

function RotationSection({ ev, symbol }: { ev: RotationEval | null | undefined; symbol: string }) {
  if (ev === undefined) return null
  if (!ev)
    return (
      <div className="dt-group">
        <div className="dt-title">Rotation</div>
        <div className="bx-note">Not on the trade tape yet — the tape samples each chain’s busiest pools and your watchlist (star it to have it sampled).</div>
      </div>
    )
  const call = ev.calls[ev.engine]
  const top = ev.peers[0]
  const lead = !ev.market
    ? 'Too few trades in the last 2 h to measure rotation.'
    : !ev.market.connected
      ? `No wallet that traded ${symbol} also traded another sampled pool in the last 2 h — its crowd is its own.`
      : !top
        ? `${symbol} shares wallets with ${ev.market.connected} other pool${ev.market.connected === 1 ? '' : 's'}, but none sold one side and bought the other: parallel positions, not rotation.`
        : top.inUsd >= top.outUsd
          ? `${top.wallets} wallet${top.wallets === 1 ? '' : 's'} moved ${formatValue(top.inUsd, 'usd')} out of ${top.symbol} into ${symbol} — the strongest path in the last 2 h.`
          : `${top.wallets} wallet${top.wallets === 1 ? '' : 's'} moved ${formatValue(top.outUsd, 'usd')} out of ${symbol} into ${top.symbol} — the strongest path in the last 2 h.`
  const max = Math.max(1, ...ev.peers.map((p) => Math.max(p.inUsd, p.outUsd)))
  return (
    <div className="dt-group">
      <div className="dt-title">Rotation · {ENGINE_LABELS[ev.engine] ?? ev.engine}</div>
      <div className="rt-lead">
        <CallBadge call={call?.call} /> <PhaseBadge phase={ev.phase.phase} /> {call?.why}
      </div>
      <div className="rt-lead dim">{lead}</div>
      <div className="dt-grid">
        <div className="dt-cell">
          <span className="dt-label">Score</span>
          <b className="dt-value">{ev.scores[ev.engine]?.score ?? '—'}</b>
          <small title={ev.scores[ev.engine]?.why}>{ev.scores[ev.engine]?.why}</small>
        </div>
        <div className="dt-cell">
          <span className="dt-label">Rotating in / out 1h</span>
          <b className="dt-value">{ev.rotation ? `${ev.rotation.inWallets} / ${ev.rotation.outWallets}` : '—'}</b>
          <small>{ev.rotation ? `net ${formatValue(ev.rotation.inUsd - ev.rotation.outUsd, 'usd')}` : 'under 15 min of tape'}</small>
        </div>
        <div className="dt-cell">
          <span className="dt-label">Market flow 2h</span>
          <b className={`dt-value ${ev.market ? (ev.market.net >= 0 ? 'up' : 'down') : ''}`}>{ev.market ? formatValue(ev.market.net, 'usd') : '—'}</b>
          <small>{ev.market ? `${ev.market.connected} connected pools` : ''}</small>
        </div>
        <div className="dt-cell">
          <span className="dt-label">Smart wallets 1h</span>
          <b className="dt-value">{ev.smart.buyers != null ? `${ev.smart.buyers} / ${ev.smart.sellers ?? 0}` : '—'}</b>
          <small>buying / selling</small>
        </div>
        <div className="dt-cell">
          <span className="dt-label">Round trip $1K</span>
          <b className="dt-value">{ev.costPct != null ? `${ev.costPct.toFixed(1)}%` : '—'}</b>
          <small>impact + fees</small>
        </div>
      </div>
      <div className="rt-calls">
        {Object.entries(ev.calls).map(([k, c]) => (
          <span key={k} title={c.why}>
            {ENGINE_LABELS[k] ?? k} <CallBadge call={c.call} />
          </span>
        ))}
      </div>
      <div className="rt-gates">
        {ev.gates.map((g) => (
          <span key={g.key} className={g.ok === false ? 'down' : g.ok ? 'up' : 'dim'} title={g.detail}>
            {g.ok === false ? '✕' : g.ok ? '✓' : '·'} {g.label}
          </span>
        ))}
      </div>
      {ev.peers.slice(0, 6).map((p) => (
        <div key={p.pool} className="rt-peer" title={`${p.wallets} shared wallets`}>
          <span className="sym">{p.symbol}</span>
          <div className="eg-bar">
            <div className="neg">{p.outUsd > 0 && <i style={{ width: `${(p.outUsd / max) * 100}%` }} />}</div>
            <div className="pos">{p.inUsd > 0 && <i style={{ width: `${(p.inUsd / max) * 100}%` }} />}</div>
          </div>
          <b className={p.inUsd >= p.outUsd ? 'up' : 'down'}>{p.inUsd >= p.outUsd ? '+' : '−'}{formatValue(Math.abs(p.inUsd - p.outUsd), 'usd')}</b>
        </div>
      ))}
      {ev.plan && (
        <div className="rt-plan">
          Trade plan: buy {formatValue(ev.plan.sizeUsd, 'usd')} at {formatValue(ev.plan.entry, 'usd')} · target {formatValue(ev.plan.target, 'usd')} (+{ev.plan.targetPct}%) · stop {formatValue(ev.plan.stop, 'usd')} (−{ev.plan.stopPct}%) · close after {ev.plan.holdHours} h
        </div>
      )}
    </div>
  )
}

function DetailsView({ props, ctx, big }: { props: Props; ctx: BlockContext<Props>; big?: boolean }) {
  // Follow the Feed's selection when nothing is wired in (kept in the block, so it survives a reload).
  const selected = useFeedSelected()
  useEffect(() => {
    if (ctx.inputs.token || !selected || parseToken(props.token)?.id === selected.id) return
    ctx.update({ token: JSON.stringify(selected) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, ctx.inputs.token])
  const token = tokenOf(props, ctx.inputs)
  // The server keeps this token's full details recorded too, every 2 minutes.
  useEffect(() => trackTokens('details', token ? [token] : []), [token?.id])
  const answer = ctx.data[0]?.data as DetailsAnswer | undefined
  const fields = DETAIL_FIELDS.filter((f) => shownOn(props, f))
  const groups = [...new Set(fields.map((f) => f.group))]
  return (
    <div className={`bx${big ? ' fill' : ''} wide`}>
      <div className="bx-head">
        {token ? <TokenLine token={token} /> : <span className="bx-icon">🔎</span>}
        <span className="bx-title">
          <strong>{token ? '' : 'Token details'}</strong>
          {!token && <small>Select a token in the Feed</small>}
        </span>
        <DataStatus states={ctx.data} />
      </div>
      <div className="bx-body">
        {token && <RotationSection ev={ctx.data[1]?.data as RotationEval | null | undefined} symbol={token.symbol} />}
        {!token ? (
          <Empty>Click a token in the Feed (or wire a token in) to see its details.</Empty>
        ) : (
          groups.map((g) => (
            <div key={g} className="dt-group">
              <div className="dt-title">{g}</div>
              <div className="dt-grid">
                {fields
                  .filter((f) => f.group === g)
                  .map((f) => {
                    const v = pick(answer, props, f)
                    const cls = v && typeof v.value === 'number' && SIGNED.has(f.key) ? (v.value >= 0 ? ' up' : ' down') : ''
                    return (
                      <div key={f.key} className="dt-cell">
                        <span className="dt-label">{f.label}</span>
                        <b className={`dt-value${cls}${v?.value === 'fails' ? ' down' : v?.value === 'passes' ? ' up' : ''}`}>{v ? show(f, v.value) : '—'}</b>
                        <small>{v ? SOURCE_NAMES[v.source] : answer ? f.only ?? 'not available' : '…'}</small>
                      </div>
                    )
                  })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** The right panel: every field — shown or hidden, and its source where there's a choice. */
function DetailsInfo({ props, update }: { props: Props; update: (p: Partial<Props>) => void }) {
  const answer = lastAnswer
  const groups = [...new Set(DETAIL_FIELDS.map((f) => f.group))]
  const errors = Object.entries(answer?.errors ?? {})
  return (
    <div className="sf">
      <div className="field-heading">
        <b>Fields and sources</b>
        <small>Tick a field to show it (and send it out of “details”). Where several sources have it, pick which one to use — if it has no value, the next source that does is used.</small>
      </div>
      {errors.length > 0 && (
        <div className="sf-note">
          {errors.map(([s, e]) => (
            <div key={s} className="dim">
              {SOURCE_NAMES[s as DetailSource]}: {e}
            </div>
          ))}
        </div>
      )}
      {groups.map((g) => (
        <section key={g} className="sf-src">
          <header>
            <b>{g}</b>
          </header>
          <ul>
            {DETAIL_FIELDS.filter((f) => f.group === g).map((f) => {
              const on = shownOn(props, f)
              const v = pick(answer ?? undefined, props, f)
              const have = answer?.values[f.key] ?? {}
              return (
                <li key={f.key} className={on ? '' : 'ignored'}>
                  <input type="checkbox" className="sf-switch" checked={on} onChange={(e) => update({ [`hide_${f.key}`]: !e.target.checked })} title={on ? 'Shown — untick to hide' : 'Hidden — tick to show'} />
                  <span style={{ flex: 1 }}>
                    <span className="lbl">{f.label}</span> <b className="dt-mini">{v ? show(f, v.value) : '—'}</b>
                    {f.sources.length > 1 ? (
                      <select className="dt-src" value={String(props[`src_${f.key}`] ?? f.sources[0])} onChange={(e) => update({ [`src_${f.key}`]: e.target.value })}>
                        {f.sources.map((s) => (
                          <option key={s} value={s}>
                            {SOURCE_NAMES[s]}
                            {answer ? (have[s] != null ? ` — ${show(f, have[s]!)}` : ' — no value') : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <small>{SOURCE_NAMES[f.sources[0]]}{f.only ? ` · ${f.only}` : ''}</small>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** The latest answer, for the right panel (which only gets the block's inputs and outputs). */
let lastAnswer: DetailsAnswer | null = null

export const tokenDetails: BlockDefinition<Props> = {
  type: 'tokenDetails',
  label: 'Token details',
  description: 'Everything about one token, each value with its source',
  icon: '🔎',
  category: 'show',
  // One per flow, always there: it can be moved (or dropped onto the Page), not deleted or duplicated.
  permanent: true,
  width: 520,
  defaultProps: { token: '' },
  settings: [],
  inlets: [{ id: 'token', label: 'A token (optional — without one it follows the token selected in the Feed)', types: ['token'] }],
  outlets: [
    { id: 'details', label: 'The shown details as a one-row table (one column per field)', types: ['table'] },
    { id: 'token', label: 'The token shown', types: ['token'] },
    { id: 'calls', label: 'The rotation engine’s calls on this token, as chart marks (BUY / SELL…)', types: ['marks'] },
    { id: 'score', label: 'The chosen engine’s score (0–100)', types: ['number'] },
  ],
  query: (props, inputs): Query[] | null => {
    const t = tokenOf(props, inputs)
    return t
      ? [
          { kind: 'details', params: { id: t.id, ...(t.pool ? { pool: t.pool } : {}) }, refreshMs: 30_000 },
          { kind: 'rotation', params: { id: t.id }, refreshMs: 60_000 },
          { kind: 'evaluation', params: { id: t.id, n: 200 }, refreshMs: 120_000 },
        ]
      : null
  },
  compute: ({ props, inputs, data }) => {
    const t = tokenOf(props, inputs)
    const answer = data[0]?.data as DetailsAnswer | undefined
    if (answer) lastAnswer = answer
    if (!t) return {}
    const fields = DETAIL_FIELDS.filter((f) => shownOn(props, f))
    const row: Row = { token: t }
    for (const f of fields) row[f.key] = pick(answer, props, f)?.value ?? null
    const columns: Column[] = fields.map((f) => ({ key: f.key, label: f.label, unit: f.unit === 'text' ? 'none' : f.unit }))
    const table: TableValue = { kind: 'table', columns, rows: [row] }
    const ev = data[1]?.data as RotationEval | null | undefined
    const log = (data[2]?.data as { recent?: CallLogEntry[] } | undefined)?.recent ?? []
    const engine = ev?.engine
    const marks: MarksValue = {
      kind: 'marks',
      label: `${t.symbol} calls`,
      marks: log
        .filter((c) => c.engine === (engine ?? 'quality') && c.call !== 'WATCH')
        .map((c) => ({ t: c.at, label: c.call, tone: c.call === 'BUY' ? 'buy' : c.call === 'SELL' ? 'sell' : 'avoid', why: c.why }) as MarksValue['marks'][number])
        .reverse(),
    }
    const score = ev && engine ? ev.scores[engine]?.score ?? null : null
    return { details: table, token: t, calls: marks, score: num(score, 'none', `${t.symbol} ${engine ?? ''} score`.trim()) }
  },
  Info: DetailsInfo,
  Render: (p) => <DetailsView {...p} />,
  Widget: (p) => <DetailsView {...p} big />,
}

export const detailsBlocks = [tokenDetails] as unknown as BlockDefinition<BlockProps>[]
