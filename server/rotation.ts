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

/** Vibe-MM's lines and rules (tuned there by walk-forward backtests, 2026-10-14). */
export const RULES = {
  rotationWindowMs: 2 * HOUR,
  marketWindowMs: 2 * HOUR,
  lines: {
    rotation: { buy: 80, hold: 60 },
    momentum: { buy: 60, hold: 45 },
    flow: { buy: 60, hold: 40 },
    rotationPlus: { buy: 80, hold: 60 },
    quality: { buy: 80, hold: 60 },
    tide: { buy: 80, hold: 60 },
  },
  /** TIDE doesn't buy while more than this ($ net, 2 h) leaves the pool for other pools. */
  rotVetoUsd: 200,
  /** The liquidity band QUALITY ROTATION buys in. */
  liqLow: 200_000,
  liqHigh: 1_000_000,
  /** An early RUNNING token may still be bought while under this % above its 6 h low. */
  lateUpPct: 12,
  phase: { runPct: 30, fadeOffHighPct: 10, runningPct: 5, quietRangePct: 1, smartExitSellers: 2 },
  hold: { memoryMin: 20, buyQuietHoldMin: 60 },
  safety: { minLiquidity: 20_000, maxTaxPct: 10 },
  execution: { tradeUsd: 1000, maxCostPct: 2, feeRoundTripPct: 0.6, thinCalibration: 0.55, deepFromUsd: 2e6, quoteUsd: 10_000 },
}

export type Engine = 'rotation' | 'momentum' | 'flow' | 'rotationPlus' | 'quality' | 'tide'
export const ENGINES: { key: Engine; label: string; blurb: string }[] = [
  { key: 'quality', label: 'QUALITY ROTATION', blurb: 'Rotation, confirmed by another engine, on a $200K–$1M pool (Vibe-MM’s default).' },
  { key: 'rotation', label: 'ROTATION', blurb: 'Wallets selling other tokens to buy this one.' },
  { key: 'rotationPlus', label: 'ROTATION+', blurb: 'Rotation over its line, with another engine over its own.' },
  { key: 'tide', label: 'TIDE', blurb: 'Rotation with momentum agreeing, and capital not leaving the pool.' },
  { key: 'momentum', label: 'MOMENTUM', blurb: 'The last 15 min trading well above the hour, buyers growing.' },
  { key: 'flow', label: 'ORDER FLOW', blurb: 'Net buying in the tape, discounted for wash and inorganic flow.' },
]
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
  liquidity: number | null
  organicScore: number | null
  honeypot: number | null
  buyTax: number | null
  sellTax: number | null
  impact10k: number | null
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

/** Last call per engine per token, for the hold rule (forgotten after a while without a fresh one). */
const lastCall = new Map<string, { s: Call['call']; t: number; since: number }>()

