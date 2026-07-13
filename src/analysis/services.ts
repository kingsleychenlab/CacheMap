/**
 * Rule: service-container overhead. Detects services started for jobs that do
 * not appear to use them, missing health checks, and services started on every
 * matrix combination.
 */
import type { Finding } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding, inferredSavings, unknownSavings } from './framework.js';

const RULE_UNUSED = 'service-unused';
const RULE_HEALTH = 'service-missing-healthcheck';
const RULE_MATRIX = 'service-per-matrix';

const SERVICE_HINTS: Record<string, RegExp> = {
  postgres: /postgres|psql|pg_|DATABASE_URL|:5432/i,
  mysql: /mysql|mariadb|:3306/i,
  redis: /redis|:6379/i,
  mongo: /mongo|:27017/i,
  rabbitmq: /rabbit|amqp|:5672/i,
  elasticsearch: /elastic|:9200/i,
};

/** Guess the service family from its id/image to look for usage hints. */
function serviceFamily(id: string, image: string | undefined): string | null {
  const haystack = `${id} ${image ?? ''}`.toLowerCase();
  for (const family of Object.keys(SERVICE_HINTS)) {
    if (haystack.includes(family) || (family === 'postgres' && haystack.includes('pg'))) {
      return family;
    }
  }
  return null;
}

export function analyzeServices(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  let unusedSeq = 1;
  let healthSeq = 1;
  let matrixSeq = 1;

  for (const job of input.workflow.jobs) {
    if (input.context.ignoredJobs.has(job.id)) continue;
    if (job.services.length === 0) continue;

    const jobText = job.steps
      .map(
        (s) =>
          `${s.run ?? ''} ${Object.values(s.env ?? {}).join(' ')} ${Object.values(s.with ?? {}).join(' ')}`,
      )
      .join('\n')
      .concat('\n', Object.values(job.env ?? {}).join(' '));

    for (const service of job.services) {
      const family = serviceFamily(service.id, service.image);
      const usageHint = family ? SERVICE_HINTS[family] : undefined;
      const looksUsed = usageHint ? usageHint.test(jobText) : true; // unknown family: assume used

      if (family && !looksUsed) {
        findings.push(
          makeFinding({
            rule: RULE_UNUSED,
            seq: unusedSeq++,
            kind: 'performance',
            severity: 'low',
            title: `Service \`${service.id}\` may be unused in job \`${job.id}\``,
            description: `Job \`${job.id}\` starts service container \`${service.id}\` (${service.image ?? 'unknown image'}), but no step references it (no matching host, port, or environment variable found). Service containers add startup time to every run of the job.`,
            recommendation:
              'Remove the service if the job does not use it, or move it to the specific job that does.',
            workflow: input.workflow.path,
            evidence: [
              {
                label: `job ${job.id}`,
                detail: `service: ${service.id} (${service.image ?? '?'})`,
              },
            ],
            ...(service.location ? { location: service.location } : {}),
            savings: inferredSavings(
              3,
              20,
              'Service startup typically costs several seconds to tens of seconds. Inferred.',
            ),
            jobs: [job.id],
          }),
        );
      }

      if (!service.hasHealthCheck) {
        findings.push(
          makeFinding({
            rule: RULE_HEALTH,
            seq: healthSeq++,
            kind: 'performance',
            severity: 'low',
            title: `Service \`${service.id}\` in job \`${job.id}\` has no health check`,
            description: `Service container \`${service.id}\` does not define a health check (\`--health-cmd\`). Without one, steps may start before the service is ready, leading to flaky failures and retry loops that waste time.`,
            recommendation:
              'Add health-check options (e.g. `--health-cmd`, `--health-interval`, `--health-retries`) so steps wait until the service is ready.',
            workflow: input.workflow.path,
            evidence: [{ label: `job ${job.id}`, detail: `service: ${service.id}` }],
            ...(service.location ? { location: service.location } : {}),
            savings: unknownSavings(
              'Impact is avoided flakiness/retries, which requires history to quantify.',
            ),
            jobs: [job.id],
          }),
        );
      }
    }

    // Services start for every matrix combination.
    const variants = input.variantsByJob.get(job.id) ?? [];
    if (job.matrix && variants.length >= 4 && job.services.length > 0) {
      findings.push(
        makeFinding({
          rule: RULE_MATRIX,
          seq: matrixSeq++,
          kind: 'performance',
          severity: 'low',
          title: `Service containers start for all ${variants.length} matrix combinations of \`${job.id}\``,
          description: `Job \`${job.id}\` starts ${job.services.length} service container(s) on each of its ${variants.length} matrix combinations. If only some combinations need the service, the rest pay startup cost for nothing.`,
          recommendation:
            'Split the job so only the combinations that need the service start it, or gate the integration tests to a single representative combination.',
          workflow: input.workflow.path,
          evidence: job.services.map((s) => ({
            label: `job ${job.id}`,
            detail: `service: ${s.id}`,
          })),
          ...(job.location ? { location: job.location } : {}),
          savings: inferredSavings(
            0,
            (variants.length - 1) * 10 * job.services.length,
            `Upper bound assumes non-essential combinations (~${variants.length - 1}) each avoid ~10s of service startup per service. Inferred.`,
          ),
          jobs: [job.id],
        }),
      );
    }
  }

  return findings;
}
