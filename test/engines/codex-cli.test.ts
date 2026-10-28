import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'child_process';
import { CodexCliEngine } from '../../src/engines/codex-cli.js';
import { UsageLimitError } from '../../src/engine.js';

const mockExec = vi.mocked(execFileSync);

const REVIEW = {
  summary: 'Looks risky.',
  verdict: 'REQUEST_CHANGES',
  comments: [{ path: 'a.ts', line: 3, severity: 'critical', body: 'SQL injection' }],
};

function events(text: string): string {
  return [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } },
  ].map((e) => JSON.stringify(e)).join('\n');
}

describe('CodexCliEngine', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('runs codex exec with a strict output schema and parses the review', () => {
    let schema: Record<string, unknown> | undefined;
    mockExec.mockImplementation(((_cmd: string, args: string[]) => {
      schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
      return events(JSON.stringify(REVIEW));
    }) as typeof execFileSync);

    const result = new CodexCliEngine().review('prompt', 'gpt-test');

    const [cmd, args, opts] = mockExec.mock.calls[0] as [string, string[], { input: string; env: NodeJS.ProcessEnv }];
    expect(cmd).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '--model', 'gpt-test', '--json', '--sandbox', 'read-only']));
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"');
    expect(opts.input).toBe('prompt');
    expect(opts.env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect(schema?.additionalProperties).toBe(false);
    expect((schema?.properties as any).comments.items.additionalProperties).toBe(false);

    expect(result.review).toEqual(REVIEW);
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      costUSD: 0,
    });
  });

  it('writes auth.json into a temp CODEX_HOME when an auth token is given', () => {
    const auth = JSON.stringify({ tokens: { access_token: 'tok' } });
    let written = '';
    let codexHome = '';
    mockExec.mockImplementation(((_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      codexHome = opts.env.CODEX_HOME!;
      written = fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8');
      return events(JSON.stringify(REVIEW));
    }) as typeof execFileSync);

    new CodexCliEngine(auth).review('prompt', 'gpt-test');

    expect(written).toBe(auth);
    expect(fs.existsSync(codexHome)).toBe(false);
  });

  it('wraps a bare API key as OPENAI_API_KEY', () => {
    let written = '';
    mockExec.mockImplementation(((_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      written = fs.readFileSync(path.join(opts.env.CODEX_HOME!, 'auth.json'), 'utf8');
      return events(JSON.stringify(REVIEW));
    }) as typeof execFileSync);

    new CodexCliEngine('sk-test').review('prompt', 'gpt-test');

    expect(JSON.parse(written)).toEqual({ OPENAI_API_KEY: 'sk-test' });
  });

  it('throws when the turn fails', () => {
    mockExec.mockReturnValue(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }));
    expect(() => new CodexCliEngine().review('prompt', 'gpt-test')).toThrow('quota exceeded');
  });

  it('synthesize returns the last agent message without a schema', () => {
    mockExec.mockReturnValue(events('  Combined summary.  '));

    expect(new CodexCliEngine().synthesize('prompt', 'gpt-test')).toBe('Combined summary.');
    const args = mockExec.mock.calls[0][1] as string[];
    expect(args).not.toContain('--output-schema');
  });

  it('throws UsageLimitError when codex exits with a usage-limit turn failure', () => {
    mockExec.mockImplementation(() => {
      const err = new Error('Command failed') as Error & { stdout: string; stderr: string };
      err.stdout = JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at 5:31 PM." } });
      err.stderr = '';
      throw err;
    });
    expect(() => new CodexCliEngine().review('prompt', 'gpt-test')).toThrow(UsageLimitError);
  });

  it('rejects JSON auth without tokens or an API key, and still cleans up its temp dir', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('codex-review-')).length;
    expect(() => new CodexCliEngine('{"something":"else"}').review('prompt', 'gpt-test')).toThrow(/neither tokens.access_token/);
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('codex-review-')).length;
    expect(after).toBe(before);
    expect(mockExec).not.toHaveBeenCalled();
  });
});
