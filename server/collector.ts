import fs from 'node:fs/promises'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { API_LIMITS, type Api } from '../src/core/feedSources'
import { CLOCK_METRICS } from '../src/core/metrics'

/**
 * The Feed's storage. Every source (GeckoTerminal trending, DexScreener boosts, CoinGecko top…) runs on
 * its own timer in the background — whether a Feed shows it or not — and every token it returns is
 * written to data/history/<token>.jsonl (the files the History block reads). When a source finishes,
 * the app is told at once (server-sent events), so lists and the selected token's history update live.
 *
 *   data/feed/config.json   each source's timer and pages, and how long history is kept
 *   data/feed/latest.json   each source's last list, so a restart shows data at once
 *   data/history/*.jsonl    one line per change: { at, src, m: metrics }
 */

/** What the storage needs of a row (the engine's market rows have more). */
export interface Row {
  token: { id: string; chain: string }
  metrics: Record<string, number | null>
  /** When it was fetched (enrichment uses it to re-check the oldest first). */
  at?: number
  /** Text values (e.g. the rotation engine's phase and call). */
  tags?: Record<string, string>
}

/** What a fetch can see: the tokens stored now, the tokens tracked in full, and when each was last enriched. */
export interface FetchContext<R extends Row> {
  tokens: () => R['token'][]
  /** The latest row of every token in the lists (with its metrics), once per token. */
  rows: () => R[]
  tracked: () => R['token'][]
  checkedAt: (key: string, id: string) => number
}

export interface SourceDef {
  key: string
  /** Which API's budget it uses. */
  api: Api
  /** 'list' = a token list; 'enrich' = values added to stored tokens (merged per token, not replaced). */
  kind?: 'list' | 'enrich'
  /** Documented defaults: seconds between fetches, and pages per fetch (paged lists). */
  every: number
  pages?: number
  maxPages?: number
  /** API calls one fetch makes, for the budget (pages × networks, list + market lookups…; n = tokens covered). */
  calls: (pages: number, n: number) => number
}

export interface SourceStatus {
  key: string
  every: number
  pages?: number
  count: number
  lastAt?: number
  lastMs?: number
  nextAt?: number
  running: boolean
  error?: string
  runs: number
}

interface Config {
  sources: Record<string, { every: number; pages?: number }>
  keepDays: number
}


