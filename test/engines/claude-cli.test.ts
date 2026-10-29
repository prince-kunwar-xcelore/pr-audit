import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { ClaudeCliEngine } from '../../src/engines/claude-cli.js';
import { AgentAuthError } from '../../src/engine.js';

const mockExec = vi.mocked(execFileSync);

function failWith(stdout: string, stderr = ''): void {
  mockExec.mockImplementation(() => {
    throw Object.assign(new Error('Command failed: claude -p'), { stdout, stderr });
  });
}

describe('ClaudeCliEngine failures', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('reads the reason from an error envelope', () => {
    failWith(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }));
    expect(() => new ClaudeCliEngine().review('prompt', 'm')).toThrow(AgentAuthError);
  });

  it('ignores the result of a non-error envelope, which can quote the diff', () => {
    failWith(JSON.stringify({ is_error: false, result: 'The diff handles "Not logged in" and "usage limit reached"' }));
    expect(() => new ClaudeCliEngine().review('prompt', 'm')).toThrow('Command failed: claude -p');
  });

  it('falls back to raw output when stdout is not an envelope', () => {
    failWith('', 'Invalid API key · Please run /login');
    expect(() => new ClaudeCliEngine().review('prompt', 'm')).toThrow(AgentAuthError);
  });
});
