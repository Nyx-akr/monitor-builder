import { useEffect, useRef, useState } from 'react'
import type { BlockContext, BlockDefinition, Message } from '../../types'
import './slice.css'

type Props = {
  /** 0-based index of the first item; negative counts from the end (-5 = last five). */
  from: number
  /** How many items to take. */
  count: number
}

/** The last list each slice received — kept in memory (lists can be large) so bang can re-slice it. */
const lastList = new Map<string, Message[]>()
/** Lets the open box show "250 → 10" after each output. */
const statusListeners = new Map<string, (s: { inLen: number; outLen: number }) => void>()

/** A list as Max sees it: an array, or space-separated words; anything else is a one-item list. */
function toList(msg: Message): Message[] {
  if (Array.isArray(msg)) return msg
  if (typeof msg === 'string') return msg.trim() ? msg.trim().split(/\s+/) : []
  return [msg]
}

function sliceAndSend(ctx: BlockContext<Props>, list: Message[]) {
  const count = Math.max(0, Math.floor(Number(ctx.props.count) || 0))
  const from = Math.floor(Number(ctx.props.from) || 0)
  // 0-based from the start, or counted back from the end when negative.
  const start = from < 0 ? Math.max(0, list.length + from) : from
  const taken = list.slice(start, start + count)
  const rest = [...list.slice(0, start), ...list.slice(start + count)]

  statusListeners.get(ctx.id)?.({ inLen: list.length, outLen: taken.length })
  // Right to left, like Max: the remainder first, then the slice.
  ctx.send('rest', rest)
  // A single item goes out on its own, so it can feed a card's token inlet directly.
  ctx.send('out', count === 1 && taken.length === 1 ? taken[0] : taken)
}

function SliceBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [status, setStatus] = useState<{ inLen: number; outLen: number } | null>(null)

  useEffect(() => {
    statusListeners.set(ctx.id, setStatus)
    return () => {
      statusListeners.delete(ctx.id)
    }
  }, [ctx.id])

  // Changing From / Count in the panel re-slices the last list right away.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const list = lastList.get(ctx.id)
    if (list) sliceAndSend(ctx, list)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.from, props.count])

  const from = Math.floor(Number(props.from) || 0)
  const count = Math.max(0, Math.floor(Number(props.count) || 0))
  const range = from < 0 ? `last ${-from}` : count === 1 ? `[${from}]` : `[${from}–${from + count - 1}]`

  return (
    <div className="slice-box" title="Slice a list: in (list) · from · count">
      <span className="slice-name">slice</span>
      <span className="slice-args">
        {from} {count}
      </span>
      <span className="slice-info">
        {range}
        {status && ` · ${status.inLen} → ${status.outLen}`}
      </span>
    </div>
  )
}

export const slice: BlockDefinition<Props> = {
  type: 'slice',
  label: 'Slice',
  description: 'Take a number of items from a list',
  icon: '✂',
  category: 'objects',
  defaultProps: { from: 0, count: 10 },
  settings: [
    { key: 'from', label: 'From index', type: 'number', help: '0 = first item (lists start at 0). Negative counts from the end (-5 = the last 5).' },
    { key: 'count', label: 'Count', type: 'number', min: 0, help: 'How many items to take. 1 sends the item itself instead of a one-item list.' },
  ],
  inlets: [{ id: 'in', label: 'list (or space-separated text) — the slice is sent on straight away', types: ['list', 'string'] }],
  outlets: [
    { id: 'out', label: 'the sliced items (a single item when count is 1)', types: ['any'] },
    { id: 'rest', label: 'rest — every item that wasn’t taken', types: ['list'] },
  ],
  // count 1 sends the item itself (any type); otherwise a list.
  outletTypes: (props) => ({ out: Math.floor(Number(props.count) || 0) === 1 ? ['any'] : ['list'] }),
  menu: [
    {
      label: 'Send again',
      run: (ctx) => {
        const list = lastList.get(ctx.id)
        if (list) sliceAndSend(ctx, list)
      },
    },
  ],
  receive: (ctx, _inlet, msg) => {
    const list = toList(msg)
    lastList.set(ctx.id, list)
    sliceAndSend(ctx, list)
  },
  Render: SliceBox,
}
