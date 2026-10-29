import type { ReviewOutput } from './types.js';

/**
 * What earlier pr-audit runs left on a PR: the commit the last review covered
 * (from a hidden marker in its body) and its inline comment threads.
 */

export interface PriorThread {
  path: string;
  line: number | null;
  /** The pr-audit comment, e.g. "**[warning]** …". */
  body: string;
  /** Replies, oldest first. */
  replies: { author: string; body: string }[];
  /** Marked resolved on the platform. */
  resolved: boolean;
  /** The lines it points at have changed since (GitHub: \`line\` is null). */
  outdated: boolean;
}

export interface ReviewHistory {
  /** Head SHA the last pr-audit review covered, or null if there is none. */
  lastSha: string | null;
  threads: PriorThread[];
}

const MARKER = /<!-- pr-audit:sha=([0-9a-f]{7,40}) -->/;

/** Hidden marker appended to every review body, recording the commit it covers. */
export function reviewMarker(headSha: string): string {
  return `<!-- pr-audit:sha=${headSha} -->`;
}

export function parseReviewMarker(body: string | null | undefined): string | null {
  return MARKER.exec(body ?? '')?.[1] ?? null;
}

// pr-audit's inline comments start with the severity tag (see postReview)
const PR_AUDIT_COMMENT = /^\*\*\[(?:critical|warning|suggestion)\]\*\*/;

export function isPrAuditComment(body: string): boolean {
  return PR_AUDIT_COMMENT.test(body);
}

function status(t: PriorThread): string {
  return t.resolved ? 'resolved' : t.outdated ? 'outdated' : 'open';
}

export interface OpenFindings {
  critical: number;
  warning: number;
}

/** Earlier critical/warning threads on `paths` that are neither resolved nor outdated. */
export function countOpenFindings(threads: PriorThread[], paths: string[]): OpenFindings {
  const open = threads.filter((t) => paths.includes(t.path) && status(t) === 'open');
  return {
    critical: open.filter((t) => t.body.startsWith('**[critical]**')).length,
    warning: open.filter((t) => t.body.startsWith('**[warning]**')).length,
  };
}

/**
 * The agent is told not to repeat earlier findings, so it may approve while they're still open.
 * Open critical findings keep the verdict at REQUEST_CHANGES, open warnings at COMMENT.
 */
export function holdForOpenFindings(
  verdict: ReviewOutput['verdict'],
  open: OpenFindings,
): { verdict: ReviewOutput['verdict']; note: string | null } {
  const total = open.critical + open.warning;
  if (total === 0) return { verdict, note: null };
  const held = open.critical ? 'REQUEST_CHANGES' : verdict === 'APPROVE' ? 'COMMENT' : verdict;
  const counts = [open.critical && `${open.critical} critical`, open.warning && `${open.warning} warning`]
    .filter(Boolean)
    .join(', ');
  return {
    verdict: held,
    note: `${total} earlier finding(s) still open (${counts}). Resolve those threads, or push a fix that changes the lines they point at.`,
  };
}

const MAX_BODY = 300;
const MAX_REPLY = 200;
const MAX_REPLIES = 3;
const MAX_THREADS = 50;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Prompt section listing earlier threads on `paths`, or '' if there are none. */
export function renderPriorThreads(threads: PriorThread[], paths: string[]): string {
  // Most recent last; cap so a long-running PR doesn't crowd out the diff
  const relevant = threads.filter((t) => paths.includes(t.path)).slice(-MAX_THREADS);
  if (relevant.length === 0) return '';
  const lines = relevant.map((t) => {
    const replies = t.replies
      .slice(-MAX_REPLIES)
      .map((r) => `\n    ↳ ${r.author}: ${clip(r.body, MAX_REPLY)}`)
      .join('');
    return `- ${t.path}${t.line ? `:${t.line}` : ''} (${status(t)}) ${clip(t.body, MAX_BODY)}${replies}`;
  });
  return lines.join('\n');
}
