import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import { GitHubProvider } from '../../src/providers/github.js';

const mockExec = vi.mocked(execSync);
const ref = { slug: 'owner/repo', number: 7 };

function payload(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as { input: Buffer }).input.toString());
}

describe('GitHubProvider.reportSkipped', () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockExec.mockReturnValue('{}');
  });

  it('posts a PR comment and a neutral check run on the head commit', () => {
    new GitHubProvider().reportSkipped(ref, 'sha1', 'AI review skipped', 'quota');

    expect(mockExec.mock.calls[0][0]).toBe('gh api --method POST /repos/owner/repo/issues/7/comments --input -');
    expect(payload(mockExec.mock.calls[0])).toEqual({ body: 'quota' });
    expect(mockExec.mock.calls[1][0]).toBe('gh api --method POST /repos/owner/repo/check-runs --input -');
    expect(payload(mockExec.mock.calls[1])).toMatchObject({ head_sha: 'sha1', conclusion: 'neutral', status: 'completed' });
  });

  it('tolerates a missing checks permission', () => {
    mockExec.mockReturnValueOnce('{}').mockImplementationOnce(() => { throw new Error('403'); });
    expect(() => new GitHubProvider().reportSkipped(ref, 'sha1', 't', 'b')).not.toThrow();
  });

  it('posts nothing in dry-run', () => {
    new GitHubProvider().reportSkipped(ref, 'sha1', 't', 'b', true);
    expect(mockExec).not.toHaveBeenCalled();
  });
});
