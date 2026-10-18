import type { Value } from './values'
import { describe } from './show'

/**
 * Each output's current value — shown when hovering it, so you see the data that's actually coming out
 * (e.g. "table · 25 rows: BONK, WIF, POPCAT…") rather than only a description.
 */
const sent = new Map<string, { value: Value; at: number }>()
const key = (block: string, port: string) => `${block}|${port}`

export function recordSent(block: string, port: string, value: Value) {
  const prev = sent.get(key(block, port))
  if (prev?.value !== value) sent.set(key(block, port), { value, at: Date.now() })
}

export function lastSent(block: string, port: string) {
  const s = sent.get(key(block, port))
  return s ? { msg: s.value, at: s.at } : undefined
}

/** A few readable lines about a value. */
export const previewLines = (v: Value): string[] => describe(v)

export const timeOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
