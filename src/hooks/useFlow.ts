import { useCallback, useEffect, useRef, useState } from 'react'
import { blockByType } from '../blocks/registry'
import type { BlockInstance, BlockProps, PortRef, Wire } from '../blocks/types'
import { patch, type Snapshot, type Step } from '../core/history'
import { PAGE_W, pageOf, placeDocked, slotById } from '../core/pageLayout'
import { compatible } from '../core/dataTypes'
import { findPort, portsOf, wireFits } from '../core/ports'

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

/** Undo steps kept per flow, and how close together edits with the same key must be to merge. */
const HISTORY_LIMIT = 200
const MERGE_MS = 1000

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
  // Permanent blocks (the Page) are in every flow: add any that's missing, to the right of everything else.
  for (const def of Object.values(blockByType).filter((d) => d.permanent && !blocks.some((b) => b.type === d.type))) {
    const right = blocks.length ? Math.max(...blocks.map((b) => b.x)) + 560 : 600
    const top = blocks.length ? Math.min(...blocks.map((b) => b.y)) : 0
    blocks.push({ id: def.type, type: def.type, props: { ...def.defaultProps }, x: right, y: top })
  }
  // Page boxes: a fixed widget (the token selector) is always in its box; any other docked block must be
  // dockable, in a box that exists, and alone there.
  const taken = new Set<string>()
  for (const b of blocks) {
    const def = blockByType[b.type]
    if (def.dockedIn) b.dock = { slot: def.dockedIn }
  }
  for (const b of blocks) {
    if (!b.dock) continue
    const def = blockByType[b.type]
    const ok = slotById(b.dock.slot) && (def.dockedIn === b.dock.slot || (def.Widget && !taken.has(b.dock.slot) && b.dock.slot !== 'selector'))
    if (ok) taken.add(b.dock.slot)
    else delete b.dock
  }
  // Ports that moved to another block (the Page's token list → the token selector): their saved settings follow.
  for (const b of blocks) {
    const moved = blockByType[b.type].movedPorts
    if (!moved) continue
    for (const targetType of new Set(Object.values(moved))) {
      const target = blocks.find((x) => x.id === targetType)
      if (!target) continue
      for (const k of Object.keys(blockByType[targetType].defaultProps)) {
        if (b.props[k] !== undefined && !target.props[k]) target.props = { ...target.props, [k]: b.props[k] }
      }
    }
  }
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
    // A port that moved to another block (see movedPorts) takes its wires along.
    const movedTo = into && blockByType[into.type].movedPorts?.[original.to.port]
    const movedFrom = outOf && blockByType[outOf.type].movedPorts?.[original.from.port]
    const w = {
      from: renamedOut ? { ...original.from, port: renamedOut } : movedFrom ? { ...original.from, block: movedFrom } : original.from,
      to: renamed ? { ...original.to, port: renamed } : movedTo ? { ...original.to, block: movedTo } : original.to,
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
  // A block that learns from what's wired in (the Page's token list, a Get's fields) and has learned nothing
  // yet: let it read a source that already holds data (a message box showing a list) — e.g. wired before
  // this was possible, or after the list was saved.
  const primed = blocks.map((b) => {
    const def = blockByType[b.type]
    if (!def.primeFrom || !def.learnedReset) return b
    const empty = Object.keys(def.learnedReset).every((k) => !b.props[k])
    if (!empty) return b
    for (const w of wires.filter((x) => x.to.block === b.id)) {
      const source = byId.get(w.from.block)
      const learned = source && def.primeFrom(b.props, source)
      if (learned) return { ...b, props: { ...b.props, ...learned } as BlockProps }
    }
    return b
  })
  return { ...flow, blocks: primed, wires }
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

  // ---------- undo / redo ----------
  // Only edits made by you are recorded (add, move, delete, wire, settings…) — not data arriving at blocks.
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const wiresRef = useRef(wires)
  wiresRef.current = wires
  const undoStack = useRef<Step[]>([])
  const redoStack = useRef<Step[]>([])
  /** The flow just before an edit that's being made; the step is stored once React has applied it. */
  const pending = useRef<{ before: Snapshot; key?: string } | null>(null)

  /** Call right before an edit's state updates. `key`: edits with the same key within a second merge. */
  const record = (key?: string) => {
    if (pending.current) return
    const before = { blocks: blocksRef.current, wires: wiresRef.current }
    pending.current = { before, key }
    // An edit that changed nothing (e.g. a wire that already existed) leaves no step behind.
    setTimeout(() => {
      const p = pending.current
      if (p && p.before.blocks === blocksRef.current && p.before.wires === wiresRef.current) pending.current = null
    }, 100)
  }

  useEffect(() => {
    const p = pending.current
    if (!p) return
    pending.current = null
    const after = { blocks, wires }
    const top = undoStack.current[undoStack.current.length - 1]
    const now = Date.now()
    if (p.key && top?.key === p.key && now - top.at < MERGE_MS) {
      top.after = after
      top.at = now
    } else {
      undoStack.current.push({ before: p.before, after, key: p.key, at: now })
      if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift()
    }
    redoStack.current = []
  }, [blocks, wires])

  const travel = (fromStack: typeof undoStack, toStack: typeof undoStack, direction: 'undo' | 'redo') => {
    const step = fromStack.current.pop()
    if (!step) return false
    pending.current = null
    const current = { blocks: blocksRef.current, wires: wiresRef.current }
    const next = direction === 'undo' ? patch(current, step.after, step.before) : patch(current, step.before, step.after)
    toStack.current.push({ ...step, key: undefined }) // never merge an edit into an undone / redone step
    setBlocks(next.blocks)
    setWires(next.wires)
    setSelectedId((s) => (s && next.blocks.some((b) => b.id === s) ? s : null))
    setSelectedWireId((s) => (s && next.wires.some((w) => w.id === s) ? s : null))
    return true
  }
  const undo = () => travel(undoStack, redoStack, 'undo')
  const redo = () => travel(redoStack, undoStack, 'redo')

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
      // Undo history belongs to one flow.
      undoStack.current = []
      redoStack.current = []
      pending.current = null
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
    record()
    setBlocks((bs) => [...bs, block])
    select(block.id)
  }

  /** Move a block. Dragging a docked widget takes it out of its Page box; a fixed one (the token selector) stays. */
  const moveTo = (id: string, x: number, y: number) => {
    const target = blocksRef.current.find((b) => b.id === id)
    if (!target || blockByType[target.type].dockedIn) return
    record(`move:${id}`) // one drag = one step
    setBlocks((bs) =>
      bs.map((b) => {
        if (b.id !== id) return b
        const { dock: _undocked, ...rest } = b
        return { ...rest, x: snap(x), y: snap(y) }
      }),
    )
  }

  /** Put a block into a Page box (dropped there at the end of a drag — the same undo step as the drag). */
  const dock = (id: string, slot: string) => {
    record(`move:${id}`)
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, dock: { slot } } : b)))
  }

  /** Take a widget out of the Page, placing it just right of the Page. */
  const undock = (id: string) => {
    const page = pageOf(blocksRef.current)
    record()
    setBlocks((bs) =>
      bs.map((b) => {
        if (b.id !== id) return b
        const { dock: _undocked, ...rest } = b
        return page ? { ...rest, x: snap(page.x + PAGE_W + 80), y: snap(page.y + 40) } : rest
      }),
    )
  }

  const select = (id: string) => {
    setSelectedId(id)
    setSelectedWireId(null)
  }

  /** Change a block's props without an undo step — what blocks do with data they receive. */
  const update = (id: string, props: Partial<BlockProps>) =>
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, props: { ...b.props, ...props } as BlockProps } : b)))

  /** A settings change made in the right panel: undoable (typing in one field is one step). */
  const edit = (id: string, props: Partial<BlockProps>) => {
    record(`edit:${id}:${Object.keys(props).sort().join(',')}`)
    update(id, props)
  }

  const duplicate = async (id: string) => {
    const src = blocks.find((b) => b.id === id)
    if (!src || blockByType[src.type].permanent) return
    // A copy hasn't received anything yet: drop what the original learned from its own data.
    const learned = blockByType[src.type].learnedReset ?? {}
    const props = await prepared(src.type, { ...src.props, ...learned } as BlockProps, 'duplicate')
    // A copy of a docked widget goes next to the Page box it came from, not into the same box.
    const { dock: _box, ...placed } = placeDocked(blocks).find((b) => b.id === id) ?? src
    const copy = { ...placed, id: newId(), props, x: placed.x + 32, y: placed.y + 32 }
    record()
    setBlocks((bs) => [...bs, copy])
    select(copy.id)
  }

  const isPermanent = (id: string) => {
    const b = blocks.find((x) => x.id === id)
    return Boolean(b && blockByType[b.type]?.permanent)
  }

  const remove = (id: string) => {
    if (isPermanent(id)) return
    record()
    setBlocks((bs) => bs.filter((b) => b.id !== id))
    setWires((ws) => ws.filter((w) => w.from.block !== id && w.to.block !== id))
    setSelectedId((s) => (s === id ? null : s))
  }

  /** Remove every block and wire — except permanent blocks (the Page), which stay, unwired. */
  const clear = () => {
    record()
    setBlocks((bs) => bs.filter((b) => blockByType[b.type]?.permanent))
    setWires([])
    setSelectedId(null)
    setSelectedWireId(null)
  }

  // ---------- wires ----------

  /** Wire an outlet to an inlet — only if their data types fit (returns whether it connected). */
  const connect = (from: PortRef, to: PortRef): boolean => {
    if (from.block === to.block) return false
    if (!wireFits(blocks, { from, to })) return false
    record()
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
    record()
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
    edit,
    undo,
    redo,
    dock,
    undock,
    duplicate,
    remove,
    clear,
    connect,
    disconnect,
  }
}

export type FlowState = ReturnType<typeof useFlow>
