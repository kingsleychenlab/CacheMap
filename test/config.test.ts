import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigError, configJsonSchema, DEFAULT_CONFIG } from '../src/config.js';

describe('config parsing', () => {
  it('parses a valid config and applies defaults', () => {
    const cfg = parseConfig('version: 1\nhistory:\n  runs: 50\n', '.cachemap.yml');
    expect(cfg.historyRuns).toBe(50);
    expect(cfg.failOn).toBe(DEFAULT_CONFIG.failOn);
    expect(cfg.cost.linuxPerMinute).toBe(0.008);
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parseConfig('version: 1\nbogus: true\n', '.cachemap.yml')).toThrow(ConfigError);
  });

  it('rejects unknown nested keys', () => {
    expect(() => parseConfig('version: 1\nthresholds:\n  nope: 1\n', '.cachemap.yml')).toThrow(
      ConfigError,
    );
  });

  it('rejects an invalid version', () => {
    expect(() => parseConfig('version: 2\n', '.cachemap.yml')).toThrow(ConfigError);
  });

  it('rejects an empty config', () => {
    expect(() => parseConfig('', '.cachemap.yml')).toThrow(ConfigError);
  });

  it('parses ignore rules and jobs', () => {
    const cfg = parseConfig(
      'version: 1\nignore:\n  rules: [full-checkout]\n  jobs: [release]\n',
      '.cachemap.yml',
    );
    expect(cfg.ignoreRules).toEqual(['full-checkout']);
    expect(cfg.ignoreJobs).toEqual(['release']);
  });

  it('treats cost rates as user estimates (overridable)', () => {
    const cfg = parseConfig('version: 1\ncost:\n  linux-per-minute: 0.01\n', '.cachemap.yml');
    expect(cfg.cost.linuxPerMinute).toBe(0.01);
  });

  it('emits a JSON schema with additionalProperties false', () => {
    const schema = configJsonSchema();
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required'] as string[]).toContain('version');
  });
});
