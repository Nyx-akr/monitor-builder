import { useCallback, useEffect, useRef, useState } from 'react'
import { blockByType } from '../blocks/registry'
import type { BlockInstance, BlockProps, PortRef, Wire } from '../blocks/types'
import { compatible } from '../lib/dataTypes'
import { findPort, portsOf, wireFits } from './ports'

/** Camera over the canvas: screen = world * zoom + (x, y) */
export interface View {
  x: number
  y: number
  zoom: number
}

/** What a flow file (flows/<name>.json) holds: the blocks and the wires between them. */
export interface FlowFile {
  version: 1
  name: string
  blocks: BlockInstance[]
  wires: Wire[]
  /** Only in older files — the camera now lives in localStorage, see viewKey. */
  view?: View
  /** Bumped by the server on every save; saves must name the revision they build on. */
  rev?: number
  updatedAt?: string
}

export type SaveStatus = 'loading' | 'saved' | 'unsaved' | 'saving' | 'offline' | 'conflict' | 'error'

export const GRID = 8
export const snap = (n: number) => Math.round(n / GRID) * GRID

const CURRENT_FLOW_KEY = 'dex-builder:current-flow'
/** Pan/zoom is a per-browser convenience, not part of the flow, so it never marks the flow unsaved. */
const viewKey = (flow: string) => `dex-builder:view:${flow}`
const SAVE_DEBOUNCE_MS = 500
/** How often to retry while the flow server can't be reached. */
const RETRY_MS = 3000

/**
 * Unsaved changes are also kept in localStorage until the file has them — so a page reload (e.g. Vite
 * reloading when the dev server comes back) or a closed tab doesn't lose work while saving is failing.
 */
const pendingKey = (flow: string) => `dex-builder:pending:${flow}`
interface PendingBackup {
  /** The file revision these changes were made on top of. */
  baseRev: number
  blocks: BlockInstance[]
  wires: Wire[]
  at: number
}
function writeBackup(name: string, baseRev: number, blocks: BlockInstance[], wires: Wire[]) {
  try {
    localStorage.setItem(pendingKey(name), JSON.stringify({ baseRev, blocks, wires, at: Date.now() } satisfies PendingBackup))
  } catch {
    /* storage full or blocked — the in-memory state is still saved once the server answers */
  }
}
function readBackup(name: string): PendingBackup | null {
  try {
    return JSON.parse(localStorage.getItem(pendingKey(name)) || 'null')
  } catch {
    return null
  }
}
function clearBackup(name: string) {
  try {
    localStorage.removeItem(pendingKey(name))
  } catch {
    /* nothing to clear */
  }
}

/** Why a request to the flow server failed — decides whether to retry, stop, or report. */
class FlowError extends Error {
  constructor(message: string, public kind: 'offline' | 'conflict' | 'server') {
    super(message)
  }
}
const BLANK_VIEW: View = { x: 0, y: 0, zoom: 1 }

const newId = () => Math.random().toString(36).slice(2, 10)

// ---------- flow file API (served by vite-plugin-flows) ----------

