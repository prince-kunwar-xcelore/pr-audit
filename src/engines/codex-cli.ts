import { execFileSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectUsageLimit, type ReviewEngine } from '../engine.js';
import type { ReviewOutput, TokenUsage, BatchResult } from '../types.js';
import { OUTPUT_SCHEMA } from '../claude.js';
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
function strictSchema(schema: unknown): unknown {
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

export class CodexCliEngine implements ReviewEngine {
  readonly name = 'Codex CLI';
  readonly defaultModel = 'gpt-6.1-sol';

  constructor(private authToken = '') {}

  private run(prompt: string, model: string, schema: string | null, timeout: number): CodexEvent[] {
    // Empty, read-only working dir: the diff is in the prompt, the agent has nothing to explore.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-'));
    let raw: string;
    try {
      const args = [
        'exec',
        '--model', model,
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--sandbox', 'read-only',
        '--cd', workDir,
      ];
      if (schema) {
        const schemaPath = path.join(workDir, 'schema.json');
        fs.writeFileSync(schemaPath, JSON.stringify(strictSchema(JSON.parse(schema))));
        args.push('--output-schema', schemaPath);
      }
      args.push('-');

      const env = { ...process.env };
      if (this.authToken) {
        const codexHome = path.join(workDir, '.codex');
        fs.mkdirSync(codexHome, { mode: 0o700 });
        fs.writeFileSync(path.join(codexHome, 'auth.json'), authJson(this.authToken), { mode: 0o600 });
        env.CODEX_HOME = codexHome;
      }

      raw = execFileSync('codex', args, {
        input: prompt,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        timeout,
        env,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      // codex exits non-zero when the turn fails; the reason is in its JSON events
      const limit = detectUsageLimit(this.name, `${e.stdout ?? ''}\n${e.stderr ?? ''}`);
      if (limit) throw limit;
      log.error(`codex CLI error: ${e.message}`);
      if (e.stderr) log.error(`stderr: ${e.stderr.trim()}`);
      if (e.stdout) log.error(`stdout: ${e.stdout.trim()}`);
      throw err;
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    log.debug(`Codex raw events:\n${raw.trim()}`);

    const events: CodexEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as CodexEvent);
      } catch {
        // codex may interleave non-JSON diagnostics; ignore them
      }
    }

    const failure = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
    if (failure) {
      const limit = detectUsageLimit(this.name, failure.error?.message ?? failure.message ?? '');
      if (limit) throw limit;
      throw new Error(`Codex returned an error: ${failure.error?.message ?? failure.message ?? 'unknown'}`);
    }
    return events;
  }

  private lastMessage(events: CodexEvent[]): string {
    const messages = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
    const text = messages.at(-1)?.item?.text;
    if (text === undefined) throw new Error('Codex produced no agent message');
    return text;
  }

  review(prompt: string, model: string): BatchResult {
    log.debug(`Codex prompt:\n${prompt}`);

    const events = this.run(prompt, model, OUTPUT_SCHEMA, 5 * 60 * 1000);
    const text = this.lastMessage(events);

    let review: ReviewOutput;
    try {
      review = JSON.parse(text) as ReviewOutput;
    } catch {
      log.error('[error] Codex result is not valid JSON:');
      log.error(text.slice(0, 500));
      throw new Error('Failed to parse Codex review JSON');
    }

    log.debug(`Codex parsed ${review.comments.length} comment(s), verdict: ${review.verdict}`);
    for (const c of review.comments) {
      log.debug(`  [${c.severity}] ${c.path}:${c.line} — ${c.body}`);
    }

    const turnUsage = events.find((e) => e.type === 'turn.completed')?.usage;
    // Subscription usage has no per-call price, so costUSD stays 0.
    const usage: TokenUsage = {
      inputTokens: turnUsage?.input_tokens ?? 0,
      outputTokens: turnUsage?.output_tokens ?? 0,
      cacheReadTokens: turnUsage?.cached_input_tokens ?? 0,
      cacheCreationTokens: 0,
      costUSD: 0,
    };

    return { review, usage };
  }

  synthesize(prompt: string, model: string): string {
    log.debug(`Synthesis prompt:\n${prompt}`);

    const summary = this.lastMessage(this.run(prompt, model, null, 2 * 60 * 1000)).trim();
    log.debug(`Synthesized summary:\n${summary}`);
    return summary;
  }
}
