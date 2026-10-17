import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { CHAINS, searchPairs, type DexPair } from '../services/dexscreener'
import { getTokenList, LIST_SOURCES, type ListSource } from '../services/tokenLists'
import { usdCompact, usdPrice } from '../lib/format'
import type { BlockProps } from '../blocks/types'

const chainLabel = (id: string) => CHAINS.find((c) => c.value === id)?.label ?? id

type Pick = (p: DexPair) => void

function PairRow({ pair, active, onHover, onPick }: { pair: DexPair; active: boolean; onHover: () => void; onPick: Pick }) {
  return (
    <button className={`ts-row${active ? ' active' : ''}`} onMouseEnter={onHover} onClick={() => onPick(pair)}>
      {pair.info?.imageUrl ? (
        <img src={pair.info.imageUrl} alt="" />
      ) : (
        <span className="ts-fallback">{pair.baseToken.symbol.slice(0, 2)}</span>
      )}
      <span className="ts-main">
        <strong>
          {pair.baseToken.symbol}
          <em>/{pair.quoteToken.symbol}</em>
        </strong>
        <small>
          {pair.baseToken.name} · {chainLabel(pair.chainId)} · {pair.dexId}
        </small>
      </span>
      <span className="ts-nums">
        <strong>{usdPrice(pair.priceUsd)}</strong>
        <small>Liq {usdCompact(pair.liquidity?.usd)}</small>
      </span>
    </button>
  )
}

/** Arrow keys move through `items`, Enter picks, Escape calls onEscape. */
export function useListKeys<T>(
  items: T[],
  onPick: (item: T) => void,
  onEscape: () => void,
  listRef: RefObject<HTMLDivElement>,
  /** For virtualised lists, where the active row may not be in the DOM. */
  scrollToIndex?: (i: number) => void,
) {
  const [active, setActive] = useState(0)
  useEffect(() => setActive(0), [items])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(0, Math.min(items.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      if (scrollToIndex) scrollToIndex(next)
      else listRef.current?.querySelectorAll('.ts-row')[next]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && items[active]) {
      onPick(items[active])
    } else if (e.key === 'Escape') {
      onEscape()
    }
  }
  return { active, setActive, onKeyDown }
}

/** Live DexScreener search as you type. */
function SearchBox({ chain, onPick }: { chain: string; onPick: Pick }) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<DexPair[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const q = text.trim()
    if (!q) {
      setResults([])
      setError(null)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const pairs = await searchPairs(q, chain, controller.signal)
        setResults(pairs)
        setError(pairs.length ? null : chain ? `No results on ${chainLabel(chain)}` : 'No results')
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 300)
    return () => {
      clearTimeout(t)
      controller.abort()
    }
  }, [text, chain])

  const pick = (p: DexPair) => {
    onPick(p)
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
          placeholder="Search name, symbol or address…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys.onKeyDown}
        />
        {loading && <span className="spinner" />}
      </div>
      {text.trim() && (
        <div className="ts-results" ref={listRef}>
          {error && !loading && <div className="ts-empty">{error}</div>}
          {results.map((p, i) => (
            <PairRow key={`${p.chainId}:${p.pairAddress}`} pair={p} active={i === keys.active} onHover={() => keys.setActive(i)} onPick={pick} />
          ))}
        </div>
      )}
    </>
  )
}

/** Dropdown listing tokens fetched from DexScreener's lists, filterable as you type. */
function TokenBrowser({ chain, onPick }: { chain: string; onPick: Pick }) {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<ListSource>('popular')
  const [filter, setFilter] = useState('')
  const [pairs, setPairs] = useState<DexPair[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    getTokenList(source)
      .then((p) => !cancelled && setPairs(p))
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [open, source])

  // Close when clicking anywhere outside the dropdown.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return pairs.filter(
      (p) =>
        (!chain || p.chainId === chain) &&
        (!q ||
          p.baseToken.symbol.toLowerCase().includes(q) ||
          p.baseToken.name.toLowerCase().includes(q) ||
          p.baseToken.address.toLowerCase() === q),
    )
  }, [pairs, chain, filter])

  const pick = (p: DexPair) => {
    onPick(p)
    setOpen(false)
    setFilter('')
  }
  const keys = useListKeys(shown, pick, () => setOpen(false), listRef)
  const sourceInfo = LIST_SOURCES.find((s) => s.value === source)!

  return (
    <div className="tb" ref={rootRef}>
      <button className={`tb-trigger${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span>
          Browse tokens <em>· {sourceInfo.label}</em>
        </span>
        <span className="tb-caret">▾</span>
      </button>

      {open && (
        <div className="tb-menu">
          <div className="tb-tabs">
            {LIST_SOURCES.map((s) => (
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
              placeholder={`Filter ${sourceInfo.label.toLowerCase()} tokens…`}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={keys.onKeyDown}
            />
            {loading && <span className="spinner" />}
          </div>
          <div className="tb-meta">
            {sourceInfo.help}
            {!loading && ` · ${shown.length} token${shown.length === 1 ? '' : 's'}`}
            {chain && ` on ${chainLabel(chain)}`}
          </div>
          <div className="ts-results tb-list" ref={listRef}>
            {error && <div className="ts-empty">{error}</div>}
            {!error && !loading && shown.length === 0 && (
              <div className="ts-empty">
                {filter ? 'No tokens match your filter' : `No ${sourceInfo.label.toLowerCase()} tokens on ${chainLabel(chain)} — try "Any chain"`}
              </div>
            )}
            {shown.map((p, i) => (
              <PairRow key={`${p.chainId}:${p.pairAddress}`} pair={p} active={i === keys.active} onHover={() => keys.setActive(i)} onPick={pick} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Token picker: live search plus a browsable dropdown of DexScreener token lists.
 * Writes `query`, `chain`, `pairAddress` and `pairLabel` on the block, so blocks using it should declare those props.
 */
export function TokenSearch({ props, onChange }: { props: BlockProps; onChange: (p: Partial<BlockProps>) => void }) {
  const chain = String(props.chain ?? '')

  const pick = (p: DexPair) =>
    onChange({
      query: p.baseToken.address,
      chain: p.chainId,
      pairAddress: p.pairAddress,
      pairLabel: `${p.baseToken.symbol}/${p.quoteToken.symbol}`,
    })

  const current = String(props.pairLabel || '') || String(props.query || '')

  return (
    <div className="field token-search">
      <span>Token</span>
      <div className={`ts-current${current ? '' : ' none'}`}>
        <span className="ts-current-label">{current || 'No token selected'}</span>
        {current && chain && <span className="tc-chip">{chainLabel(chain)}</span>}
        {current && (
          <button
            className="ts-clear"
            title="Clear token"
            onClick={() => onChange({ query: '', pairAddress: '', pairLabel: '' })}
          >
            ✕
          </button>
        )}
      </div>
      <SearchBox chain={chain} onPick={pick} />
      <TokenBrowser chain={chain} onPick={pick} />
      <small>{chain ? `Showing ${chainLabel(chain)} only — set Chain to "Any chain" to widen` : 'Showing all chains'}</small>
    </div>
  )
}
