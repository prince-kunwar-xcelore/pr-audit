import { describe, it, expect } from 'vitest';
import './setup.js';
import { detectUsageLimit, UsageLimitError } from '../src/engine.js';

describe('detectUsageLimit', () => {
  it('detects the Codex message and its reset time', () => {
    const err = detectUsageLimit(
      'Codex CLI',
      '{"type":"error","message":"You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 5:31 PM."}',
    );
    expect(err).toBeInstanceOf(UsageLimitError);
    expect(err?.resetsAt).toBe('5:31 PM');
    expect(err?.message).toBe('Codex CLI usage limit reached — resets 5:31 PM');
  });

  it('detects Claude messages', () => {
    expect(detectUsageLimit('Claude CLI', 'Claude AI usage limit reached|1793197200')?.resetsAt).toBe(
      new Date(1793197200 * 1000).toISOString(),
    );
    expect(detectUsageLimit('Claude CLI', 'You’ve hit your limit · resets 3pm (Asia/Kolkata)')?.resetsAt).toBe('3pm (Asia/Kolkata)');
  });

  it('ignores transient rate limits and other errors', () => {
    expect(detectUsageLimit('Claude CLI', 'API Error: 429 rate_limit_error: Number of requests exceeded')).toBeNull();
    expect(detectUsageLimit('Codex CLI', 'Selected model is at capacity. Please try a different model.')).toBeNull();
  });
});
