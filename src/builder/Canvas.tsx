import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent, type RefObject, type SetStateAction } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { blockByType } from '../blocks/registry'
import type { BlockContext, BlockInstance, Port, PortRef, Wire } from '../blocks/types'
import { GRID, type View } from './useFlow'

const MIN_ZOOM = 0.1
const MAX_ZOOM = 3
const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/** Movement (screen px) before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3

/** Presses starting on these keep their normal behaviour instead of dragging the block. */
const INTERACTIVE = 'a, button, input, select, textarea, label'

/** Port size in world px (Max-style flat tabs on the block's top and bottom edges). */
const PORT_W = 16
const PORT_H = 7

type PortKind = 'inlet' | 'outlet'
type Size = { w: number; h: number }

interface Props {
  blocks: BlockInstance[]
  wires: Wire[]
  activeWires: Set<string>
  editing: boolean
  view: View
  setView: Dispatch<SetStateAction<View>>
  viewportRef: RefObject<HTMLDivElement>
  selectedId: string | null
  selectedWireId: string | null
  makeCtx: (id: string) => BlockContext
  onSelect: (id: string) => void
  onSelectWire: (id: string | null) => void
  onDeselect: () => void
  onMove: (id: string, x: number, y: number) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
  onConnect: (from: PortRef, to: PortRef) => void
}

function zoomAround(v: View, sx: number, sy: number, nextZoom: number): View {
  const zoom = clamp(nextZoom)
  const k = zoom / v.zoom
  return { zoom, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k }
}

/** Horizontal offset of port i of n inside a block of width w: first at the left edge, last at the right. */
const portOffset = (i: number, n: number, w: number) => (n <= 1 ? 0 : (i / (n - 1)) * (w - PORT_W))

/** World position of a port's connection point. */
function portPoint(block: BlockInstance, size: Size, kind: PortKind, portId: string) {
  const def = blockByType[block.type]
  const ports = (kind === 'inlet' ? def.inlets : def.outlets) ?? []
  const i = Math.max(0, ports.findIndex((p) => p.id === portId))
  return {
    x: block.x + portOffset(i, ports.length, size.w) + PORT_W / 2,
    y: kind === 'inlet' ? block.y : block.y + size.h,
  }
}

/** Patch cord: leaves an outlet downward, enters an inlet from above. */
function cordPath(a: { x: number; y: number }, b: { x: number; y: number }) {
  const bend = Math.max(30, Math.abs(b.y - a.y) / 2)
  return `M${a.x},${a.y} C${a.x},${a.y + bend} ${b.x},${b.y - bend} ${b.x},${b.y}`
}

function useSpaceHeld() {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const typing = () => document.activeElement?.matches('input, textarea, select')
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !typing()) {
        e.preventDefault()
        setHeld(true)
      }
    }
    const up = (e: KeyboardEvent) => e.code === 'Space' && setHeld(false)
    const blur = () => setHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
  return held
}

function Ports({
  block,
  kind,
  ports,
  editing,
  connected,
  onPortDown,
}: {
  block: BlockInstance
  kind: PortKind
  ports: Port[]
  editing: boolean
  connected: Set<string>
  onPortDown: (ref: PortRef, kind: PortKind, e: PointerEvent) => void
}) {
  return (
    <>
      {ports.map((p, i) => (
        <span
          key={p.id}
          data-port={`${block.id}|${p.id}|${kind}`}
          className={`port ${kind}${connected.has(`${kind}:${p.id}`) ? ' connected' : ''}`}
          style={{
            left: ports.length <= 1 ? 0 : `calc((100% - ${PORT_W}px) * ${i / (ports.length - 1)})`,
            width: PORT_W,
            height: PORT_H,
          }}
          title={`${kind === 'inlet' ? 'Inlet' : 'Outlet'} · ${p.label}`}
          onPointerDown={(e) => {
            if (!editing || e.button !== 0) return
            e.stopPropagation()
            e.preventDefault()
            onPortDown({ block: block.id, port: p.id }, kind, e)
          }}
        />
      ))}
    </>
  )
}

