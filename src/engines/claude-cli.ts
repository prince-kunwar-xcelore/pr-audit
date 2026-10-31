import { execFileSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectAuthError,
  detectUsageLimit,
  engineEnv,
  isTimeout,
  READ_ONLY_GIT,
  SessionTimeoutError,
  type ReviewEngine,
  type SessionRequest,
  type SessionResult,
} from '../engine.js';
import type { SessionUsage } from '../types.js';
import { log } from '../logger.js';

interface ClaudeEnvelope {
  type: string;
  is_error: boolean;
  result: string;
  structured_output?: unknown;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

// On failure the JSON envelope carries the reason. A non-error envelope's result is the
// agent's answer (it can quote the diff), so only stderr counts then. Raw stdout is used only
// when it isn't an envelope at all.
function failureText(stdout = '', stderr = ''): string {
  let envelope: Partial<ClaudeEnvelope>;
  try {
    envelope = JSON.parse(stdout.trim()) as Partial<ClaudeEnvelope>;
  } catch {
    return `${stdout}\n${stderr}`;
  }
  return envelope.is_error && envelope.result ? `${envelope.result}\n${stderr}` : stderr;
}

function makeTempHome(credentialsOrToken: string): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });

  let credentialsJson: string;
  try {
    const parsed = JSON.parse(credentialsOrToken);
    if (parsed?.claudeAiOauth?.accessToken) {
      credentialsJson = credentialsOrToken;
    } else {
      credentialsJson = JSON.stringify({
        claudeAiOauth: {
          accessToken: credentialsOrToken,
          expiresAt: Date.now() + 24 * 3600 * 1000,
        },
      });
    }
  } catch {
    credentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: credentialsOrToken,
        expiresAt: Date.now() + 24 * 3600 * 1000,
      },
    });
  }

  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), credentialsJson, {
    mode: 0o600,
  });
  return tempHome;
}

export class ClaudeCliEngine implements ReviewEngine {
  readonly name = 'Claude CLI';
  readonly defaultModel = 'claude-sonnet-5-5';

  constructor(private authToken = '', readonly effort = 'medium') {}

  // Credentials go in a temp HOME outside the checkout; --restricted confines the file tools
  // to the working directory, so the agent can't read them back
  private buildEnv(): { env: NodeJS.ProcessEnv; tempHome: string | null } {
    if (!this.authToken) return { env: engineEnv(), tempHome: null };
    const tempHome = makeTempHome(this.authToken);
    const env = engineEnv({ HOME: tempHome });
    delete env.CLAUDE_CONFIG_DIR; // would point claude away from the temp credentials
    return { env, tempHome };
  }

  // Neither is worth retrying
  private throwIfQuotaOrAuth(output: string): void {
    const err = detectUsageLimit(this.name, output) ?? detectAuthError(this.name, 'claude', output);
    if (err) throw err;
  }

  run<T>(req: SessionRequest): SessionResult<T> {
    log.debug(`Claude ${req.label} prompt:\n${req.prompt}`);

    const args = [
      '-p',
      '--model', req.model,
      '--effort', this.effort,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(req.schema),
      // No project settings, hooks, MCP servers or auto-loaded CLAUDE.md (the PR's copy):
      // repo guidance is read from the base branch as the prompt says
      '--restricted', '--safe-mode', '--strict-mcp-config',
      '--permission-prompts', 'none',
      '--tools', 'Read,Grep,Glob,Bash,WebFetch,WebSearch',
      // Variadic, so last; anything not allowed here is denied
      '--allowedTools', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
      ...READ_ONLY_GIT.map((c) => `Bash(git ${c}:*)`),
    ];

    const { env, tempHome } = this.buildEnv();
    const started = Date.now();
    let raw: string;
    try {
      raw = execFileSync('claude', args, {
        input: req.prompt,
        cwd: req.cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
        timeout: req.timeoutMs,
        env,
      });
    } catch (err) {
      if (isTimeout(err)) throw new SessionTimeoutError(req.label, req.timeoutMs);
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      this.throwIfQuotaOrAuth(failureText(e.stdout, e.stderr));
      log.error(`claude CLI error: ${e.message}`);
      if (e.stderr) log.error(`stderr: ${e.stderr.trim()}`);
      if (e.stdout) log.error(`stdout: ${e.stdout.trim().slice(0, 2000)}`);
      throw err;
    } finally {
      if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
    }
    const durationMs = Date.now() - started;

    log.debug(`Claude raw envelope:\n${raw.trim()}`);

    let envelope: ClaudeEnvelope;
    try {
      envelope = JSON.parse(raw.trim()) as ClaudeEnvelope;
    } catch {
      log.error('[error] Failed to parse claude envelope:');
      log.error(raw.trim().slice(0, 500));
      throw new Error('Failed to parse claude CLI JSON envelope');
    }

    if (envelope.is_error) {
      this.throwIfQuotaOrAuth(envelope.result);
      throw new Error(`Claude returned an error: ${envelope.result}`);
    }

    let output: T;
    if (envelope.structured_output) {
      output = envelope.structured_output as T;
    } else {
      try {
        output = JSON.parse(envelope.result) as T;
      } catch {
        log.error('[error] Claude result is not valid JSON:');
        log.error(envelope.result.slice(0, 500));
        throw new Error(`Failed to parse Claude ${req.label} JSON`);
      }
    }

    const usage: SessionUsage = {
      inputTokens: envelope.usage.input_tokens,
      outputTokens: envelope.usage.output_tokens,
      cacheReadTokens: envelope.usage.cache_read_input_tokens,
      cacheCreationTokens: envelope.usage.cache_creation_input_tokens,
      costUSD: envelope.total_cost_usd,
      durationMs,
    };
    return { output, usage };
  }
}
