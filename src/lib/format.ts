const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})

export const CURRENCY_SYMBOLS: Record<string, string> = {
  usd: '$',
  eur: '€',
  gbp: '£',
  jpy: '¥',
  btc: '₿',
  eth: 'Ξ',
}
const sym = (currency: string) => CURRENCY_SYMBOLS[currency] ?? currency.toUpperCase() + ' '

export function moneyCompact(n: number | null | undefined, currency = 'usd'): string {
  if (n == null || Number.isNaN(n)) return '—'
  return sym(currency) + compact.format(n)
}

export const usdCompact = (n: number | null | undefined) => moneyCompact(n, 'usd')

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'

/** 0.00002587 → $0.0₄2587 (DexScreener-style zero compression). Accepts API strings or numbers. */
export function money(raw: string | number | null | undefined, currency = 'usd'): string {
  if (raw == null || raw === '') return '—'
  const n = Number(raw)
  if (Number.isNaN(n)) return '—'
  if (n >= 1) return sym(currency) + n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 2 : 4 })
  // Numbers like 4.06e-6 need a plain decimal string to count the zeros.
  const plain = typeof raw === 'string' && !raw.includes('e') ? raw : n.toFixed(20)
  const match = plain.match(/^0\.(0+)(\d+)/)
  if (match && match[1].length >= 4) {
    const zeros = String(match[1].length)
      .split('')
      .map((d) => SUBSCRIPT[Number(d)])
      .join('')
    return `${sym(currency)}0.0${zeros}${match[2].slice(0, 4)}`
  }
  return sym(currency) + Number(n.toPrecision(4))
}

export const usdPrice = (raw: string | number | null | undefined) => money(raw, 'usd')

export function percent(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

export function age(ts: number | undefined): string {
  if (!ts) return '—'
  const days = (Date.now() - ts) / 86_400_000
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`
  if (days < 60) return `${Math.round(days)}d`
  if (days < 730) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(1)}y`
}

export function compactNumber(n: number | null | undefined): string {
  return n == null ? '—' : compact.format(n)
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