function BlockFrame({
  block,
  editing,
  zoom,
  spaceHeld,
  selected,
  connected,
  ctx,
  onSelect,
  onMove,
  onDuplicate,
  onRemove,
  onSize,
  onPortDown,
}: {
  block: BlockInstance
  editing: boolean
  zoom: number
  spaceHeld: boolean
  selected: boolean
  connected: Set<string>
  ctx: BlockContext
  onSelect: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
  onSize: (id: string, size: Size) => void
  onPortDown: (ref: PortRef, kind: PortKind, e: PointerEvent) => void
}) {
  const def = blockByType[block.type]
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number; moved: boolean; pointer: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  // Wires attach to the block's edges, so the canvas needs its rendered size.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => onSize(block.id, { w: el.offsetWidth, h: el.offsetHeight })
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [block.id, onSize])

  const onPointerDown = (e: PointerEvent) => {
    // Middle button or space+drag pans the canvas, even over a block.
    if (!editing || e.button !== 0 || spaceHeld) return
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return
    e.stopPropagation()
    drag.current = { sx: e.clientX, sy: e.clientY, bx: block.x, by: block.y, moved: false, pointer: e.pointerId }
    onSelect(block.id)
  }

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (!d.moved) {
      // Capture only once it's a real drag, so a plain click still reaches the block's content
      // (e.g. a message box's click-to-send).
      try {
        e.currentTarget.setPointerCapture(d.pointer)
      } catch {
        /* pointer already released */
      }
      setDragging(true)
    }
    d.moved = true
    onMove(block.id, d.bx + dx / zoom, d.by + dy / zoom)
  }

  const endDrag = () => {
    drag.current = null
    setDragging(false)
  }

  return (
    <div
      ref={ref}
      data-block-id={block.id}
      className={`block-frame${editing ? ' editable' : ''}${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      style={{ left: block.x, top: block.y, width: def.width ?? 'max-content' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {editing && (
        <div className="block-toolbar">
          <span className="block-label">⠿ {def.label}</span>
          <span className="toolbar-actions">
            <button onClick={() => onDuplicate(block.id)} title="Duplicate">⧉</button>
            <button onClick={() => onRemove(block.id)} title="Delete">✕</button>
          </span>
        </div>
      )}
      <def.Render props={block.props} ctx={ctx} />
      <Ports block={block} kind="inlet" ports={def.inlets ?? []} editing={editing} connected={connected} onPortDown={onPortDown} />
      <Ports block={block} kind="outlet" ports={def.outlets ?? []} editing={editing} connected={connected} onPortDown={onPortDown} />
    </div>
  )
}

export function Canvas({
  blocks,
  wires,
  activeWires,
  editing,
  view,
  setView,
  viewportRef,
  selectedId,
  selectedWireId,
  makeCtx,
  onSelect,
  onSelectWire,
  onDeselect,
  onConnect,
  ...actions
}: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: 'canvas' })
  const worldRef = useRef<HTMLDivElement>(null)
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null)
  const [panning, setPanning] = useState(false)
  const spaceHeld = useSpaceHeld()
  const [sizes, setSizes] = useState<Record<string, Size>>({})
  const [wiring, setWiring] = useState<{ from: PortRef; kind: PortKind; x: number; y: number } | null>(null)
  const wiringRef = useRef(wiring)
  wiringRef.current = wiring
  const onConnectRef = useRef(onConnect)
  onConnectRef.current = onConnect

  const onSize = useCallback(
    (id: string, size: Size) =>
      setSizes((s) => (s[id]?.w === size.w && s[id]?.h === size.h ? s : { ...s, [id]: size })),
    [],
  )

  const viewRef = useRef(view)
  viewRef.current = view
  const toWorld = (clientX: number, clientY: number) => {
    const r = viewportRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }
  }

  // Drag from a port to draw a new wire; release over a port of the opposite kind to connect.
  const onPortDown = (from: PortRef, kind: PortKind, e: PointerEvent) => {
    setWiring({ from, kind, ...toWorld(e.clientX, e.clientY) })
  }

  useEffect(() => {
    if (!wiring) return
    const move = (e: globalThis.PointerEvent) => setWiring((w) => w && { ...w, ...toWorld(e.clientX, e.clientY) })
    const up = (e: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-port]')
      const w = wiringRef.current
      if (target && w) {
        const [block, port, kind] = target.dataset.port!.split('|')
        if (kind !== w.kind && block !== w.from.block) {
          const other = { block, port }
          if (w.kind === 'outlet') onConnectRef.current(w.from, other)
          else onConnectRef.current(other, w.from)
        }
      }
      setWiring(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // Re-subscribe only when a wiring drag starts or ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(wiring)])

  // Wheel zooms around the cursor; panning is done by dragging.
  // Registered manually because React's onWheel is passive and can't preventDefault.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      // Normalise line/page deltas to pixels so every mouse zooms at the same speed.
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1)
      // Trackpad pinch arrives as ctrl+wheel with small deltas, so it gets a stronger factor.
      const speed = e.ctrlKey ? 0.01 : 0.0015
      setView((v) => zoomAround(v, e.clientX - r.left, e.clientY - r.top, v.zoom * Math.exp(-dy * speed)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [viewportRef, setView])

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    // Let links and controls inside blocks work, unless explicitly panning.
    if (e.button === 0 && !spaceHeld && (e.target as HTMLElement).closest(INTERACTIVE)) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already released — panning still works while over the canvas */
    }
    pan.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false }
  }

  const onPointerMove = (e: PointerEvent) => {
    const p = pan.current
    if (!p) return
    const dx = e.clientX - p.sx
    const dy = e.clientY - p.sy
    if (!p.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (!p.moved) setPanning(true)
    p.moved = true
    setView((v) => ({ ...v, x: p.vx + dx, y: p.vy + dy }))
  }

  const onPointerUp = () => {
    // A click (no drag) on empty canvas clears the selection.
    if (pan.current && !pan.current.moved) onDeselect()
    pan.current = null
    setPanning(false)
  }

  const zoomBy = (factor: number) => {
    const r = viewportRef.current!.getBoundingClientRect()
    setView((v) => zoomAround(v, r.width / 2, r.height / 2, v.zoom * factor))
  }

  const fit = () => {
    const vp = viewportRef.current!.getBoundingClientRect()
    const frames = worldRef.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? []
    if (frames.length === 0) return setView({ x: 0, y: 0, zoom: 1 })
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    frames.forEach((f) => {
      // offset* are layout sizes in world px — unaffected by the zoom transform.
      minX = Math.min(minX, f.offsetLeft)
      minY = Math.min(minY, f.offsetTop)
      maxX = Math.max(maxX, f.offsetLeft + f.offsetWidth)
      maxY = Math.max(maxY, f.offsetTop + f.offsetHeight)
    })
    const pad = 64
    const zoom = clamp(Math.min((vp.width - pad * 2) / (maxX - minX), (vp.height - pad * 2) / (maxY - minY), 1))
    setView({
      zoom,
      x: (vp.width - (maxX - minX) * zoom) / 2 - minX * zoom,
      y: (vp.height - (maxY - minY) * zoom) / 2 - minY * zoom,
    })
  }

  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && e.code === 'Digit1' && !document.activeElement?.matches('input, textarea, select')) fitRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const byId = new Map(blocks.map((b) => [b.id, b]))
  const connectedPorts = (blockId: string) => {
    const set = new Set<string>()
    for (const w of wires) {
      if (w.from.block === blockId) set.add(`outlet:${w.from.port}`)
      if (w.to.block === blockId) set.add(`inlet:${w.to.port}`)
    }
    return set
  }

  const wirePaths = wires.flatMap((w) => {
    const a = byId.get(w.from.block)
    const b = byId.get(w.to.block)
    if (!a || !b || !sizes[a.id] || !sizes[b.id]) return []
    return [{ wire: w, d: cordPath(portPoint(a, sizes[a.id], 'outlet', w.from.port), portPoint(b, sizes[b.id], 'inlet', w.to.port)) }]
  })

  let draft: string | null = null
  if (wiring) {
    const src = byId.get(wiring.from.block)
    if (src && sizes[src.id]) {
      const p = portPoint(src, sizes[src.id], wiring.kind, wiring.from.port)
      draft = wiring.kind === 'outlet' ? cordPath(p, wiring) : cordPath(wiring, p)
    }
  }

  const grid = GRID * 3 * view.zoom

  return (
    <div
      ref={(el) => {
        setNodeRef(el)
        ;(viewportRef as { current: HTMLDivElement | null }).current = el
      }}
      className={`canvas${editing ? '' : ' preview'}${isOver ? ' over' : ''}${panning ? ' panning' : spaceHeld ? ' can-pan' : ''}${
        wiring ? ` wiring from-${wiring.kind}` : ''
      }`}
      style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div ref={worldRef} className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        <svg className="wires">
          {wirePaths.map(({ wire, d }) => (
            <g
              key={wire.id}
              className={`wire${selectedWireId === wire.id ? ' selected' : ''}${activeWires.has(wire.id) ? ' active' : ''}`}
              onPointerDown={(e) => {
                if (!editing) return
                e.stopPropagation()
                onSelectWire(wire.id)
              }}
            >
              <path className="wire-hit" d={d} />
              <path className="wire-line" d={d} />
            </g>
          ))}
          {draft && <path className="wire-line draft" d={draft} />}
        </svg>

        {blocks.map((b) => (
          <BlockFrame
            key={b.id}
            block={b}
            editing={editing}
            zoom={view.zoom}
            spaceHeld={spaceHeld}
            selected={editing && selectedId === b.id}
            connected={connectedPorts(b.id)}
            ctx={makeCtx(b.id)}
            onSelect={onSelect}
            onSize={onSize}
            onPortDown={onPortDown}
            {...actions}
          />
        ))}
      </div>

      {blocks.length === 0 && editing && (
        <div className="empty">
          <strong>This flow is empty</strong>
          <span>Drag a block from the left to start building</span>
        </div>
      )}

      <div className="zoom-controls" onPointerDown={(e) => e.stopPropagation()}>
        <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out">−</button>
        <button className="zoom-level" onClick={() => setView((v) => zoomAround(v, 0, 0, 1))} title="Reset to 100%">
          {Math.round(view.zoom * 100)}%
        </button>
        <button onClick={() => zoomBy(1.2)} title="Zoom in">+</button>
        <button onClick={fit} title="Fit all blocks (Shift+1)">Fit</button>
      </div>
      {editing && (
        <div className="canvas-hint">
          Drag outlet → inlet to wire · click a wire + Delete to cut · scroll to zoom · drag empty space to pan
        </div>
      )}
    </div>
  )
}
