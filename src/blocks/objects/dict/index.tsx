import { useEffect, useState } from 'react'
import type { BlockContext, BlockDefinition, Message, Port } from '../../types'
import { describeValue, isObject } from '../../../lib/messages'
import './dict.css'

type Props = {
  /** Names of the values to keep, comma separated ("btc, eth") — one input each. */
  keys: string
  /** What it holds, as JSON — saved with the flow so it survives a reload. */
  data: string
}

type Dict = Record<string, Message>

/** Key names from the Keys setting: trimmed, no duplicates, no "|" (used in port ids). */
const keysOf = (props: Props) => [
  ...new Set(
    String(props.keys ?? '')
      .split(',')
      .map((k) => k.replace(/\|/g, '').trim())
      .filter(Boolean),
  ),
]

const KEY_PREFIX = 'key:'
const keyInlet = (k: string) => `${KEY_PREFIX}${k}`

function parse(data: string): Dict {
  try {
    const v = JSON.parse(data || '{}') as Message
    return isObject(v) ? (v as Dict) : {}
  } catch {
    return {}
  }
}

/** What each Dict holds right now — the flow's saved copy (props.data) lags behind a render. */
const held = new Map<string, Dict>()
const listeners = new Map<string, (d: Dict) => void>()

const dictOf = (ctx: BlockContext<Props>) => {
  if (!held.has(ctx.id)) held.set(ctx.id, parse(ctx.props.data))
  return held.get(ctx.id)!
}

function save(ctx: BlockContext<Props>, next: Dict) {
  held.set(ctx.id, next)
  listeners.get(ctx.id)?.(next)
  ctx.update({ data: JSON.stringify(next) })
}

const output = (ctx: BlockContext<Props>) => ctx.send('out', { ...dictOf(ctx) })

function DictBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [dict, setDict] = useState<Dict>(() => dictOf(ctx))

  useEffect(() => {
    listeners.set(ctx.id, setDict)
    return () => {
      listeners.delete(ctx.id)
    }
  }, [ctx.id])

  // Keys set in the right panel come first (waiting until their value arrives), then everything else held.
  const keys = keysOf(props)
  const rows = [...keys, ...Object.keys(dict).filter((k) => !keys.includes(k))]
  const count = Object.keys(dict).length
  return (
    <div className="dict-box" title="Holds named values: each key's input sets it, a dict arriving is merged in · the whole dict is sent on every change">
      <div className="dict-head">
        <span className="dict-name">dict</span>
        <span className="dict-count">
          {count} {count === 1 ? 'item' : 'items'}
        </span>
      </div>
      {rows.length ? (
        <div className="dict-rows scroll-y">
          {rows.map((k) => (
            <div key={k} className={`dict-kv${k in dict ? '' : ' waiting'}`}>
              <span>{k}</span>
              <strong>{k in dict ? describeValue(dict[k], k) : '—'}</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="dict-empty">Empty — add keys in the right panel, or wire a dict in</div>
      )}
    </div>
  )
}

export const dict: BlockDefinition<Props> = {
  type: 'dict',
  label: 'Dict',
  description: 'Keep named values together (btc: 82,000 · eth: 3,100…)',
  icon: '▤',
  category: 'objects',
  defaultProps: { keys: '', data: '' },
  settings: [
    {
      key: 'keys',
      label: 'Keys',
      type: 'text',
      placeholder: 'e.g. btc, eth, sol',
      help: 'Names of the values to keep, separated by commas — each gets its own input. Whatever arrives on it is stored under that name.',
    },
  ],
  // `in` merges a whole dict; each key in Settings gets an input that sets that one value.
  ports: (props) => {
    const inlets: Port[] = [
      { id: 'in', label: 'dict — merged in (same names are replaced) · a signal sends the dict as it is', types: ['dict', 'bang'] },
      ...keysOf(props).map(
        (k): Port => ({ id: keyInlet(k), label: `${k} — whatever arrives is stored as “${k}”`, types: ['number', 'string', 'list', 'dict'] }),
      ),
    ]
    return { inlets }
  },
  outlets: [{ id: 'out', label: 'the whole dict — sent on every change', types: ['dict'] }],
  menu: [
    { label: 'Send', run: (ctx) => output(ctx) },
    {
      label: 'Clear',
      run: (ctx) => {
        save(ctx, {})
        output(ctx)
      },
    },
  ],
  receive: (ctx, inlet, msg) => {
    if (inlet === 'in') {
      if (msg === 'bang') return output(ctx)
      if (!isObject(msg)) return
      save(ctx, { ...dictOf(ctx), ...(msg as Dict) })
      return output(ctx)
    }
    if (!inlet.startsWith(KEY_PREFIX) || msg === 'bang') return
    save(ctx, { ...dictOf(ctx), [inlet.slice(KEY_PREFIX.length)]: msg })
    output(ctx)
  },
  Render: DictBox,
}
