import { useState } from 'react'
import type { BlockContext, BlockDefinition, Message } from '../../blocks/types'
import { describeItem, isObject, isTokenItem } from '../../core/messages'
import { percent, usdPrice } from '../../lib/format'
import { findPair } from '../../services/dexscreener'
import '../page/page.css'

type Props = {
  /** The token picked (its symbol), shown highlighted. */
  selected: string
  /** The list to choose from, as JSON — saved with the flow, so it's there after a reload. */
  tokens: string
}

/** What the selector keeps of each token: enough to show it and send it on as a Token (chain, address, pool…). */
function slim(items: Message[]): Message[] {
  return items.map((item) =>
    isObject(item) && typeof item.symbol === 'string'
      ? {
          kind: 'token',
          source: item.source ?? null,
          symbol: item.symbol,
          name: item.name ?? null,
          chain: item.chain ?? null,
          address: item.address ?? null,
          pool: item.pool ?? item.pair ?? null,
          id: item.id ?? null,
          logo: item.logo ?? null,
          price: item.price ?? null,
          change24h: item.change24h ?? null,
        }
      : item,
  )
}

/** A Token without a contract address (from an older save): find it on DexScreener by its symbol and chain. */
async function complete(t: Message): Promise<Message> {
  if (!isObject(t) || typeof t.symbol !== 'string' || (typeof t.address === 'string' && t.address)) return t
  try {
    const pair = await findPair(t.symbol, typeof t.chain === 'string' ? t.chain : '')
    if (!pair) return t
    return {
      ...t,
      chain: pair.chainId,
      address: pair.baseToken.address,
      pool: pair.pairAddress,
      logo: t.logo ?? pair.info?.imageUrl ?? null,
    }
  } catch {
    return t
  }
}

/** A row as a Token (rows from older saves have no mark yet). */
const asToken = (item: Message): Message => (isObject(item) && typeof item.symbol === 'string' ? { ...item, kind: 'token' } : item)

function parseTokens(json: string): Message[] {
  try {
    const v = JSON.parse(json || '[]') as Message
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** What a row sends and shows: a token's symbol, or the item itself when it's plain text / a number. */
function symbolOf(item: Message): string {
  if (isTokenItem(item)) return item.symbol.toUpperCase()
  if (isObject(item) && typeof item.symbol === 'string') return item.symbol.toUpperCase()
  return typeof item === 'string' || typeof item === 'number' ? String(item) : describeItem(item)
}

function TokenSelectorBox({ props, ctx }: { props: Props; ctx: BlockContext<Props> }) {
  const [query, setQuery] = useState('')
  const items = parseTokens(props.tokens)
  const selected = props.selected
  // Picking a row sends it on as a Token — what every card downstream understands. A row saved before
  // tokens carried their address is completed first, so the Token always says which contract it is.
  const onPick = async (item: Message) => {
    ctx.update({ selected: symbolOf(item) })
    ctx.send('token', await complete(asToken(item)))
  }

  const q = query.trim().toLowerCase()
  const shown = q
    ? items.filter((item) => {
        const name = isObject(item) && typeof item.name === 'string' ? item.name : ''
        return symbolOf(item).toLowerCase().includes(q) || name.toLowerCase().includes(q)
      })
    : items

  return (
    <section className="page-widget fill">
      <div className="page-widget-head">
        <span className="page-widget-title">Token selector</span>
        <span className="page-widget-sub">{items.length ? `${items.length} tokens` : 'no list yet'}</span>
      </div>
      {items.length > 0 && (
        <input className="ts-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tokens…" />
      )}
      {items.length === 0 ? (
        <div className="ts-empty">Wire a card’s list into this selector’s input</div>
      ) : (
        <div className="ts-list scroll-y">
          {shown.map((item, i) => {
            const symbol = symbolOf(item)
            const token = isObject(item) && typeof item.symbol === 'string' ? item : null
            const change = typeof token?.change24h === 'number' ? token.change24h : null
            return (
              <button
                key={`${symbol}-${i}`}
                className={`ts-row${symbol === selected ? ' selected' : ''}`}
                onClick={() => onPick(item)}
                title={`Choose ${symbol} — sends “${symbol}” out of token`}
              >
                <span className="ts-sym">{symbol}</span>
                <span className="ts-name">{typeof token?.name === 'string' ? token.name : ''}</span>
                <span className="ts-price">{typeof token?.price === 'number' ? usdPrice(token.price) : ''}</span>
                <span className={`ts-chg${change == null ? '' : change >= 0 ? ' up' : ' down'}`}>{change != null ? percent(change) : ''}</span>
              </button>
            )
          })}
          {shown.length === 0 && <div className="ts-empty">No token matches “{query}”</div>}
        </div>
      )}
    </section>
  )
}

export const tokenSelector: BlockDefinition<Props> = {
  type: 'tokenSelector',
  label: 'Token selector',
  description: 'The Page’s token list: pick one, its symbol goes out',
  icon: '☷',
  category: 'pages',
  // Part of the Page: always in its first box.
  permanent: true,
  dockedIn: 'selector',
  defaultProps: { selected: '', tokens: '' },
  // The list belongs to what's wired into `tokens`: rewiring clears it…
  learnedReset: { tokens: '' },
  // …and wiring in a message box that already shows a list fills it right away.
  primeFrom: (_props, source) => {
    if (source.type !== 'message' || typeof source.props.data !== 'string' || !source.props.data.startsWith('[')) return null
    const items = parseTokens(source.props.data)
    return items.length ? { tokens: JSON.stringify(slim(items)) } : null
  },
  settings: [],
  inlets: [{ id: 'tokens', label: 'tokens — a table of tokens to choose from (e.g. a card’s list)', types: ['table'] }],
  outlets: [{ id: 'token', label: 'token — the chosen Token (chain, address, symbol, name, pool…), sent when one is picked', types: ['token'] }],
  menu: [
    {
      label: 'Send chosen token again',
      run: (ctx) => {
        const item = parseTokens(ctx.props.tokens).find((t) => symbolOf(t) === ctx.props.selected)
        if (item !== undefined) complete(asToken(item)).then((t) => ctx.send('token', t))
      },
    },
  ],
  receive: (ctx, inlet, msg) => {
    if (inlet !== 'tokens') return
    // One row (a single token's details) is a one-token list.
    if (isObject(msg)) msg = [msg]
    if (!Array.isArray(msg)) return
    ctx.update({ tokens: JSON.stringify(slim(msg)) })
  },
  Render: TokenSelectorBox,
}
