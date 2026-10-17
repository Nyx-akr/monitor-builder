import { chainById } from '../../services/chains'
import { flag, getJson, makeApiCard, num, pct, taxLine, yesNo, type ApiCardProps, type Line, type Row } from '../shared/makeApiCard'

/**
 * GoPlus: a token contract's security check — honeypot, buy / sell tax, mintable, owner powers (change
 * balances, take back ownership, pause transfers, blacklist), open source, proxy, holders. EVM chains and
 * Solana (mint / freeze / close authorities, transfer fees). Free, no key: api.gopluslabs.io.
 */
type Props = ApiCardProps

const API = 'https://api.gopluslabs.io/api/v1'

type GoPlusRaw = Record<string, unknown>

/** The risky "yes" flags of an EVM token, by their readable name. */
const EVM_RISKS: [string, string][] = [
  ['is_honeypot', 'honeypot'],
  ['cannot_sell_all', "can't sell all"],
  ['cannot_buy', "can't buy"],
  ['is_mintable', 'mintable'],
  ['owner_change_balance', 'owner can change balances'],
  ['can_take_back_ownership', 'ownership can be taken back'],
  ['hidden_owner', 'hidden owner'],
  ['selfdestruct', 'can self-destruct'],
  ['transfer_pausable', 'transfers can be paused'],
  ['is_blacklisted', 'has a blacklist'],
  ['slippage_modifiable', 'tax can be changed'],
  ['trading_cooldown', 'trading cooldown'],
  ['is_proxy', 'proxy contract'],
  ['external_call', 'external calls'],
]

function evmRow(r: GoPlusRaw, chain: string, address: string): Row {
  const risks = EVM_RISKS.filter(([k]) => flag(r[k]) === true).map(([, name]) => name)
  if (flag(r.is_open_source) === false) risks.push('not open source')
  return {
    source: 'goplus',
    symbol: (r.token_symbol as string) ?? null,
    name: (r.token_name as string) ?? null,
    chain,
    address,
    isHoneypot: flag(r.is_honeypot),
    buyTax: num(r.buy_tax) === null ? null : num(r.buy_tax)! * 100,
    sellTax: num(r.sell_tax) === null ? null : num(r.sell_tax)! * 100,
    isOpenSource: flag(r.is_open_source),
    isMintable: flag(r.is_mintable),
    ownerCanChangeBalance: flag(r.owner_change_balance),
    hiddenOwner: flag(r.hidden_owner),
    transferPausable: flag(r.transfer_pausable),
    isBlacklisted: flag(r.is_blacklisted),
    isProxy: flag(r.is_proxy),
    holders: num(r.holder_count),
    lpHolders: num(r.lp_holder_count),
    creatorPercent: num(r.creator_percent) === null ? null : num(r.creator_percent)! * 100,
    ownerPercent: num(r.owner_percent) === null ? null : num(r.owner_percent)! * 100,
    riskCount: risks.length,
    risks: risks.join(', ') || 'none',
  }
}

function solanaRow(r: GoPlusRaw, address: string): Row {
  const status = (k: string) => flag((r[k] as { status?: string } | undefined)?.status)
  const meta = (r.metadata as { name?: string; symbol?: string } | undefined) ?? {}
  const checks: [string, boolean | null][] = [
    ['mintable', status('mintable')],
    ['freezable', status('freezable')],
    ['closable', status('closable')],
    ['balances can be changed', status('balance_mutable_authority')],
    ['metadata can be changed', status('metadata_mutable')],
    ['transfer fee can be changed', status('transfer_fee_upgradable')],
    ['non-transferable', flag(r.non_transferable)],
  ]
  const risks = checks.filter(([, v]) => v === true).map(([name]) => name)
  return {
    source: 'goplus',
    symbol: meta.symbol ?? null,
    name: meta.name ?? null,
    chain: 'solana',
    address,
    isMintable: status('mintable'),
    isFreezable: status('freezable'),
    isClosable: status('closable'),
    balanceMutable: status('balance_mutable_authority'),
    metadataMutable: status('metadata_mutable'),
    holders: num(r.holder_count),
    trusted: flag(r.trusted_token),
    riskCount: risks.length,
    risks: risks.join(', ') || 'none',
  }
}

export const goplus = makeApiCard<Props>({
  type: 'goplus',
  label: 'GoPlus',
  description: 'Token security check: honeypot, taxes, owner powers',
  icon: '🛡',
  source: 'GoPlus',
  defaultProps: { token: '', chain: 'ethereum', label: '', refreshSec: 0 },
  chains: ['ethereum', 'bsc', 'base', 'arbitrum', 'polygon', 'avalanche', 'optimism', 'solana'],
  needsToken: () => true,
  tokenHelp: 'a contract address (EVM or Solana), or a token row from a card (its chain comes along)',
  dataLabel: 'data — the security check: honeypot, buy / sell tax, mintable, owner powers, holders, and the risks found (riskCount, risks)',
  fetch: async ({ token, chain }) => {
    if (chain === 'solana') {
      const res = await getJson<{ result: Record<string, GoPlusRaw> }>(`${API}/solana/token_security?contract_addresses=${token}`, 'GoPlus')
      const r = res.result?.[token]
      if (!r) throw new Error('GoPlus has no data for this token')
      return { data: solanaRow(r, token) }
    }
    const c = chainById(chain)
    if (!c?.evmId) throw new Error(`GoPlus doesn't cover ${chain}`)
    const res = await getJson<{ result: Record<string, GoPlusRaw> }>(`${API}/token_security/${c.evmId}?contract_addresses=${token}`, 'GoPlus')
    const r = res.result?.[token.toLowerCase()]
    if (!r) throw new Error(`GoPlus has no data for this token on ${c.label}`)
    return { data: evmRow(r, chain, token) }
  },
  headline: ({ data }) => {
    if (!data) return null
    if (data.isHoneypot === true) return { text: 'Honeypot — you can’t sell', tone: 'bad' }
    const n = Number(data.riskCount)
    return n === 0 ? { text: 'No risks found', tone: 'good' } : { text: `${n} risk${n === 1 ? '' : 's'}: ${data.risks}`, tone: n > 2 ? 'bad' : 'warn' }
  },
  lines: ({ data }) => {
    if (!data) return []
    const lines: Line[] = []
    if (data.chain !== 'solana') {
      lines.push(['Honeypot', ...yesNo(data.isHoneypot as boolean | null)])
      lines.push(taxLine('Buy tax', num(data.buyTax)), taxLine('Sell tax', num(data.sellTax)))
      lines.push(['Open source', ...yesNo(data.isOpenSource as boolean | null, false)])
      lines.push(['Mintable', ...yesNo(data.isMintable as boolean | null)])
      lines.push(['Owner can change balances', ...yesNo(data.ownerCanChangeBalance as boolean | null)])
      lines.push(['Transfers pausable', ...yesNo(data.transferPausable as boolean | null)])
      lines.push(['Blacklist', ...yesNo(data.isBlacklisted as boolean | null)])
      lines.push(['Creator holds', pct(num(data.creatorPercent))])
    } else {
      lines.push(['Mintable', ...yesNo(data.isMintable as boolean | null)])
      lines.push(['Freezable', ...yesNo(data.isFreezable as boolean | null)])
      lines.push(['Balances changeable', ...yesNo(data.balanceMutable as boolean | null)])
      lines.push(['Metadata changeable', ...yesNo(data.metadataMutable as boolean | null)])
    }
    lines.push(['Holders', num(data.holders)?.toLocaleString('en-US') ?? '—'])
    return lines
  },
})