export function createCollector<R extends Row>(opts: {
  dir: string
  historyDir: string
  sources: SourceDef[]
  fetch: (key: string, pages: number, ctx: FetchContext<R>) => Promise<R[]>
  /** How many tokens an enrichment covers now (for the budget). */
  count?: (key: string, ctx: FetchContext<R>) => number
}) {
  const { sources } = opts
  const configFile = path.join(opts.dir, 'config.json')
  const latestFile = path.join(opts.dir, 'latest.json')
  const config: Config = { sources: {}, keepDays: 7 }
  const state = new Map<string, SourceStatus>(sources.map((s) => [s.key, { key: s.key, every: s.every, pages: s.pages, count: 0, running: false, runs: 0 }]))
  const rows = new Map<string, R[]>()
  const clients = new Set<ServerResponse>()
  const timers: NodeJS.Timeout[] = []

  const settingsOf = (s: SourceDef) => ({
    every: config.sources[s.key]?.every ?? s.every,
    pages: s.pages ? Math.min(s.maxPages ?? 10, Math.max(1, config.sources[s.key]?.pages ?? s.pages)) : undefined,
  })

  // ---------- storage: batched, async, only what changed ----------

  const lastWritten = new Map<string, string>()
  const pending = new Map<string, string[]>()
  const fileOf = (id: string) => path.join(opts.historyDir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`)
  let stored = { files: 0, bytes: 0, at: 0 }

  /** What counts as "changed": the metrics without the ones that only move with the clock (age). */
  const fingerprint = (m: Record<string, number | null>) => JSON.stringify(m, (k, v) => (CLOCK_METRICS.includes(k) ? undefined : v))

  /**
   * Store rows: a line per token whose values changed since its last line. `group` keeps market lines and
   * enrichment lines (Jupiter, GoPlus…) apart, so each only compares with its own kind.
   */
  function store(list: Row[], src: string, at = Date.now(), group = 'market') {
    for (const r of list) {
      const m = JSON.stringify(r.metrics)
      const key = `${group}|${r.token.id}`
      const fp = fingerprint(r.metrics)
      if (lastWritten.get(key) === fp) continue // nothing new for this token
      lastWritten.set(key, fp)
      const lines = pending.get(r.token.id) ?? []
      lines.push(`{"at":${at},"src":"${src}","m":${m}}\n`)
      pending.set(r.token.id, lines)
    }
  }

  async function flush() {
    if (!pending.size) return
    const batch = [...pending]
    pending.clear()
    await fs.mkdir(opts.historyDir, { recursive: true })
    for (let i = 0; i < batch.length; i += 32)
      await Promise.all(batch.slice(i, i + 32).map(([id, lines]) => fs.appendFile(fileOf(id), lines.join('')).catch(() => {})))
  }

  /** Drop history of tokens nobody has updated for `keepDays` (0 = keep forever), and count what's stored. */
  async function prune() {
    const names = await fs.readdir(opts.historyDir).catch(() => [] as string[])
    const cutoff = Date.now() - config.keepDays * 86400e3
    let files = 0
    let bytes = 0
    for (const n of names) {
      const st = await fs.stat(path.join(opts.historyDir, n)).catch(() => null)
      if (!st) continue
      if (config.keepDays > 0 && st.mtimeMs < cutoff) await fs.unlink(path.join(opts.historyDir, n)).catch(() => {})
      else (files++, (bytes += st.size))
    }
    stored = { files, bytes, at: Date.now() }
  }

  // ---------- live updates to the app ----------

  function emit(event: { source: string; at: number; ids: string[] }) {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const res of clients) res.write(data)
  }

  function subscribe(res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    clients.add(res)
    res.on('close', () => clients.delete(res))
  }

  // ---------- the timers ----------

  let saveTimer: NodeJS.Timeout | null = null
  const saveLatest = () => {
    if (saveTimer) return
    saveTimer = setTimeout(async () => {
      saveTimer = null
      await fs.mkdir(opts.dir, { recursive: true })
      const tmp = `${latestFile}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(rows)))
      await fs.rename(tmp, latestFile).catch(() => {})
    }, 5000)
  }

  // ---------- what the enrichment works on ----------

  const lists = () => sources.filter((s) => (s.kind ?? 'list') === 'list')
  /** Every token in the sources' last lists, once. */
  const universe = (): R['token'][] => {
    const seen = new Map<string, R['token']>()
    for (const s of lists()) for (const r of rows.get(s.key) ?? []) if (!seen.has(r.token.id)) seen.set(r.token.id, r.token)
    return [...seen.values()]
  }
  /** Tokens tracked in full (the Watchlist's, the one in Token details), by who asked. */
  const trackedBy = new Map<string, R['token'][]>()
  const tracked = () => {
    const seen = new Map<string, R['token']>()
    for (const list of trackedBy.values()) for (const t of list) seen.set(t.id, t)
    return [...seen.values()]
  }
  const latestRows = (): R[] => {
    const seen = new Map<string, R>()
    for (const s of lists()) for (const r of rows.get(s.key) ?? []) if (!seen.has(r.token.id)) seen.set(r.token.id, r)
    return [...seen.values()]
  }
  const ctx: FetchContext<R> = {
    tokens: universe,
    rows: latestRows,
    tracked,
    checkedAt: (key, id) => rows.get(key)?.find((r) => r.token.id === id)?.at ?? 0,
  }
  /** Replace who-tracks-what (the Watchlist sends its tokens, Token details its one). */
  const track = (key: string, tokens: R['token'][]) => void trackedBy.set(key, tokens)

  /** Every enrichment's values for a token, merged (later sources win). */
  function extras(id: string): Record<string, number | null> {
    const out: Record<string, number | null> = {}
    for (const s of sources) if (s.kind === 'enrich') Object.assign(out, rows.get(s.key)?.find((r) => r.token.id === id)?.metrics ?? {})
    return out
  }

  /** Every enrichment's text values for a token, merged. */
  function extraTags(id: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const s of sources) if (s.kind === 'enrich') Object.assign(out, rows.get(s.key)?.find((r) => r.token.id === id)?.tags ?? {})
    return out
  }

  async function run(s: SourceDef) {
    const st = state.get(s.key)!
    const { every, pages } = settingsOf(s)
    const started = Date.now()
    st.running = true
    // The next fetch is due `every` after this one *started*, so the pace is the one set.
    st.nextAt = started + every * 1000
    try {
      const list = await opts.fetch(s.key, pages ?? 1, ctx)
      if (s.kind === 'enrich') {
        // Merge: a run covers some tokens; the others keep their last values (up to 20,000 tokens).
        const byId = new Map((rows.get(s.key) ?? []).map((r) => [r.token.id, r]))
        for (const r of list) byId.set(r.token.id, { ...r, at: r.at ?? Date.now() })
        rows.set(s.key, [...byId.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 20_000))
        st.count = rows.get(s.key)!.length
      } else {
        rows.set(s.key, list)
        st.count = list.length
      }
      st.error = undefined
      store(list, s.key, Date.now(), s.kind === 'enrich' ? s.key : 'market')
      await flush() // on disk before the app is told, so its history read sees the new point
      saveLatest()
      emit({ source: s.key, at: Date.now(), ids: list.map((r) => r.token.id) })
    } catch (e) {
      st.error = (e as Error).message
    } finally {
      st.running = false
      st.lastAt = Date.now()
      st.lastMs = st.lastAt - started
      st.runs++
    }
  }

  function tick() {
    const now = Date.now()
    for (const s of sources) {
      const st = state.get(s.key)!
      const { every, pages } = settingsOf(s)
      st.every = every
      st.pages = pages
      if (every <= 0) {
        st.nextAt = undefined
        continue
      }
      if (st.nextAt == null) st.nextAt = now + Math.random() * 3000 // stagger the first round
      if (!st.running && now >= st.nextAt) void run(s)
    }
  }

  async function start() {
    try {
      Object.assign(config, JSON.parse(await fs.readFile(configFile, 'utf8')))
    } catch {
      /* defaults */
    }
    try {
      const saved = JSON.parse(await fs.readFile(latestFile, 'utf8')) as Record<string, R[]>
      for (const [k, list] of Object.entries(saved))
        if (state.has(k)) {
          rows.set(k, list)
          state.get(k)!.count = list.length
          const group = sources.find((s) => s.key === k)?.kind === 'enrich' ? k : 'market'
          for (const r of list) lastWritten.set(`${group}|${r.token.id}`, fingerprint(r.metrics))
        }
    } catch {
      /* first run */
    }
    timers.push(setInterval(tick, 1000))
    timers.push(setInterval(() => void flush(), 5000))
    timers.push(setInterval(() => void prune(), 10 * 60_000))
    timers.push(setInterval(() => clients.forEach((c) => c.write(': ping\n\n')), 25_000))
    void prune()
  }

  async function stop() {
    timers.forEach(clearInterval)
    clients.forEach((c) => c.end())
    await flush()
  }

  /** Change timers / pages / retention (from a Feed's settings). Only what's given changes. */
  async function configure(patch: Partial<Config>) {
    let changed = false
    for (const [k, v] of Object.entries(patch.sources ?? {})) {
      const def = sources.find((s) => s.key === k)
      if (!def) continue
      const every = Math.max(0, Number(v.every))
      const pages = v.pages != null ? Number(v.pages) : undefined
      const prev = config.sources[k]
      if (prev?.every === every && prev?.pages === pages) continue
      // A faster timer applies now, not after the old, longer wait.
      const st = state.get(k)!
      if (st.lastAt && every > 0) st.nextAt = Math.min(st.nextAt ?? Infinity, (st.lastAt - (st.lastMs ?? 0)) + every * 1000)
      config.sources[k] = { every, ...(pages != null ? { pages } : {}) }
      changed = true
    }
    if (patch.keepDays != null && Number(patch.keepDays) !== config.keepDays) {
      config.keepDays = Math.max(0, Number(patch.keepDays))
      changed = true
    }
    if (!changed) return
    await fs.mkdir(opts.dir, { recursive: true })
    await fs.writeFile(configFile, JSON.stringify(config, null, 2))
  }

  /** API calls per minute each API gets from the timers, against its documented limit. */
  function budget() {
    const out: Record<string, { used: number; limit: number }> = {}
    for (const api of Object.keys(API_LIMITS) as Api[]) out[api] = { used: 0, limit: API_LIMITS[api] }
    for (const s of sources) {
      const { every, pages } = settingsOf(s)
      if (every > 0) out[s.api].used += (s.calls(pages ?? 1, opts.count?.(s.key, ctx) ?? 0) * 60) / every
    }
    return out
  }

  const status = () => ({
    sources: sources.map((s) => ({ ...state.get(s.key)!, api: s.api })),
    budget: budget(),
    storage: { ...stored, keepDays: config.keepDays, pending: pending.size },
  })

  /** The newest row of a token in any source's last list. */
  function find(id: string): R | undefined {
    let best: R | undefined
    let bestAt = -1
    for (const [k, list] of rows) {
      if (sources.find((s) => s.key === k)?.kind === 'enrich') continue // partial rows (no price)
      const r = list.find((x) => x.token.id === id)
      const at = state.get(k)?.lastAt ?? 0
      if (r && at > bestAt) (best = r), (bestAt = at)
    }
    return best
  }

  /** Rows fetched outside the timers (the selected token's own updates): stored, then announced. */
  async function record(list: R[], src: string) {
    if (!list.length) return
    store(list, src)
    await flush()
    emit({ source: src, at: Date.now(), ids: list.map((r) => r.token.id) })
  }

  return { start, stop, store, record, find, flush, extras, extraTags, track, tracked, rows: (key: string) => rows.get(key) ?? [], subscribe, configure, status }
}
