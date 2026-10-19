import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The trade tape: recent trades of many pools on a chain, wallet by wallet — what the rotation engine
 * reads (a wallet selling one token and buying another is capital rotating between them).
 *
 * Fed by the `tradeTape` job (server/engine.ts), which samples a few pools' last trades per run from
 * GeckoTerminal. Trades are kept for WINDOW_MS, deduplicated by transaction, and saved to
 * data/trades/<chain>.json so a restart picks up where it was.
 */

export interface TapeTrade {
  /** When it happened (ms). */
  at: number
  /** The pool it traded in, and the token (chain:address) bought or sold. */
  pool: string
  token: string
  symbol: string
  kind: 'buy' | 'sell'
  usd: number
  /** The token's USD price in this trade (GeckoTerminal's), when known. */
  price?: number | null
  wallet: string
  tx: string
}

interface PoolTape {
  pool: string
  token: string
  symbol: string
  /** When this pool was last sampled. */
  sampledAt: number
  trades: TapeTrade[]
}

/** How long trades are kept: rotation reads the last 1–2 h; 6 h leaves room for trends. */
export const WINDOW_MS = 6 * 3600e3

export function createTape(dir: string) {
  const chains = new Map<string, Map<string, PoolTape>>()
  const fileOf = (chain: string) => path.join(dir, `${chain}.json`)
  const dirty = new Set<string>()

  const poolsOf = (chain: string) => {
    let m = chains.get(chain)
    if (!m) chains.set(chain, (m = new Map()))
    return m
  }

  /** Add a pool's freshly sampled trades: new ones are kept, ones already held are skipped. */
  /** Add a pool's freshly sampled trades; returns the ones that were new. */
  function add(chain: string, p: { pool: string; token: string; symbol: string }, trades: TapeTrade[], at = Date.now()): TapeTrade[] {
    const pools = poolsOf(chain)
    const held = pools.get(p.pool) ?? { ...p, sampledAt: 0, trades: [] }
    const seen = new Set(held.trades.map((t) => `${t.tx}|${t.wallet}|${t.kind}`))
    const added: TapeTrade[] = []
    for (const t of trades) {
      const k = `${t.tx}|${t.wallet}|${t.kind}`
      if (seen.has(k)) continue
      seen.add(k)
      held.trades.push(t)
      added.push(t)
    }
    held.trades.sort((a, b) => a.at - b.at)
    held.sampledAt = at
    held.symbol = p.symbol || held.symbol
    pools.set(p.pool, held)
    dirty.add(chain)
    return added
  }

  /** Drop trades older than the window, and pools with nothing left. */
  function prune(now = Date.now()) {
    for (const [chain, pools] of chains)
      for (const [key, p] of pools) {
        const before = p.trades.length
        p.trades = p.trades.filter((t) => now - t.at <= WINDOW_MS)
        if (p.trades.length !== before) dirty.add(chain)
        if (!p.trades.length && now - p.sampledAt > WINDOW_MS) pools.delete(key)
      }
  }

  async function save() {
    if (!dirty.size) return
    await fs.mkdir(dir, { recursive: true })
    for (const chain of [...dirty]) {
      dirty.delete(chain)
      const tmp = `${fileOf(chain)}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify([...(chains.get(chain)?.values() ?? [])]))
      await fs.rename(tmp, fileOf(chain)).catch(() => {})
    }
  }

  async function load() {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      try {
        const list = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')) as PoolTape[]
        const pools = poolsOf(n.slice(0, -5))
        for (const p of list) pools.set(p.pool, p)
      } catch {
        /* a broken file starts over */
      }
    }
    prune()
  }

  /** The chains with a tape. */
  const chainList = () => [...chains.keys()].filter((c) => (chains.get(c)?.size ?? 0) > 0)

  /** When a pool was last sampled (0 = never). */
  const sampledAt = (chain: string, pool: string) => chains.get(chain)?.get(pool)?.sampledAt ?? 0

  /** Every trade held on a chain since `since`, oldest first. */
  function trades(chain: string, since = 0): TapeTrade[] {
    const out: TapeTrade[] = []
    for (const p of chains.get(chain)?.values() ?? []) for (const t of p.trades) if (t.at >= since) out.push(t)
    return out.sort((a, b) => a.at - b.at)
  }

  /** One pool's tape. */
  const pool = (chain: string, key: string) => chains.get(chain)?.get(key) ?? null

  /** What's held, per chain: pools, trades, wallets, and the span of time it covers. */
  function stats() {
    const out: Record<string, { pools: number; trades: number; wallets: number; sharedWallets: number; from: number | null; to: number | null; freshPools: number }> = {}
    const now = Date.now()
    for (const [chain, pools] of chains) {
      const byWallet = new Map<string, Set<string>>()
      let n = 0
      let from = Infinity
      let to = -Infinity
      let fresh = 0
      for (const p of pools.values()) {
        if (now - p.sampledAt < 30 * 60_000) fresh++
        for (const t of p.trades) {
          n++
          from = Math.min(from, t.at)
          to = Math.max(to, t.at)
          const s = byWallet.get(t.wallet) ?? new Set<string>()
          s.add(p.pool)
          byWallet.set(t.wallet, s)
        }
      }
      out[chain] = {
        pools: pools.size,
        trades: n,
        wallets: byWallet.size,
        // Wallets seen in two or more pools: the raw material of rotation.
        sharedWallets: [...byWallet.values()].filter((s) => s.size > 1).length,
        from: Number.isFinite(from) ? from : null,
        to: Number.isFinite(to) ? to : null,
        freshPools: fresh,
      }
    }
    return out
  }

  return { add, prune, save, load, sampledAt, trades, pool, stats, chains: chainList }
}
