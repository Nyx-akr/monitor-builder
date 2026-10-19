import type { BlockContext, BlockDefinition, BlockProps, Port, SettingField } from '../types'
import type { Column, NumberValue, Row, SeriesValue, TableValue, Value } from '../../core/values'
import type { Unit } from '../../core/metrics'
import { evalFormula, parseFormula } from '../../core/formula'
import { formatValue } from '../../core/show'
import { parseNumber } from '../../lib/parseNumber'
import { Box, Empty, MiniTable, columnOptions, unitOf } from '../shared'

/**
 * Calculation blocks: combine, shape and do maths on tables (token lists), numbers and series. All of
 * them are live: they recompute whenever what's wired in changes.
 */

// ---------- helpers ----------

/** A table, or a token as a one-row table. */
function asTable(v: Value | undefined): TableValue | null {
  if (!v) return null
  if (v.kind === 'table') return v
  if (v.kind === 'token') return { kind: 'table', columns: [], rows: [{ token: v, symbol: v.symbol }] }
  return null
}

const rowKey = (r: Row) => r.token?.id ?? JSON.stringify(r)

function unionColumns(tables: TableValue[]): Column[] {
  const out: Column[] = []
  for (const t of tables) for (const c of t.columns) if (!out.some((x) => x.key === c.key)) out.push(c)
  return out
}

/** The numbers of a series or candles (closes). */
const pointsOf = (v: Value | undefined): [number, number][] | null =>
  v?.kind === 'series' ? v.points : v?.kind === 'candles' ? v.bars.map((b) => [b[0], b[4]] as [number, number]) : null

/** Every block here shows its result the same way: a number, a few rows, or a series' latest point. */
function Result({ ctx, port, empty }: { ctx: Pick<BlockContext, 'outputs'>; port: string; empty: string }) {
  const v = ctx.outputs[port]
  if (!v) return <Empty>{empty}</Empty>
  if (v.kind === 'number') return <div className="bx-big">{formatValue(v.value, v.unit)}</div>
  if (v.kind === 'table') return v.rows.length ? <MiniTable table={v} max={5} /> : <Empty>No rows.</Empty>
  if (v.kind === 'series')
    return (
      <div className="bx-row">
        <span>{v.points.length} points · latest</span>
        <b>{formatValue(v.points[v.points.length - 1]?.[1], v.unit)}</b>
      </div>
    )
  return null
}

const TABLE_IN = (id: string, label: string): Port => ({ id, label, types: ['table', 'token'] })
const OPS = [
  { value: '>', label: '>' },
  { value: '>=', label: '≥' },
  { value: '<', label: '<' },
  { value: '<=', label: '≤' },
  { value: '=', label: '=' },
  { value: '!=', label: '≠' },
]

// ---------- Merge ----------

type MergeProps = { inputs: number }
const mergeCount = (p: MergeProps) => Math.min(6, Math.max(2, Math.floor(Number(p.inputs) || 2)))

export const merge: BlockDefinition<MergeProps> = {
  type: 'merge',
  label: 'Merge',
  description: 'Combine lists into one (duplicates removed)',
  icon: '⊕',
  category: 'calc',
  defaultProps: { inputs: 2 },
  settings: [{ key: 'inputs', label: 'Inputs', type: 'number', min: 2, max: 6 }],
  ports: (p) => ({ inlets: Array.from({ length: mergeCount(p) }, (_, i) => TABLE_IN(`in${i + 1}`, `List ${i + 1} (a token list, or a token)`)) }),
  outlets: [{ id: 'out', label: 'Every row of the lists, in order; a token in several lists appears once', types: ['table'] }],
  compute: ({ props, inputs }) => {
    const tables = Array.from({ length: mergeCount(props) }, (_, i) => asTable(inputs[`in${i + 1}`])).filter((t): t is TableValue => Boolean(t))
    if (!tables.length) return {}
    const seen = new Set<string>()
    const rows = tables.flatMap((t) => t.rows).filter((r) => (seen.has(rowKey(r)) ? false : (seen.add(rowKey(r)), true)))
    return { out: { kind: 'table', columns: unionColumns(tables), rows } }
  },
  Render: ({ ctx }) => (
    <Box icon="⊕" title="Merge" sub={ctx.outputs.out?.kind === 'table' ? `${ctx.outputs.out.rows.length} tokens` : undefined}>
      <Result ctx={ctx} port="out" empty="Wire two or more lists in." />
    </Box>
  ),
}

