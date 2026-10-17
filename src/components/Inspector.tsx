import { blockByType } from '../blocks/registry'
import type { BlockInstance, BlockProps, SettingField, Wire } from '../blocks/types'
import { TokenSearch } from './TokenSearch'
import { CoinSearch } from './CoinSearch'
import { portsOf } from '../core/ports'
import { TYPE_COLORS, TYPE_LABELS, ERROR_COLOR, typesOf } from '../core/dataTypes'

function Field({ field, value, onChange }: { field: SettingField; value: BlockProps[string]; onChange: (v: BlockProps[string]) => void }) {
  let input
  switch (field.type) {
    case 'text':
      input = <input type="text" value={String(value ?? '')} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      break
    case 'number':
      input = (
        <input
          type="number"
          value={Number(value ?? 0)}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )
      break
    case 'select':
      input = (
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
      break
    case 'tokenSearch':
    case 'coinSearch':
      // Rendered by the Inspector directly since they write several props.
      return null
    case 'toggle':
      return (
        <label className="field toggle">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span>{field.label}</span>
        </label>
      )
  }
  return (
    <label className="field">
      <span>{field.label}</span>
      {input}
      {field.help && <small>{field.help}</small>}
    </label>
  )
}

/** Lists a block's inlets and outlets with what each is wired to, so wires can be cut from here too. */
function PortList({
  block,
  blocks,
  wires,
  onDisconnect,
}: {
  block: BlockInstance
  blocks: BlockInstance[]
  wires: Wire[]
  onDisconnect: (wireId: string) => void
}) {
  const def = portsOf(block)
  const labelOf = (id: string) => {
    const b = blocks.find((x) => x.id === id)
    return b ? blockByType[b.type].label : '?'
  }
  const rows = [
    ...(def.inlets ?? []).map((p) => ({
      kind: 'in' as const,
      port: p,
      links: wires.filter((w) => w.to.block === block.id && w.to.port === p.id).map((w) => ({ wire: w, other: `${labelOf(w.from.block)} · ${w.from.port}` })),
    })),
    ...(def.outlets ?? []).map((p) => ({
      kind: 'out' as const,
      port: p,
      links: wires.filter((w) => w.from.block === block.id && w.from.port === p.id).map((w) => ({ wire: w, other: `${labelOf(w.to.block)} · ${w.to.port}` })),
    })),
  ]
  if (rows.length === 0) return null

  return (
    <div className="ports-panel">
      <h3>Ports</h3>
      {rows.map(({ kind, port, links }) => (
        <div key={`${kind}:${port.id}`} className="port-row">
          <div className="port-name">
            <span className={`port-badge ${kind}`}>{kind === 'in' ? 'inlet' : 'outlet'}</span>
            <strong>{port.id}</strong>
            <span className="type-chips">
              {typesOf(port).map((t) => (
                <span key={t} className="type-chip" style={{ color: port.error ? ERROR_COLOR : TYPE_COLORS[t] }}>
                  {port.error ? 'error' : TYPE_LABELS[t]}
                </span>
              ))}
            </span>
          </div>
          <small>{port.label}</small>
          {links.length === 0 ? (
            <small className="muted">Not connected — drag {kind === 'in' ? 'an outlet onto it' : 'it onto an inlet'}</small>
          ) : (
            links.map(({ wire, other }) => (
              <div key={wire.id} className="port-link">
                <span>
                  {kind === 'in' ? '←' : '→'} {other}
                </span>
                <button className="ts-clear" title="Disconnect" onClick={() => onDisconnect(wire.id)}>
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  )
}

export function Inspector({
  block,
  blocks,
  wires,
  onChange,
  onDisconnect,
}: {
  block: BlockInstance | undefined
  blocks: BlockInstance[]
  wires: Wire[]
  onChange: (props: Partial<BlockProps>) => void
  onDisconnect: (wireId: string) => void
}) {
  if (!block) {
    return (
      <aside className="panel inspector">
        <h2>Settings</h2>
        <p className="hint">Select a block on the canvas to edit it</p>
      </aside>
    )
  }
  const def = blockByType[block.type]
  return (
    <aside className="panel inspector">
      <h2>
        {def.icon} {def.label}
      </h2>
      {(def.settingsFor?.(block.props) ?? def.settings).map((f) =>
        f.type === 'tokenSearch' ? (
          <TokenSearch key={f.key} props={block.props} onChange={onChange} />
        ) : f.type === 'coinSearch' ? (
          <CoinSearch key={f.key} props={block.props} onChange={onChange} />
        ) : (
          <Field key={f.key} field={f} value={block.props[f.key]} onChange={(v) => onChange({ [f.key]: v })} />
        ),
      )}
      <PortList block={block} blocks={blocks} wires={wires} onDisconnect={onDisconnect} />
    </aside>
  )
}
