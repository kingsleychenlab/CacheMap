/**
 * Safe GitHub Actions workflow YAML parsing into {@link WorkflowModel}.
 *
 * Safety: parsing is data-only — the `yaml` library never executes code, and
 * we cap alias expansion to guard against "billion laughs" style documents.
 * We never run repository code or workflow steps. Source locations (line/col)
 * are captured for jobs, steps, and services so findings can be annotated.
 */
import { parseDocument, LineCounter, isMap, isSeq, isScalar } from 'yaml';
import type { Document } from 'yaml';
import type {
  WorkflowModel,
  JobModel,
  StepModel,
  ServiceModel,
  TriggerModel,
  TriggerFilters,
  PermissionsModel,
  ConcurrencyModel,
  RawMatrix,
  MatrixDimension,
  ResolvedValue,
  SourceLocation,
} from '../types.js';
import { containsExpression } from './expressions.js';

export class WorkflowParseError extends Error {
  constructor(
    message: string,
    public readonly file: string,
  ) {
    super(message);
    this.name = 'WorkflowParseError';
  }
}

type Path = (string | number)[];

/** Resolve a source location for a document path, when available. */
function locationAt(
  doc: Document.Parsed,
  lineCounter: LineCounter,
  path: Path,
  file: string,
): SourceLocation | undefined {
  try {
    const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
    if (node && Array.isArray(node.range)) {
      const pos = lineCounter.linePos(node.range[0]);
      return { file, line: pos.line, column: pos.col };
    }
  } catch {
    // fall through
  }
  return { file };
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map(asString).filter((v): v is string => v !== undefined);
  }
  const single = asString(value);
  return single !== undefined ? [single] : [];
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const s = asString(v);
    if (s !== undefined) out[k] = s;
    else out[k] = ''; // preserve key even when value is dynamic/complex
  }
  return out;
}

function parseResolvedString(value: unknown): ResolvedValue<string> {
  if (Array.isArray(value)) {
    // runs-on can be a group array; join for display.
    const joined = value.map(asString).filter(Boolean).join(', ');
    return { value: joined, raw: joined, dynamic: false };
  }
  const raw = asString(value) ?? '';
  const dynamic = containsExpression(raw);
  return { value: dynamic ? undefined : raw, raw, dynamic };
}

function parsePermissions(value: unknown): PermissionsModel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value === 'read-all' || value === 'write-all') {
      return { blanket: value, scopes: {}, raw: value };
    }
    return { scopes: {}, raw: value };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const scopes: Record<string, 'read' | 'write' | 'none'> = {};
    for (const [scope, level] of Object.entries(value as Record<string, unknown>)) {
      const lvl = asString(level);
      if (lvl === 'read' || lvl === 'write' || lvl === 'none') {
        scopes[scope] = lvl;
      }
    }
    return { scopes, raw: value };
  }
  return undefined;
}

function parseTriggerFilters(value: unknown): TriggerFilters | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const filters: TriggerFilters = {};
  const branches = asStringArray(obj['branches']);
  const branchesIgnore = asStringArray(obj['branches-ignore']);
  const paths = asStringArray(obj['paths']);
  const pathsIgnore = asStringArray(obj['paths-ignore']);
  const tags = asStringArray(obj['tags']);
  if (branches.length) filters.branches = branches;
  if (branchesIgnore.length) filters.branchesIgnore = branchesIgnore;
  if (paths.length) filters.paths = paths;
  if (pathsIgnore.length) filters.pathsIgnore = pathsIgnore;
  if (tags.length) filters.tags = tags;
  return filters;
}

function parseTriggers(value: unknown): TriggerModel {
  const model: TriggerModel = { events: [], raw: value };
  if (typeof value === 'string') {
    model.events = [value];
    return model;
  }
  if (Array.isArray(value)) {
    model.events = value.map(asString).filter((v): v is string => v !== undefined);
    return model;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    model.events = Object.keys(obj);
    const push = parseTriggerFilters(obj['push']);
    if (push) model.push = push;
    const pr = parseTriggerFilters(obj['pull_request']);
    if (pr) model.pullRequest = pr;
    const prt = parseTriggerFilters(obj['pull_request_target']);
    if (prt) model.pullRequestTarget = prt;
    const schedule = obj['schedule'];
    if (Array.isArray(schedule)) {
      const crons = schedule
        .map((s) =>
          s && typeof s === 'object' ? asString((s as Record<string, unknown>).cron) : undefined,
        )
        .filter((c): c is string => c !== undefined)
        .map((cron) => ({ cron }));
      if (crons.length) model.schedule = crons;
    }
  }
  return model;
}

