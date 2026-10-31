import { execFileSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectAuthError,
  detectUsageLimit,
  engineEnv,
  isTimeout,
  SessionTimeoutError,
  type ReviewEngine,
  type SessionRequest,
  type SessionResult,
} from '../engine.js';
import type { SessionUsage } from '../types.js';
import { log } from '../logger.js';

interface CodexEvent {
  type: string;
  item?: { type: string; text?: string };
  usage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
  message?: string;
  error?: { message: string };
}

// OpenAI structured outputs require every object to declare additionalProperties: false
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = strictSchema(v);
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

// Accepts either the full contents of ~/.codex/auth.json (ChatGPT subscription login)
// or a bare OpenAI API key.
function authJson(credentialsOrKey: string): string {
  let parsed: { tokens?: { access_token?: string }; OPENAI_API_KEY?: string | null };
  try {
    parsed = JSON.parse(credentialsOrKey);
  } catch {
    // not JSON — treat as an API key
    return JSON.stringify({ OPENAI_API_KEY: credentialsOrKey });
  }
  if (parsed?.tokens?.access_token || parsed?.OPENAI_API_KEY) return credentialsOrKey;
  throw new Error('Codex auth token is JSON but has neither tokens.access_token nor OPENAI_API_KEY');
}

function parseEvents(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as CodexEvent);
    } catch {
      // codex may interleave non-JSON diagnostics; ignore them
    }
  }
  return events;
}

function eventMessage(event: CodexEvent): string {
  return event.error?.message ?? event.message ?? 'unknown';
}

// The failure reasons in codex's output: the `turn.failed` message first, then `error` events,
// then stderr. Other events are skipped — they can echo the prompt (the diff under review).
function failureText(stdout = '', stderr = ''): string {
  const events = parseEvents(stdout);
  const failed = events.filter((e) => e.type === 'turn.failed').map(eventMessage);
  const errors = events.filter((e) => e.type === 'error').map(eventMessage);
  return [...failed, ...errors, stderr].join('\n');
}

/** The environment can't run Codex's sandbox. Not retried: it won't fix itself. */
export class CodexSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSandboxError';
  }
}

export class CodexCliEngine implements ReviewEngine {
  readonly name = 'Codex CLI';
  readonly defaultModel = 'gpt-6.1-sol';

  // Effort is always passed explicitly: user config is ignored, and the model's own default is low
  private readonly auth: string | null;

  constructor(authToken = '', readonly effort = 'medium') {
    // Validated once here: a malformed token is deterministic, not worth the review retries
    this.auth = authToken ? authJson(authToken) : null;
  }

  // Neither is worth retrying
  private throwIfQuotaOrAuth(output: string): void {
    const err = detectUsageLimit(this.name, output) ?? detectAuthError(this.name, 'codex', output);
    if (err) throw err;
  }

  private sandboxChecked = false;

