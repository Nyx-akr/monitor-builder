import { useEffect, useRef, useState } from 'react'
import type { BlockContext, BlockDefinition } from '../../types'
import './message.css'

type Props = { text: string }

/** How long to wait after a click to see whether it turns into a double-click (edit). */
const DOUBLE_CLICK_MS = 220

/**
 * Sends the box's content out of its outlet. Like Max, "a, b" sends "a" then "b",
 * and $1 is replaced by the incoming message when one arrives on the inlet.
 */
function output(ctx: BlockContext<Props>, text: string, arg?: string) {
  const content = arg === undefined ? text : text.replace(/\$1/g, arg)
  for (const part of content.split(',')) {
    const msg = part.trim()
    if (msg) ctx.send('out', msg)
  }
}

function MessageBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(props.text)
  const [flash, setFlash] = useState(0)
  const clickTimer = useRef<ReturnType<typeof setTimeout>>()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => clearTimeout(clickTimer.current), [])
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const trigger = () => {
    output(ctx, props.text)
    setFlash((f) => f + 1)
  }

  const onClick = (e: React.MouseEvent) => {
    if (editing) return
    // Outside edit mode there is no double-click to wait for.
    if (!ctx.editing) return trigger()
    if (e.detail > 1) return
    clickTimer.current = setTimeout(trigger, DOUBLE_CLICK_MS)
  }

  const onDoubleClick = () => {
    if (!ctx.editing) return
    clearTimeout(clickTimer.current)
    setDraft(props.text)
    setEditing(true)
  }

  const commit = () => {
    ctx.update({ text: draft.trim() })
    setEditing(false)
  }

  return (
    <div
      key={flash}
      className={`msg${flash ? ' flash' : ''}${editing ? ' editing' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={ctx.editing ? 'Click to send · double-click to edit' : 'Click to send'}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          size={Math.max(4, draft.length + 1)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
            e.stopPropagation()
          }}
        />
      ) : (
        <span>{props.text || ' '}</span>
      )}
    </div>
  )
}

export const message: BlockDefinition<Props> = {
  type: 'message',
  label: 'Message',
  description: 'Click to send its text down a wire',
  icon: '✉',
  category: 'objects',
  defaultProps: { text: 'PEPE' },
  settings: [{ key: 'text', label: 'Message', type: 'text', help: 'Commas send several messages. $1 is replaced by what arrives on the inlet.' }],
  inlets: [{ id: 'in', label: 'bang outputs · set <text> replaces · anything else fills $1 and outputs' }],
  outlets: [{ id: 'out', label: 'message' }],
  receive: (ctx, _inlet, msg) => {
    const m = String(msg)
    if (m === 'bang') return output(ctx, ctx.props.text)
    if (m.startsWith('set ')) return ctx.update({ text: m.slice(4) })
    if (m === 'set') return ctx.update({ text: '' })
    output(ctx, ctx.props.text, m)
  },
  Render: MessageBox,
}
