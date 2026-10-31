import type { GitProvider, FollowUpPost } from './provider.js';
import {
  AgentAuthError,
  SessionTimeoutError,
  UsageLimitError,
  type ReviewEngine,
  type SessionRequest,
} from './engine.js';
import { parseDiffString } from './diff.js';
import { buildReviewPrompt, buildVerifyPrompt, REVIEW_SCHEMA, VERIFY_SCHEMA, type ReviewContext } from './prompt.js';
import { issueLabel } from './requirements.js';
import {
  findingTag,
  generalMarker,
  openThreads,
  reviewMarker,
  threadSeverity,
  type PriorThread,
  type ReviewHistory,
} from './review-history.js';
import {
  KINDS,
  SEVERITIES,
  type Finding,
  type FollowUp,
  type LinkedIssue,
  type ParsedFile,
  type PrData,
  type PrRef,
  type ReviewSessionOutput,
  type SessionUsage,
  type Severity,
  type Verdict,
  type VerifySessionOutput,
} from './types.js';
import { log } from './logger.js';

/** The checkout the sessions run in, and the git questions pr-audit asks of it. */
export interface Workspace {
  dir: string;
  diff(from: string, to: string, twoDot?: boolean): string;
  mergeBase(a: string, b: string): string;
  isAncestor(ancestor: string, of: string): boolean;
  hasCommit(sha: string): boolean;
}

export interface ReviewOptions {
  model: string;
  verify: boolean;
  full: boolean;
  dryRun: boolean;
  reviewTimeoutMs: number;
  verifyTimeoutMs: number;
  /** Wait before the one retry (default 5 s). */
  retryDelayMs?: number;
}

export interface SessionReport {
  label: string;
  usage: SessionUsage;
}

export type ReviewOutcome =
  | { posted: false; reason: string }
  | { posted: true; verdict: Verdict; inline: number; threaded: number; body: number; followUps: number; sessions: SessionReport[] };

export interface ReviewInput {
  provider: GitProvider;
  engine: ReviewEngine;
  ref: PrRef;
  pr: PrData;
  history: ReviewHistory;
  workspace: Workspace;
  issues: LinkedIssue[];
  unfetchedIssues: string[];
  options: ReviewOptions;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 2, warning: 1, suggestion: 0 };
const blocks = (s: Severity) => SEVERITY_RANK[s] >= SEVERITY_RANK.warning;

/** Crashes and network errors get one more try; quota, auth and timeouts don't. */
async function withRetry<T>(fn: () => T, label: string, delayMs: number): Promise<T> {
  try {
    return fn();
  } catch (err) {
    if (err instanceof UsageLimitError || err instanceof AgentAuthError || err instanceof SessionTimeoutError) throw err;
    log.warn(`${label} session failed (${(err as Error).message.split('\n')[0]}) — retrying once in ${delayMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, delayMs));
    return fn();
  }
}

/** Coerce model output into valid findings (unknown enum values get safe defaults). */
export function sanitizeFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as Finding).body === 'string')
    .map((f) => ({
      path: typeof f.path === 'string' && f.path.trim() ? f.path.trim().replace(/^\.?\//, '') : null,
      line: Number.isInteger(f.line) && (f.line as number) > 0 ? (f.line as number) : null,
      severity: SEVERITIES.includes(f.severity as Severity) ? (f.severity as Severity) : 'suggestion',
      kind: KINDS.includes(f.kind as Finding['kind']) ? (f.kind as Finding['kind']) : 'bug',
      body: (f.body as string).trim(),
    }))
    .filter((f) => f.body);
}

/** Apply verification decisions; findings it said nothing about are kept. */
export function applyVerification(
  candidates: { id: string; finding: Finding }[],
  decisions: VerifySessionOutput['findings'],
): Finding[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const kept: Finding[] = [];
  for (const { id, finding } of candidates) {
    const d = byId.get(id);
    if (!d) {
      log.debug(`  ${id}: no verification decision — kept`);
      kept.push(finding);
      continue;
    }
    log.info(`  ${id} ${d.action}: ${d.reason}`);
    switch (d.action) {
      case 'drop':
        break;
      case 'downgrade': {
        // Never upgrade through "downgrade"
        const severity = d.severity && SEVERITY_RANK[d.severity] < SEVERITY_RANK[finding.severity] ? d.severity : finding.severity;
        kept.push({ ...finding, severity });
        break;
      }
      case 'move':
        kept.push({ ...finding, path: d.path ?? null, line: d.path ? d.line ?? null : null });
        break;
      default:
        kept.push(finding);
    }
  }
  return kept;
}

/**
 * Inline when the anchor is a commentable line of the PR diff. Anything else becomes a
 * general finding, keeping its location in the text rather than being dropped.
 */
export function placeFindings(findings: Finding[], prFiles: ParsedFile[]): { inline: Finding[]; general: Finding[] } {
  const lines = new Map(prFiles.map((f) => [f.path, f.commentableLines]));
  const inline: Finding[] = [];
  const general: Finding[] = [];
  for (const f of findings) {
    if (f.path && f.line && lines.get(f.path)?.has(f.line)) {
      inline.push(f);
    } else if (f.path && f.line) {
      log.debug(`  ${f.path}:${f.line} is not a line of the PR diff — posting as a general finding`);
      general.push({ ...f, line: null, body: `\`${f.path}:${f.line}\`: ${f.body}`, path: lines.has(f.path) ? f.path : null });
    } else if (f.path && !lines.has(f.path)) {
      general.push({ ...f, path: null, body: `\`${f.path}\`: ${f.body}` });
    } else {
      general.push(f);
    }
  }
  return { inline, general };
}

