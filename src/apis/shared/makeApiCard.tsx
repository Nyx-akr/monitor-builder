import { useEffect, useRef, useState } from 'react'
import type { BlockContext, BlockDefinition, Message, Port, SettingField } from '../../blocks/types'
import { track } from '../../core/fetchState'
import { isObject, isToken } from '../../core/messages'
import { FetchBadge } from '../../components/FetchBadge'
import { CHAINS, coinContract, guessChain, isEvmAddress, isSolanaAddress } from '../../services/chains'
import { getCoin } from '../../services/coingecko'
import { findPair } from '../../services/dexscreener'
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
  /** CoinGecko's id, for a CoinGecko token that has no contract address yet. */
  coinId?: string
  /** A Token that came without its address (saved before tokens carried one): look it up by symbol. */
  lookUp?: boolean
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
  /** Can look a token up by symbol / name (Jupiter); the others need its contract address. */
  searchesBySymbol?: boolean
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
  /** The list's type, when it isn't a plain table — e.g. a history (dated rows) a Chart can draw. */
  listTypes?: (props: P) => NonNullable<Port['types']>
  tokenHelp: string
}

/** The last result each card got, by block id (the card shows it; it's fetched again on load). */
const results = new Map<string, ApiResult>()
const listeners = new Map<string, (r: ApiResult | null) => void>()
/** Why the last ask failed (shown on the card until an answer arrives). */
const errors = new Map<string, string>()
const errorListeners = new Map<string, (e: string | null) => void>()
const setError = (id: string, e: string | null) => {
  if (e) errors.set(id, e)
  else errors.delete(id)
  errorListeners.get(id)?.(e)
}

/** A Token (or a token row; a many-row table: its first row) → what to ask about. */
function inputFrom(msg: Message, fallbackChain: string): TokenInput | null {
  const row = Array.isArray(msg) ? msg[0] : msg
  if (isObject(row)) {
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    const address = str(row.address)
    const chain = str(row.chain) ?? fallbackChain
    const symbol = str(row.symbol)
    const pair = str(row.pool) ?? str(row.pair)
    const coinId = row.source === 'coingecko' ? str(row.id) : undefined
    const token = address ?? (coinId ? '' : symbol)
    const lookUp = !address && !coinId && Boolean(symbol) && isToken(row)
    // (A Token to look up keeps its own chain only — the card's default could be the wrong one.)
    return token !== undefined || coinId ? { token: token ?? '', chain: lookUp ? str(row.chain) ?? '' : chain, symbol, pair, coinId, lookUp } : null
  }
  if (typeof row === 'string' || typeof row === 'number') {
    const token = String(row).trim()
    return token ? { token, chain: guessChain(token, fallbackChain) } : null
  }
  return null
}

/**
 * A token with no contract on a chain this card covers (e.g. a CoinGecko coin): find its contract via
 * CoinGecko. A coin that has none (BTC, ETH…) can't be checked by DEX / safety tools — say so plainly.
 */
async function withContract(input: TokenInput, chains: string[], cardLabel: string, searchesBySymbol: boolean): Promise<TokenInput> {
  // A Token missing its address: its most traded pair on DexScreener (by symbol, on its chain if known).
  if (input.lookUp && input.symbol) {
    const pair = await findPair(input.symbol, input.chain)
    if (!pair) throw new Error(`Couldn’t find ${input.symbol}’s contract — pick it again in the token selector or a Token block`)
    input = { ...input, token: pair.baseToken.address, chain: pair.chainId, pair: input.pair ?? pair.pairAddress, lookUp: false }
  }
  const isAddress = isSolanaAddress(input.token) || isEvmAddress(input.token)
  // Plain text (a symbol like "PONK") isn't enough: say what's needed instead of failing on the API.
  if (input.token && !isAddress && !input.coinId && !searchesBySymbol)
    throw new Error(`${cardLabel} needs a token’s contract address, not “${input.token}” — wire a Token block (or a card’s data / a list row) in`)
  if (input.token && chains.includes(input.chain)) return input
  if (!input.coinId) {
    if (!input.token) throw new Error('No token address to look up')
    throw new Error(`${cardLabel} doesn’t cover ${input.chain}`)
  }
  const coin = await getCoin(input.coinId)
  const found = coinContract(coin.platforms, chains)
  if (!found) throw new Error(`${coin.name} has no contract on a chain ${cardLabel} covers (${chains.join(', ')}) — it may be a chain's own coin`)
  return { ...input, token: found.address, chain: found.chain }
}

