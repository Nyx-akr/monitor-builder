import type { SaveStatus } from './useFlow'

const NEW = '__new__'

const STATUS_TEXT: Record<SaveStatus, string> = {
  loading: 'Loading…',
  saved: 'Saved',
  unsaved: 'Unsaved',
  saving: 'Saving…',
  error: 'Save failed',
}

/** Picks which flows/<name>.json is open, creates new flows, and shows autosave state. */
export function FlowSelector({
  flows,
  current,
  status,
  error,
  onSwitch,
  onNew,
  onSave,
}: {
  flows: string[]
  current: string | null
  status: SaveStatus
  error: string | null
  onSwitch: (name: string) => void
  onNew: () => void
  onSave: () => void
}) {
  return (
    <div className="flow-selector">
      <button
        className={`flow-status ${status}`}
        onClick={onSave}
        title={error ?? (current ? `Autosaves to flows/${current}.json · click or ⌘S to save now` : '')}
      >
        <span className="dot" /> {STATUS_TEXT[status]}
      </button>
      <select
        value={current ?? ''}
        onChange={(e) => (e.target.value === NEW ? onNew() : onSwitch(e.target.value))}
        title="Switch flow"
      >
        {!current && <option value="">—</option>}
        {flows.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
        <option disabled>──────────</option>
        <option value={NEW}>+ New blank flow</option>
      </select>
    </div>
  )
}
