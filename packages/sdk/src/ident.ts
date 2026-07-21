const IDENT_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const IDENT_MAX = 63;

export class IdentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentError";
  }
}

export function assertIdent(name: string, kind: string): void {
  if (name.length > IDENT_MAX) {
    throw new IdentError(
      `${kind} name "${name}" exceeds max length ${IDENT_MAX}`
    );
  }
  if (!IDENT_RE.test(name)) {
    throw new IdentError(
      `${kind} name "${name}" is invalid: use letters, digits, underscores; must start with a letter (no hyphens)`
    );
  }
}

export function assertNoIdentCollisions(names: readonly string[], kind: string): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const key = name.toLowerCase();
    const prev = seen.get(key);
    if (prev && prev !== name) {
      throw new IdentError(
        `${kind} names "${prev}" and "${name}" collide (case-insensitive)`
      );
    }
    seen.set(key, name);
  }
}

/** Coerce a string into a safe lowercase identifier: non-`[a-zA-Z0-9_]` runes → `_`, then lowercased. Pure (no SQL). */
export function sanitiseIdent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}
