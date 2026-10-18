import type { CheckResult, SourceResult } from './safetyChecks'
import type { Unit } from './metrics'

/**
 * What travels on a wire. Every block computes its outputs from its inputs (like spreadsheet cells), so a
 * wire always carries the source's *current* value — one of these.
 */

/** Which token: chain + contract address (`id` = "chain:address"), plus how it's shown. */
export interface Token {
  kind: 'token'
  id: string
  chain: string
  address: string
  symbol: string
  name: string
  logo?: string | null
  /** Its main pool / pair, when known. */
  pool?: string | null
}

/** One number with its unit (and what it is). */
export interface NumberValue {
  kind: 'number'
  value: number | null
  unit: Unit
  label?: string
}

export interface Column {
  key: string
  label: string
  unit: Unit
}

/** A row of a table: named cells, and the token it's about (for token lists). */
export type Row = { token?: Token } & Record<string, number | string | null | Token | undefined>

/** Rows × named columns. A token list is a table whose rows each carry a `token`. */
export interface TableValue {
  kind: 'table'
  columns: Column[]
  rows: Row[]
}

/** A value over time, oldest first. */
export interface SeriesValue {
  kind: 'series'
  label: string
  unit: Unit
  points: [t: number, v: number][]
}

/** OHLCV candles, oldest first. */
export interface CandlesValue {
  kind: 'candles'
  label: string
  /** Candle size, e.g. "15m". */
  interval: string
  bars: [t: number, open: number, high: number, low: number, close: number, volume: number][]
}

export type Level = 'good' | 'warn' | 'bad'

/** A verdict with its findings (e.g. a safety check). */
export interface ReportValue {
  kind: 'report'
  title: string
  verdict: 'safe' | 'caution' | 'danger' | 'unknown'
  token?: Token
  flags: { label: string; level: Level }[]
  facts: { label: string; value: string; level?: Level }[]
  sources: string[]
  /** Every check made and its outcome, and how each service answered (see core/safetyChecks). */
  checks?: CheckResult[]
  answered?: SourceResult[]
}

export interface TextValue {
  kind: 'text'
  value: string
}

export interface BoolValue {
  kind: 'bool'
  value: boolean
  label?: string
}

/** A Clock's beat: blocks with a clock wired in refresh every `everyMs` (or not at all while it's paused). */
export interface ClockValue {
  kind: 'clock'
  everyMs: number
  running: boolean
  label?: string
}

export type Value = Token | NumberValue | TableValue | SeriesValue | CandlesValue | ReportValue | TextValue | BoolValue | ClockValue

export type ValueKind = Value['kind']

// ---------- helpers ----------

export const num = (value: number | null, unit: Unit = 'none', label?: string): NumberValue => ({ kind: 'number', value, unit, label })

export const isTokenTable = (t: TableValue) => t.rows.length > 0 && t.rows.every((r) => r.token)

/** Plain numbers of a column (nulls dropped). */
export const columnValues = (t: TableValue, key: string) =>
  t.rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

/** A token's id from chain + address (CoinGecko coins without a contract: "coingecko:<id>"). */
export const tokenId = (chain: string, address: string) => `${chain}:${address}`
