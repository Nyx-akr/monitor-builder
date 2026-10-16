import { useEffect, useState } from 'react'
import type { BlockContext, BlockDefinition, Message } from '../../types'
import './gate.css'

type Props = {
  /** Open when the flow starts, before any control value has arrived. */
  startOpen: boolean
}

/** Each gate's state and the last data it received, by block id. */
const gates = new Map<string, { open?: boolean; last?: Message; passed: number }>()
type Status = { open: boolean; passed: number }
const listeners = new Map<string, (s: Status) => void>()

const stateOf = (ctx: BlockContext<Props>) => {
  if (!gates.has(ctx.id)) gates.set(ctx.id, { passed: 0 })
  return gates.get(ctx.id)!
}
const isOpen = (ctx: BlockContext<Props>) => stateOf(ctx).open ?? Boolean(ctx.props.startOpen)
const report = (ctx: BlockContext<Props>) => listeners.get(ctx.id)?.({ open: isOpen(ctx), passed: stateOf(ctx).passed })

/** 1 opens the gate, 0 closes it; anything else is ignored. */
const controlValue = (msg: Message): boolean | null => (msg === 1 ? true : msg === 0 ? false : null)

function pass(ctx: BlockContext<Props>, msg: Message) {
  const s = stateOf(ctx)
  s.passed += 1
  report(ctx)
  ctx.send('out', msg)
}

function GateBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [status, setStatus] = useState<Status>(() => ({ open: isOpen(ctx), passed: stateOf(ctx).passed }))

  useEffect(() => {
    listeners.set(ctx.id, setStatus)
    return () => {
      listeners.delete(ctx.id)
    }
  }, [ctx.id])

  // "Starts open" changed while no control value has arrived yet: show it.
  useEffect(() => report(ctx), [props.startOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`gate-box${status.open ? ' open' : ''}`}
      title="Data on the left input passes while the gate is open · 1 on the right input opens it, 0 closes it"
    >
      <span className="gate-name">gate</span>
      <span className="gate-state">{status.open ? 'open' : 'closed'}</span>
      {status.passed > 0 && <span className="gate-count">{status.passed} passed</span>}
    </div>
  )
}

export const gate: BlockDefinition<Props> = {
  type: 'gate',
  label: 'Gate',
  description: 'Pass data while open (1), stop it while closed (0)',
  icon: '⛩',
  category: 'objects',
  defaultProps: { startOpen: false },
  settings: [
    {
      key: 'startOpen',
      label: 'Start open',
      type: 'toggle',
      help: 'Whether data passes before any control value has arrived. Off: closed until a 1 arrives.',
    },
  ],
  inlets: [
    { id: 'in', label: 'data — anything; passed straight on while the gate is open, stopped while it’s closed', types: ['string', 'number', 'list', 'dict', 'bang'] },
    {
      id: 'control',
      label: 'control — 1 opens the gate (and sends the last data held back), 0 closes it · e.g. a Condition’s result',
      types: ['number'],
    },
  ],
  outlets: [{ id: 'out', label: 'the data, while the gate is open', types: ['any'] }],
  menu: [
    {
      label: 'Open',
      run: (ctx) => {
        stateOf(ctx).open = true
        report(ctx)
      },
    },
    {
      label: 'Close',
      run: (ctx) => {
        stateOf(ctx).open = false
        report(ctx)
      },
    },
  ],
  receive: (ctx, inlet, msg) => {
    const s = stateOf(ctx)
    if (inlet === 'control') {
      const open = controlValue(msg)
      if (open === null) return
      const wasOpen = isOpen(ctx)
      s.open = open
      report(ctx)
      // Opening lets through the data that arrived while it was closed — so it doesn't matter
      // whether the data or the control (e.g. a Condition fed by the same price) arrives first.
      if (open && !wasOpen && s.last !== undefined) {
        const held = s.last
        s.last = undefined
        pass(ctx, held)
      }
      return
    }
    if (isOpen(ctx)) {
      s.last = undefined
      return pass(ctx, msg)
    }
    // Closed: hold on to the newest data only, in case the gate opens next.
    s.last = msg
  },
  Render: GateBox,
}
