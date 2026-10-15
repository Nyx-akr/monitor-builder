import { useDraggable } from '@dnd-kit/core'
import { blocks } from '../blocks/registry'
import type { BlockDefinition } from '../blocks/types'

export function PaletteCard({ def, ghost }: { def: BlockDefinition<any>; ghost?: boolean }) {
  return (
    <div className={`palette-card${ghost ? ' ghost' : ''}`}>
      <span className="palette-icon">{def.icon}</span>
      <span>
        <strong>{def.label}</strong>
        <small>{def.description}</small>
      </span>
    </div>
  )
}

function PaletteItem({ def, onAdd }: { def: BlockDefinition<any>; onAdd: () => void }) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `palette:${def.type}`,
    data: { from: 'palette', type: def.type },
  })
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onAdd}
      className="palette-item"
      style={{ opacity: isDragging ? 0.4 : 1 }}
      title="Drag onto the page, or click to add"
    >
      <PaletteCard def={def} />
    </button>
  )
}

export function Palette({ onAdd }: { onAdd: (type: string) => void }) {
  return (
    <aside className="panel palette">
      <h2>Blocks</h2>
      <p className="hint">Drag a block onto the canvas</p>
      {(['cards', 'objects'] as const).map((category) => {
        const group = blocks.filter((b) => b.category === category)
        if (group.length === 0) return null
        return (
          <div key={category} className="palette-group">
            <h3>{category === 'cards' ? 'Cards' : 'Objects'}</h3>
            {group.map((def) => (
              <PaletteItem key={def.type} def={def} onAdd={() => onAdd(def.type)} />
            ))}
          </div>
        )
      })}
      <p className="hint soon">Add a block: create a folder in src/blocks/cards or src/blocks/objects</p>
    </aside>
  )
}
