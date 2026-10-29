import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { GitLabProvider } from '../../src/providers/gitlab.js';

const mockExec = vi.mocked(execFileSync);

/** The command line a mocked call would have run, for readable assertions. */
function cmd(call: unknown[]): string {
  return [call[0] as string, ...(call[1] as string[])].join(' ');
}

const MR_META = {
  title: 'Test MR',
  description: 'A test MR',
  diff_refs: {
    base_sha: 'base-sha',
    start_sha: 'start-sha',
    head_sha: 'head-sha',
  },
};

function setupProvider(slug = 'group/project', number = 1): GitLabProvider {
  const provider = new GitLabProvider();
  mockExec
    .mockReturnValueOnce(JSON.stringify(MR_META))
    .mockReturnValueOnce('diff content');
  provider.fetchPr({ slug, number });
  mockExec.mockClear();
  mockExec.mockReturnValue('{}');
  return provider;
}

function getPayload(call: unknown[]): { body: string; position?: object } {
  const options = call[2] as { input: Buffer };
  return JSON.parse(options.input.toString());
}

describe('GitLabProvider', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  describe('fetchPr', () => {
    it('calls glab mr view and glab mr diff with the correct flags', () => {
      const provider = new GitLabProvider();
      mockExec
        .mockReturnValueOnce(JSON.stringify(MR_META))
        .mockReturnValueOnce('diff content');

      const result = provider.fetchPr({ slug: 'group/project', number: 1 });

      expect(cmd(mockExec.mock.calls[0])).toBe('glab mr view 1 -R group/project --output json');
      expect(cmd(mockExec.mock.calls[1])).toBe('glab mr diff 1 -R group/project');
      expect(result.title).toBe('Test MR');
      expect(result.body).toBe('A test MR');
      expect(result.headSha).toBe('head-sha');
      expect(result.diff).toBe('diff content');
      expect(result.providerMeta).toEqual({
        baseSha: 'base-sha',
        startSha: 'start-sha',
      });
    });

    it('treats null description as empty body', () => {
      const provider = new GitLabProvider();
      mockExec
        .mockReturnValueOnce(JSON.stringify({ ...MR_META, description: null }))
        .mockReturnValueOnce('');
      expect(provider.fetchPr({ slug: 'g/p', number: 1 }).body).toBe('');
    });

    it('throws when MR is missing diff_refs', () => {
      const provider = new GitLabProvider();
      mockExec.mockReturnValueOnce(JSON.stringify({ title: 'orphan' }));
      expect(() => provider.fetchPr({ slug: 'g/p', number: 1 })).toThrow('missing diff_refs');
    });
  });

  describe('postReview', () => {
    it('throws when called before fetchPr', () => {
      const provider = new GitLabProvider();
      expect(() =>
        provider.postReview(
          { slug: 'g/p', number: 1 },
          'sha',
          { summary: '', verdict: 'COMMENT', comments: [] },
          [],
        ),
      ).toThrow('called before fetchPr');
    });

    it("sends 'Content-Type: application/json' on every API call", () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'ok', verdict: 'APPROVE', comments: [] },
        [{ path: 'a.ts', line: 5, severity: 'warning', body: 'bug' }],
      );

      expect(mockExec).toHaveBeenCalled();
      for (const call of mockExec.mock.calls) {
        expect(call[1]).toEqual(expect.arrayContaining(['-H', 'Content-Type: application/json']));
      }
    });

    it('URL-encodes nested group slugs in the API path', () => {
      const provider = setupProvider('group/subgroup/project', 7);

      provider.postReview(
        { slug: 'group/subgroup/project', number: 7 },
        'head-sha',
        { summary: 'ok', verdict: 'COMMENT', comments: [] },
        [],
      );

      expect(cmd(mockExec.mock.calls[0])).toContain('projects/group%2Fsubgroup%2Fproject/merge_requests/7');
    });

    it('builds discussion position object from cached diff refs', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: '', verdict: 'COMMENT', comments: [] },
        [{ path: 'a.ts', line: 5, severity: 'warning', body: 'bug' }],
      );

      const payload = getPayload(mockExec.mock.calls[0]);
      expect(payload.body).toBe('**[warning]** bug');
      expect(payload.position).toEqual({
        base_sha: 'base-sha',
        start_sha: 'start-sha',
        head_sha: 'head-sha',
        position_type: 'text',
        new_path: 'a.ts',
        new_line: 5,
      });
    });

    it('calls /approve when verdict is APPROVE', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'lgtm', verdict: 'APPROVE', comments: [] },
        [],
      );

      const endpoints = mockExec.mock.calls.map((c) => cmd(c));
      expect(endpoints.some((e) => e.includes('/approve'))).toBe(true);
    });

    it('does NOT call /approve when verdict is COMMENT', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'feedback', verdict: 'COMMENT', comments: [] },
        [],
      );

      const endpoints = mockExec.mock.calls.map((c) => cmd(c));
      expect(endpoints.some((e) => e.includes('/approve'))).toBe(false);
    });

    it('does NOT call /approve when verdict is REQUEST_CHANGES', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'needs work', verdict: 'REQUEST_CHANGES', comments: [] },
        [],
      );

      const endpoints = mockExec.mock.calls.map((c) => cmd(c));
      expect(endpoints.some((e) => e.includes('/approve'))).toBe(false);
    });

    it('prepends "Changes Requested" heading for REQUEST_CHANGES verdict', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'needs work', verdict: 'REQUEST_CHANGES', comments: [] },
        [],
      );

      const noteCall = mockExec.mock.calls.find((c) => cmd(c).includes('/notes'));
      expect(getPayload(noteCall!).body).toBe('## Changes Requested\n\nneeds work');
    });

    it('does NOT add heading for APPROVE or COMMENT', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'lgtm', verdict: 'APPROVE', comments: [] },
        [],
      );

      const noteCall = mockExec.mock.calls.find((c) => cmd(c).includes('/notes'));
      expect(getPayload(noteCall!).body).toBe('lgtm');
    });

    it('hits endpoints in order: discussions → notes → approve', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'lgtm', verdict: 'APPROVE', comments: [] },
        [
          { path: 'a.ts', line: 5, severity: 'warning', body: 'b1' },
          { path: 'b.ts', line: 10, severity: 'critical', body: 'b2' },
        ],
      );

      const endpoints = mockExec.mock.calls.map((c) => cmd(c));
      expect(endpoints[0]).toContain('/discussions');
      expect(endpoints[1]).toContain('/discussions');
      expect(endpoints[2]).toContain('/notes');
      expect(endpoints[3]).toContain('/approve');
    });
  });

  describe('dry-run mode', () => {
    it('does not call execFileSync when dryRun is true', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'ok', verdict: 'APPROVE', comments: [] },
        [{ path: 'a.ts', line: 5, severity: 'warning', body: 'bug' }],
        true,
      );

      expect(mockExec).not.toHaveBeenCalled();
    });
  });
});
