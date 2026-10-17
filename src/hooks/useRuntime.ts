import { useCallback, useRef, useState } from 'react'
import { blockByType } from '../blocks/registry'
import type { BlockContext, BlockInstance, BlockProps, Message, Wire } from '../blocks/types'
import { logText } from '../core/messages'
import { accepts, typeOfMessage, typesOf } from '../core/dataTypes'
import { portsOf } from '../core/ports'
import { recordSent } from '../core/lastSent'

/** A loop of wires (A → B → A) would otherwise run forever; Max calls this a stack overflow. */
const MAX_DEPTH = 64
const WIRE_FLASH_MS = 300

/**
 * Message passing between blocks. A block's `send(outlet, msg)` delivers `msg` along every wire
 * leaving that outlet, calling `receive` on each connected block — so what's wired is what happens.
 */
export function useRuntime(opts: {
  blocks: BlockInstance[]
  wires: Wire[]
  editing: boolean
  update: (id: string, props: Partial<BlockProps>) => void
}) {
  // Refs so messages see the latest blocks and wires, including props changed earlier in the same cascade.
  const blocksRef = useRef(opts.blocks)
  blocksRef.current = opts.blocks
  const wiresRef = useRef(opts.wires)
  wiresRef.current = opts.wires
  const optsRef = useRef(opts)
  optsRef.current = opts

  const [activeWires, setActiveWires] = useState<Set<string>>(new Set())
  const flashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const flash = (wireId: string) => {
    setActiveWires((s) => new Set(s).add(wireId))
    clearTimeout(flashTimers.current.get(wireId))
    flashTimers.current.set(
      wireId,
      setTimeout(() => {
        setActiveWires((s) => {
          const next = new Set(s)
          next.delete(wireId)
          return next
        })
      }, WIRE_FLASH_MS),
    )
  }

  const makeCtx = useCallback((id: string, depth = 0): BlockContext => {
    const ctx: BlockContext = {
      id,
      get props() {
        return blocksRef.current.find((b) => b.id === id)?.props ?? {}
      },
      get editing() {
        return optsRef.current.editing
      },
      update: (props) => {
        // Apply immediately to the ref so a following message in the same cascade sees it.
        blocksRef.current = blocksRef.current.map((b) => (b.id === id ? { ...b, props: { ...b.props, ...props } as BlockProps } : b))
        optsRef.current.update(id, props)
      },
      send: (outlet, msg) => send(id, outlet, msg, depth),
    }
    return ctx
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = (fromBlock: string, outlet: string, msg: Message, depth: number) => {
    if (depth >= MAX_DEPTH) {
      console.warn(`[dex-builder] stack overflow: message "${logText(msg)}" looped through ${MAX_DEPTH} wires — check for a feedback loop`)
      return
    }
    // Remember it for the outlet's hover preview — even when nothing is wired to it yet.
    recordSent(fromBlock, outlet, msg)
    for (const wire of wiresRef.current) {
      if (wire.from.block !== fromBlock || wire.from.port !== outlet) continue
      const target = blocksRef.current.find((b) => b.id === wire.to.block)
      const def = target && blockByType[target.type]
      if (!target || !def?.receive) continue
      // Typed inlets ignore messages of other types (e.g. a string reaching a bang-only trigger).
      const inlet = portsOf(target).inlets.find((p) => p.id === wire.to.port)
      if (!inlet) continue // its inlet no longer exists (e.g. a Join's input count was lowered)
      if (!accepts(typesOf(inlet), typeOfMessage(msg))) continue
      flash(wire.id)
      Promise.resolve(def.receive(makeCtx(target.id, depth + 1), wire.to.port, msg)).catch((e) =>
        console.error(`[dex-builder] ${def.label} failed to handle "${logText(msg)}":`, e),
      )
    }
  }

  return { makeCtx, activeWires }
}