/** Identifies this tab in flow-server logs (DEBUG_FLOWS=1), to spot two tabs editing one flow. */
const CLIENT_ID = Math.random().toString(36).slice(2, 6)

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/flows${path}`, {
      ...init,
      headers: { 'x-flow-client': CLIENT_ID, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    })
  } catch {
    throw new FlowError("Can't reach the flow server — is the dev server running (npm run dev)? Retrying…", 'offline')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (res.status === 409) throw new FlowError(body.error ?? 'This flow was changed elsewhere', 'conflict')
    // A static build or another server answers 404 for /api/flows: same as no flow server.
    if (res.status === 404 && !body.error) throw new FlowError("No flow server here — flow files need the dev server (npm run dev). Retrying…", 'offline')
    throw new FlowError(body.error ?? `Flow server responded ${res.status}`, 'server')
  }
  return res.json()
}

const listFlows = () => api<{ flows: string[] }>('').then((r) => r.flows)
const readFlow = (name: string) => api<FlowFile>(`/${encodeURIComponent(name)}`)
const writeFlow = (flow: FlowFile, baseRev: number) =>
  api<{ rev: number }>(`/${encodeURIComponent(flow.name)}`, { method: 'PUT', body: JSON.stringify({ ...flow, baseRev }) })
const createFlow = (initial?: Partial<FlowFile>) => api<FlowFile>('', { method: 'POST', body: JSON.stringify(initial ?? {}) })

/** Pages built before flow files existed were kept in localStorage; they become flow_1. */
function legacyPage(): Partial<FlowFile> | undefined {
  try {
    const blocks = JSON.parse(localStorage.getItem('dex-builder:page') || 'null') as BlockInstance[] | null
    if (!blocks?.length) return undefined
    const view = JSON.parse(localStorage.getItem('dex-builder:view') || 'null') as View | null
    return {
      blocks: blocks.map((b, i) => ({ ...b, x: b.x ?? 40, y: b.y ?? 40 + i * 520 })),
      wires: [],
      view: view ?? BLANK_VIEW,
    }
  } catch {
    return undefined
  }
}

/** Drop blocks whose folder was removed, and wires that point at missing blocks or ports. */
/**
 * Blocks that were retired in favour of another (old type → new type). Saved flows load them as the new
 * block with its default settings, keeping position and wires. The Bang button became the Timer: clicking a
 * Timer sends one signal, just like a Bang did.
 */
const REPLACED_TYPES: Record<string, string> = { bang: 'clock' }

function sanitize(flow: FlowFile): FlowFile {
  const blocks = (flow.blocks ?? [])
    .map((b) => {
      const to = REPLACED_TYPES[b.type]
      return to && blockByType[to] ? { ...b, type: to, props: { ...blockByType[to].defaultProps } } : b
    })
    .filter((b) => blockByType[b.type])
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const hasPort = (ref: PortRef, kind: 'inlets' | 'outlets') => {
    const b = byId.get(ref.block)
    return Boolean(b && portsOf(b)[kind].some((p) => p.id === ref.port))
  }
  const wires: Wire[] = []
  for (const original of flow.wires ?? []) {
    // An inlet that was renamed or merged into another (e.g. a card's trigger → refresh).
    const into = byId.get(original.to.block)
    const renamed = into && blockByType[into.type].renamedInlets?.[original.to.port]
    const outOf = byId.get(original.from.block)
    const renamedOut = outOf && blockByType[outOf.type].renamedOutlets?.[original.from.port]
    const w = {
      from: renamedOut ? { ...original.from, port: renamedOut } : original.from,
      to: renamed ? { ...original.to, port: renamed } : original.to,
      id: original.id,
    }
    if (!hasPort(w.from, 'outlets') || !hasPort(w.to, 'inlets')) continue
    if (wires.some((x) => x.from.block === w.from.block && x.from.port === w.from.port && x.to.block === w.to.block && x.to.port === w.to.port)) continue
    if (wireFits(blocks, w)) {
      wires.push(w)
      continue
    }
    // Typed ports: a wire that no longer fits (e.g. a bang into a message box's data inlet, from before
    // the separate trigger inlet existed) moves to an inlet on the same block that takes its type.
    const outlet = findPort(blocks, w.from, 'outlet')
    const target = byId.get(w.to.block)!
    const fit = portsOf(target).inlets.find(
      (inlet) =>
        compatible(outlet, inlet) &&
        !wires.some((x) => x.from.block === w.from.block && x.from.port === w.from.port && x.to.block === target.id && x.to.port === inlet.id),
    )
    if (fit) wires.push({ ...w, to: { block: target.id, port: fit.id } })
  }
  return { ...flow, blocks, wires }
}

export function useFlow() {
  const [flows, setFlows] = useState<string[]>([])
  const [name, setName] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<BlockInstance[]>([])
  const [wires, setWires] = useState<Wire[]>([])
  const [view, setView] = useState<View>(BLANK_VIEW)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedWireId, setSelectedWireId] = useState<string | null>(null)
  const [status, setStatus] = useState<SaveStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const statusRef = useRef(status)
  statusRef.current = status

  // The state that was just loaded must not be written straight back.
  const skipSave = useRef(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const latest = useRef<FlowFile | null>(null)
  latest.current = name ? { version: 1, name, blocks, wires } : null
  /** Revision of the flow file this state is based on. */
  const rev = useRef(0)
  /** Set after a conflict: stop autosaving so newer changes on disk aren't overwritten. */
  const conflicted = useRef(false)

  // A pending autosave must not fire after this instance is gone (e.g. after a hot reload).
  useEffect(() => () => clearTimeout(saveTimer.current), [])

  const open = useCallback(async (flowName: string) => {
    setStatus('loading')
    try {
      const flow = sanitize(await readFlow(flowName))
      rev.current = flow.rev ?? 0
      conflicted.current = false
      // Unsaved changes from before a reload: restore them if the file hasn't moved on since.
      const backup = readBackup(flowName)
      const restore = backup && backup.baseRev === rev.current
      if (backup && !restore) clearBackup(flowName) // the file changed after them; the file wins
      const content = restore ? sanitize({ ...flow, blocks: backup.blocks, wires: backup.wires }) : flow
      skipSave.current = !restore // restored changes still need saving
      setName(flowName)
      setBlocks(content.blocks)
      setWires(content.wires)
      let saved: View | null = null
      try {
        saved = JSON.parse(localStorage.getItem(viewKey(flowName)) || 'null')
      } catch {
        /* start from the file's old view, or the origin */
      }
      setView(saved ?? flow.view ?? BLANK_VIEW)
      setSelectedId(null)
      setSelectedWireId(null)
      setStatus(restore ? 'unsaved' : 'saved')
      setError(restore ? 'Restored unsaved changes from before the page reloaded' : null)
      try {
        localStorage.setItem(CURRENT_FLOW_KEY, flowName)
      } catch {
        /* only affects which flow opens next time */
      }
    } catch (e) {
      setStatus((e as FlowError).kind === 'offline' ? 'offline' : 'error')
      setError((e as Error).message)
      throw e
    }
  }, [])

  // First load: pick the last-used flow, or create flow_1 (from the old localStorage page if there is one).
  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const boot = async () => {
      try {
        let names = await listFlows()
        if (names.length === 0) {
          await createFlow(legacyPage())
          names = await listFlows()
        }
        setFlows(names)
        let last: string | null = null
        try {
          last = localStorage.getItem(CURRENT_FLOW_KEY)
        } catch {
          /* fall back to the first flow */
        }
        if (!cancelled) await open(last && names.includes(last) ? last : names[0])
      } catch (e) {
        if (cancelled) return
        const offline = (e as FlowError).kind === 'offline'
        setStatus(offline ? 'offline' : 'error')
        setError((e as Error).message)
        // Server not up yet: keep trying until it is.
        if (offline) retry = setTimeout(boot, RETRY_MS)
      }
    }
    boot()
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [open])

  const saveNow = useCallback(async () => {
    clearTimeout(saveTimer.current)
    const flow = latest.current
    if (!flow || conflicted.current) return
    writeBackup(flow.name, rev.current, flow.blocks, flow.wires)
    setStatus('saving')
    try {
      rev.current = (await writeFlow(flow, rev.current)).rev
      // Only clear the backup if nothing changed while the request was in flight.
      const now = latest.current
      if (now && now.name === flow.name && now.blocks === flow.blocks && now.wires === flow.wires) clearBackup(flow.name)
      setStatus('saved')
      setError(null)
    } catch (e) {
      const kind = (e as FlowError).kind
      setError((e as Error).message)
      if (kind === 'conflict') {
        // Someone else saved this flow: stop, so their changes aren't overwritten. Click the status to reload.
        conflicted.current = true
        setStatus('conflict')
        return
      }
      setStatus(kind === 'offline' ? 'offline' : 'error')
      // Keep trying: the server may be restarting. Changes are safe in the backup meanwhile.
      saveTimer.current = setTimeout(saveNow, kind === 'offline' ? RETRY_MS : RETRY_MS * 3)
    }
  }, [])

  // A reload while changes aren't on disk yet (e.g. Vite reloading when the server comes back): back them up.
  useEffect(() => {
    const onUnload = () => {
      const flow = latest.current
      if (flow && !conflicted.current && statusRef.current !== 'saved' && statusRef.current !== 'loading') {
        writeBackup(flow.name, rev.current, flow.blocks, flow.wires)
      }
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  /** After a conflict: drop local changes and load the version on disk. */
  const reloadFromDisk = async () => {
    if (!name) return
    clearBackup(name)
    await open(name).catch(() => {})
  }

  // Autosave every change to the current flow's file.
  useEffect(() => {
    if (!name) return
    if (skipSave.current) {
      skipSave.current = false
      return
    }
    setStatus('unsaved')
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(saveNow, SAVE_DEBOUNCE_MS)
  }, [name, blocks, wires, saveNow])

  // Remember where you were looking in each flow — locally, without touching the flow file or its save status.
  useEffect(() => {
    if (!name) return
    const t = setTimeout(() => {
      try {
        localStorage.setItem(viewKey(name), JSON.stringify(view))
      } catch {
        /* the view just won't be restored next time */
      }
    }, 300)
    return () => clearTimeout(t)
  }, [name, view])

  // Leaving a flow with changes not yet on disk: try to save; if that fails they stay in the backup.
  const flushBeforeLeaving = async () => {
    if (status === 'saved' || status === 'loading' || status === 'conflict') return
    await saveNow()
    const flow = latest.current
    if (flow && statusRef.current !== 'saved') writeBackup(flow.name, rev.current, flow.blocks, flow.wires)
  }

  const switchFlow = async (flowName: string) => {
    if (flowName === name) return
    await flushBeforeLeaving()
    clearTimeout(saveTimer.current)
    await open(flowName).catch(() => {})
  }

  const newFlow = async () => {
    await flushBeforeLeaving()
    try {
      const flow = await createFlow()
      setFlows(await listFlows())
      clearTimeout(saveTimer.current)
      await open(flow.name)
    } catch (e) {
      setStatus((e as FlowError).kind === 'offline' ? 'offline' : 'error')
      setError((e as Error).message)
    }
  }

  // A block's ports can depend on its settings (e.g. a Join's input count); drop wires whose port is gone.
  useEffect(() => {
    const has = (ref: PortRef, kind: 'inlets' | 'outlets') => {
      const b = blocks.find((x) => x.id === ref.block)
      return Boolean(b && portsOf(b)[kind].some((p) => p.id === ref.port))
    }
    setWires((ws) => {
      const kept = ws.filter((w) => has(w.from, 'outlets') && has(w.to, 'inlets'))
      return kept.length === ws.length ? ws : kept
    })
  }, [blocks])

  // ---------- blocks ----------

  /** Props a block's `prepare` adds before it's placed (e.g. a new Storage's file). */
  const prepared = async (type: string, props: BlockProps, reason: 'add' | 'duplicate'): Promise<BlockProps> => {
    const prepare = blockByType[type].prepare
    if (!prepare) return props
    try {
      return { ...props, ...((await prepare(props, reason)) ?? {}) } as BlockProps
    } catch (e) {
      console.warn(`[flow] ${type}: couldn't prepare the new block`, e)
      return props
    }
  }

  const add = async (type: string, x: number, y: number, preset: Partial<BlockProps> = {}) => {
    const def = blockByType[type]
    const props = await prepared(type, { ...def.defaultProps, ...preset } as BlockProps, 'add')
    const block: BlockInstance = { id: newId(), type, props, x: snap(x), y: snap(y) }
    setBlocks((bs) => [...bs, block])
    select(block.id)
  }

  const moveTo = (id: string, x: number, y: number) =>
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, x: snap(x), y: snap(y) } : b)))

  const select = (id: string) => {
    setSelectedId(id)
    setSelectedWireId(null)
  }

  const update = (id: string, props: Partial<BlockProps>) =>
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, props: { ...b.props, ...props } as BlockProps } : b)))

  const duplicate = async (id: string) => {
    const src = blocks.find((b) => b.id === id)
    if (!src) return
    // A copy hasn't received anything yet: drop what the original learned from its own data.
    const learned = blockByType[src.type].learnedReset ?? {}
    const props = await prepared(src.type, { ...src.props, ...learned } as BlockProps, 'duplicate')
    const copy = { ...src, id: newId(), props, x: src.x + 32, y: src.y + 32 }
    setBlocks((bs) => [...bs, copy])
    select(copy.id)
  }

  const remove = (id: string) => {
    setBlocks((bs) => bs.filter((b) => b.id !== id))
    setWires((ws) => ws.filter((w) => w.from.block !== id && w.to.block !== id))
    setSelectedId((s) => (s === id ? null : s))
  }

  const clear = () => {
    setBlocks([])
    setWires([])
    setSelectedId(null)
    setSelectedWireId(null)
  }

  // ---------- wires ----------

  /** Wire an outlet to an inlet — only if their data types fit (returns whether it connected). */
  const connect = (from: PortRef, to: PortRef): boolean => {
    if (from.block === to.block) return false
    if (!wireFits(blocks, { from, to })) return false
    setWires((ws) =>
      ws.some((w) => w.from.block === from.block && w.from.port === from.port && w.to.block === to.block && w.to.port === to.port)
        ? ws
        : [...ws, { id: newId(), from, to }],
    )
    relearn(to.block, from.block)
    return true
  }

  /**
   * A block's inputs changed: forget what it learned from the old source, then (if given) learn from what
   * the new source already holds. E.g. a Get connected to a message box showing info lists that box's fields.
   */
  const relearn = (blockId: string, newSource?: string) => {
    const target = blocks.find((b) => b.id === blockId)
    const def = target && blockByType[target.type]
    if (!target || !def?.learnedReset) return
    const source = newSource ? blocks.find((b) => b.id === newSource) : undefined
    const primed = source && def.primeFrom ? def.primeFrom({ ...target.props, ...def.learnedReset }, source) : null
    update(blockId, { ...def.learnedReset, ...(primed ?? {}) })
  }

  const disconnect = (wireId: string) => {
    const gone = wires.find((w) => w.id === wireId)
    if (gone) relearn(gone.to.block)
    setWires((ws) => ws.filter((w) => w.id !== wireId))
    setSelectedWireId((s) => (s === wireId ? null : s))
  }

  const selectWire = (wireId: string | null) => {
    setSelectedWireId(wireId)
    if (wireId) setSelectedId(null)
  }

  return {
    flows,
    name,
    status,
    error,
    switchFlow,
    newFlow,
    saveNow,
    reloadFromDisk,
    blocks,
    wires,
    view,
    setView,
    selectedId,
    setSelectedId,
    selectedWireId,
    selectWire,
    select,
    add,
    moveTo,
    update,
    duplicate,
    remove,
    clear,
    connect,
    disconnect,
  }
}

export type FlowState = ReturnType<typeof useFlow>
