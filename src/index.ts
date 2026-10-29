#!/usr/bin/env node
import process from 'node:process';
import { resolveProvider, type GitProvider } from './provider.js';
import type { PrRef, ReviewOutput, TokenUsage } from './types.js';
import fs from 'node:fs';
import { resolveEngine, UsageLimitError, DEFAULT_EFFORT, ENGINE_EFFORTS } from './engine.js';
import { parseDiffString, chunkFiles, validateComments } from './diff.js';
import { buildPrompt, buildSynthesisPrompt, mergeResults } from './claude.js';
import { initLogger, log } from './logger.js';
import { readAuthToken, redactArgs, AUTH_TOKEN_ENV } from './auth-token.js';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => T, retries = 3, label = ''): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return fn();
    } catch (err) {
      // Quota exhaustion won't clear in seconds — don't burn retries on it
      if (attempt === retries || err instanceof UsageLimitError) throw err;
      const delay = 2 ** attempt * 1000;
      log.warn(`${label} attempt ${attempt}/${retries} failed — retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }
  throw new Error('unreachable');
}

/** Exit code when the review is skipped because the agent's usage limit was hit. */
export const EXIT_USAGE_LIMIT = 3;

/**
 * Skip the review instead of failing it: comment on the PR, mark it neutral
 * where possible, and surface the reason in the CI UI.
 * GitHub Actions exits 0 (the neutral check run carries the status); elsewhere
 * exits EXIT_USAGE_LIMIT so CI can treat it as allowed-to-fail (GitLab
 * `allow_failure: exit_codes`).
 */
function handleUsageLimit(
  err: UsageLimitError,
  provider: GitProvider,
  ref: PrRef,
  headSha: string,
  reviewTerm: string,
  dryRun: boolean,
): number {
  const title = `AI review skipped: ${err.engine} usage limit reached`;
  const body =
    `⏸️ **${title}.**\n\n` +
    `The ${reviewTerm} was not reviewed because the agent subscription behind this review is out of quota` +
    `${err.resetsAt ? ` (resets ${err.resetsAt})` : ''}. ` +
    'Push a new commit or re-run the job after it resets.\n\n' +
    `<sub>${err.detail.replace(/[<>]/g, '')}</sub>`;

  log.section('SKIPPED: USAGE LIMIT');
  log.warn(err.message);
  try {
    provider.reportSkipped(ref, headSha, title, body, dryRun);
  } catch {
    log.warn('[warn] Could not post the skip notice');
  }

  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning title=${title}::${err.message}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${err.message}\n`);
    }
    return 0;
  }
  return EXIT_USAGE_LIMIT;
}

function parseFlag(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 ? (args[idx + 1] ?? '') : '';
}

