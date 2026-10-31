import type { IssueRef, LinkedIssue, PrData } from './types.js';

/** At most this many linked issues are fetched; the agent is told about the rest. */
export const MAX_ISSUES = 10;
const MAX_ISSUE_BODY = 4000;
const MAX_COMMENTS = 10;
const MAX_COMMENT = 1000;

export interface IssueMention {
  ref: IssueRef;
  /** Preceded by a closing keyword ("Closes #12") or recorded by the provider as closing. */
  closes: boolean;
}

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*$/i;

// #12, owner/repo#12, group/sub/project#12, and full issue URLs on GitHub or GitLab
const MENTION =
  /(?:https?:\/\/[^\s/]+\/((?:[\w.-]+\/)+[\w.-]+?)(?:\/-)?\/issues\/(\d+))|(?:(?<![\w/])((?:[\w.-]+\/)+[\w.-]+)#(\d+))|(?:(?<![\w/#&])#(\d+)\b)/g;

/** Issue references in free text, with whether each follows a closing keyword. */
export function scanText(text: string, slug: string): IssueMention[] {
  const out: IssueMention[] = [];
  for (const m of text.matchAll(MENTION)) {
    const before = text.slice(0, m.index);
    const closes = CLOSING.test(before);
    if (m[1]) out.push({ ref: { slug: m[1].replace(/\/-$/, ''), number: Number(m[2]) }, closes });
    else if (m[3]) out.push({ ref: { slug: m[3], number: Number(m[4]) }, closes });
    else out.push({ ref: { slug, number: Number(m[5]) }, closes });
  }
  return out;
}

/** Branch names carry issue numbers as `123-fix-login`, `fix/123-login`, `issue-123`. */
export function scanBranch(branch: string, slug: string): IssueMention[] {
  const m = /(?:^|\/)(?:issue[-_]?|gh[-_]?)?(\d+)(?:[-_]|$)/i.exec(branch);
  return m ? [{ ref: { slug, number: Number(m[1]) }, closes: false }] : [];
}

const key = (r: IssueRef) => `${r.slug.toLowerCase()}#${r.number}`;

/**
 * Every issue the PR points at: provider closing links first, then mentions in the title,
 * description and commit messages. Deduplicated; `closes` if any source says so. A number in
 * the branch name is a weak signal (`release/2024-hotfix`), used only when nothing else is found.
 */
export function findIssueMentions(pr: PrData, slug: string): IssueMention[] {
  let all: IssueMention[] = [
    ...pr.closingIssues.map((ref) => ({ ref, closes: true })),
    ...scanText(`${pr.title}\n${pr.body}`, slug),
    ...pr.commits.flatMap((c) => scanText(c, slug)),
  ];
  if (all.length === 0) all = scanBranch(pr.headRef, slug);
  const byKey = new Map<string, IssueMention>();
  for (const m of all) {
    const k = key(m.ref);
    const seen = byKey.get(k);
    if (seen) seen.closes ||= m.closes;
    else byKey.set(k, { ...m });
  }
  return [...byKey.values()];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… truncated]` : text;
}

/** Trim an issue to what goes in the prompt. */
export function trimIssue(issue: LinkedIssue): LinkedIssue {
  return {
    ...issue,
    body: clip(issue.body, MAX_ISSUE_BODY),
    comments: issue.comments.slice(-MAX_COMMENTS).map((c) => ({ ...c, body: clip(c.body, MAX_COMMENT) })),
  };
}

export function issueLabel(ref: IssueRef, slug: string): string {
  return ref.slug.toLowerCase() === slug.toLowerCase() ? `#${ref.number}` : `${ref.slug}#${ref.number}`;
}
