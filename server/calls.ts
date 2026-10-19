import fs from 'node:fs/promises'
import path from 'node:path'
import type { PriceSeries } from './smart'

/**
 * The calls log and its grading (Vibe-MM's Evaluation): every time an engine's call on a token changes,
 * it's written down with the price, the score and why. Later each BUY (and SELL, as a short) is graded
 * from the stored prices: its return after 1 h, 6 h and 24 h, and the trade plan's outcome — the target
 * or the stop, whichever came first, else the price at the end of the hold.
 *
 *   data/calls/calls.jsonl   one line per call change
 */

const MIN = 60_000
const HOUR = 60 * MIN
const KEEP_MS = 14 * 24 * HOUR
export const HORIZONS = [1, 6, 24]

export interface CallEntry {
  id: string
  at: number
  chain: string
  token: string
  symbol: string
  engine: string
  call: string
  score: number | null
  price: number | null
  why: string
  /** The trade plan's frame when it was a BUY (target / stop %, hold hours). */
  plan?: { targetPct: number; stopPct: number; holdHours: number } | null
}

export interface Grade {
  /** % return at each horizon (sign-adjusted for SELL: a fall is a gain), null until known. */
  r: Record<number, number | null>
  /** The plan: 'target' / 'stop' / 'time' and its return, null until resolved. */
  plan: { outcome: 'target' | 'stop' | 'time'; returnPct: number } | null
  done: boolean
}

export function createCallLog(dir: string) {
  const file = path.join(dir, 'calls.jsonl')
  const entries: CallEntry[] = []
  const last = new Map<string, string>()
  const grades = new Map<string, Grade>()
  let pendingLines: string[] = []

  /** Log the call changes in this round: only what changed since the token's last logged call. */
  function log(list: Omit<CallEntry, 'id'>[]) {
    for (const c of list) {
      const k = `${c.engine}|${c.token}`
      if (last.get(k) === c.call) continue
      last.set(k, c.call)
      const e = { ...c, id: `${c.at.toString(36)}-${Math.random().toString(36).slice(2, 7)}` }
      entries.push(e)
      pendingLines.push(JSON.stringify(e))
    }
  }

  async function save() {
    if (!pendingLines.length) return
    await fs.mkdir(dir, { recursive: true })
    const lines = pendingLines
    pendingLines = []
    await fs.appendFile(file, lines.join('\n') + '\n')
  }

  async function load() {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    const cut = Date.now() - KEEP_MS
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as CallEntry
        if (e.at < cut) continue
        entries.push(e)
        last.set(`${e.engine}|${e.token}`, e.call)
      } catch {
        /* a cut line */
      }
    }
  }

  /** Grade every BUY / SELL not finished yet, from the stored prices (one read per token). */
  async function grade(series: PriceSeries, now = Date.now()) {
    const todo = entries.filter((e) => (e.call === 'BUY' || e.call === 'SELL') && !grades.get(e.id)?.done && e.price)
    const byToken = new Map<string, CallEntry[]>()
    for (const e of todo) (byToken.get(e.token) ?? byToken.set(e.token, []).get(e.token)!).push(e)
    for (const [token, list] of byToken) {
      const from = Math.min(...list.map((e) => e.at))
      const pts = await series(token, from, now)
      for (const e of list) {
        const dir = e.call === 'SELL' ? -1 : 1
        const p0 = e.price!
        const after = pts.filter(([t]) => t > e.at)
        const at = (h: number) => {
          const target = e.at + h * HOUR
          if (now < target) return null
          const near = after.find(([t]) => t >= target && t - target <= 20 * MIN) ?? [...after].reverse().find(([t]) => t <= target && target - t <= 20 * MIN)
          return near ? dir * (near[1] / p0 - 1) * 100 : null
        }
        const r: Record<number, number | null> = {}
        for (const h of HORIZONS) r[h] = at(h)
        const frame = e.plan ?? { targetPct: 10, stopPct: 7, holdHours: 6 }
        let plan: Grade['plan'] = null
        const end = e.at + frame.holdHours * HOUR
        for (const [t, px] of after) {
          if (t > end) break
          const ret = dir * (px / p0 - 1) * 100
          if (ret >= frame.targetPct) {
            plan = { outcome: 'target', returnPct: frame.targetPct }
            break
          }
          if (ret <= -frame.stopPct) {
            plan = { outcome: 'stop', returnPct: -frame.stopPct }
            break
          }
        }
        if (!plan && now >= end) {
          const h = r[frame.holdHours] ?? at(frame.holdHours)
          if (h != null) plan = { outcome: 'time', returnPct: h }
        }
        const done = HORIZONS.every((h) => r[h] != null || now > e.at + h * HOUR + 2 * HOUR) && (plan != null || now > end + 2 * HOUR)
        grades.set(e.id, { r, plan, done })
      }
    }
  }

  /** Per engine: BUYs and SELLs, how many are graded, average returns, plan win rate (one token's, or all). */
  function summary(token?: string) {
    const out: Record<string, Record<string, unknown>> = {}
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null)
    for (const e of entries) {
      if (token && e.token !== token) continue
      if (e.call !== 'BUY' && e.call !== 'SELL') continue
      const g = grades.get(e.id)
      const s = (out[e.engine] ??= { buys: 0, sells: 0, r1: [], r6: [], r24: [], plans: [], wins: 0 }) as Record<string, number | number[]>
      if (e.call === 'BUY') (s.buys as number)++
      else (s.sells as number)++
      if (g?.r[1] != null) (s.r1 as number[]).push(g.r[1])
      if (g?.r[6] != null) (s.r6 as number[]).push(g.r[6])
      if (g?.r[24] != null) (s.r24 as number[]).push(g.r[24])
      if (g?.plan) {
        ;(s.plans as number[]).push(g.plan.returnPct)
        if (g.plan.returnPct > 0) (s.wins as number)++
      }
    }
    return Object.fromEntries(
      Object.entries(out).map(([engine, s]) => {
        const plans = s.plans as number[]
        return [
          engine,
          { buys: s.buys, sells: s.sells, graded: plans.length, avg1h: avg(s.r1 as number[]), avg6h: avg(s.r6 as number[]), avg24h: avg(s.r24 as number[]), planAvg: avg(plans), planWinPct: plans.length ? Math.round(((s.wins as number) / plans.length) * 100) : null },
        ]
      }),
    )
  }

  /** The latest calls (optionally one token's), newest first, with their grades. */
  const recent = (n = 100, token?: string) =>
    entries
      .filter((e) => !token || e.token === token)
      .slice(-n)
      .reverse()
      .map((e) => ({ ...e, grade: grades.get(e.id) ?? null }))

  const count = () => entries.length

  return { log, save, load, grade, summary, recent, count }
}
