import type { PrRef, PrData, ReviewComment, ReviewOutput } from './types.js';
import { GitHubProvider } from './providers/github.js';
import { GitLabProvider } from './providers/gitlab.js';

export interface GitProvider {
  readonly name: string;
  readonly reviewTerm: string;

  fetchPr(ref: PrRef): PrData;
  postReview(
    ref: PrRef,
    headSha: string,
    review: ReviewOutput,
    comments: ReviewComment[],
    dryRun?: boolean,
  ): void;

  /**
   * Report that no review was produced (e.g. the agent's usage limit was hit):
   * a plain comment, plus a neutral status where the platform supports one.
   */
  reportSkipped(ref: PrRef, headSha: string, title: string, body: string, dryRun?: boolean): void;
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
