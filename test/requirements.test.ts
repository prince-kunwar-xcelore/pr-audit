import { describe, it, expect } from 'vitest';
import './setup.js';
import { findIssueMentions, scanBranch, scanText, trimIssue } from '../src/requirements.js';
import type { PrData } from '../src/types.js';

const slug = 'owner/repo';

describe('scanText', () => {
  it('finds same-repo, cross-repo and URL references', () => {
    expect(scanText('See #12, other/lib#3 and https://github.com/a/b/issues/9', slug)).toEqual([
      { ref: { slug, number: 12 }, closes: false },
      { ref: { slug: 'other/lib', number: 3 }, closes: false },
      { ref: { slug: 'a/b', number: 9 }, closes: false },
    ]);
  });

  it('marks references after a closing keyword', () => {
    expect(scanText('Closes #12. Fixes: #13, resolved other/lib#4. Part of #14', slug)).toEqual([
      { ref: { slug, number: 12 }, closes: true },
      { ref: { slug, number: 13 }, closes: true },
      { ref: { slug: 'other/lib', number: 4 }, closes: true },
      { ref: { slug, number: 14 }, closes: false },
    ]);
  });

  it('reads GitLab issue URLs, nested groups included', () => {
    expect(scanText('https://gitlab.com/group/sub/project/-/issues/7', 'group/sub/project')).toEqual([
      { ref: { slug: 'group/sub/project', number: 7 }, closes: false },
    ]);
  });

  it('ignores anchors and HTML entities that look like references', () => {
    expect(scanText('see docs/page#3 and &#39; and color #fff', slug)).toEqual([
      // docs/page#3 is a valid cross-repo form; the fetch decides whether it exists
      { ref: { slug: 'docs/page', number: 3 }, closes: false },
    ]);
  });
});

describe('scanBranch', () => {
  it('reads issue numbers from common branch names', () => {
    expect(scanBranch('12-csv-export', slug)).toEqual([{ ref: { slug, number: 12 }, closes: false }]);
    expect(scanBranch('fix/34-login', slug)).toEqual([{ ref: { slug, number: 34 }, closes: false }]);
    expect(scanBranch('issue-56', slug)).toEqual([{ ref: { slug, number: 56 }, closes: false }]);
    expect(scanBranch('feature/login', slug)).toEqual([]);
  });
});

describe('findIssueMentions', () => {
  const pr: PrData = {
    title: 'CSV export (#12)',
    body: 'Closes #12\nRelated: #20',
    url: 'u',
    headSha: 'h',
    baseSha: 'b',
    baseRef: 'main',
    headRef: '12-csv',
    commits: ['Add CSV writer\n\nRefs #21'],
    closingIssues: [{ slug, number: 30 }],
  };

  it('merges provider links and text mentions, closing if any source says so', () => {
    expect(findIssueMentions(pr, slug)).toEqual([
      { ref: { slug, number: 30 }, closes: true },
      { ref: { slug, number: 12 }, closes: true },
      { ref: { slug, number: 20 }, closes: false },
      { ref: { slug, number: 21 }, closes: false },
    ]);
  });
});

describe('trimIssue', () => {
  it('clips long bodies and keeps the last comments', () => {
    const issue = trimIssue({
      ref: { slug, number: 1 },
      url: 'u',
      title: 't',
      body: 'x'.repeat(5000),
      state: 'open',
      closes: false,
      comments: Array.from({ length: 15 }, (_, i) => ({ author: 'a', body: `c${i}` })),
    });
    expect(issue.body.length).toBeLessThan(4100);
    expect(issue.body).toContain('[… truncated]');
    expect(issue.comments.map((c) => c.body)).toEqual(['c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'c13', 'c14']);
  });
});
