import { chainById } from '../../services/chains'
import { getJson, makeApiCard, num, taxLine, yesNo, type ApiCardProps, type Line } from '../shared/makeApiCard'

/**
 * honeypot.is (Ethereum, BNB Chain, Base): simulates a real buy and sell of the token — is it a honeypot,
 * what tax is actually taken on buy / sell / transfer, the overall risk, and what's been seen in holders'
 * sells. Free, no key: api.honeypot.is.
 */
type Props = ApiCardProps

interface HoneypotAnswer {
  token?: { name: string; symbol: string; totalHolders?: number }
  summary?: { risk?: string; riskLevel?: number; flags?: { flag?: string; description?: string }[] }
  simulationSuccess?: boolean
  simulationError?: string
  honeypotResult?: { isHoneypot: boolean; honeypotReason?: string }
  simulationResult?: { buyTax?: number; sellTax?: number; transferTax?: number }
  holderAnalysis?: { holders?: string; successful?: string; failed?: string; siphoned?: string; highestTax?: number }
}

export const honeypot = makeApiCard<Props>({
  type: 'honeypot',
  label: 'honeypot.is',
  description: 'Simulated buy & sell: honeypot? real taxes',
  icon: '🍯',
  source: 'honeypot.is',
  defaultProps: { token: '', chain: 'ethereum', label: '', refreshSec: 0 },
  chains: ['ethereum', 'bsc', 'base'],
  needsToken: () => true,
  tokenHelp: 'an EVM contract address (Ethereum, BNB Chain, Base), or a token row from a card',
  dataLabel: 'data — the simulation: isHoneypot, risk (low → high), buy / sell / transfer tax, holders, flags',
  fetch: async ({ token, chain }) => {
    const c = chainById(chain)
    if (!c?.evmId) throw new Error(`honeypot.is doesn't cover ${chain}`)
    const a = await getJson<HoneypotAnswer>(`https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=${c.evmId}`, 'honeypot.is')
    if (!a.simulationSuccess && a.simulationError) throw new Error(`Simulation failed: ${a.simulationError}`)
    return {
      data: {
        source: 'honeypot.is',
        symbol: a.token?.symbol ?? null,
        name: a.token?.name ?? null,
        chain,
        address: token,
        isHoneypot: a.honeypotResult?.isHoneypot ?? null,
        reason: a.honeypotResult?.honeypotReason ?? null,
        risk: a.summary?.risk ?? null,
        riskLevel: a.summary?.riskLevel ?? null,
        buyTax: a.simulationResult?.buyTax ?? null,
        sellTax: a.simulationResult?.sellTax ?? null,
        transferTax: a.simulationResult?.transferTax ?? null,
        holders: a.token?.totalHolders ?? null,
        holdersFailedToSell: num(a.holderAnalysis?.failed),
        flags: (a.summary?.flags ?? []).map((f) => f.flag ?? f.description).filter(Boolean).join(', ') || 'none',
      },
    }
  },
  headline: ({ data }) => {
    if (!data) return null
    if (data.isHoneypot) return { text: `Honeypot${data.reason ? ` — ${data.reason}` : ''}`, tone: 'bad' }
    const risk = String(data.risk ?? '')
    return { text: `Not a honeypot · ${risk || 'unknown'} risk`, tone: risk === 'low' || risk === 'very_low' ? 'good' : 'warn' }
  },
  lines: ({ data }) => {
    if (!data) return []
    const lines: Line[] = [
      ['Honeypot', ...yesNo(data.isHoneypot as boolean | null)],
      ['Risk', String(data.risk ?? '—'), data.risk === 'low' || data.risk === 'very_low' ? 'good' : 'warn'],
      taxLine('Buy tax', num(data.buyTax)),
      taxLine('Sell tax', num(data.sellTax)),
      taxLine('Transfer tax', num(data.transferTax)),
      ['Holders', num(data.holders)?.toLocaleString('en-US') ?? '—'],
      ['Holders who couldn’t sell', String(data.holdersFailedToSell ?? '—'), num(data.holdersFailedToSell) ? 'warn' : undefined],
      ['Flags', String(data.flags)],
    ]
    return lines
  },
})
