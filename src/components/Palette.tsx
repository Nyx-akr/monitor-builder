import { useRef, type PointerEvent } from 'react'
import { blocks, blockByType } from '../blocks/registry'
import type { BlockDefinition, BlockProps } from '../blocks/types'
import { deleteStore, formatBytes, useStores } from '../services/storage'

/** Movement (px) before a press on a palette item becomes a drag instead of a click. */
const DRAG_THRESHOLD = 5

/** A palette item being dragged: where the cursor is, and where on the card it was grabbed. */
export interface PaletteDrag {
  type: string
  /** Props the placed block starts with (e.g. which storage file it uses). */
  props?: Partial<BlockProps>
  /** What the item shows, when it's not the block's own label (a storage's file name). */
  card?: CardText
  x: number
  y: number
  grabX: number
  grabY: number
}

export type CardText = { label: string; description: string }

export function PaletteCard({ def, card, ghost }: { def: BlockDefinition<any>; card?: CardText; ghost?: boolean }) {
  return (
    <div className={`palette-card${ghost ? ' ghost' : ''}`}>
      <span className="palette-icon">{def.icon}</span>
      <span>
        <strong>{card?.label ?? def.label}</strong>
        <small>{card?.description ?? def.description}</small>
      </span>
    </div>
  )
}

/**
 * Press and drag onto the canvas, or click to add. The item captures the pointer on press, so the
 * release always reaches it — even over the floating ghost or outside the window — and the drag can't get stuck.
 */
function PaletteItem({
  def,
  props,
  card,
  onAdd,
  onDrag,
  onDrop,
  onContextMenu,
  title = 'Drag onto the canvas, or click to add',
}: {
  def: BlockDefinition<any>
  props?: Partial<BlockProps>
  card?: CardText
  onContextMenu?: (e: React.MouseEvent) => void
  title?: string
  onAdd: () => void
  onDrag: (drag: PaletteDrag | null) => void
  onDrop: (drag: PaletteDrag) => void
}) {
  const press = useRef<{ id: number; sx: number; sy: number; grabX: number; grabY: number; dragging: boolean } | null>(null)

  const end = () => {
    press.current = null
    onDrag(null)
  }

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.preventDefault() // no text selection or native drag
    const r = e.currentTarget.getBoundingClientRect()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture is a robustness extra; the drag still works without it */
    }
    press.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, grabX: e.clientX - r.left, grabY: e.clientY - r.top, dragging: false }
  }

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current
    if (!p || e.pointerId !== p.id) return
    // Button released without us seeing pointerup (can happen when focus jumps away): end the drag.
    if (e.buttons === 0) return end()
    if (!p.dragging && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < DRAG_THRESHOLD) return
    p.dragging = true
    onDrag({ type: def.type, props, card, x: e.clientX, y: e.clientY, grabX: p.grabX, grabY: p.grabY })
  }

  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current
    if (!p || e.pointerId !== p.id) return
    if (p.dragging) onDrop({ type: def.type, props, card, x: e.clientX, y: e.clientY, grabX: p.grabX, grabY: p.grabY })
    else onAdd()
    end()
  }

  return (
    <button
      className="palette-item"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={end}
      onLostPointerCapture={() => press.current && end()}
      // Keyboard (Enter/Space) still adds; mouse clicks are handled by pointerup above.
      onClick={(e) => e.detail === 0 && onAdd()}
      onContextMenu={onContextMenu}
      title={title}
    >
      <PaletteCard def={def} card={card} />
    </button>
  )
}

export function Palette({
  onAdd,
  onDrag,
  onDrop,
}: {
  onAdd: (type: string, props?: Partial<BlockProps>) => void
  onDrag: (drag: PaletteDrag | null) => void
  onDrop: (drag: PaletteDrag) => void
}) {
  const stores = useStores()
  const storageDef = blockByType.storage
  return (
    <aside className="panel palette">
      <h2>Blocks</h2>
      <p className="hint">Drag a block onto the canvas</p>
      {(['apis', 'objects'] as const).map((category) => {
        // Permanent blocks (the Page) are in every flow already — nothing to add.
        const group = blocks.filter((b) => b.category === category && !b.permanent)
        if (group.length === 0) return null
        return (
          <div key={category} className="palette-group">
            <h3>{category === 'apis' ? 'APIs' : 'Objects'}</h3>
            {group.map((def) => (
              <PaletteItem key={def.type} def={def} onAdd={() => onAdd(def.type)} onDrag={onDrag} onDrop={onDrop} />
            ))}
          </div>
        )
      })}
      {storageDef && stores.length > 0 && (
        <div className="palette-group">
          <h3>Storage</h3>
          {stores.map((s) => {
            const card = { label: s.name, description: `${s.entries.toLocaleString('en-US')} ${s.entries === 1 ? 'batch' : 'batches'} · ${formatBytes(s.bytes)}` }
            return (
              <PaletteItem
                key={s.name}
                def={storageDef}
                props={{ store: s.name }}
                card={card}
                title={`flows/storage/${s.name}.jsonl — drag onto the canvas to read or add to this history · right-click to delete it`}
                onAdd={() => onAdd('storage', { store: s.name })}
                onDrag={onDrag}
                onDrop={onDrop}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (confirm(`Delete ${s.name} and its whole history (${card.description})? This can’t be undone.`)) deleteStore(s.name).catch((err) => alert(err.message))
                }}
              />
            )
          })}
        </div>
      )}
      <p className="hint soon">Add a block: create a folder in src/objects (or src/apis) and list it in its index.ts</p>
    </aside>
  )
}
