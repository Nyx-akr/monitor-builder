import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { blockByType } from '../blocks/registry'
import type { BlockContext, BlockInstance, BlockProps, Query, QueryState, Wire } from '../blocks/types'
import type { Value } from '../core/values'
import { accepts, typesOf } from '../core/dataTypes'
import { portsOf } from '../core/ports'
import { keyOf, read, setActive, useEngineVersion } from '../engine/client'
import { recordSent } from '../core/lastSent'

/**
 * The live-formula runtime. Every block's outputs are computed from its inputs and its engine data, in wire
 * order — like spreadsheet cells. Whatever changes (a setting, an answer from the engine, a new wire), the
 * blocks downstream recompute, so a wire always carries its source's current value: no signals, no order.
 */

export interface BlockResult {
  inputs: Record<string, Value | undefined>
  inputsAll: Record<string, Value[]>
  outputs: Record<string, Value | undefined>
  data: QueryState[]
  queries: (Query | null)[]
  error?: string
}

const WIRE_FLASH_MS = 400

/** Blocks in wire order (sources first). Blocks in a loop come last, reading what's there. */
function order(blocks: BlockInstance[], wires: Wire[]): BlockInstance[] {
  const indeg = new Map(blocks.map((b) => [b.id, 0]))
  for (const w of wires) if (indeg.has(w.to.block) && indeg.has(w.from.block)) indeg.set(w.to.block, (indeg.get(w.to.block) ?? 0) + 1)
  const queue = blocks.filter((b) => !indeg.get(b.id))
  const out: BlockInstance[] = []
  const byId = new Map(blocks.map((b) => [b.id, b]))
  while (queue.length) {
    const b = queue.shift()!
    out.push(b)
    for (const w of wires)
      if (w.from.block === b.id && indeg.has(w.to.block)) {
        indeg.set(w.to.block, indeg.get(w.to.block)! - 1)
        if (indeg.get(w.to.block) === 0) queue.push(byId.get(w.to.block)!)
      }
  }
  return [...out, ...blocks.filter((b) => !out.includes(b))]
}

/** Shallow equal arrays (by identity). */
const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i])

export function useGraph(opts: { blocks: BlockInstance[]; wires: Wire[]; editing: boolean; update: (id: string, props: Partial<BlockProps>) => void }) {
  const { blocks, wires } = opts
  const version = useEngineVersion()
  // Per block: what its outputs were computed from, so unchanged blocks keep the same output objects.
  const memo = useRef(new Map<string, { deps: unknown[]; outputs: Record<string, Value | undefined>; error?: string }>())

  const results = useMemo(() => {
    const res = new Map<string, BlockResult>()
    const keys = new Set<string>()
    for (const b of order(blocks, wires)) {
      const def = blockByType[b.type]
      if (!def) continue
      const ports = portsOf(b)
      const inputsAll: Record<string, Value[]> = {}
      for (const inlet of ports.inlets) {
        inputsAll[inlet.id] = wires
          .filter((w) => w.to.block === b.id && w.to.port === inlet.id)
          .map((w) => res.get(w.from.block)?.outputs[w.from.port])
          .filter((v): v is Value => Boolean(v) && accepts(typesOf(inlet), v!.kind))
      }
      const inputs = Object.fromEntries(Object.entries(inputsAll).map(([k, v]) => [k, v[0]]))
      let queries: (Query | null)[] = []
      try {
        const q = def.query?.(b.props, inputs)
        queries = q == null ? [] : Array.isArray(q) ? q : [q]
      } catch {
        queries = []
      }
      const data = queries.map((q) => {
        if (!q) return { loading: false } as QueryState
        keys.add(keyOf(q))
        return read(q)
      })
      const deps = [b.props, ...Object.values(inputsAll).flat(), ...data]
      const prev = memo.current.get(b.id)
      let outputs = prev?.outputs ?? {}
      let error = prev?.error
      if (!prev || !same(prev.deps, deps)) {
        try {
          outputs = def.compute?.({ props: b.props, inputs, inputsAll, data }) ?? {}
          error = undefined
        } catch (e) {
          outputs = {}
          error = (e as Error).message
        }
        memo.current.set(b.id, { deps, outputs, error })
      }
      res.set(b.id, { inputs, inputsAll, outputs, data, queries, error })
    }
    return { res, keys }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, wires, version])

  useEffect(() => setActive(results.keys), [results])

  // Hover previews show each output's current value.
  useEffect(() => {
    for (const [id, r] of results.res) for (const [port, v] of Object.entries(r.outputs)) if (v) recordSent(id, port, v)
  }, [results])

  // A wire flashes when the value it carries changes.
  const [activeWires, setActiveWires] = useState<Set<string>>(new Set())
  const carried = useRef(new Map<string, Value | undefined>())
  useEffect(() => {
    const changed: string[] = []
    for (const w of wires) {
      const v = results.res.get(w.from.block)?.outputs[w.from.port]
      if (carried.current.has(w.id) && carried.current.get(w.id) !== v && v) changed.push(w.id)
      carried.current.set(w.id, v)
    }
    if (!changed.length) return
    setActiveWires((s) => new Set([...s, ...changed]))
    const t = setTimeout(() => setActiveWires((s) => new Set([...s].filter((id) => !changed.includes(id)))), WIRE_FLASH_MS)
    return () => clearTimeout(t)
  }, [results, wires])

  const latest = useRef({ results, blocks, opts })
  latest.current = { results, blocks, opts }

  const makeCtx = useCallback((id: string): BlockContext => {
    const r = latest.current.results.res.get(id)
    return {
      id,
      get props() {
        return latest.current.blocks.find((b) => b.id === id)?.props ?? {}
      },
      get editing() {
        return latest.current.opts.editing
      },
      update: (props) => latest.current.opts.update(id, props),
      inputs: r?.inputs ?? {},
      inputsAll: r?.inputsAll ?? {},
      outputs: r?.outputs ?? {},
      data: r?.data ?? [],
    }
  }, [])

  return { makeCtx, activeWires, results: results.res }
}
