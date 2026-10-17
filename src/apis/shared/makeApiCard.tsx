import { useEffect, useRef, useState } from 'react'
import type { BlockContext, BlockDefinition, Message, Port, SettingField } from '../../blocks/types'
import { track } from '../../core/fetchState'
import { isObject } from '../../core/messages'
import { FetchBadge } from '../../components/FetchBadge'
import { CHAINS, guessChain } from '../../services/chains'
import { shortAddress } from '../../lib/format'
import './apiCard.css'

/**
 * The common shape of the API cards (Jupiter, GoPlus, RugCheck, honeypot.is, KyberSwap, DefiLlama): a
 * `token` input, `data` (one row) / `list` (many rows) / `error` outputs, a fetch badge and a table of the
 * key results. Each API only says how to fetch and what to show — see makeApiCard().
 */

/** What a card was asked about: from typed text, or a token row (e.g. from DexScreener) with its chain. */
export interface TokenInput {
  /** Contract address / mint, or whatever was typed (a symbol, an id). */
  token: string
  chain: string
  symbol?: string
  /** The pair / pool the row was about (DexScreener rows carry it). */
  pair?: string
}

export type Row = Record<string, Message>
export interface ApiResult {
  data?: Row
  list?: Row[]
}

/** One line of the card's table: label, shown value, and whether it's good / bad news. */
export type Line = [label: string, value: string, tone?: 'good' | 'bad' | 'warn']

export interface ApiCardProps {
  token: string
  chain: string
  /** The token's name for the card (a symbol), when it came from a row. */
  label: string
  refreshSec: number
  [key: string]: string | number | boolean
}

export interface ApiSpec<P extends ApiCardProps> {
  type: string
  label: string
  description: string
  icon: string
  /** Shown in the badge / errors. */
  source: string
  defaultProps: P
  /** Chains the API covers (ids from services/chains); the Chain dropdown offers these. */
  chains: string[]
  /** Without a token it has nothing to fetch (false: e.g. DefiLlama's rankings). */
  needsToken: (props: P) => boolean
  /** Extra settings, after Token / Chain. */
  settings?: (props: P) => SettingField[]
  fetch: (input: TokenInput, props: P) => Promise<ApiResult>
  /** What the card shows from the last result. */
  lines: (result: ApiResult, props: P) => Line[]
  /** A one-line verdict above the table (e.g. "Not a honeypot"). */
  headline?: (result: ApiResult, props: P) => { text: string; tone?: Line[2] } | null
  /** Port labels. */
  dataLabel: string
  listLabel?: string
  tokenHelp: string
}

/** The last result each card got, by block id (the card shows it; it's fetched again on load). */
const results = new Map<string, ApiResult>()
const listeners = new Map<string, (r: ApiResult | null) => void>()

/** A token row (DexScreener / CoinGecko / Jupiter item) → what to ask about. A many-row table: its first row. */
function inputFrom(msg: Message, fallbackChain: string): TokenInput | null {
  const row = Array.isArray(msg) ? msg[0] : msg
  if (isObject(row)) {
    const address = typeof row.address === 'string' ? row.address : typeof row.id === 'string' ? row.id : ''
    const chain = typeof row.chain === 'string' ? row.chain : fallbackChain
    const symbol = typeof row.symbol === 'string' ? row.symbol : undefined
    const pair = typeof row.pair === 'string' ? row.pair : undefined
    return address || symbol ? { token: address || symbol!, chain, symbol, pair } : null
  }
  if (typeof row === 'string' || typeof row === 'number') {
    const token = String(row).trim()
    return token ? { token, chain: guessChain(token, fallbackChain) } : null
  }
  return null
}

