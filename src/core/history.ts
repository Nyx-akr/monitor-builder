import type { BlockInstance, BlockProps, Wire } from '../blocks/types'

/** The flow's content at one moment — the arrays are immutable, so keeping one costs almost nothing. */
export interface Snapshot {
  blocks: BlockInstance[]
  wires: Wire[]
}

/** One undoable edit: the flow just before and just after it. */
export interface Step {
  before: Snapshot
  after: Snapshot
  /** Edits with the same key in quick succession (one drag, typing in one field) become one step. */
  key?: string
  at: number
}

/**
 * Apply the change from `from` to `to` onto `current`, touching only what that edit changed: blocks it
 * added or removed, the position / settings it changed, wires it added or removed. Everything else in
 * `current` — e.g. data that reached a message box after the edit — is kept as it is now.
 * Undo is patch(current, step.after, step.before); redo is patch(current, step.before, step.after).
 */
export function patch(current: Snapshot, from: Snapshot, to: Snapshot): Snapshot {
  const fromB = new Map(from.blocks.map((b) => [b.id, b]))
  const toB = new Map(to.blocks.map((b) => [b.id, b]))

  let blocks = current.blocks.filter((b) => !(fromB.has(b.id) && !toB.has(b.id)))
  for (const [id, b] of toB) if (!fromB.has(id) && !blocks.some((x) => x.id === id)) blocks.push(b)
  blocks = blocks.map((b) => {
    const was = fromB.get(b.id)
    const will = toB.get(b.id)
    if (!was || !will || was === will) return b
    const next: BlockInstance = { ...b, props: { ...b.props } }
    if (was.x !== will.x) next.x = will.x
    if (was.y !== will.y) next.y = will.y
    if (was.dock?.slot !== will.dock?.slot) {
      if (will.dock) next.dock = will.dock
      else delete next.dock
    }
    for (const k of new Set([...Object.keys(was.props), ...Object.keys(will.props)])) {
      if (was.props[k] === will.props[k]) continue
      if (k in will.props) next.props[k] = will.props[k]
      else delete (next.props as BlockProps)[k]
    }
    return next
  })

  const fromW = new Set(from.wires.map((w) => w.id))
  const toW = new Set(to.wires.map((w) => w.id))
  let wires = current.wires.filter((w) => !(fromW.has(w.id) && !toW.has(w.id)))
  for (const w of to.wires) if (!fromW.has(w.id) && !wires.some((x) => x.id === w.id)) wires.push(w)
  // A wire can't outlive a block it connects.
  const ids = new Set(blocks.map((b) => b.id))
  wires = wires.filter((w) => ids.has(w.from.block) && ids.has(w.to.block))
  return { blocks, wires }
}
