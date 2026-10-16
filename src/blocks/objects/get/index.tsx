import { useEffect, useState } from 'react'
import type { BlockContext, BlockDefinition, Message, Port, SettingField } from '../../types'
import { isObject } from '../../../lib/messages'
import { parseNumber } from '../../../lib/parseNumber'
import './get.css'

type Props = {
  /** The field to read — a name, or a dotted path into nested info (chains.solana). */
  field: string
  /** Round number values to a whole number. */
  round: boolean
  /**
   * Every field of the last info received, with its type: "symbol:string,price:number,chains:dict,…".
   * The dropdown and the outlet's type are built from this.
   */
  knownFields: string
}

type FieldType = 'number' | 'string' | 'dict' | 'list'

/** The last info each Get received, so picking another field shows its value right away. */
const lastInput = new Map<string, Message>()

type Status = { kind: 'value'; value: Message } | { kind: 'error'; text: string } | { kind: 'waiting' }
const statusListeners = new Map<string, (s: Status) => void>()

/** Read a field, or a dotted path into nested info (chains.solana). */
function readPath(obj: Message, path: string): Message | undefined {
  let cur: Message | undefined = obj
  for (const key of path.split('.')) {
    if (!isObject(cur as Message)) return undefined
    cur = (cur as Record<string, Message | undefined>)[key]
  }
  return cur
}

/** The type a value is sent as: numbers (and number text like "55%") as number, other text as text. */
function typeOfValue(v: Message | undefined): FieldType | null {
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) return 'list'
  if (isObject(v)) return 'dict'
  if (typeof v === 'number' || typeof v === 'boolean') return 'number'
  return parseNumber(v) !== null ? 'number' : 'string'
}

/** Every field of the info, in its order — nested info also offers its own fields (chains.solana). */
function fieldsOf(obj: Message, prefix = '', depth = 0): [string, FieldType][] {
  if (!isObject(obj)) return []
  return Object.entries(obj).flatMap(([k, v]): [string, FieldType][] => {
    const path = prefix ? `${prefix}.${k}` : k
    const t = typeOfValue(v)
    if (!t) return []
    const own: [string, FieldType][] = [[path, t]]
    return t === 'dict' && depth < 1 ? [...own, ...fieldsOf(v as Message, path, depth + 1)] : own
  })
}

const encode = (fields: [string, FieldType][]) => fields.map(([p, t]) => `${p}:${t}`).join(',')

/** knownFields → [[path, type]]. Older saves listed bare names (all numbers). */
function decode(known: string): [string, FieldType][] {
  if (!known) return []
  return known.split(',').map((entry) => {
    const i = entry.lastIndexOf(':')
    return i > 0 ? [entry.slice(0, i), entry.slice(i + 1) as FieldType] : [entry, 'number']
  })
}

/** The value as it's sent: number text becomes a number; everything else goes as it is. */
function valueOut(v: Message, round: boolean): Message {
  const t = typeOfValue(v)
  if (t !== 'number') return v
  const n = typeof v === 'number' ? v : (parseNumber(v) as number)
  return round ? Math.round(n) : n
}

function extract(ctx: BlockContext<Props>, msg: Message) {
  const report = (s: Status) => statusListeners.get(ctx.id)?.(s)
  const fields = fieldsOf(msg)
  const known = encode(fields)
  // The dropdown follows the info that arrives. A picked field this info doesn't have goes back to "none";
  // the field stays "none" until it's picked — nothing is sent before that.
  const field = ctx.props.field && fields.some(([p]) => p === ctx.props.field) ? ctx.props.field : ''
  if (known !== ctx.props.knownFields || field !== ctx.props.field) ctx.update({ knownFields: known, field })
  if (!field) return report({ kind: 'waiting' })

  const value = readPath(msg, field)
  if (value === undefined || value === null) {
    const error = `"${field}" isn't in this dict`
    report({ kind: 'error', text: error })
    return ctx.send('error', { field, error })
  }
  const out = valueOut(value, ctx.props.round)
  report({ kind: 'value', value: out })
  ctx.send('out', out)
}

function show(v: Message): string {
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 1 ? 10 : 4 })
  if (Array.isArray(v)) return `list · ${v.length}`
  if (isObject(v)) return `dict · ${Object.keys(v).length}`
  const s = String(v)
  return s.length > 24 ? `${s.slice(0, 22)}…` : s
}

function GetBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    statusListeners.set(ctx.id, setStatus)
    return () => {
      statusListeners.delete(ctx.id)
    }
  }, [ctx.id])

  // Field list reset (copied, rewired): the old source's info no longer applies.
  useEffect(() => {
    if (!props.knownFields) lastInput.delete(ctx.id)
  }, [props.knownFields, ctx.id])

  // A different field (or rounding): read it from the last info right away.
  useEffect(() => {
    setStatus(null)
    const last = lastInput.get(ctx.id)
    if (last !== undefined && props.field) extract(ctx, last)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.field, props.round])

  return (
    <div className={`get-box${status?.kind === 'error' ? ' failed' : ''}`} title={status?.kind === 'error' ? status.text : undefined}>
      <span className="get-name">get</span>
      <span className={`get-field${props.field ? '' : ' none'}`}>{props.field || 'none'}</span>
      {status && status.kind !== 'waiting' && <span className="get-value">→ {status.kind === 'value' ? show(status.value) : '✕'}</span>}
    </div>
  )
}

const TYPE_WORD: Record<FieldType, string> = { number: 'number', string: 'text', dict: 'dict', list: 'list' }

export const get: BlockDefinition<Props> = {
  type: 'get',
  label: 'Get',
  description: 'Read one item from a dict (price, symbol, …)',
  icon: '⌖',
  category: 'objects',
  defaultProps: { field: '', round: false, knownFields: '' },
  // The field list belongs to the info that reached this Get — not to a block it was copied from.
  learnedReset: { field: '', knownFields: '' },
  // Wired to a message box that already shows info: offer its fields right away (nothing is sent).
  primeFrom: (_props, source) => {
    if (source.type !== 'message' || typeof source.props.data !== 'string' || !source.props.data.startsWith('{')) return null
    try {
      const info = JSON.parse(source.props.data) as Message
      return { knownFields: encode(fieldsOf(info)) }
    } catch {
      return null
    }
  },
  settings: [],
  // The field list is exactly the items of the last info received.
  settingsFor: (props): SettingField[] => {
    const fields = decode(props.knownFields)
    // Before any info has arrived, keep a saved choice visible; after that the list is exactly what the info has.
    if (props.field && fields.length === 0) fields.push([props.field, 'number'])
    return [
      {
        key: 'field',
        label: 'Field',
        type: 'select',
        options: [{ value: '', label: 'none' }, ...fields.map(([p, t]) => ({ value: p, label: `${p}  ·  ${TYPE_WORD[t] ?? t}` }))],
        help: fields.length
          ? 'Every item of the last dict this received, with the type it’s sent as. Nothing is sent while this is none.'
          : 'No dict yet — wire a card’s data or info outlet in (or a Dict box, or a message box showing a dict); its items appear here.',
      },
      { key: 'round', label: 'Round numbers to a whole number', type: 'toggle' },
    ]
  },
  inlets: [
    {
      id: 'in',
      label: 'dict — a card’s data / info, a Dict box (or a message box showing one); the chosen item is sent on straight away · a blank signal (e.g. an empty message box) clears the fields',
      types: ['dict', 'bang'],
    },
  ],
  outlets: [
    { id: 'out', label: 'the chosen item — its type follows the field (number, text, dict or list)', types: ['any'] },
    { id: 'error', label: 'error — the chosen item isn’t in the dict that arrived', types: ['dict'], error: true },
  ],
  // The outlet's type is the chosen field's type (anything while none is chosen, so it can be wired early).
  outletTypes: (props) => {
    const t = decode(props.knownFields).find(([p]) => p === props.field)?.[1]
    return { out: (t ? [t] : ['any']) as NonNullable<Port['types']> }
  },
  receive: (ctx, _inlet, msg) => {
    // A blank signal means "no data": forget the fields learned from the last info.
    if (msg === 'bang') {
      lastInput.delete(ctx.id)
      statusListeners.get(ctx.id)?.({ kind: 'waiting' })
      if (ctx.props.knownFields || ctx.props.field) ctx.update({ knownFields: '', field: '' })
      return
    }
    if (!isObject(msg)) return
    lastInput.set(ctx.id, msg)
    extract(ctx, msg)
  },
  Render: GetBox,
}
