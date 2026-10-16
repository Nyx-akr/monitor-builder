import { useEffect, useRef, useState } from 'react'
import { blockByType } from './blocks/registry'
import { Palette, PaletteCard, type PaletteDrag } from './builder/Palette'
import { Canvas } from './builder/Canvas'
import { Inspector } from './builder/Inspector'
import { FlowSelector } from './builder/FlowSelector'
import { useFlow } from './builder/useFlow'
import type { BlockProps } from './blocks/types'
import { useRuntime } from './builder/useRuntime'

export default function App() {
  const flow = useFlow()
  const { view } = flow
  const [editing, setEditing] = useState(true)
  const [paletteDrag, setPaletteDrag] = useState<PaletteDrag | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const runtime = useRuntime({ blocks: flow.blocks, wires: flow.wires, editing, update: flow.update })

  /** Screen point (relative to the canvas) → world coordinates. */
  const toWorld = (sx: number, sy: number) => ({ x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom })

  /** Is a screen point over the canvas? */
  const overCanvas = (x: number, y: number) => {
    const vp = viewportRef.current?.getBoundingClientRect()
    return Boolean(vp && x >= vp.left && x <= vp.right && y >= vp.top && y <= vp.bottom)
  }

  /** Released a palette item: place the block's top-left where the ghost card's top-left is. */
  const onPaletteDrop = (drag: PaletteDrag) => {
    if (!overCanvas(drag.x, drag.y)) return
    const vp = viewportRef.current!.getBoundingClientRect()
    const { x, y } = toWorld(drag.x - drag.grabX - vp.left, drag.y - drag.grabY - vp.top)
    flow.add(drag.type, x, y, drag.props)
  }

  const addAtCenter = (type: string, props?: Partial<BlockProps>) => {
    const vp = viewportRef.current!.getBoundingClientRect()
    const center = toWorld(vp.width / 2, vp.height / 3)
    const cascade = (flow.blocks.length % 5) * 32
    flow.add(type, center.x - (blockByType[type].width ?? 120) / 2 + cascade, center.y + cascade, props)
  }

  // Delete / Backspace removes the selected block or wire, Escape deselects, ⌘S saves now.
  const { selectedId, selectedWireId, remove, disconnect, setSelectedId, selectWire, saveNow } = flow
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        saveNow()
        return
      }
      if (!editing || document.activeElement?.matches('input, textarea, select')) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedWireId) disconnect(selectedWireId)
        else if (selectedId) remove(selectedId)
      }
      if (e.key === 'Escape') {
        setSelectedId(null)
        selectWire(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, selectedId, selectedWireId, remove, disconnect, setSelectedId, selectWire, saveNow])

  const selected = flow.blocks.find((b) => b.id === flow.selectedId)

  return (
    <div className={`app${editing ? '' : ' previewing'}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> Dex Builder
        </div>
        <div className="topbar-actions">
          {editing && flow.blocks.length > 0 && (
            <button className="ghost-btn" onClick={() => confirm('Remove all blocks and wires from this flow?') && flow.clear()}>
              Clear
            </button>
          )}
          <div className="segmented">
            <button className={editing ? 'active' : ''} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className={!editing ? 'active' : ''} onClick={() => setEditing(false)}>
              Preview
            </button>
          </div>
          <FlowSelector
            flows={flow.flows}
            current={flow.name}
            status={flow.status}
            error={flow.error}
            onSwitch={flow.switchFlow}
            onNew={flow.newFlow}
            onSave={flow.saveNow}
            onReload={flow.reloadFromDisk}
          />
        </div>
      </header>

      <div className="workspace">
          {editing && <Palette onAdd={addAtCenter} onDrag={setPaletteDrag} onDrop={onPaletteDrop} />}
          <Canvas
            blocks={flow.blocks}
            wires={flow.wires}
            activeWires={runtime.activeWires}
            editing={editing}
            dropTarget={Boolean(paletteDrag && overCanvas(paletteDrag.x, paletteDrag.y))}
            view={view}
            setView={flow.setView}
            viewportRef={viewportRef}
            selectedId={flow.selectedId}
            selectedWireId={flow.selectedWireId}
            makeCtx={runtime.makeCtx}
            onSelect={flow.select}
            onSelectWire={flow.selectWire}
            onDeselect={() => {
              flow.setSelectedId(null)
              flow.selectWire(null)
            }}
            onMove={flow.moveTo}
            onDuplicate={flow.duplicate}
            onRemove={flow.remove}
            onConnect={flow.connect}
            onDisconnect={flow.disconnect}
          />
          {editing && (
            <Inspector
              block={selected}
              blocks={flow.blocks}
              wires={flow.wires}
              onChange={(p) => selected && flow.update(selected.id, p)}
              onDisconnect={flow.disconnect}
            />
          )}
      </div>
      {paletteDrag && (
        <div className="drag-ghost" style={{ left: paletteDrag.x - paletteDrag.grabX, top: paletteDrag.y - paletteDrag.grabY }}>
          <PaletteCard def={blockByType[paletteDrag.type]} card={paletteDrag.card} ghost />
        </div>
      )}
    </div>
  )
}
