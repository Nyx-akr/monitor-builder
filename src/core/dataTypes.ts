import type { Port } from '../blocks/types'
import type { Value } from './values'

/**
 * The types a port takes or gives — the kinds of value (see core/values). Only compatible ports connect:
 * a Chart takes series or candles, a Market data block takes a token or a token list…
 */
export type DataType = 'token' | 'table' | 'number' | 'series' | 'candles' | 'report' | 'text' | 'bool' | 'clock' | 'marks' | 'any'

export const TYPE_COLORS: Record<DataType, string> = {
  token: '#facc15',
  table: '#a78bfa',
  number: '#2dd4bf',
  series: '#a3e635',
  candles: '#e879f9',
  report: '#fb7185',
  text: '#60a5fa',
  bool: '#cbd5e1',
  clock: '#38bdf8',
  marks: '#f97316',
  any: '#8b93a7',
}

export const ERROR_COLOR = '#f97316'

export const TYPE_LABELS: Record<DataType, string> = {
  token: 'token',
  table: 'table',
  number: 'number',
  series: 'series',
  candles: 'candles',
  report: 'report',
  text: 'text',
  bool: 'yes / no',
  clock: 'clock',
  marks: 'chart marks',
  any: 'anything',
}

export const typesOf = (port: Port | undefined): DataType[] => port?.types ?? ['any']

export const typeOfValue = (v: Value | undefined): DataType | null => (v ? v.kind : null)

/** Can an input taking `takes` receive a value of type `t`? */
export function accepts(takes: DataType[], t: DataType): boolean {
  return takes.includes('any') || takes.includes(t)
}

/** Can this output be wired to this input? An `any` output may connect anywhere. */
export function compatible(outlet: Port | undefined, inlet: Port | undefined): boolean {
  const sends = typesOf(outlet)
  if (sends.includes('any')) return true
  return sends.some((t) => accepts(typesOf(inlet), t))
}

/** The colour a port / wire is drawn in: its single type, or neutral for mixed / any. */
export function portColor(port: Port | undefined): string {
  if (port?.error) return ERROR_COLOR
  const t = typesOf(port)
  return t.length === 1 ? TYPE_COLORS[t[0]] : TYPE_COLORS.any
}

export const describeTypes = (port: Port | undefined) => typesOf(port).map((t) => TYPE_LABELS[t]).join(' · ')

/** Port fill: one type = its colour; several = equal stripes of each. */
export function portBackground(port: Port | undefined): string {
  if (port?.error) return ERROR_COLOR
  const t = typesOf(port).filter((x) => x !== 'any')
  if (t.length <= 1) return portColor(port)
  const w = 100 / t.length
  return `linear-gradient(90deg, ${t.map((x, i) => `${TYPE_COLORS[x]} ${i * w}% ${(i + 1) * w}%`).join(', ')})`
}