  /**
   * Codex reads files only through shell commands in its sandbox. Where the sandbox can't start
   * (e.g. Ubuntu 24.04 GitHub runners restrict unprivileged user namespaces, so bubblewrap fails)
   * the agent reviews blind; fail with the fix instead.
   */
  private checkSandbox(cwd: string): void {
    if (this.sandboxChecked) return;
    try {
      execFileSync('codex', ['sandbox', '--', 'true'], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, env: engineEnv() });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; status?: number | null };
      // Only a sandbox that ran and failed is a sandbox problem; a missing codex or a hang is not
      if (typeof e.status !== 'number' || isTimeout(e)) throw err;
      const why = (e.stderr?.trim() || e.message).split('\n')[0];
      throw new CodexSandboxError(
        `Codex's sandbox can't start here (${why}), so the agent couldn't read the checkout. ` +
          'On GitHub Actions Ubuntu runners, run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` before pr-audit.',
      );
    }
    this.sandboxChecked = true;
  }

  run<T>(req: SessionRequest): SessionResult<T> {
    log.debug(`Codex ${req.label} prompt:\n${req.prompt}`);
    this.checkSandbox(req.cwd);

    // Schema and credentials live outside the checkout. The read-only sandbox can still read
    // them (no path rules), an accepted risk (ADR 0002)
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-'));
    const codexHome = this.auth ? fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-')) : null;
    const started = Date.now();
    let raw: string;
    try {
      const schemaPath = path.join(scratch, 'schema.json');
      fs.writeFileSync(schemaPath, JSON.stringify(strictSchema(req.schema)));
      const args = [
        'exec',
        '--model', req.model,
        '-c', `model_reasoning_effort="${this.effort}"`,
        // Network only through the web search / open-page tool; shell commands stay offline
        '-c', 'web_search="live"',
        // Don't auto-load the PR's AGENTS.md: repo guidance is read from the base branch
        '-c', 'project_doc_max_bytes=0',
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--sandbox', 'read-only',
        '--cd', req.cwd,
        '--output-schema', schemaPath,
        '-',
      ];

      const extra: Record<string, string> = {};
      if (codexHome) {
        fs.chmodSync(codexHome, 0o700);
        fs.writeFileSync(path.join(codexHome, 'auth.json'), this.auth!, { mode: 0o600 });
        extra.CODEX_HOME = codexHome;
      }

      raw = execFileSync('codex', args, {
        input: req.prompt,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
        timeout: req.timeoutMs,
        env: engineEnv(extra),
      });
    } catch (err) {
      if (isTimeout(err)) throw new SessionTimeoutError(req.label, req.timeoutMs);
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      // codex exits non-zero when the turn fails; the reason is in its JSON events
      this.throwIfQuotaOrAuth(failureText(e.stdout, e.stderr));
      log.error(`codex CLI error: ${e.message}`);
      if (e.stderr) log.error(`stderr: ${e.stderr.trim()}`);
      if (e.stdout) log.error(`stdout: ${e.stdout.trim().slice(0, 2000)}`);
      // Surface the turn's own failure message rather than "Command failed: codex exec …"
      const turnFailure = parseEvents(e.stdout ?? '').find((ev) => ev.type === 'turn.failed');
      if (turnFailure) throw new Error(`Codex returned an error: ${eventMessage(turnFailure)}`);
      throw err;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
      if (codexHome) fs.rmSync(codexHome, { recursive: true, force: true });
    }
    const durationMs = Date.now() - started;

    log.debug(`Codex raw events:\n${raw.trim()}`);

    const events = parseEvents(raw);

    // Only a failed turn is fatal; standalone `error` events can be transient (e.g. a retried stream)
    const failure = events.find((e) => e.type === 'turn.failed');
    if (failure) {
      this.throwIfQuotaOrAuth(eventMessage(failure));
      throw new Error(`Codex returned an error: ${eventMessage(failure)}`);
    }

    const text = this.lastMessage(events);
    let output: T;
    try {
      output = JSON.parse(text) as T;
    } catch {
      log.error('[error] Codex result is not valid JSON:');
      log.error(text.slice(0, 500));
      throw new Error(`Failed to parse Codex ${req.label} JSON`);
    }

    // Usage is summed over turns; subscription usage has no per-call price
    const usage: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: null, durationMs };
    for (const e of events.filter((ev) => ev.type === 'turn.completed' && ev.usage)) {
      usage.inputTokens += e.usage!.input_tokens;
      usage.outputTokens += e.usage!.output_tokens;
      usage.cacheReadTokens += e.usage!.cached_input_tokens;
    }
    return { output, usage };
  }

  private lastMessage(events: CodexEvent[]): string {
    const messages = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
    const text = messages.at(-1)?.item?.text;
    if (text === undefined) {
      const lastError = events.filter((e) => e.type === 'error').at(-1)?.message;
      throw new Error(`Codex produced no agent message${lastError ? ` (last error: ${lastError})` : ''}`);
    }
    return text;
  }
}
