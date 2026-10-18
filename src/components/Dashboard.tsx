import { useEffect, useState } from 'react'
import { blockByType } from '../blocks/registry'
import type { BlockContext, BlockInstance } from '../blocks/types'
import { pageOf, parseLayout, type LayoutNode } from '../core/pageLayout'
import { useFeedSelected } from '../blocks/pick'
import { TokenLine } from '../blocks/shared'

/**
 * The full-screen UI: the Page's widgets as a real, responsive dashboard — it fills the window (ultrawide
 * too), scrolls and clicks like any app, under a fixed navbar. The flow behind it keeps running.
 */
export function Dashboard({ blocks, makeCtx, onExit }: { blocks: BlockInstance[]; makeCtx: (id: string) => BlockContext; onExit: () => void }) {
  const selected = useFeedSelected()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const docked = new Map(blocks.filter((b) => b.dock).map((b) => [b.dock!.slot, b]))
  // The Page's layout, as nested flexible rows and columns: it fills any screen at the same proportions.
  const box = (n: LayoutNode): JSX.Element => {
    if ('leaf' in n) {
      const b = docked.get(n.id)
      const Widget = b ? blockByType[b.type]?.Widget : undefined
      return (
        <section key={n.id} className={`dash-cell${b ? '' : ' empty'}`}>
          {b && Widget ? <Widget props={b.props} ctx={makeCtx(b.id)} /> : null}
        </section>
      )
    }
    return (
      <div key={n.id} className={`dash-split ${n.dir}`}>
        <div style={{ flex: `${n.ratio} 1 0` }}>{box(n.a)}</div>
        <div style={{ flex: `${1 - n.ratio} 1 0` }}>{box(n.b)}</div>
      </div>
    )
  }
  return (
    <div className="dash">
      <nav className="dash-nav">
        <div className="dash-brand">
          <span className="logo">◆</span> Market Monitor
        </div>
        <div className="dash-selected">{selected ? <TokenLine token={selected} /> : <span className="dim">Select a token in the Feed</span>}</div>
        <div className="dash-right">
          <span className="dash-clock">{now.toLocaleTimeString()}</span>
          <button className="dash-exit" onClick={onExit} title="Back to the flow (Esc)">
            ⤡ Exit full screen
          </button>
        </div>
      </nav>
      <main className="dash-grid">{box(parseLayout(pageOf(blocks)?.props.layout))}</main>
    </div>
  )
}
