import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent, type RefObject, type SetStateAction } from 'react'
import { blockByType } from '../blocks/registry'
import type { BlockContext, BlockInstance, Port, PortRef, Wire } from '../blocks/types'
import { GRID, type View } from '../hooks/useFlow'
import { compatible, describeTypes, portBackground, portColor } from '../core/dataTypes'
import { findPort, portsOf } from '../core/ports'
import { lastSent, previewLines, timeOf } from '../core/lastSent'
import { freeSlotAt, pageOf, placeDocked, slotById, type Slot } from '../core/pageLayout'

/** Can this block go into a Page box? Blocks with a widget look (message box, dict…), except fixed ones. */
const canDock = (b: BlockInstance) => Boolean(blockByType[b.type]?.Widget) && !blockByType[b.type]?.dockedIn

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
  /** A palette item is being dragged over the canvas. */
  dropTarget: boolean
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
  onDisconnect: (wireId: string) => void
  /** Dropped into an empty Page box. */
  onDock: (id: string, slot: string) => void
  onUndock: (id: string) => void
}

type MenuTarget = { block: string } | { wire: string }
type MenuItem = { label: string; hint?: string; danger?: boolean; run: () => void } | 'separator'

/** Right-click menu, positioned in screen space over the canvas. */
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('wheel', onClose, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('wheel', onClose, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <div ref={ref} className="ctx-menu" style={{ left: x, top: y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={item.danger ? 'danger' : ''}
            onClick={() => {
              item.run()
              onClose()
            }}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  )
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
  const resolved = portsOf(block)
  const ports = kind === 'inlet' ? resolved.inlets : resolved.outlets
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
  wiringSource,
  onPortDown,
}: {
  block: BlockInstance
  kind: PortKind
  ports: Port[]
  editing: boolean
  connected: Set<string>
  /** The port a wire is being dragged from, if any — ports that can't take it are dimmed. */
  wiringSource: { kind: PortKind; port: Port | undefined; block: string } | null
  onPortDown: (ref: PortRef, kind: PortKind, e: PointerEvent) => void
}) {
  const fitClass = (p: Port) => {
    if (!wiringSource) return ''
    if (wiringSource.kind === kind || wiringSource.block === block.id) return ' dim'
    const fits = kind === 'inlet' ? compatible(wiringSource.port, p) : compatible(p, wiringSource.port)
    return fits ? ' can-connect' : ' dim'
  }
  return (
    <>
      {ports.map((p, i) => (
        <span
          key={p.id}
          data-port={`${block.id}|${p.id}|${kind}`}
          className={`port ${kind}${p.error ? ' error' : ''}${connected.has(`${kind}:${p.id}`) ? ' connected' : ''}${fitClass(p)}`}
          style={{
            left: ports.length <= 1 ? 0 : `calc((100% - ${PORT_W}px) * ${i / (ports.length - 1)})`,
            width: PORT_W,
            height: PORT_H,
            background: portBackground(p),
            color: portColor(p),
          }}
          // Shown instantly by the canvas's own tooltip (a native title waits ~1s).
          data-tip={`${kind === 'inlet' ? 'inlet' : 'outlet'}|${p.id}|${p.label}|${p.error ? 'error' : ''}|${describeTypes(p)}`}
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
  onMenu,
  onSize,
  onPortDown,
  wiringSource,
  slot,
  onDragAt,
}: {
  /** The Page box this block is docked in: it's drawn there, box-sized, as its widget. */
  slot?: Slot
  /** While dragging (and once on release): where the pointer is, so a Page box under it can light up / take it. */
  onDragAt: (id: string, clientX: number, clientY: number, done: boolean) => void
  block: BlockInstance
  editing: boolean
  zoom: number
  spaceHeld: boolean
  selected: boolean
  connected: Set<string>
  ctx: BlockContext
  onSelect: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onMenu: (target: { block: string }, clientX: number, clientY: number) => void
  onSize: (id: string, size: Size) => void
  onPortDown: (ref: PortRef, kind: PortKind, e: PointerEvent) => void
  wiringSource: { kind: PortKind; port: Port | undefined; block: string } | null
}) {
  const def = blockByType[block.type]
  const ports = portsOf(block)
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  // The drag listeners live on window, so they read the latest zoom / onMove through refs.
  const latest = useRef({ zoom, onMove, onDragAt })
  latest.current = { zoom, onMove, onDragAt }
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])

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

  /**
   * Moving a block. Move/release are tracked on window from the moment of the press, so a fast mouse
   * that leaves a small block (a bang, a message box) before the drag starts can never strand it
   * "stuck" to the cursor. Any move with no button held also ends the drag.
   */
  const onPointerDown = (e: PointerEvent) => {
    // Middle button or space+drag pans the canvas, even over a block.
    if (!editing || e.button !== 0 || spaceHeld) return
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return
    e.stopPropagation()
    stopDrag.current?.()
    onSelect(block.id)
    // A fixed Page widget (the token selector) stays in its box.
    if (def.dockedIn) return

    const start = { x: e.clientX, y: e.clientY, bx: block.x, by: block.y, pointer: e.pointerId }
    let moved = false
    let last = { x: e.clientX, y: e.clientY }

    const move = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== start.pointer) return
      if (ev.buttons === 0) return finish() // released somewhere we didn't hear about
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      if (!moved) setDragging(true)
      moved = true
      const { zoom: z, onMove: mv, onDragAt: at } = latest.current
      mv(block.id, start.bx + dx / z, start.by + dy / z)
      last = { x: ev.clientX, y: ev.clientY }
      at(block.id, ev.clientX, ev.clientY, false)
    }
    const up = (ev: globalThis.PointerEvent) => ev.pointerId === start.pointer && finish()
    const finish = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener('blur', finish)
      stopDrag.current = null
      setDragging(false)
      if (moved) latest.current.onDragAt(block.id, last.x, last.y, true)
      if (moved) {
        // The click that follows a drag must not reach the block (e.g. send a message box).
        const swallow = (ce: MouseEvent) => {
          ce.stopPropagation()
          ce.preventDefault()
        }
        window.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => window.removeEventListener('click', swallow, true), 0)
      }
    }

    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener('blur', finish)
    stopDrag.current = finish
  }

  return (
    <div
      ref={ref}
      data-block-id={block.id}
      className={`block-frame${editing ? ' editable' : ''}${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${slot ? ' docked' : ''}`}
      style={{ left: block.x, top: block.y, width: slot ? slot.w : def.width ?? 'max-content', height: slot?.h }}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onMenu({ block: block.id }, e.clientX, e.clientY)
      }}
    >
      {editing && (
        <div className="block-toolbar">
          <span className="block-label">⠿ {def.label}</span>
        </div>
      )}
      {slot && def.Widget ? <def.Widget props={block.props} ctx={ctx} /> : <def.Render props={block.props} ctx={ctx} />}
      <Ports block={block} kind="inlet" ports={ports.inlets} editing={editing} connected={connected} wiringSource={wiringSource} onPortDown={onPortDown} />
      <Ports block={block} kind="outlet" ports={ports.outlets} editing={editing} connected={connected} wiringSource={wiringSource} onPortDown={onPortDown} />
    </div>
  )
}

