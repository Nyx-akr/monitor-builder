import type { TapeTrade } from './tape'

/**
 * The rotation engine — a port of Vibe-MM's (src/flow/score-flow.js, src/calculations/core.js), on Dex
 * Builder's data: the trade tape (server/tape.ts) for wallets, the stored history for price / volume /
 * buyers, and the enrichment for liquidity, organic score, honeypot, taxes and the $10K impact.
 *
 * ROTATION: a wallet that sold another token in the last 2 h and bought this one in the last hour rotated
 * IN; one that sold this one and bought another rotated OUT. Scores 0–100 per engine, then a call per
 * engine (BUY / WATCH / SELL / AVOID) gated by the token's phase, safety and execution cost, with a hold
 * rule so a call doesn't flicker. Every number is a floor over the pools the tape has sampled.
 */

const MIN = 60_000
const HOUR = 60 * MIN

/** Vibe-MM's lines and rules (tuned there by walk-forward backtests, 2026-10-14). Editable: see applyRules. */
export const DEFAULT_RULES = {
  rotationWindowMs: 2 * HOUR,
  marketWindowMs: 2 * HOUR,
  lines: {
    cycle: { buy: 85, hold: 80 },
    momentum: { buy: 60, hold: 45 },
    smart: { buy: 70, hold: 40 },
    flow: { buy: 60, hold: 40 },
    rotation: { buy: 80, hold: 60 },
    blend: { buy: 100, hold: 50 },
    rotationPlus: { buy: 80, hold: 60 },
    consensus: { buy: 100, hold: 50 },
    rotationMidLiq: { buy: 80, hold: 60 },
    smartRotation: { buy: 80, hold: 60 },
    quality: { buy: 80, hold: 60 },
    tide: { buy: 80, hold: 60 },
  },
  /** TIDE doesn't buy while more than this ($ net, 2 h) leaves the pool for other pools. */
  rotVetoUsd: 200,
  /** The liquidity band ROTATION MID-LIQ and QUALITY ROTATION buy in. */
  liqLow: 200_000,
  liqHigh: 1_000_000,
  /** An early RUNNING token may still be bought while under this % above its 6 h low (not CYCLE). */
  lateUpPct: 12,
  phase: { runPct: 30, fadeOffHighPct: 10, runningPct: 5, quietRangePct: 1, smartExitSellers: 2 },
  hold: { memoryMin: 20, buyQuietHoldMin: 60 },
  safety: { minLiquidity: 20_000, maxTaxPct: 10 },
  execution: { tradeUsd: 1000, maxCostPct: 2, feeRoundTripPct: 0.6, thinCalibration: 0.55, deepFromUsd: 2e6, quoteUsd: 10_000 },
  /** The trade plan: hold this long, with this frame's target and stop. */
  plan: { holdHours: 6 },
  /** The engine whose call the Feed shows. */
  engine: 'quality' as Engine,
}
export const RULES: typeof DEFAULT_RULES = structuredClone(DEFAULT_RULES)

/** Change the rules (from the Rotation board's panel): deep-merged, unknown keys ignored. */
export function applyRules(patch: Record<string, unknown>) {
  const merge = (target: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src ?? {})) {
      if (!(k in target)) continue
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') merge(target[k] as Record<string, unknown>, v as Record<string, unknown>)
      else if (typeof v === typeof target[k]) target[k] = v
    }
  }
  merge(RULES as unknown as Record<string, unknown>, patch)
}
export const resetRules = () => Object.assign(RULES, structuredClone(DEFAULT_RULES))

/** How long a trade is held, and each frame's target and stop (%), as in Vibe-MM. */
export const TIME_FRAMES = [
  { hours: 1, targetPct: 4, stopPct: 3 },
  { hours: 2, targetPct: 6, stopPct: 4 },
  { hours: 6, targetPct: 10, stopPct: 7 },
  { hours: 12, targetPct: 15, stopPct: 10 },
  { hours: 24, targetPct: 20, stopPct: 15 },
]
export const frameOf = (hours: number) => TIME_FRAMES.find((f) => f.hours === hours) ?? TIME_FRAMES[2]

