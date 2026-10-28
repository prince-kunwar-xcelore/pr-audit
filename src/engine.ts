import type { BatchResult } from './types.js';
import { ClaudeCliEngine } from './engines/claude-cli.js';
import { CodexCliEngine } from './engines/codex-cli.js';

export interface ReviewEngine {
  readonly name: string;
  readonly defaultModel: string;

  review(prompt: string, model: string): BatchResult;
  synthesize(prompt: string, model: string): string;
}

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
// Transient rate limits (HTTP 429) are deliberately not matched — those are worth retrying.
const USAGE_LIMIT = /usage limit|hit your (?:usage )?limit/i;

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

export function resolveEngine(name: string, authToken = ''): ReviewEngine {
  switch (name) {
    case 'claude-cli':
      return new ClaudeCliEngine(authToken);
    case 'codex-cli':
      return new CodexCliEngine(authToken);
    default:
      throw new Error(`Unsupported engine: "${name}". Supported: claude-cli, codex-cli`);
  }
}
