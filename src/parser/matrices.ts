/**
 * Matrix expansion into concrete job variants, following GitHub's documented
 * include/exclude semantics as closely as is statically possible.
 *
 * When a matrix references unresolved expressions we cannot enumerate the
 * combinations; in that case we emit a single variant flagged `dynamic: true`
 * so analyses can avoid unsupported conclusions.
 */
import type { JobModel, JobVariant, RawMatrix } from '../types.js';

function valueLabel(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Build the GitHub-style display id, e.g. `test (ubuntu-latest, 20)`. */
function buildVariantId(jobId: string, ordered: unknown[]): string {
  if (ordered.length === 0) return jobId;
  return `${jobId} (${ordered.map(valueLabel).join(', ')})`;
}

/** Cartesian product of the base matrix dimensions. */
function cartesian(dimensions: { name: string; values: unknown[] }[]): Record<string, unknown>[] {
  let combos: Record<string, unknown>[] = [{}];
  for (const dim of dimensions) {
    const next: Record<string, unknown>[] = [];
    for (const combo of combos) {
      for (const value of dim.values) {
        next.push({ ...combo, [dim.name]: value });
      }
    }
    combos = next;
  }
  return combos;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** True when `combo` matches all key/values present in `filter`. */
function matchesAll(combo: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (!(k in combo) || !deepEqual(combo[k], v)) return false;
  }
  return true;
}

/**
 * Expand a job's matrix into concrete variants. Jobs without a matrix yield a
 * single variant. Dynamic matrices yield a single dynamic variant.
 */
export function expandMatrix(job: JobModel): JobVariant[] {
  const matrix = job.matrix;
  if (!matrix) {
    return [{ jobId: job.id, variantId: job.id, matrixValues: {}, dynamic: false }];
  }
  if (matrix.dynamic || hasUnresolvableDimension(matrix)) {
    return [{ jobId: job.id, variantId: job.id, matrixValues: {}, dynamic: true }];
  }

  const baseDims = matrix.dimensions
    .filter((d): d is typeof d & { values: unknown[] } => Array.isArray(d.values))
    .map((d) => ({ name: d.name, values: d.values }));
  const originalKeys = new Set(baseDims.map((d) => d.name));

  let combos = cartesian(baseDims);

  // exclude: remove combinations matching an exclude entry.
  if (matrix.exclude.length > 0) {
    combos = combos.filter((combo) => !matrix.exclude.some((ex) => matchesAll(combo, ex)));
  }

  // include: merge into matching combinations, else append as new.
  for (const inc of matrix.include) {
    let merged = false;
    for (const combo of combos) {
      // An include may extend a combination only if it does not overwrite any
      // ORIGINAL matrix value (original keys present in include must match).
      const conflictsWithOriginal = Object.entries(inc).some(
        ([k, v]) => originalKeys.has(k) && k in combo && !deepEqual(combo[k], v),
      );
      const sharesOriginalKey = Object.keys(inc).some((k) => originalKeys.has(k));
      if (!conflictsWithOriginal) {
        // Add non-original keys (and original keys, which already match).
        for (const [k, v] of Object.entries(inc)) {
          if (!originalKeys.has(k)) combo[k] = v;
        }
        merged = true;
        if (!sharesOriginalKey) {
          // Include with only extra keys applies to every combination.
          continue;
        }
      }
    }
    if (!merged) {
      combos.push({ ...inc });
    }
  }

  if (combos.length === 0) {
    // Everything excluded — represent as an empty (no-op) matrix.
    return [{ jobId: job.id, variantId: job.id, matrixValues: {}, dynamic: false }];
  }

  // Build deterministic variant ids using declaration order, then extra keys.
  const extraKeyOrder: string[] = [];
  for (const combo of combos) {
    for (const k of Object.keys(combo)) {
      if (!originalKeys.has(k) && !extraKeyOrder.includes(k)) extraKeyOrder.push(k);
    }
  }
  const orderedKeys = [...baseDims.map((d) => d.name), ...extraKeyOrder];

  const seen = new Set<string>();
  const variants: JobVariant[] = [];
  for (const combo of combos) {
    const ordered = orderedKeys.filter((k) => k in combo).map((k) => combo[k]);
    let variantId = buildVariantId(job.id, ordered);
    // Guarantee uniqueness for duplicate display ids.
    let suffix = 2;
    const base = variantId;
    while (seen.has(variantId)) {
      variantId = `${base} #${suffix++}`;
    }
    seen.add(variantId);
    variants.push({ jobId: job.id, variantId, matrixValues: combo, dynamic: false });
  }
  return variants;
}

function hasUnresolvableDimension(matrix: RawMatrix): boolean {
  return matrix.dimensions.some((d) => d.dynamic || !Array.isArray(d.values));
}

/**
 * Detect duplicate matrix combinations (identical resolved values). Returns
 * groups of variant ids that share the same matrix values.
 */
export function findDuplicateCombinations(variants: JobVariant[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const v of variants) {
    if (v.dynamic) continue;
    const key = JSON.stringify(
      Object.keys(v.matrixValues)
        .sort()
        .map((k) => [k, v.matrixValues[k]]),
    );
    const list = groups.get(key) ?? [];
    list.push(v.variantId);
    groups.set(key, list);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
