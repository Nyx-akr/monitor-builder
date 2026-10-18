import { useEffect, useSyncExternalStore } from 'react'
import type { BlockContext, BlockDefinition, BlockProps } from '../types'
import { formatValue } from '../../core/show'
import { parseNumber } from '../../lib/parseNumber'
import { timeOf } from '../../core/lastSent'
import { Box, Empty } from '../shared'

/**
 * Rules: the one place where "something happened" matters. An Alert watches a number (or a list) and fires
 * when its condition *becomes* true — into the Alert log, and as a browser notification if allowed.
 * (Alerts run while the app is open; server-side alerts and Telegram come next.)
 */

// ---------- the alert log (shared by every Alert) ----------

interface Fired {
  at: number
  title: string
  text: string
}
let fired: Fired[] = []
const listeners = new Set<() => void>()
const pushAlert = (a: Fired, notify = true) => {
  fired = [a, ...fired].slice(0, 200)
  listeners.forEach((l) => l())
  if (notify && typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(a.title, { body: a.text })
}
const useAlerts = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => fired,
  )

// ---------- Alert ----------

type AlertProps = { mode: string; threshold: string; title: string; notify: boolean }

const MODES = [
  { value: 'above', label: 'Goes above' },
  { value: 'below', label: 'Goes below' },
  { value: 'moves', label: 'Moves by more than (%) since the last alert' },
  { value: 'newRows', label: 'A new token appears in the list' },
]

/** What each Alert saw last: its value, whether its condition held, and the tokens it has seen. */
const memory = new Map<string, { value?: number | null; holds?: boolean; base?: number; seen?: Set<string> }>()

function AlertView({ props, ctx }: { props: AlertProps; ctx: BlockContext<AlertProps> }) {
  const v = ctx.inputs.value?.kind === 'number' ? ctx.inputs.value : null
  const list = ctx.inputs.list?.kind === 'table' ? ctx.inputs.list : null
  const limit = parseNumber(props.threshold)
  const name = props.title || v?.label || 'Alert'

  useEffect(() => {
    const m = memory.get(ctx.id) ?? {}
    memory.set(ctx.id, m)
    if (props.mode === 'newRows') {
      if (!list) return
      const ids = list.rows.map((r) => r.token?.id).filter((x): x is string => Boolean(x))
      if (!m.seen) return void (m.seen = new Set(ids)) // the first list is the baseline
      const fresh = list.rows.filter((r) => r.token && !m.seen!.has(r.token.id))
      fresh.forEach((r) => m.seen!.add(r.token!.id))
      if (fresh.length) pushAlert({ at: Date.now(), title: name, text: `New: ${fresh.map((r) => r.token!.symbol).join(', ')}` }, props.notify)
      return
    }
    if (!v || v.value == null || limit == null) return
    if (props.mode === 'moves') {
      if (m.base == null) return void (m.base = v.value)
      const move = m.base ? (v.value / m.base - 1) * 100 : 0
      if (Math.abs(move) >= Math.abs(limit)) {
        pushAlert({ at: Date.now(), title: name, text: `${move >= 0 ? 'Up' : 'Down'} ${formatValue(Math.abs(move), 'pct').replace('+', '')} to ${formatValue(v.value, v.unit)}` }, props.notify)
        m.base = v.value
      }
      return
    }
    const holds = props.mode === 'below' ? v.value < limit : v.value > limit
    // Fires on the change from "not" to "yes" — not again while it stays true.
    if (holds && m.holds === false) pushAlert({ at: Date.now(), title: name, text: `${props.mode === 'below' ? 'Below' : 'Above'} ${props.threshold}: now ${formatValue(v.value, v.unit)}` }, props.notify)
    m.holds = holds
    m.value = v.value
  }, [v?.value, list, props.mode, limit, ctx.id, name, props.threshold, v?.unit, v, props.notify])

  const holdsNow = props.mode === 'below' ? (v?.value ?? Infinity) < (limit ?? -Infinity) : props.mode === 'above' ? (v?.value ?? -Infinity) > (limit ?? Infinity) : false
  return (
    <Box
      icon="🔔"
      title={name}
      sub={`${MODES.find((m) => m.value === props.mode)?.label ?? props.mode}${props.mode !== 'newRows' ? ` ${props.threshold}` : ''}`}
      status={<span className={`bx-status${holdsNow ? ' warn' : ''}`}>{holdsNow ? 'True now' : ''}</span>}
    >
      {props.mode === 'newRows' ? (
        list ? <div className="bx-sub">Watching {list.rows.length} tokens</div> : <Empty>Wire a list in.</Empty>
      ) : v ? (
        <div className="bx-row">
          <span>Now</span>
          <b>{formatValue(v.value, v.unit)}</b>
        </div>
      ) : (
        <Empty>Wire a number in.</Empty>
      )}
    </Box>
  )
}