/** EARLY (the CYCLE engine's entry score): seven inputs, weighted, each a curve (Vibe-MM's EARLY_MODEL). */
const EARLY = {
  model: [
    { key: 'room', label: 'Room to run', weight: 30 },
    { key: 'waking', label: 'Waking tape', weight: 15 },
    { key: 'seasoning', label: 'Seasoning', weight: 15 },
    { key: 'holding', label: 'Holding highs', weight: 6 },
    { key: 'interest', label: 'Fresh interest', weight: 6 },
    { key: 'holders', label: 'Holder base', weight: 5 },
    { key: 'repeat', label: 'Repeat buyers', weight: 3 },
  ],
  minParts: 4,
  curves: {
    room: [[0, 40], [0.007, 100], [0.04, 100], [0.15, 0]] as [number, number][],
    holding: [[0, 60], [0.015, 100], [0.075, 100], [0.25, 0]] as [number, number][],
    waking: [[0, 0], [0.01, 100], [0.035, 100], [0.12, 0]] as [number, number][],
    repeatLo: 1.0,
    repeatHi: 2.0,
    holdersLo: 100,
    holdersHi: 20000,
    ageLoHours: 6,
    ageHiHours: 720,
  },
}
const to100 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100)
const multipleScore = (m: number | null | undefined) => (fin(m) && m > 0 ? to100(0.5 + 0.3 * Math.log10(m)) : null)
const logScore = (v: number | null | undefined, lo: number, hi: number) => (fin(v) && v > 0 ? to100((Math.log10(Math.max(v, 1)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) : null)

export type Engine =
  | 'cycle'
  | 'momentum'
  | 'smart'
  | 'flow'
  | 'rotation'
  | 'blend'
  | 'rotationPlus'
  | 'consensus'
  | 'rotationMidLiq'
  | 'smartRotation'
  | 'quality'
  | 'tide'
/** Vibe-MM's twelve engines. The first five read the market; the rest combine their scores. */
export const ENGINES: { key: Engine; label: string; blurb: string }[] = [
  { key: 'quality', label: 'QUALITY ROTATION', blurb: 'Rotation, confirmed by another engine, on a $200K–$1M pool (Vibe-MM’s default: best after costs).' },
  { key: 'rotation', label: 'ROTATION', blurb: 'Wallets selling other tokens to buy this one.' },
  { key: 'rotationPlus', label: 'ROTATION+', blurb: 'Rotation over its line, with another engine over its own.' },
  { key: 'rotationMidLiq', label: 'ROTATION MID-LIQ', blurb: 'Rotation, only on $200K–$1M pools (the band where it paid).' },
  { key: 'smartRotation', label: 'SMART ROTATION', blurb: 'Rotation with a learned smart wallet among this hour’s buyers.' },
  { key: 'tide', label: 'TIDE', blurb: 'Rotation with smart wallets or volume agreeing, and capital not leaving the pool.' },
  { key: 'cycle', label: 'CYCLE', blurb: 'The attention cycle: buys a WAKING token with room to run (the EARLY score).' },
  { key: 'momentum', label: 'MOMENTUM', blurb: 'The last 15 min trading well above the hour, buyers growing.' },
  { key: 'smart', label: 'SMART MONEY', blurb: 'Learned smart wallets buying, net of the ones selling.' },
  { key: 'flow', label: 'ORDER FLOW', blurb: 'Net buying in the tape, discounted for wash and inorganic flow.' },
  { key: 'blend', label: 'BLEND', blurb: 'Votes: a BUY when two or more base engines clear their own BUY line.' },
  { key: 'consensus', label: 'CONSENSUS', blurb: 'Two of the three best engines (ROTATION, SMART MONEY, MOMENTUM) over their lines.' },
]
const BASE: Engine[] = ['cycle', 'momentum', 'smart', 'flow', 'rotation']
export const DEFAULT_ENGINE: Engine = 'quality'

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const clamp100 = (x: number) => Math.max(0, Math.min(100, Math.round(x)))
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

/** Piecewise-linear: x mapped through [x, y] points (clamped at the ends). */
export function band(x: number | null | undefined, points: [number, number][]): number | null {
  if (!fin(x)) return null
  if (x <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]
    if (x <= x1) {
      const [x0, y0] = points[i - 1]
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
    }
  }
  return points[points.length - 1][1]
}

// ---------- the wallet tape ----------

/** Every wallet's trades across the sampled pools (built once per run). */
export function walletIndex(trades: TapeTrade[]): Map<string, TapeTrade[]> {
  const m = new Map<string, TapeTrade[]>()
  for (const t of trades) {
    const list = m.get(t.wallet)
    if (list) list.push(t)
    else m.set(t.wallet, [t])
  }
  return m
}

/** Wallets rotating into / out of this pool over the last hour (vs other pools' last 2 h). */
export function rotationOf(own: TapeTrade[], index: Map<string, TapeTrade[]>, pool: string, now: number) {
  if (!own.length) return null
  const oldest = Math.min(...own.map((t) => t.at))
  // Under 15 minutes of tape for this pool: too short to say anything about the last hour.
  if (!(oldest <= now - 15 * MIN)) return null
  const inW = new Map<string, number>()
  const outW = new Map<string, number>()
  for (const x of own) {
    if (x.at <= now - HOUR || x.at > now) continue
    const other = (kind: 'buy' | 'sell') => (index.get(x.wallet) ?? []).some((y) => y.pool !== pool && y.kind === kind && y.at > now - RULES.rotationWindowMs && y.at <= now)
    if (x.kind === 'buy' && other('sell')) inW.set(x.wallet, (inW.get(x.wallet) ?? 0) + x.usd)
    else if (x.kind === 'sell' && other('buy')) outW.set(x.wallet, (outW.get(x.wallet) ?? 0) + x.usd)
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)
  return { inWallets: inW.size, outWallets: outW.size, inUsd: sum(inW), outUsd: sum(outW) }
}

export interface Peer {
  pool: string
  token: string
  symbol: string
  /** Capital that arrived here from that pool / left here for it (min of both sides, per wallet). */
  inUsd: number
  outUsd: number
  wallets: number
}

/**
 * Capital between this pool and every other sampled pool over 2 h: per wallet active in both, net buying
 * here against net selling there is ARRIVING (credited min of the two sides, so no dollar counts twice),
 * the reverse LEAVING; same-direction is parallel, not rotation, and isn't counted.
 */
export function marketFlowOf(own: TapeTrade[], index: Map<string, TapeTrade[]>, pool: string, now: number) {
  const here = new Map<string, number>()
  let n = 0
  for (const x of own) {
    if (x.at <= now - RULES.marketWindowMs || x.at > now) continue
    here.set(x.wallet, (here.get(x.wallet) ?? 0) + (x.kind === 'buy' ? x.usd : -x.usd))
    n++
  }
  if (n < 3) return null
  const peers = new Map<string, Peer>()
  let inUsd = 0
  let outUsd = 0
  here.forEach((netHere, w) => {
    const there = new Map<string, { net: number; t: TapeTrade }>()
    for (const y of index.get(w) ?? []) {
      if (y.pool === pool || y.at <= now - RULES.marketWindowMs || y.at > now) continue
      const cur = there.get(y.pool) ?? { net: 0, t: y }
      cur.net += y.kind === 'buy' ? y.usd : -y.usd
      there.set(y.pool, cur)
    }
    there.forEach(({ net: netThere, t }, p) => {
      const peer = peers.get(p) ?? { pool: p, token: t.token, symbol: t.symbol, inUsd: 0, outUsd: 0, wallets: 0 }
      peer.wallets++
      if (netHere > 0 && netThere < 0) {
        const v = Math.min(netHere, -netThere)
        inUsd += v
        peer.inUsd += v
      } else if (netHere < 0 && netThere > 0) {
        const v = Math.min(-netHere, netThere)
        outUsd += v
        peer.outUsd += v
      }
      peers.set(p, peer)
    })
  })
  return { inUsd, outUsd, net: inUsd - outUsd, connected: peers.size, peers: [...peers.values()].filter((p) => p.inUsd || p.outUsd).sort((a, b) => b.inUsd + b.outUsd - (a.inUsd + a.outUsd)) }
}

/** The pool's own tape over the last hour: net buying ratio, and buys per buyer (high = one wallet churning). */
export function flowOf(own: TapeTrade[], now: number) {
  const hour = own.filter((t) => t.at > now - HOUR && t.at <= now)
  if (hour.length < 5) return null
  const buys = hour.filter((t) => t.kind === 'buy')
  const buyUsd = buys.reduce((s, t) => s + t.usd, 0)
  const sellUsd = hour.filter((t) => t.kind === 'sell').reduce((s, t) => s + t.usd, 0)
  const total = buyUsd + sellUsd
  const buyers = new Set(buys.map((t) => t.wallet)).size
  return { netRatio: total ? (buyUsd - sellUsd) / total : null, buysPerBuyer: buyers ? buys.length / buyers : null, trades: hour.length }
}

// ---------- measures and phase, from the stored history ----------

export interface Sample {
  t: number
  price?: number | null
  volume5m?: number | null
  buyers5m?: number | null
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const ratio = (a: number | null, b: number | null) => (fin(a) && fin(b) && b > 0 ? a / b : null)

/** Where the price is in its 6 h range, how much it moved in the last hour, and volume / buyer trends. */
export function measuresOf(samples: Sample[], now: number) {
  const all = samples.filter((s) => fin(s.t) && s.t <= now).sort((a, b) => a.t - b.t)
  const o = { aboveLow6h: null as number | null, belowHigh6h: null as number | null, range1h: null as number | null, volAccel: null as number | null, buyerTrend: null as number | null }
  const priced = all.filter((s) => fin(s.price) && s.price! > 0)
  if (priced.length < 2) return o
  const last = priced[priced.length - 1]
  const p0 = last.price!
  const w6 = priced.filter((s) => s.t > now - 6 * HOUR)
  if (w6.length >= 10 && last.t - w6[0].t >= HOUR) {
    const ps = w6.map((s) => s.price!)
    o.aboveLow6h = (p0 / Math.min(...ps) - 1) * 100
    o.belowHigh6h = (p0 / Math.max(...ps) - 1) * 100
  }
  const w1 = priced.filter((s) => s.t > now - HOUR)
  if (w1.length >= 10 && last.t - w1[0].t >= 30 * MIN) {
    const ps = w1.map((s) => s.price!)
    o.range1h = ((Math.max(...ps) - Math.min(...ps)) / Math.min(...ps)) * 100
  }
  const within = (ms: number) => all.filter((s) => s.t > now - ms)
  const vol = (list: Sample[]) => mean(list.map((s) => s.volume5m).filter(fin))
  const byr = (list: Sample[]) => mean(list.map((s) => s.buyers5m).filter(fin))
  const v1 = within(HOUR).filter((s) => fin(s.volume5m))
  if (v1.length >= 10 && last.t - v1[0].t >= 30 * MIN) o.volAccel = ratio(vol(within(15 * MIN)), vol(within(HOUR)))
  const b6 = within(6 * HOUR).filter((s) => fin(s.buyers5m))
  if (b6.length >= 20 && last.t - b6[0].t >= 2 * HOUR) o.buyerTrend = ratio(byr(within(HOUR)), byr(within(6 * HOUR)))
  return o
}

export type Phase = 'QUIET' | 'WAKING' | 'RUNNING' | 'PEAKING' | 'FADING'

/** The attention cycle: QUIET → WAKING → RUNNING → PEAKING → FADING (Vibe-MM's PHASE). */
export function phaseOf(m: ReturnType<typeof measuresOf>, smartSellers = 0): { phase: Phase | null; why: string } {
  const r = RULES.phase
  const up = m.aboveLow6h
  const off = m.belowHigh6h
  if (!fin(up) || !fin(off)) return { phase: null, why: 'needs an hour of price history' }
  if (up >= r.runPct)
    return off <= -r.fadeOffHighPct
      ? { phase: 'FADING', why: `up ${up.toFixed(0)}% on its 6h low but already ${Math.abs(off).toFixed(0)}% off the high` }
      : { phase: 'PEAKING', why: `up ${up.toFixed(0)}% on its 6h low and ${Math.abs(off).toFixed(1)}% from the high` }
  if (up >= r.runningPct && smartSellers >= r.smartExitSellers) return { phase: 'PEAKING', why: `${smartSellers} smart wallets selling after a ${up.toFixed(0)}% move` }
  if (up >= r.runningPct) return { phase: 'RUNNING', why: `up ${up.toFixed(0)}% on its 6h low — the move is under way` }
  if (fin(m.range1h) && m.range1h < r.quietRangePct) return { phase: 'QUIET', why: `last hour moved ${m.range1h.toFixed(2)}% — nothing is trading` }
  return { phase: 'WAKING', why: `moving, but only ${up.toFixed(1)}% off its 6h low` }
}

/** A round trip's cost (%) at `tradeUsd`: from a real $10K quote when there is one, else from pool depth; plus fees. */
export function roundTripCostPct(liquidity: number | null, impact10kPct: number | null, tradeUsd = RULES.execution.tradeUsd) {
  const e = RULES.execution
  let oneWay: number | null = null
  if (fin(impact10kPct) && impact10kPct >= 0) oneWay = impact10kPct * (tradeUsd / e.quoteUsd)
  else if (fin(liquidity) && liquidity > 0) oneWay = (100 * (liquidity < e.deepFromUsd ? e.thinCalibration : 1) * tradeUsd) / (liquidity / 2)
  return oneWay === null ? null : 2 * oneWay + e.feeRoundTripPct
}

// ---------- scores, gates and calls ----------

export interface Inputs {
  token: string
  price: number | null
  liquidity: number | null
  poolAgeHours: number | null
  holders: number | null
  organicScore: number | null
  /** honeypot.is (1 = honeypot) on EVM; on Solana: freeze authority still enabled (1) and a sell route (1 / 0). */
  honeypot: number | null
  freezable: number | null
  sellRoute: number | null
  buyTax: number | null
  sellTax: number | null
  impact10k: number | null
  /** The learned smart wallets on this chain (lowercase), or null before any are known. */
  smart: Set<string> | null
}

export interface Scored {
  score: number | null
  why: string
}

export interface Call {
  call: 'BUY' | 'WATCH' | 'SELL' | 'AVOID' | null
  why: string
  held?: boolean
}

/** Smart wallets buying / selling in this pool over the last hour (Vibe-MM's smartFlowOf). */
export function smartFlowOf(own: TapeTrade[], smart: Set<string> | null, now: number) {
  if (!smart || !own.length) return { buyers: null as number | null, sellers: null as number | null }
  const oldest = Math.min(...own.map((t) => t.at))
  if (!(oldest <= now - 15 * MIN)) return { buyers: null, sellers: null }
  const b = new Set<string>()
  const s = new Set<string>()
  for (const x of own) {
    if (x.at <= now - HOUR || x.at > now || !smart.has(x.wallet)) continue
    if (x.kind === 'buy') b.add(x.wallet)
    else s.add(x.wallet)
  }
  return { buyers: b.size, sellers: s.size }
}

/** Last call per engine per token, for the hold rule (forgotten after a while without a fresh one). */
const lastCall = new Map<string, { s: Call['call']; t: number; since: number }>()

export function evaluate(own: TapeTrade[], index: Map<string, TapeTrade[]>, pool: string, samples: Sample[], inputs: Inputs, now = Date.now()) {
  const rot = rotationOf(own, index, pool, now)
  const market = marketFlowOf(own, index, pool, now)
  const flow = flowOf(own, now)
  const measures = measuresOf(samples, now)
  const smart = smartFlowOf(own, inputs.smart, now)
  const phase = phaseOf(measures, smart.sellers ?? 0)
  const cost = roundTripCostPct(inputs.liquidity, inputs.impact10k)
  const L = RULES.lines
  const over = (s: Scored, e: Engine) => fin(s.score) && s.score >= L[e].buy

  // --- safety gates: a gate fails only on evidence; missing data is "not checked" ---
  const sellable =
    inputs.honeypot === 1
      ? { ok: false, detail: 'honeypot.is: the sell simulation failed' }
      : inputs.honeypot === 0
        ? { ok: true, detail: 'honeypot.is: a sell goes through' }
        : inputs.freezable === 1
          ? { ok: false, detail: 'freeze authority still enabled: holders can be frozen' }
          : inputs.sellRoute === 0
            ? { ok: false, detail: 'Jupiter found no route to sell it' }
            : inputs.sellRoute === 1
              ? { ok: true, detail: `Jupiter routes a sell${inputs.freezable === 0 ? ', freeze authority disabled' : ''}` }
              : { ok: null, detail: 'not checked yet' }
  const gates = [
    { key: 'sellable', label: 'Sellable', ...sellable },
    {
      key: 'tax',
      label: 'Tax in range',
      ok: fin(inputs.buyTax) || fin(inputs.sellTax) ? Math.max(inputs.buyTax ?? 0, inputs.sellTax ?? 0) <= RULES.safety.maxTaxPct : null,
      detail: fin(inputs.buyTax) || fin(inputs.sellTax) ? `buy ${(inputs.buyTax ?? 0).toFixed(1)}%, sell ${(inputs.sellTax ?? 0).toFixed(1)}% (cap ${RULES.safety.maxTaxPct}%)` : 'not checked (GoPlus hasn’t reached it)',
    },
    { key: 'liquidity', label: 'Liquidity floor', ok: fin(inputs.liquidity) ? inputs.liquidity >= RULES.safety.minLiquidity : null, detail: fin(inputs.liquidity) ? `${usd(inputs.liquidity)} vs ${usd(RULES.safety.minLiquidity)}` : 'no liquidity yet' },
  ]
  const vetoed = gates.some((g) => g.ok === false)

  // --- the base engines ---
  const cycle: Scored = (() => {
    const c = EARLY.curves
    const parts: Record<string, number | null> = {
      room: fin(measures.aboveLow6h) ? band(Math.max(0, measures.aboveLow6h) / 100, c.room) : null,
      holding: fin(measures.belowHigh6h) ? band(Math.abs(Math.min(0, measures.belowHigh6h)) / 100, c.holding) : null,
      waking: fin(measures.range1h) ? band(measures.range1h / 100, c.waking) : null,
      seasoning: fin(inputs.poolAgeHours) && inputs.poolAgeHours > 0 ? logScore(Math.max(inputs.poolAgeHours, 1), c.ageLoHours, c.ageHiHours) : null,
      holders: logScore(inputs.holders, c.holdersLo, c.holdersHi),
      interest: (() => {
        const a = multipleScore(measures.volAccel)
        const t = multipleScore(measures.buyerTrend)
        return a !== null && t !== null ? Math.round((a + t) / 2) : (a ?? t)
      })(),
      repeat: flow && fin(flow.buysPerBuyer) ? to100((flow.buysPerBuyer - c.repeatLo) / (c.repeatHi - c.repeatLo)) : null,
    }
    let weighted = 0
    let used = 0
    let present = 0
    for (const m of EARLY.model) {
      const v = parts[m.key]
      if (fin(v)) ((weighted += v * m.weight), (used += m.weight), present++)
    }
    if (present < EARLY.minParts || !used) return { score: null, why: `EARLY needs ${EARLY.minParts} of 7 inputs, has ${present}` }
    const raw = Math.round(weighted / used)
    const strongest = EARLY.model.filter((m) => fin(parts[m.key])).sort((a, b) => (parts[b.key]! - 50) * b.weight - (parts[a.key]! - 50) * a.weight)[0]
    return vetoed ? { score: 0, why: 'a safety gate failed' } : { score: raw, why: `EARLY ${raw} from ${present} of 7 inputs — ${strongest.label.toLowerCase()} ${parts[strongest.key]}` }
  })()
  const rotation: Scored = !rot
    ? { score: null, why: 'under 15 min of tape for this pool' }
    : (() => {
        let s = band(rot.inWallets - rot.outWallets, [[0, 0], [4, 100]])!
        const net = rot.inUsd - rot.outUsd
        if (net < 0) s *= 0.5
        return { score: clamp100(s), why: `${rot.inWallets} wallet${rot.inWallets === 1 ? '' : 's'} rotated in, ${rot.outWallets} out, net ${net >= 0 ? '+' : '−'}${usd(Math.abs(net))}${net < 0 ? ' (halved: capital net leaving)' : ''}` }
      })()
  const momentum: Scored = !fin(measures.volAccel)
    ? { score: null, why: 'needs 30 min of 5-minute volume history' }
    : (() => {
        const v = band(measures.volAccel, [[1, 0], [2.5, 100]])!
        const b = band(measures.buyerTrend, [[1, 0], [2, 100]])
        return { score: clamp100(b === null ? v : 0.6 * v + 0.4 * b), why: `volume ${measures.volAccel!.toFixed(2)}× the hour${fin(measures.buyerTrend) ? `, buyers ${measures.buyerTrend.toFixed(2)}× the 6h` : ''}` }
      })()
  const smartScore: Scored = !fin(smart.buyers)
    ? { score: null, why: inputs.smart ? 'under 15 min of tape for this pool' : 'no smart wallets learned on this chain yet' }
    : { score: clamp100(30 * smart.buyers - 30 * (smart.sellers ?? 0)), why: `${smart.buyers} smart wallet${smart.buyers === 1 ? '' : 's'} buying, ${smart.sellers ?? 0} selling` }
  const orderFlow: Scored = !flow || !fin(flow.netRatio)
    ? { score: null, why: 'under 5 trades in the last hour of tape' }
    : (() => {
        let s = band(flow.netRatio, [[0, 0], [0.5, 100]])!
        const why = [`net flow ${flow.netRatio!.toFixed(2)}`]
        if (fin(flow.buysPerBuyer) && flow.buysPerBuyer > 4) ((s *= 0.5), why.push(`${flow.buysPerBuyer.toFixed(1)} buys per buyer (wash) ×0.5`))
        if (fin(inputs.organicScore) && inputs.organicScore < 40) ((s *= 0.5), why.push(`organic ${inputs.organicScore} ×0.5`))
        return { score: clamp100(s), why: why.join(', ') }
      })()
  const base: Record<string, Scored> = { cycle, momentum, smart: smartScore, flow: orderFlow, rotation }
  const label = (e: Engine) => ENGINES.find((x) => x.key === e)!.label

  // --- the combined engines ---
  const present = BASE.filter((e) => fin(base[e].score))
  const votes = present.filter((e) => over(base[e], e))
  const blend: Scored = present.length < 2 ? { score: null, why: 'needs two base engines with a score' } : { score: clamp100(50 * votes.length), why: votes.length ? `${votes.map(label).join(' + ')} vote BUY` : 'no engine votes BUY' }
  const others = BASE.filter((e) => e !== 'rotation' && over(base[e], e))
  const rotationPlus: Scored = !fin(rotation.score)
    ? { score: null, why: rotation.why }
    : others.length
      ? { score: rotation.score, why: `rotation ${rotation.score}, confirmed by ${others.map(label).join(' + ')}` }
      : { score: clamp100(rotation.score / 2), why: `rotation ${rotation.score}, no other engine agrees (halved)` }
  const three: Engine[] = ['rotation', 'smart', 'momentum']
  const yes3 = three.filter((e) => over(base[e], e))
  const consensus: Scored = !three.some((e) => fin(base[e].score)) ? { score: null, why: 'none of ROTATION, SMART MONEY, MOMENTUM has a score' } : { score: clamp100(50 * yes3.length), why: yes3.length ? `${yes3.map(label).join(' + ')} over their lines` : 'none of the three over its line' }
  const inBand = fin(inputs.liquidity) && inputs.liquidity >= RULES.liqLow && inputs.liquidity <= RULES.liqHigh
  const bandWhy = `liquidity ${fin(inputs.liquidity) ? usd(inputs.liquidity) : '?'} outside the ${usd(RULES.liqLow)}–${usd(RULES.liqHigh)} band`
  const rotationMidLiq: Scored = !fin(rotation.score) ? { score: null, why: rotation.why } : inBand ? { score: rotation.score, why: `rotation ${rotation.score} on ${usd(inputs.liquidity!)} liquidity` } : { score: 0, why: bandWhy }
  const smartRotation: Scored =
    !fin(rotation.score) || !fin(smart.buyers)
      ? { score: null, why: !fin(rotation.score) ? rotation.why : smartScore.why }
      : smart.buyers >= 1
        ? { score: rotation.score, why: `rotation ${rotation.score} with ${smart.buyers} smart buyer${smart.buyers > 1 ? 's' : ''}` }
        : { score: 0, why: 'no smart wallet among the buyers' }
  const quality: Scored = !fin(rotationPlus.score) ? { score: null, why: rotationPlus.why } : inBand ? { score: rotationPlus.score, why: `${rotationPlus.why}, on ${usd(inputs.liquidity!)}` } : { score: 0, why: bandWhy }
  const tideConf = (['smart', 'momentum'] as Engine[]).filter((e) => over(base[e], e))
  const tide: Scored = !fin(rotation.score)
    ? { score: null, why: rotation.why }
    : market && market.net < -RULES.rotVetoUsd
      ? { score: 0, why: `${usd(-market.net)} net leaving the pool — against the tide` }
      : tideConf.length
        ? { score: rotation.score, why: `rotation ${rotation.score} with ${tideConf.map(label).join(' + ')}${market ? `, market flow ${market.net >= 0 ? '+' : '−'}${usd(Math.abs(market.net))}` : ''}` }
        : { score: clamp100(rotation.score / 2), why: `rotation ${rotation.score}, neither smart wallets nor volume agree (halved)` }
  const scores: Record<Engine, Scored> = { cycle, momentum, smart: smartScore, flow: orderFlow, rotation, blend, rotationPlus, consensus, rotationMidLiq, smartRotation, quality, tide }

  // --- a call per engine ---
  const up = measures.aboveLow6h
  const inZone = (e: Engine) => phase.phase === 'WAKING' || (e !== 'cycle' && phase.phase === 'RUNNING' && fin(up) && up < RULES.lateUpPct)
  const block = (e: Engine) =>
    fin(cost) && cost > RULES.execution.maxCostPct
      ? `too thin for ${usd(RULES.execution.tradeUsd)}: a round trip costs ${cost.toFixed(1)}% (cap ${RULES.execution.maxCostPct}%)`
      : e === 'tide' && market && market.net < -RULES.rotVetoUsd
        ? `${usd(-market.net)} net leaving the pool for other pools (2h)`
        : null
  const calls = {} as Record<Engine, Call>
  for (const { key: e, label: name } of ENGINES) {
    const s = scores[e].score
    const line = L[e]
    let c: Call
    if (!phase.phase) c = { call: null, why: 'no phase yet — ' + phase.why }
    else if (phase.phase === 'PEAKING') c = { call: 'SELL', why: 'peaking — take profit, don’t chase' }
    else if (phase.phase === 'FADING') c = { call: 'AVOID', why: 'the burst is over' }
    else if (inZone(e)) {
      const where = phase.phase.toLowerCase()
      if (vetoed) c = { call: 'WATCH', why: `${where}, but a safety gate failed` }
      else if (!fin(s)) c = { call: 'WATCH', why: `${where}, no ${name} score yet` }
      else if (s < line.buy) c = { call: 'WATCH', why: `${where}, ${name} ${s} under ${line.buy}` }
      else if (block(e)) c = { call: 'WATCH', why: `${where}, ${name} ${s} — but ${block(e)}` }
      else c = { call: 'BUY', why: `${where}, ${name} ${s}${fin(smart.buyers) && smart.buyers > 0 ? `, ${smart.buyers} smart wallet${smart.buyers > 1 ? 's' : ''} buying` : ''}` }
    } else c = { call: 'WATCH', why: phase.phase === 'RUNNING' ? 'running — late to buy, early to sell' : 'quiet' }

    // The hold rule: keep the previous call through a dip under its line.
    const k = `${e}|${inputs.token}`
    const prev = lastCall.get(k)
    const fresh = prev && now >= prev.t && now - prev.t <= RULES.hold.memoryMin * MIN
    if (fresh && c.call === 'WATCH') {
      if (prev.s === 'BUY' && block(e)) {
        /* a gate that closes ends the BUY */
      } else if (prev.s === 'BUY' && inZone(e) && !vetoed && fin(s) && s >= line.hold) c = { call: 'BUY', why: `holding BUY — still ${phase.phase!.toLowerCase()}, ${name} ${s} (holds while ≥ ${line.hold})`, held: true }
      else if (prev.s === 'BUY' && phase.phase === 'QUIET' && !vetoed && now - prev.since <= RULES.hold.buyQuietHoldMin * MIN) c = { call: 'BUY', why: `holding BUY — the tape paused, nothing broke (up to ${RULES.hold.buyQuietHoldMin} min)`, held: true }
      else if (prev.s === 'SELL' && phase.phase === 'RUNNING') c = { call: 'SELL', why: 'holding SELL — pulled back under the run line but not back to waking', held: true }
    }
    if (c.call) lastCall.set(k, { s: c.call, t: now, since: c.held && prev?.s === c.call ? prev.since : now })
    calls[e] = c
  }

  // --- the trade plan, for a BUY on the chosen engine ---
  const engine = RULES.engine in calls ? RULES.engine : DEFAULT_ENGINE
  const frame = frameOf(RULES.plan.holdHours)
  const plan =
    calls[engine].call === 'BUY' && fin(inputs.price)
      ? {
          entry: inputs.price,
          target: inputs.price * (1 + frame.targetPct / 100),
          stop: inputs.price * (1 - frame.stopPct / 100),
          targetPct: frame.targetPct,
          stopPct: frame.stopPct,
          holdHours: frame.hours,
          sizeUsd: RULES.execution.tradeUsd,
          costPct: cost,
        }
      : null

  return {
    at: now,
    pool,
    rotation: rot,
    market: market ? { inUsd: market.inUsd, outUsd: market.outUsd, net: market.net, connected: market.connected } : null,
    peers: market?.peers.slice(0, 12) ?? [],
    flow,
    smart,
    measures,
    phase,
    costPct: cost,
    gates,
    scores,
    calls,
    engine,
    plan,
  }
}

export type Evaluation = ReturnType<typeof evaluate>
