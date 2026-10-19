import { useSyncExternalStore } from 'react'
import type { Query, QueryState } from '../blocks/types'

/**
 * The app's side of the data engine. Blocks ask for data with a Query; identical queries from different
 * blocks are one request. While a query is in use (its block is on the canvas) it's asked again every
 * `refreshMs`; a failed one is retried after a while. Every answer bumps a version, so the graph recomputes.
 */

interface Entry {
  q: Query
  state: QueryState
  fetching: boolean
}

const entries = new Map<string, Entry>()
let active = new Set<string>()
let version = 0
const listeners = new Set<() => void>()
const bump = () => {
  version++
  listeners.forEach((l) => l())
}

const RETRY_MS = 15_000

export const keyOf = (q: Query) =>
  `${q.kind}?${Object.entries(q.params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')}`

async function load(key: string, e: Entry) {
  if (e.fetching) return
  e.fetching = true
  e.state = { ...e.state, loading: true }
  try {
    const res = await fetch(`/api/engine/${key}`)
    const body = await res.json().catch(() => ({ error: `The engine answered ${res.status}` }))
    if (!res.ok || body.error) e.state = { ...e.state, loading: false, error: body.error ?? `The engine answered ${res.status}`, at: e.state.at }
    else {
      e.state = { data: body, at: Date.now(), loading: false }
      // A partial answer (a list still filling up): ask again soon, whatever the refresh setting.
      if (body.partial) setTimeout(() => active.has(key) && void load(key, e), 4000)
    }
  } catch {
    e.state = { ...e.state, loading: false, error: 'The dev server isn’t answering (is npm run dev running?)' }
  } finally {
    e.fetching = false
    errorAt.set(key, e.state.error ? Date.now() : 0)
    bump()
  }
}

const errorAt = new Map<string, number>()

/** The current answer to a query (asking for it if it's new). */
export function read(q: Query): QueryState {
  const key = keyOf(q)
  let e = entries.get(key)
  if (!e) {
    e = { q, state: { loading: true }, fetching: false }
    entries.set(key, e)
    void load(key, e)
  } else e.q = q
  return e.state
}

/** The queries in use right now (set by the graph after each evaluation). */
export const setActive = (keys: Set<string>) => {
  active = keys
}

/** Ask again whatever's in use and due. */
setInterval(() => {
  const now = Date.now()
  for (const key of active) {
    const e = entries.get(key)
    if (!e || e.fetching) continue
    const failed = errorAt.get(key)
    if (failed && now - failed > RETRY_MS) void load(key, e)
    else if (!failed && e.q.refreshMs && e.state.at && now - e.state.at > e.q.refreshMs) void load(key, e)
  }
}, 1000)

/** Ask a query again now (a block's "Refresh"). */
export function refresh(q: Query) {
  const key = keyOf(q)
  const e = entries.get(key)
  if (e) void load(key, e)
}

/** Re-render whenever any answer arrives. */
export function useEngineVersion() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
  )
}

/** A one-off request outside the graph (e.g. the token search box). */
export async function ask<T>(kind: Query['kind'], params: Query['params']): Promise<T> {
  const res = await fetch(`/api/engine/${keyOf({ kind, params })}`)
  const body = await res.json()
  if (!res.ok || body.error) throw new Error(body.error ?? `The engine answered ${res.status}`)
  return body as T
}

// ---------- live: the Feed's sources tell the app when they've fetched ----------

/** The latest fetch of each Feed source ({ source → at }), for the Feed's "updated 3 s ago". */
export const sourceUpdates = new Map<string, number>()

/**
 * When a source has fetched, the Feed lists are asked again at once, and so is the history of every token
 * that fetch updated — e.g. the token selected in a Feed gets its new point the moment its source has it.
 */
function listen() {
  if (typeof EventSource === 'undefined') return
  const es = new EventSource('/api/engine/feed/events')
  es.onmessage = (msg) => {
    let ev: { source: string; at: number; ids: string[] }
    try {
      ev = JSON.parse(msg.data)
    } catch {
      return
    }
    sourceUpdates.set(ev.source, ev.at)
    const ids = new Set(ev.ids)
    for (const key of active) {
      const e = entries.get(key)
      if (!e) continue
      // After the rotation engine (or the grading) ran, its views refresh too.
      const engineView = (ev.source === 'rotation' || ev.source === 'grading') && (e.q.kind === 'rotation' || e.q.kind === 'rotation/market' || e.q.kind === 'evaluation')
      if (e.q.kind === 'feed' || engineView || (e.q.kind === 'history' && ids.has(String(e.q.params.id)))) void load(key, e)
    }
  }
  // EventSource reconnects by itself after the dev server restarts.
}
listen()
