import type { BlockDefinition, Category } from './types'
import { pickBlocks } from './pick'
import { dataBlocks } from './data'
import { calcBlocks } from './calc'
import { showBlocks } from './show'
import { detailsBlocks } from './show/details'
import { ruleBlocks } from './rules'
import { pageBlocks } from '../page'

/**
 * Every block, by what a trader wants to do: Pick tokens → get Data about them → Calculate → Show → Rules.
 * Each group's file lists its blocks; the palette shows them in this order.
 */
export const CATEGORY_ORDER: Category[] = ['pick', 'data', 'calc', 'show', 'rules', 'pages']
export const CATEGORY_LABELS: Record<Category, string> = {
  pick: 'Pick',
  data: 'Data',
  calc: 'Calculate',
  show: 'Show',
  rules: 'Rules',
  pages: 'Page',
}

export const blocks: BlockDefinition<any>[] = [...pickBlocks, ...dataBlocks, ...calcBlocks, ...showBlocks, ...detailsBlocks, ...ruleBlocks, ...pageBlocks]

export const blockByType = Object.fromEntries(blocks.map((b) => [b.type, b])) as Record<string, BlockDefinition<any>>
