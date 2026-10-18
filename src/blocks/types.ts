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
  /**
   * Data types this inlet accepts / this outlet sends (see lib/dataTypes). Only compatible ports can be
   * wired, and an inlet ignores messages of other types. Omitted = 'any'.
   */
  types?: ('bang' | 'string' | 'number' | 'table' | 'token' | 'history' | 'ohlcv' | 'any')[]
  /** An error outlet: drawn orange, carries what went wrong. */
  error?: boolean
}

/**
 * A message travelling along a wire, like a Max message: a symbol/number ("bang" means "output now"),
 * a list, or a dictionary (e.g. a token with its details).
 */
export type Message = string | number | boolean | null | Message[] | { [key: string]: Message | undefined }

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
  category: 'apis' | 'objects' | 'pages'
  /**
   * Always in every flow, exactly once (added when a flow opens), and can only be moved — no delete,
   * duplicate or palette item. E.g. the Page: the screen this flow's logic drives.
   */
  permanent?: boolean
  /** Always docked in this Page box (e.g. the token selector) — it can't be dragged out. */
  dockedIn?: string
  /**
   * How the block looks when dropped into a Page box (a nicer, read-only-ish widget instead of the patch box).
   * Blocks with a Widget can be docked; it gets the same props and ctx as Render.
   */
  Widget?: ComponentType<{ props: P; ctx: BlockContext<P> }>
  /** Ports that moved to another (permanent) block, port id → that block's type (its id). Saved wires follow. */
  movedPorts?: Record<string, string>
  defaultProps: P
  /** Width of the block on the canvas, in px. Omit to size to content. */
  width?: number
  settings: SettingField[]
  /** Settings that depend on the block's current props (e.g. a dropdown of fields seen in received data). */
  settingsFor?: (props: P) => SettingField[]
  inlets?: Port[]
  outlets?: Port[]
  /**
   * Inlets that were renamed or merged, old id → new id. Saved flows' wires into the old inlet are moved
   * to the new one when the flow loads (wires into an inlet that was simply removed are dropped).
   */
  renamedInlets?: Record<string, string>
  /** Outlets that were renamed or merged, old id → new id (wires from the old outlet move to the new one). */
  renamedOutlets?: Record<string, string>
  /** Ports that depend on the block's current settings (e.g. a Join with N inputs); overrides inlets/outlets. */
  ports?: (props: P) => { inlets?: Port[]; outlets?: Port[] }
  /** Outlet types that depend on the block's current settings (e.g. a message box holding "bang" sends bang). */
  outletTypes?: (props: P) => Record<string, NonNullable<Port['types']>>
  /**
   * Props the block learned from data it received (e.g. Get's field list). They belong to that data's
   * source, so they're reset when the block is duplicated or its input wires change.
   */
  learnedReset?: Partial<P>
  /**
   * When a wire is connected into this block, a chance to learn from what the source already holds
   * (e.g. a message box showing info) — without anything being sent.
   */
  primeFrom?: (props: P, source: BlockInstance) => Partial<P> | null
  /**
   * Runs before a block is placed ('add') or copied ('duplicate') — e.g. a Storage creates its own file.
   * Returns props to set (null = nothing). If it fails the block is placed anyway.
   */
  prepare?: (props: P, reason: 'add' | 'duplicate') => Promise<Partial<P> | null>
  /** A wire was just connected into this block: hand it what the source last sent (e.g. a Chart gets the candles at once). */
  replayOnConnect?: boolean
  /** A wire was just connected from one of this block's outlets — e.g. a Storage sends its history to the new wire. */
  onWired?: (ctx: BlockContext<P>, outlet: string) => void
  /** Extra right-click menu items for this block (Duplicate / Delete are always there). */
  menu?: { label: string; run: (ctx: BlockContext<P>) => void }[]
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
  /** Docked in a Page box: drawn there as a widget (its x / y are then the box's). */
  dock?: { slot: string }
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