export function makeApiCard<P extends ApiCardProps>(spec: ApiSpec<P>): BlockDefinition<P> {
  /** Cards with an ask still running: an auto-refresh skips them instead of queueing up behind a slow API. */
  const busy = new Set<string>()

  async function run(ctx: BlockContext<P>, input?: TokenInput, auto = false) {
    if (auto && busy.has(ctx.id)) return
    busy.add(ctx.id)
    try {
      await ask(ctx, input)
    } finally {
      busy.delete(ctx.id)
    }
  }

  async function ask(ctx: BlockContext<P>, input?: TokenInput) {
    const props = ctx.props
    const query: TokenInput = input ?? {
      token: props.token,
      chain: props.chain || spec.chains[0],
      symbol: props.label || undefined,
      pair: typeof props.pair === 'string' && props.pair ? props.pair : undefined,
    }
    if (spec.needsToken(props) && !query.token && !query.coinId) return
    try {
      const resolved = spec.needsToken(props) ? await withContract(query, spec.chains, spec.label, Boolean(spec.searchesBySymbol)) : query
      if (resolved !== query) ctx.update({ token: resolved.token, chain: resolved.chain } as Partial<P>)
      const result = await track(ctx.id, spec.fetch(resolved, props))
      results.set(ctx.id, result)
      listeners.get(ctx.id)?.(result)
      setError(ctx.id, null)
      // Right to left, like Max: the list, then the data.
      if (result.list) ctx.send('list', result.list)
      if (result.data) ctx.send('data', result.data)
    } catch (e) {
      setError(ctx.id, (e as Error).message)
      ctx.send('error', { source: spec.source, token: query.token, chain: query.chain, error: (e as Error).message })
    }
  }

  function Card({ props, ctx }: { props: P; ctx: BlockContext<P> }) {
    const [result, setResult] = useState<ApiResult | null>(() => results.get(ctx.id) ?? null)
    const [error, setErr] = useState<string | null>(() => errors.get(ctx.id) ?? null)
    useEffect(() => {
      errorListeners.set(ctx.id, setErr)
      return () => {
        errorListeners.delete(ctx.id)
      }
    }, [ctx.id])
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
      const t = setInterval(() => run(ctxRef.current, undefined, true), Math.max(5, every) * 1000)
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
        {error && <div className="api-headline bad">{error}</div>}
        {headline && !error && <div className={`api-headline ${headline.tone ?? ''}`}>{headline.text}</div>}
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
          !error && <div className="api-empty">{spec.needsToken(props) && !props.token ? spec.tokenHelp : 'Waiting for an answer…'}</div>
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
      { id: 'token', label: `token — a Token (from a Token block, the Page’s token selector, a card’s data): ${spec.label} looks it up`, types: ['token'] },
      { id: 'refresh', label: 'refresh — a signal (e.g. a Timer) asks again', types: ['bang'] },
    ],
    outlets,
    outletTypes: (props): Record<string, NonNullable<Port['types']>> => (spec.listTypes ? { list: spec.listTypes(props) } : {}),
    menu: [{ label: 'Fetch now', run: (ctx) => run(ctx) }],
    receive: (ctx, inlet, msg) => {
      if (inlet === 'refresh' || msg === 'bang') return run(ctx)
      const input = inputFrom(msg, ctx.props.chain || spec.chains[0])
      if (!input) return
      // A token on a chain this card doesn't cover keeps its chain, so the card can say so (or find a contract).
      const chain = input.chain
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
  let res: Response
  // An API that doesn't answer within 20 seconds is given up on (the card says so, and asks again later).
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 20_000)
  try {
    res = await fetch(url, { ...init, signal: timeout.signal })
  } catch {
    clearTimeout(timer)
    // The browser hides the answer when a server refuses without its CORS header — which is how some APIs
    // (GeckoTerminal) answer "too many requests". Treat it as the rate limit it almost always is.
    throw new Error(`${source} didn’t answer — usually its rate limit; it will try again shortly`)
  }
  clearTimeout(timer)
  if (res.status === 429) throw new Error(`${source} rate limit hit — try again in a minute`)
  const body = await res.json().catch(() => null)
  if (body?.status?.error_code === 429) throw new Error(`${source} rate limit hit — try again in a minute`)
  if (!res.ok) throw new Error((body && (body.message || body.error)) || `${source} answered ${res.status}`)
  return body as T
}
