import { useEffect, useState } from 'react'
import { useFetchState } from '../lib/fetchState'

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * Top-right status of a card's API: Fetching… while any request is in flight, Updated HH:MM:SS after a
 * success, Error (reason on hover) after a failure. Combines requests made by wires (tracked) with the
 * card's own loading / auto-refresh.
 */
export function FetchBadge({
  id,
  loading,
  error,
  updatedAt,
  source,
}: {
  id: string
  /** The card's own first load is running. */
  loading: boolean
  /** The card's own last load failed (and it has nothing to show). */
  error: string | null
  /** The card's own last successful load. */
  updatedAt: number | null
  source: string
}) {
  const s = useFetchState(id)
  // Keep "Fetching…" visible for a moment even when the answer comes from cache, so it's never invisible.
  const [lingering, setLingering] = useState(false)
  const busy = s.pending > 0 || loading
  useEffect(() => {
    if (!busy && s.started === 0) return
    setLingering(true)
    const t = setTimeout(() => setLingering(false), 400)
    return () => clearTimeout(t)
  }, [busy, s.started])

  const okAt = Math.max(s.okAt ?? 0, updatedAt ?? 0) || null
  const errorText = s.errorAt && s.errorAt > (okAt ?? 0) ? s.error : error
  const errorAt = s.errorAt && s.errorAt > (okAt ?? 0) ? s.errorAt : null

  let state: 'fetching' | 'error' | 'ok' | 'idle' = 'idle'
  if (busy || lingering) state = 'fetching'
  else if (errorText) state = 'error'
  else if (okAt) state = 'ok'

  const label = { fetching: 'Fetching…', error: 'Error', ok: okAt ? `Updated ${time(okAt)}` : '', idle: 'Idle' }[state]
  const title =
    state === 'error'
      ? `${source}: ${errorText}${errorAt ? ` (at ${time(errorAt)})` : ''}`
      : state === 'ok'
        ? `${source} answered at ${time(okAt!)}`
        : state === 'fetching'
          ? `Waiting for ${source}…`
          : `No request to ${source} yet`

  return (
    <span className={`fetch-badge ${state}`} title={title}>
      {state === 'fetching' ? <span className="spinner" /> : <span className="fetch-dot" />}
      {label}
    </span>
  )
}
