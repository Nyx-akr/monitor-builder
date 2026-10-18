import type { BlockContext, BlockDefinition, BlockProps } from '../types'
import { metricByKey, metricOptions } from '../../core/metrics'
import { formatValue } from '../../core/show'
import { CANDLE_SIZES, ChartView, DEFAULT_TIMEFRAME, STYLES, TIMEFRAMES, type ChartLine, type ChartStyle, type Point } from '../../charts'
import { CLOCK_IN, DataStatus, Empty, MiniTable, SafetySummary, TokenLine, refreshMs, type MarketRow } from '../shared'

/** Show blocks: how data looks — on the canvas, and in a Page box (bigger). */

const wrap = (big: boolean | undefined) => `bx${big ? ' fill' : ''}`

// ---------- Chart ----------

type ChartProps = { lines: number; style: string; timeframe: string; scale: string; candle: string }
const lineCount = (p: ChartProps) => Math.min(4, Math.max(1, Math.floor(Number(p.lines) || 1)))

function chartLines(ctx: BlockContext<ChartProps>, n: number): ChartLine[] {
  const out: ChartLine[] = []
  for (let i = 1; i <= n; i++) {
    const v = ctx.inputs[`in${i}`]
    if (v?.kind === 'series') out.push({ key: `in${i}`, label: v.label || `Line ${i}`, points: v.points as Point[] })
    else if (v?.kind === 'candles') out.push({ key: `in${i}`, label: v.label || `Line ${i}`, points: v.bars.map(([t, o, h, l, c]) => [t, c, o, h, l] as Point) })
    else out.push({ key: `in${i}`, label: `Line ${i}`, points: [] })
  }
  return out
}

function ChartBlock({ props, ctx, big }: { props: ChartProps; ctx: BlockContext<ChartProps>; big?: boolean }) {
  const lines = chartLines(ctx, lineCount(props))
  return (
    <ChartView
      lines={lines}
      style={(STYLES.some((s) => s.value === props.style) ? props.style : 'line') as ChartStyle}
      timeframe={props.timeframe}
      asPercent={props.scale === 'percent'}
      candleSize={props.candle}
      big={big}
      onTimeframe={(value) => ctx.update({ timeframe: value })}
      emptyText={lines.some((l) => l.points.length) ? 'Nothing in this timeframe — pick a longer one' : 'Wire candles or a series in (Candles, History, Math, Moving average…)'}
    />
  )
}

export const chart: BlockDefinition<ChartProps> = {
  type: 'chart',
  label: 'Chart',
  description: 'Candles or lines — up to 4, compared',
  icon: '📈',
  category: 'show',
  defaultProps: { lines: 1, style: 'line', timeframe: DEFAULT_TIMEFRAME, scale: 'value', candle: 'auto' },
  settings: [],
  settingsFor: (props) => [
    { key: 'style', label: 'Chart style', type: 'select', options: STYLES },
    ...(props.style === 'candle' ? [{ key: 'candle', label: 'Candle size (for series)', type: 'select' as const, options: CANDLE_SIZES }] : []),
    { key: 'timeframe', label: 'Timeframe', type: 'select', options: TIMEFRAMES.map(({ value, label }) => ({ value, label })) },
    {
      key: 'scale',
      label: 'Scale',
      type: 'select',
      options: [
        { value: 'value', label: 'Values — one shared scale' },
        { value: 'percent', label: '% change — compare lines of different sizes' },
      ],
    },
    { key: 'lines', label: 'Inputs', type: 'number', min: 1, max: 4, help: 'How many lines (1–4), each with its own colour.' },
  ],
  ports: (props) => ({
    inlets: Array.from({ length: lineCount(props) }, (_, i) => ({ id: `in${i + 1}`, label: `Line ${i + 1}: candles or a series`, types: ['candles', 'series'] })),
  }),
  outlets: [],
  Render: (p) => <ChartBlock {...p} />,
  Widget: (p) => <ChartBlock {...p} big />,
}

// ---------- Number tile ----------

type TileProps = { title: string }

function TileView({ props, ctx, big }: { props: TileProps; ctx: BlockContext<TileProps>; big?: boolean }) {
  const v = ctx.inputs.in?.kind === 'number' ? ctx.inputs.in : null
  return (
    <div className={wrap(big)}>
      <div className="bx-head">
        <span className="bx-icon">#</span>
        <span className="bx-title">
          <strong>{props.title || v?.label || 'Number'}</strong>
        </span>
      </div>
      <div className="bx-body">
        {v ? (
          <div className={`bx-big${v.unit === 'pct' && v.value != null ? (v.value >= 0 ? ' up' : ' down') : ''}`}>{formatValue(v.value, v.unit)}</div>
        ) : (
          <Empty>Wire a number in (Market data value, Pick value, Aggregate, Math…).</Empty>
        )}
      </div>
    </div>
  )
}

export const numberTile: BlockDefinition<TileProps> = {
  type: 'numberTile',
  label: 'Number tile',
  description: 'One big number',
  icon: '#',
  category: 'show',
  defaultProps: { title: '' },
  settings: [{ key: 'title', label: 'Title', type: 'text', placeholder: 'e.g. Avg 24h change' }],
  inlets: [{ id: 'in', label: 'A number', types: ['number'] }],
  outlets: [],
  Render: (p) => <TileView {...p} />,
  Widget: (p) => <TileView {...p} big />,
}

// ---------- Table ----------

type TableProps = { title: string; columns: string; rows: number }

