import fs from 'node:fs/promises'
import path from 'node:path'
import type { TapeTrade } from './tape'

/**
 * Smart wallets, learned from our own data (Vibe-MM's rule, scripts/backtest-early.mjs): every buy of $20+
 * seen on the trade tape is remembered; once its 6 hours are over it's judged against the token's stored
 * prices — a WIN if the price went +10% before -7%. A wallet is SMART when at least `minResolved` of its
 * buys are judged, on `minTokens` or more tokens, and `minRate` of them won.
 *
 *   data/smart/pending.json   buys waiting for their 6 hours
 *   data/smart/wallets.json   every judged wallet's record, per chain
 */

const MIN = 60_000
const HOUR = 60 * MIN

export const SMART_RULE = { minBuyUsd: 20, horizonMs: 6 * HOUR, winPct: 10, lossPct: 7, minResolved: 3, minTokens: 2, minRate: 0.4 }

interface Pending {
  chain: string
  wallet: string
  token: string
  at: number
  price: number | null
}

interface WalletRecord {
  buys: number
  wins: number
  tokens: string[]
  lastAt: number
}

/** A token's prices over a span, oldest first: [time, price]. */
export type PriceSeries = (token: string, from: number, to: number) => Promise<[number, number][]>

const MAX_PENDING = 300_000

export function createSmart(dir: string) {
  const pending = new Map<string, Pending>()
  /** chain → wallet → record */
  const wallets = new Map<string, Map<string, WalletRecord>>()
  let judged = 0
  let won = 0
  let dirty = false

  /** Remember the tape's new buys (one per wallet, token and 10 minutes — bots buy in bursts). */
  function record(chain: string, trades: TapeTrade[]) {
    for (const t of trades) {
      if (t.kind !== 'buy' || t.usd < SMART_RULE.minBuyUsd) continue
      const key = `${chain}|${t.wallet}|${t.token}|${Math.floor(t.at / (10 * MIN))}`
      if (pending.has(key)) continue
      pending.set(key, { chain, wallet: t.wallet, token: t.token, at: t.at, price: t.price ?? null })
      dirty = true
    }
    if (pending.size > MAX_PENDING) {
      const oldest = [...pending.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, pending.size - MAX_PENDING)
      for (const [k] of oldest) pending.delete(k)
    }
  }

  /** Judge every buy whose 6 hours are over, from the stored prices (one read per token). */
  async function resolve(series: PriceSeries, now = Date.now()) {
    const due = [...pending.entries()].filter(([, p]) => p.at + SMART_RULE.horizonMs <= now)
    const byToken = new Map<string, [string, Pending][]>()
    for (const e of due) (byToken.get(e[1].token) ?? byToken.set(e[1].token, []).get(e[1].token)!).push(e)
    for (const [token, list] of byToken) {
      const from = Math.min(...list.map(([, p]) => p.at)) - 5 * MIN
      const to = Math.max(...list.map(([, p]) => p.at)) + SMART_RULE.horizonMs
      const pts = await series(token, from, to)
      for (const [key, p] of list) {
        pending.delete(key)
        dirty = true
        // The entry: the stored price at (or just before) the buy, else the trade's own price.
        const before = pts.filter(([t]) => t <= p.at && p.at - t <= 5 * MIN)
        const p0 = before.length ? before[before.length - 1][1] : p.price
        if (!p0) continue
        const after = pts.filter(([t]) => t > p.at && t <= p.at + SMART_RULE.horizonMs)
        // Not covered to the end of its 6 hours: unresolved, never a guess.
        if (!after.length || p.at + SMART_RULE.horizonMs - after[after.length - 1][0] > 20 * MIN) continue
        let win: boolean | null = null
        for (const [, px] of after) {
          const r = (px / p0 - 1) * 100
          if (r >= SMART_RULE.winPct) {
            win = true
            break
          }
          if (r <= -SMART_RULE.lossPct) {
            win = false
            break
          }
        }
        win ??= false
        judged++
        if (win) won++
        const chainMap = wallets.get(p.chain) ?? wallets.set(p.chain, new Map()).get(p.chain)!
        const rec = chainMap.get(p.wallet) ?? { buys: 0, wins: 0, tokens: [], lastAt: 0 }
        rec.buys++
        if (win) rec.wins++
        if (!rec.tokens.includes(token)) rec.tokens.push(token)
        rec.lastAt = Math.max(rec.lastAt, p.at)
        chainMap.set(p.wallet, rec)
      }
    }
  }

  const isSmart = (r: WalletRecord) => r.buys >= SMART_RULE.minResolved && r.tokens.length >= SMART_RULE.minTokens && r.wins / r.buys >= SMART_RULE.minRate

  /** A chain's smart wallets now, or null while none are known (so SMART shows nothing, never zero). */
  function setFor(chain: string): Set<string> | null {
    const m = wallets.get(chain)
    if (!m) return null
    const s = new Set([...m.entries()].filter(([, r]) => isSmart(r)).map(([w]) => w))
    return s.size ? s : null
  }

  /** The smart wallets of a chain, best first (for the panels). */
  const list = (chain: string) =>
    [...(wallets.get(chain) ?? new Map<string, WalletRecord>()).entries()]
      .filter(([, r]) => isSmart(r))
      .map(([wallet, r]) => ({ wallet, buys: r.buys, wins: r.wins, rate: r.wins / r.buys, tokens: r.tokens.length, lastAt: r.lastAt }))
      .sort((a, b) => b.rate - a.rate || b.buys - a.buys)

  function stats() {
    const perChain: Record<string, { judgedWallets: number; smart: number }> = {}
    for (const [chain, m] of wallets) perChain[chain] = { judgedWallets: m.size, smart: [...m.values()].filter(isSmart).length }
    return { pending: pending.size, judged, baseWinPct: judged ? Math.round((won / judged) * 1000) / 10 : null, chains: perChain, rule: SMART_RULE }
  }

  async function save() {
    if (!dirty) return
    dirty = false
    await fs.mkdir(dir, { recursive: true })
    const write = async (name: string, data: unknown) => {
      const file = path.join(dir, name)
      await fs.writeFile(`${file}.${process.pid}.tmp`, JSON.stringify(data))
      await fs.rename(`${file}.${process.pid}.tmp`, file).catch(() => {})
    }
    await write('pending.json', [...pending.values()])
    await write('wallets.json', { judged, won, chains: Object.fromEntries([...wallets].map(([c, m]) => [c, Object.fromEntries(m)])) })
  }

  async function load() {
    try {
      const list = JSON.parse(await fs.readFile(path.join(dir, 'pending.json'), 'utf8')) as Pending[]
      for (const p of list) pending.set(`${p.chain}|${p.wallet}|${p.token}|${Math.floor(p.at / (10 * MIN))}`, p)
    } catch {
      /* first run */
    }
    try {
      const w = JSON.parse(await fs.readFile(path.join(dir, 'wallets.json'), 'utf8')) as { judged: number; won: number; chains: Record<string, Record<string, WalletRecord>> }
      judged = w.judged ?? 0
      won = w.won ?? 0
      for (const [c, m] of Object.entries(w.chains ?? {})) wallets.set(c, new Map(Object.entries(m)))
    } catch {
      /* first run */
    }
  }

  return { record, resolve, setFor, list, stats, save, load }
}
