import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { ClaudeCliEngine } from '../../src/engines/claude-cli.js';
import { AgentAuthError, type SessionRequest } from '../../src/engine.js';
import { REVIEW_SCHEMA } from '../../src/prompt.js';

const req: SessionRequest = { label: 'review', prompt: 'prompt', schema: REVIEW_SCHEMA, cwd: '/tmp', model: 'm', timeoutMs: 60_000 };

const mockExec = vi.mocked(execFileSync);

function failWith(stdout: string, stderr = ''): void {
  mockExec.mockImplementation(() => {
    throw Object.assign(new Error('Command failed: claude -p'), { stdout, stderr });
  });
}

describe('ClaudeCliEngine failures', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('reads the reason from an error envelope', () => {
    failWith(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }));
    expect(() => new ClaudeCliEngine().run(req)).toThrow(AgentAuthError);
  });

  it('ignores the result of a non-error envelope, which can quote the diff', () => {
    failWith(JSON.stringify({ is_error: false, result: 'The diff handles "Not logged in" and "usage limit reached"' }));
    expect(() => new ClaudeCliEngine().run(req)).toThrow('Command failed: claude -p');
  });

  it('falls back to raw output when stdout is not an envelope', () => {
    failWith('', 'Invalid API key · Please run /login');
    expect(() => new ClaudeCliEngine().run(req)).toThrow(AgentAuthError);
  });
});

describe('ClaudeCliEngine sessions', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  const envelope = (output: unknown) =>
    JSON.stringify({
      type: 'result',
      is_error: false,
      result: '',
      structured_output: output,
      total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    });

  it('runs a restricted, read-only session in the checkout and returns the structured output', () => {
    mockExec.mockReturnValue(envelope({ summary: 's', findings: [], follow_ups: [] }));
    const result = new ClaudeCliEngine().run(req);

    const [cmd, args, opts] = mockExec.mock.calls[0] as [string, string[], { cwd: string; input: string; timeout: number }];
    expect(cmd).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['-p', '--restricted', '--safe-mode', '--strict-mcp-config']));
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash,WebFetch,WebSearch');
    const allowed = args.slice(args.indexOf('--allowedTools') + 1);
    expect(allowed).toEqual(expect.arrayContaining(['Read', 'WebFetch', 'Bash(git diff:*)', 'Bash(git show:*)']));
    expect(allowed.some((t) => /Bash\((?!git )/.test(t) || t === 'Bash' || t === 'Edit' || t === 'Write')).toBe(false);
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1])).toEqual(REVIEW_SCHEMA);
    expect(opts.cwd).toBe('/tmp');
    expect(opts.input).toBe('prompt');
    expect(opts.timeout).toBe(60_000);

    expect(result.output).toEqual({ summary: 's', findings: [], follow_ups: [] });
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, costUSD: 0.12 });
  });

  it('puts credentials in a temp HOME outside the checkout and strips other secrets', () => {
    process.env.GH_TOKEN = 'ghp_secret';
    let home = '';
    mockExec.mockImplementation(((_c: string, _a: string[], opts: { env: NodeJS.ProcessEnv }) => {
      home = opts.env.HOME!;
      expect(opts.env.GH_TOKEN).toBeUndefined();
      return envelope({ summary: 's', findings: [], follow_ups: [] });
    }) as typeof execFileSync);
    try {
      new ClaudeCliEngine('sk-ant-oat-token').run(req);
    } finally {
      delete process.env.GH_TOKEN;
    }
    expect(home).not.toBe(process.env.HOME);
    expect(home.startsWith('/tmp')).toBe(true);
  });
});
