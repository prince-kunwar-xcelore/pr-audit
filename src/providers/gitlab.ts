import { execFileSync } from 'child_process';
import type { GitProvider } from '../provider.js';
import type { Finding, IssueRef, LinkedIssue, PrRef, PrData, ReviewPost } from '../types.js';
import { log } from '../logger.js';
import { findingTag } from '../review-history.js';

interface GitLabDiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

interface GitLabMr {
  title: string;
  description: string | null;
  web_url: string;
  source_branch: string;
  target_branch: string;
  diff_refs: GitLabDiffRefs | null;
}

const project = (slug: string) => `projects/${encodeURIComponent(slug)}`;

function api<T>(endpoint: string): T {
  log.debug(`glab api ${endpoint}`);
  return JSON.parse(
    execFileSync('glab', ['api', endpoint], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 }),
  ) as T;
}

export class GitLabProvider implements GitProvider {
  readonly name = 'GitLab';
  readonly reviewTerm = 'merge request';
  private diffRefs: GitLabDiffRefs | null = null;

  fetchPr(ref: PrRef): PrData {
    const mrPath = `${project(ref.slug)}/merge_requests/${ref.number}`;
    const mr = api<GitLabMr>(mrPath);
    if (!mr.diff_refs?.head_sha) {
      throw new Error(`GitLab MR ${ref.slug}!${ref.number} is missing diff_refs — cannot post inline comments`);
    }
    this.diffRefs = mr.diff_refs;
    log.debug(`MR metadata: ${JSON.stringify({ title: mr.title, headSha: mr.diff_refs.head_sha, bodyLength: mr.description?.length ?? 0 })}`);

    // Newest first from the API
    const commits = api<{ message: string }[]>(`${mrPath}/commits?per_page=100`).map((c) => c.message).reverse();
    let closingIssues: IssueRef[] = [];
    try {
      closingIssues = api<{ iid: number; references?: { full?: string } }[]>(`${mrPath}/closes_issues`).map((i) => ({
        slug: i.references?.full?.replace(/#\d+$/, '') ?? ref.slug,
        number: i.iid,
      }));
    } catch (err) {
      log.debug(`closes_issues not available: ${(err as Error).message.split('\n')[0]}`);
    }

    return {
      title: mr.title,
      body: mr.description ?? '',
      url: mr.web_url,
      headSha: mr.diff_refs.head_sha,
      // start_sha is the target branch tip the MR is compared against
      baseSha: mr.diff_refs.start_sha,
      baseRef: mr.target_branch,
      headRef: mr.source_branch,
      commits,
      closingIssues,
      providerMeta: { baseSha: mr.diff_refs.base_sha, startSha: mr.diff_refs.start_sha },
    };
  }

  cloneRepo(ref: PrRef, dir: string): void {
    log.debug(`glab repo clone ${ref.slug} ${dir} -- --filter=blob:none`);
    execFileSync('glab', ['repo', 'clone', ref.slug, dir, '--', '--filter=blob:none', '--quiet'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  fetchIssue(issue: IssueRef): Omit<LinkedIssue, 'closes'> | null {
    const path = `${project(issue.slug)}/issues/${issue.number}`;
    let data: { title: string; description: string | null; web_url: string; state: string };
    try {
      data = api(path);
    } catch (err) {
      log.debug(`issue ${issue.slug}#${issue.number} not fetched: ${(err as Error).message.split('\n')[0]}`);
      return null;
    }
    let comments: { author: string; body: string }[] = [];
    try {
      comments = api<{ system: boolean; body: string; author: { username: string } | null }[]>(`${path}/notes?sort=asc&per_page=100`)
        .filter((n) => !n.system)
        .map((n) => ({ author: n.author?.username ?? 'unknown', body: n.body }));
    } catch {
      // the issue itself is what matters
    }
    return { ref: issue, url: data.web_url, title: data.title, body: data.description ?? '', state: data.state, comments };
  }

  threadsGeneralFinding(_finding: Finding, _prPaths: string[]): boolean {
    // MR discussions are resolvable threads with or without a position
    return true;
  }

  postReview(ref: PrRef, headSha: string, review: ReviewPost, dryRun = false): void {
    if (!this.diffRefs) {
      throw new Error('GitLabProvider.postReview called before fetchPr — diff refs unavailable');
    }
    const mrPath = `${project(ref.slug)}/merge_requests/${ref.number}`;

    for (const c of review.inline) {
      this.callApi(
        `${mrPath}/discussions`,
        {
          body: `${findingTag(c)} ${c.body}`,
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
    for (const c of review.threaded) {
      const where = c.path ? `\`${c.path}\`: ` : '';
      this.callApi(`${mrPath}/discussions`, { body: `${findingTag(c)} ${where}${c.body}` }, 'general discussion', dryRun);
    }

    const summaryBody = review.verdict === 'REQUEST_CHANGES' ? `## Changes Requested\n\n${review.summary}` : review.summary;
    this.callApi(`${mrPath}/notes`, { body: summaryBody }, 'summary note', dryRun);

    if (review.verdict === 'APPROVE') {
      this.callApi(`${mrPath}/approve`, {}, 'approval', dryRun);
    }

    const prefix = dryRun ? '[dry-run] Review NOT posted' : 'Review posted';
    log.info(`${prefix}: ${review.verdict} (${review.inline.length} inline, ${review.threaded.length} general discussion(s))`);
  }

  reportSkipped(ref: PrRef, _headSha: string, _title: string, body: string, dryRun = false): void {
    // GitLab's neutral equivalent is the job's allow_failure exit code; here just leave a note
    this.callApi(`${project(ref.slug)}/merge_requests/${ref.number}/notes`, { body }, 'skip note', dryRun);
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
