import { useEffect, useMemo, useRef, useState } from 'react'
import { getMarkets, getTrending, searchCoins } from '../services/coingecko'
import { money, percent } from '../lib/format'
import type { BlockProps } from '../blocks/types'
import { useListKeys } from './TokenSearch'

/** What the picker lists — normalised across CoinGecko's search, markets and trending responses. */
interface CoinRow {
  id: string
  name: string
  symbol: string
  image: string
  rank: number | null
  price?: number | null
  change24h?: number | null
}

type Pick = (c: CoinRow) => void

function Row({ coin, active, onHover, onPick }: { coin: CoinRow; active: boolean; onHover: () => void; onPick: Pick }) {
  const trend = coin.change24h == null ? '' : coin.change24h >= 0 ? 'up' : 'down'
  return (
    <button className={`ts-row${active ? ' active' : ''}`} onMouseEnter={onHover} onClick={() => onPick(coin)}>
      {coin.image ? <img src={coin.image} alt="" /> : <span className="ts-fallback">{coin.symbol.slice(0, 2)}</span>}
      <span className="ts-main">
        <strong>
          {coin.name} <em>{coin.symbol.toUpperCase()}</em>
        </strong>
        <small>{coin.rank ? `Rank #${coin.rank}` : 'Unranked'}</small>
      </span>
      {coin.price !== undefined && (
        <span className="ts-nums">
          <strong>{money(coin.price)}</strong>
          <small className={trend}>{percent(coin.change24h)}</small>
        </span>
      )}
    </button>
  )
}

