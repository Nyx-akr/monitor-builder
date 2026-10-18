import { CANDLE_SIZES } from './options'
import type { Candle, Point } from './types'

/** Candle maths for the chart: turning points into candles of a period. */

/**
 * The candle period: the chosen one, or (auto) one giving up to 40 candles with about 4 points each —
 * so each candle has a real open / high / low / close rather than a single value.
 */
export function candlePeriod(size: string, spanMs: number, pointsPerLine = 160): number {
  const chosen = CANDLE_SIZES.find((c) => c.value === size && c.ms > 0)
  if (chosen) return chosen.ms
  const count = Math.min(40, Math.max(5, Math.round(pointsPerLine / 4)))
  const target = spanMs / count
  const fits = CANDLE_SIZES.filter((c) => c.ms > 0)
  return fits.reduce((best, c) => (Math.abs(Math.log(c.ms / target)) < Math.abs(Math.log(best.ms / target)) ? c : best), fits[0]).ms
}

/** Points → candles: one per period that has points, from its first, highest, lowest and last value. */
export function toCandles(points: Point[], periodMs: number): Candle[] {
  const candles: Candle[] = []
  for (const [t, v] of points) {
    const start = Math.floor(t / periodMs) * periodMs
    const last = candles[candles.length - 1]
    if (last && last.t === start) {
      last.high = Math.max(last.high, v)
      last.low = Math.min(last.low, v)
      last.close = v
    } else candles.push({ t: start, open: v, high: v, low: v, close: v })
  }
  return candles
}
