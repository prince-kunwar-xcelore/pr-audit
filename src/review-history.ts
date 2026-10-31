import { KINDS, SEVERITIES, type Finding, type Severity } from './types.js';

/**
 * What earlier pr-audit runs left on a PR: the commit the last review covered and the
 * general findings it kept in its body (hidden markers), and its threads.
 */

export interface PriorThread {
  /** Provider id of the thread's first comment. */
  id: string;
  path: string;
  /** null for file-level threads and outdated ones. */
  line: number | null;
  /** The pr-audit comment, e.g. "**[warning · bug]** …". */
  body: string;
  /** Replies, oldest first. */
  replies: { author: string; body: string }[];
  /** Marked resolved on the platform. */
  resolved: boolean;
  /** The lines it points at have changed since. */
  outdated: boolean;
  /** Provider handle needed to resolve the thread (GitHub: GraphQL thread node id). */
  resolveId?: string;
  /** pr-audit has the last word (its reply, no author answer since): don't reply again. */
  awaitingAuthor?: boolean;
}

export interface ReviewHistory {
  /** Head SHA the last pr-audit review covered, or null if there is none. */
  lastSha: string | null;
  threads: PriorThread[];
  /** General findings the last review kept in its body. */
  bodyFindings: Finding[];
}

export const EMPTY_HISTORY: ReviewHistory = { lastSha: null, threads: [], bodyFindings: [] };

const MARKER = /<!-- pr-audit:sha=([0-9a-f]{7,40}) -->/;
const GENERAL_MARKER = /<!-- pr-audit:general=([A-Za-z0-9+/=]*) -->/;

/** Hidden marker appended to every review body, recording the commit it covers. */
export function reviewMarker(headSha: string): string {
  return `<!-- pr-audit:sha=${headSha} -->`;
}

export function parseReviewMarker(body: string | null | undefined): string | null {
  return MARKER.exec(body ?? '')?.[1] ?? null;
}

// Keeps the marker well under GitHub's 65536-character review body limit
const MAX_MARKER_FINDINGS = 20;
const MAX_MARKER_BODY = 600;

/** Hidden marker carrying the body findings, so the next review can re-check them. */
export function generalMarker(findings: Finding[]): string {
  const data = findings
    .slice(0, MAX_MARKER_FINDINGS)
    .map(({ severity, kind, body }) => ({ severity, kind, body: body.length > MAX_MARKER_BODY ? `${body.slice(0, MAX_MARKER_BODY)}…` : body }));
  return `<!-- pr-audit:general=${Buffer.from(JSON.stringify(data)).toString('base64')} -->`;
}

export function parseGeneralMarker(body: string | null | undefined): Finding[] {
  const m = GENERAL_MARKER.exec(body ?? '');
  if (!m) return [];
  try {
    const data = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as Partial<Finding>[];
    return data
      .filter((f) => SEVERITIES.includes(f.severity as Severity) && typeof f.body === 'string')
      .map((f) => ({
        path: null,
        line: null,
        severity: f.severity as Severity,
        kind: KINDS.includes(f.kind as Finding['kind']) ? (f.kind as Finding['kind']) : 'bug',
        body: f.body as string,
      }));
  } catch {
    return [];
  }
}

/** Hidden marker on pr-audit's resolving replies: the thread counts as resolved even if the provider refused to resolve it. */
export const RESOLVED_MARKER = '<!-- pr-audit:resolved -->';

/** The tag every pr-audit finding comment starts with, e.g. "**[warning · question]**". */
export function findingTag(f: Pick<Finding, 'severity' | 'kind'>): string {
  return `**[${f.severity} · ${f.kind}]**`;
}

// Current tag, and the severity-only tag of reviews before kinds existed
const PR_AUDIT_COMMENT = /^\*\*\[(critical|warning|suggestion)(?: · [a-z]+)?\]\*\*/;

export function isPrAuditComment(body: string): boolean {
  return PR_AUDIT_COMMENT.test(body);
}

export function threadSeverity(t: Pick<PriorThread, 'body'>): Severity | null {
  return (PR_AUDIT_COMMENT.exec(t.body)?.[1] as Severity | undefined) ?? null;
}

export function threadStatus(t: PriorThread): 'open' | 'resolved' | 'outdated' {
  return t.resolved ? 'resolved' : t.outdated ? 'outdated' : 'open';
}

/** Open threads on files still in the PR: the ones the review follows up on and the verdict counts. */
export function openThreads(threads: PriorThread[], paths: string[]): PriorThread[] {
  return threads.filter((t) => paths.includes(t.path) && threadStatus(t) === 'open');
}

const MAX_BODY = 1500;
const MAX_REPLY = 800;
const MAX_REPLIES = 5;
const MAX_CLOSED = 50;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function firstSentence(text: string): string {
  const flat = text.replace(PR_AUDIT_COMMENT, '').replace(/\s+/g, ' ').trim();
  const m = /^(.{1,160}?[.!?])(\s|$)/.exec(flat);
  return m ? m[1] : clip(flat, 160);
}

const where = (t: PriorThread) => `${t.path}${t.line ? `:${t.line}` : ''}`;

/** Open threads in full with their ids (T1, T2, …) and replies. */
export function renderOpenThreads(threads: { id: string; thread: PriorThread }[]): string {
  return threads
    .map(({ id, thread: t }) => {
      const replies = t.replies
        .slice(-MAX_REPLIES)
        .map((r) => `\n    ↳ ${r.author}: ${clip(r.body.replace(/<!--[\s\S]*?-->/g, ''), MAX_REPLY)}`)
        .join('');
      const waiting = t.awaitingAuthor ? ' (you already replied; waiting for the author — only resolve it if the code now fixes it)' : '';
      return `- ${id} ${where(t)}${t.line === null ? ' (file)' : ''}${waiting}: ${clip(t.body, MAX_BODY)}${replies}`;
    })
    .join('\n');
}

/** Resolved and outdated threads, one line each, so they aren't raised again. */
export function renderClosedThreads(threads: PriorThread[], paths: string[]): string {
  return threads
    .filter((t) => paths.includes(t.path) && threadStatus(t) !== 'open')
    .slice(-MAX_CLOSED)
    .map((t) => `- ${where(t)} (${threadStatus(t)}) ${firstSentence(t.body)}`)
    .join('\n');
}
