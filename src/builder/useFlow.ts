import { useCallback, useEffect, useRef, useState } from 'react'
import { blockByType } from '../blocks/registry'
import type { BlockInstance, BlockProps, PortRef, Wire } from '../blocks/types'

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

export type SaveStatus = 'loading' | 'saved' | 'unsaved' | 'saving' | 'error'

export const GRID = 8
export const snap = (n: number) => Math.round(n / GRID) * GRID

const CURRENT_FLOW_KEY = 'dex-builder:current-flow'
/** Pan/zoom is a per-browser convenience, not part of the flow, so it never marks the flow unsaved. */
const viewKey = (flow: string) => `dex-builder:view:${flow}`
const SAVE_DEBOUNCE_MS = 500
const BLANK_VIEW: View = { x: 0, y: 0, zoom: 1 }

const newId = () => Math.random().toString(36).slice(2, 10)

// ---------- flow file API (served by vite-plugin-flows) ----------

/** Identifies this tab in flow-server logs (DEBUG_FLOWS=1), to spot two tabs editing one flow. */
const CLIENT_ID = Math.random().toString(36).slice(2, 6)

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/flows${path}`, {
    ...init,
    headers: { 'x-flow-client': CLIENT_ID, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Flow server responded ${res.status} — flow files need the dev server (npm run dev)`)
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
function sanitize(flow: FlowFile): FlowFile {
  const blocks = (flow.blocks ?? []).filter((b) => blockByType[b.type])
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const hasPort = (ref: PortRef, kind: 'inlets' | 'outlets') => {
    const b = byId.get(ref.block)
    return Boolean(b && blockByType[b.type][kind]?.some((p) => p.id === ref.port))
  }
  const wires = (flow.wires ?? []).filter((w) => hasPort(w.from, 'outlets') && hasPort(w.to, 'inlets'))
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
      skipSave.current = true
      setName(flowName)
      setBlocks(flow.blocks)
      setWires(flow.wires)
      let saved: View | null = null
      try {
        saved = JSON.parse(localStorage.getItem(viewKey(flowName)) || 'null')
      } catch {
        /* start from the file's old view, or the origin */
      }
      setView(saved ?? flow.view ?? BLANK_VIEW)
      setSelectedId(null)
      setSelectedWireId(null)
      setStatus('saved')
      setError(null)
      try {
        localStorage.setItem(CURRENT_FLOW_KEY, flowName)
      } catch {
        /* only affects which flow opens next time */
      }
    } catch (e) {
      setStatus('error')
      setError((e as Error).message)
    }
  }, [])

  // First load: pick the last-used flow, or create flow_1 (from the old localStorage page if there is one).
  useEffect(() => {
    ;(async () => {
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
        await open(last && names.includes(last) ? last : names[0])
      } catch (e) {
        setStatus('error')
        setError((e as Error).message)
      }
    })()
  }, [open])

  const saveNow = useCallback(async () => {
    clearTimeout(saveTimer.current)
    const flow = latest.current
    if (!flow || conflicted.current) return
    setStatus('saving')
    try {
      rev.current = (await writeFlow(flow, rev.current)).rev
      setStatus('saved')
      setError(null)
    } catch (e) {
      if ((e as Error).message.includes('changed elsewhere')) conflicted.current = true
      setStatus('error')
      setError((e as Error).message)
    }
  }, [])

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

  const switchFlow = async (flowName: string) => {
    if (flowName === name) return
    if (status === 'unsaved') await saveNow()
    await open(flowName)
  }

  const newFlow = async () => {
    if (status === 'unsaved') await saveNow()
    try {
      const flow = await createFlow()
      setFlows(await listFlows())
      await open(flow.name)
    } catch (e) {
      setStatus('error')
      setError((e as Error).message)
    }
  }

  // ---------- blocks ----------

  const add = (type: string, x: number, y: number) => {
    const def = blockByType[type]
    const block: BlockInstance = { id: newId(), type, props: { ...def.defaultProps }, x: snap(x), y: snap(y) }
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

  const duplicate = (id: string) => {
    const src = blocks.find((b) => b.id === id)
    if (!src) return
    const copy = { ...src, id: newId(), props: { ...src.props }, x: src.x + 32, y: src.y + 32 }
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

  const connect = (from: PortRef, to: PortRef) => {
    if (from.block === to.block) return
    setWires((ws) =>
      ws.some((w) => w.from.block === from.block && w.from.port === from.port && w.to.block === to.block && w.to.port === to.port)
        ? ws
        : [...ws, { id: newId(), from, to }],
    )
  }

  const disconnect = (wireId: string) => {
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
