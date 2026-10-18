import type { BlockDefinition } from '../../blocks/types'
import { PAGE_BAR_H, PAGE_H, PAGE_HEAD, PAGE_W, computeLayout, parseLayout } from '../../core/pageLayout'
import './page.css'

type Props = { layout: string }

/** The Page: a wireframe of the screen this flow drives. Its boxes hold widgets — docked blocks, drawn over them. */
function PageBox({ props }: { props: Props }) {
  const { slots } = computeLayout(parseLayout(props.layout))
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
      {slots.map((s) => (
        <div key={s.id} className="wf page-slot" style={{ left: s.x, top: s.y, width: s.w, height: s.h }}>
          <span>Drop a block here — Feed, Token details, Chart, Table… “Edit layout” splits the boxes.</span>
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
  defaultProps: { layout: '' },
  settings: [],
  Render: PageBox,
}