function SearchBox({ onPick }: { onPick: Pick }) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<CoinRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const q = text.trim()
    if (q.length < 2) {
      setResults([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    // Longer debounce than DexScreener: CoinGecko's keyless rate limit is tight.
    const t = setTimeout(async () => {
      try {
        const coins = await searchCoins(q)
        if (cancelled) return
        setResults(coins.map((c) => ({ id: c.id, name: c.name, symbol: c.symbol, image: c.thumb, rank: c.market_cap_rank })))
        setError(coins.length ? null : 'No coins found')
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [text])

  const pick = (c: CoinRow) => {
    onPick(c)
    setText('')
  }
  const keys = useListKeys(results, pick, () => setText(''), listRef)

  return (
    <>
      <div className="ts-input">
        <span className="ts-icon">⌕</span>
        <input
          type="text"
          value={text}
          placeholder="Search CoinGecko coins…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys.onKeyDown}
        />
        {loading && <span className="spinner" />}
      </div>
      {text.trim().length >= 2 && (
        <div className="ts-results" ref={listRef}>
          {error && !loading && <div className="ts-empty">{error}</div>}
          {results.map((c, i) => (
            <Row key={c.id} coin={c} active={i === keys.active} onHover={() => keys.setActive(i)} onPick={pick} />
          ))}
        </div>
      )}
    </>
  )
}

const SOURCES = [
  { value: 'top', label: 'Top 250', help: 'Largest coins by market cap' },
  { value: 'trending', label: 'Trending', help: 'Most searched on CoinGecko (24h)' },
] as const
type Source = (typeof SOURCES)[number]['value']

async function loadSource(source: Source): Promise<CoinRow[]> {
  if (source === 'top') {
    const coins = await getMarkets({ perPage: 250 })
    return coins.map((c) => ({
      id: c.id,
      name: c.name,
      symbol: c.symbol,
      image: c.image,
      rank: c.market_cap_rank,
      price: c.current_price,
      change24h: c.price_change_percentage_24h,
    }))
  }
  const coins = await getTrending()
  return coins.map((c) => ({
    id: c.id,
    name: c.name,
    symbol: c.symbol,
    image: c.small,
    rank: c.market_cap_rank,
    price: c.data.price,
    change24h: c.data.price_change_percentage_24h?.usd ?? null,
  }))
}

/** Best matches first: exact symbol, symbol prefix, name prefix, then anything containing the text. */
function filterCoins(coins: CoinRow[], text: string): CoinRow[] {
  const q = text.trim().toLowerCase()
  if (!q) return coins
  const buckets: CoinRow[][] = [[], [], [], []]
  for (const c of coins) {
    const sym = c.symbol.toLowerCase()
    const name = c.name.toLowerCase()
    if (sym === q) buckets[0].push(c)
    else if (sym.startsWith(q)) buckets[1].push(c)
    else if (name.startsWith(q)) buckets[2].push(c)
    else if (name.includes(q) || sym.includes(q) || c.id.includes(q)) buckets[3].push(c)
  }
  return buckets.flat()
}

const ROW_HEIGHT = 46
const LIST_HEIGHT = 380
const OVERSCAN = 6

function CoinBrowser({ onPick }: { onPick: Pick }) {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<Source>('top')
  const [scrollTop, setScrollTop] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [filter, setFilter] = useState('')
  const [coins, setCoins] = useState<CoinRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    loadSource(source)
      .then((c) => !cancelled && setCoins(c))
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [open, source, attempt])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const shown = useMemo(() => filterCoins(coins, filter), [coins, filter])

  // Jump back to the top whenever the list changes.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
    setScrollTop(0)
  }, [shown])

  // Only rows in view are rendered, so long lists stay fast.
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(shown.length, Math.ceil((scrollTop + LIST_HEIGHT) / ROW_HEIGHT) + OVERSCAN)

  const scrollToIndex = (i: number) => {
    const el = listRef.current
    if (!el) return
    const top = i * ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight
  }

  const pick = (c: CoinRow) => {
    onPick(c)
    setOpen(false)
    setFilter('')
  }
  const keys = useListKeys(shown, pick, () => setOpen(false), listRef, scrollToIndex)
  const info = SOURCES.find((s) => s.value === source)!

  return (
    <div className="tb" ref={rootRef}>
      <button className={`tb-trigger${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span>
          Browse coins <em>· {info.label}</em>
        </span>
        <span className="tb-caret">▾</span>
      </button>
      {open && (
        <div className="tb-menu">
          <div className="tb-tabs">
            {SOURCES.map((s) => (
              <button key={s.value} className={s.value === source ? 'active' : ''} onClick={() => setSource(s.value)} title={s.help}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="ts-input">
            <span className="ts-icon">⌕</span>
            <input
              autoFocus
              type="text"
              value={filter}
              placeholder={`Filter ${info.label.toLowerCase()}…`}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={keys.onKeyDown}
            />
            {loading && <span className="spinner" />}
          </div>
          <div className="tb-meta">
            {info.help}
            {!loading && !error && ` · ${shown.length.toLocaleString()} coin${shown.length === 1 ? '' : 's'}`}
          </div>
          <div
            className="ts-results tb-list tb-virtual"
            ref={listRef}
            style={{ maxHeight: LIST_HEIGHT }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            {error && (
              <div className="ts-empty">
                <div className="tc-error">{error}</div>
                <button className="ghost-btn tb-retry" onClick={() => setAttempt((a) => a + 1)}>
                  Retry
                </button>
              </div>
            )}
            {!error && !loading && shown.length === 0 && <div className="ts-empty">No coins match your filter</div>}
            {!error && shown.length > 0 && (
              <div style={{ height: shown.length * ROW_HEIGHT, position: 'relative' }}>
                {shown.slice(first, last).map((c, j) => {
                  const i = first + j
                  return (
                    <div key={c.id} className="tb-vrow" style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}>
                      <Row coin={c} active={i === keys.active} onHover={() => keys.setActive(i)} onPick={pick} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** CoinGecko coin picker. Writes `coinId` and `coinLabel` on the block. */
export function CoinSearch({ props, onChange }: { props: BlockProps; onChange: (p: Partial<BlockProps>) => void }) {
  const pick = (c: CoinRow) => onChange({ coinId: c.id, coinLabel: `${c.name} (${c.symbol.toUpperCase()})` })
  const current = String(props.coinLabel || props.coinId || '')

  return (
    <div className="field token-search">
      <span>Coin</span>
      <div className={`ts-current${current ? '' : ' none'}`}>
        <span className="ts-current-label">{current || 'No coin selected'}</span>
        {current && (
          <button className="ts-clear" title="Clear coin" onClick={() => onChange({ coinId: '', coinLabel: '' })}>
            ✕
          </button>
        )}
      </div>
      <SearchBox onPick={pick} />
      <CoinBrowser onPick={pick} />
      <small>Data from CoinGecko — use search for coins outside the top 250</small>
    </div>
  )
}
