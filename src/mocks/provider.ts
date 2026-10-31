import type { FollowUpPost, GitProvider } from '../provider.js';
import type { Finding, IssueRef, LinkedIssue, PrRef, PrData, ReviewPost } from '../types.js';
import { EMPTY_HISTORY, type ReviewHistory } from '../review-history.js';

export interface MockReviewCall {
  ref: PrRef;
  headSha: string;
  review: ReviewPost;
  dryRun: boolean;
}

const DEFAULT_PR_DATA: PrData = {
  title: 'Mock PR',
  body: 'Mock PR description.',
  url: 'https://example.com/test/repo/pull/1',
  headSha: 'head000',
  baseSha: 'base000',
  baseRef: 'main',
  headRef: 'feature',
  commits: ['Add b'],
  closingIssues: [],
};

export class MockProvider implements GitProvider {
  readonly name = 'Mock';
  readonly reviewTerm = 'pull request';
  readonly reviewCalls: MockReviewCall[] = [];
  readonly skipCalls: { ref: PrRef; headSha: string; title: string; body: string; dryRun: boolean }[] = [];
  readonly followUpCalls: FollowUpPost[][] = [];
  readonly threadCalls: Finding[] = [];
  /** Bodies of general findings whose thread post fails. */
  failThreads = new Set<string>();

  constructor(
    private prData: PrData = DEFAULT_PR_DATA,
    private history: ReviewHistory = EMPTY_HISTORY,
    private issues: Omit<LinkedIssue, 'closes'>[] = [],
  ) {}

  fetchPr(_ref: PrRef): PrData {
    return this.prData;
  }

  cloneRepo(_ref: PrRef, _dir: string): void {
    throw new Error('MockProvider cannot clone');
  }

  fetchIssue(issue: IssueRef): Omit<LinkedIssue, 'closes'> | null {
    return this.issues.find((i) => i.ref.slug === issue.slug && i.ref.number === issue.number) ?? null;
  }

  threadsGeneralFinding(finding: Finding, prPaths: string[]): boolean {
    return !!finding.path && prPaths.includes(finding.path);
  }

  postGeneralThread(_ref: PrRef, _headSha: string, finding: Finding): void {
    if (this.failThreads.has(finding.body)) throw new Error('HTTP 422');
    this.threadCalls.push(finding);
  }

  postReview(ref: PrRef, headSha: string, review: ReviewPost, dryRun = false): void {
    this.reviewCalls.push({ ref, headSha, review, dryRun });
  }

  reportSkipped(ref: PrRef, headSha: string, title: string, body: string, dryRun = false): void {
    this.skipCalls.push({ ref, headSha, title, body, dryRun });
  }

  fetchReviewHistory(_ref: PrRef): ReviewHistory {
    return this.history;
  }

  applyFollowUps(_ref: PrRef, posts: FollowUpPost[]): void {
    this.followUpCalls.push(posts);
  }
}