function parseConcurrency(value: unknown): ConcurrencyModel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return { group: value, cancelInProgress: false };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const group = asString(obj['group']) ?? '';
    const cancel = obj['cancel-in-progress'];
    return {
      group,
      cancelInProgress: typeof cancel === 'boolean' ? cancel : (asString(cancel) ?? false),
    };
  }
  return undefined;
}

function parseMatrix(value: unknown): RawMatrix | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const dimensions: MatrixDimension[] = [];
  let dynamic = false;

  for (const [name, dimValue] of Object.entries(obj)) {
    if (name === 'include' || name === 'exclude') continue;
    if (typeof dimValue === 'string' && containsExpression(dimValue)) {
      dimensions.push({ name, dynamic: true, raw: dimValue });
      dynamic = true;
      continue;
    }
    if (Array.isArray(dimValue)) {
      const hasDynamic = dimValue.some((v) => typeof v === 'string' && containsExpression(v));
      dimensions.push({
        name,
        values: dimValue,
        dynamic: hasDynamic,
        raw: JSON.stringify(dimValue),
      });
      if (hasDynamic) dynamic = true;
    } else {
      dimensions.push({ name, dynamic: true, raw: String(dimValue) });
      dynamic = true;
    }
  }

  const include = Array.isArray(obj['include'])
    ? (obj['include'] as unknown[]).filter(
        (v): v is Record<string, unknown> => v !== null && typeof v === 'object',
      )
    : [];
  const exclude = Array.isArray(obj['exclude'])
    ? (obj['exclude'] as unknown[]).filter(
        (v): v is Record<string, unknown> => v !== null && typeof v === 'object',
      )
    : [];

  if (typeof obj['include'] === 'string' && containsExpression(obj['include'])) dynamic = true;
  if (typeof obj['exclude'] === 'string' && containsExpression(obj['exclude'])) dynamic = true;

  return { dimensions, include, exclude, dynamic, raw: value };
}

function parseServices(
  value: unknown,
  doc: Document.Parsed,
  lineCounter: LineCounter,
  jobPath: Path,
  file: string,
): ServiceModel[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const services: ServiceModel[] = [];
  for (const [id, svc] of Object.entries(value as Record<string, unknown>)) {
    if (svc === null || typeof svc !== 'object') {
      services.push({
        id,
        hasHealthCheck: false,
        ...loc(doc, lineCounter, [...jobPath, 'services', id], file),
      });
      continue;
    }
    const svcObj = svc as Record<string, unknown>;
    const image = asString(svcObj['image']);
    const ports = asStringArray(svcObj['ports']);
    const options = asString(svcObj['options']) ?? '';
    const hasHealthCheck = /--health-cmd/.test(options);
    services.push({
      id,
      ...(image !== undefined ? { image } : {}),
      ...(ports.length ? { ports } : {}),
      hasHealthCheck,
      ...loc(doc, lineCounter, [...jobPath, 'services', id], file),
    });
  }
  return services;
}

/** Wrap locationAt into an object spread for `...loc(...)`. */
function loc(
  doc: Document.Parsed,
  lineCounter: LineCounter,
  path: Path,
  file: string,
): { location?: SourceLocation } {
  const location = locationAt(doc, lineCounter, path, file);
  return location ? { location } : {};
}

function parseSteps(
  value: unknown,
  doc: Document.Parsed,
  lineCounter: LineCounter,
  jobPath: Path,
  file: string,
): StepModel[] {
  if (!Array.isArray(value)) return [];
  const steps: StepModel[] = [];
  value.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object') return;
    const obj = raw as Record<string, unknown>;
    const uses = asString(obj['uses']);
    const name = asString(obj['name']);
    const run = asString(obj['run']);
    const ifCond = asString(obj['if']);
    const step: StepModel = {
      index,
      ...(name !== undefined ? { name } : {}),
      ...(uses !== undefined ? { uses } : {}),
      ...(run !== undefined ? { run } : {}),
      ...(ifCond !== undefined ? { if: ifCond } : {}),
      ...loc(doc, lineCounter, [...jobPath, 'steps', index], file),
    };
    if (uses !== undefined) {
      const at = uses.lastIndexOf('@');
      if (at > 0) {
        step.usesAction = uses.slice(0, at);
        step.usesVersion = uses.slice(at + 1);
      } else {
        step.usesAction = uses;
      }
    }
    const withMap = asStringMap(obj['with']);
    if (withMap) step.with = withMap;
    const envMap = asStringMap(obj['env']);
    if (envMap) step.env = envMap;
    steps.push(step);
  });
  return steps;
}

