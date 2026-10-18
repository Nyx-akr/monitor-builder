import { useEffect, useState } from 'react'
import { percent } from '../lib/format'
import { candlePeriod, toCandles } from './data'
import { LINE_COLORS, TIMEFRAMES, formatTime, formatValue, timeframeOf } from './options'
import type { Candle, ChartStyle, DrawnLine, Point } from './types'
import './chart.css'

/** One line to draw: its key, guide name and all its points (the view keeps the ones in the timeframe). */
export interface ChartLine {
  key: string
  label: string
  points: Point[]
}

export interface ChartViewProps {
  lines: ChartLine[]
  style: ChartStyle
  timeframe: string
  /** % change from each line's first point in view, instead of one shared value scale. */
  asPercent: boolean
  candleSize: string
  /** Filling a Page box (bigger text), rather than the patch box on the canvas. */
  big?: boolean
  /** Shown when there's nothing to draw yet. */
  emptyText: string
  /** Given: the timeframe is a dropdown at the top right, so it can be changed right on the chart. */
  onTimeframe?: (value: string) => void
}

// The plot is drawn in a 1000 × 400 box and stretched to fit; labels are HTML so they don't stretch.
const W = 1000
const H = 400

/** Keep a sliding window current even when no new data arrives. */
function useNow(everyMs = 5000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

export function ChartView({ lines, style, timeframe, asPercent, candleSize, big, emptyText, onTimeframe }: ChartViewProps) {
  const now = useNow()
  const tf = timeframeOf(timeframe)
  const from = now - tf.ms

  // Visible points per line, as % change from the first one when asked.
  const drawn: DrawnLine[] = lines.map((line, i) => {
    const pts = line.points.filter(([t]) => t >= from)
    const base = pts[0]?.[1]
    const last = pts[pts.length - 1]?.[1]
    return {
      key: line.key,
      label: line.label,
      color: LINE_COLORS[i % LINE_COLORS.length],
      points: asPercent && base ? pts.map(([t, v, o, h, l]): Point => (o === undefined ? [t, toPct(v, base)] : [t, toPct(v, base), toPct(o, base), toPct(h!, base), toPct(l!, base)])) : pts,
      last,
      change: base && last !== undefined ? (last / base - 1) * 100 : null,
    }
  })

  const all = drawn.flatMap((l) => l.points)
  const t0 = Math.min(...all.map((p) => p[0]))
  const t1 = Math.max(...all.map((p) => p[0]))
  const withData = drawn.filter((l) => l.points.length > 0)
  // Lines that came as real candles (open / high / low / close per row) are drawn as they are; others are
  // grouped into candles of the chosen size.
  const real = withData.length > 0 && withData.every((l) => l.points.every((p) => p[2] !== undefined))
  const period = real ? realPeriod(withData) : candlePeriod(candleSize, t1 - t0, Math.max(0, ...withData.map((l) => l.points.length)))
  const candles = style === 'candle' ? withData.map((l) => (real ? l.points.map(asCandle) : toCandles(l.points, period))) : []
  // Candles stretch the time range by one period so the last one has room.
  const tEnd = style === 'candle' ? t1 + period : t1
  const tStart = style === 'candle' ? Math.floor(t0 / period) * period : t0
  // Candles reach their highs and lows, not just their closes.
  let v0 = Math.min(...all.map((p) => (style === 'candle' && p[4] !== undefined ? p[4] : p[1])))
  let v1 = Math.max(...all.map((p) => (style === 'candle' && p[3] !== undefined ? p[3] : p[1])))
  const pad = (v1 - v0) * 0.08 || Math.abs(v1) * 0.01 || 1
  v0 -= pad
  v1 += pad
  const x = (t: number) => (tEnd > tStart ? ((t - tStart) / (tEnd - tStart)) * W : W / 2)
  const y = (v: number) => H - ((v - v0) / (v1 - v0)) * H

  return (
    <div className={`chart-box ${big ? 'big' : 'small'}`}>
      <div className="chart-head">
        <span className="chart-title">Chart</span>
        <span className="chart-tf">
          {onTimeframe ? (
            <select className="chart-tf-select" value={tf.value} onChange={(e) => onTimeframe(e.target.value)} title="How far back to show">
              {TIMEFRAMES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          ) : (
            tf.label
          )}
          {asPercent ? ' · % change' : ''}
          {style === 'candle' && all.length > 0 ? ` · ${Math.round(period / 60e3) >= 60 ? `${Math.round(period / 3600e3)}h` : `${Math.round(period / 60e3)}m`} candles` : ''}
        </span>
      </div>
      {/* The guide: which colour is which data, its latest value and its change over the window. */}
      <div className="chart-legend">
        {drawn.map((l) => (
          <span key={l.key} className="chart-key" title={`${l.label} — from input ${l.key.split(':')[0]}`}>
            <i style={{ background: l.color }} />
            {l.label}
            {l.last !== undefined ? <b>{formatValue(l.last, false)}</b> : <span className="dim">no data</span>}
            {l.change !== null && <span className={l.change >= 0 ? 'up' : 'down'}>{percent(l.change)}</span>}
          </span>
        ))}
      </div>
      <div className="chart-plot">
        {all.length === 0 ? (
          <div className="chart-empty">{emptyText}</div>
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              {[H / 4, H / 2, (H * 3) / 4].map((g) => (
                <line key={g} className="grid" x1="0" x2={W} y1={g} y2={g} />
              ))}
              {style === 'candle'
                ? candles.map((cs, i) => <Candles key={withData[i].key} candles={cs} index={i} count={withData.length} color={withData[i].color} period={period} x={x} y={y} />)
                : drawn.map((l) => <Line key={l.key} line={l} area={style === 'area'} x={x} y={y} />)}
            </svg>
            <span className="chart-y top">{formatValue(v1 - pad, asPercent)}</span>
            <span className="chart-y bottom">{formatValue(v0 + pad, asPercent)}</span>
          </>
        )}
      </div>
      {all.length > 0 && (
        <div className="chart-x">
          <span>{formatTime(t0, t1 - t0)}</span>
          <span>{formatTime(t1, t1 - t0)}</span>
        </div>
      )}
    </div>
  )
}

type Scale = (n: number) => number

const toPct = (v: number, base: number) => (v / base - 1) * 100

/** A point that came as a candle → the candle. */
const asCandle = ([t, close, open, high, low]: Point): Candle => ({ t, open: open!, high: high!, low: low!, close })

/** The spacing of real candles: the most common gap between them. */
function realPeriod(lines: DrawnLine[]): number {
  const gaps = lines.flatMap((l) => l.points.slice(1).map((p, i) => p[0] - l.points[i][0])).filter((g) => g > 0)
  if (!gaps.length) return 60e3
  const counts = new Map<number, number>()
  for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}

function Line({ line, area, x, y }: { line: DrawnLine; area: boolean; x: Scale; y: Scale }) {
  const pts = line.points
  if (pts.length === 1) return <circle cx={x(pts[0][0])} cy={y(pts[0][1])} r="4" fill={line.color} />
  const path = pts.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')
  return (
    <g>
      {area && <polygon className="area" fill={line.color} fillOpacity={0.16} points={`${x(pts[0][0])},${H} ${path} ${x(pts[pts.length - 1][0])},${H}`} />}
      <polyline stroke={line.color} points={path} />
    </g>
  )
}

/**
 * One line's candles. A single line uses green (up) / red (down); with several lines each keeps its own
 * colour — filled when up, hollow when down — and its candles sit side by side within each period.
 */
function Candles({ candles, index, count, color, period, x, y }: { candles: Candle[]; index: number; count: number; color: string; period: number; x: Scale; y: Scale }) {
  const slot = (x(period) - x(0)) * 0.8
  const w = Math.max(1, slot / count)
  return (
    <g>
      {candles.map((c) => {
        const up = c.close >= c.open
        const tone = count === 1 ? (up ? 'var(--up)' : 'var(--down)') : color
        const left = x(c.t) + (x(period) - x(0)) * 0.1 + index * w
        const top = y(Math.max(c.open, c.close))
        const bodyH = Math.max(1, Math.abs(y(c.open) - y(c.close)))
        return (
          <g key={c.t}>
            <line className="wick" stroke={tone} x1={left + w / 2} x2={left + w / 2} y1={y(c.high)} y2={y(c.low)} />
            <rect className="body" x={left} y={top} width={w} height={bodyH} stroke={tone} fill={up || count === 1 ? tone : 'transparent'} />
          </g>
        )
      })}
    </g>
  )
}
