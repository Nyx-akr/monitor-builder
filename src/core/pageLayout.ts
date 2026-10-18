import type { BlockInstance } from '../blocks/types'

// No imports from the block registry here: the Page block itself uses this file.

/**
 * The Page's boxes, in world px from the Page's top-left corner. A block dropped into a box is "docked":
 * it's drawn there (as a widget), keeps its own ports and wires, and moves with the Page.
 */
export interface Slot {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** A full-HD screen: 1920 × 1080 world px. */
export const PAGE_W = 1920
export const PAGE_H = 1080
export const PAGE_BAR_H = 40
const PAD = 24
const GAP = 20
/** The wireframe header strip under the browser bar. */
export const PAGE_HEAD = { top: PAGE_BAR_H + PAD, h: 48 }
const TOP = PAGE_HEAD.top + PAGE_HEAD.h + GAP
const CONTENT_H = PAGE_H - TOP - PAD

// Left: the token selector, full height. Right: 4 tiles, 2 panels, 1 wide box.
const SIDE_W = 440
const RIGHT_W = PAGE_W - PAD * 2 - SIDE_W - GAP
const TILE_H = 200
const PANEL_H = 340
const TILE_W = (RIGHT_W - GAP * 3) / 4

// ---------- the layout: a tree of splits (edited with "Edit layout" above the Page) ----------

/** A box, or a box split in two — side by side ('row') or one above the other ('col') — at `ratio`. */
export type LayoutNode = { id: string; leaf: true } | { id: string; dir: 'row' | 'col'; ratio: number; a: LayoutNode; b: LayoutNode }

/** A new Page: one box. */
export const DEFAULT_LAYOUT: LayoutNode = { id: 'main', leaf: true }

const leaf = (id: string): LayoutNode => ({ id, leaf: true })
const split = (id: string, dir: 'row' | 'col', ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ id, dir, ratio, a, b })

/** The fixed boxes of older flows (selector | 4 tiles / 2 panels / wide), as a tree with the same ids and sizes. */
export const LEGACY_LAYOUT: LayoutNode = split(
  's-side',
  'row',
  SIDE_W / (PAGE_W - PAD * 2 - GAP),
  leaf('selector'),
  split(
    's-rows',
    'col',
    TILE_H / (CONTENT_H - GAP),
    split('s-t1', 'row', TILE_W / (RIGHT_W - GAP), leaf('tile1'), split('s-t2', 'row', TILE_W / (RIGHT_W - TILE_W - GAP * 2), leaf('tile2'), split('s-t3', 'row', 0.5, leaf('tile3'), leaf('tile4')))),
    split('s-bottom', 'col', PANEL_H / (CONTENT_H - TILE_H - GAP * 2), split('s-panels', 'row', 0.5, leaf('panel1'), leaf('panel2')), leaf('wide')),
  ),
)
export const LEGACY_IDS = ['selector', 'tile1', 'tile2', 'tile3', 'tile4', 'panel1', 'panel2', 'wide']

export function parseLayout(json: unknown): LayoutNode {
  try {
    const n = JSON.parse(String(json || ''))
    return n && typeof n.id === 'string' ? n : DEFAULT_LAYOUT
  } catch {
    return DEFAULT_LAYOUT
  }
}

/** The Page's content area (under its header strip), in world px from the Page's corner. */
const CONTENT = { x: PAD, y: TOP, w: PAGE_W - PAD * 2, h: CONTENT_H }

export interface Divider {
  /** The split it belongs to. */
  id: string
  dir: 'row' | 'col'
  /** The divider's own rectangle (the gap between the two sides). */
  x: number
  y: number
  w: number
  h: number
  /** Where the split starts and how much it can share out (its length minus the gap), along `dir`. */
  start: number
  span: number
}

