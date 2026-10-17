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
const RIGHT_X = PAD + SIDE_W + GAP
const RIGHT_W = PAGE_W - PAD - RIGHT_X
const TILE_H = 200
const PANEL_H = 340
const WIDE_H = CONTENT_H - TILE_H - PANEL_H - GAP * 2
const TILE_W = (RIGHT_W - GAP * 3) / 4
const PANEL_W = (RIGHT_W - GAP) / 2
const ROW2 = TOP + TILE_H + GAP
const ROW3 = ROW2 + PANEL_H + GAP

export const SLOTS: Slot[] = [
  { id: 'selector', x: PAD, y: TOP, w: SIDE_W, h: CONTENT_H },
  ...[0, 1, 2, 3].map((i) => ({ id: `tile${i + 1}`, x: RIGHT_X + i * (TILE_W + GAP), y: TOP, w: TILE_W, h: TILE_H })),
  ...[0, 1].map((i) => ({ id: `panel${i + 1}`, x: RIGHT_X + i * (PANEL_W + GAP), y: ROW2, w: PANEL_W, h: PANEL_H })),
  { id: 'wide', x: RIGHT_X, y: ROW3, w: RIGHT_W, h: WIDE_H },
]

export const slotById = (id: string) => SLOTS.find((s) => s.id === id)

export const pageOf = (blocks: BlockInstance[]) => blocks.find((b) => b.type === 'page')


/** Docked blocks get the position of their box, so they're drawn there and wires attach there. */
export function placeDocked(blocks: BlockInstance[]): BlockInstance[] {
  const page = pageOf(blocks)
  if (!page) return blocks
  return blocks.map((b) => {
    const slot = b.dock && slotById(b.dock.slot)
    return slot ? { ...b, x: page.x + slot.x, y: page.y + slot.y } : b
  })
}

/** The empty box under a world point, if any (a box holding another block doesn't count). */
export function freeSlotAt(blocks: BlockInstance[], x: number, y: number, except: string): Slot | undefined {
  const page = pageOf(blocks)
  if (!page) return undefined
  return SLOTS.find(
    (s) =>
      x >= page.x + s.x &&
      x <= page.x + s.x + s.w &&
      y >= page.y + s.y &&
      y <= page.y + s.y + s.h &&
      !blocks.some((b) => b.id !== except && b.dock?.slot === s.id),
  )
}
