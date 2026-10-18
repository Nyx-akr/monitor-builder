import { compactNumber, percent } from '../lib/format'
import type { ChartStyle } from './types'

/** One colour per line, in order — the guide shows which is which. */
export const LINE_COLORS = ['#60a5fa', '#f472b6', '#facc15', '#2dd4bf', '#a78bfa', '#f97316']
export const MAX_LINES = LINE_COLORS.length

export const TIMEFRAMES: { value: string; label: string; ms: number }[] = [
  { value: '5m', label: 'Last 5 minutes', ms: 5 * 60e3 },
  { value: '15m', label: 'Last 15 minutes', ms: 15 * 60e3 },
  { value: '1h', label: 'Last hour', ms: 3600e3 },
  { value: '4h', label: 'Last 4 hours', ms: 4 * 3600e3 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 3600e3 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86400e3 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 86400e3 },
  { value: 'all', label: 'Everything', ms: Infinity },
]
/** The default timeframe: the last 24 hours. */
export const DEFAULT_TIMEFRAME = '24h'
export const timeframeOf = (value: string) => TIMEFRAMES.find((x) => x.value === value) ?? TIMEFRAMES.find((x) => x.value === DEFAULT_TIMEFRAME)!

export const STYLES: { value: ChartStyle; label: string }[] = [
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area — line with a filled area below' },
  { value: 'candle', label: 'Candles — open / high / low / close per period' },
]

/** Candle periods; "auto" picks one giving about 40 candles across what's shown. */
export const CANDLE_SIZES: { value: string; label: string; ms: number }[] = [
  { value: 'auto', label: 'Automatic', ms: 0 },
  { value: '1m', label: '1 minute', ms: 60e3 },
  { value: '5m', label: '5 minutes', ms: 5 * 60e3 },
  { value: '15m', label: '15 minutes', ms: 15 * 60e3 },
  { value: '1h', label: '1 hour', ms: 3600e3 },
  { value: '4h', label: '4 hours', ms: 4 * 3600e3 },
  { value: '1d', label: '1 day', ms: 86400e3 },
]

/** A value on the chart's axis / guide. */
export const formatValue = (v: number, asPercent: boolean) =>
  asPercent ? percent(v) : Math.abs(v) >= 1e5 ? compactNumber(v) : v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 1 ? 6 : 2 })

/** A time on the x axis: with the date once the span is over a day and a half, with seconds under 15 minutes. */
export function formatTime(t: number, spanMs: number) {
  const d = new Date(t)
  return spanMs > 36 * 3600e3
    ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: spanMs < 15 * 60e3 ? '2-digit' : undefined })
}