// ---------- Common / Exclude ----------

function setOp(keep: boolean): BlockDefinition<Record<string, never>>['compute'] {
  return ({ inputs }) => {
    const a = asTable(inputs.a)
    const b = asTable(inputs.b)
    if (!a) return {}
    const keys = new Set((b?.rows ?? []).map(rowKey))
    return { out: { ...a, rows: a.rows.filter((r) => keys.has(rowKey(r)) === keep) } }
  }
}

export const common: BlockDefinition<Record<string, never>> = {
  type: 'common',
  label: 'Common',
  description: 'Tokens that are in both lists',
  icon: '∩',
  category: 'calc',
  defaultProps: {},
  settings: [],
  inlets: [TABLE_IN('a', 'List A'), TABLE_IN('b', 'List B')],
  outlets: [{ id: 'out', label: 'The rows of A whose token is also in B', types: ['table'] }],
  compute: setOp(true),
  Render: ({ ctx }) => (
    <Box icon="∩" title="Common" sub="in A and in B">
      <Result ctx={ctx} port="out" empty="Wire list A and list B in." />
    </Box>
  ),
}

export const exclude: BlockDefinition<Record<string, never>> = {
  type: 'exclude',
  label: 'Exclude',
  description: 'Tokens of A that aren’t in B',
  icon: '∖',
  category: 'calc',
  defaultProps: {},
  settings: [],
  inlets: [TABLE_IN('a', 'List A'), TABLE_IN('b', 'List B — removed from A')],
  outlets: [{ id: 'out', label: 'The rows of A whose token isn’t in B', types: ['table'] }],
  compute: setOp(false),
  Render: ({ ctx }) => (
    <Box icon="∖" title="Exclude" sub="A without B">
      <Result ctx={ctx} port="out" empty="Wire list A and list B in." />
    </Box>
  ),
}

// ---------- Filter ----------

type FilterProps = { col1: string; op1: string; val1: string; col2: string; op2: string; val2: string; col3: string; op3: string; val3: string }

const cellOf = (r: Row, col: string) => (col === 'chain' ? r.token?.chain ?? null : col === 'symbol' ? r.token?.symbol ?? r.symbol ?? null : r[col])

function test(r: Row, col: string, op: string, raw: string): boolean {
  if (!col) return true
  const cell = cellOf(r, col)
  const n = parseNumber(raw)
  if (typeof cell === 'number' && n !== null) {
    return op === '>' ? cell > n : op === '>=' ? cell >= n : op === '<' ? cell < n : op === '<=' ? cell <= n : op === '=' ? cell === n : cell !== n
  }
  const a = String(cell ?? '').toLowerCase()
  const b = raw.trim().toLowerCase()
  return op === '!=' ? a !== b : op === '=' ? a === b : false
}

