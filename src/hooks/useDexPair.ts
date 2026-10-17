import { useEffect, useState } from 'react'
import { findPair, type DexPair } from '../services/dexscreener'

interface State {
  pair: DexPair | null
  loading: boolean
  error: string | null
  updatedAt: number | null
}

export function useDexPair(query: string, chain: string, pairAddress: string, refreshSec: number): State {
  const [state, setState] = useState<State>({ pair: null, loading: false, error: null, updatedAt: null })

  useEffect(() => {
    if (!query.trim() && !pairAddress) {
      setState({ pair: null, loading: false, error: null, updatedAt: null })
      return
    }
    let controller = new AbortController()

    const load = async (initial: boolean) => {
      controller.abort()
      controller = new AbortController()
      if (initial) setState((s) => ({ ...s, loading: true, error: null }))
      try {
        const pair = await findPair(query, chain, pairAddress, controller.signal)
        setState({
          pair,
          loading: false,
          error: pair ? null : `No token matching "${query.trim()}"${chain ? ` on ${chain}` : ''} on DexScreener`,
          updatedAt: Date.now(),
        })
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        setState((s) => ({ ...s, loading: false, error: (e as Error).message }))
      }
    }

    // Debounce so typing in the inspector doesn't fire a request per keystroke.
    const debounce = setTimeout(() => load(true), 400)
    const interval = refreshSec > 0 ? setInterval(() => load(false), Math.max(5, refreshSec) * 1000) : undefined

    return () => {
      clearTimeout(debounce)
      if (interval) clearInterval(interval)
      controller.abort()
    }
  }, [query, chain, pairAddress, refreshSec])

  return state
}
