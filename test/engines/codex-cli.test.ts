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
import { AgentAuthError, SessionTimeoutError, UsageLimitError, type SessionRequest } from '../../src/engine.js';
import { REVIEW_SCHEMA } from '../../src/prompt.js';

const mockExec = vi.mocked(execFileSync);

const REVIEW = {
  summary: 'Looks risky.',
  findings: [{ path: 'a.ts', line: 3, severity: 'critical', kind: 'security', body: 'SQL injection' }],
  follow_ups: [],
};

const CHECKOUT = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-'));
const req = (over: Partial<SessionRequest> = {}): SessionRequest => ({
  label: 'review',
  prompt: 'prompt',
  schema: REVIEW_SCHEMA,
  cwd: CHECKOUT,
  model: 'gpt-test',
  timeoutMs: 60_000,
  ...over,
});

function events(text: string): string {
  return [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } },
  ].map((e) => JSON.stringify(e)).join('\n');
}

/** Calls to `codex exec` (the first call of an engine is the `codex sandbox` preflight). */
const execCalls = () => mockExec.mock.calls.filter((c) => (c[1] as string[])[0] === 'exec');

describe('CodexCliEngine', () => {
  beforeEach(() => {
    mockExec.mockReset();
    vi.restoreAllMocks();
    // The sandbox preflight has its own tests below
    vi.spyOn(CodexCliEngine.prototype as unknown as { checkSandbox(): void }, 'checkSandbox').mockImplementation(() => {});
  });

  it('runs codex exec with a strict output schema and parses the review', () => {
    let schema: Record<string, unknown> | undefined;
    mockExec.mockImplementation(((_cmd: string, args: string[]) => {
      schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
      return events(JSON.stringify(REVIEW));
    }) as typeof execFileSync);

    const result = new CodexCliEngine().run(req());

    const [cmd, args, opts] = execCalls()[0] as [string, string[], { input: string; env: NodeJS.ProcessEnv; timeout: number }];
    expect(cmd).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '--model', 'gpt-test', '--json', '--sandbox', 'read-only']));
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"');
    expect(args).toEqual(expect.arrayContaining(['-c', 'web_search="live"', '-c', 'project_doc_max_bytes=0']));
    expect(args[args.indexOf('--cd') + 1]).toBe(CHECKOUT);
    expect(opts.input).toBe('prompt');
    expect(opts.timeout).toBe(60_000);
    expect(schema?.additionalProperties).toBe(false);
    expect((schema?.properties as any).findings.items.additionalProperties).toBe(false);
    // the schema file is not written into the checkout
    expect(fs.readdirSync(CHECKOUT)).toEqual([]);

    expect(result.output).toEqual(REVIEW);
    expect(result.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      costUSD: null,
    });
  });

  it('keeps secrets out of the agent environment', () => {
    process.env.GH_TOKEN = 'ghp_secret';
    process.env.PR_AUDIT_AUTH_TOKEN = 'tok';
    try {
      mockExec.mockReturnValue(events(JSON.stringify(REVIEW)));
      new CodexCliEngine().run(req());
      const env = (execCalls()[0][2] as { env: NodeJS.ProcessEnv }).env;
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.PR_AUDIT_AUTH_TOKEN).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.PR_AUDIT_AUTH_TOKEN;
    }
  });

  it('turns a timeout into SessionTimeoutError', () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync codex ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });
    expect(() => new CodexCliEngine().run(req())).toThrow(SessionTimeoutError);
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

    new CodexCliEngine(auth).run(req());

    expect(written).toBe(auth);
    expect(fs.existsSync(codexHome)).toBe(false);
    // auth.json must not be inside the checkout the agent works in
    expect(path.relative(CHECKOUT, codexHome).startsWith('..')).toBe(true);
  });

  it('wraps a bare API key as OPENAI_API_KEY', () => {
    let written = '';
    mockExec.mockImplementation(((_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      written = fs.readFileSync(path.join(opts.env.CODEX_HOME!, 'auth.json'), 'utf8');
      return events(JSON.stringify(REVIEW));
    }) as typeof execFileSync);

    new CodexCliEngine('sk-test').run(req());

    expect(JSON.parse(written)).toEqual({ OPENAI_API_KEY: 'sk-test' });
  });

  it('ignores non-fatal error events when the turn completes', () => {
    mockExec.mockReturnValue(
      JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }) + '\n' + events(JSON.stringify(REVIEW)),
    );
    expect(new CodexCliEngine().run(req()).output).toEqual(REVIEW);
  });

  it('throws when the turn fails', () => {
    mockExec.mockReturnValue(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }));
    expect(() => new CodexCliEngine().run(req())).toThrow('quota exceeded');
  });

  it('throws UsageLimitError when codex exits with a usage-limit turn failure', () => {
    mockExec.mockImplementation(() => {
      const err = new Error('Command failed') as Error & { stdout: string; stderr: string };
      err.stdout = JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at 5:31 PM." } });
      err.stderr = '';
      throw err;
    });
    expect(() => new CodexCliEngine().run(req())).toThrow(UsageLimitError);
  });

  it('throws AgentAuthError when codex exits on a 401', () => {
    mockExec.mockImplementation(() => {
      const err = new Error('Command failed') as Error & { stdout: string; stderr: string };
      err.stdout = [
        { type: 'error', message: 'Reconnecting... 1/5 (workspace routing discovery unauthorized (401))' },
        { type: 'turn.failed', error: { message: 'workspace routing discovery unauthorized (401)' } },
      ].map((e) => JSON.stringify(e)).join('\n');
      err.stderr = '';
      throw err;
    });
    expect(() => new CodexCliEngine().run(req())).toThrow(AgentAuthError);
    expect(() => new CodexCliEngine().run(req())).toThrow(/failed: workspace routing discovery unauthorized \(401\) —/);
  });

  it('does not treat a usage-limit or auth phrase in an agent message as a failure reason', () => {
    mockExec.mockImplementation(() => {
      const err = new Error('Command failed') as Error & { stdout: string; stderr: string };
      err.stdout = [
        { type: 'item.completed', item: { type: 'agent_message', text: 'This diff handles "Not logged in" and "usage limit reached"' } },
        { type: 'turn.failed', error: { message: 'stream disconnected before completion' } },
      ].map((e) => JSON.stringify(e)).join('\n');
      err.stderr = '';
      throw err;
    });
    expect(() => new CodexCliEngine().run(req())).toThrow('Codex returned an error: stream disconnected before completion');
  });

  it('fails with the fix when the sandbox cannot start, without running a session', () => {
    vi.restoreAllMocks();
    mockExec.mockImplementation(((_c: string, args: string[]) => {
      if (args[0] === 'sandbox') throw Object.assign(new Error('Command failed'), { stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n' });
      return events(JSON.stringify(REVIEW));
    }) as typeof execFileSync);
    expect(() => new CodexCliEngine().run(req())).toThrow(/bwrap: loopback[\s\S]*apparmor_restrict_unprivileged_userns=0/);
    expect(execCalls()).toHaveLength(0);
  });

  it('checks the sandbox once per engine', () => {
    vi.restoreAllMocks();
    mockExec.mockReturnValue(events(JSON.stringify(REVIEW)));
    const engine = new CodexCliEngine();
    engine.run(req());
    engine.run(req({ label: 'verification' }));
    expect(mockExec.mock.calls.filter((c) => (c[1] as string[])[0] === 'sandbox')).toHaveLength(1);
  });

  it('rejects JSON auth without tokens or an API key up front, before creating temp dirs', () => {
    const mkdtemp = vi.spyOn(fs, 'mkdtempSync');
    expect(() => new CodexCliEngine('{"something":"else"}')).toThrow(/neither tokens.access_token/);
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    mkdtemp.mockRestore();
  });
});
