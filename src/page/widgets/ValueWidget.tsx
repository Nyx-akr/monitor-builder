import type { Message } from '../../blocks/types'
import { describeItem, describeValue, isObject } from '../../core/messages'
import { compactNumber, moneyCompact, percent, usdPrice } from '../../lib/format'
import './widgets.css'

/**
 * How a value looks on the Page: a number as a big figure, text as a heading, a list as a table (tokens
 * get symbol / name / price / 24h columns), a dict as name → value rows (a single token as a price card).
 */

type Row = { [key: string]: Message | undefined }
const isTokenLike = (v: Message | undefined): v is Row => isObject(v as Message) && typeof (v as Row).symbol === 'string'
const num = (v: Message | undefined) => (typeof v === 'number' ? v : null)

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="dim">—</span>
  return <span className={value >= 0 ? 'up' : 'down'}>{percent(value)}</span>
}

function TokenTable({ items }: { items: Row[] }) {
  const hasCap = items.some((t) => num(t.marketCap) !== null)
  const hasLiq = items.some((t) => num(t.liquidity) !== null)
  return (
    <table className="pw-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Token</th>
          <th>Name</th>
          <th className="num">Price</th>
          <th className="num">24h</th>
          {hasCap && <th className="num">Market cap</th>}
          {hasLiq && <th className="num">Liquidity</th>}
        </tr>
      </thead>
      <tbody>
        {items.map((t, i) => (
          <tr key={i}>
            <td className="dim">{i}</td>
            <td className="sym">{String(t.symbol).toUpperCase()}</td>
            <td className="dim">{typeof t.name === 'string' ? t.name : ''}</td>
            <td className="num">{num(t.price) !== null ? usdPrice(num(t.price)) : '—'}</td>
            <td className="num">
              <Change value={num(t.change24h)} />
            </td>
            {hasCap && <td className="num">{moneyCompact(num(t.marketCap))}</td>}
            {hasLiq && <td className="num">{moneyCompact(num(t.liquidity))}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function TokenCard({ token }: { token: Row }) {
  const stats: [string, string][] = []
  if (num(token.marketCap) !== null) stats.push(['Market cap', moneyCompact(num(token.marketCap))])
  if (num(token.volume24h) !== null) stats.push(['Volume 24h', moneyCompact(num(token.volume24h))])
  if (num(token.liquidity) !== null) stats.push(['Liquidity', moneyCompact(num(token.liquidity))])
  if (typeof token.chain === 'string') stats.push(['Chain', token.chain])
  const change = num(token.change24h)
  return (
    <div className="pw-main">
      <div className="pw-token">
        <span className="pw-token-sym">{String(token.symbol).toUpperCase()}</span>
        {typeof token.name === 'string' && <span className="pw-token-name">{token.name}</span>}
      </div>
      <div className="pw-token-price">
        {num(token.price) !== null ? usdPrice(num(token.price)) : '—'}
        {change !== null && <span className={`pw-token-chg ${change >= 0 ? 'up' : 'down'}`}>{percent(change)}</span>}
      </div>
      {stats.length > 0 && (
        <div className="pw-token-stats">
          {stats.map(([k, v]) => (
            <span key={k}>
              {k} <b>{v}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** A value as a Page widget. `caption` names what it is (shown top-left). */
export function ValueWidget({ value, caption }: { value: Message | undefined; caption?: string }) {
  let kind = ''
  let body: React.ReactNode
  if (value === undefined || value === null || value === '' || value === 'bang') {
    body = (
      <div className="pw-main">
        <div className="pw-empty">Waiting for data — wire something into this box</div>
      </div>
    )
  } else if (typeof value === 'number') {
    kind = 'number'
    body = (
      <div className="pw-main">
        <div className="pw-number">{Math.abs(value) >= 1e6 ? compactNumber(value) : value.toLocaleString('en-US', { maximumFractionDigits: 8 })}</div>
      </div>
    )
  } else if (typeof value === 'string' || typeof value === 'boolean') {
    kind = 'text'
    body = (
      <div className="pw-main">
        <div className="pw-text">{String(value)}</div>
      </div>
    )
  } else if (Array.isArray(value)) {
    kind = `table · ${value.length} rows`
    const tokens = value.length > 0 && value.every(isTokenLike)
    body = (
      <div className="pw-scroll scroll-y">
        {tokens ? (
          <TokenTable items={value as Row[]} />
        ) : (
          <table className="pw-table">
            <tbody>
              {value.map((item, i) => (
                <tr key={i}>
                  <td className="dim">{i}</td>
                  <td>{describeItem(item)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    )
  } else if (isTokenLike(value)) {
    kind = 'token'
    body = <TokenCard token={value} />
  } else {
    const entries = Object.entries(value as Row).filter(([, v]) => v !== undefined && v !== null)
    kind = `table · 1 row`
    body = (
      <div className="pw-scroll scroll-y">
        {entries.map(([k, v]) => (
          <div key={k} className="pw-kv">
            <span>{k}</span>
            <strong>{describeValue(v, k)}</strong>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="pw">
      <div className="pw-cap">
        <span>{caption}</span>
        <span>{kind}</span>
      </div>
      {body}
    </div>
  )
}
