import { blockByType } from '../blocks/registry'
import type { BlockInstance, Port, PortRef, Wire } from '../blocks/types'
import { compatible } from '../lib/dataTypes'

/** A block's ports with their types resolved for its current settings. */
export function portsOf(block: BlockInstance): { inlets: Port[]; outlets: Port[] } {
  const def = blockByType[block.type]
  const custom = def.ports?.(block.props) ?? {}
  const dynamic = def.outletTypes?.(block.props) ?? {}
  return {
    inlets: custom.inlets ?? def.inlets ?? [],
    outlets: (custom.outlets ?? def.outlets ?? []).map((p) => (dynamic[p.id] ? { ...p, types: dynamic[p.id] } : p)),
  }
}

export function findPort(blocks: BlockInstance[], ref: PortRef, kind: 'inlet' | 'outlet'): Port | undefined {
  const b = blocks.find((x) => x.id === ref.block)
  if (!b) return undefined
  const { inlets, outlets } = portsOf(b)
  return (kind === 'inlet' ? inlets : outlets).find((p) => p.id === ref.port)
}

/** Can this wire carry data from its outlet to its inlet, given both ports' types? */
export const wireFits = (blocks: BlockInstance[], w: Pick<Wire, 'from' | 'to'>) =>
  compatible(findPort(blocks, w.from, 'outlet'), findPort(blocks, w.to, 'inlet'))
