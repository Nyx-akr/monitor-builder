/**
 * The Page — the screen a flow drives — and its fixed widgets. Boxes on the Page show other blocks as
 * widgets (see widgets/ValueWidget); the Page's layout (its boxes) is in core/pageLayout.
 */
import { page } from './page'
import { tokenSelector } from './tokenSelector'

export const pageBlocks = [page, tokenSelector]