/** The boxes (leaves) and dividers of a layout, in world px from the Page's corner. */
export function computeLayout(node: LayoutNode, rect = CONTENT): { slots: Slot[]; dividers: Divider[] } {
  if ('leaf' in node) return { slots: [{ id: node.id, ...rect }], dividers: [] }
  const r = Math.min(0.92, Math.max(0.08, node.ratio))
  if (node.dir === 'row') {
    const span = rect.w - GAP
    const wa = span * r
    const A = computeLayout(node.a, { x: rect.x, y: rect.y, w: wa, h: rect.h })
    const B = computeLayout(node.b, { x: rect.x + wa + GAP, y: rect.y, w: span - wa, h: rect.h })
    return { slots: [...A.slots, ...B.slots], dividers: [{ id: node.id, dir: 'row', x: rect.x + wa, y: rect.y, w: GAP, h: rect.h, start: rect.x, span }, ...A.dividers, ...B.dividers] }
  }
  const span = rect.h - GAP
  const ha = span * r
  const A = computeLayout(node.a, { x: rect.x, y: rect.y, w: rect.w, h: ha })
  const B = computeLayout(node.b, { x: rect.x, y: rect.y + ha + GAP, w: rect.w, h: span - ha })
  return { slots: [...A.slots, ...B.slots], dividers: [{ id: node.id, dir: 'col', x: rect.x, y: rect.y + ha, w: rect.w, h: GAP, start: rect.y, span }, ...A.dividers, ...B.dividers] }
}

const newId = () => `b${Math.random().toString(36).slice(2, 7)}`

/** Split a box in two: the box keeps its id (and its widget) on the left / top; the new half is empty. */
export function splitBox(node: LayoutNode, id: string, dir: 'row' | 'col'): LayoutNode {
  if ('leaf' in node) return node.id === id ? split(newId(), dir, 0.5, node, leaf(newId())) : node
  return { ...node, a: splitBox(node.a, id, dir), b: splitBox(node.b, id, dir) }
}

/** Remove a box: its neighbour takes the space. (The last box can't go.) */
export function removeBox(node: LayoutNode, id: string): LayoutNode {
  if ('leaf' in node) return node
  if ('leaf' in node.a && node.a.id === id) return node.b
  if ('leaf' in node.b && node.b.id === id) return node.a
  return { ...node, a: removeBox(node.a, id), b: removeBox(node.b, id) }
}

/** Move a split's divider. */
export function setRatio(node: LayoutNode, id: string, ratio: number): LayoutNode {
  if ('leaf' in node) return node
  if (node.id === id) return { ...node, ratio: Math.min(0.92, Math.max(0.08, ratio)) }
  return { ...node, a: setRatio(node.a, id, ratio), b: setRatio(node.b, id, ratio) }
}

export const pageOf = (blocks: BlockInstance[]) => blocks.find((b) => b.type === 'page')

/** The boxes of a flow's Page. */
export const slotsOf = (blocks: BlockInstance[]): Slot[] => computeLayout(parseLayout(pageOf(blocks)?.props.layout)).slots

export const slotById = (blocks: BlockInstance[], id: string) => slotsOf(blocks).find((s) => s.id === id)

/** Docked blocks get the position of their box, so they're drawn there and wires attach there. */
export function placeDocked(blocks: BlockInstance[]): BlockInstance[] {
  const page = pageOf(blocks)
  if (!page) return blocks
  const slots = slotsOf(blocks)
  return blocks.map((b) => {
    const slot = b.dock && slots.find((s) => s.id === b.dock!.slot)
    return slot ? { ...b, x: page.x + slot.x, y: page.y + slot.y } : b
  })
}

/** The empty box under a world point, if any (a box holding another block doesn't count). */
export function freeSlotAt(blocks: BlockInstance[], x: number, y: number, except: string): Slot | undefined {
  const page = pageOf(blocks)
  if (!page) return undefined
  return slotsOf(blocks).find(
    (s) =>
      x >= page.x + s.x &&
      x <= page.x + s.x + s.w &&
      y >= page.y + s.y &&
      y <= page.y + s.y + s.h &&
      !blocks.some((b) => b.id !== except && b.dock?.slot === s.id),
  )
}
