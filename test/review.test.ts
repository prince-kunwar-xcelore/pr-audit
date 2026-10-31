import { describe, it, expect } from 'vitest';
import './setup.js';
import { MockEngine, type MockAnswer } from '../src/engines/mock.js';
import { MockProvider } from '../src/mocks/provider.js';
import { applyVerification, deriveVerdict, placeFindings, runReview, sanitizeFindings, type Workspace } from '../src/review.js';
import { EMPTY_HISTORY, parseGeneralMarker, type PriorThread, type ReviewHistory } from '../src/review-history.js';
import { parseDiffString } from '../src/diff.js';
import { SessionTimeoutError, UsageLimitError } from '../src/engine.js';
import type { Finding, LinkedIssue } from '../src/types.js';

const PR_DIFF = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const q = 'SELECT * FROM users WHERE id = ' + id;
 const c = 3;
 const d = 4;
`;

const NEW_DIFF = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -3,2 +3,3 @@
 const c = 3;
+const e = 5;
 const d = 4;
`;

function workspace(diffs: Record<string, string> = {}, opts: { ancestor?: boolean } = {}): Workspace {
  return {
    dir: '/checkout',
    diff: (from) => diffs[from] ?? PR_DIFF,
    mergeBase: () => 'mb00000',
    isAncestor: () => opts.ancestor ?? true,
    hasCommit: () => true,
  };
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  path: 'app.ts',
  line: 2,
  severity: 'critical',
  kind: 'security',
  body: 'SQL injection',
  ...over,
});

const options = { model: 'm', verify: true, full: false, dryRun: true, reviewTimeoutMs: 1000, verifyTimeoutMs: 500, retryDelayMs: 0 };

async function run(answers: Record<string, MockAnswer[]>, history: ReviewHistory = EMPTY_HISTORY, extra: { issues?: LinkedIssue[]; ws?: Workspace; verify?: boolean } = {}) {
  const provider = new MockProvider(undefined, history);
  const engine = new MockEngine(answers);
  const outcome = await runReview({
    provider,
    engine,
    ref: { slug: 'test/repo', number: 1 },
    pr: provider.fetchPr({ slug: 'test/repo', number: 1 }),
    history,
    workspace: extra.ws ?? workspace(),
    issues: extra.issues ?? [],
    unfetchedIssues: [],
    options: { ...options, verify: extra.verify ?? true },
  });
  return { provider, engine, outcome, post: provider.reviewCalls[0]?.review };
}

describe('deriveVerdict', () => {
  it('requests changes on critical or warning, comments on suggestions, approves on nothing', () => {
    expect(deriveVerdict(['suggestion', 'warning'])).toBe('REQUEST_CHANGES');
    expect(deriveVerdict(['critical'])).toBe('REQUEST_CHANGES');
    expect(deriveVerdict(['suggestion'])).toBe('COMMENT');
    expect(deriveVerdict([])).toBe('APPROVE');
  });
});

describe('sanitizeFindings', () => {
  it('defaults unknown enums, normalises paths and drops empty findings', () => {
    expect(sanitizeFindings([
      { path: './app.ts', line: 2, severity: 'blocker', kind: 'perf', body: ' slow ' },
      { path: '', line: 0, severity: 'warning', kind: 'question', body: 'why?' },
      { path: 'a.ts', line: 1, severity: 'warning', kind: 'bug', body: '' },
    ])).toEqual([
      { path: 'app.ts', line: 2, severity: 'suggestion', kind: 'bug', body: 'slow' },
      { path: null, line: null, severity: 'warning', kind: 'question', body: 'why?' },
    ]);
  });
});

describe('applyVerification', () => {
  const candidates = [
    { id: 'F1', finding: finding() },
    { id: 'F2', finding: finding({ severity: 'warning', body: 'b' }) },
    { id: 'F3', finding: finding({ severity: 'warning', body: 'c' }) },
    { id: 'F4', finding: finding({ severity: 'suggestion', body: 'd' }) },
    { id: 'F5', finding: finding({ body: 'e' }) },
  ];

  it('keeps, drops, downgrades and moves; undecided findings are kept', () => {
    const out = applyVerification(candidates, [
      { id: 'F1', action: 'keep', severity: null, path: null, line: null, reason: 'real' },
      { id: 'F2', action: 'drop', severity: null, path: null, line: null, reason: 'handled in db.ts' },
      { id: 'F3', action: 'downgrade', severity: 'suggestion', path: null, line: null, reason: 'minor' },
      { id: 'F4', action: 'downgrade', severity: 'critical', path: null, line: null, reason: 'not a downgrade' },
    ]);
    expect(out.map((f) => [f.body, f.severity])).toEqual([
      ['SQL injection', 'critical'],
      ['c', 'suggestion'],
      ['d', 'suggestion'],
      ['e', 'critical'],
    ]);
  });

  it('moves a finding to a new anchor or makes it general', () => {
    const [moved, general] = applyVerification(candidates.slice(0, 2), [
      { id: 'F1', action: 'move', severity: null, path: 'app.ts', line: 3, reason: 'better line' },
      { id: 'F2', action: 'move', severity: null, path: null, line: 9, reason: 'no line fits' },
    ]);
    expect([moved.path, moved.line]).toEqual(['app.ts', 3]);
    expect([general.path, general.line]).toEqual([null, null]);
  });
});

