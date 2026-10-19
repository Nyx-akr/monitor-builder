import type { Unit } from './metrics'
import type { Value } from './values'
import { compactNumber, money, moneyCompact, percent } from '../lib/format'

/** A number shown in its unit: $0.0₅2886, $1.2M, +12.4%, 1,204, 3.5h… */
export function formatValue(v: number | null | undefined, unit: Unit): string {
  if (v == null || !Number.isFinite(v)) return '—'
  switch (unit) {
    case 'usd':
      return Math.abs(v) >= 1e4 ? moneyCompact(v) : money(v)
    case 'pct':
      return percent(v)
    case 'count':
      return Math.abs(v) >= 1e5 ? compactNumber(v) : Math.round(v).toLocaleString('en-US')
    case 'hours':
      return v < 1 ? `${Math.round(v * 60)}m` : v < 48 ? `${v.toFixed(1)}h` : `${Math.round(v / 24)}d`
    case 'ratio':
      return v.toLocaleString('en-US', { maximumFractionDigits: 4 })
    default:
      return Math.abs(v) >= 1e6 ? compactNumber(v) : v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 1 ? 8 : 4 })
  }
}

/** A few readable lines about any value (port tooltips, previews). */
export function describe(v: Value): string[] {
  switch (v.kind) {
    case 'token':
      return [`token · ${v.symbol} · ${v.name}`, v.chain === 'coingecko' ? `CoinGecko: ${v.address}` : `${v.chain} · ${v.address}`]
    case 'number':
      return [`${v.label ? `${v.label}: ` : ''}${formatValue(v.value, v.unit)}`]
    case 'table': {
      const names = v.rows.slice(0, 4).map((r) => (r.token ? r.token.symbol : Object.values(r).find((x) => typeof x === 'string') ?? '·'))
      return [`table · ${v.rows.length} row${v.rows.length === 1 ? '' : 's'} · ${v.columns.length} columns`, names.join(', ') + (v.rows.length > 4 ? ', …' : '')]
    }
    case 'series': {
      const last = v.points[v.points.length - 1]
      return [`series · ${v.label} · ${v.points.length} points`, last ? `latest ${formatValue(last[1], v.unit)}` : 'no points yet']
    }
    case 'candles': {
      const last = v.bars[v.bars.length - 1]
      return [`candles · ${v.label} · ${v.bars.length} × ${v.interval}`, last ? `last close ${formatValue(last[4], 'usd')}` : 'no candles yet']
    }
    case 'report':
      return [`${v.title} · ${v.verdict}`, v.flags.length ? v.flags.map((f) => f.label).join(', ') : 'no flags']
    case 'text':
      return [`“${v.value.slice(0, 60)}”`]
    case 'bool':
      return [`${v.label ? `${v.label}: ` : ''}${v.value ? 'yes' : 'no'}`]
    case 'marks':
      return [`${v.label} · ${v.marks.length} mark${v.marks.length === 1 ? '' : 's'}`, ...v.marks.slice(-2).map((m) => `${m.label} at ${new Date(m.t).toLocaleTimeString()}`)]
    case 'clock':
      return [v.running ? `every ${v.everyMs >= 60_000 ? `${v.everyMs / 60_000} min` : `${v.everyMs / 1000} s`}` : 'paused']
  }
}
