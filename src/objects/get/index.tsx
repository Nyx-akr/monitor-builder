import { useEffect, useState } from 'react'
import type { BlockContext, BlockDefinition, Message, Port, SettingField } from '../../blocks/types'
import { isObject } from '../../core/messages'
import { parseNumber } from '../../lib/parseNumber'
import './get.css'

/**
 * Get: read one item from a table. A table with one row (a token's details, a market summary) reads its
 * field straight away; a table with many rows (Top 250, Trending) first picks a row — by symbol, by
 * position, or all rows — then its field.
 */
type Props = {
  /** The field to read — a name, or a dotted path into nested values (chains.solana). '' = none. */
  field: string
  /** Which row of a many-row table: 'sym:BTC', 'i:0', '*' (all rows) or '' (none). Unused for one row. */
  row: string
  /** Round number values to a whole number. */
  round: boolean
  /** Every field of the last table received, with its type: "symbol:string,price:number,chains:table,…". */
  knownFields: string
  /** The rows of the last many-row table received, as "value=label" pairs joined by \n ('' = it had one row). */
  knownRows: string
}

type FieldType = 'number' | 'string' | 'table'

/** The last table each Get received, so picking another row / field shows its value right away. */
const lastInput = new Map<string, Message>()

type Status = { kind: 'value'; value: Message } | { kind: 'error'; text: string } | { kind: 'waiting'; text?: string }
const statusListeners = new Map<string, (s: Status) => void>()

/** Rows offered in the dropdown, at most — Top 250 fits. */
const MAX_ROWS = 300
/** Rows looked at to learn a many-row table's fields. */
const FIELD_SAMPLE = 20

/** Read a field, or a dotted path into nested values (chains.solana). */
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
  if (Array.isArray(v) || isObject(v)) return 'table'
  if (typeof v === 'number' || typeof v === 'boolean') return 'number'
  return parseNumber(v) !== null ? 'number' : 'string'
}

/** Every field of a row, in its order — a nested table also offers its own fields (chains.solana). */
function fieldsOf(obj: Message, prefix = '', depth = 0): [string, FieldType][] {
  if (!isObject(obj)) return []
  return Object.entries(obj).flatMap(([k, v]): [string, FieldType][] => {
    const path = prefix ? `${prefix}.${k}` : k
    const t = typeOfValue(v)
    if (!t) return []
    const own: [string, FieldType][] = [[path, t]]
    return t === 'table' && !Array.isArray(v) && depth < 1 ? [...own, ...fieldsOf(v as Message, path, depth + 1)] : own
  })
}

/** The fields of a table: a row's own, or (many rows) those found in its first rows. */
function tableFields(table: Message): [string, FieldType][] {
  if (!Array.isArray(table)) return fieldsOf(table)
  const seen = new Map<string, FieldType>()
  for (const row of table.slice(0, FIELD_SAMPLE)) for (const [p, t] of fieldsOf(row)) if (!seen.has(p)) seen.set(p, t)
  return [...seen]
}

const symbolOf = (row: Message): string | null =>
  isObject(row) && typeof (row as { symbol?: unknown }).symbol === 'string' ? String((row as { symbol: string }).symbol).toUpperCase() : null

/** A many-row table's rows for the dropdown: by symbol when rows have one (first of each), else by position. */
function tableRows(table: Message[]): [string, string][] {
  const rows: [string, string][] = []
  const seen = new Set<string>()
  table.slice(0, MAX_ROWS).forEach((row, i) => {
    const sym = symbolOf(row)
    if (sym && !seen.has(sym)) {
      seen.add(sym)
      const name = isObject(row) && typeof (row as { name?: unknown }).name === 'string' ? ` — ${(row as { name: string }).name}` : ''
      rows.push([`sym:${sym}`, `#${i}  ${sym}${name}`])
    } else if (!sym) rows.push([`i:${i}`, `#${i}`])
  })
  return rows
}

/** The chosen row of a many-row table (undefined: none chosen / not there). */
function pickRow(table: Message[], row: string): Message | undefined {
  if (row.startsWith('sym:')) return table.find((r) => symbolOf(r) === row.slice(4))
  if (row.startsWith('i:')) {
    const i = Number(row.slice(2))
    return table[i < 0 ? table.length + i : i]
  }
  return undefined
}

const encodeFields = (fields: [string, FieldType][]) => fields.map(([p, t]) => `${p}:${t}`).join(',')
/** knownFields → [[path, type]]. Older saves listed bare names (numbers) or called tables dict / list. */
function decodeFields(known: string): [string, FieldType][] {
  if (!known) return []
  return known.split(',').map((entry) => {
    const i = entry.lastIndexOf(':')
    if (i <= 0) return [entry, 'number']
    const t = entry.slice(i + 1)
    return [entry.slice(0, i), (t === 'dict' || t === 'list' ? 'table' : t) as FieldType]
  })
}
const encodeRows = (rows: [string, string][]) => rows.map(([v, l]) => `${v}=${l}`).join('\n')
const decodeRows = (known: string): [string, string][] =>
  known ? known.split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]) : []

