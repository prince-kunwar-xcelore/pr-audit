#!/usr/bin/env node
import process from 'node:process';
import { resolveProvider, type GitProvider } from './provider.js';
import type { LinkedIssue, PrRef } from './types.js';
import fs from 'node:fs';
import {
  resolveEngine,
  AgentAuthError,
  SessionTimeoutError,
  UsageLimitError,
  DEFAULT_EFFORT,
  ENGINE_EFFORTS,
} from './engine.js';
import { initLogger, log } from './logger.js';
import { EMPTY_HISTORY, type ReviewHistory } from './review-history.js';
import { readAuthToken, redactArgs, AUTH_TOKEN_ENV } from './auth-token.js';
import { findIssueMentions, issueLabel, MAX_ISSUES, trimIssue } from './requirements.js';
import { gitDiff, hasCommit, isAncestor, mergeBase, prepareCheckout, type Checkout } from './checkout.js';
import { runReview, type ReviewOutcome, type SessionReport, type Workspace } from './review.js';

/** Default session time limits, in minutes. */
export const DEFAULT_REVIEW_TIMEOUT_MIN = 20;
export const DEFAULT_VERIFY_TIMEOUT_MIN = 10;
const MAX_TIMEOUT_MIN = 240;

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
  } catch (e) {
    log.warn(`[warn] Could not post the skip notice: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning title=${escapeProperty(title)}::${escapeData(err.message)}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${err.message}\n`);
    }
    return 0;
  }
  return EXIT_USAGE_LIMIT;
}

// GitHub Actions workflow-command escaping (as in @actions/core)
function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function parseFlag(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  if (idx === -1) return '';
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

function flagIndices(args: string[], ...flags: string[]): Set<number> {
  const idxs = new Set<number>();
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx >= 0) { idxs.add(idx); idxs.add(idx + 1); }
  }
  return idxs;
}

const USAGE =
  'Usage: pr-audit <ref> [--engine <engine>] [--model <model>] [--effort <level>] [--auth-token <token> | --auth-token-file <path>] [--provider github|gitlab] [--full] [--no-verify] [--timeout <minutes>] [--dry-run]';

function usageText(): string {
  return (
    `${USAGE}\n` +
    '\n' +
    'Supported formats:\n' +
    '  GitHub:  owner/repo#123  or  https://github.com/owner/repo/pull/123\n' +
    '  GitLab:  group/project!123  or  https://gitlab.com/group/project/-/merge_requests/123\n' +
    '\n' +
    'Engines: claude-cli (default), codex-cli\n' +
    `Credentials: --auth-token, --auth-token-file or $${AUTH_TOKEN_ENV} (default: the agent CLI's own login)\n` +
    `Effort (default ${DEFAULT_EFFORT}): claude-cli ${ENGINE_EFFORTS['claude-cli'].join('|')}; codex-cli ${ENGINE_EFFORTS['codex-cli'].join('|')}\n` +
    `Verification: on by default; --no-verify skips it. --timeout: review session limit in minutes (default ${DEFAULT_REVIEW_TIMEOUT_MIN}; verification gets half)`
  );
}

const BOOLEAN_FLAGS = ['--dry-run', '--full', '--verify', '--no-verify'];

/** Linked issues to hand the agent: fetched up to MAX_ISSUES, the rest named only. */
function collectIssues(provider: GitProvider, ref: PrRef, pr: ReturnType<GitProvider['fetchPr']>): { issues: LinkedIssue[]; unfetched: string[] } {
  const mentions = findIssueMentions(pr, ref.slug);
  const issues: LinkedIssue[] = [];
  const unfetched: string[] = [];
  for (const m of mentions) {
    if (issues.length >= MAX_ISSUES) {
      unfetched.push(issueLabel(m.ref, ref.slug));
      continue;
    }
    const issue = provider.fetchIssue(m.ref);
    if (issue) issues.push(trimIssue({ ...issue, closes: m.closes }));
  }
  return { issues, unfetched };
}

function workspaceOf(checkout: Checkout): Workspace {
  return {
    dir: checkout.dir,
    diff: (from, to, twoDot) => gitDiff(checkout.dir, from, to, twoDot),
    mergeBase: (a, b) => mergeBase(checkout.dir, a, b),
    isAncestor: (a, b) => isAncestor(checkout.dir, a, b),
    hasCommit: (sha) => hasCommit(checkout.dir, sha),
  };
}