export const filter: BlockDefinition<FilterProps> = {
  type: 'filter',
  label: 'Filter',
  description: 'Keep the rows that match (liquidity > 50k…)',
  icon: '⏚',
  category: 'calc',
  defaultProps: { col1: 'liquidity', op1: '>', val1: '50000', col2: '', op2: '>', val2: '', col3: '', op3: '>', val3: '' },
  settings: [],
  settingsFor: (_p, inputs) => {
    // Text columns too (e.g. the rotation engine's phase and call: "call = BUY").
    const t = asTable(inputs.in)
    const text = t ? t.columns.filter((c) => c.key !== 'symbol' && t.rows.some((r) => typeof r[c.key] === 'string')).map((c) => ({ value: c.key, label: `${c.label} (text)` })) : []
    const cols = [{ value: '', label: '— not used —' }, ...columnOptions(inputs.in), ...text, { value: 'chain', label: 'Chain' }, { value: 'symbol', label: 'Symbol' }]
    return [1, 2, 3].flatMap((i): SettingField[] => [
      { key: `col${i}`, label: `Condition ${i}`, type: 'select', options: cols },
      { key: `op${i}`, label: 'is', type: 'select', options: OPS },
      { key: `val${i}`, label: 'value', type: 'text', placeholder: 'e.g. 50000, 50k, 1.2M, 5, solana, BUY', help: i === 1 ? 'Rows matching every condition are kept. Money in dollars, changes in %, age in hours; text with = or ≠ (call = BUY).' : undefined },
    ])
  },
  inlets: [TABLE_IN('in', 'A token list (or any table)')],
  outlets: [{ id: 'out', label: 'The rows matching every condition', types: ['table'] }],
  compute: ({ props, inputs }) => {
    const t = asTable(inputs.in)
    if (!t) return {}
    const conds = [1, 2, 3].map((i) => [props[`col${i}` as keyof FilterProps], props[`op${i}` as keyof FilterProps], props[`val${i}` as keyof FilterProps]] as string[])
    return { out: { ...t, rows: t.rows.filter((r) => conds.every(([c, o, v]) => !c || !String(v ?? '').trim() || test(r, c, o, String(v)))) } }
  },
  Render: ({ props, ctx }) => {
    const t = ctx.outputs.out?.kind === 'table' ? ctx.outputs.out : null
    const n = asTable(ctx.inputs.in)?.rows.length
    const cond = [1, 2, 3]
      .map((i) => [props[`col${i}` as keyof FilterProps], props[`op${i}` as keyof FilterProps], props[`val${i}` as keyof FilterProps]])
      .filter(([c, , v]) => c && String(v).trim())
      .map(([c, o, v]) => `${c} ${OPS.find((x) => x.value === o)?.label ?? o} ${v}`)
      .join(' · ')
    return (
      <Box icon="⏚" title="Filter" sub={cond || 'Set conditions in the right panel'}>
        {t && <div className="bx-sub">{t.rows.length} of {n} kept</div>}
        <Result ctx={ctx} port="out" empty="Wire a list in." />
      </Box>
    )
  },
}

// ---------- Sort / Top N ----------

type SortProps = { column: string; direction: string }

export const sort: BlockDefinition<SortProps> = {
  type: 'sort',
  label: 'Sort',
  description: 'Order rows by a column',
  icon: '⇅',
  category: 'calc',
  defaultProps: { column: 'volume24h', direction: 'desc' },
  settings: [],
  settingsFor: (_p, inputs) => [
    { key: 'column', label: 'By', type: 'select', options: columnOptions(inputs.in) },
    { key: 'direction', label: 'Order', type: 'select', options: [{ value: 'desc', label: 'Highest first' }, { value: 'asc', label: 'Lowest first' }] },
  ],
  inlets: [TABLE_IN('in', 'A list')],
  outlets: [{ id: 'out', label: 'The rows in order (empty values last)', types: ['table'] }],
  compute: ({ props, inputs }) => {
    const t = asTable(inputs.in)
    if (!t) return {}
    const dir = props.direction === 'asc' ? 1 : -1
    const val = (r: Row) => (typeof r[props.column] === 'number' ? (r[props.column] as number) : null)
    const rows = [...t.rows].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      return x === null ? 1 : y === null ? -1 : (x - y) * dir
    })
    return { out: { ...t, rows } }
  },
  Render: ({ props, ctx }) => (
    <Box icon="⇅" title="Sort" sub={`${props.column} · ${props.direction === 'asc' ? 'lowest' : 'highest'} first`}>
      <Result ctx={ctx} port="out" empty="Wire a list in." />
    </Box>
  ),
}

type TopProps = { n: number }