/** The value as it's sent: number text becomes a number; everything else goes as it is. */
function valueOut(v: Message, round: boolean): Message {
  if (typeOfValue(v) !== 'number') return v
  const n = typeof v === 'number' ? v : (parseNumber(v) as number)
  return round ? Math.round(n) : n
}

/** What the dropdowns offer for a table, and the choices that still fit it. */
function learn(table: Message, props: Props) {
  const fields = tableFields(table)
  const rows = Array.isArray(table) ? tableRows(table) : []
  const many = Array.isArray(table)
  // A picked row / field this table doesn't have goes back to none.
  const row = many && (props.row === '*' || rows.some(([v]) => v === props.row) || (props.row.startsWith('i:') && pickRow(table, props.row) !== undefined)) ? props.row : ''
  const field = props.field && fields.some(([p]) => p === props.field) ? props.field : ''
  return { knownFields: encodeFields(fields), knownRows: many ? encodeRows(rows) : '', row, field }
}

function extract(ctx: BlockContext<Props>, table: Message) {
  const report = (s: Status) => statusListeners.get(ctx.id)?.(s)
  const learned = learn(table, ctx.props)
  const { row, field } = learned
  if (learned.knownFields !== ctx.props.knownFields || learned.knownRows !== ctx.props.knownRows || row !== ctx.props.row || field !== ctx.props.field)
    ctx.update(learned)

  const fail = (error: string) => {
    report({ kind: 'error', text: error })
    ctx.send('error', { row: row || null, field: field || null, error })
  }

  // One row: its field.
  if (!Array.isArray(table)) {
    if (!field) return report({ kind: 'waiting' })
    const value = readPath(table, field)
    if (value === undefined || value === null) return fail(`"${field}" isn't in this table`)
    const out = valueOut(value, ctx.props.round)
    report({ kind: 'value', value: out })
    return ctx.send('out', out)
  }

  // Many rows: a row first (or all of them), then its field (or the whole row).
  if (!row) return report({ kind: 'waiting', text: 'pick a row' })
  if (row === '*') {
    const out = field ? table.map((r) => readPath(r, field)).filter((v): v is Message => v !== undefined && v !== null).map((v) => valueOut(v, ctx.props.round)) : table
    report({ kind: 'value', value: out })
    return ctx.send('out', out)
  }
  const picked = pickRow(table, row)
  if (picked === undefined) return fail(`${row.replace(/^sym:|^i:/, '')} isn't in this table`)
  if (!field) {
    report({ kind: 'value', value: picked })
    return ctx.send('out', picked)
  }
  const value = readPath(picked, field)
  if (value === undefined || value === null) return fail(`"${field}" isn't in that row`)
  const out = valueOut(value, ctx.props.round)
  report({ kind: 'value', value: out })
  ctx.send('out', out)
}

function show(v: Message): string {
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 1 ? 10 : 4 })
  if (Array.isArray(v)) return `table · ${v.length} rows`
  if (isObject(v)) return symbolOf(v) ?? 'table · 1 row'
  const s = String(v)
  return s.length > 24 ? `${s.slice(0, 22)}…` : s
}

const rowLabel = (row: string) =>
  row === '*' ? 'all rows' : row === 'i:0' ? 'first row' : row === 'i:-1' ? 'last row' : row.replace(/^sym:/, '').replace(/^i:/, '#')

function GetBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    statusListeners.set(ctx.id, setStatus)
    return () => {
      statusListeners.delete(ctx.id)
    }
  }, [ctx.id])

  // Field list reset (copied, rewired): the old source's table no longer applies.
  useEffect(() => {
    if (!props.knownFields) lastInput.delete(ctx.id)
  }, [props.knownFields, ctx.id])

  // A different row / field (or rounding): read it from the last table right away.
  useEffect(() => {
    setStatus(null)
    const last = lastInput.get(ctx.id)
    if (last !== undefined && (props.field || props.row)) extract(ctx, last)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.field, props.row, props.round])

  const many = Boolean(props.knownRows)
  const what = [many && props.row ? rowLabel(props.row) : '', props.field].filter(Boolean).join(' · ')
  return (
    <div className={`get-box${status?.kind === 'error' ? ' failed' : ''}`} title={status?.kind === 'error' ? status.text : undefined}>
      <span className="get-name">get</span>
      <span className={`get-field${what ? '' : ' none'}`}>{what || (many ? 'pick a row' : 'none')}</span>
      {status && status.kind !== 'waiting' && <span className="get-value">→ {status.kind === 'value' ? show(status.value) : '✕'}</span>}
    </div>
  )
}

