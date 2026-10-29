import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './setup.js';
import { readAuthToken, redactArgs } from '../src/auth-token.js';

describe('readAuthToken', () => {
  const dirs: string[] = [];
  function tokenFile(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-test-'));
    dirs.push(dir);
    const file = path.join(dir, 'token');
    fs.writeFileSync(file, content);
    return file;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('returns empty when no source is given', () => {
    expect(readAuthToken(['o/r#1'], {})).toBe('');
  });

  it('reads --auth-token, --auth-token-file and the env var', () => {
    expect(readAuthToken(['o/r#1', '--auth-token', 'tok'], {})).toBe('tok');
    expect(readAuthToken(['o/r#1', '--auth-token-file', tokenFile('{"a":1}\n')], {})).toBe('{"a":1}');
    expect(readAuthToken(['o/r#1'], { PR_AUDIT_AUTH_TOKEN: 'env-tok' })).toBe('env-tok');
  });

  it('prefers flags over the env var', () => {
    expect(readAuthToken(['--auth-token', 'flag'], { PR_AUDIT_AUTH_TOKEN: 'env' })).toBe('flag');
  });

  it('refuses empty or missing values', () => {
    expect(() => readAuthToken(['--auth-token', ''], {})).toThrow('--auth-token is empty');
    expect(() => readAuthToken(['--auth-token'], {})).toThrow('--auth-token needs a value');
    expect(() => readAuthToken(['--auth-token', '--dry-run'], {})).toThrow('--auth-token needs a value');
    expect(() => readAuthToken(['--auth-token-file', tokenFile(' \n')], {})).toThrow(/is empty/);
    expect(() => readAuthToken(['--auth-token-file', '/nonexistent/token'], {})).toThrow(/Cannot read --auth-token-file/);
    expect(() => readAuthToken([], { PR_AUDIT_AUTH_TOKEN: '' })).toThrow('$PR_AUDIT_AUTH_TOKEN is set but empty');
  });

  it('refuses both flags at once', () => {
    expect(() => readAuthToken(['--auth-token', 'a', '--auth-token-file', 'b'], {})).toThrow(/not both/);
  });
});

describe('redactArgs', () => {
  it('hides the --auth-token value in both forms', () => {
    expect(redactArgs(['node', 'pr-audit', 'o/r#1', '--auth-token', '{"secret":1}', '--dry-run'])).toEqual([
      'node', 'pr-audit', 'o/r#1', '--auth-token', '***', '--dry-run',
    ]);
    expect(redactArgs(['o/r#1', '--auth-token={"secret":1}'])).toEqual(['o/r#1', '--auth-token=***']);
  });

  it('leaves a token file path visible', () => {
    expect(redactArgs(['--auth-token-file', '/tmp/t'])).toEqual(['--auth-token-file', '/tmp/t']);
  });
});
