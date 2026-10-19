import { useSyncExternalStore } from 'react'

/**
 * The dashboard's timeframe (its navbar menu): while the full-screen dashboard shows, every chart on it
 * uses this one instead of its own. Empty = each chart keeps its own.
 */
let current = ''
const listeners = new Set<() => void>()

export function setDashTimeframe(v: string) {
  if (v === current) return
  current = v
  listeners.forEach((l) => l())
}

export const useDashTimeframe = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => current,
  )
