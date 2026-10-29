import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { GitHubProvider } from '../../src/providers/github.js';

const mockExec = vi.mocked(execFileSync);

/** The command line a mocked call would have run, for readable assertions. */
function cmd(call: unknown[]): string {
  return [call[0] as string, ...(call[1] as string[])].join(' ');
}
const ref = { slug: 'owner/repo', number: 7 };

function payload(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[2] as { input: Buffer }).input.toString());
}

describe('GitHubProvider.reportSkipped', () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockExec.mockReturnValue('{}');
  });

  it('posts a PR comment and a neutral check run on the head commit', () => {
    new GitHubProvider().reportSkipped(ref, 'sha1', 'AI review skipped', 'quota');

    expect(cmd(mockExec.mock.calls[0])).toBe('gh api --method POST /repos/owner/repo/issues/7/comments --input -');
    expect(payload(mockExec.mock.calls[0])).toEqual({ body: 'quota' });
    expect(cmd(mockExec.mock.calls[1])).toBe('gh api --method POST /repos/owner/repo/check-runs --input -');
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

describe('GitHubProvider.postReview', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('falls back to a COMMENT review when Actions may not approve', () => {
    mockExec
      .mockImplementationOnce(() => {
        const err = new Error('Command failed') as Error & { stdout: string };
        err.stdout = '{"message":"Unprocessable Entity","errors":["GitHub Actions is not permitted to approve pull requests."]}';
        throw err;
      })
      .mockReturnValueOnce('{}');

    new GitHubProvider().postReview(ref, 'sha1', { summary: 'LGTM', verdict: 'APPROVE', comments: [] }, []);

    expect(mockExec).toHaveBeenCalledTimes(2);
    const retry = payload(mockExec.mock.calls[1]);
    expect(retry.event).toBe('COMMENT');
    expect(retry.body).toMatch(/Approved by AI review[\s\S]*LGTM/);
  });

  it('does not retry other failures', () => {
    mockExec.mockImplementationOnce(() => { throw Object.assign(new Error('boom'), { stdout: '{"message":"Not Found"}' }); });
    expect(() => new GitHubProvider().postReview(ref, 'sha1', { summary: 's', verdict: 'APPROVE', comments: [] }, [])).toThrow('boom');
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

describe('GitHubProvider.fetchPr', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('passes the slug as a single argument, never through a shell', () => {
    mockExec.mockReturnValueOnce('{"title":"t","body":"","headRefOid":"sha1"}').mockReturnValueOnce('');
    new GitHubProvider().fetchPr({ slug: 'owner/repo;touch pwned', number: 7 });

    expect(mockExec.mock.calls[0][0]).toBe('gh');
    expect(mockExec.mock.calls[0][1]).toEqual(['pr', 'view', '7', '--repo', 'owner/repo;touch pwned', '--json', 'title,body,headRefOid']);
    expect(mockExec.mock.calls[1][1]).toEqual(['pr', 'diff', '7', '--repo', 'owner/repo;touch pwned']);
  });
});
