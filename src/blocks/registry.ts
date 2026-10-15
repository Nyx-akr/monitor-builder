import type { BlockDefinition } from './types'

/**
 * Blocks are discovered from their folders: every src/blocks/cards/<name>/index.tsx and
 * src/blocks/objects/<name>/index.tsx exporting a BlockDefinition is added to the palette.
 * To add a block, create a folder; to remove one, delete its folder.
 */
const modules = import.meta.glob<Record<string, unknown>>(['./cards/*/index.tsx', './objects/*/index.tsx'], { eager: true })

const isBlock = (v: unknown): v is BlockDefinition<any> =>
  typeof v === 'object' && v !== null && 'type' in v && 'Render' in v && 'defaultProps' in v

export const blocks: BlockDefinition<any>[] = Object.values(modules)
  .flatMap((m) => Object.values(m).filter(isBlock))
  .sort((a, b) => (a.category === b.category ? a.label.localeCompare(b.label) : a.category === 'cards' ? -1 : 1))

export const blockByType = Object.fromEntries(blocks.map((b) => [b.type, b])) as Record<string, BlockDefinition<any>>
