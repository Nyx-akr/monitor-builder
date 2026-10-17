/**
 * A point on a line: time (ms) and value — plus open / high / low when it came as a real candle (e.g. from
 * GeckoTerminal's OHLCV); its value is then the close.
 */
export type Point = [t: number, v: number, o?: number, h?: number, l?: number]

/**
 * The lines of a chart, by key: "line1" for values arriving on input 1, "line1:NUBI" for the token NUBI
 * picked out of the token lists arriving on input 1 (one input carrying a list of tokens draws one line per token).
 */
export type Series = Record<string, Point[]>

/** One candle: a time bucket's open / high / low / close. */
export interface Candle {
  t: number
  open: number
  high: number
  low: number
  close: number
}

export type ChartStyle = 'line' | 'area' | 'candle'

/** One line as drawn: its colour, name and visible points (already filtered to the timeframe / scaled). */
export interface DrawnLine {
  key: string
  label: string
  color: string
  points: Point[]
  last: number | undefined
  change: number | null
}