const TYPE_WORD: Record<FieldType, string> = { number: 'number', string: 'text', table: 'table' }

export const get: BlockDefinition<Props> = {
  type: 'get',
  label: 'Get',
  description: 'Read one item from a table (a row’s price, symbol…)',
  icon: '⌖',
  category: 'objects',
  defaultProps: { field: '', row: '', round: false, knownFields: '', knownRows: '' },
  // What it learned belongs to the table that reached this Get — not to a block it was copied from.
  learnedReset: { field: '', row: '', knownFields: '', knownRows: '' },
  // Wired to a message box that already shows a table: offer its rows / fields right away (nothing is sent).
  primeFrom: (props, source) => {
    if (source.type !== 'message' || typeof source.props.data !== 'string' || !/^[[{]/.test(source.props.data)) return null
    try {
      const { knownFields, knownRows } = learn(JSON.parse(source.props.data) as Message, props)
      return { knownFields, knownRows }
    } catch {
      return null
    }
  },
  settings: [],
  // The dropdowns are built from the last table received.
  settingsFor: (props): SettingField[] => {
    const fields = decodeFields(props.knownFields)
    const rows = decodeRows(props.knownRows)
    // Before any table has arrived, keep a saved choice visible; after that the lists are exactly what it has.
    if (props.field && fields.length === 0) fields.push([props.field, 'number'])
    const rowField: SettingField[] = rows.length
      ? [
          {
            key: 'row',
            label: 'Row',
            type: 'select',
            options: [
              { value: '', label: 'none' },
              { value: '*', label: 'all rows (the field from every row)' },
              { value: 'i:0', label: 'first row (#0 — whichever it is)' },
              { value: 'i:-1', label: 'last row (whichever it is)' },
              ...rows.filter(([value]) => value !== 'i:0').map(([value, label]) => ({ value, label })),
            ],
            help: `This table has many rows (${rows.length}${rows.length >= MAX_ROWS ? '+' : ''}): pick one by symbol (it follows that token wherever it moves in the list), the first or last row, or all of them. Nothing is sent while this is none.`,
          },
        ]
      : []
    return [
      ...rowField,
      {
        key: 'field',
        label: 'Field',
        type: 'select',
        options: [
          { value: '', label: rows.length ? 'none (the whole row)' : 'none' },
          ...fields.map(([p, t]) => ({ value: p, label: `${p}  ·  ${TYPE_WORD[t] ?? t}` })),
        ],
        help: fields.length
          ? 'Every item of the rows that arrived, with the type it’s sent as.'
          : 'No table yet — wire a card’s data, info or list in (or a Dict, or a message box showing a table); its rows and items appear here.',
      },
      { key: 'round', label: 'Round numbers to a whole number', type: 'toggle' },
    ]
  },
  inlets: [
    {
      id: 'in',
      label: 'table — one row (a card’s data / info, a Dict) or many (a card’s list); the chosen item is sent on straight away · a blank signal clears the choices',
      types: ['table', 'bang'],
    },
  ],
  outlets: [
    { id: 'out', label: 'the chosen item — its type follows the field (number, text or table); a whole row, or all rows’ values, as a table', types: ['any'] },
    { id: 'error', label: 'error — the chosen row or item isn’t in the table that arrived', types: ['table'], error: true },
  ],
  // The outlet's type follows the choice (anything while nothing is chosen, so it can be wired early).
  outletTypes: (props) => {
    const t = decodeFields(props.knownFields).find(([p]) => p === props.field)?.[1]
    const many = Boolean(props.knownRows)
    if (many && props.row === '*') return { out: ['table'] }
    // A whole row of a token list is a Token (rows offered by symbol are tokens).
    if (many && props.row && !props.field) return { out: decodeRows(props.knownRows).some(([v]) => v.startsWith('sym:')) ? ['token'] : ['table'] }
    return { out: (t ? [t] : ['any']) as NonNullable<Port['types']> }
  },
  receive: (ctx, _inlet, msg) => {
    // A blank signal means "no data": forget what was learned from the last table.
    if (msg === 'bang') {
      lastInput.delete(ctx.id)
      statusListeners.get(ctx.id)?.({ kind: 'waiting' })
      if (ctx.props.knownFields || ctx.props.field || ctx.props.row || ctx.props.knownRows) ctx.update({ knownFields: '', knownRows: '', field: '', row: '' })
      return
    }
    if (!isObject(msg) && !Array.isArray(msg)) return
    lastInput.set(ctx.id, msg)
    extract(ctx, msg)
  },
  Render: GetBox,
}
