/**
 * Objects — the building blocks that pass, shape, store and show data. Each object lives in its own
 * folder here (its code and styles); to add one, create a folder exporting a BlockDefinition and list it below.
 */
import { chart } from './chart'
import { clock } from './clock'
import { condition } from './condition'
import { dict } from './dict'
import { gate } from './gate'
import { get } from './get'
import { join } from './join'
import { list } from './list'
import { message } from './message'
import { slice } from './slice'
import { storage } from './storage'

export const objectBlocks = [chart, clock, condition, dict, gate, get, join, list, message, slice, storage]
