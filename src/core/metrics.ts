/**
 * The standard metrics: one dictionary every data source maps into, so a trader picks "Liquidity",
 * never `liquidity.usd` or `reserve_in_usd`. Shared by the server's engine and the app.
 */
export type Unit = 'usd' | 'pct' | 'count' | 'hours' | 'ratio' | 'none'

export interface MetricDef {
  key: string
  label: string
  unit: Unit
  /** Shorter label for table headers. */
  short?: string
}

export const METRICS: MetricDef[] = [
  { key: 'price', label: 'Price', unit: 'usd' },
  { key: 'change5m', label: 'Change 5m', unit: 'pct', short: '5m' },
  { key: 'change1h', label: 'Change 1h', unit: 'pct', short: '1h' },
  { key: 'change6h', label: 'Change 6h', unit: 'pct', short: '6h' },
  { key: 'change24h', label: 'Change 24h', unit: 'pct', short: '24h' },
  { key: 'volume5m', label: 'Volume 5m', unit: 'usd', short: 'Vol 5m' },
  { key: 'volume1h', label: 'Volume 1h', unit: 'usd', short: 'Vol 1h' },
  { key: 'volume24h', label: 'Volume 24h', unit: 'usd', short: 'Vol 24h' },
  { key: 'liquidity', label: 'Liquidity', unit: 'usd', short: 'Liq' },
  { key: 'marketCap', label: 'Market cap', unit: 'usd', short: 'MCap' },
  { key: 'fdv', label: 'FDV', unit: 'usd' },
  { key: 'buys1h', label: 'Buys 1h', unit: 'count' },
  { key: 'sells1h', label: 'Sells 1h', unit: 'count' },
  { key: 'buys24h', label: 'Buys 24h', unit: 'count' },
  { key: 'sells24h', label: 'Sells 24h', unit: 'count' },
  { key: 'txns24h', label: 'Trades 24h', unit: 'count' },
  { key: 'buyers5m', label: 'Buyers 5m', unit: 'count' },
  { key: 'buyers24h', label: 'Buyers 24h', unit: 'count' },
  { key: 'ageHours', label: 'Age', unit: 'hours' },
  // Filled in for every stored token by the background enrichment (see server/collector.ts):
  { key: 'holders', label: 'Holders', unit: 'count' },
  { key: 'top10', label: 'Top-10 share', unit: 'pct', short: 'Top 10' },
  { key: 'holdersDelta1h', label: 'Holders Δ 1h', unit: 'pct', short: 'Hold Δ1h' },
  { key: 'organicScore', label: 'Organic score (Jupiter)', unit: 'none', short: 'Organic' },
  { key: 'organicVol24h', label: 'Organic volume 24h', unit: 'usd', short: 'Org vol' },
  { key: 'buyTax', label: 'Buy tax', unit: 'pct' },
  { key: 'sellTax', label: 'Sell tax', unit: 'pct' },
  { key: 'honeypot', label: 'Honeypot (1 = yes)', unit: 'none' },
  { key: 'priceVsLlama', label: 'Price vs DefiLlama', unit: 'pct', short: 'vs Llama' },
  // For tracked tokens (the Feed's watchlist, the one in Token details):
  { key: 'netBuy5m', label: 'Net buy 5m', unit: 'usd' },
  { key: 'organicTrades', label: 'Organic score (trade sample)', unit: 'none', short: 'Organic (trades)' },
  { key: 'washProb', label: 'Wash probability', unit: 'pct', short: 'Wash' },
  { key: 'impact10k', label: 'Impact $10K', unit: 'pct', short: 'Impact' },
  // From the trade tape (the rotation engine's input):
  { key: 'tapeTrades2h', label: 'Tape trades 2h', unit: 'count', short: 'Tape tr.' },
  { key: 'tapeWallets2h', label: 'Tape wallets 2h', unit: 'count', short: 'Tape w.' },
  // The rotation engine (server/rotation.ts):
  { key: 'rotIn1h', label: 'Wallets rotating in 1h', unit: 'count', short: 'Rot in' },
  { key: 'rotOut1h', label: 'Wallets rotating out 1h', unit: 'count', short: 'Rot out' },
  { key: 'rotNetUsd', label: 'Rotation net $ 1h', unit: 'usd', short: 'Rot net' },
  { key: 'flow2h', label: 'Market net flow 2h', unit: 'usd', short: 'Flow 2h' },
  { key: 'connectedPools', label: 'Connected pools 2h', unit: 'count', short: 'Conn.' },
  { key: 'qualityScore', label: 'Quality rotation score', unit: 'none', short: 'Quality' },
  { key: 'rotationScore', label: 'Rotation score', unit: 'none', short: 'Rotation' },
  { key: 'rotationPlusScore', label: 'Rotation+ score', unit: 'none', short: 'Rot+' },
  { key: 'tideScore', label: 'Tide score', unit: 'none', short: 'Tide' },
  { key: 'momentumScore', label: 'Momentum score', unit: 'none', short: 'Momentum' },
  { key: 'flowScore', label: 'Order flow score', unit: 'none', short: 'Flow sc.' },
  { key: 'executionCost', label: 'Round-trip cost $1K', unit: 'pct', short: 'Cost' },
  { key: 'aboveLow6h', label: 'Above 6h low', unit: 'pct', short: '↑6h low' },
]

/** Text values some rows carry (the rotation engine's phase and call). */
export const TAGS = [
  { key: 'phase', label: 'Phase' },
  { key: 'call', label: 'Call' },
]

/** Metrics that only change by the clock (not news): they don't make a new storage line. */
export const CLOCK_METRICS = ['ageHours']

export const metricByKey = (key: string) => METRICS.find((m) => m.key === key)

export const metricOptions = (keys = METRICS.map((m) => m.key)) =>
  keys.map((k) => ({ value: k, label: metricByKey(k)?.label ?? k }))