export const topN: BlockDefinition<TopProps> = {
  type: 'topN',
  label: 'Top N',
  description: 'The first N rows',
  icon: '🔝',
  category: 'calc',
  defaultProps: { n: 10 },
  settings: [{ key: 'n', label: 'How many', type: 'number', min: 1 }],
  inlets: [TABLE_IN('in', 'A list (sort it first)')],
  outlets: [{ id: 'out', label: 'The first N rows', types: ['table'] }],
  compute: ({ props, inputs }) => {
    const t = asTable(inputs.in)
    return t ? { out: { ...t, rows: t.rows.slice(0, Math.max(1, Math.floor(Number(props.n) || 10))) } } : {}
  },
  Render: ({ props, ctx }) => (
    <Box icon="🔝" title={`Top ${props.n}`}>
      <Result ctx={ctx} port="out" empty="Wire a list in." />
    </Box>
  ),
}

// ---------- Pick value ----------

type PickProps = { row: string; column: string }

export const pickValue: BlockDefinition<PickProps> = {
  type: 'pickValue',
  label: 'Pick value',
  description: 'One number (and its token) from a list',
  icon: '⌖',
  category: 'calc',
  defaultProps: { row: 'first', column: 'price' },
  settings: [],
  settingsFor: (_p, inputs) => {
    const t = asTable(inputs.in)
    const rows = (t?.rows ?? []).slice(0, 200).map((r) => r.token?.symbol).filter((s): s is string => Boolean(s))
    return [
      {
        key: 'row',
        label: 'Row',
        type: 'select',
        options: [{ value: 'first', label: 'First row' }, { value: 'last', label: 'Last row' }, ...[...new Set(rows)].map((s) => ({ value: `sym:${s}`, label: s }))],
        help: 'A token by symbol follows it wherever it moves in the list.',
      },
      { key: 'column', label: 'Value', type: 'select', options: columnOptions(inputs.in) },
    ]
  },
  inlets: [TABLE_IN('in', 'A list')],
  outlets: [
    { id: 'value', label: 'The chosen value, with its unit', types: ['number'] },
    { id: 'token', label: 'The chosen row’s token', types: ['token'] },
  ],
  compute: ({ props, inputs }) => {
    const t = asTable(inputs.in)
    if (!t?.rows.length) return {}
    const r = props.row === 'last' ? t.rows[t.rows.length - 1] : props.row.startsWith('sym:') ? t.rows.find((x) => x.token?.symbol === props.row.slice(4)) : t.rows[0]
    if (!r) return {}
    const v = r[props.column]
    return {
      value: { kind: 'number', value: typeof v === 'number' ? v : null, unit: unitOf(t, props.column), label: `${r.token?.symbol ?? ''} ${props.column}`.trim() },
      token: r.token,
    }
  },
  Render: ({ props, ctx }) => (
    <Box icon="⌖" title="Pick value" sub={`${props.row.replace('sym:', '')} · ${props.column}`}>
      <Result ctx={ctx} port="value" empty="Wire a list in." />
    </Box>
  ),
}

// ---------- Aggregate ----------

type AggProps = { fn: string; column: string }

const FNS: Record<string, { label: string; run: (xs: number[]) => number | null; unit?: Unit }> = {
  avg: { label: 'Average', run: (x) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : null) },
  sum: { label: 'Sum', run: (x) => x.reduce((a, b) => a + b, 0) },
  median: {
    label: 'Median',
    run: (x) => {
      if (!x.length) return null
      const s = [...x].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    },
  },
  min: { label: 'Lowest', run: (x) => (x.length ? Math.min(...x) : null) },
  max: { label: 'Highest', run: (x) => (x.length ? Math.max(...x) : null) },
  count: { label: 'Count', run: (x) => x.length, unit: 'count' },
}

