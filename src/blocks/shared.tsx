import type { ReactNode } from 'react'
import type { QueryState } from './types'
import type { Column, ReportValue, Row, TableValue, Token, Value } from '../core/values'
import { METRICS, TAGS, metricByKey } from '../core/metrics'
import { formatValue } from '../core/show'
import { timeOf } from '../core/lastSent'
import { shortAddress } from '../lib/format'
import './blocks.css'

// ---------- engine answers → values ----------

/** A token's market row as the engine sends it. */
export interface MarketRow {
  token: Token
  metrics: Record<string, number | null>
  dex?: string
  url?: string
  at: number
  source: string
  /** Text values (the rotation engine's phase, call and its reason). */
  tags?: Record<string, string>
}

export const METRIC_COLUMNS: Column[] = METRICS.map((m) => ({ key: m.key, label: m.short ?? m.label, unit: m.unit }))

/** Market rows → a token list: one row per token with every standard metric as a column. */
export function marketTable(rows: MarketRow[]): TableValue {
  return {
    kind: 'table',
    columns: [...METRIC_COLUMNS, ...TAGS.map((t) => ({ key: t.key, label: t.label, unit: 'none' as const }))],
    rows: rows.map((r) => ({ token: r.token, symbol: r.token.symbol, ...r.metrics, ...r.tags }) as Row),
  }
}

/** The tokens of a value: a token, or the tokens of a token list. */
export function tokensOf(v: Value | undefined): Token[] {
  if (!v) return []
  if (v.kind === 'token') return [v]
  if (v.kind === 'table') return v.rows.map((r) => r.token).filter((t): t is Token => Boolean(t))
  return []
}

/** Columns a table has that hold numbers (for column pickers). */
export const numberColumns = (t: Value | undefined) =>
  t?.kind === 'table' ? t.columns.filter((c) => t.rows.some((r) => typeof r[c.key] === 'number')) : METRIC_COLUMNS

export const columnOptions = (t: Value | undefined) => numberColumns(t).map((c) => ({ value: c.key, label: metricByKey(c.key)?.label ?? c.label }))

export const unitOf = (t: Value | undefined, key: string) =>
  (t?.kind === 'table' ? t.columns.find((c) => c.key === key)?.unit : undefined) ?? metricByKey(key)?.unit ?? 'none'

// ---------- the common look ----------

export function Box({ icon, title, sub, status, children, wide }: { icon: string; title: string; sub?: ReactNode; status?: ReactNode; children?: ReactNode; wide?: boolean }) {
  return (
    <div className={`bx${wide ? ' wide' : ''}`}>
      <div className="bx-head">
        <span className="bx-icon">{icon}</span>
        <span className="bx-title">
          <strong>{title}</strong>
          {sub && <small>{sub}</small>}
        </span>
        {status}
      </div>
      {children !== undefined && <div className="bx-body">{children}</div>}
    </div>
  )
}

/** Where a block's data stands: updating, updated at…, or why it failed. */
export function DataStatus({ states }: { states: QueryState[] }) {
  if (!states.length) return null
  const error = states.find((s) => s.error)?.error
  const loading = states.some((s) => s.loading)
  const at = Math.max(0, ...states.map((s) => s.at ?? 0))
  if (error && !at) return <span className="bx-status bad" title={error}>Error</span>
  return (
    <span className={`bx-status${error ? ' warn' : loading ? ' busy' : ''}`} title={error ?? (at ? `Updated ${timeOf(at)}` : '')}>
      {loading ? 'Updating…' : error ? 'Retrying…' : at ? timeOf(at) : ''}
    </span>
  )
}

