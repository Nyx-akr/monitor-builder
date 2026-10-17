import type { BlockDefinition } from '../../blocks/types'
import { PAGE_BAR_H, PAGE_H, PAGE_HEAD, PAGE_W, SLOTS } from '../../core/pageLayout'
import './page.css'

type Props = Record<string, never>

/** The Page: a wireframe of the screen this flow drives. Its boxes hold widgets — docked blocks, drawn over them. */
function PageBox() {
  return (
    <div className="page-frame" style={{ width: PAGE_W, height: PAGE_H }}>
      <div className="page-bar" style={{ height: PAGE_BAR_H }}>
        <i />
        <i />
        <i />
        <span className="page-url">Page · 1920 × 1080</span>
      </div>
      <div className="wf-head" style={{ top: PAGE_HEAD.top, height: PAGE_HEAD.h }}>
        <div className="wf wf-logo" />
        <div className="wf-line" style={{ width: '38%' }} />
        <div className="wf-line" style={{ width: '18%', marginLeft: 'auto' }} />
      </div>
      {SLOTS.filter((s) => s.id !== 'selector').map((s) => (
        <div key={s.id} className="wf page-slot" style={{ left: s.x, top: s.y, width: s.w, height: s.h }}>
          <span>Drop a message box, dict or chart here</span>
        </div>
      ))}
    </div>
  )
}

export const page: BlockDefinition<Props> = {
  type: 'page',
  label: 'Page',
  description: 'The page this flow drives — drop boxes into it to show their data',
  icon: '▭',
  category: 'pages',
  permanent: true,
  width: PAGE_W,
  defaultProps: {},
  settings: [],
  // The token selector's input / output used to be on the Page itself.
  movedPorts: { tokens: 'tokenSelector', token: 'tokenSelector' },
  Render: PageBox,
}
