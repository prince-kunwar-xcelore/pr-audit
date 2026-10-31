export interface PrRef {
  slug: string;
  number: number;
}

export interface PrData {
  title: string;
  body: string;
  /** Web URL of the PR / MR. */
  url: string;
  headSha: string;
  /** Tip of the target branch; the PR's diff is `baseSha...headSha`. */
  baseSha: string;
  /** Target branch name. */
  baseRef: string;
  /** Source branch name. */
  headRef: string;
  /** Commit messages, oldest first. */
  commits: string[];
  /** Issues the provider itself records as closed by this PR (e.g. GitHub's closing references). */
  closingIssues: IssueRef[];
  providerMeta?: Record<string, unknown>;
}

/** A reference to an issue on the provider: `#12` (same repo) or `owner/repo#12`. */
export interface IssueRef {
  slug: string;
  number: number;
}

export interface LinkedIssue {
  ref: IssueRef;
  url: string;
  title: string;
  body: string;
  state: string;
  /** Most recent last. */
  comments: { author: string; body: string }[];
  /** The PR claims to finish this issue (closing keyword or provider closing link). */
  closes: boolean;
}

export interface ParsedFile {
  path: string;
  /** Head-side lines a provider accepts an inline comment on (added and context lines). */
  commentableLines: Set<number>;
}

export const SEVERITIES = ['critical', 'warning', 'suggestion'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const KINDS = ['bug', 'security', 'requirement', 'test', 'question', 'cleanup', 'naming'] as const;
export type Kind = (typeof KINDS)[number];

/** Inline when `path` and `line` point at a line of the change, general otherwise. */
export interface Finding {
  path: string | null;
  line: number | null;
  severity: Severity;
  kind: Kind;
  body: string;
}

export type Verdict = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export type FollowUpAction = 'resolve_fixed' | 'resolve_answered' | 'reply';

/** What the review session wants done with one of pr-audit's own open threads. */
export interface FollowUp {
  /** Thread id as given in the prompt (T1, T2, …). */
  thread: string;
  action: FollowUpAction;
  body: string;
}

/** Structured output of a review session. */
export interface ReviewSessionOutput {
  summary: string;
  findings: Finding[];
  follow_ups: FollowUp[];
}

export type VerifyAction = 'keep' | 'drop' | 'downgrade' | 'move';

/** Structured output of a verification session. */
export interface VerifySessionOutput {
  findings: {
    /** Finding id as given in the prompt (F1, F2, …). */
    id: string;
    action: VerifyAction;
    /** New severity for `downgrade`. */
    severity: Severity | null;
    /** New anchor for `move` (null path/line: make it a general finding). */
    path: string | null;
    line: number | null;
    reason: string;
  }[];
  follow_ups: {
    thread: string;
    confirmed: boolean;
    reason: string;
  }[];
}

/** The review as posted: a summary (with any body findings), the verdict, and inline findings on their lines. */
export interface ReviewPost {
  summary: string;
  verdict: Verdict;
  inline: Finding[];
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** API-equivalent cost when the engine reports one (Claude), else null. */
  costUSD: number | null;
  durationMs: number;
}
