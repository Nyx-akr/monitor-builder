import { useEffect, useState } from 'react'
import type { BlockContext, BlockDefinition, Message } from '../../blocks/types'
import { typeOfMessage } from '../../core/dataTypes'
import { previewLines } from '../../core/lastSent'
import {
  appendRecord,
  clearStore,
  createStore,
  formatBytes,
  readRecords,
  recordDate,
  storeList,
  trimStore,
  useStores,
  type StoreRecord,
} from '../../services/storage'
import './storage.css'

type Props = {
  /** The storage file this block writes to: flows/storage/<store>.jsonl. */
  store: string
  /** How many of the newest records a signal sends out of `history` (0 = all). */
  historyLimit?: number
  /** How far back history goes ('all', '30d', '7d', '24h', '4h', '1h'). */
  historyWindow: string
  /** At most this many batches per history, spread evenly over its time span. */
  historyMax: number
  /** How many of the newest records the file keeps — older ones are removed (0 = keep everything). */
  keepLimit: number
  /** Send the history out again after every new batch (so a Chart follows along). */
  historyOnStore: boolean
}

const limitOf = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0))

/** Wait this long after History to save is edited before trimming, so typing "100" never trims to 1 first. */
const TRIM_DELAY_MS = 1500

/** How many recent batches the box shows. */
const RECENT = 3

/** A short line per recent batch: its date and what it was (e.g. "table · 250 rows"). */
type Recent = { at: string; text: string }
const recent = new Map<string, Recent[]>()
type Status = { recent: Recent[]; saving: boolean; error?: string }
const listeners = new Map<string, (s: Status) => void>()
const report = (id: string, s: Partial<Status>) => {
  const cur = { recent: recent.get(id) ?? [], saving: false, ...s }
  listeners.get(id)?.(cur)
}

const toRecent = (r: { at: string; data: Message }): Recent => ({ at: r.at, text: previewLines(r.data).slice(0, 2).join(' — ') })

/** A block placed while the server was down has no file yet: make one on its first data. */
const creating = new Map<string, Promise<string>>()
function ensureStore(ctx: BlockContext<Props>): Promise<string> {
  if (ctx.props.store) return Promise.resolve(ctx.props.store)
  if (!creating.has(ctx.id)) {
    const p = createStore().then((info) => {
      ctx.update({ store: info.name })
      return info.name
    })
    p.finally(() => creating.delete(ctx.id))
    creating.set(ctx.id, p)
  }
  return creating.get(ctx.id)!
}

async function store(ctx: BlockContext<Props>, msg: Message) {
  // Hot like every input: what arrives goes straight on, and is saved alongside.
  ctx.send('out', msg)
  const at = new Date().toISOString()
  // The box never shows more batches than the file keeps.
  const shown = Math.min(RECENT, limitOf(ctx.props.keepLimit) || RECENT)
  recent.set(ctx.id, [...(recent.get(ctx.id) ?? []), toRecent({ at, data: msg })].slice(-shown))
  report(ctx.id, { saving: true })
  try {
    const name = await ensureStore(ctx)
    await appendRecord(name, typeOfMessage(msg), msg, limitOf(ctx.props.keepLimit))
    report(ctx.id, {})
    // Older Storages have no such setting yet: on.
    // After the full history (sent when wired / on a signal), each new batch is sent on by itself:
    // a Chart adds it to what it has instead of receiving everything again.
    if (ctx.props.historyOnStore !== false) ctx.send('history', [{ at, type: typeOfMessage(msg), data: msg }])
  } catch (e) {
    report(ctx.id, { error: (e as Error).message })
  }
}

/** How far back history goes. */
const WINDOWS: { value: string; label: string; ms: number }[] = [
  { value: 'all', label: 'Everything stored', ms: 0 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 86400e3 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86400e3 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 3600e3 },
  { value: '4h', label: 'Last 4 hours', ms: 4 * 3600e3 },
  { value: '1h', label: 'Last hour', ms: 3600e3 },
  { value: '15m', label: 'Last 15 minutes', ms: 15 * 60e3 },
  { value: '5m', label: 'Last 5 minutes', ms: 5 * 60e3 },
]
const DEFAULT_MAX = 500

/** The whole history (within its time span, at most historyMax batches spread evenly), oldest first. */
async function sendHistory(ctx: BlockContext<Props>, windowValue = ctx.props.historyWindow) {
  if (!ctx.props.store) return ctx.send('history', [])
  try {
    const window = WINDOWS.find((w) => w.value === (windowValue ?? 'all')) ?? WINDOWS[0]
    const max = limitOf(ctx.props.historyMax ?? DEFAULT_MAX) || DEFAULT_MAX
    const records = await readRecords(ctx.props.store, 0, { since: window.ms ? Date.now() - window.ms : 0, max })
    ctx.send('history', records as unknown as Message)
  } catch (e) {
    report(ctx.id, { error: (e as Error).message })
  }
}

function StorageBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [status, setStatus] = useState<Status>({ recent: recent.get(ctx.id) ?? [], saving: false })
  const info = useStores().find((s) => s.name === props.store)

  useEffect(() => {
    listeners.set(ctx.id, setStatus)
    return () => {
      listeners.delete(ctx.id)
    }
  }, [ctx.id])

  // Show the newest batches already in the file (on open, or after switching to another storage).
  useEffect(() => {
    if (!props.store) return
    let live = true
    readRecords(props.store, RECENT)
      .then((records: StoreRecord[]) => {
        if (!live) return
        recent.set(ctx.id, records.map(toRecent))
        report(ctx.id, {})
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [props.store, ctx.id])

  // History to save lowered (or a file already longer than it): remove the oldest batches.
  const keep = limitOf(props.keepLimit)
  useEffect(() => {
    if (!props.store || !keep) return
    const t = setTimeout(() => {
      trimStore(props.store, keep)
        .then(() => readRecords(props.store, RECENT))
        .then((records) => {
          recent.set(ctx.id, records.map(toRecent))
          report(ctx.id, {})
        })
        .catch((e) => report(ctx.id, { error: (e as Error).message }))
    }, TRIM_DELAY_MS)
    return () => clearTimeout(t)
  }, [props.store, keep, ctx.id])

  const entries = info?.entries ?? 0
  return (
    <div className={`storage-box${status.error ? ' failed' : ''}`} title={status.error ?? `Saved in flows/storage/${props.store || '…'}.jsonl`}>
      <div className="storage-head">
        <span className="storage-name">storage</span>
        <span className="storage-file">{props.store || 'new'}</span>
        <span className={`storage-dot${status.saving ? ' saving' : ''}`} />
      </div>
      <div className="storage-size">
        {entries.toLocaleString('en-US')}
        {keep ? ` / ${keep.toLocaleString('en-US')}` : ''} {(keep || entries) === 1 ? 'batch' : 'batches'} · {formatBytes(info?.bytes ?? 0)}
      </div>
      {status.recent.length > 0 ? (
        <ul className="storage-recent">
          {[...status.recent].reverse().map((r, i) => (
            <li key={`${r.at}-${i}`}>
              <span className="storage-at">{recordDate(r.at)}</span>
              <span className="storage-what">{r.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="storage-empty">Nothing stored yet — wire data in</div>
      )}
    </div>
  )
}

export const storage: BlockDefinition<Props> = {
  type: 'storage',
  label: 'Storage',
  description: 'Keep a dated history of everything sent to it',
  icon: '🗄',
  category: 'objects',
  defaultProps: { store: '', historyWindow: 'all', historyMax: DEFAULT_MAX, keepLimit: 0, historyOnStore: true },
  // Each new Storage gets its own file; a copy starts its own history too.
  prepare: async (props, reason) => (reason === 'add' && props.store ? null : { store: (await createStore()).name }),
  settings: [],
  settingsFor: (props) => {
    const names = storeList().map((s) => s.name)
    if (props.store && !names.includes(props.store)) names.unshift(props.store)
    return [
      {
        key: 'store',
        label: 'Storage file',
        type: 'select',
        options: names.map((n) => ({ value: n, label: n })),
        help: `Saved in flows/storage/${props.store || '…'}.jsonl — one dated line per batch received. Pick another file to write to it instead.`,
      },
      {
        key: 'keepLimit',
        label: 'History to save',
        type: 'number',
        min: 0,
        help: 'How many batches the file keeps: once it’s full, each new batch removes the oldest one. 0 = keep everything (no limit). Lowering it deletes the oldest batches over the limit.',
      },
      {
        key: 'historyWindow',
        label: 'History to send',
        type: 'select',
        options: WINDOWS.map(({ value, label }) => ({ value, label })),
        help: 'How far back history goes when it’s sent (when wired, on a signal, or Send history).',
      },
      {
        key: 'historyMax',
        label: 'Most batches to send',
        type: 'number',
        min: 2,
        help: `A long history is thinned to this many batches, spread evenly over its whole time span (the newest always included), so it stays quick. Default ${DEFAULT_MAX}.`,
      },
      {
        key: 'historyOnStore',
        label: 'Send each new batch on history',
        type: 'toggle',
        help: 'So a Chart wired to history keeps following: each new batch goes out by itself and the chart adds it to what it has.',
      },
    ]
  },
  inlets: [
    {
      id: 'in',
      label: 'data — anything arriving is stored with its date and time, and sent straight on · a signal sends the history instead',
      types: ['string', 'number', 'table', 'bang'],
    },
    {
      id: 'timeframe',
      label: 'timeframe — how far back history goes (5m, 15m, 1h, 4h, 24h, 7d, 30d, all), e.g. from a Chart’s timeframe: sets History to send and sends that span',
      types: ['string'],
    },
  ],
  outlets: [
    { id: 'out', label: 'what just arrived, passed straight on', types: ['any'] },
    {
      id: 'history',
      label: 'history — a list of { at, type, data }, oldest first: the whole history when wired or on a signal; after that, each new batch by itself',
      types: ['table'],
    },
  ],
  menu: [
    { label: 'Send history', run: (ctx) => sendHistory(ctx) },
    {
      label: 'Clear history…',
      run: (ctx) => {
        if (!ctx.props.store || !confirm(`Delete every batch stored in ${ctx.props.store}? This can’t be undone.`)) return
        clearStore(ctx.props.store)
          .then(() => {
            recent.delete(ctx.id)
            report(ctx.id, {})
          })
          .catch((e) => report(ctx.id, { error: (e as Error).message }))
      },
    },
  ],
  receive: (ctx, inlet, msg) => {
    // A timeframe (e.g. a Chart's): the history it asks for is cut here, and sent at once.
    if (inlet === 'timeframe') {
      const value = String(msg).trim().toLowerCase()
      if (!WINDOWS.some((w) => w.value === value)) return
      if (value !== ctx.props.historyWindow) ctx.update({ historyWindow: value })
      return sendHistory(ctx, value)
    }
    return msg === 'bang' ? sendHistory(ctx) : store(ctx, msg)
  },
  // Wiring history into something (e.g. a Chart) fills it right away.
  onWired: (ctx, outlet) => {
    if (outlet === 'history') sendHistory(ctx)
  },
  Render: StorageBox,
}
