/**
 * Thin, defensive wrapper around @octokit/rest for optional historical data.
 *
 * Safety: tokens are never logged and are redacted from any error message.
 * Pagination and retries are bounded, and rate-limit responses produce a clear,
 * actionable error rather than an opaque failure.
 */
import { Octokit } from '@octokit/rest';

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly kind: 'auth' | 'rate-limit' | 'not-found' | 'network' | 'unknown',
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubClientOptions {
  token: string;
  /** Base URL for GitHub Enterprise; defaults to public GitHub. */
  baseUrl?: string;
  /** Max pages to fetch for any paginated endpoint. */
  maxPages?: number;
  /** Max retries for transient failures. */
  maxRetries?: number;
}

/** Replace any occurrence of the token in a string with a redaction marker. */
export function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join('***REDACTED***');
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Parse "owner/repo" into a {@link RepoRef}. */
export function parseRepo(slug: string): RepoRef {
  const parts = slug.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GitHubError(`Invalid repository slug "${slug}" (expected owner/repo)`, 'unknown');
  }
  return { owner: parts[0], repo: parts[1] };
}

export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly token: string;
  readonly maxPages: number;
  private readonly maxRetries: number;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.maxPages = options.maxPages ?? 10;
    this.maxRetries = options.maxRetries ?? 3;
    this.octokit = new Octokit({
      auth: options.token,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      request: { timeout: 20000 },
    });
  }

  /** Redact the configured token from arbitrary text. */
  redact(text: string): string {
    return redactToken(text, this.token);
  }

  /**
   * Execute an Octokit call with bounded retry and normalized errors. The token
   * is redacted from any error surfaced to callers.
   */
  async request<T>(fn: (octokit: Octokit) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn(this.octokit);
      } catch (err) {
        lastError = err;
        const status = (err as { status?: number }).status;
        // Secondary rate limit / abuse detection uses 403 with a retry-after.
        if (status === 403 || status === 429) {
          const isRate = this.isRateLimit(err);
          if (isRate && attempt < this.maxRetries) {
            await this.sleep(this.backoff(attempt, err));
            continue;
          }
          throw new GitHubError(
            this.redact(
              `GitHub rate limit reached: ${this.messageOf(err)}. Retry later or reduce --runs.`,
            ),
            'rate-limit',
          );
        }
        if (status === 401) {
          throw new GitHubError(
            'GitHub authentication failed (check the token and its scopes).',
            'auth',
          );
        }
        if (status === 404) {
          throw new GitHubError(this.redact(`Not found: ${this.messageOf(err)}`), 'not-found');
        }
        if (status && status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt, err));
          continue;
        }
        // Network errors without a status: retry a couple of times.
        if (status === undefined && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt, err));
          continue;
        }
        break;
      }
    }
    throw new GitHubError(
      this.redact(`GitHub request failed: ${this.messageOf(lastError)}`),
      'network',
    );
  }

  /**
   * Paginate an endpoint up to {@link maxPages}. `fn` receives the 1-based page
   * number and returns that page's items (empty array ends pagination).
   */
  async paginate<T>(fn: (page: number) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const items = await fn(page);
      out.push(...items);
      if (items.length === 0) break;
    }
    return out;
  }

  private isRateLimit(err: unknown): boolean {
    const message = this.messageOf(err).toLowerCase();
    const headers = (err as { response?: { headers?: Record<string, string> } }).response?.headers;
    const remaining = headers?.['x-ratelimit-remaining'];
    return (
      message.includes('rate limit') || message.includes('secondary rate') || remaining === '0'
    );
  }

  private backoff(attempt: number, err: unknown): number {
    const headers = (err as { response?: { headers?: Record<string, string> } }).response?.headers;
    const retryAfter = headers?.['retry-after'];
    if (retryAfter && Number.isFinite(Number(retryAfter))) {
      return Math.min(Number(retryAfter) * 1000, 30000);
    }
    return Math.min(1000 * 2 ** attempt, 15000);
  }

  private messageOf(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Resolve a token from an explicit value or standard environment variables.
 * Returns null when none is available (callers then run offline).
 */
export function resolveToken(explicit: string | undefined): string | null {
  if (explicit && explicit.trim()) return explicit.trim();
  const env = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  return env && env.trim() ? env.trim() : null;
}
