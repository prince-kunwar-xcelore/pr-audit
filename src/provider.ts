import type { Finding, IssueRef, LinkedIssue, PrRef, PrData, ReviewPost } from './types.js';
import type { PriorThread, ReviewHistory } from './review-history.js';
import { GitHubProvider } from './providers/github.js';
import { GitLabProvider } from './providers/gitlab.js';

/** A follow-up on one of pr-audit's own threads: a reply, optionally resolving it. */
export interface FollowUpPost {
  thread: PriorThread;
  body: string;
  resolve: boolean;
}

export interface GitProvider {
  readonly name: string;
  readonly reviewTerm: string;

  fetchPr(ref: PrRef): PrData;
  /** Clone the repo into `dir` with the provider's CLI (so private repos work with its auth). */
  cloneRepo(ref: PrRef, dir: string): void;
  /** An issue's content, or null if it doesn't exist or is a PR. `closes` is filled in by the caller. */
  fetchIssue(issue: IssueRef): Omit<LinkedIssue, 'closes'> | null;

  /** Post the review: the summary, the verdict, and inline findings on their lines. */
  postReview(ref: PrRef, headSha: string, review: ReviewPost, dryRun?: boolean): void;
  /** Whether this general finding can be its own thread here; the rest go in the review body. */
  threadsGeneralFinding(finding: Finding, prPaths: string[]): boolean;
  /** Post a general finding as its own thread (before the review). Throws on failure; the caller moves it to the body. */
  postGeneralThread(ref: PrRef, headSha: string, finding: Finding, dryRun?: boolean): void;

  /**
   * Report that no review was produced (e.g. the agent's usage limit was hit):
   * a plain comment, plus a neutral status where the platform supports one.
   */
  reportSkipped(ref: PrRef, headSha: string, title: string, body: string, dryRun?: boolean): void;

  /**
   * Incremental reviews (optional; providers without them always review the full diff):
   * what earlier pr-audit reviews covered and left open.
   */
  fetchReviewHistory?(ref: PrRef): ReviewHistory;
  /** Reply to (and resolve) pr-audit's own earlier threads. */
  applyFollowUps?(ref: PrRef, posts: FollowUpPost[], dryRun?: boolean): void;
}

interface ResolvedProvider {
  provider: GitProvider;
  ref: PrRef;
}

const URL_MATCHERS: Array<{
  pattern: RegExp;
  providerKey: string;
  extract: (match: RegExpMatchArray) => PrRef;
}> = [
  {
    pattern: /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/,
    providerKey: 'github',
    extract: (m) => ({ slug: m[1], number: parseInt(m[2], 10) }),
  },
  {
    pattern: /https?:\/\/[^/]+\/((?:[^/]+\/)+[^/]+)\/-\/merge_requests\/(\d+)/,
    providerKey: 'gitlab',
    extract: (m) => ({ slug: m[1], number: parseInt(m[2], 10) }),
  },
];

const SHORTHAND_MATCHERS: Array<{
  pattern: RegExp;
  providerKey: string;
  extract: (match: RegExpMatchArray) => PrRef;
}> = [
  {
    pattern: /^([^/]+\/[^#]+)#(\d+)$/,
    providerKey: 'github',
    extract: (m) => ({ slug: m[1], number: parseInt(m[2], 10) }),
  },
  {
    pattern: /^(.+)!(\d+)$/,
    providerKey: 'gitlab',
    extract: (m) => ({ slug: m[1], number: parseInt(m[2], 10) }),
  },
];

function createProvider(key: string): GitProvider {
  switch (key) {
    case 'github':
      return new GitHubProvider();
    case 'gitlab':
      return new GitLabProvider();
    default:
      throw new Error(`Unsupported provider: "${key}". Supported: github, gitlab`);
  }
}

export function resolveProvider(arg: string, hint?: string): ResolvedProvider {
  for (const { pattern, providerKey, extract } of URL_MATCHERS) {
    const match = arg.match(pattern);
    if (match) {
      const key = hint || providerKey;
      return { provider: createProvider(key), ref: extract(match) };
    }
  }

  for (const { pattern, providerKey, extract } of SHORTHAND_MATCHERS) {
    const match = arg.match(pattern);
    if (match) {
      const key = hint || providerKey;
      return { provider: createProvider(key), ref: extract(match) };
    }
  }

  throw new Error(
    `Invalid reference: "${arg}"\n` +
    'Supported formats:\n' +
    '  GitHub:  owner/repo#123  or  https://github.com/owner/repo/pull/123\n' +
    '  GitLab:  group/project!123  or  https://gitlab.com/group/project/-/merge_requests/123',
  );
}
