/**
 * A tiny, safe formula language for the Formula block: numbers, names (columns such as `volume24h`,
 * `liquidity`, or inputs `a`, `b`), + − × ÷ ^, brackets, and abs / min / max / sqrt / log / round.
 *   volume24h / liquidity        (price - a) / a * 100        max(change1h, change24h)
 * Parsed once into a tree, then evaluated per row — never `eval`.
 */
type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'neg'; e: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'fn'; name: string; args: Node[] }

const FUNCS: Record<string, (...x: number[]) => number> = {
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  sqrt: Math.sqrt,
  log: Math.log10,
  ln: Math.log,
  round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
}

export function parseFormula(src: string): Node {
  const toks = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]\w*|[-+*/^(),]/gi) ?? []
  const rest = src.replace(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]\w*|[-+*/^(),]|\s+/gi, '')
  if (rest) throw new Error(`Can’t read “${rest[0]}” in the formula`)
  let i = 0
  const peek = () => toks[i]
  const next = () => toks[i++]
  const expect = (t: string) => {
    if (next() !== t) throw new Error(`Expected “${t}” in the formula`)
  }
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 }

  function primary(): Node {
    const tok = next()
    if (tok === undefined) throw new Error('The formula ends too early')
    if (tok === '-') return { t: 'neg', e: primary() }
    if (tok === '(') {
      const e = expr(0)
      expect(')')
      return e
    }
    if (/^[\d.]/.test(tok)) return { t: 'num', v: Number(tok) }
    if (/^[A-Za-z_]/.test(tok)) {
      if (peek() === '(') {
        next()
        const args: Node[] = []
        if (peek() !== ')') {
          args.push(expr(0))
          while (peek() === ',') (next(), args.push(expr(0)))
        }
        expect(')')
        if (!FUNCS[tok.toLowerCase()]) throw new Error(`No function called “${tok}”`)
        return { t: 'fn', name: tok.toLowerCase(), args }
      }
      return { t: 'var', name: tok }
    }
    throw new Error(`Unexpected “${tok}” in the formula`)
  }

  /** Precedence climbing: binds tighter operators first; ^ is right-associative. */
  function expr(min: number): Node {
    let left = primary()
    for (;;) {
      const op = peek()
      const p = op === undefined ? undefined : prec[op]
      if (p === undefined || p < min) break
      next()
      const right = expr(op === '^' ? p : p + 1)
      left = { t: 'bin', op: op!, a: left, b: right }
    }
    return left
  }

  const tree = expr(0)
  if (i < toks.length) throw new Error(`Unexpected “${toks[i]}” in the formula`)
  return tree
}

/** Evaluate with these names; a missing name or a division by zero gives null. */
export function evalFormula(node: Node, vars: Record<string, number | null | undefined>): number | null {
  const ev = (n: Node): number | null => {
    switch (n.t) {
      case 'num':
        return n.v
      case 'var': {
        const v = vars[n.name]
        return typeof v === 'number' && Number.isFinite(v) ? v : null
      }
      case 'neg': {
        const v = ev(n.e)
        return v == null ? null : -v
      }
      case 'fn': {
        const args = n.args.map(ev)
        if (args.some((a) => a == null)) return null
        const r = FUNCS[n.name](...(args as number[]))
        return Number.isFinite(r) ? r : null
      }
      case 'bin': {
        const a = ev(n.a)
        const b = ev(n.b)
        if (a == null || b == null) return null
        const r = n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? (b === 0 ? NaN : a / b) : a ** b
        return Number.isFinite(r) ? r : null
      }
    }
  }
  return ev(node)
}

/** The names a formula uses (to say which columns it needs). */
export function formulaNames(node: Node): string[] {
  const out = new Set<string>()
  const walk = (n: Node) => {
    if (n.t === 'var') out.add(n.name)
    else if (n.t === 'neg') walk(n.e)
    else if (n.t === 'bin') (walk(n.a), walk(n.b))
    else if (n.t === 'fn') n.args.forEach(walk)
  }
  walk(node)
  return [...out]
}