export const alert: BlockDefinition<AlertProps> = {
  type: 'alert',
  label: 'Alert',
  description: 'Fire when a value crosses a level, moves, or a new token appears',
  icon: '🔔',
  category: 'rules',
  defaultProps: { mode: 'above', threshold: '0', title: '', notify: true },
  settings: [
    { key: 'title', label: 'Name', type: 'text', placeholder: 'e.g. BONK breakout' },
    { key: 'mode', label: 'When the value…', type: 'select', options: MODES },
    { key: 'threshold', label: 'Level / %', type: 'text', placeholder: 'e.g. 0.00003, 50k, 5', help: 'For “moves”: the % move that fires it.' },
    { key: 'notify', label: 'Also show a browser notification', type: 'toggle' },
  ],
  inlets: [
    { id: 'value', label: 'A number to watch', types: ['number'] },
    { id: 'list', label: 'A list (for “a new token appears”)', types: ['table'] },
  ],
  outlets: [{ id: 'holds', label: 'Whether the condition is true right now', types: ['bool'] }],
  compute: ({ props, inputs }) => {
    const v = inputs.value?.kind === 'number' ? inputs.value.value : null
    const limit = parseNumber(props.threshold)
    if (v == null || limit == null || (props.mode !== 'above' && props.mode !== 'below')) return {}
    return { holds: { kind: 'bool', value: props.mode === 'below' ? v < limit : v > limit, label: props.title || 'Alert' } }
  },
  menu: [
    {
      label: 'Allow browser notifications',
      run: () => {
        if (typeof Notification !== 'undefined') void Notification.requestPermission()
      },
    },
  ],
  Render: AlertView,
}

// ---------- Alert log ----------

function LogView({ big }: { big?: boolean }) {
  const alerts = useAlerts()
  return (
    <div className={`bx${big ? ' fill' : ''}`}>
      <div className="bx-head">
        <span className="bx-icon">📜</span>
        <span className="bx-title">
          <strong>Alert log</strong>
          <small>{alerts.length} alert{alerts.length === 1 ? '' : 's'}</small>
        </span>
      </div>
      <div className="bx-body scroll-y" style={{ maxHeight: big ? undefined : 220, overflowY: 'auto' }}>
        {alerts.length ? (
          alerts.slice(0, big ? 200 : 20).map((a, i) => (
            <div key={i} className="bx-alert">
              <small>{timeOf(a.at)}</small>
              <b>{a.title}</b> — {a.text}
            </div>
          ))
        ) : (
          <Empty>Alerts appear here when they fire.</Empty>
        )}
      </div>
    </div>
  )
}

export const alertLog: BlockDefinition<Record<string, never>> = {
  type: 'alertLog',
  label: 'Alert log',
  description: 'Every alert that fired',
  icon: '📜',
  category: 'rules',
  defaultProps: {},
  settings: [],
  outlets: [],
  menu: [
    {
      label: 'Clear the log',
      run: () => {
        fired = []
        listeners.forEach((l) => l())
      },
    },
  ],
  Render: () => <LogView />,
  Widget: () => <LogView big />,
}

export const ruleBlocks = [alert, alertLog] as unknown as BlockDefinition<BlockProps>[]
