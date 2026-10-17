import { useEffect, useState } from 'react'

/**
 * Live API state per card: how many requests are in flight, and when the last one succeeded or failed.
 * Cards wrap every fetch in `track()`, so the badge on the card shows what's really happening — the wire
 * into a card blinks the moment a token is delivered, but the answer may take a while (or fail).
 */
export interface FetchState {
  pending: number
  /** Requests started so far — lets the badge show even a request answered instantly from cache. */
  started: number
  okAt: number | null
  error: string | null
  errorAt: number | null
}

const EMPTY: FetchState = { pending: 0, started: 0, okAt: null, error: null, errorAt: null }
const states = new Map<string, FetchState>()
const listeners = new Map<string, Set<(s: FetchState) => void>>()

const get = (id: string) => states.get(id) ?? EMPTY

function set(id: string, next: FetchState) {
  states.set(id, next)
  listeners.get(id)?.forEach((l) => l(next))
}

/** Count `promise` as an in-flight request for card `id`, recording its success or failure. */
export async function track<T>(id: string, promise: Promise<T>, answeredAt?: (result: T) => number | undefined): Promise<T> {
  set(id, { ...get(id), pending: get(id).pending + 1, started: get(id).started + 1 })
  try {
    const result = await promise
    // A reused (cached) answer reports when it was really fetched, not "now".
    const at = answeredAt?.(result) ?? Date.now()
    set(id, { ...get(id), okAt: Math.max(get(id).okAt ?? 0, at) })
    return result
  } catch (e) {
    set(id, { ...get(id), error: (e as Error).message, errorAt: Date.now() })
    throw e
  } finally {
    set(id, { ...get(id), pending: Math.max(0, get(id).pending - 1) })
  }
}

export function useFetchState(id: string): FetchState {
  const [state, setState] = useState(() => get(id))
  useEffect(() => {
    const set = listeners.get(id) ?? new Set()
    set.add(setState)
    listeners.set(id, set)
    setState(get(id))
    return () => {
      set.delete(setState)
    }
  }, [id])
  return state
}
