import { useEffect, useRef, useState } from 'react'
import type { BlockContext, BlockDefinition, Message } from '../../blocks/types'
import { isObject, isToken, listItem, type Token } from '../../core/messages'
import { CHAINS, findPair, type DexPair } from '../../services/dexscreener'
import { percent, shortAddress, usdPrice } from '../../lib/format'
import './token.css'

/**
 * Token: the one place a flow says *which* token. Pick it by searching (name, symbol or address, any
 * chain), or send one in (a list click, another card's data). Its output always carries the selected
 * Token — chain, contract address, symbol, name, pool, logo, and a price snapshot — so every card
 * downstream (DexScreener, GeckoTerminal, RugCheck, GoPlus…) knows exactly what to look up.
 */
type Props = {
  /** Written by the search in the right panel (same as the DexScreener card's). */
  query: string
  chain: string
  pairAddress: string
  pairLabel: string
  /** The selected Token, as JSON — saved with the flow. */
  token: string
}

function parse(json: string): Token | null {
  try {
    const v = JSON.parse(json || 'null') as Message
    return isToken(v) ? v : null
  } catch {
    return null
  }
}

/** A DexScreener pair → the Token it's about (its base token, with the pair as its pool). */
function tokenOf(p: DexPair): Token {
  return {
    ...listItem({
      source: 'dexscreener',
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      price: p.priceUsd ? Number(p.priceUsd) : null,
      change24h: p.priceChange?.h24 ?? null,
      marketCap: p.marketCap ?? null,
      volume24h: p.volume?.h24 ?? null,
      liquidity: p.liquidity?.usd ?? null,
      chain: p.chainId,
      address: p.baseToken.address,
      pair: p.pairAddress,
      url: p.url,
      logo: p.info?.imageUrl ?? null,
    }),
    kind: 'token',
    pool: p.pairAddress,
  } as Token
}

const same = (a: Token | null, b: Token | null) => Boolean(a && b && a.chain === b.chain && a.address === b.address)

/** Keep a Token: show it, save it, send it on. */
function select(ctx: BlockContext<Props>, t: Token) {
  ctx.update({ token: JSON.stringify(t), query: t.address || t.symbol, chain: t.chain || '', pairAddress: (t.pool as string) || '', pairLabel: t.symbol })
  ctx.send('token', t)
}

function TokenBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const token = parse(props.token)
  const [error, setError] = useState<string | null>(null)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  // Opening the flow sends the saved Token, so everything downstream fills in.
  useEffect(() => {
    const t = parse(ctxRef.current.props.token)
    if (t) ctxRef.current.send('token', t)
  }, [])

  // A token picked in the right panel's search: look it up and send it.
  useEffect(() => {
    if (!props.query.trim() && !props.pairAddress) return
    let live = true
    const t = setTimeout(async () => {
      try {
        const pair = await findPair(props.query, props.chain, props.pairAddress)
        if (!live) return
        if (!pair) return setError(`No token matching "${props.query}" on DexScreener`)
        setError(null)
        const next = tokenOf(pair)
        // Already the one selected (e.g. it was just sent in): don't send it twice.
        if (!same(next, parse(ctxRef.current.props.token))) select(ctxRef.current, next)
      } catch (e) {
        if (live) setError((e as Error).message)
      }
    }, 400)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [props.query, props.chain, props.pairAddress])

  if (!token)
    return (
      <div className="tok">
        <span className="tok-logo">?</span>
        <span className="tok-main">
          <strong>Token</strong>
          <small className="tok-empty">{error ?? 'Pick a token in the right panel, or send one in'}</small>
        </span>
      </div>
    )
  const chain = CHAINS.find((c) => c.value === token.chain)?.label ?? token.chain
  const change = typeof token.change24h === 'number' ? token.change24h : null
  return (
    <div className="tok" title={`${token.name} · ${chain} · ${token.address}`}>
      {token.logo ? <img className="tok-logo" src={String(token.logo)} alt="" /> : <span className="tok-logo">{token.symbol.slice(0, 2)}</span>}
      <span className="tok-main">
        <strong>{token.symbol}</strong>
        <small>
          {token.name} · {chain || '—'} · {token.address ? shortAddress(token.address) : 'no contract'}
        </small>
      </span>
      {typeof token.price === 'number' && (
        <span className="tok-price">
          <b>{usdPrice(token.price)}</b>
          {change !== null && <span className={change >= 0 ? 'up' : 'down'}>{percent(change)}</span>}
        </span>
      )}
    </div>
  )
}

export const token: BlockDefinition<Props> = {
  type: 'token',
  label: 'Token',
  description: 'Pick a token — every card wired to it knows which one',
  icon: '🪙',
  category: 'objects',
  defaultProps: { query: '', chain: '', pairAddress: '', pairLabel: '', token: '' },
  settings: [{ key: 'query', label: 'Token', type: 'tokenSearch', help: 'Search by name, symbol or contract address, on any chain.' }],
  inlets: [
    {
      id: 'in',
      label: 'token — a Token (the Page’s token selector, a card’s data) becomes the selected one',
      types: ['token'],
    },
    {
      id: 'send',
      label: 'send — a signal (e.g. a Timer, or a click on a message box) pushes the selected Token out again',
      types: ['bang'],
    },
  ],
  outlets: [{ id: 'token', label: 'token — the selected Token: chain, contract address, symbol, name, pool, logo, price snapshot', types: ['token'] }],
  menu: [
    {
      label: 'Send again',
      run: (ctx) => {
        const t = parse(ctx.props.token)
        if (t) ctx.send('token', t)
      },
    },
  ],
  // A copy keeps the same token (it's a choice you made, not data it received).
  receive: (ctx, inlet, msg) => {
    // The send input: push the selected Token out again (e.g. so every card wired to it asks again).
    if (inlet === 'send' || msg === 'bang') {
      const t = parse(ctx.props.token)
      if (t) ctx.send('token', t)
      return
    }
    const row = Array.isArray(msg) ? msg[0] : msg
    if (isToken(row)) return select(ctx, row)
    // A token-like row without the mark (older lists): make it a Token if it says where it lives.
    if (isObject(row) && typeof row.symbol === 'string' && typeof row.address === 'string' && typeof row.chain === 'string') {
      return select(ctx, { ...(row as Record<string, Message>), kind: 'token' } as Token)
    }
    // Text: search for it (the panel's search does the same).
    if (typeof row === 'string' && row.trim()) ctx.update({ query: row.trim(), chain: '', pairAddress: '', pairLabel: '' })
  },
  Render: TokenBox,
}