/** Request changes on any critical or warning, comment on suggestions only, approve on nothing. */
export function deriveVerdict(severities: Severity[]): Verdict {
  if (severities.some(blocks)) return 'REQUEST_CHANGES';
  return severities.length ? 'COMMENT' : 'APPROVE';
}

function logUsage(label: string, u: SessionUsage): void {
  log.info(
    `  ${label}: ${u.inputTokens} in / ${u.outputTokens} out` +
      (u.cacheReadTokens ? ` / ${u.cacheReadTokens} cache-read` : '') +
      ` · ${(u.durationMs / 1000).toFixed(0)}s` +
      (u.costUSD !== null ? ` · $${u.costUSD.toFixed(4)} API-equivalent` : ''),
  );
}

export async function runReview(input: ReviewInput): Promise<ReviewOutcome> {
  const { provider, engine, ref, pr, history, workspace, options } = input;
  const short = (s: string) => s.slice(0, 7);

  const mergeBase = workspace.mergeBase(pr.baseSha, pr.headSha);
  const prFiles = parseDiffString(workspace.diff(mergeBase, pr.headSha, true));
  if (prFiles.length === 0) return { posted: false, reason: 'No reviewable files in the diff.' };
  const prPaths = prFiles.map((f) => f.path);

  // Incremental: only what changed since the last pr-audit review, unless --full
  let sinceSha: string | undefined;
  if (!options.full && history.lastSha) {
    if (!workspace.hasCommit(history.lastSha) || !workspace.isAncestor(history.lastSha, pr.headSha)) {
      log.info(`  Last reviewed commit ${short(history.lastSha)} is not in this branch's history (force-push?) — reviewing the full diff`);
    } else {
      // Files outside the PR's own diff (e.g. from merging the base branch in) aren't the PR's changes
      const changed = parseDiffString(workspace.diff(history.lastSha, pr.headSha, true)).filter((f) => prPaths.includes(f.path));
      if (changed.length === 0) return { posted: false, reason: 'No reviewable changes since the last review.' };
      sinceSha = history.lastSha;
      log.info(`  Incremental: changes since ${short(sinceSha)} (${changed.length} file(s))`);
    }
  }

  const open = openThreads(history.threads, prPaths).map((thread, i) => ({ id: `T${i + 1}`, thread }));
  const ctx: ReviewContext = {
    slug: ref.slug,
    reviewTerm: provider.reviewTerm,
    pr,
    mergeBase,
    prPaths,
    sinceSha,
    issues: input.issues,
    unfetchedIssues: input.unfetchedIssues,
    openThreads: open,
    allThreads: history.threads,
    bodyFindings: history.bodyFindings,
  };
  log.info(`  Files in PR: ${prFiles.length} · open threads: ${open.length} · linked issues: ${input.issues.length}`);

  const session = (label: string, prompt: string, schema: object, timeoutMs: number): SessionRequest => ({
    label,
    prompt,
    schema,
    cwd: workspace.dir,
    model: options.model,
    timeoutMs,
  });
  const sessions: SessionReport[] = [];

  // Review session
  log.section('REVIEW SESSION');
  log.info(`Reviewing in ${workspace.dir} (limit ${Math.round(options.reviewTimeoutMs / 60000)} min)...`);
  const review = await withRetry(
    () => engine.run<ReviewSessionOutput>(session('review', buildReviewPrompt(ctx), REVIEW_SCHEMA, options.reviewTimeoutMs)),
    'Review',
    options.retryDelayMs ?? 5000,
  );
  sessions.push({ label: 'review', usage: review.usage });
  logUsage('review', review.usage);

  let findings = sanitizeFindings(review.output.findings);
  const threadById = new Map(open.map((o) => [o.id, o.thread]));
  let followUps: FollowUp[] = (Array.isArray(review.output.follow_ups) ? review.output.follow_ups : []).filter(
    (f) => !!f && typeof f === 'object' && threadById.has(f.thread) && ['resolve_fixed', 'resolve_answered', 'reply'].includes(f.action) && f.body?.trim(),
  );
  log.info(`  Candidate findings: ${findings.length} · follow-ups: ${followUps.length}`);
  for (const f of findings) log.debug(`  ${findingTag(f)} ${f.path ?? '(general)'}${f.line ? `:${f.line}` : ''} — ${f.body}`);

  // Verification
  let unverifiedNote: string | null = null;
  const resolutions = followUps.filter((f) => f.action !== 'reply');
  if (options.verify && (findings.length || resolutions.length)) {
    log.section('VERIFICATION SESSION');
    const candidates = findings.map((finding, i) => ({ id: `F${i + 1}`, finding }));
    const toConfirm = resolutions.map((f) => ({ id: f.thread, thread: threadById.get(f.thread)!, claim: f.body }));
    try {
      const verified = await withRetry(
        () =>
          engine.run<VerifySessionOutput>(
            session('verification', buildVerifyPrompt({ ...ctx, candidates, resolutions: toConfirm }), VERIFY_SCHEMA, options.verifyTimeoutMs),
          ),
        'Verification',
        options.retryDelayMs ?? 5000,
      );
      sessions.push({ label: 'verification', usage: verified.usage });
      logUsage('verification', verified.usage);
      findings = applyVerification(candidates, (Array.isArray(verified.output.findings) ? verified.output.findings : []).filter((d) => !!d && typeof d === 'object'));
      const rejected = new Set(
        (Array.isArray(verified.output.follow_ups) ? verified.output.follow_ups : [])
          .filter((v) => !!v && typeof v === 'object' && !v.confirmed)
          .map((v) => {
            log.info(`  ${v.thread} stays open: ${v.reason}`);
            return v.thread;
          }),
      );
      followUps = followUps.filter((f) => f.action === 'reply' || !rejected.has(f.thread));
    } catch (err) {
      // A finished review is worth posting even when its check failed
      const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
      log.warn(`[warn] Verification failed — posting unverified findings (${why})`);
      unverifiedNote = `⚠️ These findings were not verified (verification failed: ${why.replace(/[<>]/g, '')}).`;
    }
  }

  // Placement: general findings become their own threads where possible, the rest (and any
  // whose thread fails to post) go in the body, where the marker carries them to the next review
  const { inline, general } = placeFindings(findings, prFiles);
  const threaded: Finding[] = [];
  const body: Finding[] = [];
  for (const f of general) {
    if (!provider.threadsGeneralFinding(f, prPaths)) {
      body.push(f);
      continue;
    }
    try {
      provider.postGeneralThread(ref, pr.headSha, f, options.dryRun);
      threaded.push(f);
    } catch (err) {
      log.warn(`[warn] Could not post a general finding as a thread — keeping it in the review body (${(err as Error).message.split('\n')[0]})`);
      body.push(f);
    }
  }

  // Verdict: this review's findings plus earlier blocking threads that stay open
  const resolvedIds = new Set(followUps.filter((f) => f.action !== 'reply').map((f) => f.thread));
  const stillOpen = open.filter((o) => !resolvedIds.has(o.id));
  const openBlocking = stillOpen.filter((o) => {
    const s = threadSeverity(o.thread);
    return s !== null && blocks(s);
  });
  const verdict = deriveVerdict([...findings.map((f) => f.severity), ...openBlocking.map((o) => threadSeverity(o.thread)!)]);

  // Summary
  const parts: string[] = [];
  if (sinceSha) parts.push(`_Incremental review: changes since ${short(sinceSha)}._`);
  parts.push(review.output.summary?.trim() || '(no summary)');
  if (input.issues.length) {
    parts.push(`Requirements checked against: ${input.issues.map((i) => `${issueLabel(i.ref, ref.slug)}${i.closes ? ' (closes)' : ''}`).join(', ')}.`);
  }
  if (body.length) {
    parts.push(`### Other findings\n${body.map((f) => `- ${findingTag(f)} ${f.body}`).join('\n')}`);
  }
  if (openBlocking.length) {
    parts.push(`${openBlocking.length} earlier finding(s) still open. Resolve those threads, or push a fix.`);
  }
  if (resolvedIds.size) parts.push(`Resolved ${resolvedIds.size} earlier thread(s).`);
  if (unverifiedNote) parts.push(unverifiedNote);
  // Recorded so the next run can review only what's pushed after this commit and re-check body findings
  parts.push(`${reviewMarker(pr.headSha)}\n${generalMarker(body)}`);

  log.section(options.dryRun ? 'DRY-RUN: REVIEW PREVIEW' : 'POSTING REVIEW');
  log.info(`${options.dryRun ? 'Previewing' : 'Posting'} review (${verdict}): ${inline.length} inline, ${threaded.length} general thread(s), ${body.length} in the body`);
  provider.postReview(ref, pr.headSha, { summary: parts.join('\n\n'), verdict, inline }, options.dryRun);

  if (followUps.length && provider.applyFollowUps) {
    const posts: FollowUpPost[] = followUps.map((f) => ({
      thread: threadById.get(f.thread) as PriorThread,
      body: f.body.trim(),
      resolve: f.action !== 'reply',
    }));
    provider.applyFollowUps(ref, posts, options.dryRun);
  }

  return { posted: true, verdict, inline: inline.length, threaded: threaded.length, body: body.length, followUps: followUps.length, sessions };
}
