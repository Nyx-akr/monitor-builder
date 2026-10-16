import { useEffect, useState } from 'react'
import type { BlockContext, BlockDefinition, Message } from '../../types'
import { parseNumber } from '../../../lib/parseNumber'
import { describeValue } from '../../../lib/messages'
import './condition.css'

type Op = '>' | '>=' | '<' | '<=' | '==' | '!='

type Props = {
  /** How a is compared with b. */
  op: Op
}

const OPS: { value: Op; label: string; word: string }[] = [
  { value: '>', label: 'a > b — a is bigger than b', word: '>' },
  { value: '>=', label: 'a ≥ b — a is bigger than or equal to b', word: '≥' },
  { value: '<', label: 'a < b — a is smaller than b', word: '<' },
  { value: '<=', label: 'a ≤ b — a is smaller than or equal to b', word: '≤' },
  { value: '==', label: 'a = b — a equals b', word: '=' },
  { value: '!=', label: 'a ≠ b — a is not equal to b', word: '≠' },
]

/** The last a and b each Condition received. */
const values = new Map<string, { a?: Message; b?: Message }>()
type Status = { a?: Message; b?: Message; result?: boolean }
const listeners = new Map<string, (s: Status) => void>()

/** Numbers (and number text like "$1.02M" or "55%") compare as numbers; anything else as text. */
function compare(a: Message, b: Message, op: Op): boolean {
  const na = parseNumber(a)
  const nb = parseNumber(b)
  if (na !== null && nb !== null) {
    switch (op) {
      case '>': return na > nb
      case '>=': return na >= nb
      case '<': return na < nb
      case '<=': return na <= nb
      case '==': return na === nb
      case '!=': return na !== nb
    }
  }
  const sa = String(a ?? '').trim().toLowerCase()
  const sb = String(b ?? '').trim().toLowerCase()
  switch (op) {
    case '>': return sa > sb
    case '>=': return sa >= sb
    case '<': return sa < sb
    case '<=': return sa <= sb
    case '==': return sa === sb
    case '!=': return sa !== sb
  }
}

function evaluate(ctx: BlockContext<Props>) {
  const { a, b } = values.get(ctx.id) ?? {}
  // Nothing to compare until both have arrived.
  if (a === undefined || b === undefined) return listeners.get(ctx.id)?.({ a, b })
  const result = compare(a, b, ctx.props.op)
  listeners.get(ctx.id)?.({ a, b, result })
  ctx.send('result', result ? 1 : 0)
}

/** A value as shown in the box — its letter while it hasn't arrived yet. */
const shown = (v: Message | undefined, letter: string) => {
  if (v === undefined) return letter
  const s = v === '' ? '""' : describeValue(v)
  return s.length > 14 ? `${s.slice(0, 13)}…` : s
}

function ConditionBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [status, setStatus] = useState<Status>(() => ({ ...values.get(ctx.id) }))

  useEffect(() => {
    listeners.set(ctx.id, setStatus)
    return () => {
      listeners.delete(ctx.id)
    }
  }, [ctx.id])

  // Condition changed in the right panel: check the last a and b again right away.
  useEffect(() => {
    evaluate(ctx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.op])

  const word = OPS.find((o) => o.value === props.op)?.word ?? props.op
  const state = status.result === undefined ? '' : status.result ? ' yes' : ' no'
  return (
    <div
      className={`cond-box${state}`}
      title="Compares a (left input) with b (right input) whenever either arrives · sends 1 (green: true) or 0 (red: false)"
    >
      <span className="cond-name">if</span>
      <span className="cond-expr">
        {shown(status.a, 'a')} {word} {shown(status.b, 'b')}
      </span>
    </div>
  )
}

export const condition: BlockDefinition<Props> = {
  type: 'condition',
  label: 'Condition',
  description: 'If a is bigger, smaller or equal to b',
  icon: '⋚',
  category: 'objects',
  defaultProps: { op: '>' },
  settings: [
    {
      key: 'op',
      label: 'Condition',
      type: 'select',
      options: OPS.map(({ value, label }) => ({ value, label })),
      help: 'a is the left input, b the right one — e.g. a price into a, and a message box with a fixed number (100000) into b. Numbers and number text ($1.02M, 55%) compare as numbers; other text alphabetically.',
    },
  ],
  inlets: [
    { id: 'a', label: 'a — the value to check (e.g. a price from Get); checked as soon as it arrives', types: ['number', 'string'] },
    { id: 'b', label: 'b — what a is compared with (e.g. a message box with a fixed number); a is checked again', types: ['number', 'string'] },
  ],
  outlets: [
    { id: 'result', label: 'result — 1 when true, 0 when false (e.g. into a Gate’s control)', types: ['number'] },
  ],
  // The yes / no outlets were folded into the single result.
  renamedOutlets: { yes: 'result', no: 'result' },
  menu: [
    { label: 'Check again', run: (ctx) => evaluate(ctx) },
  ],
  receive: (ctx, inlet, msg) => {
    if (msg === 'bang' || (inlet !== 'a' && inlet !== 'b')) return
    values.set(ctx.id, { ...values.get(ctx.id), [inlet]: msg })
    evaluate(ctx)
  },
  Render: ConditionBox,
}
