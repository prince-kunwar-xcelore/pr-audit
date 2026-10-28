import { execSync } from 'child_process';
import type { GitProvider } from '../provider.js';
import type { PrRef, PrData, ReviewComment, ReviewOutput } from '../types.js';
import { log } from '../logger.js';

export class GitHubProvider implements GitProvider {
  readonly name = 'GitHub';
  readonly reviewTerm = 'pull request';

  fetchPr(ref: PrRef): PrData {
    const { slug, number } = ref;

    log.debug(`gh pr view ${number} --repo ${slug} --json title,body,headRefOid`);
    const metaRaw = execSync(
      `gh pr view ${number} --repo ${slug} --json title,body,headRefOid`,
      { encoding: 'utf8' },
    );
    const meta = JSON.parse(metaRaw) as { title: string; body: string; headRefOid: string };
    log.debug(`PR metadata: ${JSON.stringify({ title: meta.title, headSha: meta.headRefOid, bodyLength: meta.body?.length ?? 0 })}`);

    log.debug(`gh pr diff ${number} --repo ${slug}`);
    const diff = execSync(`gh pr diff ${number} --repo ${slug}`, {
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
      response = execSync(`gh api --method POST ${endpoint} --input -`, {
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
      execSync(`gh api --method POST ${endpoint} --input -`, {
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
