import { useEffect, useRef, useState } from 'react'

interface State<T> {
  data: T | null
  loading: boolean
  error: string | null
  updatedAt: number | null
}

/**
 * Loads `load()` whenever `key` changes, then every `refreshSec` seconds (0 = once).
 * Keeps the last good data if a refresh fails, so a rate-limit blip doesn't blank the block.
 */
export function usePolling<T>(key: string, load: () => Promise<T>, refreshSec: number, minRefreshSec = 5): State<T> {
  const [state, setState] = useState<State<T>>({ data: null, loading: false, error: null, updatedAt: null })
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (!key) {
      setState({ data: null, loading: false, error: null, updatedAt: null })
      return
    }
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    setState({ data: null, loading: true, error: null, updatedAt: null })

    const run = async () => {
      try {
        const data = await loadRef.current()
        if (!cancelled) setState({ data, loading: false, error: null, updatedAt: Date.now() })
      } catch (e) {
        if (cancelled) return
        setState((s) => ({ ...s, loading: false, error: (e as Error).message }))
        // Rate-limited: try again as soon as the limit lifts rather than at the next scheduled refresh.
        const after = (e as { retryAfterSec?: number }).retryAfterSec
        if (after) {
          clearTimeout(retry)
          retry = setTimeout(run, (after + 1) * 1000)
        }
      }
    }

    // Debounce so typing in the inspector doesn't fire a request per keystroke.
    const debounce = setTimeout(run, 400)
    const interval = refreshSec > 0 ? setInterval(run, Math.max(minRefreshSec, refreshSec) * 1000) : undefined
    return () => {
      cancelled = true
      clearTimeout(retry)
      clearTimeout(debounce)
      if (interval) clearInterval(interval)
    }
  }, [key, refreshSec, minRefreshSec])

  return state
}
