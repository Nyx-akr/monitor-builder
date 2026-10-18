import type { Unit } from './metrics'

/**
 * The Token details block's fields and where each can come from (first = default). Shared by the engine
 * (which fetches every source it can for a token) and the block's right panel (show / hide, pick a source).
 *
 * Checked responses (Oct 2026), all free and keyless:
 * - GeckoTerminal pool: transactions.{m5,h24}.{buys,sells,buyers,sellers}, market_cap_usd, pool_created_at
 * - GeckoTerminal /pools/{pool}/trades: last 300 trades — kind, tx_from_address, volume_in_usd, block_timestamp
 * - GoPlus (EVM and Solana): holders[0..9].percent (0–1) → top-10 share
 * - Jupiter lite-api tokens/v2/search: mcap, liquidity, holderCount, organicScore, circSupply, launchpad,
 *   audit.{topHoldersPercentage, devMints, devMigrations}, stats{5m,1h,24h}.{holderChange, buyOrganicVolume…}
 * - Jupiter lite-api swap/v1/quote (USDC → token, $10K): priceImpactPct (Solana)
 * - KyberSwap aggregator /{chain}/api/v1/routes: routeSummary.amountInUsd / amountOutUsd (EVM)
 * - DefiLlama coins.llama.fi/prices/current/{chain}:{address}: price
 */
export type DetailSource = 'dexscreener' | 'geckoterminal' | 'trades' | 'goplus' | 'honeypot' | 'jupiter' | 'kyberswap' | 'defillama'

export const SOURCE_NAMES: Record<DetailSource, string> = {
  dexscreener: 'DexScreener',
  geckoterminal: 'GeckoTerminal',
  trades: 'Trade sample (GeckoTerminal, our analysis)',
  goplus: 'GoPlus',
  honeypot: 'honeypot.is',
  jupiter: 'Jupiter',
  kyberswap: 'KyberSwap routed quote',
  defillama: 'DefiLlama',
}

export interface DetailField {
  key: string
  label: string
  group: 'Market' | 'Flow' | 'Execution' | 'Holders' | 'Token' | 'Risk'
  /** 'text' values are words (a launchpad's name, "passes"). */
  unit: Unit | 'text'
  sources: DetailSource[]
  /** When it's only available somewhere (shown instead of a value). */
  only?: string
}

export const DETAIL_FIELDS: DetailField[] = [
  { key: 'price', label: 'Price', group: 'Market', unit: 'usd', sources: ['dexscreener', 'geckoterminal', 'jupiter', 'defillama'] },
  { key: 'marketCap', label: 'Mkt cap', group: 'Market', unit: 'usd', sources: ['dexscreener', 'geckoterminal', 'jupiter'] },
  { key: 'liquidity', label: 'Liquidity', group: 'Market', unit: 'usd', sources: ['dexscreener', 'geckoterminal', 'jupiter'] },
  { key: 'volume5m', label: 'Vol 5m', group: 'Market', unit: 'usd', sources: ['dexscreener', 'geckoterminal'] },
  { key: 'volume24h', label: 'Vol 24h', group: 'Market', unit: 'usd', sources: ['dexscreener', 'geckoterminal', 'jupiter'] },
  { key: 'buyers5m', label: 'Buyers 5m', group: 'Flow', unit: 'count', sources: ['geckoterminal'] },
  { key: 'buyers24h', label: 'Buyers 24h', group: 'Flow', unit: 'count', sources: ['geckoterminal'] },
  { key: 'bsRatio24h', label: 'B/S ratio 24h', group: 'Flow', unit: 'ratio', sources: ['geckoterminal', 'dexscreener', 'jupiter'] },
  { key: 'volLiq24h', label: 'Vol/Liq 24h', group: 'Flow', unit: 'ratio', sources: ['dexscreener', 'geckoterminal'] },
  { key: 'netBuy5m', label: 'Net buy 5m', group: 'Flow', unit: 'usd', sources: ['trades'] },
  { key: 'organicScore', label: 'Organic score', group: 'Flow', unit: 'none', sources: ['trades', 'jupiter'] },
  { key: 'washProb', label: 'Wash prob', group: 'Flow', unit: 'pct', sources: ['trades'] },
  { key: 'organicVol24h', label: 'Organic vol 24h', group: 'Flow', unit: 'usd', sources: ['jupiter'], only: 'Jupiter: Solana only' },
  { key: 'impact10k', label: 'Impact $10K', group: 'Execution', unit: 'pct', sources: ['kyberswap', 'jupiter'] },
  { key: 'priceVsLlama', label: 'Price vs Llama', group: 'Execution', unit: 'pct', sources: ['defillama'] },
  { key: 'holders', label: 'Holders', group: 'Holders', unit: 'count', sources: ['goplus', 'jupiter'] },
  { key: 'top10', label: 'Top-10 share', group: 'Holders', unit: 'pct', sources: ['goplus', 'jupiter'] },
  { key: 'holdersDelta1h', label: 'Holders Δ 1h', group: 'Holders', unit: 'pct', sources: ['jupiter'], only: 'Jupiter: Solana only' },
  { key: 'poolAge', label: 'Pool age', group: 'Token', unit: 'hours', sources: ['geckoterminal', 'dexscreener'] },
  { key: 'circSupply', label: 'Circ supply', group: 'Token', unit: 'count', sources: ['jupiter'], only: 'Jupiter: Solana only' },
  { key: 'launchpad', label: 'Launchpad', group: 'Token', unit: 'text', sources: ['jupiter'], only: 'Jupiter: Solana only' },
  { key: 'devMigrations', label: 'Dev migrations', group: 'Token', unit: 'count', sources: ['jupiter'], only: 'Jupiter: Solana only' },
  { key: 'sellSim', label: 'Sell simulation', group: 'Risk', unit: 'text', sources: ['honeypot'], only: 'honeypot.is: Ethereum, BNB, Base' },
]

/** What the engine answers: every value it found, by field and source. */
export interface DetailsAnswer {
  id: string
  at: number
  values: Record<string, Partial<Record<DetailSource, number | string | null>>>
  /** Sources that failed, and why. */
  errors: Partial<Record<DetailSource, string>>
}
