/**
 * How a token's safety is judged: which services are asked, how each one works, and every check it makes.
 * Shared by the engine (server/engine.ts runs the checks with these labels and levels) and the Safety
 * block's right panel (which lists them, with each check's result for the token wired in).
 *
 * Levels: `bad` = a red flag (the verdict is Danger), `warn` = worth knowing (the verdict is Caution).
 */
export type CheckLevel = 'bad' | 'warn'

export interface SafetyCheck {
  /** The field the service answers with. */
  key: string
  label: string
  level: CheckLevel
  /** What it means for a holder, in plain words. */
  means: string
}

export interface SafetySource {
  id: string
  name: string
  url: string
  /** Which tokens it covers. */
  covers: string
  /** How it finds out. */
  method: string
  checks: SafetyCheck[]
  /** Numbers it adds to the report (not flags). */
  facts: string[]
  /** Its checks aren't a fixed list (RugCheck reports the risks it finds). */
  open?: boolean
  /** Which chains ask it. */
  appliesTo: (chain: string, evmId?: number) => boolean
}

export const SAFETY_SOURCES: SafetySource[] = [
  {
    id: 'goplus-solana',
    name: 'GoPlus',
    url: 'https://gopluslabs.io',
    covers: 'Solana tokens',
    method: 'Reads the token’s on-chain authorities: who can still mint, freeze, move balances or edit it.',
    appliesTo: (chain) => chain === 'solana',
    checks: [
      { key: 'mintable', label: 'Mintable', level: 'bad', means: 'Someone can still create new tokens and dilute holders.' },
      { key: 'freezable', label: 'Freezable', level: 'bad', means: 'Someone can freeze holders’ accounts so they can’t sell.' },
      { key: 'balance_mutable_authority', label: 'Balances can be changed', level: 'bad', means: 'An authority can change what holders own.' },
      { key: 'metadata_mutable', label: 'Metadata can be changed', level: 'warn', means: 'The name, symbol or logo can be changed later.' },
    ],
    facts: ['Holders'],
  },
  {
    id: 'rugcheck',
    name: 'RugCheck',
    url: 'https://rugcheck.xyz',
    covers: 'Solana tokens',
    method: 'Scores rug risk from holder concentration, liquidity and its lock, authorities and the creator’s history. It lists only the risks it finds.',
    appliesTo: (chain) => chain === 'solana',
    open: true,
    checks: [
      { key: 'danger', label: 'A risk RugCheck rates “danger”', level: 'bad', means: 'E.g. a few wallets hold most of the supply, liquidity isn’t locked, or authorities are still enabled.' },
      { key: 'warn', label: 'A risk RugCheck rates “warn”', level: 'warn', means: 'E.g. low liquidity, a mutable token, or few holders.' },
    ],
    facts: ['Liquidity locked', 'RugCheck score'],
  },
  {
    id: 'goplus-evm',
    name: 'GoPlus',
    url: 'https://gopluslabs.io',
    covers: 'EVM tokens (Ethereum, BNB, Base, Arbitrum, Polygon, Avalanche, Optimism)',
    method: 'Analyses the contract’s code and simulates trades to find traps: honeypots, taxes, owner powers.',
    appliesTo: (_chain, evmId) => evmId != null,
    checks: [
      { key: 'is_honeypot', label: 'Honeypot', level: 'bad', means: 'You can buy but not sell.' },
      { key: 'cannot_sell_all', label: 'Can’t sell all', level: 'bad', means: 'Holders can’t sell their whole balance.' },
      { key: 'is_mintable', label: 'Mintable', level: 'bad', means: 'The owner can create new tokens and dilute holders.' },
      { key: 'owner_change_balance', label: 'Owner can change balances', level: 'bad', means: 'The owner can change what holders own.' },
      { key: 'hidden_owner', label: 'Hidden owner', level: 'bad', means: 'Ownership looks renounced but someone still controls it.' },
      { key: 'can_take_back_ownership', label: 'Ownership can be taken back', level: 'bad', means: 'Renounced ownership can be reclaimed.' },
      { key: 'transfer_pausable', label: 'Transfers can be paused', level: 'warn', means: 'The owner can stop all trading.' },
      { key: 'is_blacklisted', label: 'Has a blacklist', level: 'warn', means: 'The owner can block wallets from selling.' },
      { key: 'slippage_modifiable', label: 'Tax can be changed', level: 'warn', means: 'Buy and sell taxes can be raised later.' },
      { key: 'is_proxy', label: 'Proxy contract', level: 'warn', means: 'The code can be swapped for new code.' },
      { key: 'is_open_source', label: 'Not open source', level: 'warn', means: 'The contract code isn’t published, so it can’t be checked.' },
    ],
    facts: ['Buy tax', 'Sell tax', 'Holders'],
  },
  {
    id: 'honeypot-is',
    name: 'honeypot.is',
    url: 'https://honeypot.is',
    covers: 'Ethereum, BNB Chain and Base tokens',
    method: 'Simulates a real buy and sell on a copy of the chain and measures what comes back.',
    appliesTo: (_chain, evmId) => evmId === 1 || evmId === 56 || evmId === 8453,
    checks: [{ key: 'isHoneypot', label: 'Honeypot', level: 'bad', means: 'The simulated sell failed: you could buy but not sell.' }],
    facts: ['Simulated risk'],
  },
]

export const VERDICT_RULE = 'Danger if any red flag, Caution if any warning, otherwise No risks found. The same risk reported by two services counts once, at the worse level.'

/** One check's outcome for a token, as the engine reports it. */
export interface CheckResult {
  source: string
  key: string
  label: string
  level: CheckLevel
  /** true = flagged, false = passed. */
  hit: boolean
  detail?: string
}

/** How each service answered for a token. */
export interface SourceResult {
  id: string
  ok: boolean
  error?: string
}