export function evaluate(own: TapeTrade[], index: Map<string, TapeTrade[]>, pool: string, samples: Sample[], inputs: Inputs, now = Date.now()) {
  const rot = rotationOf(own, index, pool, now)
  const market = marketFlowOf(own, index, pool, now)
  const flow = flowOf(own, now)
  const measures = measuresOf(samples, now)
  const phase = phaseOf(measures)
  const cost = roundTripCostPct(inputs.liquidity, inputs.impact10k)
  const L = RULES.lines

  // --- the base engines ---
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
  const orderFlow: Scored = !flow || !fin(flow.netRatio)
    ? { score: null, why: 'under 5 trades in the last hour of tape' }
    : (() => {
        let s = band(flow.netRatio, [[0, 0], [0.5, 100]])!
        const why = [`net flow ${flow.netRatio!.toFixed(2)}`]
        if (fin(flow.buysPerBuyer) && flow.buysPerBuyer > 4) ((s *= 0.5), why.push(`${flow.buysPerBuyer.toFixed(1)} buys per buyer (wash) ×0.5`))
        if (fin(inputs.organicScore) && inputs.organicScore < 40) ((s *= 0.5), why.push(`organic ${inputs.organicScore} ×0.5`))
        return { score: clamp100(s), why: why.join(', ') }
      })()
  const over = (s: Scored, line: number) => fin(s.score) && s.score >= line
  const confirmers = [over(momentum, L.momentum.buy) && 'MOMENTUM', over(orderFlow, L.flow.buy) && 'ORDER FLOW'].filter(Boolean) as string[]

  // --- the combined engines ---
  const rotationPlus: Scored = !fin(rotation.score)
    ? { score: null, why: rotation.why }
    : confirmers.length
      ? { score: rotation.score, why: `rotation ${rotation.score}, confirmed by ${confirmers.join(' + ')}` }
      : { score: clamp100(rotation.score / 2), why: `rotation ${rotation.score}, no other engine agrees (halved)` }
  const inBand = fin(inputs.liquidity) && inputs.liquidity >= RULES.liqLow && inputs.liquidity <= RULES.liqHigh
  const quality: Scored = !fin(rotationPlus.score)
    ? { score: null, why: rotationPlus.why }
    : inBand
      ? { score: rotationPlus.score, why: `${rotationPlus.why}, on ${usd(inputs.liquidity!)} liquidity` }
      : { score: 0, why: `liquidity ${fin(inputs.liquidity) ? usd(inputs.liquidity) : '?'} outside the $200K–$1M band` }
  const tide: Scored = !fin(rotation.score)
    ? { score: null, why: rotation.why }
    : market && market.net < -RULES.rotVetoUsd
      ? { score: 0, why: `${usd(-market.net)} net leaving the pool — against the tide` }
      : over(momentum, L.momentum.buy)
        ? { score: rotation.score, why: `rotation ${rotation.score} with MOMENTUM${market ? `, market flow ${market.net >= 0 ? '+' : '−'}${usd(Math.abs(market.net))}` : ''}` }
        : { score: clamp100(rotation.score / 2), why: `rotation ${rotation.score}, volume doesn't agree (halved)` }
  const scores: Record<Engine, Scored> = { rotation, momentum, flow: orderFlow, rotationPlus, quality, tide }

  // --- safety gates: a gate fails only on evidence; missing data is "not checked" ---
  const gates = [
    { key: 'sellable', label: 'Sellable', ok: inputs.honeypot === 1 ? false : inputs.honeypot === 0 ? true : null, detail: inputs.honeypot === 1 ? 'honeypot.is: the sell simulation failed' : inputs.honeypot === 0 ? 'honeypot.is: a sell goes through' : 'not checked (honeypot.is covers Ethereum, BNB, Base)' },
    {
      key: 'tax',
      label: 'Tax in range',
      ok: fin(inputs.buyTax) || fin(inputs.sellTax) ? Math.max(inputs.buyTax ?? 0, inputs.sellTax ?? 0) <= RULES.safety.maxTaxPct : null,
      detail: fin(inputs.buyTax) || fin(inputs.sellTax) ? `buy ${(inputs.buyTax ?? 0).toFixed(1)}%, sell ${(inputs.sellTax ?? 0).toFixed(1)}% (cap ${RULES.safety.maxTaxPct}%)` : 'not checked (GoPlus hasn’t reached it)',
    },
    { key: 'liquidity', label: 'Liquidity floor', ok: fin(inputs.liquidity) ? inputs.liquidity >= RULES.safety.minLiquidity : null, detail: fin(inputs.liquidity) ? `${usd(inputs.liquidity)} vs ${usd(RULES.safety.minLiquidity)}` : 'no liquidity yet' },
  ]
  const vetoed = gates.some((g) => g.ok === false)

  // --- a call per engine ---
  const up = measures.aboveLow6h
  const inZone = phase.phase === 'WAKING' || (phase.phase === 'RUNNING' && fin(up) && up < RULES.lateUpPct)
  const block = (e: Engine) =>
    fin(cost) && cost > RULES.execution.maxCostPct
      ? `too thin for ${usd(RULES.execution.tradeUsd)}: a round trip costs ${cost.toFixed(1)}% (cap ${RULES.execution.maxCostPct}%)`
      : e === 'tide' && market && market.net < -RULES.rotVetoUsd
        ? `${usd(-market.net)} net leaving the pool for other pools (2h)`
        : null
  const calls = {} as Record<Engine, Call>
  for (const { key: e, label } of ENGINES) {
    const s = scores[e].score
    const line = L[e]
    let c: Call
    if (!phase.phase) c = { call: null, why: 'no phase yet — ' + phase.why }
    else if (phase.phase === 'PEAKING') c = { call: 'SELL', why: 'peaking — take profit, don’t chase' }
    else if (phase.phase === 'FADING') c = { call: 'AVOID', why: 'the burst is over' }
    else if (inZone) {
      const where = phase.phase.toLowerCase()
      if (vetoed) c = { call: 'WATCH', why: `${where}, but a safety gate failed` }
      else if (!fin(s)) c = { call: 'WATCH', why: `${where}, no ${label} score yet` }
      else if (s < line.buy) c = { call: 'WATCH', why: `${where}, ${label} ${s} under ${line.buy}` }
      else if (block(e)) c = { call: 'WATCH', why: `${where}, ${label} ${s} — but ${block(e)}` }
      else c = { call: 'BUY', why: `${where}, ${label} ${s}` }
    } else c = { call: 'WATCH', why: phase.phase === 'RUNNING' ? 'running — late to buy, early to sell' : 'quiet' }

    // The hold rule: keep the previous call through a dip under its line.
    const k = `${e}|${inputs.token}`
    const prev = lastCall.get(k)
    const fresh = prev && now >= prev.t && now - prev.t <= RULES.hold.memoryMin * MIN
    if (fresh && c.call === 'WATCH') {
      if (prev.s === 'BUY' && block(e)) {
        /* a gate that closes ends the BUY */
      } else if (prev.s === 'BUY' && inZone && !vetoed && fin(s) && s >= line.hold) c = { call: 'BUY', why: `holding BUY — still ${phase.phase!.toLowerCase()}, ${label} ${s} (holds while ≥ ${line.hold})`, held: true }
      else if (prev.s === 'BUY' && phase.phase === 'QUIET' && !vetoed && now - prev.since <= RULES.hold.buyQuietHoldMin * MIN) c = { call: 'BUY', why: `holding BUY — the tape paused, nothing broke (up to ${RULES.hold.buyQuietHoldMin} min)`, held: true }
      else if (prev.s === 'SELL' && phase.phase === 'RUNNING') c = { call: 'SELL', why: 'holding SELL — pulled back under the run line but not back to waking', held: true }
    }
    if (c.call) lastCall.set(k, { s: c.call, t: now, since: c.held && prev?.s === c.call ? prev.since : now })
    calls[e] = c
  }

  return {
    at: now,
    pool,
    rotation: rot,
    market: market ? { inUsd: market.inUsd, outUsd: market.outUsd, net: market.net, connected: market.connected } : null,
    peers: market?.peers.slice(0, 12) ?? [],
    flow,
    measures,
    phase,
    costPct: cost,
    gates,
    scores,
    calls,
    engine: DEFAULT_ENGINE,
  }
}

export type Evaluation = ReturnType<typeof evaluate>
