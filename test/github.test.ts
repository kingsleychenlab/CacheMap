import { describe, it, expect } from 'vitest';
import {
  GitHubClient,
  GitHubError,
  parseRepo,
  redactToken,
  resolveToken,
} from '../src/github/client.js';

describe('token handling', () => {
  it('redacts a token from text', () => {
    expect(redactToken('leaked ghp_secret here', 'ghp_secret')).toBe('leaked ***REDACTED*** here');
  });

  it('does not alter text when no token is present', () => {
    expect(redactToken('nothing to redact', undefined)).toBe('nothing to redact');
  });

  it('resolves a token from explicit value or env', () => {
    expect(resolveToken('explicit')).toBe('explicit');
    const prev = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'from-env';
    try {
      expect(resolveToken(undefined)).toBe('from-env');
    } finally {
      if (prev === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = prev;
    }
  });
});

describe('parseRepo', () => {
  it('parses owner/repo', () => {
    expect(parseRepo('kingsleychenlab/cachemap')).toEqual({
      owner: 'kingsleychenlab',
      repo: 'cachemap',
    });
  });
  it('rejects invalid slugs', () => {
    expect(() => parseRepo('not-a-slug')).toThrow(GitHubError);
  });
});

describe('request error normalization', () => {
  function client(): GitHubClient {
    return new GitHubClient({ token: 'ghp_test', maxRetries: 0 });
  }

  it('maps 401 to an auth error', async () => {
    await expect(
      client().request(async () => {
        throw Object.assign(new Error('Bad credentials'), { status: 401 });
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps 404 to a not-found error', async () => {
    await expect(
      client().request(async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }),
    ).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('maps a rate-limit 403 to a rate-limit error and redacts the token', async () => {
    const err = Object.assign(new Error('API rate limit exceeded for ghp_test'), {
      status: 403,
      response: { headers: { 'x-ratelimit-remaining': '0' } },
    });
    try {
      await client().request(async () => {
        throw err;
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubError);
      expect((e as GitHubError).kind).toBe('rate-limit');
      expect((e as GitHubError).message).not.toContain('ghp_test');
    }
  });
});