export const aggregate: BlockDefinition<AggProps> = {
  type: 'aggregate',
  label: 'Aggregate',
  description: 'Average, sum, median, min, max or count',
  icon: 'Σ',
  category: 'calc',
  defaultProps: { fn: 'avg', column: 'change24h' },
  settings: [],
  settingsFor: (_p, inputs) => [
    { key: 'fn', label: 'Calculate', type: 'select', options: Object.entries(FNS).map(([value, f]) => ({ value, label: f.label })) },
    ...(inputs.in?.kind === 'table' || inputs.in?.kind === 'token' || !inputs.in
      ? [{ key: 'column', label: 'Of column', type: 'select' as const, options: columnOptions(inputs.in) }]
      : []),
  ],
  inlets: [{ id: 'in', label: 'A list (one column), or a series / candles (over time)', types: ['table', 'series', 'candles'] }],
  outlets: [{ id: 'value', label: 'The result, with its unit', types: ['number'] }],
  compute: ({ props, inputs }) => {
    const f = FNS[props.fn] ?? FNS.avg
    const pts = pointsOf(inputs.in)
    if (pts) {
      const unit = inputs.in?.kind === 'series' ? inputs.in.unit : 'usd'
      return { value: { kind: 'number', value: f.run(pts.map((p) => p[1])), unit: f.unit ?? unit, label: f.label } }
    }
    const t = asTable(inputs.in)
    if (!t) return {}
    const xs = t.rows.map((r) => r[props.column]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    return { value: { kind: 'number', value: f.run(xs), unit: f.unit ?? unitOf(t, props.column), label: `${f.label} ${props.column}` } }
  },
  Render: ({ props, ctx }) => (
    <Box icon="Σ" title={FNS[props.fn]?.label ?? 'Aggregate'} sub={pointsOf(ctx.inputs.in) ? 'over time' : props.column}>
      <Result ctx={ctx} port="value" empty="Wire a list or a series in." />
    </Box>
  ),
}

// ---------- Math ----------

type MathProps = { op: string; b: string }

const MATH: Record<string, { label: string; f: (a: number, b: number) => number; unit: (ua: Unit, ub: Unit) => Unit }> = {
  add: { label: 'a + b', f: (a, b) => a + b, unit: (u) => u },
  sub: { label: 'a − b', f: (a, b) => a - b, unit: (u) => u },
  mul: { label: 'a × b', f: (a, b) => a * b, unit: (u, v) => (v === 'none' ? u : u === 'none' ? v : 'none') },
  div: { label: 'a ÷ b', f: (a, b) => a / b, unit: (u, v) => (u === v ? 'ratio' : v === 'none' ? u : 'none') },
  pctOf: { label: 'a as % of b', f: (a, b) => (a / b) * 100, unit: () => 'pct' },
  change: { label: '% change from b to a', f: (a, b) => (a / b - 1) * 100, unit: () => 'pct' },
}

/** b's value at time t (the closest point at or before it). */
function at(points: [number, number][], t: number): number | null {
  let lo = 0
  let hi = points.length - 1
  let best: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid][0] <= t) {
      best = points[mid][1]
      lo = mid + 1
    } else hi = mid - 1
  }
  return best ?? points[0]?.[1] ?? null
}

export const math: BlockDefinition<MathProps> = {
  type: 'math',
  label: 'Math',
  description: 'a + − × ÷ b — numbers or series',
  icon: '±',
  category: 'calc',
  defaultProps: { op: 'div', b: '' },
  settings: [
    { key: 'op', label: 'Calculate', type: 'select', options: Object.entries(MATH).map(([value, m]) => ({ value, label: m.label })) },
    { key: 'b', label: 'b (when nothing is wired into b)', type: 'text', placeholder: 'e.g. 100, 1.5, 50k' },
  ],
  inlets: [
    { id: 'a', label: 'a — a number, or a series / candles (each point)', types: ['number', 'series', 'candles'] },
    { id: 'b', label: 'b — a number, or a series / candles (matched by time) · or set b in the right panel', types: ['number', 'series', 'candles'] },
  ],
  outlets: [{ id: 'out', label: 'The result: a number, or a series when a or b is one', types: ['number', 'series'] }],
  compute: ({ props, inputs }) => {
    const m = MATH[props.op] ?? MATH.div
    const a = inputs.a
    const bIn = inputs.b
    const bConst = parseNumber(props.b)
    const unitA = a?.kind === 'number' || a?.kind === 'series' ? a.unit : 'usd'
    const unitB = bIn?.kind === 'number' || bIn?.kind === 'series' ? bIn.unit : bIn?.kind === 'candles' ? 'usd' : 'none'
    const unit = m.unit(unitA, unitB)
    const safe = (x: number | null, y: number | null) => (x == null || y == null ? null : Number.isFinite(m.f(x, y)) ? m.f(x, y) : null)
    const aPts = pointsOf(a)
    const bPts = pointsOf(bIn)
    const bNum = bIn?.kind === 'number' ? bIn.value : bConst
    if (aPts) {
      const points = aPts
        .map(([t, v]): [number, number | null] => [t, safe(v, bPts ? at(bPts, t) : bNum)])
        .filter((p): p is [number, number] => p[1] != null)
      return { out: { kind: 'series', label: m.label, unit, points } satisfies SeriesValue }
    }
    if (bPts && a?.kind === 'number') {
      const points = bPts.map(([t, v]): [number, number | null] => [t, safe(a.value, v)]).filter((p): p is [number, number] => p[1] != null)
      return { out: { kind: 'series', label: m.label, unit, points } }
    }
    if (a?.kind === 'number') return { out: { kind: 'number', value: safe(a.value, bNum), unit, label: m.label } satisfies NumberValue }
    return {}
  },
  Render: ({ props, ctx }) => (
    <Box icon="±" title="Math" sub={MATH[props.op]?.label}>
      <Result ctx={ctx} port="out" empty="Wire a (and b, or set b in the right panel)." />
    </Box>
  ),
}

