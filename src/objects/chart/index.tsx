import { useEffect, useRef, useState } from 'react'
import type { BlockContext, BlockDefinition, Port } from '../../blocks/types'
import {
  CANDLE_SIZES,
  ChartView,
  DEFAULT_TOKENS,
  MAX_LINES,
  STYLES,
  TIMEFRAMES,
  mergeLines,
  timeframeOf,
  parseSeries,
  toLines,
  type ChartStyle,
  type Series,
} from '../../charts'

/** The Chart object: settings, inputs and the points it holds. Drawing is the chart module's (src/charts). */
type Props = {
  /** How many inputs (1–6). */
  lines: number
  /** Names for the inputs' own lines in the guide, comma separated ("BTC, ETH"). */
  names: string
  /** When the data is a dict or a list of tokens, the item to plot. */
  field: string
  /** When the data is a list of tokens: which tokens get a line ("NUBI, DAWG"). */
  tokens: string
  /** Line, area or candles. */
  style: string
  /** Candle period ('auto' = about 40 candles). */
  candle: string
  /** How far back to show. */
  timeframe: string
  /** 'value': one shared scale · 'percent': each line as % change from its first point in view. */
  scale: string
  /** The points, as JSON — saved with the flow. */
  points: string
}

const MIN_LINES = 1
const lineCount = (props: Props) => Math.min(MAX_LINES, Math.max(MIN_LINES, Math.floor(Number(props.lines) || MIN_LINES)))
const inletId = (i: number) => `line${i + 1}`
const nameOf = (props: Props, i: number) => String(props.names ?? '').split(',').map((s) => s.trim())[i] || `Line ${i + 1}`

/** What each chart holds right now (the saved copy in props lags a render behind). */
const held = new Map<string, Series>()
const listeners = new Map<string, (s: Series) => void>()
const seriesOf = (ctx: BlockContext<Props>) => {
  if (!held.has(ctx.id)) held.set(ctx.id, parseSeries(ctx.props.points, inletId))
  return held.get(ctx.id)!
}

function save(ctx: BlockContext<Props>, next: Series) {
  held.set(ctx.id, next)
  listeners.get(ctx.id)?.(next)
  ctx.update({ points: JSON.stringify(next) })
}

function ChartBlock({ props, ctx, big }: { props: Props; ctx: BlockContext<Props>; big?: boolean }) {
  const [series, setSeries] = useState<Series>(() => seriesOf(ctx))
  useEffect(() => {
    listeners.set(ctx.id, setSeries)
    return () => {
      listeners.delete(ctx.id)
    }
  }, [ctx.id])

  // The chosen timeframe goes out (when the flow opens, and on every change): a Storage wired to it sends
  // just that span of its history — the cropping happens there.
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  useEffect(() => {
    ctxRef.current.send('timeframe', timeframeOf(props.timeframe).value)
  }, [props.timeframe])

  // Input by input: its own line, or one line per token it carried; an input with nothing yet still gets
  // a guide entry ("no data"). At most one line per colour.
  // Tokens named in Settings always get a guide entry on an input that carries tokens ("no data" if
  // that token isn't in the data — e.g. it dropped out of the list).
  const named = String(props.tokens ?? '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
  const keys = Array.from({ length: lineCount(props) }, (_, i) => {
    const own = Object.keys(series).filter((k) => k === inletId(i) || k.startsWith(`${inletId(i)}:`))
    const tokenLines = own.filter((k) => k.includes(':'))
    if (tokenLines.length && named.length) return named.map((t) => `${inletId(i)}:${t}`)
    return own.length ? own : [inletId(i)]
  })
    .flat()
    .slice(0, MAX_LINES)
  const lines = keys.map((key) => {
    const [inlet, token] = key.split(':')
    return { key, label: token ?? nameOf(props, Number(inlet.replace('line', '')) - 1), points: series[key] ?? [] }
  })
  const hasData = Object.values(series).some((s) => s?.length)

  return (
    <ChartView
      lines={lines}
      style={(STYLES.some((s) => s.value === props.style) ? props.style : 'line') as ChartStyle}
      timeframe={props.timeframe}
      asPercent={props.scale === 'percent'}
      candleSize={props.candle}
      big={big}
      emptyText={
        hasData
          ? 'Nothing in this timeframe — pick a longer one in the right panel'
          : 'Wire a Storage’s history (or live numbers) into the chart’s inputs — one per line'
      }
    />
  )
}

export const chart: BlockDefinition<Props> = {
  type: 'chart',
  label: 'Chart',
  description: 'Draw values over time — line, area or candles',
  icon: '📈',
  category: 'objects',
  defaultProps: { lines: 1, names: '', field: 'price', tokens: '', style: 'line', candle: 'auto', timeframe: '1h', scale: 'value', points: '' },
  settingsFor: (props) => [
    { key: 'style', label: 'Chart style', type: 'select', options: STYLES },
    ...(props.style === 'candle'
      ? [{ key: 'candle', label: 'Candle size', type: 'select' as const, options: CANDLE_SIZES, help: 'Each candle is one period: its first, highest, lowest and last value.' }]
      : []),
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
    { key: 'lines', label: 'Inputs', type: 'number', min: MIN_LINES, max: MAX_LINES, help: 'How many inputs (1–6). Each draws its own line — or one per token when it carries token lists.' },
    { key: 'names', label: 'Line names', type: 'text', placeholder: 'e.g. BTC, ETH', help: 'Guide names for the inputs’ own lines, comma separated, in input order (token lines use the token’s symbol).' },
    {
      key: 'tokens',
      label: 'Tokens (for lists)',
      type: 'text',
      placeholder: 'e.g. NUBI, DAWG',
      help: `When the data is a list of tokens (e.g. a Storage of a card’s list): the tokens to draw, one line each, by symbol. Empty: the first ${DEFAULT_TOKENS} of the newest list.`,
    },
    {
      key: 'field',
      label: 'Field',
      type: 'text',
      placeholder: 'price',
      help: 'When the data is a dict or a list of tokens: the item to plot (price, marketCap, volume24h…).',
    },
  ],
  settings: [],
  ports: (props) => ({
    inlets: Array.from(
      { length: lineCount(props) },
      (_, i): Port => ({
        id: inletId(i),
        label: `${nameOf(props, i)} — a Storage’s history redraws this input’s lines (a history of token lists draws one line per token); a number or dict adds a point now`,
        types: ['table', 'number', 'string'],
      }),
    ),
  }),
  outlets: [
    {
      id: 'timeframe',
      label: 'timeframe — the chosen timeframe (5m, 15m, 1h, 4h, 24h, 7d, 30d, all), sent on every change — wire into a Storage’s timeframe so it sends just that span',
      types: ['string'],
    },
  ],
  // Wiring timeframe somewhere sends the current one straight away.
  onWired: (ctx, outlet) => {
    if (outlet === 'timeframe') ctx.send('timeframe', timeframeOf(ctx.props.timeframe).value)
  },
  menu: [{ label: 'Clear chart', run: (ctx) => save(ctx, {}) }],
  receive: (ctx, inlet, msg) => {
    const i = Number(inlet.replace('line', '')) - 1
    if (!(i >= 0 && i < MAX_LINES) || msg === 'bang') return
    const [incoming, replace] = toLines(inlet, msg, String(ctx.props.field ?? 'price'), String(ctx.props.tokens ?? ''))
    if (!Object.keys(incoming).length && !replace) return
    save(ctx, mergeLines(seriesOf(ctx), inlet, incoming, replace))
  },
  Render: (p) => <ChartBlock {...p} />,
  Widget: (p) => <ChartBlock {...p} big />,
}
