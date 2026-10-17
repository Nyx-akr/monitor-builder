import type { BlockDefinition } from './types'
import { apiBlocks } from '../apis'
import { objectBlocks } from '../objects'
import { pageBlocks } from '../page'

/**
 * Every block the editor knows: APIs (src/apis), objects (src/objects) and the Page (src/page). Each
 * folder's index.ts lists its blocks; the palette shows them grouped by category, A–Z.
 */
const ORDER: BlockDefinition['category'][] = ['apis', 'objects', 'pages']

export const blocks: BlockDefinition<any>[] = [...apiBlocks, ...objectBlocks, ...pageBlocks].sort((a, b) =>
  a.category === b.category ? a.label.localeCompare(b.label) : ORDER.indexOf(a.category) - ORDER.indexOf(b.category),
)

export const blockByType = Object.fromEntries(blocks.map((b) => [b.type, b])) as Record<string, BlockDefinition<any>>