function flagIndices(args: string[], ...flags: string[]): Set<number> {
  const idxs = new Set<number>();
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx >= 0) { idxs.add(idx); idxs.add(idx + 1); }
  }
  return idxs;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const engineName = parseFlag(args, '--engine');
  const model = parseFlag(args, '--model');
  const providerHint = parseFlag(args, '--provider');
  const effort = parseFlag(args, '--effort');
  const dryRun = args.includes('--dry-run');

  if (model && !engineName) {
    console.error('Error: --model requires --engine. Supported engines: claude-cli, codex-cli');
    process.exit(1);
  }

  const skipIdxs = flagIndices(args, '--engine', '--model', '--auth-token', '--auth-token-file', '--provider', '--effort');
  const positional = args.filter((a, i) => !skipIdxs.has(i) && a !== '--dry-run');
  const arg = positional[0];

  if (!arg) {
    console.error(
      'Usage: pr-audit <ref> [--engine <engine>] [--model <model>] [--effort <level>] [--auth-token <token> | --auth-token-file <path>] [--provider github|gitlab] [--dry-run]\n' +
      '\n' +
      'Supported formats:\n' +
      '  GitHub:  owner/repo#123  or  https://github.com/owner/repo/pull/123\n' +
      '  GitLab:  group/project!123  or  https://gitlab.com/group/project/-/merge_requests/123\n' +
      '\n' +
      'Engines: claude-cli (default), codex-cli\n' +
      `Credentials: --auth-token, --auth-token-file or $${AUTH_TOKEN_ENV} (default: the agent CLI's own login)\n` +
      `Effort (default ${DEFAULT_EFFORT}): claude-cli ${ENGINE_EFFORTS['claude-cli'].join('|')}; codex-cli ${ENGINE_EFFORTS['codex-cli'].join('|')}`,
    );
    process.exit(1);
  }

  const authToken = readAuthToken(args);
  const { provider, ref } = resolveProvider(arg, providerHint || undefined);
  const engine = resolveEngine(engineName || 'claude-cli', authToken, effort || DEFAULT_EFFORT);
  const effectiveModel = model || engine.defaultModel;

  const label = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${ref.slug.replace(/\//g, '_')}_${ref.number}`;
  initLogger(label);

  log.section('RUN START');
  log.debug(`Command: ${redactArgs(process.argv).join(' ')}`);
  log.info(`Provider: ${provider.name}`);
  log.info(`Engine:   ${engine.name}`);
  log.info(`Model:    ${effectiveModel}`);
  log.info(`Effort:   ${engine.effort}`);
  if (dryRun) log.info('Mode:     DRY-RUN (no review will be posted)');
  log.info(`Fetching ${provider.reviewTerm} ${ref.slug}#${ref.number}...`);
  console.log(`Logging to ${log.filePath}`);

  const prData = provider.fetchPr(ref);
  log.info(`  Title: ${prData.title}`);
  log.debug(`  Body: ${prData.body.slice(0, 300)}${prData.body.length > 300 ? '…' : ''}`);
  log.debug(`  headSha: ${prData.headSha}`);

  const files = parseDiffString(prData.diff);
  if (files.length === 0) {
    log.info('No reviewable files found in diff. Exiting.');
    await log.close();
    process.exit(0);
  }
  log.info(`  Files to review: ${files.length}`);
  log.debug(`  Files: ${files.map((f) => f.path).join(', ')}`);

  const batches = chunkFiles(files);
  log.info(`  Batches: ${batches.length}`);

  const totalRenderedLines = files.reduce((s, f) => s + f.renderedLineCount, 0);
  const estInputTokens = totalRenderedLines * 12 + batches.length * 800;
  const estOutputTokens = batches.length * 800;
  const estCost = (estInputTokens * 3 + estOutputTokens * 15) / 1_000_000;
  log.info(`  Est. cost: ~$${estCost.toFixed(3)} (${totalRenderedLines} rendered lines)`);

  const results = [];
  let merged: ReviewOutput;
  let totalUsage: TokenUsage;
  try {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const totalChanged = batch.reduce((s, f) => s + f.changedLineCount, 0);

      log.section(`Batch ${i + 1} / ${batches.length}`);
      log.info(`Reviewing batch ${i + 1}/${batches.length} (${totalChanged} changed lines)...`);
      log.debug(`  Files in batch: ${batch.map((f) => `${f.path} (${f.changedLineCount} lines)`).join(', ')}`);

      const prompt = buildPrompt(prData, batch, provider.reviewTerm);
      const result = await withRetry(
        () => engine.review(prompt, effectiveModel),
        3,
        `Batch ${i + 1}/${batches.length}`,
      );
      results.push(result);

      const u = result.usage;
      const tokenLine =
        `  Tokens: ${u.inputTokens} in / ${u.outputTokens} out` +
        (u.cacheReadTokens ? ` / ${u.cacheReadTokens} cache-read` : '') +
        `  Cost: $${u.costUSD.toFixed(4)}`;
      log.info(tokenLine);

      if (i < batches.length - 1) {
        await sleep(500);
      }
    }

    ({ review: merged, totalUsage } = mergeResults(results));

    if (batches.length > 1) {
      log.section('SYNTHESIZING SUMMARY');
      log.info('Synthesizing batch summaries into one...');
      const synthesisPrompt = buildSynthesisPrompt(
        prData.title,
        results.map((r) => r.review.summary),
        merged.verdict,
        provider.reviewTerm,
      );
      merged.summary = engine.synthesize(synthesisPrompt, effectiveModel);
    }
  } catch (err) {
    if (!(err instanceof UsageLimitError)) throw err;
    const code = handleUsageLimit(err, provider, ref, prData.headSha, provider.reviewTerm, dryRun);
    await log.close();
    process.exit(code);
  }

  if (batches.length > 1) {
    const totalLine =
      `Total — Tokens: ${totalUsage.inputTokens} in / ${totalUsage.outputTokens} out` +
      (totalUsage.cacheReadTokens ? ` / ${totalUsage.cacheReadTokens} cache-read` : '') +
      `  Cost: $${totalUsage.costUSD.toFixed(4)}`;
    log.info(totalLine);
  }

  const validComments = validateComments(merged.comments, files);
  if (validComments.length < merged.comments.length) {
    log.warn(`[warn] Dropped ${merged.comments.length - validComments.length} comment(s) with invalid line refs`);
  }

  log.section(dryRun ? 'DRY-RUN: REVIEW PREVIEW' : 'POSTING REVIEW');
  log.info(`${dryRun ? 'Previewing' : 'Posting'} review (${merged.verdict})...`);
  provider.postReview(ref, prData.headSha, merged, validComments, dryRun);

  log.section('RUN SUMMARY');
  log.info(`Verdict:   ${merged.verdict}`);
  log.info(`Comments:  ${validComments.length} posted, ${merged.comments.length - validComments.length} dropped`);
  log.info(`Total cost: $${totalUsage.costUSD.toFixed(4)}`);
  log.info(`Log file:  ${log.filePath}`);

  await log.close();
}

main().catch(async (err) => {
  // Before initLogger() the logger is a no-op (e.g. bad flags) — print directly
  if (!log.filePath) console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  log.error(`[fatal] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  await log.close();
  process.exit(1);
});
