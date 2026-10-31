import type { ReviewEngine, SessionRequest, SessionResult } from '../engine.js';
import type { ReviewSessionOutput, SessionUsage, VerifySessionOutput } from '../types.js';

const DEFAULT_REVIEW: ReviewSessionOutput = {
  summary: 'Mock review: no issues found.',
  findings: [],
  follow_ups: [],
};

const DEFAULT_VERIFY: VerifySessionOutput = { findings: [], follow_ups: [] };

const DEFAULT_USAGE: SessionUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUSD: null,
  durationMs: 1000,
};

/** A canned session answer, or an error the session throws. */
export type MockAnswer = ReviewSessionOutput | VerifySessionOutput | Error;

/**
 * Answers sessions from per-label queues ("review", "verification"); an empty queue
 * falls back to an empty review / a verification that decides nothing.
 */
export class MockEngine implements ReviewEngine {
  readonly name = 'Mock';
  readonly defaultModel = 'mock-model';
  readonly effort = 'medium';
  readonly calls: SessionRequest[] = [];

  constructor(private answers: Record<string, MockAnswer[]> = {}) {}

  run<T>(req: SessionRequest): SessionResult<T> {
    if (req.label !== 'review' && req.label !== 'verification') throw new Error(`MockEngine: unknown session label "${req.label}"`);
    this.calls.push(req);
    const next = this.answers[req.label]?.shift();
    if (next instanceof Error) throw next;
    const output = next ?? (req.label === 'review' ? DEFAULT_REVIEW : DEFAULT_VERIFY);
    return { output: structuredClone(output) as T, usage: DEFAULT_USAGE };
  }
}
