import { describe, it, expect } from 'vitest';
import './setup.js';
import {
  countOpenFindings,
  holdForOpenFindings,
  isPrAuditComment,
  parseReviewMarker,
  renderPriorThreads,
  reviewMarker,
  type PriorThread,
} from '../src/review-history.js';

const thread = (path: string, body: string, state: Partial<PriorThread> = {}): PriorThread => ({
  path, line: 1, body, replies: [], resolved: false, outdated: false, ...state,
});

describe('review marker', () => {
  it('round-trips the head SHA through a review body', () => {
    const sha = 'af3323278397bbad2f63bbc3444c1b4e2c556b7c';
    expect(parseReviewMarker(`Looks good.\n\n${reviewMarker(sha)}`)).toBe(sha);
  });

  it('returns null without a marker', () => {
    expect(parseReviewMarker('Looks good.')).toBeNull();
    expect(parseReviewMarker(null)).toBeNull();
  });
});

describe('isPrAuditComment', () => {
  it('matches pr-audit severity tags only', () => {
    expect(isPrAuditComment('**[critical]** SQL injection')).toBe(true);
    expect(isPrAuditComment('**[note]** something')).toBe(false);
    expect(isPrAuditComment('Thanks, fixed')).toBe(false);
  });
});

describe('renderPriorThreads', () => {
  it('flattens and clips long bodies, keeping the last replies', () => {
    const out = renderPriorThreads(
      [{
        path: 'a.ts',
        line: null,
        body: `**[warning]** ${'x'.repeat(400)}`,
        replies: [1, 2, 3, 4].map((n) => ({ author: 'dev', body: `reply ${n}\nsecond line` })),
        resolved: false,
        outdated: true,
      }],
      ['a.ts'],
    );
    expect(out.startsWith('- a.ts (outdated) **[warning]** xxx')).toBe(true);
    expect(out).toContain('…');
    expect(out).not.toContain('reply 1');
    expect(out).toContain('↳ dev: reply 4 second line');
  });

  it('returns empty when no thread touches the files', () => {
    expect(renderPriorThreads([thread('a.ts', 'b')], ['b.ts'])).toBe('');
  });
});

describe('open findings', () => {
  const threads = [
    thread('a.ts', '**[critical]** open'),
    thread('a.ts', '**[critical]** resolved', { resolved: true }),
    thread('a.ts', '**[critical]** outdated', { outdated: true }),
    thread('a.ts', '**[warning]** open'),
    thread('a.ts', '**[suggestion]** open'),
    thread('gone.ts', '**[critical]** file no longer in the PR'),
  ];

  it('counts only open critical/warning threads on the given files', () => {
    expect(countOpenFindings(threads, ['a.ts'])).toEqual({ critical: 1, warning: 1 });
    expect(renderPriorThreads(threads, ['a.ts'])).toContain('- a.ts:1 (resolved) **[critical]** resolved');
  });

  it('holds APPROVE back while earlier findings are open', () => {
    expect(holdForOpenFindings('APPROVE', { critical: 1, warning: 2 })).toEqual({
      verdict: 'REQUEST_CHANGES',
      note: '3 earlier finding(s) still open (1 critical, 2 warning). Resolve those threads, or push a fix that changes the lines they point at.',
    });
    expect(holdForOpenFindings('APPROVE', { critical: 0, warning: 1 }).verdict).toBe('COMMENT');
    expect(holdForOpenFindings('REQUEST_CHANGES', { critical: 0, warning: 1 }).verdict).toBe('REQUEST_CHANGES');
    expect(holdForOpenFindings('APPROVE', { critical: 0, warning: 0 })).toEqual({ verdict: 'APPROVE', note: null });
  });
});
