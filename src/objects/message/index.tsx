import { useEffect, useMemo, useState } from 'react'
import type { BlockContext, BlockDefinition, Message, Port } from '../../blocks/types'
import { describeItem, describeValue, isHistory, isObject, isToken, legacySummaries, summarize } from '../../core/messages'
import './message.css'
import { ValueWidget } from '../../page/widgets/ValueWidget'

type Props = {
  text: string
  /** A received list or dictionary, as JSON ('' when the box holds plain text). */
  data: string
}

/** Plain decimal numbers only — "0x6982…" is an address, not hex. */
const isNumeric = (s: string) => /^-?\d+(\.\d+)?$/.test(s)

const parse = (data: string): Message | undefined => {
  if (!data) return undefined
  try {
    return JSON.parse(data) as Message
  } catch {
    return undefined
  }
}

/** The structured value the box is showing, if any (editing the text in the panel switches back to plain text). */
const heldData = (props: Props): Message | undefined => {
  const value = parse(props.data)
  return value !== undefined && (props.text === summarize(value) || legacySummaries(value).includes(props.text)) ? value : undefined
}

/**
 * Sends the box's content out of its outlet: a held list/dictionary as-is, otherwise its text.
 * Like Max, "a, b" sends "a" then "b", and $1 is replaced by the message that arrived on the inlet.
 */
/** Lets the open box flash whenever it sends — by click or triggered from a wire. */
const flashListeners = new Map<string, () => void>()

function output(ctx: BlockContext<Props>, arg?: string) {
  flashListeners.get(ctx.id)?.()
  const data = heldData(ctx.props)
  if (data !== undefined) return ctx.send('out', data)
  const text = ctx.props.text
  // An empty box passes the signal on: downstream, that's a blank token (e.g. a card fetches its list & info).
  if (!text.trim()) return ctx.send('out', 'bang')
  const content = arg === undefined ? text : text.replace(/\$1/g, arg)
  for (const part of content.split(',')) {
    const msg = part.trim()
    if (msg) ctx.send('out', isNumeric(msg) ? Number(msg) : msg)
  }
}

/** The type the box sends, from what it holds. */
function contentTypes(props: Props): NonNullable<Port['types']> {
  const data = heldData(props)
  if (data !== undefined) return isToken(data) ? ['token'] : isHistory(data) ? ['history'] : Array.isArray(data) || isObject(data) ? ['table'] : ['any']
  const text = (props.text ?? '').trim()
  if (!text) return ['any']
  if (text === 'bang') return ['bang']
  const parts = text.split(',').map((x) => x.trim()).filter(Boolean)
  return parts.every(isNumeric) ? ['number'] : ['string']
}

function MessageBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [flash, setFlash] = useState(0)
  const data = useMemo(() => heldData(props), [props.text, props.data])

  useEffect(() => {
    flashListeners.set(ctx.id, () => setFlash((f) => f + 1))
    return () => {
      flashListeners.delete(ctx.id)
    }
  }, [ctx.id])

  const trigger = () => output(ctx)

  /** Clicking one row sends just that item. */
  const sendItem = (e: React.MouseEvent, item: Message) => {
    e.stopPropagation()
    ctx.send('out', item)
    setFlash((f) => f + 1)
  }

  let body: React.ReactNode
  if (Array.isArray(data)) {
    body = (
      <>
        <div className="msg-head">{props.text}</div>
        <div className="msg-list scroll-y">
          {data.map((item, i) => (
            <button key={i} className="msg-row" onClick={(e) => sendItem(e, item)} title="Click to send this item">
              <span className="msg-index">{i}</span>
              <span className="msg-row-text">{describeItem(item)}</span>
            </button>
          ))}
        </div>
      </>
    )
  } else if (data !== undefined && isObject(data)) {
    body = (
      <div className="msg-dict scroll-y">
        {Object.entries(data)
          .filter(([k]) => k !== 'kind') // the Token mark is for the app, not for reading
          .map(([k, v]) => (
          <div key={k} className="msg-kv">
            <span>{k}</span>
            <strong>{describeValue(v, k)}</strong>
          </div>
        ))}
      </div>
    )
  } else {
    body = props.text ? <span>{props.text}</span> : <span className="msg-empty">(empty)</span>
  }

  return (
    <div
      key={flash}
      className={`msg${flash ? ' flash' : ''}${data !== undefined ? ' structured' : ''}`}
      onClick={trigger}
      title={ctx.editing ? 'Click to send · edit the text in the right panel' : 'Click to send'}
    >
      {body}
    </div>
  )
}

/** In a Page box: what it holds, as a widget (a big number, a heading, a table…). */
function MessageWidget({ props }: { props: Props; ctx: BlockContext<Props> }) {
  const data = heldData(props)
  const text = (props.text ?? '').trim()
  const value = data !== undefined ? data : isNumeric(text) ? Number(text) : text
  return <ValueWidget value={value} />
}

export const message: BlockDefinition<Props> = {
  type: 'message',
  label: 'Message',
  description: 'Click to send · shows what it receives',
  icon: '✉',
  category: 'objects',
  menu: [
    { label: 'Send', run: (ctx) => output(ctx) },
    { label: 'Clear message', run: (ctx) => ctx.update({ text: '', data: '' }) },
  ],
  // Empty: a signal arriving passes straight through (a blank token). Text typed in the panel fills it.
  defaultProps: { text: '', data: '' },
  settings: [
    {
      key: 'text',
      label: 'Message',
      type: 'text',
      help: 'Commas send several messages. If the text has $1, an incoming message fills it in and is sent on.',
    },
  ],
  // Older flows had a separate bang-only trigger inlet; a bang on `in` now does the same.
  renamedInlets: { trigger: 'in' },
  inlets: [
    {
      id: 'in',
      label: 'anything arriving is shown and sent straight on · a signal sends the current content (or passes the signal on if the box is empty)',
      types: ['string', 'number', 'table', 'bang'],
    },
  ],
  outlets: [{ id: 'out', label: 'what it holds — its type follows the content (table, text, number); anything while empty', types: ['any'] }],
  // The outlet shows the type of what the box holds — the data that came in. Empty: anything, so it can
  // be wired before data arrives (an empty box passes a signal on).
  outletTypes: (props) => ({ out: contentTypes(props) }),
  receive: (ctx, _inlet, msg) => {
    if (msg === 'bang') return output(ctx)
    if (typeof msg === 'string' && (msg === 'set' || msg.startsWith('set '))) return ctx.update({ text: msg.slice(4), data: '' })
    // A template like "solana $1" fills in and sends on.
    if (typeof msg !== 'object' && /\$1/.test(ctx.props.text) && !heldData(ctx.props)) return output(ctx, String(msg))
    // Everything else is shown (lists and info as rows) and passed straight on — inputs are always "hot".
    if (typeof msg === 'object' && msg !== null) ctx.update({ text: summarize(msg), data: JSON.stringify(msg) })
    else ctx.update({ text: String(msg), data: '' })
    flashListeners.get(ctx.id)?.()
    ctx.send('out', msg)
  },
  Render: MessageBox,
  Widget: MessageWidget,
}
