import { execFileSync } from 'child_process';
import type { GitProvider } from '../provider.js';
import type { PrRef, PrData, ReviewComment, ReviewOutput } from '../types.js';
import { log } from '../logger.js';

interface GitLabDiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

interface GitLabMrMeta {
  title: string;
  description: string | null;
  diff_refs: GitLabDiffRefs;
}

export class GitLabProvider implements GitProvider {
  readonly name = 'GitLab';
  readonly reviewTerm = 'merge request';
  private diffRefs: GitLabDiffRefs | null = null;

  fetchPr(ref: PrRef): PrData {
    const { slug, number } = ref;

    log.debug(`glab mr view ${number} -R ${slug} --output json`);
    const metaRaw = execFileSync('glab', ['mr', 'view', String(number), '-R', slug, '--output', 'json'], {
      encoding: 'utf8',
    });
    const meta = JSON.parse(metaRaw) as GitLabMrMeta;
    if (!meta.diff_refs?.head_sha) {
      throw new Error(`GitLab MR ${slug}!${number} is missing diff_refs — cannot post inline comments`);
    }
    log.debug(
      `MR metadata: ${JSON.stringify({
        title: meta.title,
        headSha: meta.diff_refs.head_sha,
        bodyLength: meta.description?.length ?? 0,
      })}`,
    );

    this.diffRefs = meta.diff_refs;

    log.debug(`glab mr diff ${number} -R ${slug}`);
    const diff = execFileSync('glab', ['mr', 'diff', String(number), '-R', slug], {
      encoding: 'utf8',
    });
    log.debug(`Diff fetched: ${diff.length} bytes`);

    return {
      title: meta.title,
      body: meta.description ?? '',
      headSha: meta.diff_refs.head_sha,
      diff,
      providerMeta: {
        baseSha: meta.diff_refs.base_sha,
        startSha: meta.diff_refs.start_sha,
      },
    };
  }

  postReview(
    ref: PrRef,
    headSha: string,
    review: ReviewOutput,
    comments: ReviewComment[],
    dryRun = false,
  ): void {
    if (!this.diffRefs) {
      throw new Error('GitLabProvider.postReview called before fetchPr — diff refs unavailable');
    }

    const projectId = encodeURIComponent(ref.slug);
    const mrPath = `projects/${projectId}/merge_requests/${ref.number}`;

    for (const c of comments) {
      this.callApi(
        `${mrPath}/discussions`,
        {
          body: `**[${c.severity}]** ${c.body}`,
          position: {
            base_sha: this.diffRefs.base_sha,
            start_sha: this.diffRefs.start_sha,
            head_sha: headSha,
            position_type: 'text',
            new_path: c.path,
            new_line: c.line,
          },
        },
        `discussion on ${c.path}:${c.line}`,
        dryRun,
      );
    }

    const summaryBody =
      review.verdict === 'REQUEST_CHANGES'
        ? `## Changes Requested\n\n${review.summary}`
        : review.summary;
    this.callApi(`${mrPath}/notes`, { body: summaryBody }, 'summary note', dryRun);

    if (review.verdict === 'APPROVE') {
      this.callApi(`${mrPath}/approve`, {}, 'approval', dryRun);
    }

    const prefix = dryRun ? '[dry-run] Review NOT posted' : 'Review posted';
    log.info(`${prefix}: ${review.verdict} (${comments.length} inline comment(s))`);
  }

  reportSkipped(ref: PrRef, _headSha: string, _title: string, body: string, dryRun = false): void {
    // GitLab's neutral equivalent is the job's allow_failure exit code; here just leave a note
    const mrPath = `projects/${encodeURIComponent(ref.slug)}/merge_requests/${ref.number}`;
    this.callApi(`${mrPath}/notes`, { body }, 'skip note', dryRun);
    log.info(`${dryRun ? '[dry-run] Skip note NOT posted' : 'Posted skip note'}`);
  }

  private callApi(endpoint: string, payload: object, label: string, dryRun: boolean): void {
    log.debug(`glab api POST ${endpoint} payload:\n${JSON.stringify(payload, null, 2)}`);

    if (dryRun) {
      log.info(`[dry-run] Would call: glab api --method POST ${endpoint}`);
      log.info(`[dry-run] Payload (${label}):\n${JSON.stringify(payload, null, 2)}`);
      return;
    }

    let response: string;
    try {
      response = execFileSync(
        'glab',
        ['api', '--method', 'POST', '-H', 'Content-Type: application/json', endpoint, '--input', '-'],
        {
          input: Buffer.from(JSON.stringify(payload)),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      log.error(`GitLab API error (${label}): ${e.message}`);
      if (e.stderr) log.error(`stderr: ${e.stderr.trim()}`);
      if (e.stdout) log.error(`stdout: ${e.stdout.trim()}`);
      throw err;
    }

    log.debug(`GitLab response (${label}):\n${response}`);
  }
}