function parseJob(
  id: string,
  raw: unknown,
  doc: Document.Parsed,
  lineCounter: LineCounter,
  file: string,
): JobModel {
  const jobPath: Path = ['jobs', id];
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const strategy = (
    obj['strategy'] && typeof obj['strategy'] === 'object' ? obj['strategy'] : {}
  ) as Record<string, unknown>;
  const matrix = parseMatrix(strategy['matrix']);
  const failFast = typeof strategy['fail-fast'] === 'boolean' ? strategy['fail-fast'] : undefined;
  const maxParallel =
    typeof strategy['max-parallel'] === 'number' ? strategy['max-parallel'] : undefined;

  const usesWorkflow = asString(obj['uses']);
  const permissions = parsePermissions(obj['permissions']);
  const envMap = asStringMap(obj['env']);
  const jobName = asString(obj['name']);
  const jobIf = asString(obj['if']);

  const job: JobModel = {
    id,
    ...(jobName !== undefined ? { name: jobName } : {}),
    runsOn: parseResolvedString(obj['runs-on']),
    needs: asStringArray(obj['needs']),
    ...(jobIf !== undefined ? { if: jobIf } : {}),
    steps: parseSteps(obj['steps'], doc, lineCounter, jobPath, file),
    services: parseServices(obj['services'], doc, lineCounter, jobPath, file),
    ...(matrix ? { matrix } : {}),
    ...(failFast !== undefined ? { failFast } : {}),
    ...(maxParallel !== undefined ? { maxParallel } : {}),
    ...(usesWorkflow !== undefined ? { usesWorkflow } : {}),
    ...(permissions ? { permissions } : {}),
    ...(envMap ? { env: envMap } : {}),
    ...loc(doc, lineCounter, jobPath, file),
  };
  return job;
}

function documentName(obj: Record<string, unknown>, fallback: string): string {
  const name = asString(obj['name']);
  return name && name.trim() ? name : fallback;
}

/**
 * Parse a workflow YAML string into a {@link WorkflowModel}.
 *
 * @param contents raw YAML text
 * @param path repository-relative path (used for locations and default name)
 */
export function parseWorkflow(contents: string, path: string): WorkflowModel {
  const lineCounter = new LineCounter();
  const doc = parseDocument(contents, { lineCounter });

  const warnings: string[] = [];
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    throw new WorkflowParseError(`YAML parse error: ${first?.message ?? 'unknown'}`, path);
  }
  for (const w of doc.warnings) {
    warnings.push(w.message);
  }

  const root = doc.contents;
  if (!root || (!isMap(root) && !isScalar(root) && !isSeq(root))) {
    throw new WorkflowParseError('Workflow is empty or not a mapping', path);
  }
  // maxAliasCount guards against "billion laughs" alias-expansion attacks.
  const js = doc.toJS({ maxAliasCount: 100 });
  if (js === null || typeof js !== 'object' || Array.isArray(js)) {
    throw new WorkflowParseError('Workflow root must be a mapping', path);
  }
  const obj = js as Record<string, unknown>;

  const jobsRaw = obj['jobs'];
  const jobs: JobModel[] = [];
  if (jobsRaw && typeof jobsRaw === 'object' && !Array.isArray(jobsRaw)) {
    for (const jobId of Object.keys(jobsRaw as Record<string, unknown>)) {
      jobs.push(
        parseJob(jobId, (jobsRaw as Record<string, unknown>)[jobId], doc, lineCounter, path),
      );
    }
  } else {
    warnings.push('Workflow has no `jobs` mapping');
  }

  const permissions = parsePermissions(obj['permissions']);
  const concurrency = parseConcurrency(obj['concurrency']);
  const defaults =
    obj['defaults'] && typeof obj['defaults'] === 'object' && !Array.isArray(obj['defaults'])
      ? (obj['defaults'] as Record<string, unknown>)
      : undefined;

  // `on` is often YAML-parsed as the boolean `true` key because bare `on`
  // is a YAML 1.1 truthy token; check both.
  const onValue = obj['on'] !== undefined ? obj['on'] : obj[String(true)];

  return {
    path,
    name: documentName(obj, path),
    triggers: parseTriggers(onValue),
    ...(permissions ? { permissions } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(defaults ? { defaults } : {}),
    jobs,
    warnings,
  };
}
