import { describe, it, expect } from 'vitest';
import './setup.js';
import {
  findingTag,
  generalMarker,
  isPrAuditComment,
  openThreads,
  parseGeneralMarker,
  parseReviewMarker,
  renderClosedThreads,
  renderOpenThreads,
  reviewMarker,
  threadSeverity,
  type PriorThread,
} from '../src/review-history.js';

const thread = (path: string, body: string, state: Partial<PriorThread> = {}): PriorThread => ({
  id: '1', path, line: 1, body, replies: [], resolved: false, outdated: false, ...state,
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

describe('general marker', () => {
  it('round-trips body findings, keeping only severity, kind and text', () => {
    const body = `Summary\n\n${generalMarker([{ path: null, line: null, severity: 'warning', kind: 'requirement', body: 'CSV export (#12) is missing' }])}`;
    expect(parseGeneralMarker(body)).toEqual([{ path: null, line: null, severity: 'warning', kind: 'requirement', body: 'CSV export (#12) is missing' }]);
  });

  it('ignores missing or garbled markers', () => {
    expect(parseGeneralMarker('no marker')).toEqual([]);
    expect(parseGeneralMarker('<!-- pr-audit:general=bm90IGpzb24= -->')).toEqual([]);
  });
});

describe('finding tags', () => {
  it('tags findings with severity and kind', () => {
    expect(findingTag({ severity: 'warning', kind: 'question' })).toBe('**[warning · question]**');
  });

  it('recognises current and severity-only (older) tags', () => {
    expect(isPrAuditComment('**[warning · question]** does this handle retries?')).toBe(true);
    expect(isPrAuditComment('**[critical]** SQL injection')).toBe(true);
    expect(isPrAuditComment('**[note]** something')).toBe(false);
    expect(isPrAuditComment('Thanks, fixed')).toBe(false);
    expect(threadSeverity({ body: '**[critical · security]** x' })).toBe('critical');
    expect(threadSeverity({ body: '**[warning]** x' })).toBe('warning');
  });
});

describe('earlier threads', () => {
  const threads = [
    thread('a.ts', '**[critical · bug]** open one. More detail.'),
    thread('a.ts', '**[critical]** resolved one. More.', { resolved: true }),
    thread('a.ts', '**[warning]** outdated one.', { outdated: true }),
    thread('gone.ts', '**[critical]** file no longer in the PR'),
  ];

  it('keeps open threads on files still in the PR', () => {
    expect(openThreads(threads, ['a.ts']).map((t) => t.body)).toEqual(['**[critical · bug]** open one. More detail.']);
  });

  it('renders open threads in full with ids and the last replies', () => {
    const t = thread('a.ts', `**[warning · bug]** ${'x'.repeat(2000)}`, {
      replies: [1, 2, 3, 4, 5, 6].map((n) => ({ author: 'dev', body: `reply ${n}\nsecond line` })),
    });
    const out = renderOpenThreads([{ id: 'T1', thread: t }]);
    expect(out.startsWith('- T1 a.ts:1: **[warning · bug]** xxx')).toBe(true);
    expect(out).toContain('…');
    expect(out).not.toContain('reply 1');
    expect(out).toContain('↳ dev: reply 6 second line');
  });

  it('lists resolved and outdated threads as one-liners', () => {
    expect(renderClosedThreads(threads, ['a.ts'])).toBe('- a.ts:1 (resolved) resolved one.\n- a.ts:1 (outdated) outdated one.');
  });
});