function TableView({ props, ctx, big }: { props: TableProps; ctx: BlockContext<TableProps>; big?: boolean }) {
  const t = ctx.inputs.in?.kind === 'table' ? ctx.inputs.in : null
  const cols = String(props.columns || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return (
    <div className={`${wrap(big)} wide`}>
      <div className="bx-head">
        <span className="bx-icon">▦</span>
        <span className="bx-title">
          <strong>{props.title || 'Table'}</strong>
          <small>{t ? `${t.rows.length} rows` : 'Wire a list in'}</small>
        </span>
      </div>
      <div className="bx-body">{t ? <MiniTable table={t} columns={cols.length ? cols : ['price', 'change24h', 'volume24h', 'liquidity']} max={big ? 200 : Number(props.rows) || 10} /> : <Empty>Wire a token list in.</Empty>}</div>
    </div>
  )
}

export const table: BlockDefinition<TableProps> = {
  type: 'table',
  label: 'Table',
  description: 'A list with the columns you choose',
  icon: '▦',
  category: 'show',
  defaultProps: { title: '', columns: 'price, change24h, volume24h, liquidity', rows: 10 },
  settings: [],
  settingsFor: (_p, inputs) => [
    { key: 'title', label: 'Title', type: 'text' },
    {
      key: 'columns',
      label: 'Columns',
      type: 'text',
      help: `Comma separated: ${inputs.in?.kind === 'table' ? inputs.in.columns.map((c) => c.key).join(', ') : 'price, change24h, volume24h, liquidity, marketCap…'}`,
    },
    { key: 'rows', label: 'Rows shown on the canvas', type: 'number', min: 1 },
  ],
  inlets: [{ id: 'in', label: 'A list', types: ['table'] }],
  outlets: [],
  Render: (p) => <TableView {...p} />,
  Widget: (p) => <TableView {...p} big />,
}

// ---------- Token card ----------

type CardProps = { metrics: string }

function CardView({ props, ctx, big }: { props: CardProps; ctx: BlockContext<CardProps>; big?: boolean }) {
  const t = ctx.inputs.token?.kind === 'token' ? ctx.inputs.token : null
  const row = (ctx.data[0]?.data as { rows?: Record<string, MarketRow> } | undefined)?.rows?.[t?.id ?? '']
  const keys = String(props.metrics || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return (
    <div className={wrap(big)}>
      <div className="bx-head">
        {t ? <TokenLine token={row?.token ?? t} /> : <span className="bx-title"><strong>Token card</strong></span>}
        <span style={{ flex: 1 }} />
        <DataStatus states={ctx.data} />
      </div>
      <div className="bx-body">
        {!t && <Empty>Wire a token in.</Empty>}
        {row && (
          <>
            <div className="bx-big">
              {formatValue(row.metrics.price, 'usd')}{' '}
              <small className={(row.metrics.change24h ?? 0) >= 0 ? 'up' : 'down'} style={{ fontSize: '0.5em' }}>
                {formatValue(row.metrics.change24h, 'pct')}
              </small>
            </div>
            {keys.map((k) => {
              const m = metricByKey(k)
              const v = row.metrics[k]
              return (
                <div key={k} className="bx-row">
                  <span>{m?.label ?? k}</span>
                  <b className={m?.unit === 'pct' && v != null ? (v >= 0 ? 'up' : 'down') : ''}>{formatValue(v, m?.unit ?? 'none')}</b>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

export const tokenCard: BlockDefinition<CardProps> = {
  type: 'tokenCard',
  label: 'Token card',
  description: 'Price and key metrics of a token',
  icon: '🪪',
  category: 'show',
  defaultProps: { metrics: 'change1h, liquidity, volume24h, marketCap, ageHours' },
  settings: [{ key: 'metrics', label: 'Metrics shown', type: 'text', help: `Comma separated: ${metricOptions().map((m) => m.value).join(', ')}` }],
  inlets: [{ id: 'token', label: 'A token', types: ['token'] }, CLOCK_IN],
  outlets: [],
  query: (_p, inputs) => (inputs.token?.kind === 'token' ? { kind: 'market', params: { ids: inputs.token.id }, refreshMs: refreshMs(inputs, {}, 30, 1) } : null),
  Render: (p) => <CardView {...p} />,
  Widget: (p) => <CardView {...p} big />,
}

// ---------- Safety card ----------

function SafetyView({ ctx, big }: { ctx: BlockContext<Record<string, never>>; big?: boolean }) {
  const r = ctx.inputs.report?.kind === 'report' ? ctx.inputs.report : null
  return (
    <div className={wrap(big)}>
      <div className="bx-head">
        <span className="bx-icon">🛡</span>
        <span className="bx-title">
          <strong>Safety{r?.token ? ` · ${r.token.symbol}` : ''}</strong>
          {r && <small>{r.sources.join(' · ')}</small>}
        </span>
      </div>
      <div className="bx-body">
        {!r ? <Empty>Wire a Safety report in.</Empty> : <SafetySummary report={r} big={big} />}
      </div>
    </div>
  )
}

export const safetyCard: BlockDefinition<Record<string, never>> = {
  type: 'safetyCard',
  label: 'Safety card',
  description: 'The verdict, flags and facts of a Safety check',
  icon: '🛡',
  category: 'show',
  defaultProps: {},
  settings: [],
  inlets: [{ id: 'report', label: 'A Safety report', types: ['report'] }],
  outlets: [],
  Render: (p) => <SafetyView {...p} />,
  Widget: (p) => <SafetyView {...p} big />,
}

export const showBlocks = [chart, numberTile, table, tokenCard, safetyCard] as unknown as BlockDefinition<BlockProps>[]
