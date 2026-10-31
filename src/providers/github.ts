import { execFileSync } from 'child_process';
import type { FollowUpPost, GitProvider } from '../provider.js';
import type { Finding, IssueRef, LinkedIssue, PrRef, PrData, ReviewPost } from '../types.js';
import { log } from '../logger.js';
import {
  findingTag,
  isPrAuditComment,
  parseGeneralMarker,
  parseReviewMarker,
  type PriorThread,
  type ReviewHistory,
} from '../review-history.js';

interface GitHubReviewComment {
  id: number;
  in_reply_to_id?: number;
  path: string;
  line: number | null;
  original_line: number | null;
  subject_type?: 'line' | 'file';
  body: string;
  user: { login: string } | null;
  author_association: string;
}

interface GitHubReview {
  body: string | null;
  commit_id: string;
  user: { login: string } | null;
}

// Replies from these can steer the next review ("already discussed"); anyone else's are dropped
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** `gh api --paginate` over a list endpoint, one JSON object per line (works without --slurp). */
function listAll<T>(endpoint: string): T[] {
  const out = execFileSync('gh', ['api', '--paginate', endpoint, '--jq', '.[] | tojson'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

interface ThreadState {
  /** GraphQL node id, needed to resolve the thread. */
  id: string;
  resolved: boolean;
}

/** Review threads keyed by the database id of their first comment (only GraphQL exposes resolution). */
function reviewThreads(ref: PrRef): Map<number, ThreadState> {
  const [owner, name] = ref.slug.split('/');
  const query = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;
  const out = execFileSync(
    'gh',
    [
      'api', 'graphql', '--paginate',
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${ref.number}`,
      '-f', `query=${query}`,
      '--jq', '.data.repository.pullRequest.reviewThreads.nodes[] | {id, resolved: .isResolved, first: .comments.nodes[0].databaseId} | tojson',
    ],
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
  );
  const map = new Map<number, ThreadState>();
  for (const line of out.split('\n').filter((l) => l.trim())) {
    const t = JSON.parse(line) as { id: string; resolved: boolean; first: number };
    map.set(t.first, { id: t.id, resolved: t.resolved });
  }
  return map;
}

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title body url headRefOid baseRefOid baseRefName headRefName
      commits(last: 100) { nodes { commit { message } } }
      closingIssuesReferences(first: 25) { nodes { number repository { nameWithOwner } } }
    }
  }
}`;

interface GraphQlPr {
  title: string;
  body: string | null;
  url: string;
  headRefOid: string;
  baseRefOid: string;
  baseRefName: string;
  headRefName: string;
  commits: { nodes: { commit: { message: string } }[] };
  closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[] };
}

export class GitHubProvider implements GitProvider {
  readonly name = 'GitHub';
  readonly reviewTerm = 'pull request';

  fetchPr(ref: PrRef): PrData {
    const [owner, name] = ref.slug.split('/');
    log.debug(`gh api graphql pullRequest ${ref.slug}#${ref.number}`);
    const raw = execFileSync(
      'gh',
      ['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${ref.number}`, '-f', `query=${PR_QUERY}`, '--jq', '.data.repository.pullRequest'],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    const pr = JSON.parse(raw) as GraphQlPr;
    log.debug(`PR metadata: ${JSON.stringify({ title: pr.title, headSha: pr.headRefOid, baseSha: pr.baseRefOid, bodyLength: pr.body?.length ?? 0 })}`);

    return {
      title: pr.title,
      body: pr.body ?? '',
      url: pr.url,
      headSha: pr.headRefOid,
      baseSha: pr.baseRefOid,
      baseRef: pr.baseRefName,
      headRef: pr.headRefName,
      commits: pr.commits.nodes.map((n) => n.commit.message),
      closingIssues: pr.closingIssuesReferences.nodes.map((n) => ({ slug: n.repository.nameWithOwner, number: n.number })),
    };
  }

  cloneRepo(ref: PrRef, dir: string): void {
    log.debug(`gh repo clone ${ref.slug} ${dir} -- --filter=blob:none`);
    execFileSync('gh', ['repo', 'clone', ref.slug, dir, '--', '--filter=blob:none', '--quiet'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  fetchIssue(issue: IssueRef): Omit<LinkedIssue, 'closes'> | null {
    const base = `repos/${issue.slug}/issues/${issue.number}`;
    let data: { title: string; body: string | null; html_url: string; state: string; pull_request?: unknown };
    try {
      data = JSON.parse(
        execFileSync('gh', ['api', base], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    } catch (err) {
      log.debug(`issue ${issue.slug}#${issue.number} not fetched: ${(err as Error).message.split('\n')[0]}`);
      return null;
    }
    // Issue numbers are shared with PRs; a PR isn't a requirement
    if (data.pull_request) return null;
    let comments: { author: string; body: string }[] = [];
    try {
      comments = listAll<{ user: { login: string } | null; body: string | null }>(`${base}/comments`).map((c) => ({
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
      }));
    } catch {
      // the issue itself is what matters
    }
    return { ref: issue, url: data.html_url, title: data.title, body: data.body ?? '', state: data.state, comments };
  }

  threadsGeneralFinding(finding: Finding, prPaths: string[]): boolean {
    // File-level review comments are resolvable threads, but only on files in the PR
    return !!finding.path && prPaths.includes(finding.path);
  }

  postReview(ref: PrRef, headSha: string, review: ReviewPost, dryRun = false): void {
    const endpoint = `/repos/${ref.slug}/pulls/${ref.number}/reviews`;

    const payload = {
      commit_id: headSha,
      body: review.summary,
      event: review.verdict,
      comments: review.inline.map((c) => ({
        path: c.path,
        line: c.line,
        side: 'RIGHT',
        body: `${findingTag(c)} ${c.body}`,
      })),
    };
    const fileComments = review.threaded.map((c) => ({
      commit_id: headSha,
      path: c.path,
      subject_type: 'file',
      body: `${findingTag(c)} ${c.body}`,
    }));
    const commentsEndpoint = `/repos/${ref.slug}/pulls/${ref.number}/comments`;

    log.debug(`GitHub review payload:\n${JSON.stringify(payload, null, 2)}`);

    if (dryRun) {
      log.info(`[dry-run] Would POST ${endpoint}`);
      log.info(`[dry-run] Payload:\n${JSON.stringify(payload, null, 2)}`);
      for (const c of fileComments) log.info(`[dry-run] Would POST ${commentsEndpoint}: ${JSON.stringify(c)}`);
      log.info(`[dry-run] Review NOT posted (${review.verdict}, ${review.inline.length} inline, ${fileComments.length} file comment(s))`);
      return;
    }

    let response: string;
    try {
      response = execFileSync('gh', ['api', '--method', 'POST', endpoint, '--input', '-'], {
        input: Buffer.from(JSON.stringify(payload)),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      // Repos (and orgs) can forbid GitHub Actions from approving PRs; post the approval as a comment review instead
      if (review.verdict === 'APPROVE' && /not permitted to approve/i.test(`${e.stdout ?? ''}${e.stderr ?? ''}`)) {
        log.warn('[warn] GitHub Actions may not approve PRs in this repo — posting the review as COMMENT');
        this.postReview(
          ref,
          headSha,
          { ...review, verdict: 'COMMENT', summary: `✅ **Approved by AI review** (posted as a comment: GitHub Actions can't approve PRs in this repo).\n\n${review.summary}` },
          dryRun,
        );
        return;
      }
      log.error(`GitHub API error: ${e.message}`);
      if (e.stderr) log.error(`stderr: ${e.stderr.trim()}`);
      if (e.stdout) log.error(`stdout: ${e.stdout.trim()}`);
      throw err;
    }
    log.debug(`GitHub response:\n${response}`);

    for (const c of fileComments) {
      try {
        this.post(commentsEndpoint, c, `file comment on ${c.path}`);
      } catch {
        log.warn(`[warn] Could not post the file comment on ${c.path}`);
      }
    }
    log.info(`Review posted: ${review.verdict} (${review.inline.length} inline, ${fileComments.length} file comment(s))`);
  }

  applyFollowUps(ref: PrRef, posts: FollowUpPost[], dryRun = false): void {
    for (const { thread, body, resolve } of posts) {
      const endpoint = `/repos/${ref.slug}/pulls/${ref.number}/comments/${thread.id}/replies`;
      if (dryRun) {
        log.info(`[dry-run] Would reply on ${thread.path}${thread.line ? `:${thread.line}` : ''}${resolve ? ' and resolve' : ''}: ${body}`);
        continue;
      }
      try {
        this.post(endpoint, { body }, 'follow-up reply');
        if (resolve && thread.resolveId) {
          execFileSync(
            'gh',
            ['api', 'graphql', '-f', `threadId=${thread.resolveId}`, '-f', 'query=mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { isResolved } } }'],
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
          );
        }
        log.info(`Followed up on ${thread.path}${thread.line ? `:${thread.line}` : ''}${resolve ? ' (resolved)' : ''}`);
      } catch (err) {
        log.warn(`[warn] Follow-up on ${thread.path} failed: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  }

  fetchReviewHistory(ref: PrRef): ReviewHistory {
    const base = `repos/${ref.slug}/pulls/${ref.number}`;
    const posters = this.posterLogins();
    const byPoster = (user: { login: string } | null) => !!user && posters.has(user.login);

    // Only markers pr-audit itself could have posted: anyone can review a public PR, and a
    // forged marker would skip or narrow the next review
    const reviews = listAll<GitHubReview>(`${base}/reviews`);
    let lastSha: string | null = null;
    let bodyFindings: ReviewHistory['bodyFindings'] = [];
    for (const r of reviews) {
      const sha = parseReviewMarker(r.body);
      if (sha && sha === r.commit_id && byPoster(r.user)) {
        lastSha = sha;
        bodyFindings = parseGeneralMarker(r.body);
      }
    }

    const comments = listAll<GitHubReviewComment>(`${base}/comments`);
    const states = reviewThreads(ref);
    const threads = new Map<number, PriorThread>();
    for (const c of comments) {
      if (!c.in_reply_to_id && isPrAuditComment(c.body) && byPoster(c.user)) {
        const fileLevel = c.subject_type === 'file';
        threads.set(c.id, {
          id: String(c.id),
          path: c.path,
          line: fileLevel ? null : c.line ?? c.original_line,
          body: c.body,
          replies: [],
          resolved: states.get(c.id)?.resolved ?? false,
          // File-level threads don't go outdated; line threads do once their line changes
          outdated: !fileLevel && c.line === null,
          resolveId: states.get(c.id)?.id,
        });
      }
    }
    for (const c of comments) {
      const thread = c.in_reply_to_id ? threads.get(c.in_reply_to_id) : undefined;
      if (thread && (TRUSTED_ASSOCIATIONS.has(c.author_association) || byPoster(c.user))) {
        thread.replies.push({ author: c.user?.login ?? 'unknown', body: c.body });
      }
    }

    log.debug(`Review history: last reviewed ${lastSha ?? '(none)'}, ${threads.size} earlier pr-audit thread(s), ${bodyFindings.length} body finding(s)`);
    return { lastSha, threads: [...threads.values()], bodyFindings };
  }

  // Who posts pr-audit's reviews: the Actions bot (fork PRs get a read-only token, so only
  // this repo's workflows post as it) and the account gh is logged in as, for local runs
  private posterLogins(): Set<string> {
    const logins = new Set(['github-actions[bot]']);
    try {
      const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (login) logins.add(login);
    } catch {
      // the Actions GITHUB_TOKEN can't read /user
    }
    return logins;
  }

  reportSkipped(ref: PrRef, headSha: string, title: string, body: string, dryRun = false): void {
    const commentEndpoint = `/repos/${ref.slug}/issues/${ref.number}/comments`;
    // Neutral check run: GitHub Actions jobs can only pass or fail, so the
    // "skipped, not broken" status is carried by a separate check (needs `checks: write`).
    const checkEndpoint = `/repos/${ref.slug}/check-runs`;
    const check = {
      name: 'AI review',
      head_sha: headSha,
      status: 'completed',
      conclusion: 'neutral',
      output: { title, summary: body },
    };

    if (dryRun) {
      log.info(`[dry-run] Would POST ${commentEndpoint}: ${JSON.stringify({ body })}`);
      log.info(`[dry-run] Would POST ${checkEndpoint}: ${JSON.stringify(check)}`);
      return;
    }

    this.post(commentEndpoint, { body }, 'skip comment');
    log.info('Posted skip comment');
    try {
      this.post(checkEndpoint, check, 'neutral check run');
      log.info('Created neutral "AI review" check run');
    } catch {
      log.warn('[warn] Could not create a neutral check run — grant the workflow `checks: write`');
    }
  }

  private post(endpoint: string, payload: object, label: string): void {
    try {
      execFileSync('gh', ['api', '--method', 'POST', endpoint, '--input', '-'], {
        input: Buffer.from(JSON.stringify(payload)),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      log.error(`GitHub API error (${label}): ${e.message}`);
      if (e.stderr) log.error(`stderr: ${e.stderr.trim()}`);
      throw err;
    }
  }
}
