import { describe, it, expect } from 'vitest';
import './setup.js';
import { buildPrompt, buildSynthesisPrompt, mergeResults, OUTPUT_SCHEMA } from '../src/claude.js';
import { parseDiffString } from '../src/diff.js';
import type { PrData, BatchResult } from '../src/types.js';

const PR_DATA: PrData = {
  title: 'Add user validation',
  body: 'Adds input validation to the user creation endpoint.',
  headSha: 'abc123',
  diff: '',
};

const SIMPLE_DIFF = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;

describe('buildPrompt', () => {
  it('has no incremental or already-discussed sections by default', () => {
    const prompt = buildPrompt(PR_DATA, parseDiffString(SIMPLE_DIFF), 'pull request');
    expect(prompt).not.toContain('since the last review');
    expect(prompt).not.toContain('Already discussed');
  });

  it('describes an incremental diff and lists earlier threads on the batch files only', () => {
    const prompt = buildPrompt(PR_DATA, parseDiffString(SIMPLE_DIFF), 'pull request', {
      sinceSha: '0123456789abcdef',
      priorThreads: [
        { path: 'file.ts', line: 2, body: '**[warning]** b is unused', replies: [{ author: 'dev', body: 'Intended, used later' }] },
        { path: 'other.ts', line: 1, body: '**[critical]** elsewhere', replies: [] },
      ],
    });
    expect(prompt).toContain('only the changes pushed since the last review (commit 0123456)');
    expect(prompt).toContain('- file.ts:2 **[warning]** b is unused\n    ↳ dev: Intended, used later');
    expect(prompt).not.toContain('elsewhere');
  });

  it('includes PR title and description', () => {
    const files = parseDiffString(SIMPLE_DIFF);
    const prompt = buildPrompt(PR_DATA, files, 'pull request');
    expect(prompt).toContain('PR Title: Add user validation');
    expect(prompt).toContain('Adds input validation');
  });

  it('includes diff content', () => {
    const files = parseDiffString(SIMPLE_DIFF);
    const prompt = buildPrompt(PR_DATA, files, 'pull request');
    expect(prompt).toContain('+const b = 2;');
  });

  it('includes system rules with review term', () => {
    const files = parseDiffString(SIMPLE_DIFF);
    const prompt = buildPrompt(PR_DATA, files, 'merge request');
    expect(prompt).toContain('reviewing a merge request');
  });

  it('handles empty PR body', () => {
    const files = parseDiffString(SIMPLE_DIFF);
    const prompt = buildPrompt({ ...PR_DATA, body: '' }, files, 'pull request');
    expect(prompt).toContain('(none)');
  });
});

describe('buildSynthesisPrompt', () => {
  it('includes batch summaries', () => {
    const prompt = buildSynthesisPrompt('My PR', ['batch 1 summary', 'batch 2 summary'], 'APPROVE');
    expect(prompt).toContain('[Batch 1]: batch 1 summary');
    expect(prompt).toContain('[Batch 2]: batch 2 summary');
  });

  it('includes verdict', () => {
    const prompt = buildSynthesisPrompt('My PR', ['summary'], 'REQUEST_CHANGES');
    expect(prompt).toContain('Overall verdict: REQUEST_CHANGES');
  });

  it('includes PR title', () => {
    const prompt = buildSynthesisPrompt('Feature: auth', ['summary'], 'APPROVE');
    expect(prompt).toContain('PR Title: Feature: auth');
  });

  it('uses custom review term', () => {
    const prompt = buildSynthesisPrompt('My MR', ['s'], 'APPROVE', 'merge request');
    expect(prompt).toContain('merge request');
  });

  it('defaults review term to pull request', () => {
    const prompt = buildSynthesisPrompt('My PR', ['s'], 'APPROVE');
    expect(prompt).toContain('pull request');
  });
});

describe('mergeResults', () => {
  function makeBatch(verdict: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES', summary: string, comments: BatchResult['review']['comments'] = []): BatchResult {
    return {
      review: { summary, verdict, comments },
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5, costUSD: 0.01 },
    };
  }

  it('uses highest-priority verdict (REQUEST_CHANGES > COMMENT > APPROVE)', () => {
    const result = mergeResults([
      makeBatch('APPROVE', 'all good'),
      makeBatch('REQUEST_CHANGES', 'found issues'),
      makeBatch('COMMENT', 'minor notes'),
    ]);
    expect(result.review.verdict).toBe('REQUEST_CHANGES');
  });

  it('merges to COMMENT when no REQUEST_CHANGES', () => {
    const result = mergeResults([
      makeBatch('APPROVE', 'ok'),
      makeBatch('COMMENT', 'fyi'),
    ]);
    expect(result.review.verdict).toBe('COMMENT');
  });

  it('keeps APPROVE when all approve', () => {
    const result = mergeResults([
      makeBatch('APPROVE', 'ok1'),
      makeBatch('APPROVE', 'ok2'),
    ]);
    expect(result.review.verdict).toBe('APPROVE');
  });

  it('concatenates summaries', () => {
    const result = mergeResults([
      makeBatch('APPROVE', 'first'),
      makeBatch('APPROVE', 'second'),
    ]);
    expect(result.review.summary).toBe('first\n\nsecond');
  });

  it('collects all comments across batches', () => {
    const result = mergeResults([
      makeBatch('COMMENT', 'a', [{ path: 'a.ts', line: 1, severity: 'warning', body: 'w1' }]),
      makeBatch('COMMENT', 'b', [{ path: 'b.ts', line: 2, severity: 'critical', body: 'c1' }]),
    ]);
    expect(result.review.comments).toHaveLength(2);
  });

  it('aggregates token usage', () => {
    const result = mergeResults([
      makeBatch('APPROVE', 'a'),
      makeBatch('APPROVE', 'b'),
    ]);
    expect(result.totalUsage.inputTokens).toBe(200);
    expect(result.totalUsage.outputTokens).toBe(100);
    expect(result.totalUsage.cacheReadTokens).toBe(20);
    expect(result.totalUsage.cacheCreationTokens).toBe(10);
    expect(result.totalUsage.costUSD).toBeCloseTo(0.02);
  });

  it('handles single batch', () => {
    const result = mergeResults([makeBatch('APPROVE', 'only one')]);
    expect(result.review.verdict).toBe('APPROVE');
    expect(result.review.summary).toBe('only one');
  });
});

describe('OUTPUT_SCHEMA', () => {
  it('is valid JSON', () => {
    expect(() => JSON.parse(OUTPUT_SCHEMA)).not.toThrow();
  });

  it('requires summary, verdict, and comments', () => {
    const schema = JSON.parse(OUTPUT_SCHEMA);
    expect(schema.required).toEqual(['summary', 'verdict', 'comments']);
  });
});
