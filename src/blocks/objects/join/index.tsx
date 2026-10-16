import { useEffect, useState } from 'react'
import type { BlockContext, BlockDefinition, Message, Port } from '../../types'
import './join.css'

type Props = {
  /** How many lists to join (2–8) — one inlet each. */
  inputs: number
}

const MIN_INPUTS = 2
const MAX_INPUTS = 8

const inputCount = (props: Props) => Math.min(MAX_INPUTS, Math.max(MIN_INPUTS, Math.floor(Number(props.inputs) || MIN_INPUTS)))

/** The last list each inlet received, by block id — kept in memory (lists can be large). */
const stored = new Map<string, Message[][]>()
const statusListeners = new Map<string, (sizes: number[]) => void>()

/** A single item (token, text, number) joins as a one-item list. */
const toList = (msg: Message): Message[] => (Array.isArray(msg) ? msg : [msg])

function slots(ctx: BlockContext<Props>): Message[][] {
  const n = inputCount(ctx.props)
  const current = stored.get(ctx.id) ?? []
  const fitted = Array.from({ length: n }, (_, i) => current[i] ?? [])
  stored.set(ctx.id, fitted)
  return fitted
}

function output(ctx: BlockContext<Props>) {
  const lists = slots(ctx)
  statusListeners.get(ctx.id)?.(lists.map((l) => l.length))
  ctx.send('out', lists.flat())
}

const inletId = (i: number) => `in${i}`

function JoinBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const n = inputCount(props)
  const [sizes, setSizes] = useState<number[]>(() => (stored.get(ctx.id) ?? []).map((l) => l.length))

  useEffect(() => {
    statusListeners.set(ctx.id, setSizes)
    return () => {
      statusListeners.delete(ctx.id)
    }
  }, [ctx.id])

  const shown = Array.from({ length: n }, (_, i) => sizes[i] ?? 0)
  return (
    <div className="join-box" title="Join lists: whenever any input receives, all lists are joined in inlet order and sent on">
      <span className="join-name">join</span>
      <span className="join-args">{n}</span>
      <span className="join-info">
        {shown.join(' + ')} → {shown.reduce((a, b) => a + b, 0)}
      </span>
    </div>
  )
}

export const join: BlockDefinition<Props> = {
  type: 'join',
  label: 'Join',
  description: 'Join two or more lists into one',
  icon: '⊕',
  category: 'objects',
  defaultProps: { inputs: 2 },
  settings: [
    { key: 'inputs', label: 'Inputs', type: 'number', min: MIN_INPUTS, max: MAX_INPUTS, help: `How many lists to join (${MIN_INPUTS}–${MAX_INPUTS}), one inlet each, joined left to right.` },
  ],
  // One inlet per list; whichever receives, everything is joined and sent on.
  ports: (props) => {
    const n = inputCount(props)
    const inlets: Port[] = Array.from({ length: n }, (_, i) => ({
      id: inletId(i),
      label: `list ${i + 1} — joined with the others (in inlet order) and sent on`,
      types: ['list', 'dict', 'string', 'number'],
    }))
    return { inlets }
  },
  outlets: [{ id: 'out', label: 'all lists joined, in inlet order', types: ['list'] }],
  menu: [
    { label: 'Send again', run: (ctx) => output(ctx) },
    {
      label: 'Clear stored lists',
      run: (ctx) => {
        stored.delete(ctx.id)
        statusListeners.get(ctx.id)?.([])
      },
    },
  ],
  receive: (ctx, inlet, msg) => {
    const i = Number(inlet.replace('in', ''))
    if (!Number.isInteger(i)) return
    if (msg === 'bang') return
    const lists = slots(ctx)
    if (i >= lists.length) return
    lists[i] = toList(msg)
    output(ctx)
  },
  Render: JoinBox,
}