/** A port label without its leading one-word name ("info — the market summary" → "The market summary"). */
const tipText = (label: string) => label.replace(/^\S+ — /, '').replace(/^./, (c) => c.toUpperCase())

export function Canvas({
  blocks: rawBlocks,
  wires,
  activeWires,
  editing,
  dropTarget,
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
  onDisconnect,
  onMove,
  onDuplicate,
  onRemove,
  onDock,
  onUndock,
}: Props) {
  // Docked widgets sit in their Page box: their position is the box's, so wires attach there too.
  const blocks = placeDocked(rawBlocks)
  const blocksRef = useRef(rawBlocks)
  blocksRef.current = rawBlocks
  /** The empty Page box a dockable block is being dragged over. */
  const [hoverSlot, setHoverSlot] = useState<Slot | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null)
  const [tip, setTip] = useState<{
    x: number
    y: number
    below: boolean
    kind: string
    id: string
    label: string
    types: string
    error: boolean
    /** For outlets: what came out of it last, and when. */
    last?: { lines: string[]; at: number }
  } | null>(null)

  // Instant port tooltip: one listener for the whole canvas instead of a slow native title per port.
  const onPointerOver = (e: PointerEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]')
    if (!el) return
    const [kind, id, label, error, types] = el.dataset.tip!.split('|')
    const blockId = el.dataset.port?.split('|')[0]
    const sentLast = kind === 'outlet' && blockId ? lastSent(blockId, id) : undefined
    const last = sentLast ? { lines: previewLines(sentLast.msg), at: sentLast.at } : undefined
    const vp = viewportRef.current!.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const below = kind === 'outlet'
    setTip({ x: r.left + r.width / 2 - vp.left, y: (below ? r.bottom : r.top) - vp.top, below, kind, id, label, types, error: error === 'error', last })
  }
  const onPointerOut = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-tip]')) setTip(null)
  }
  const closeMenu = useCallback(() => setMenu(null), [])

  const openMenu = (target: MenuTarget, clientX: number, clientY: number) => {
    if (!editing) return
    const r = viewportRef.current!.getBoundingClientRect()
    if ('block' in target) onSelect(target.block)
    else onSelectWire(target.wire)
    setMenu({ x: clientX - r.left, y: clientY - r.top, target })
  }

  const menuItems = (target: MenuTarget): MenuItem[] => {
    if ('wire' in target) return [{ label: 'Delete wire', hint: '⌫', danger: true, run: () => onDisconnect(target.wire) }]
    const block = blocks.find((b) => b.id === target.block)
    if (!block) return []
    const def = blockByType[block.type]
    const own = (def.menu ?? []).map((m) => ({ label: m.label, run: () => m.run(makeCtx(block.id)) }))
    // A permanent block (the Page) can only be moved.
    if (def.permanent) return own
    const docked = block.dock && !def.dockedIn ? [{ label: 'Take out of the Page', run: () => onUndock(block.id) }] : []
    return [
      ...own,
      ...docked,
      ...(own.length || docked.length ? (['separator'] as const) : []),
      { label: 'Duplicate', run: () => onDuplicate(block.id) },
      { label: 'Delete', hint: '⌫', danger: true, run: () => onRemove(block.id) },
    ]
  }

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

  const onDragAt = (id: string, clientX: number, clientY: number, done: boolean) => {
    const block = blocksRef.current.find((b) => b.id === id)
    const p = toWorld(clientX, clientY)
    const slot = block && canDock(block) ? freeSlotAt(blocksRef.current, p.x, p.y, id) : undefined
    if (done) {
      setHoverSlot(null)
      if (slot) onDock(id, slot.id)
    } else setHoverSlot((s) => (s?.id === slot?.id ? s : slot ?? null))
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
      setTip(null) // ports move when zooming; a tooltip would point at the old spot
      // A scrollable list inside a block (e.g. a message box holding a list) scrolls instead of zooming.
      const scroller = (e.target as HTMLElement).closest<HTMLElement>('.scroll-y')
      if (scroller && !e.ctrlKey) {
        const atTop = scroller.scrollTop <= 0
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
        if (scroller.scrollHeight > scroller.clientHeight && !((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom))) return
      }
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
    // Button already up (release happened outside where we could hear it): stop panning.
    if (e.buttons === 0) {
      pan.current = null
      setPanning(false)
      return
    }
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
  const page = pageOf(blocks)
  const rank = (b: BlockInstance) => (b.type === 'page' ? 0 : b.dock ? 2 : 1)
  const wiringSource = wiring ? { kind: wiring.kind, block: wiring.from.block, port: findPort(blocks, wiring.from, wiring.kind) } : null
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
    const outlet = findPort(blocks, w.from, 'outlet')
    const fits = compatible(outlet, findPort(blocks, w.to, 'inlet'))
    return [{ wire: w, color: portColor(outlet), fits, d: cordPath(portPoint(a, sizes[a.id], 'outlet', w.from.port), portPoint(b, sizes[b.id], 'inlet', w.to.port)) }]
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
      ref={viewportRef}
      className={`canvas${editing ? '' : ' preview'}${dropTarget ? ' over' : ''}${panning ? ' panning' : spaceHeld ? ' can-pan' : ''}${
        wiring ? ` wiring from-${wiring.kind}` : ''
      }`}
      style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      <div ref={worldRef} className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        <svg className="wires">
          {wirePaths.map(({ wire, d, color, fits }) => (
            <g
              key={wire.id}
              className={`wire${fits ? '' : ' mismatch'}${selectedWireId === wire.id ? ' selected' : ''}${activeWires.has(wire.id) ? ' active' : ''}`}
              style={{ '--wire': color } as React.CSSProperties}
              onPointerDown={(e) => {
                if (!editing || e.button !== 0) return
                e.stopPropagation()
                onSelectWire(wire.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                openMenu({ wire: wire.id }, e.clientX, e.clientY)
              }}
            >
              <path className="wire-hit" d={d} />
              <path className="wire-line" d={d} />
            </g>
          ))}
          {draft && <path className="wire-line draft" d={draft} style={{ stroke: portColor(wiringSource?.port) }} />}
        </svg>

        {/* The Page first (underneath), its docked widgets last (on top of it). */}
        {[...blocks].sort((a, b) => rank(a) - rank(b)).map((b) => (
          <BlockFrame
            key={b.id}
            block={b}
            editing={editing}
            zoom={view.zoom}
            spaceHeld={spaceHeld}
            selected={editing && selectedId === b.id}
            connected={connectedPorts(b.id)}
            wiringSource={wiringSource}
            ctx={makeCtx(b.id)}
            onSelect={onSelect}
            onSize={onSize}
            onPortDown={onPortDown}
            onMove={onMove}
            onMenu={openMenu}
            slot={b.dock ? slotById(b.dock.slot) : undefined}
            onDragAt={onDragAt}
          />
        ))}
        {hoverSlot && page && (
          <div className="slot-hover" style={{ left: page.x + hoverSlot.x, top: page.y + hoverSlot.y, width: hoverSlot.w, height: hoverSlot.h }}>
            Drop to show it here
          </div>
        )}
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
      {tip && !menu && (
        <div className={`port-tip${tip.below ? ' below' : ''}${tip.error ? ' error' : ''}`} style={{ left: tip.x, top: tip.y }}>
          {/* Just the explanation: a label's leading port name ("info — …") isn't repeated here. */}
          <div className="port-tip-label">{tipText(tip.label)}</div>
          <div className="port-tip-types">
            {tip.kind === 'inlet' ? 'accepts' : 'sends'}: <b>{tip.types}</b>
          </div>
          {tip.kind === 'outlet' && (
            <div className="port-tip-last">
              {tip.last ? (
                <>
                  <span className="port-tip-last-head">Last sent · {timeOf(tip.last.at)}</span>
                  {tip.last.lines.map((line, i) => (
                    <span key={i} className={i === 0 ? 'port-tip-last-main' : ''}>
                      {line}
                    </span>
                  ))}
                </>
              ) : (
                <span className="port-tip-last-head">Nothing sent yet</span>
              )}
            </div>
          )}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />}
      {editing && (
        <div className="canvas-hint">
          Drag outlet → inlet to wire · right-click a block or wire for options · scroll to zoom · drag empty space to pan
        </div>
      )}
    </div>
  )
}
