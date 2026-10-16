import { useEffect, useState } from 'react'
import type { BlockContext, BlockDefinition, Message } from '../../types'
import './clock.css'

type Props = {
  /** Seconds between bangs. */
  intervalSec: number
  /** How many bangs per run; 0 = keep going forever. */
  count: number
  /** Start ticking as soon as the flow is opened. */
  autostart: boolean
}

/** Fastest allowed tick — anything quicker would flood the wires (and the APIs behind the cards). */
const MIN_INTERVAL_SEC = 0.1

interface Run {
  timer: ReturnType<typeof setTimeout>
  ticks: number
}

/** Running clocks by block id. Kept outside React so a tick never depends on a render. */
const runs = new Map<string, Run>()
type Status = { running: boolean; ticks: number; pulse: number }
const listeners = new Map<string, (s: Status) => void>()
const report = (id: string, s: Status) => listeners.get(id)?.(s)

const intervalMs = (props: Props) => Math.max(MIN_INTERVAL_SEC, Number(props.intervalSec) || 1) * 1000

function tick(ctx: BlockContext<Props>) {
  const run = runs.get(ctx.id)
  if (!run) return
  const total = Math.max(0, Math.floor(Number(ctx.props.count) || 0))
  const n = run.ticks
  run.ticks += 1
  report(ctx.id, { running: true, ticks: run.ticks, pulse: run.ticks })
  // Right to left, like Max: the tick number, then the bang.
  ctx.send('tick', n)
  ctx.send('out', 'bang')
  if (total > 0 && run.ticks >= total) {
    stop(ctx.id)
    ctx.send('done', 'bang')
    return
  }
  run.timer = setTimeout(() => tick(ctx), intervalMs(ctx.props))
}

/** One signal, as if the timer ticked once — clicking the box does this. */
function fireOnce(ctx: BlockContext<Props>) {
  const run = runs.get(ctx.id)
  report(ctx.id, { running: Boolean(run), ticks: run?.ticks ?? 0, pulse: Date.now() })
  ctx.send('out', 'bang')
}

/** Start (or restart) the timer: a signal immediately, then every interval. */
function start(ctx: BlockContext<Props>) {
  stop(ctx.id, false)
  runs.set(ctx.id, { timer: setTimeout(() => {}, 0), ticks: 0 })
  tick(ctx)
}

function stop(id: string, notify = true) {
  const run = runs.get(id)
  if (run) clearTimeout(run.timer)
  runs.delete(id)
  if (notify) report(id, { running: false, ticks: run?.ticks ?? 0, pulse: 0 })
}

/** A new interval takes effect on the next tick, without restarting the count. */
function retime(ctx: BlockContext<Props>) {
  const run = runs.get(ctx.id)
  if (!run) return
  clearTimeout(run.timer)
  run.timer = setTimeout(() => tick(ctx), intervalMs(ctx.props))
}

function ClockBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [status, setStatus] = useState<Status>({ running: runs.has(ctx.id), ticks: runs.get(ctx.id)?.ticks ?? 0, pulse: 0 })

  useEffect(() => {
    listeners.set(ctx.id, setStatus)
    if (props.autostart && !runs.has(ctx.id)) start(ctx)
    return () => {
      listeners.delete(ctx.id)
      // Block deleted or flow closed: a clock must not keep firing into nothing.
      stop(ctx.id, false)
    }
    // Mount/unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.id])

  const total = Math.max(0, Math.floor(Number(props.count) || 0))
  const secs = Math.max(MIN_INTERVAL_SEC, Number(props.intervalSec) || 1)
  // Interval edited in the right panel while running: apply it from now, without restarting the count.
  useEffect(() => {
    if (runs.has(ctx.id)) retime(ctx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.intervalSec])

  return (
    <div
      className={`clock-box${status.running ? ' running' : ''}`}
      onClick={() => fireOnce(ctx)}
      title="Click to send one signal · ▶ to keep sending every interval"
    >
      <button
        className="clock-toggle"
        onClick={(e) => {
          e.stopPropagation() // the play button starts/stops; it doesn't also send a single signal
          return status.running ? stop(ctx.id) : start(ctx)
        }}
        title={status.running ? 'Stop' : 'Start repeating'}
      >
        {status.running ? '■' : '▶'}
      </button>
      <span className="clock-name">timer</span>
      <span className="clock-args">{secs}s</span>
      <span className="clock-count">
        {status.ticks} / {total > 0 ? total : '∞'}
      </span>
      <span key={status.pulse} className={`clock-dot${status.pulse ? ' pulse' : ''}`} />
    </div>
  )
}

const isStop = (msg: Message) => msg === 0 || msg === '0' || msg === 'stop' || msg === false
const isStart = (msg: Message) => msg === 1 || msg === '1' || msg === 'start' || msg === true

export const clock: BlockDefinition<Props> = {
  type: 'clock',
  label: 'Timer',
  description: 'Click to send once · ▶ to repeat every N seconds',
  icon: '⏱',
  category: 'objects',
  defaultProps: { intervalSec: 5, count: 0, autostart: false },
  settings: [
    { key: 'intervalSec', label: 'Interval (seconds)', type: 'number', min: MIN_INTERVAL_SEC, help: 'Time between signals while playing. Decimals work (0.5 = twice a second). Changes apply right away.' },
    { key: 'count', label: 'Count', type: 'number', min: 0, help: '0 = forever (default). Otherwise stops after this many signals and sends done.' },
    { key: 'autostart', label: 'Start when the flow opens', type: 'toggle' },
  ],
  inlets: [
    { id: 'in', label: '"start" / 1 starts repeating, "stop" / 0 stops — anything else arriving (a signal, text, data) sends one signal', types: ['any'] },
    { id: 'interval', label: 'interval — seconds between signals; applies right away', types: ['number'] },
  ],
  outlets: [
    { id: 'out', label: 'a signal on every tick (and on a click)', types: ['bang'] },
    { id: 'tick', label: 'tick number, counting from 0', types: ['number'] },
    { id: 'done', label: 'a signal when a counted run finishes', types: ['bang'] },
  ],
  menu: [
    { label: 'Send once', run: (ctx) => fireOnce(ctx) },
    { label: 'Start', run: (ctx) => start(ctx) },
    { label: 'Stop', run: (ctx) => stop(ctx.id) },
  ],
  receive: (ctx, inlet, msg) => {
    if (inlet === 'interval') {
      const secs = Number(msg)
      if (Number.isFinite(secs) && secs > 0) {
        ctx.update({ intervalSec: Math.max(MIN_INTERVAL_SEC, secs) })
        retime(ctx)
      }
      return
    }
    // Only the words start / stop (or 1 / 0) control the timer; anything else arriving — a signal, text,
    // data — sends one signal, so "data arrived" can trigger whatever is wired after it.
    if (isStop(msg)) return stop(ctx.id)
    if (isStart(msg)) return start(ctx)
    fireOnce(ctx)
  },
  Render: ClockBox,
}