export function makeApiCard<P extends ApiCardProps>(spec: ApiSpec<P>): BlockDefinition<P> {
  async function run(ctx: BlockContext<P>, input?: TokenInput) {
    const props = ctx.props
    const ask: TokenInput = input ?? {
      token: props.token,
      chain: props.chain || spec.chains[0],
      symbol: props.label || undefined,
      pair: typeof props.pair === 'string' && props.pair ? props.pair : undefined,
    }
    if (spec.needsToken(props) && !ask.token) return
    try {
      const result = await track(ctx.id, spec.fetch(ask, props))
      results.set(ctx.id, result)
      listeners.get(ctx.id)?.(result)
      // Right to left, like Max: the list, then the data.
      if (result.list) ctx.send('list', result.list)
      if (result.data) ctx.send('data', result.data)
    } catch (e) {
      ctx.send('error', { source: spec.source, token: ask.token, chain: ask.chain, error: (e as Error).message })
    }
  }

  function Card({ props, ctx }: { props: P; ctx: BlockContext<P> }) {
    const [result, setResult] = useState<ApiResult | null>(() => results.get(ctx.id) ?? null)
    const ctxRef = useRef(ctx)
    ctxRef.current = ctx

    useEffect(() => {
      listeners.set(ctx.id, setResult)
      return () => {
        listeners.delete(ctx.id)
      }
    }, [ctx.id])

    // Fetch on open, when the token / chain / settings change, and every refreshSec if set.
    const key = JSON.stringify({ ...props, label: undefined })
    useEffect(() => {
      run(ctxRef.current)
      const every = Math.max(0, Number(props.refreshSec) || 0)
      if (!every) return
      const t = setInterval(() => run(ctxRef.current), Math.max(5, every) * 1000)
      return () => clearInterval(t)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key])

    const headline = result && spec.headline?.(result, props)
    const lines = result ? spec.lines(result, props) : []
    const chain = CHAINS.find((c) => c.id === props.chain)?.label ?? props.chain
    const who = props.token ? `${props.label || shortAddress(String(props.token))}${spec.chains.length > 1 ? ` · ${chain}` : ''}` : ''
    return (
      <div className="api-card">
        <div className="api-head">
          <span className="api-icon">{spec.icon}</span>
          <span className="api-title">
            <strong>{spec.label}</strong>
            <small>{who || (spec.needsToken(props) ? 'no token yet' : spec.description)}</small>
          </span>
          <FetchBadge id={ctx.id} loading={false} error={null} updatedAt={null} source={spec.source} />
        </div>
        {headline && <div className={`api-headline ${headline.tone ?? ''}`}>{headline.text}</div>}
        {lines.length > 0 ? (
          <div className="api-lines">
            {lines.map(([label, value, tone]) => (
              <div key={label} className="api-line">
                <span>{label}</span>
                <strong className={tone ?? ''}>{value}</strong>
              </div>
            ))}
          </div>
        ) : (
          <div className="api-empty">{spec.needsToken(props) && !props.token ? spec.tokenHelp : 'Waiting for an answer…'}</div>
        )}
      </div>
    )
  }

  const chainOptions = CHAINS.filter((c) => spec.chains.includes(c.id)).map((c) => ({ value: c.id, label: c.label }))
  const outlets: Port[] = [
    { id: 'data', label: spec.dataLabel, types: ['table'] },
    ...(spec.listLabel ? [{ id: 'list', label: spec.listLabel, types: ['table'] } as Port] : []),
    { id: 'error', label: `error — the token and why ${spec.label} couldn’t answer`, types: ['table'], error: true },
  ]

  return {
    type: spec.type,
    label: spec.label,
    description: spec.description,
    icon: spec.icon,
    category: 'apis',
    width: 340,
    defaultProps: spec.defaultProps,
    settings: [],
    settingsFor: (props) => [
      ...(spec.needsToken(props) || props.token
        ? [{ key: 'token', label: 'Token', type: 'text' as const, placeholder: 'contract address / mint', help: spec.tokenHelp }]
        : []),
      ...(chainOptions.length > 1 ? [{ key: 'chain', label: 'Chain', type: 'select' as const, options: chainOptions }] : []),
      ...(spec.settings?.(props) ?? []),
      { key: 'refreshSec', label: 'Auto-refresh (seconds)', type: 'number', min: 0, help: '0 = only when a token or signal arrives (and when the flow opens).' },
    ],
    inlets: [
      {
        id: 'token',
        label: `token — ${spec.tokenHelp} · a signal asks again`,
        types: ['string', 'table', 'bang'],
      },
    ],
    outlets,
    menu: [{ label: 'Fetch now', run: (ctx) => run(ctx) }],
    receive: (ctx, _inlet, msg) => {
      if (msg === 'bang') return run(ctx)
      const input = inputFrom(msg, ctx.props.chain || spec.chains[0])
      if (!input) return
      const chain = spec.chains.includes(input.chain) ? input.chain : ctx.props.chain
      // Remember it (shown on the card, saved with the flow) and ask straight away.
      ctx.update({ token: input.token, chain, label: input.symbol ?? '', ...('pair' in ctx.props ? { pair: input.pair ?? '' } : {}) } as Partial<P>)
      run(ctx, { ...input, chain })
    },
    Render: Card,
  }
}

// ---------- shared formatting for the cards' tables ----------

export const yesNo = (v: boolean | null | undefined, badWhenYes = true): [string, Line[2]] =>
  v == null ? ['—', undefined] : [v ? 'yes' : 'no', v === badWhenYes ? 'bad' : 'good']

export const pct = (v: number | null | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`)

/** A tax: 0% is good, up to 10% a warning, more is bad. */
export const taxLine = (label: string, v: number | null | undefined): Line => [label, pct(v), v == null ? undefined : v === 0 ? 'good' : v <= 10 ? 'warn' : 'bad']

export const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/** GoPlus-style flags: "1" / "0" (or 1 / 0) → true / false; anything else → null. */
export const flag = (v: unknown): boolean | null => (v === '1' || v === 1 ? true : v === '0' || v === 0 ? false : null)

export async function getJson<T>(url: string, source: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (res.status === 429) throw new Error(`${source} rate limit hit — try again in a minute`)
  const body = await res.json().catch(() => null)
  if (body?.status?.error_code === 429) throw new Error(`${source} rate limit hit — try again in a minute`)
  if (!res.ok) throw new Error((body && (body.message || body.error)) || `${source} answered ${res.status}`)
  return body as T
}
