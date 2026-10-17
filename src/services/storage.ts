import { useEffect, useState } from 'react'
import type { Message } from '../blocks/types'

/** A storage file in flows/storage: how many batches it holds and how much disk it takes. */
export interface StoreInfo {
  name: string
  entries: number
  bytes: number
  updatedAt: string
}

/** One batch of data a storage received, labelled with when it arrived. */
export interface StoreRecord {
  at: string
  type: string
  data: Message
}

const API = '/api/storage'

let stores: StoreInfo[] = []
let loaded = false
const listeners = new Set<(s: StoreInfo[]) => void>()
const publish = () => listeners.forEach((l) => l(stores))

/** Merge one store's fresh info into the list (adds it if it's new). */
function setInfo(info: StoreInfo) {
  const i = stores.findIndex((s) => s.name === info.name)
  stores = i >= 0 ? stores.map((s, j) => (j === i ? info : s)) : [...stores, info].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  publish()
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Storage request failed (${res.status})`)
  return body as T
}

export async function refreshStores() {
  const { stores: list } = await call<{ stores: StoreInfo[] }>(API)
  stores = list
  loaded = true
  publish()
  return stores
}

export const storeList = () => stores
export const storeInfo = (name: string) => stores.find((s) => s.name === name)

/** Every storage file, kept current as data is stored. */
export function useStores() {
  const [list, setList] = useState(stores)
  useEffect(() => {
    listeners.add(setList)
    if (!loaded) refreshStores().catch(() => {})
    return () => {
      listeners.delete(setList)
    }
  }, [])
  return list
}

export async function createStore() {
  const info = await call<StoreInfo>(API, { method: 'POST' })
  setInfo(info)
  return info
}

const url = (name: string) => `${API}/${encodeURIComponent(name)}`

/**
 * Add one batch to a store's history; the server labels it with the date and time.
 * keep > 0: only the newest `keep` batches stay in the file (0 = keep everything).
 */
export async function appendRecord(name: string, type: string, data: Message, keep = 0) {
  const info = await call<StoreInfo>(url(name), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, data, keep }) })
  setInfo(info)
  return info
}

/** Remove all but the newest `keep` batches right away (e.g. when the limit is lowered). */
export async function trimStore(name: string, keep: number) {
  if (!(keep > 0)) return
  setInfo(await call<StoreInfo>(`${url(name)}?keep=${keep}`, { method: 'PATCH' }))
}

/**
 * Records, oldest first: the newest `last` (0 = all of them); with `since` (ms) only those stored since
 * then; with `max`, no more than that many — spread evenly over the time span, the newest always included.
 */
export async function readRecords(name: string, last = 50, opts: { since?: number; max?: number } = {}) {
  const q = new URLSearchParams({ last: String(last) })
  if (opts.since) q.set('since', String(Math.floor(opts.since)))
  if (opts.max) q.set('max', String(opts.max))
  const { records, ...info } = await call<StoreInfo & { records: StoreRecord[] }>(`${url(name)}?${q}`)
  setInfo(info)
  return records
}

export async function clearStore(name: string) {
  setInfo(await call<StoreInfo>(`${url(name)}?clear`, { method: 'DELETE' }))
}

export async function deleteStore(name: string) {
  await call(url(name), { method: 'DELETE' })
  stores = stores.filter((s) => s.name !== name)
  publish()
}

/** 1.4 KB, 3.2 MB… */
export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

/** "16 Oct, 22:41:09" — the label a record is shown with. */
export const recordDate = (iso: string) =>
  new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
