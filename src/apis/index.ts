/**
 * API blocks — live market data from outside services. Each block lives in its own folder here; to add
 * one, create a folder exporting a BlockDefinition (shared/makeApiCard gives the common card) and list it below.
 */
import { coinCard } from './coingecko'
import { tokenCard } from './dexscreener'
import { jupiter } from './jupiter'
import { goplus } from './goplus'
import { rugcheck } from './rugcheck'
import { honeypot } from './honeypot'
import { kyberswap } from './kyberswap'
import { defillama } from './defillama'
import { geckoterminal } from './geckoterminal'

export const apiBlocks = [coinCard, tokenCard, jupiter, goplus, rugcheck, honeypot, kyberswap, defillama, geckoterminal]
