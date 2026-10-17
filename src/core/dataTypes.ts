import type { Message, Port } from '../blocks/types'
import { isObject } from './messages'

/**
 * What travels on a wire. Every port declares the types it takes (inlet) or sends (outlet), and only
 * compatible ports can be wired together — a bang outlet can't feed a string-only inlet.
 */
/**
 * 'table': structured data — rows of named values. One row is a dict (a token's details, a market summary,
 * an error, a Dict box); many rows are a list (Top 250, Trending, a Storage's history). Blocks take both.
 */
export type DataType = 'bang' | 'string' | 'number' | 'table' | 'any'

export const TYPE_COLORS: Record<DataType, string> = {
  bang: '#facc15',
  string: '#60a5fa',
  number: '#2dd4bf',
  table: '#a78bfa',
  any: '#8b93a7',
}

export const ERROR_COLOR = '#f97316'

export const typesOf = (port: Port | undefined): DataType[] => port?.types ?? ['any']

/** The type of an actual message value. */
export function typeOfMessage(msg: Message): DataType {
  if (msg === 'bang') return 'bang'
  if (typeof msg === 'number') return 'number'
  if (typeof msg === 'string') return 'string'
  if (Array.isArray(msg) || isObject(msg)) return 'table'
  return 'any'
}

/** Can an inlet taking `accepts` receive a value of type `t`? */
export function accepts(acceptsTypes: DataType[], t: DataType): boolean {
  return acceptsTypes.includes('any') || acceptsTypes.includes(t)
}

/** Can this outlet be wired to this inlet? An `any` outlet may connect anywhere; delivery then checks each message. */
export function compatible(outlet: Port | undefined, inlet: Port | undefined): boolean {
  const sends = typesOf(outlet)
  const takes = typesOf(inlet)
  if (sends.includes('any')) return true
  return sends.some((t) => accepts(takes, t))
}

/** The colour a port / wire is drawn in: its single type, or neutral for mixed / any. */
export function portColor(port: Port | undefined): string {
  if (port?.error) return ERROR_COLOR
  const t = typesOf(port)
  return t.length === 1 ? TYPE_COLORS[t[0]] : TYPE_COLORS.any
}

/** How a type is named in the UI — a bare trigger is just a "signal" to users (internally 'bang'). */
export const TYPE_LABELS: Record<DataType, string> = {
  bang: 'signal',
  string: 'text',
  number: 'number',
  table: 'table',
  any: 'anything',
}

export const describeTypes = (port: Port | undefined) => typesOf(port).map((t) => TYPE_LABELS[t]).join(' · ')

/** Port fill: one type = its colour; several types = equal stripes of each (e.g. text + info). */
export function portBackground(port: Port | undefined): string {
  if (port?.error) return ERROR_COLOR
  const t = typesOf(port).filter((x) => x !== 'any')
  if (t.length <= 1) return portColor(port)
  const w = 100 / t.length
  return `linear-gradient(90deg, ${t.map((x, i) => `${TYPE_COLORS[x]} ${i * w}% ${(i + 1) * w}%`).join(', ')})`
}
