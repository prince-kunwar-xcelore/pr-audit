import { execFileSync } from 'child_process';
import type { GitProvider } from '../provider.js';
import type { PrRef, PrData, ReviewComment, ReviewOutput } from '../types.js';
import { log } from '../logger.js';
import { isPrAuditComment, parseReviewMarker, type PriorThread, type ReviewHistory } from '../review-history.js';

interface GitHubReviewComment {
  id: number;
  in_reply_to_id?: number;
  path: string;
  line: number | null;
  original_line: number | null;
  body: string;
  user: { login: string } | null;
}

/** `gh api --paginate` over a list endpoint, one JSON object per line (works without --slurp). */
function listAll<T>(endpoint: string): T[] {
  const out = execFileSync('gh', ['api', '--paginate', endpoint, '--jq', '.[] | tojson'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

/** Database IDs of the first comment of each resolved review thread (only GraphQL exposes resolution). */
function resolvedThreadIds(ref: PrRef): Set<number> {
  const [owner, name] = ref.slug.split('/');
  const query = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { databaseId } } }
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
      '--jq', '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved) | .comments.nodes[0].databaseId',
    ],
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
  );
  return new Set(out.split('\n').filter((l) => l.trim()).map(Number));
}

export class GitHubProvider implements GitProvider {
  readonly name = 'GitHub';
  readonly reviewTerm = 'pull request';

  fetchPr(ref: PrRef): PrData {
    const { slug, number } = ref;

    log.debug(`gh pr view ${number} --repo ${slug} --json title,body,headRefOid`);
    const metaRaw = execFileSync(
      'gh',
      ['pr', 'view', String(number), '--repo', slug, '--json', 'title,body,headRefOid'],
      { encoding: 'utf8' },
    );
    const meta = JSON.parse(metaRaw) as { title: string; body: string; headRefOid: string };
    log.debug(`PR metadata: ${JSON.stringify({ title: meta.title, headSha: meta.headRefOid, bodyLength: meta.body?.length ?? 0 })}`);

    log.debug(`gh pr diff ${number} --repo ${slug}`);
    const diff = execFileSync('gh', ['pr', 'diff', String(number), '--repo', slug], {
      encoding: 'utf8',
    });
    log.debug(`Diff fetched: ${diff.length} bytes`);

    return {
      title: meta.title,
      body: meta.body ?? '',
      headSha: meta.headRefOid,
      diff,
    };
  }

  postReview(
    ref: PrRef,
    headSha: string,
    review: ReviewOutput,
    comments: ReviewComment[],
    dryRun = false,
  ): void {
    const endpoint = `/repos/${ref.slug}/pulls/${ref.number}/reviews`;

    const payload = {
      commit_id: headSha,
      body: review.summary,
      event: review.verdict,
      comments: comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: 'RIGHT',
        body: `**[${c.severity}]** ${c.body}`,
      })),
    };

    log.debug(`GitHub review payload:\n${JSON.stringify(payload, null, 2)}`);

    if (dryRun) {
      log.info(`[dry-run] Would POST ${endpoint}`);
      log.info(`[dry-run] Payload:\n${JSON.stringify(payload, null, 2)}`);
      log.info(`[dry-run] Review NOT posted (${review.verdict}, ${comments.length} inline comment(s))`);
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
          comments,
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
    log.info(`Review posted: ${review.verdict} (${comments.length} inline comment(s))`);
  }

  fetchReviewHistory(ref: PrRef): ReviewHistory {
    const base = `repos/${ref.slug}/pulls/${ref.number}`;

    const reviews = listAll<{ body: string | null }>(`${base}/reviews`);
    let lastSha: string | null = null;
    for (const r of reviews) lastSha = parseReviewMarker(r.body) ?? lastSha;

    const comments = listAll<GitHubReviewComment>(`${base}/comments`);
    const resolved = resolvedThreadIds(ref);
    const threads = new Map<number, PriorThread>();
    for (const c of comments) {
      if (!c.in_reply_to_id && isPrAuditComment(c.body)) {
        threads.set(c.id, {
          path: c.path,
          line: c.line ?? c.original_line,
          body: c.body,
          replies: [],
          resolved: resolved.has(c.id),
          outdated: c.line === null,
        });
      }
    }
    for (const c of comments) {
      const thread = c.in_reply_to_id ? threads.get(c.in_reply_to_id) : undefined;
      thread?.replies.push({ author: c.user?.login ?? 'unknown', body: c.body });
    }

    log.debug(`Review history: last reviewed ${lastSha ?? '(none)'}, ${threads.size} earlier pr-audit thread(s)`);
    return { lastSha, threads: [...threads.values()] };
  }

  fetchDiffSince(ref: PrRef, fromSha: string, headSha: string): string | null {
    const endpoint = `repos/${ref.slug}/compare/${fromSha}...${headSha}`;
    let status: string;
    try {
      status = execFileSync('gh', ['api', endpoint, '--jq', '.status'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      // 404 once the old commit is gone (force-push + GC)
      log.debug(`compare ${fromSha}...${headSha} failed: ${(err as Error).message}`);
      return null;
    }
    // "ahead": fromSha is an ancestor of head. "diverged"/"behind": history was rewritten.
    if (status !== 'ahead' && status !== 'identical') {
      log.debug(`compare ${fromSha}...${headSha}: ${status}`);
      return null;
    }
    try {
      return execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.diff', endpoint], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (err) {
      log.warn(`[warn] Could not fetch the diff since ${fromSha.slice(0, 7)}: ${(err as Error).message}`);
      return null;
    }
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
