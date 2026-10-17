import { useEffect, useState } from 'react'
import type { BlockContext, BlockDefinition, Message } from '../../blocks/types'
import { describeItem } from '../../core/messages'
import './list.css'

type Props = {
  /** Keep only the newest N items (0 = no limit) — e.g. a rolling history of prices. */
  maxItems: number
}

/** Collected items by block id — kept in memory (lists can be large). */
const lists = new Map<string, Message[]>()
type Status = { count: number; last?: Message }
const statusListeners = new Map<string, (s: Status) => void>()

const itemsOf = (id: string) => lists.get(id) ?? []

function report(ctx: BlockContext<Props>) {
  const items = itemsOf(ctx.id)
  statusListeners.get(ctx.id)?.({ count: items.length, last: items[items.length - 1] })
}

function output(ctx: BlockContext<Props>) {
  const items = itemsOf(ctx.id)
  // Right to left, like Max: the count, then the list.
  ctx.send('count', items.length)
  ctx.send('out', [...items])
}

function add(ctx: BlockContext<Props>, msg: Message) {
  // A list arriving adds each of its items.
  const incoming = Array.isArray(msg) ? msg : [msg]
  let items = [...itemsOf(ctx.id), ...incoming]
  const max = Math.max(0, Math.floor(Number(ctx.props.maxItems) || 0))
  if (max > 0 && items.length > max) items = items.slice(items.length - max)
  lists.set(ctx.id, items)
  report(ctx)
  output(ctx)
}

function clear(ctx: BlockContext<Props>) {
  lists.delete(ctx.id)
  report(ctx)
  // Hot like every input: what's downstream learns the list is now empty.
  output(ctx)
}

function ListBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [status, setStatus] = useState<Status>(() => ({ count: itemsOf(ctx.id).length, last: itemsOf(ctx.id).at(-1) }))

  useEffect(() => {
    statusListeners.set(ctx.id, setStatus)
    return () => {
      statusListeners.delete(ctx.id)
    }
  }, [ctx.id])

  const max = Math.max(0, Math.floor(Number(props.maxItems) || 0))
  return (
    <div className="list-box" title="Collects items: each one arriving is added and the list is sent on · a signal on clear empties it">
      <span className="list-name">list</span>
      <span className="list-count">
        {status.count}
        {max > 0 ? ` / ${max}` : ''}
      </span>
      {status.last !== undefined && <span className="list-last">last: {describeItem(status.last)}</span>}
    </div>
  )
}

export const list: BlockDefinition<Props> = {
  type: 'list',
  label: 'List',
  description: 'Collect items into a list',
  icon: '☰',
  category: 'objects',
  defaultProps: { maxItems: 0 },
  settings: [
    { key: 'maxItems', label: 'Max items', type: 'number', min: 0, help: '0 = no limit. Otherwise keeps only the newest N (a rolling window, e.g. the last 20 prices).' },
  ],
  inlets: [
    { id: 'in', label: 'row or value — adds it and sends the table on (a many-row table adds all its rows)', types: ['string', 'number', 'table'] },
    { id: 'clear', label: 'clear — a signal empties it and sends it on (no rows, count 0)', types: ['bang'] },
  ],
  outlets: [
    { id: 'out', label: 'the collected rows, as a table', types: ['table'] },
    { id: 'count', label: 'how many items it holds', types: ['number'] },
  ],
  menu: [
    { label: 'Send again', run: (ctx) => output(ctx) },
    { label: 'Clear list', run: (ctx) => clear(ctx) },
  ],
  receive: (ctx, inlet, msg) => {
    if (inlet === 'clear') return clear(ctx)
    add(ctx, msg)
  },
  Render: ListBox,
}
