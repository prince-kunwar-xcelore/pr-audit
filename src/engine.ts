import type { SessionUsage } from './types.js';
import { ClaudeCliEngine } from './engines/claude-cli.js';
import { CodexCliEngine } from './engines/codex-cli.js';

/** One agent session: the engine works in `cwd` and answers with JSON matching `schema`. */
export interface SessionRequest {
  /** For logs: "review" or "verification". */
  label: string;
  prompt: string;
  schema: object;
  /** The checkout the agent works in. */
  cwd: string;
  model: string;
  timeoutMs: number;
}

export interface SessionResult<T> {
  output: T;
  usage: SessionUsage;
}

export interface ReviewEngine {
  readonly name: string;
  readonly defaultModel: string;
  /** Reasoning effort used for every session. */
  readonly effort: string;

  run<T>(req: SessionRequest): SessionResult<T>;
}

/** The session ran past its time limit. Not retried: a second run would likely time out too. */
export class SessionTimeoutError extends Error {
  constructor(readonly label: string, readonly timeoutMs: number) {
    super(`${label} session timed out after ${Math.round(timeoutMs / 60000)} min`);
    this.name = 'SessionTimeoutError';
  }
}

/** True when an execFileSync failure was its timeout firing. */
export function isTimeout(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & { signal?: string };
  return e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM';
}

// Passed through to the agent CLI; everything else (GH_TOKEN, CI secrets, the auth-token
// file path, …) is dropped: the agent reads attacker-influenced text (ADR 0002)
const ENV_ALLOW = /^(PATH|HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TZ|TMPDIR|LC_\w+|XDG_\w+|(?:HTTPS?|NO|ALL)_PROXY|(?:https?|no|all)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_(?:FILE|DIR))$/;

/** The agent CLI's environment: the allowlisted host variables plus `extra`. */
export function engineEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (ENV_ALLOW.test(k)) env[k] = v;
  return { ...env, ...extra };
}

/** Read-only git subcommands the agent may run (search is the engine's own tool, not `git grep -O<cmd>`). */
export const READ_ONLY_GIT = ['diff', 'log', 'show', 'blame', 'ls-files', 'merge-base', 'rev-parse'];

/**
 * Flags that turn those subcommands into writes, command execution or reads outside the
 * checkout: `--output=<file>`, `-O`/`--open-files-in-pager`, `--no-index` and `blame --contents`
 * (any file on disk, e.g. the engine's credentials), external diff drivers.
 */
export const GIT_DENIED_FLAGS = ['--output', '-O', '--open-files-in-pager', '--no-index', '--contents', '--ext-diff'];

/**
 * The agent's subscription is out of quota. Retrying won't help until it
 * resets, so callers skip the review instead of failing it.
 */
export class UsageLimitError extends Error {
  constructor(
    readonly engine: string,
    readonly detail: string,
    /** When the limit resets, as stated by the provider (e.g. "5:31 PM"), if given. */
    readonly resetsAt: string | null,
  ) {
    super(`${engine} usage limit reached${resetsAt ? ` — resets ${resetsAt}` : ''}`);
    this.name = 'UsageLimitError';
  }
}

// Subscription quota messages, e.g.
//   Codex:  "You've hit your usage limit. ... try again at 5:31 PM."
//   Claude: "Claude AI usage limit reached|<epoch>" / "You've hit your limit · resets 3pm"
//           / "You've hit your 5-hour limit · resets 8:10am (UTC)" (also weekly variants)
// Transient rate limits (HTTP 429) are deliberately not matched — those are worth retrying.
const USAGE_LIMIT = /usage limit|hit your (?:usage |\d+-hour |daily |weekly |monthly )?limit/i;

/** Return a UsageLimitError if `output` is a subscription-quota message, else null. */
export function detectUsageLimit(engine: string, output: string): UsageLimitError | null {
  const line = output.split('\n').find((l) => USAGE_LIMIT.test(l));
  if (!line) return null;

  let resetsAt: string | null = null;
  const tryAgain = /(?:try again at|resets(?: at)?)\s+([^.·"|\n]+?)(?:[.·"|]|$)/i.exec(line);
  const epoch = /usage limit reached\|(\d{10})/i.exec(line);
  if (tryAgain) resetsAt = tryAgain[1].trim();
  else if (epoch) resetsAt = new Date(Number(epoch[1]) * 1000).toISOString();

  return new UsageLimitError(engine, line.trim().slice(0, 300), resetsAt);
}

/**
 * The agent CLI's credentials are missing, expired or rejected. Retrying won't
 * help; the login has to be refreshed where the credentials come from.
 */
export class AgentAuthError extends Error {
  constructor(
    readonly engine: string,
    readonly detail: string,
    /** The agent CLI to run once on the credentials' machine to refresh its login. */
    readonly cli: string,
  ) {
    super(
      `${engine} authentication failed: ${detail} — refresh the login on the machine the credentials ` +
      `come from (run \`${cli}\` there once), or check the auth token`,
    );
    this.name = 'AgentAuthError';
  }
}

// Credential failures, e.g.
//   Claude: "Not logged in · Please run /login", "Failed to authenticate: OAuth session expired and could not be refreshed"
//   Codex:  "workspace routing discovery unauthorized (401)", "Failed to refresh token status=401 Unauthorized"
const AUTH_ERROR =
  /not logged in|please run \/login|failed to authenticate|oauth (?:token|session) (?:has )?expired|invalid api key|authentication_error|unauthorized \(401\)|401 unauthorized|failed to refresh token|try signing in again/i;

/** Return an AgentAuthError if `output` is a credentials failure, else null. */
export function detectAuthError(engine: string, cli: string, output: string): AgentAuthError | null {
  const line = output.split('\n').find((l) => AUTH_ERROR.test(l));
  if (!line) return null;
  return new AgentAuthError(engine, line.trim().slice(0, 200), cli);
}

export const DEFAULT_EFFORT = 'medium';

/** Effort levels each engine's CLI accepts (Claude: `claude --effort`; Codex: gpt-6.1 models). */
export const ENGINE_EFFORTS: Record<string, readonly string[]> = {
  'claude-cli': ['low', 'medium', 'high', 'xhigh', 'max'],
  'codex-cli': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

export function resolveEngine(name: string, authToken = '', effort = DEFAULT_EFFORT): ReviewEngine {
  const efforts = ENGINE_EFFORTS[name];
  if (efforts && !efforts.includes(effort)) {
    throw new Error(`Unsupported effort "${effort}" for ${name}. Supported: ${efforts.join(', ')}`);
  }
  switch (name) {
    case 'claude-cli':
      return new ClaudeCliEngine(authToken, effort);
    case 'codex-cli':
      return new CodexCliEngine(authToken, effort);
    default:
      throw new Error(`Unsupported engine: "${name}". Supported: claude-cli, codex-cli`);
  }
}
