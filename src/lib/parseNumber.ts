/**
 * Turn a value into a number, reading the formats the app (and people) write numbers in:
 *   55% → 55 · $1.02M → 1020000 · 1.5K → 1500 · -$4.40 → -4.4 · 1,234.5 → 1234.5
 *   $0.0₄2341 → 0.00002341 (the DexScreener-style zero compression used on cards)
 * Returns null when there's no number to read.
 */

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }
const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'

export function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value !== 'string') return null

  let s = value.trim().toLowerCase()
  if (!s) return null

  // "0.0₄2341": the subscript is how many zeros follow the decimal point → 0.00002341.
  s = s.replace(/0\.0([₀-₉]+)(\d+)/, (_, sub: string, digits: string) => {
    const zeros = Number([...sub].map((c) => SUBSCRIPT.indexOf(c)).join(''))
    return `0.${'0'.repeat(zeros)}${digits}`
  })

  // A leading sign (or accounting brackets) makes it negative; an exponent's sign is left alone.
  const negative = /^[(\s$€£¥₿Ξ]*[-−–]/.test(s) || /^\(.*\)$/.test(s)
  // Drop currency signs, %, spaces, thousands separators, brackets, then the leading sign.
  s = s.replace(/[()$€£¥₿Ξ%\s,]/g, '').replace(/^[+\-−–]+/, '')

  const m = s.match(/^(\d*\.?\d+)(?:e([+-]?\d+))?([kmbt])?$/)
  if (!m) return null
  let n = Number(m[1]) * (m[2] ? 10 ** Number(m[2]) : 1)
  if (m[3]) n *= SUFFIX[m[3]]
  if (!Number.isFinite(n)) return null
  // Keep the result clean of float noise from the multiplication (1.02 × 1e6 = 1020000.0000000001).
  n = Number(n.toPrecision(15))
  return negative ? -n : n
}
