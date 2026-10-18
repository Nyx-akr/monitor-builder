import type { ComponentType } from 'react'
import type { DataType } from '../core/dataTypes'
import type { Value } from '../core/values'

export type BlockProps = Record<string, string | number | boolean>

/** A field shown in the right panel. Blocks describe their settings with these — no custom UI needed. */
export type SettingField =
  | { key: string; label: string; type: 'text'; placeholder?: string; help?: string }
  | { key: string; label: string; type: 'number'; min?: number; max?: number; help?: string }
  | { key: string; label: string; type: 'toggle'; help?: string }
  /** A section title in the right panel (no value). */
  | { key: string; label: string; type: 'heading'; help?: string }
  | { key: string; label: string; type: 'select'; options: { value: string; label: string }[]; help?: string }
  /** Token search (any chain); writes query (the address), chain, pairAddress and pairLabel. */
  | { key: string; label: string; type: 'tokenSearch'; help?: string }

/** An input or output. A wire carries the output's current value to the input. */
export interface Port {
  id: string
  label: string
  /** The kinds of value it takes / gives (see core/dataTypes). Omitted = anything. */
  types?: DataType[]
  /** Drawn orange: what went wrong. */
  error?: boolean
}

/** Data a block needs from the engine (the server): what, with which parameters, and how fresh. */
export interface Query {
  kind: 'search' | 'market' | 'feed' | 'candles' | 'safety' | 'history' | 'details'
  params: Record<string, string | number>
  /** Ask again this often while the block is on the canvas (ms). */
  refreshMs?: number
}

export interface QueryState<T = unknown> {
  data?: T
  error?: string
  /** When the answer arrived (ms). */
  at?: number
  loading: boolean
}

/** What a block knows while it's drawn: its props, its inputs, its outputs and its data. */
export interface BlockContext<P extends BlockProps = BlockProps> {
  id: string
  props: P
  editing: boolean
  update: (props: Partial<P>) => void
  /** Each input's value (the first wire into it). */
  inputs: Record<string, Value | undefined>
  /** Every value wired into each input (for blocks that take several, like Merge). */
  inputsAll: Record<string, Value[]>
  outputs: Record<string, Value | undefined>
  /** The answers to its queries, in the order `query` returned them. */
  data: QueryState[]
}

export interface ComputeArgs<P extends BlockProps = BlockProps> {
  props: P
  inputs: Record<string, Value | undefined>
  inputsAll: Record<string, Value[]>
  data: QueryState[]
}

export type Category = 'pick' | 'data' | 'calc' | 'show' | 'rules' | 'pages'

export interface BlockDefinition<P extends BlockProps = BlockProps> {
  type: string
  label: string
  description: string
  icon: string
  /** Palette group. */
  category: Category
  /** Always in every flow, exactly once, and can only be moved (the Page). */
  permanent?: boolean
  /** Always docked in this Page box — it can't be dragged out. */
  dockedIn?: string
  /** How the block looks in a Page box (blocks with a Widget can be dropped into one). */
  Widget?: ComponentType<{ props: P; ctx: BlockContext<P> }>
  /** Ports that moved to another (permanent) block, port id → that block's type. Saved wires follow. */
  movedPorts?: Record<string, string>
  defaultProps: P
  /** Width on the canvas, in px. Omit to size to content. */
  width?: number
  settings: SettingField[]
  /** Settings that depend on the props or on what's wired in (e.g. a dropdown of the input table's columns). */
  settingsFor?: (props: P, inputs: Record<string, Value | undefined>) => SettingField[]
  inlets?: Port[]
  outlets?: Port[]
  /** Old port ids → new, so saved wires follow a rename. */
  renamedInlets?: Record<string, string>
  renamedOutlets?: Record<string, string>
  /** Ports that depend on the settings (e.g. a Merge with N inputs); overrides inlets / outlets. */
  ports?: (props: P) => { inlets?: Port[]; outlets?: Port[] }
  /** Output types that depend on the settings. */
  outletTypes?: (props: P) => Record<string, DataType[]>
  /** Props reset when the block is duplicated or rewired (what it learned from its old input). */
  learnedReset?: Partial<P>
  primeFrom?: (props: P, source: BlockInstance) => Partial<P> | null
  /** Runs before a block is placed or copied. */
  prepare?: (props: P, reason: 'add' | 'duplicate') => Promise<Partial<P> | null>
  /** The engine data it needs, worked out from its props and inputs (null = nothing right now). */
  query?: (props: P, inputs: Record<string, Value | undefined>) => Query | null | (Query | null)[]
  /** Its outputs, from its inputs and data — recomputed whenever any of them changes. */
  compute?: (args: ComputeArgs<P>) => Record<string, Value | undefined>
  /** Extra right-click menu items (Duplicate / Delete are always there). */
  menu?: { label: string; run: (ctx: BlockContext<P>) => void }[]
  /** Extra information in the right panel, under the settings (e.g. how the Safety block judges a token). */
  Info?: ComponentType<{ props: P; inputs: Record<string, Value | undefined>; outputs: Record<string, Value | undefined>; update: (patch: Partial<P>) => void }>
  Render: ComponentType<{ props: P; ctx: BlockContext<P> }>
}

export interface BlockInstance {
  id: string
  type: string
  props: BlockProps
  /** Position on the canvas, in world (unzoomed) px. */
  x: number
  y: number
  /** Docked in a Page box: drawn there as a widget. */
  dock?: { slot: string }
}

export interface PortRef {
  block: string
  port: string
}

/** A connection from one block's output to another block's input. */
export interface Wire {
  id: string
  from: PortRef
  to: PortRef
}
