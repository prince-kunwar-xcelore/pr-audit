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
  web_url: 'https://gitlab.com/group/project/-/merge_requests/1',
  source_branch: 'feature',
  target_branch: 'main',
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
    .mockReturnValueOnce('[]')
    .mockReturnValueOnce('[]');
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
    it('reads the MR, its commits and the issues it closes through the API', () => {
      const provider = new GitLabProvider();
      mockExec
        .mockReturnValueOnce(JSON.stringify(MR_META))
        .mockReturnValueOnce(JSON.stringify([{ message: 'second' }, { message: 'first' }]))
        .mockReturnValueOnce(JSON.stringify([{ iid: 12, references: { full: 'group/project#12' } }]));

      const result = provider.fetchPr({ slug: 'group/project', number: 1 });

      expect(cmd(mockExec.mock.calls[0])).toBe('glab api projects/group%2Fproject/merge_requests/1');
      expect(cmd(mockExec.mock.calls[1])).toBe('glab api projects/group%2Fproject/merge_requests/1/commits?per_page=100');
      expect(cmd(mockExec.mock.calls[2])).toBe('glab api projects/group%2Fproject/merge_requests/1/closes_issues');
      expect(result).toEqual({
        title: 'Test MR',
        body: 'A test MR',
        url: 'https://gitlab.com/group/project/-/merge_requests/1',
        headSha: 'head-sha',
        baseSha: 'start-sha',
        baseRef: 'main',
        headRef: 'feature',
        commits: ['first', 'second'],
        closingIssues: [{ slug: 'group/project', number: 12 }],
        providerMeta: { baseSha: 'base-sha', startSha: 'start-sha' },
      });
    });

    it('treats null description as empty body', () => {
      const provider = new GitLabProvider();
      mockExec
        .mockReturnValueOnce(JSON.stringify({ ...MR_META, description: null }))
        .mockReturnValueOnce('[]')
        .mockReturnValueOnce('[]');
      expect(provider.fetchPr({ slug: 'g/p', number: 1 }).body).toBe('');
    });

    it('throws when MR is missing diff_refs', () => {
      const provider = new GitLabProvider();
      mockExec.mockReturnValueOnce(JSON.stringify({ title: 'orphan' }));
      expect(() => provider.fetchPr({ slug: 'g/p', number: 1 })).toThrow('missing diff_refs');
    });
  });

  describe('fetchIssue', () => {
    it('returns the issue with its non-system notes', () => {
      mockExec
        .mockReturnValueOnce(JSON.stringify({ title: 'CSV', description: 'Add CSV', web_url: 'u', state: 'opened' }))
        .mockReturnValueOnce(JSON.stringify([
          { system: true, body: 'changed the description', author: { username: 'pm' } },
          { system: false, body: 'Include headers', author: { username: 'pm' } },
        ]));
      expect(new GitLabProvider().fetchIssue({ slug: 'g/p', number: 12 })).toEqual({
        ref: { slug: 'g/p', number: 12 }, url: 'u', title: 'CSV', body: 'Add CSV', state: 'opened',
        comments: [{ author: 'pm', body: 'Include headers' }],
      });
    });
  });

  describe('general findings', () => {
    it('posts them as MR discussions without a position', () => {
      const provider = setupProvider();
      provider.postReview({ slug: 'group/project', number: 1 }, 'head-sha', {
        summary: 's', verdict: 'COMMENT', inline: [],
        threaded: [{ path: 'b.ts', line: null, severity: 'suggestion', kind: 'cleanup', body: 'dead code' }],
      });
      expect(getPayload(mockExec.mock.calls[0])).toEqual({ body: '**[suggestion · cleanup]** `b.ts`: dead code' });
      expect(provider.threadsGeneralFinding({ path: null, line: null, severity: 'warning', kind: 'requirement', body: 'x' }, [])).toBe(true);
    });
  });

  describe('postReview', () => {
    it('throws when called before fetchPr', () => {
      const provider = new GitLabProvider();
      expect(() =>
        provider.postReview(
          { slug: 'g/p', number: 1 },
          'sha',
          { summary: '', verdict: 'COMMENT', inline: [], threaded: [] },
        ),
      ).toThrow('called before fetchPr');
    });

    it("sends 'Content-Type: application/json' on every API call", () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'ok', verdict: 'APPROVE', inline: [{ path: 'a.ts', line: 5, severity: 'warning', kind: 'bug', body: 'bug' }], threaded: [] },
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
        { summary: 'ok', verdict: 'COMMENT', inline: [], threaded: [] },
      );

      expect(cmd(mockExec.mock.calls[0])).toContain('projects/group%2Fsubgroup%2Fproject/merge_requests/7');
    });

    it('builds discussion position object from cached diff refs', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: '', verdict: 'COMMENT', inline: [{ path: 'a.ts', line: 5, severity: 'warning', kind: 'bug', body: 'bug' }], threaded: [] },
      );

      const payload = getPayload(mockExec.mock.calls[0]);
      expect(payload.body).toBe('**[warning · bug]** bug');
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
        { summary: 'lgtm', verdict: 'APPROVE', inline: [], threaded: [] },
      );

      const endpoints = mockExec.mock.calls.map((c) => cmd(c));
      expect(endpoints.some((e) => e.includes('/approve'))).toBe(true);
    });

    it('does NOT call /approve when verdict is COMMENT', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'feedback', verdict: 'COMMENT', inline: [], threaded: [] },
      );

      const endpoints = mockExec.mock.calls.map((c) => cmd(c));
      expect(endpoints.some((e) => e.includes('/approve'))).toBe(false);
    });

    it('does NOT call /approve when verdict is REQUEST_CHANGES', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'needs work', verdict: 'REQUEST_CHANGES', inline: [], threaded: [] },
      );

      const endpoints = mockExec.mock.calls.map((c) => cmd(c));
      expect(endpoints.some((e) => e.includes('/approve'))).toBe(false);
    });

    it('prepends "Changes Requested" heading for REQUEST_CHANGES verdict', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'needs work', verdict: 'REQUEST_CHANGES', inline: [], threaded: [] },
      );

      const noteCall = mockExec.mock.calls.find((c) => cmd(c).includes('/notes'));
      expect(getPayload(noteCall!).body).toBe('## Changes Requested\n\nneeds work');
    });

    it('does NOT add heading for APPROVE or COMMENT', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'lgtm', verdict: 'APPROVE', inline: [], threaded: [] },
      );

      const noteCall = mockExec.mock.calls.find((c) => cmd(c).includes('/notes'));
      expect(getPayload(noteCall!).body).toBe('lgtm');
    });

    it('hits endpoints in order: discussions → notes → approve', () => {
      const provider = setupProvider();

      provider.postReview(
        { slug: 'group/project', number: 1 },
        'head-sha',
        { summary: 'lgtm', verdict: 'APPROVE', inline: [
          { path: 'a.ts', line: 5, severity: 'warning', kind: 'bug', body: 'b1' },
          { path: 'b.ts', line: 10, severity: 'critical', kind: 'bug', body: 'b2' },
        ], threaded: [] },
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
        { summary: 'ok', verdict: 'APPROVE', inline: [{ path: 'a.ts', line: 5, severity: 'warning', kind: 'bug', body: 'bug' }], threaded: [] },
        true,
      );

      expect(mockExec).not.toHaveBeenCalled();
    });
  });
});