describe('placeFindings', () => {
  const files = parseDiffString(PR_DIFF);

  it('keeps diff-line anchors inline and turns everything else into general findings', () => {
    const { inline, general } = placeFindings(
      [
        finding(),
        finding({ line: 40, body: 'off-diff line' }),
        finding({ path: 'lib/other.ts', line: 7, body: 'untouched caller breaks' }),
        finding({ path: null, line: null, kind: 'requirement', body: 'CSV export missing' }),
      ],
      files,
    );
    expect(inline.map((f) => f.body)).toEqual(['SQL injection']);
    expect(general).toEqual([
      { ...finding(), line: null, path: 'app.ts', body: '`app.ts:40`: off-diff line' },
      { ...finding(), line: null, path: null, body: '`lib/other.ts:7`: untouched caller breaks' },
      { ...finding(), path: null, line: null, kind: 'requirement', body: 'CSV export missing' },
    ]);
  });
});

describe('runReview', () => {
  it('reviews, verifies and posts with a verdict derived from surviving findings', async () => {
    const { engine, outcome, post } = await run({
      review: [{ summary: 'Adds a query.', findings: [finding(), finding({ severity: 'warning', body: 'false alarm' })], follow_ups: [] }],
      verification: [{
        findings: [
          { id: 'F1', action: 'keep', severity: null, path: null, line: null, reason: 'real' },
          { id: 'F2', action: 'drop', severity: null, path: null, line: null, reason: 'handled' },
        ],
        follow_ups: [],
      }],
    });

    expect(engine.calls.map((c) => [c.label, c.cwd, c.timeoutMs])).toEqual([['review', '/checkout', 1000], ['verification', '/checkout', 500]]);
    expect(engine.calls[1].prompt).toContain('F2');
    expect(outcome).toMatchObject({ posted: true, verdict: 'REQUEST_CHANGES', inline: 1 });
    expect(post.inline.map((f) => f.body)).toEqual(['SQL injection']);
    expect(post.summary).toContain('Adds a query.');
    expect(post.summary).toContain('<!-- pr-audit:sha=head000 -->');
  });

  it('approves when verification drops everything', async () => {
    const { post } = await run({
      review: [{ summary: 's', findings: [finding({ severity: 'warning' })], follow_ups: [] }],
      verification: [{ findings: [{ id: 'F1', action: 'drop', severity: null, path: null, line: null, reason: 'no' }], follow_ups: [] }],
    });
    expect(post.verdict).toBe('APPROVE');
  });

  it('skips verification with --no-verify or when there is nothing to verify', async () => {
    const off = await run({ review: [{ summary: 's', findings: [finding()], follow_ups: [] }] }, EMPTY_HISTORY, { verify: false });
    expect(off.engine.calls.map((c) => c.label)).toEqual(['review']);
    const empty = await run({});
    expect(empty.engine.calls.map((c) => c.label)).toEqual(['review']);
    expect(empty.post.verdict).toBe('APPROVE');
  });

  it('posts unverified findings with a note when verification fails', async () => {
    const { post } = await run({
      review: [{ summary: 's', findings: [finding()], follow_ups: [] }],
      verification: [new SessionTimeoutError('verification', 500)],
    });
    expect(post.verdict).toBe('REQUEST_CHANGES');
    expect(post.inline).toHaveLength(1);
    expect(post.summary).toMatch(/not verified \(verification failed: verification session timed out/);
  });

  it('lets a usage limit in the review session propagate', async () => {
    await expect(run({ review: [new UsageLimitError('Mock', 'limit', null)] })).rejects.toBeInstanceOf(UsageLimitError);
  });

  it('retries a crashed review session once, but not a timeout', async () => {
    const crashed = await run({ review: [new Error('stream disconnected'), { summary: 's', findings: [], follow_ups: [] }] });
    expect(crashed.engine.calls.filter((c) => c.label === 'review')).toHaveLength(2);
    await expect(run({ review: [new SessionTimeoutError('review', 1000)] })).rejects.toBeInstanceOf(SessionTimeoutError);
  });

  it('threads general findings where the provider can and keeps the rest in the body marker', async () => {
    const { post } = await run({
      review: [{
        summary: 's',
        findings: [
          finding({ line: null, severity: 'suggestion', kind: 'cleanup', body: 'file-level note' }),
          finding({ path: null, line: null, severity: 'warning', kind: 'requirement', body: '#12 asks for CSV export' }),
        ],
        follow_ups: [],
      }],
    }, EMPTY_HISTORY, { verify: false });
    expect(post.threaded.map((f) => f.body)).toEqual(['file-level note']);
    expect(post.summary).toContain('### Other findings\n- **[warning · requirement]** #12 asks for CSV export');
    expect(parseGeneralMarker(post.summary).map((f) => f.body)).toEqual(['#12 asks for CSV export']);
    expect(post.verdict).toBe('REQUEST_CHANGES');
  });

  it('names the linked issues it checked', async () => {
    const issue: LinkedIssue = { ref: { slug: 'test/repo', number: 12 }, url: 'u', title: 'CSV', body: 'b', state: 'open', comments: [], closes: true };
    const { engine, post } = await run({}, EMPTY_HISTORY, { issues: [issue] });
    expect(engine.calls[0].prompt).toContain('#12: CSV (open; this PR claims to CLOSE it)');
    expect(post.summary).toContain('Requirements checked against: #12 (closes).');
  });
});

describe('runReview incremental', () => {
  const thread = (over: Partial<PriorThread> = {}): PriorThread => ({
    id: '101', path: 'app.ts', line: 2, body: '**[critical · security]** SQL injection', replies: [], resolved: false, outdated: false, resolveId: 'R1', ...over,
  });
  const history = (threads: PriorThread[], bodyFindings: Finding[] = []): ReviewHistory => ({ lastSha: 'last000', threads, bodyFindings });

  it('scopes the review to the new range and gives open threads ids', async () => {
    const ws = workspace({ last000: NEW_DIFF });
    const { engine, post } = await run({}, history([thread()]), { ws });
    const prompt = engine.calls[0].prompt;
    expect(prompt).toContain('INCREMENTAL');
    expect(prompt).toContain('git diff last000 head000');
    expect(prompt).toContain('- T1 app.ts:2: **[critical · security]** SQL injection');
    expect(post.summary).toContain('_Incremental review: changes since last000._');
    // the open critical thread still blocks
    expect(post.verdict).toBe('REQUEST_CHANGES');
    expect(post.summary).toContain('1 earlier finding(s) still open');
  });

  it('posts nothing when the new range has no reviewable PR changes', async () => {
    const empty = 'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-a\n+b\n';
    const { outcome, engine } = await run({}, history([]), { ws: workspace({ last000: empty }) });
    expect(outcome).toEqual({ posted: false, reason: 'No reviewable changes since the last review.' });
    expect(engine.calls).toHaveLength(0);
  });

  it('falls back to a full review after a force-push', async () => {
    const { engine } = await run({}, history([]), { ws: workspace({}, { ancestor: false }) });
    expect(engine.calls[0].prompt).not.toContain('INCREMENTAL');
  });

  it('resolves verified fixes, keeps rejected ones open, and replies to disputes', async () => {
    const t1 = thread();
    const t2 = thread({ id: '102', line: 3, body: '**[warning · question]** is id validated?', resolveId: 'R2' });
    const t3 = thread({ id: '103', line: 4, body: '**[warning · bug]** off by one', resolveId: 'R3' });
    const { provider, post } = await run(
      {
        review: [{
          summary: 's',
          findings: [],
          follow_ups: [
            { thread: 'T1', action: 'resolve_fixed', body: 'Fixed in head000: parameterised.' },
            { thread: 'T2', action: 'resolve_answered', body: 'Thanks, validated upstream.' },
            { thread: 'T3', action: 'reply', body: 'Still off by one when the list is empty.' },
            { thread: 'T9', action: 'resolve_fixed', body: 'unknown thread, ignored' },
          ],
        }],
        verification: [{ findings: [], follow_ups: [{ thread: 'T1', confirmed: true, reason: 'ok' }, { thread: 'T2', confirmed: false, reason: 'not validated anywhere' }] }],
      },
      history([t1, t2, t3]),
      { ws: workspace({ last000: NEW_DIFF }) },
    );

    expect(provider.followUpCalls[0].map((p) => [p.thread.id, p.resolve, p.body])).toEqual([
      ['101', true, 'Fixed in head000: parameterised.'],
      ['103', false, 'Still off by one when the list is empty.'],
    ]);
    // T2 and T3 (warnings) stay open, so the review still requests changes
    expect(post.verdict).toBe('REQUEST_CHANGES');
    expect(post.summary).toContain('2 earlier finding(s) still open');
    expect(post.summary).toContain('Resolved 1 earlier thread(s).');
  });

  it('approves once every open thread is resolved', async () => {
    const { post } = await run(
      { review: [{ summary: 's', findings: [], follow_ups: [{ thread: 'T1', action: 'resolve_fixed', body: 'Fixed.' }] }] },
      history([thread()]),
      { ws: workspace({ last000: NEW_DIFF }), verify: false },
    );
    expect(post.verdict).toBe('APPROVE');
  });

  it('hands the last body findings back for re-checking', async () => {
    const gap = finding({ path: null, line: null, severity: 'warning', kind: 'requirement', body: 'CSV export missing' });
    const { engine } = await run({}, history([], [gap]), { ws: workspace({ last000: NEW_DIFF }) });
    expect(engine.calls[0].prompt).toContain('## General findings from the last review');
    expect(engine.calls[0].prompt).toContain('- **[warning · requirement]** CSV export missing');
  });
});
