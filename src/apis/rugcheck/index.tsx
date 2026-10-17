import { getJson, makeApiCard, num, pct, type ApiCardProps, type Line, type Row } from '../shared/makeApiCard'

/**
 * RugCheck (Solana): a token's rug-risk report — RugCheck's score, how much of the liquidity is
 * locked, and each risk found with its level (danger / warn). Free, no key: api.rugcheck.xyz.
 */
type Props = ApiCardProps

interface Summary {
  score: number
  score_normalised: number
  lpLockedPct?: number
  risks: { name: string; value: string; description: string; score: number; level: string }[]
}

export const rugcheck = makeApiCard<Props>({
  type: 'rugcheck',
  label: 'RugCheck',
  description: 'Solana rug-risk score, locked liquidity, risks',
  icon: '🔍',
  source: 'RugCheck',
  defaultProps: { token: '', chain: 'solana', label: '', refreshSec: 0 },
  chains: ['solana'],
  needsToken: () => true,
  tokenHelp: 'a Solana mint, or a token row from a card',
  dataLabel: 'data — the report: RugCheck’s score and normalised score, locked liquidity %, risk count, worst level, the risks by name',
  listLabel: 'list — each risk found: name, level (danger / warn), description, score',
  fetch: async ({ token }) => {
    const s = await getJson<Summary>(`https://api.rugcheck.xyz/v1/tokens/${token}/report/summary`, 'RugCheck')
    const worst = s.risks.some((r) => r.level === 'danger') ? 'danger' : s.risks.some((r) => r.level === 'warn') ? 'warn' : 'none'
    const data: Row = {
      source: 'rugcheck',
      chain: 'solana',
      address: token,
      score: s.score,
      scoreOutOf10: s.score_normalised,
      lpLockedPct: s.lpLockedPct ?? null,
      riskCount: s.risks.length,
      worstLevel: worst,
      risks: s.risks.map((r) => r.name).join(', ') || 'none',
    }
    const list: Row[] = s.risks.map((r) => ({ name: r.name, level: r.level, description: r.description, value: r.value || null, score: r.score }))
    return { data, list }
  },
  headline: ({ data }) => {
    if (!data) return null
    const n = Number(data.riskCount)
    if (data.worstLevel === 'danger') return { text: `Danger: ${data.risks}`, tone: 'bad' }
    return n === 0 ? { text: 'No risks found', tone: 'good' } : { text: `${n} warning${n === 1 ? '' : 's'}: ${data.risks}`, tone: 'warn' }
  },
  lines: ({ data, list }) => {
    if (!data) return []
    const s10 = num(data.scoreOutOf10)
    const locked = num(data.lpLockedPct)
    const lines: Line[] = [
      // RugCheck's own scores, shown as they are: the verdict comes from the risks it lists.
      ['Score (normalised)', s10?.toFixed(0) ?? '—'],
      ['Score', String(data.score ?? '—')],
      ['Liquidity locked', pct(locked), locked == null ? undefined : locked >= 90 ? 'good' : locked >= 50 ? 'warn' : 'bad'],
    ]
    for (const r of list ?? []) lines.push([String(r.name), String(r.level), r.level === 'danger' ? 'bad' : 'warn'])
    return lines
  },
})