export function TokenLine({ token, extra }: { token: Token; extra?: ReactNode }) {
  return (
    <span className="bx-token" title={`${token.name} · ${token.chain} · ${token.address}`}>
      {token.logo ? <img src={token.logo} alt="" /> : <i>{token.symbol.slice(0, 2)}</i>}
      <b>{token.symbol}</b>
      <small>{token.chain === 'coingecko' ? 'CoinGecko' : `${token.chain} · ${shortAddress(token.address)}`}</small>
      {extra}
    </span>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="bx-empty">{children}</div>
}

/** A small table of rows (token lists show the token, then the chosen columns). */
/** Tell the server which tokens to track in full (every source, trade sample, quotes) — `by` who asks. */
export const trackTokens = (by: string, tokens: Token[]) =>
  void fetch('/api/engine/feed/track', { method: 'POST', body: JSON.stringify({ by, tokens }) }).catch(() => {})

/** The clock input every refreshing block has. */
export const CLOCK_IN = { id: 'clock', label: 'Clock — sets how often this refreshes (instead of its own setting)', types: ['clock' as const] }

/**
 * How often a block asks again: a wired Clock decides (paused = never), otherwise its own "refresh every"
 * setting, or the fallback (seconds).
 */
export function refreshMs(inputs: Record<string, Value | undefined>, props: { refreshSec?: number | string }, fallbackSec: number, minSec = 10): number | undefined {
  const c = inputs.clock
  if (c?.kind === 'clock') return c.running ? c.everyMs : undefined
  return Math.max(minSec, Number(props.refreshSec) || fallbackSec) * 1000
}

export function MiniTable({
  table,
  columns,
  max = 8,
  onPick,
  selectedId,
  starred,
  onStar,
}: {
  table: TableValue
  columns?: string[]
  max?: number
  /** Rows can be clicked: the row's token. */
  onPick?: (t: Token) => void
  selectedId?: string
  /** A ☆ per row: which tokens are starred (on the watchlist), and what a click on the star does. */
  starred?: Set<string>
  onStar?: (t: Token) => void
}) {
  const cols = (columns?.length ? columns : table.columns.slice(0, 3).map((c) => c.key))
    .map((k) => table.columns.find((c) => c.key === k))
    .filter((c): c is Column => Boolean(c))
  return (
    <table className="bx-table">
      <thead>
        <tr>
          {onStar && <th />}
          <th>#</th>
          <th>Token</th>
          {cols.map((c) => (
            <th key={c.key} className="num">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.slice(0, max).map((r, i) => (
          <tr
            key={r.token?.id ?? i}
            className={`${onPick && r.token ? 'pick' : ''}${r.token && r.token.id === selectedId ? ' sel' : ''}`}
            onClick={onPick && r.token ? () => onPick(r.token!) : undefined}
          >
            {onStar && (
              <td className="star">
                {r.token && (
                  <button
                    className={starred?.has(r.token.id) ? 'on' : ''}
                    title={starred?.has(r.token.id) ? 'On your watchlist — click to remove' : 'Add to your watchlist'}
                    onClick={(e) => {
                      e.stopPropagation()
                      onStar(r.token!)
                    }}
                  >
                    {starred?.has(r.token.id) ? '★' : '☆'}
                  </button>
                )}
              </td>
            )}
            <td className="dim">{i + 1}</td>
            <td className="sym">{r.token?.symbol ?? String(r.symbol ?? r.name ?? '·')}</td>
            {cols.map((c) => {
              const v = r[c.key]
              const n = typeof v === 'number' ? v : null
              return (
                <td key={c.key} className={`num${c.unit === 'pct' && n != null ? (n >= 0 ? ' up' : ' down') : ''}`}>
                  {typeof v === 'string' ? v : formatValue(n, c.unit)}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
      {table.rows.length > max && (
        <tfoot>
          <tr>
            <td colSpan={cols.length + (onStar ? 3 : 2)} className="dim">
              + {table.rows.length - max} more
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  )
}

/**
 * A safety report at a glance: the verdict, how many checks passed, the risks found (worst first) and the
 * facts. Used by the Safety block (canvas and Page) and the Safety card.
 */
export function SafetySummary({ report, big, ignored = 0 }: { report: ReportValue; big?: boolean; ignored?: number }) {
  const flags = [...report.flags].sort((a, b) => Number(b.level === 'bad') - Number(a.level === 'bad'))
  const shown = big ? flags : flags.slice(0, 4)
  const checks = report.checks?.length ?? 0
  const passed = report.checks?.filter((c) => !c.hit).length ?? 0
  return (
    <>
      <div className={`bx-verdict ${report.verdict}`}>{report.verdict === 'safe' ? 'No risks found' : report.verdict[0].toUpperCase() + report.verdict.slice(1)}</div>
      {checks > 0 && (
        <div className="bx-sub">
          {passed} of {checks} checks passed
          {ignored > 0 && ` · ${ignored} ignored`} · {report.sources.join(' + ')}
        </div>
      )}
      {shown.map((f, i) => (
        <div key={i} className={`bx-flag ${f.level}`}>
          {f.label}
        </div>
      ))}
      {flags.length > shown.length && <div className="bx-sub">+ {flags.length - shown.length} more</div>}
      {report.facts.map((f, i) => (
        <div key={i} className="bx-row">
          <span>{f.label}</span>
          <b className={f.level === 'good' ? 'up' : f.level === 'bad' ? 'down' : ''}>{f.value}</b>
        </div>
      ))}
    </>
  )
}
