import { execSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectUsageLimit, type ReviewEngine } from '../engine.js';
import type { ReviewOutput, TokenUsage, BatchResult } from '../types.js';
import { OUTPUT_SCHEMA } from '../claude.js';
import { log } from '../logger.js';

interface ClaudeEnvelope {
  type: string;
  is_error: boolean;
  result: string;
  structured_output?: ReviewOutput;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
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
  readonly defaultModel = 'claude-sonnet-4-6';

  constructor(private authToken = '') {}

  private buildEnv(): { env: NodeJS.ProcessEnv; tempHome: string | null } {
    if (!this.authToken) return { env: process.env, tempHome: null };
    const tempHome = makeTempHome(this.authToken);
    return { env: { ...process.env, HOME: tempHome }, tempHome };
  }

  private cleanupTempHome(tempHome: string | null): void {
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  }

  review(prompt: string, model: string): BatchResult {
    log.debug(`Claude prompt:\n${prompt}`);

    const { env, tempHome } = this.buildEnv();
    let raw: string;
    try {
      raw = execSync(
        `claude -p --model ${model} --output-format json --json-schema '${OUTPUT_SCHEMA}'`,
        {
          input: prompt,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
          env,
        },
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const limit = detectUsageLimit(this.name, `${e.stdout ?? ''}\n${e.stderr ?? ''}`);
      if (limit) throw limit;
      log.error(`claude CLI error: ${e.message}`);
      if (e.stderr) log.error(`stderr: ${e.stderr.trim()}`);
      if (e.stdout) log.error(`stdout: ${e.stdout.trim()}`);
      throw err;
    } finally {
      this.cleanupTempHome(tempHome);
    }

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
      const limit = detectUsageLimit(this.name, envelope.result);
      if (limit) throw limit;
      throw new Error(`Claude returned an error: ${envelope.result}`);
    }

    let review: ReviewOutput;
    if (envelope.structured_output) {
      review = envelope.structured_output;
    } else {
      try {
        review = JSON.parse(envelope.result) as ReviewOutput;
      } catch {
        log.error('[error] Claude result is not valid JSON:');
        log.error(envelope.result.slice(0, 500));
        throw new Error('Failed to parse Claude review JSON');
      }
    }

    log.debug(`Claude parsed ${review.comments.length} comment(s), verdict: ${review.verdict}`);
    for (const c of review.comments) {
      log.debug(`  [${c.severity}] ${c.path}:${c.line} — ${c.body}`);
    }

    const usage: TokenUsage = {
      inputTokens: envelope.usage.input_tokens,
      outputTokens: envelope.usage.output_tokens,
      cacheReadTokens: envelope.usage.cache_read_input_tokens,
      cacheCreationTokens: envelope.usage.cache_creation_input_tokens,
      costUSD: envelope.total_cost_usd,
    };

    return { review, usage };
  }

  synthesize(prompt: string, model: string): string {
    log.debug(`Synthesis prompt:\n${prompt}`);

    const { env, tempHome } = this.buildEnv();
    let raw: string;
    try {
      raw = execSync(`claude -p --model ${model}`, {
        input: prompt,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        timeout: 2 * 60 * 1000,
        env,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const limit = detectUsageLimit(this.name, `${e.stdout ?? ''}\n${e.stderr ?? ''}`);
      if (limit) throw limit;
      log.error(`claude CLI error (synthesis): ${e.message}`);
      if (e.stderr) log.error(`stderr: ${e.stderr.trim()}`);
      throw err;
    } finally {
      this.cleanupTempHome(tempHome);
    }

    const summary = raw.trim();
    log.debug(`Synthesized summary:\n${summary}`);
    return summary;
  }
}
