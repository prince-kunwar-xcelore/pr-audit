import { describe, it, expect } from 'vitest';
import './setup.js';
import { isPrAuditComment, parseReviewMarker, renderPriorThreads, reviewMarker } from '../src/review-history.js';

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
      }],
      ['a.ts'],
    );
    expect(out.startsWith('- a.ts **[warning]** xxx')).toBe(true);
    expect(out).toContain('…');
    expect(out).not.toContain('reply 1');
    expect(out).toContain('↳ dev: reply 4 second line');
  });

  it('returns empty when no thread touches the files', () => {
    expect(renderPriorThreads([{ path: 'a.ts', line: 1, body: 'b', replies: [] }], ['b.ts'])).toBe('');
  });
});
