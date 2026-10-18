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

/** The whole history, oldest first. */
async function sendHistory(ctx: BlockContext<Props>) {
  if (!ctx.props.store) return ctx.send('history', [])
  try {
    const records = await readRecords(ctx.props.store, 0)
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
  defaultProps: { store: '', keepLimit: 0, historyOnStore: true },
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
  ],
  outlets: [
    { id: 'out', label: 'what just arrived, passed straight on', types: ['any'] },
    {
      id: 'history',
      label: 'history — the stored batches as a History (dated rows { at, type, data }), oldest first: the whole history when wired or on a signal; after that, each new batch by itself',
      types: ['history'],
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
  receive: (ctx, _inlet, msg) => (msg === 'bang' ? sendHistory(ctx) : store(ctx, msg)),
  // Wiring history into something (e.g. a Chart) fills it right away.
  onWired: (ctx, outlet) => {
    if (outlet === 'history') sendHistory(ctx)
  },
  Render: StorageBox,
}