// ---------- Formula ----------

type FormulaProps = { expr: string; name: string; unit: string }

const UNITS: { value: Unit; label: string }[] = [
  { value: 'none', label: 'Plain number' },
  { value: 'usd', label: 'Dollars' },
  { value: 'pct', label: 'Percent' },
  { value: 'ratio', label: 'Ratio' },
  { value: 'count', label: 'Count' },
  { value: 'hours', label: 'Hours' },
]

export const formula: BlockDefinition<FormulaProps> = {
  type: 'formula',
  label: 'Formula',
  description: 'Your own calculation — a new column, or a number',
  icon: 'ƒ',
  category: 'calc',
  width: 260,
  defaultProps: { expr: 'volume24h / liquidity', name: 'turnover', unit: 'ratio' },
  settings: [],
  settingsFor: (_p, inputs) => {
    const t = asTable(inputs.list)
    const names = t ? t.columns.map((c) => c.key).join(', ') : 'price, change24h, volume24h, liquidity, marketCap…'
    return [
      { key: 'expr', label: 'Formula', type: 'text', placeholder: 'volume24h / liquidity', help: `Use columns (${names}) and a, b, c (numbers wired in). + − * / ^ ( ) and abs, min, max, sqrt, log, round.` },
      { key: 'name', label: 'Name of the new column', type: 'text' },
      { key: 'unit', label: 'Unit', type: 'select', options: UNITS },
    ]
  },
  inlets: [
    { id: 'list', label: 'A list: the formula runs on every row and becomes a new column', types: ['table', 'token'] },
    { id: 'a', label: 'a — a number', types: ['number'] },
    { id: 'b', label: 'b — a number', types: ['number'] },
    { id: 'c', label: 'c — a number', types: ['number'] },
  ],
  outlets: [
    { id: 'list', label: 'The list with the new column', types: ['table'] },
    { id: 'value', label: 'The formula’s value (of the first row, or of a, b, c alone)', types: ['number'] },
  ],
  compute: ({ props, inputs }) => {
    const tree = parseFormula(String(props.expr || '0')) // a bad formula throws: shown on the block
    const nums = Object.fromEntries((['a', 'b', 'c'] as const).map((k) => [k, inputs[k]?.kind === 'number' ? (inputs[k] as NumberValue).value : null]))
    const unit = (props.unit || 'none') as Unit
    const key = String(props.name || 'formula').replace(/\W+/g, '_')
    const t = asTable(inputs.list)
    if (!t) return { value: { kind: 'number', value: evalFormula(tree, nums), unit, label: key } }
    const rows = t.rows.map((r) => {
      const vars: Record<string, number | null> = { ...nums }
      for (const [k, v] of Object.entries(r)) if (typeof v === 'number') vars[k] = v
      return { ...r, [key]: evalFormula(tree, vars) }
    })
    return {
      list: { kind: 'table', columns: [...t.columns.filter((c) => c.key !== key), { key, label: props.name || key, unit }], rows },
      value: { kind: 'number', value: (rows[0]?.[key] as number | null) ?? null, unit, label: key },
    }
  },
  Render: ({ props, ctx }) => {
    let error = ''
    try {
      parseFormula(String(props.expr || '0'))
    } catch (e) {
      error = (e as Error).message
    }
    const t = ctx.outputs.list?.kind === 'table' ? ctx.outputs.list : null
    return (
      <Box icon="ƒ" title={props.name || 'Formula'} sub={<span className="bx-formula">{props.expr}</span>}>
        {error ? <Empty>{error}</Empty> : t ? <MiniTable table={t} columns={[String(props.name || 'formula').replace(/\W+/g, '_')]} max={5} /> : <Result ctx={ctx} port="value" empty="Wire a list or numbers in." />}
      </Box>
    )
  },
}

