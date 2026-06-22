// A tiny, safe arithmetic evaluator for prefix-rule prices like "80 + csaMm2 * cores * 44".
// Whitelisted: numbers, attribute identifiers, + - * / and parentheses. NEVER eval/Function —
// formulas come from the DB, so they are untrusted input.
//   evalFormula("80 + csaMm2 * cores", { csaMm2: 2.5, cores: 3 }) === 87.5
type Tok = { t: "num" | "id" | "op" | "paren"; v: string };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d*\.?\d+)|([a-zA-Z_][a-zA-Z0-9_]*)|([()+\-*/]))/y;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) throw new Error(`bad formula near '${s.slice(pos)}'`);
    pos = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "id", v: m[2] });
    else out.push({ t: m[3] === "(" || m[3] === ")" ? "paren" : "op", v: m[3]! });
  }
  return out;
}

export function evalFormula(expr: string, vars: Record<string, number>): number {
  const toks = tokenize(expr);
  let i = 0;
  const peek = (): Tok | undefined => toks[i];

  const factor = (): number => {
    const tk = peek();
    if (!tk) throw new Error(`unexpected end of formula '${expr}'`);
    if (tk.t === "paren" && tk.v === "(") {
      i++;
      const v = expr2();
      const close = peek();
      if (!close || close.v !== ")") throw new Error(`missing ) in '${expr}'`);
      i++;
      return v;
    }
    if (tk.t === "op" && tk.v === "-") { i++; return -factor(); }
    if (tk.t === "num") { i++; return Number(tk.v); }
    if (tk.t === "id") {
      i++;
      if (!(tk.v in vars) || !Number.isFinite(vars[tk.v])) {
        throw new Error(`formula '${expr}' needs attribute '${tk.v}', which the line doesn't have`);
      }
      return vars[tk.v]!;
    }
    throw new Error(`unexpected '${tk.v}' in '${expr}'`);
  };
  const term = (): number => {
    let v = factor();
    for (let o = peek(); o && o.t === "op" && (o.v === "*" || o.v === "/"); o = peek()) {
      i++;
      const r = factor();
      v = o.v === "*" ? v * r : v / r;
    }
    return v;
  };
  const expr2 = (): number => {
    let v = term();
    for (let o = peek(); o && o.t === "op" && (o.v === "+" || o.v === "-"); o = peek()) {
      i++;
      const r = term();
      v = o.v === "+" ? v + r : v - r;
    }
    return v;
  };

  const result = expr2();
  if (i !== toks.length) throw new Error(`trailing tokens in formula '${expr}'`);
  if (!Number.isFinite(result)) throw new Error(`formula '${expr}' did not produce a finite number`);
  return result;
}