function reportUsage(sessions: SessionReport[]): void {
  if (sessions.length === 0) return;
  const total = sessions.reduce(
    (t, { usage: u }) => ({
      inputTokens: t.inputTokens + u.inputTokens,
      outputTokens: t.outputTokens + u.outputTokens,
      cacheReadTokens: t.cacheReadTokens + u.cacheReadTokens,
      durationMs: t.durationMs + u.durationMs,
      costUSD: u.costUSD === null ? t.costUSD : (t.costUSD ?? 0) + u.costUSD,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, durationMs: 0, costUSD: null as number | null },
  );
  const cost = (c: number | null) => (c === null ? '—' : `$${c.toFixed(4)}`);
  log.info(
    `Usage:     ${total.inputTokens} in / ${total.outputTokens} out / ${total.cacheReadTokens} cache-read · ` +
      `${(total.durationMs / 1000).toFixed(0)}s${total.costUSD !== null ? ` · ${cost(total.costUSD)} API-equivalent` : ''}`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = [...sessions, { label: '**total**', usage: { ...total, cacheCreationTokens: 0 } }].map(
      ({ label, usage: u }) =>
        `| ${label} | ${u.inputTokens} | ${u.outputTokens} | ${u.cacheReadTokens} | ${(u.durationMs / 1000).toFixed(0)}s | ${cost(u.costUSD)} |`,
    );
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### AI review usage\n\n| Session | Input | Output | Cache read | Time | API-equivalent cost |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const engineName = parseFlag(args, '--engine');
  const model = parseFlag(args, '--model');
  const providerHint = parseFlag(args, '--provider');
  const effort = parseFlag(args, '--effort');
  const timeoutArg = parseFlag(args, '--timeout');
  const dryRun = args.includes('--dry-run');
  const fullReview = args.includes('--full');
  const verify = !args.includes('--no-verify');

  if (model && !engineName) {
    console.error('Error: --model requires --engine. Supported engines: claude-cli, codex-cli');
    process.exit(1);
  }
  const reviewTimeoutMin = timeoutArg ? Number(timeoutArg) : DEFAULT_REVIEW_TIMEOUT_MIN;
  if (!Number.isFinite(reviewTimeoutMin) || reviewTimeoutMin <= 0 || reviewTimeoutMin > MAX_TIMEOUT_MIN) {
    console.error(`Error: --timeout must be a number of minutes between 0 and ${MAX_TIMEOUT_MIN}`);
    process.exit(1);
  }
  const verifyTimeoutMin = timeoutArg ? reviewTimeoutMin / 2 : DEFAULT_VERIFY_TIMEOUT_MIN;

  const skipIdxs = flagIndices(args, '--engine', '--model', '--auth-token', '--auth-token-file', '--provider', '--effort', '--timeout');
  const positional = args.filter((a, i) => !skipIdxs.has(i) && !BOOLEAN_FLAGS.includes(a));
  const arg = positional[0];

  if (!arg) {
    console.error(usageText());
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
  log.info(`Verify:   ${verify ? 'on' : 'off'}`);
  if (dryRun) log.info('Mode:     DRY-RUN (no review will be posted)');
  log.info(`Fetching ${provider.reviewTerm} ${ref.slug}#${ref.number}...`);
  console.log(`Logging to ${log.filePath}`);

  const pr = provider.fetchPr(ref);
  log.info(`  Title: ${pr.title}`);
  log.debug(`  head ${pr.headSha} (${pr.headRef}) → base ${pr.baseSha} (${pr.baseRef})`);

  let history: ReviewHistory = EMPTY_HISTORY;
  try {
    if (provider.fetchReviewHistory) history = provider.fetchReviewHistory(ref);
  } catch (err) {
    log.warn(`[warn] Could not read earlier reviews — reviewing the full diff (${(err as Error).message})`);
  }
  if (!fullReview && history.lastSha === pr.headSha) {
    log.info(`Commit ${pr.headSha.slice(0, 7)} was already reviewed (use --full to review it again). Exiting.`);
    await log.close();
    process.exit(0);
  }
  if (history.threads.length) log.info(`  Earlier pr-audit threads: ${history.threads.length}`);

  const { issues, unfetched } = collectIssues(provider, ref, pr);
  if (issues.length) log.info(`  Linked issues: ${issues.map((i) => `${issueLabel(i.ref, ref.slug)}${i.closes ? ' (closes)' : ''}`).join(', ')}`);

  log.info('Preparing checkout...');
  const checkout = prepareCheckout({
    slug: ref.slug,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    extraShas: history.lastSha ? [history.lastSha] : [],
    clone: (dir) => provider.cloneRepo(ref, dir),
  });
  log.info(`  Checkout: ${checkout.dir} (${checkout.source})`);

  let outcome: ReviewOutcome;
  try {
    outcome = await runReview({
      provider,
      engine,
      ref,
      pr,
      history,
      workspace: workspaceOf(checkout),
      issues,
      unfetchedIssues: unfetched,
      options: {
        model: effectiveModel,
        verify,
        full: fullReview,
        dryRun,
        reviewTimeoutMs: reviewTimeoutMin * 60_000,
        verifyTimeoutMs: verifyTimeoutMin * 60_000,
      },
    });
  } catch (err) {
    if (!(err instanceof UsageLimitError)) throw err;
    const code = handleUsageLimit(err, provider, ref, pr.headSha, provider.reviewTerm, dryRun);
    await log.close();
    process.exit(code);
  } finally {
    checkout.cleanup();
  }

  if (!outcome.posted) {
    log.info(`${outcome.reason} Exiting.`);
    await log.close();
    return;
  }

  log.section('RUN SUMMARY');
  log.info(`Verdict:   ${outcome.verdict}`);
  log.info(`Findings:  ${outcome.inline} inline, ${outcome.threaded} general thread(s), ${outcome.body} in the body`);
  if (outcome.followUps) log.info(`Follow-ups: ${outcome.followUps}`);
  reportUsage(outcome.sessions);
  log.info(`Log file:  ${log.filePath}`);

  await log.close();
}

main().catch(async (err) => {
  if (err instanceof SessionTimeoutError) {
    log.section('FAILED: SESSION TIMEOUT');
    if (!log.filePath) console.error(`Error: ${err.message}`);
    log.error(`${err.message} — raise it with --timeout <minutes>`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::error title=AI review timed out::${escapeData(`${err.message}; raise it with --timeout <minutes>`)}`);
    }
    await log.close();
    process.exit(1);
  }
  if (err instanceof AgentAuthError) {
    // One clear line instead of a stack trace; a real failure, so exit non-zero
    log.section('FAILED: AGENT AUTHENTICATION');
    if (!log.filePath) console.error(`Error: ${err.message}`);
    log.error(err.message);
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::error title=${escapeProperty(`${err.engine} authentication failed`)}::${escapeData(err.message)}`);
    }
    await log.close();
    process.exit(1);
  }
  // Before initLogger() the logger is a no-op (e.g. bad flags) — print directly
  if (!log.filePath) console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  log.error(`[fatal] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  await log.close();
  process.exit(1);
});
