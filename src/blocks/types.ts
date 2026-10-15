import type { ComponentType } from 'react'

export type BlockProps = Record<string, string | number | boolean>

/** A field shown in the inspector panel. Blocks describe their settings with these — no custom UI needed. */
export type SettingField =
  | { key: string; label: string; type: 'text'; placeholder?: string; help?: string }
  | { key: string; label: string; type: 'number'; min?: number; max?: number; help?: string }
  | { key: string; label: string; type: 'toggle'; help?: string }
  | { key: string; label: string; type: 'select'; options: { value: string; label: string }[]; help?: string }
  /** DexScreener token picker; writes query, chain, pairAddress and pairLabel. */
  | { key: string; label: string; type: 'tokenSearch'; help?: string }
  /** CoinGecko coin picker; writes coinId and coinLabel. */
  | { key: string; label: string; type: 'coinSearch'; help?: string }

/** An inlet or outlet. Wires always go from an outlet to an inlet and carry real messages (Max/MSP style). */
export interface Port {
  id: string
  label: string
}

/** A message travelling along a wire. Message boxes send strings; "bang" means "output now". */
export type Message = string | number

/** What a block can do at runtime: change its own props and emit messages from its outlets. */
export interface BlockContext<P extends BlockProps = BlockProps> {
  id: string
  props: P
  editing: boolean
  update: (props: Partial<P>) => void
  send: (outlet: string, msg: Message) => void
}

export interface BlockDefinition<P extends BlockProps = BlockProps> {
  type: string
  label: string
  description: string
  icon: string
  /** Palette group — mirrors the folder the block lives in (src/blocks/<category>/<name>). */
  category: 'cards' | 'objects'
  defaultProps: P
  /** Width of the block on the canvas, in px. Omit to size to content. */
  width?: number
  settings: SettingField[]
  inlets?: Port[]
  outlets?: Port[]
  /** Called when a message arrives on one of this block's inlets. */
  receive?: (ctx: BlockContext<P>, inlet: string, msg: Message) => void | Promise<void>
  Render: ComponentType<{ props: P; ctx: BlockContext<P> }>
}

export interface BlockInstance {
  id: string
  type: string
  props: BlockProps
  /** Position on the canvas, in world (unzoomed) px. */
  x: number
  y: number
}

export interface PortRef {
  block: string
  port: string
}

/** A connection from one block's outlet to another block's inlet. */
export interface Wire {
  id: string
  from: PortRef
  to: PortRef
}
