import { useEffect, useState } from 'react'
import { blockByType } from '../blocks/registry'
import type { BlockContext, BlockInstance } from '../blocks/types'
import { pageOf, parseLayout, type LayoutNode } from '../core/pageLayout'
import { useFeedSelected } from '../blocks/pick'
import { TokenLine } from '../blocks/shared'
import { setDashTimeframe } from '../core/dashTimeframe'
import { TIMEFRAMES } from '../charts'

const SIZES = [60, 70, 80, 90, 100]

/**
 * The full-screen UI: the Page's widgets as a real, responsive dashboard — it fills the window (ultrawide
 * too), scrolls and clicks like any app, under a fixed navbar. The flow behind it keeps running.
 */
export function Dashboard({ blocks, makeCtx, onExit }: { blocks: BlockInstance[]; makeCtx: (id: string) => BlockContext; onExit: () => void }) {
  const selected = useFeedSelected()
  // The navbar's timeframe (saved on the Page): every chart here follows it while the dashboard shows.
  const pageBlock = pageOf(blocks)
  const timeframe = String(pageBlock?.props.timeframe ?? '')
  useEffect(() => {
    setDashTimeframe(timeframe)
    return () => setDashTimeframe('')
  }, [timeframe])
  // The navbar's size (saved on the Page): scales every widget, so wide screens fit more at once.
  const size = Number(pageBlock?.props.dashSize) || 80
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
          <select className="dash-tf" value={timeframe} onChange={(e) => pageBlock && makeCtx(pageBlock.id).update({ timeframe: e.target.value })} title="Every chart on the dashboard follows this">
            <option value="">Each chart’s timeframe</option>
            {TIMEFRAMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <select className="dash-tf" value={size} onChange={(e) => pageBlock && makeCtx(pageBlock.id).update({ dashSize: Number(e.target.value) })} title="How big text and boxes are">
            {SIZES.map((v) => (
              <option key={v} value={v}>
                Size {v}%
              </option>
            ))}
          </select>
          <span className="dash-clock">{now.toLocaleTimeString()}</span>
          <button className="dash-exit" onClick={onExit} title="Back to the flow (Esc)">
            ⤡ Exit full screen
          </button>
        </div>
      </nav>
      <main className="dash-grid" style={{ zoom: size / 100 }}>{box(parseLayout(pageOf(blocks)?.props.layout))}</main>
    </div>
  )
}
