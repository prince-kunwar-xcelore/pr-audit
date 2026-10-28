import type { ReviewEngine } from '../engine.js';
import type { BatchResult, ReviewOutput, TokenUsage } from '../types.js';

export interface MockCall {
  method: 'review' | 'synthesize';
  prompt: string;
  model: string;
}

const DEFAULT_REVIEW: ReviewOutput = {
  summary: 'Mock review: no issues found.',
  verdict: 'APPROVE',
  comments: [],
};

const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUSD: 0,
};

export class MockEngine implements ReviewEngine {
  readonly name = 'Mock';
  readonly defaultModel = 'mock-model';
  readonly effort = 'medium';
  readonly calls: MockCall[] = [];

  constructor(
    private reviewResult: BatchResult = { review: DEFAULT_REVIEW, usage: DEFAULT_USAGE },
    private synthesizeResult = 'Mock synthesis summary.',
  ) {}

  review(prompt: string, model: string): BatchResult {
    this.calls.push({ method: 'review', prompt, model });
    return this.reviewResult;
  }

  synthesize(prompt: string, model: string): string {
    this.calls.push({ method: 'synthesize', prompt, model });
    return this.synthesizeResult;
  }
}
