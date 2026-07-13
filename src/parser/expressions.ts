/**
 * Minimal, deliberately conservative GitHub Actions expression handling.
 *
 * We do NOT attempt to fully evaluate arbitrary `${{ ... }}` expressions.
 * Instead we support a small set of statically resolvable forms that matter
 * for analysis (matrix substitution, `hashFiles` glob extraction, a few
 * context lookups). Anything else is preserved verbatim and marked dynamic so
 * that downstream analyses can avoid unsupported conclusions.
 */

const EXPR_RE = /\$\{\{\s*(.*?)\s*\}\}/g;

/** Static context values used when resolving simple expressions. */
export interface ExpressionContext {
  matrix?: Record<string, unknown>;
  github?: Record<string, string>;
  runner?: Record<string, string>;
  env?: Record<string, string>;
}

export interface Resolution {
  /** Fully-substituted string. */
  value: string;
  /** True when at least one embedded expression could not be resolved. */
  dynamic: boolean;
}

/** True when the string contains at least one `${{ }}` expression. */
export function containsExpression(input: string): boolean {
  EXPR_RE.lastIndex = 0;
  return EXPR_RE.test(input);
}

function lookupPath(context: ExpressionContext, path: string): string | undefined {
  const parts = path.split('.');
  const root = parts[0];
  const rest = parts.slice(1);
  let scope: Record<string, unknown> | undefined;
  if (root === 'matrix') scope = context.matrix;
  else if (root === 'github') scope = context.github;
  else if (root === 'runner') scope = context.runner;
  else if (root === 'env') scope = context.env;
  else return undefined;
  if (!scope) return undefined;
  let cursor: unknown = scope;
  for (const key of rest) {
    if (cursor && typeof cursor === 'object' && key in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  if (cursor === undefined || cursor === null) return undefined;
  if (typeof cursor === 'object') return undefined;
  return String(cursor);
}

/** A single-quoted string literal, e.g. `'ubuntu-latest'`. */
function tryStringLiteral(expr: string): string | undefined {
  const m = /^'((?:[^'\\]|\\.)*)'$/.exec(expr.trim());
  if (!m || m[1] === undefined) return undefined;
  return m[1].replace(/\\'/g, "'");
}

/**
 * Attempt to resolve a single expression body (the text between `${{` and
 * `}}`). Returns the resolved string or undefined when unresolvable.
 */
function resolveExpressionBody(body: string, context: ExpressionContext): string | undefined {
  const trimmed = body.trim();
  const literal = tryStringLiteral(trimmed);
  if (literal !== undefined) return literal;
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(trimmed)) {
    return lookupPath(context, trimmed);
  }
  return undefined;
}

/**
 * Substitute resolvable expressions in `input` using `context`. Unresolved
 * expressions are left verbatim and cause `dynamic` to be true.
 */
export function resolve(input: string, context: ExpressionContext): Resolution {
  let dynamic = false;
  const value = input.replace(EXPR_RE, (_match, body: string) => {
    const resolved = resolveExpressionBody(body, context);
    if (resolved === undefined) {
      dynamic = true;
      return `\${{ ${body.trim()} }}`;
    }
    return resolved;
  });
  return { value, dynamic };
}

/**
 * Extract the glob/path arguments passed to any `hashFiles(...)` calls in the
 * string. Used by cache-key analysis. Returns an empty array when none.
 */
export function extractHashFilesGlobs(input: string): string[] {
  const globs: string[] = [];
  const re = /hashFiles\(\s*([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const args = match[1] ?? '';
    const argRe = /'((?:[^'\\]|\\.)*)'/g;
    let argMatch: RegExpExecArray | null;
    while ((argMatch = argRe.exec(args)) !== null) {
      if (argMatch[1] !== undefined) globs.push(argMatch[1]);
    }
  }
  return globs;
}

/** True when the string references `hashFiles(...)`. */
export function referencesHashFiles(input: string): boolean {
  return /hashFiles\s*\(/.test(input);
}

/**
 * Extract distinct context references (e.g. `matrix.os`, `github.sha`,
 * `runner.arch`) mentioned anywhere in the string. Order-preserving, unique.
 */
export function extractReferences(input: string): string[] {
  const refs = new Set<string>();
  EXPR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPR_RE.exec(input)) !== null) {
    const body = match[1] ?? '';
    const idRe =
      /\b(matrix|github|runner|env|needs|secrets|inputs|steps|job|vars)\.[A-Za-z0-9_.-]+/g;
    let idMatch: RegExpExecArray | null;
    while ((idMatch = idRe.exec(body)) !== null) {
      refs.add(idMatch[0]);
    }
  }
  return [...refs];
}