// ---------- Change / Moving average ----------

type ChangeProps = { minutes: number }

export const change: BlockDefinition<ChangeProps> = {
  type: 'change',
  label: 'Change',
  description: '% change of a series over a window',
  icon: 'Δ',
  category: 'calc',
  defaultProps: { minutes: 60 },
  settings: [{ key: 'minutes', label: 'Over the last (minutes)', type: 'number', min: 0, help: '0 = from the first point to the latest.' }],
  inlets: [{ id: 'in', label: 'A series or candles', types: ['series', 'candles'] }],
  outlets: [{ id: 'value', label: 'The % change', types: ['number'] }],
  compute: ({ props, inputs }) => {
    const pts = pointsOf(inputs.in)
    if (!pts?.length) return {}
    const last = pts[pts.length - 1]
    const mins = Math.max(0, Number(props.minutes) || 0)
    const from = mins ? at(pts, last[0] - mins * 60e3) : pts[0][1]
    return { value: { kind: 'number', value: from ? (last[1] / from - 1) * 100 : null, unit: 'pct', label: mins ? `Change ${mins}m` : 'Change' } }
  },
  Render: ({ props, ctx }) => (
    <Box icon="Δ" title="Change" sub={Number(props.minutes) ? `over ${props.minutes} min` : 'over the whole series'}>
      <Result ctx={ctx} port="value" empty="Wire a series or candles in." />
    </Box>
  ),
}

type MaProps = { points: number }

export const movingAverage: BlockDefinition<MaProps> = {
  type: 'movingAverage',
  label: 'Moving average',
  description: 'Smooth a series (average of the last N points)',
  icon: '〰',
  category: 'calc',
  defaultProps: { points: 20 },
  settings: [{ key: 'points', label: 'Points (N)', type: 'number', min: 2 }],
  inlets: [{ id: 'in', label: 'A series or candles', types: ['series', 'candles'] }],
  outlets: [{ id: 'out', label: 'The moving average, as a series', types: ['series'] }],
  compute: ({ props, inputs }) => {
    const pts = pointsOf(inputs.in)
    if (!pts) return {}
    const n = Math.max(2, Math.floor(Number(props.points) || 20))
    let sum = 0
    const points: [number, number][] = []
    pts.forEach(([t, v], i) => {
      sum += v
      if (i >= n) sum -= pts[i - n][1]
      if (i >= n - 1) points.push([t, sum / n])
    })
    const unit = inputs.in?.kind === 'series' ? inputs.in.unit : 'usd'
    const label = `${inputs.in && 'label' in inputs.in ? inputs.in.label : ''} MA${n}`.trim()
    return { out: { kind: 'series', label, unit, points } }
  },
  Render: ({ props, ctx }) => (
    <Box icon="〰" title={`MA ${props.points}`}>
      <Result ctx={ctx} port="out" empty="Wire a series or candles in." />
    </Box>
  ),
}

export const calcBlocks: BlockDefinition<BlockProps>[] = [
  merge,
  common,
  exclude,
  filter,
  sort,
  topN,
  pickValue,
  aggregate,
  math,
  formula,
  change,
  movingAverage,
] as unknown as BlockDefinition<BlockProps>[]
