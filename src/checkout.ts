import { execFileSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './logger.js';

/** A checkout of the change at its head commit, with the base commit available. */
export interface Checkout {
  dir: string;
  /** How it was obtained, for the log. */
  source: 'current' | 'worktree' | 'clone';
  /** Remove whatever pr-audit created. */
  cleanup(): void;
}

export interface CheckoutTarget {
  /** `owner/repo` or `group/project`: used to recognise a clone of the same repo. */
  slug: string;
  headSha: string;
  baseSha: string;
  /** Commits that must also be present (e.g. the last reviewed commit). Fetched best-effort. */
  extraShas?: string[];
  /** Clone the repo into `dir` (provider CLI, so it carries the provider's auth). */
  clone(dir: string): void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function hasCommit(cwd: string, sha: string): boolean {
  return tryGit(cwd, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

/** The current directory's repo root if it is a clone of `slug`, else null. */
function sameRepoRoot(cwd: string, slug: string): string | null {
  const root = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const remotes = tryGit(root, ['remote', '-v']) ?? '';
  const wanted = slug.toLowerCase();
  const matches = remotes.split('\n').some((l) => {
    const url = l.split(/\s+/)[1]?.toLowerCase().replace(/\.git$/, '').replace(/\/$/, '') ?? '';
    return url.endsWith(`/${wanted}`) || url.endsWith(`:${wanted}`);
  });
  return matches ? root : null;
}

function remoteFor(root: string, slug: string): string {
  const lines = (tryGit(root, ['remote', '-v']) ?? '').split('\n');
  const wanted = slug.toLowerCase();
  const line = lines.find((l) => {
    const url = l.split(/\s+/)[1]?.toLowerCase().replace(/\.git$/, '') ?? '';
    return url.endsWith(`/${wanted}`) || url.endsWith(`:${wanted}`);
  });
  return line?.split(/\s+/)[0] ?? 'origin';
}

/** Fetch whichever of `shas` are missing, with full history (blobs on demand when partial). */
function fetchMissing(root: string, remote: string, shas: string[], required: string[]): void {
  const missing = shas.filter((s) => !hasCommit(root, s));
  if (missing.length === 0) return;
  // Shallow clones (CI's default depth 1) can't compute merge bases: deepen to full history
  const shallow = tryGit(root, ['rev-parse', '--is-shallow-repository']) === 'true';
  const args = ['fetch', '--quiet', '--no-tags', ...(shallow ? ['--unshallow'] : []), remote, ...missing];
  log.debug(`git ${args.join(' ')}`);
  try {
    git(root, args);
  } catch (err) {
    // One unreachable optional commit (e.g. a force-pushed-away review marker) fails the whole fetch
    log.debug(`fetch failed (${(err as Error).message.split('\n')[0]}); retrying required commits only`);
    git(root, ['fetch', '--quiet', '--no-tags', ...(shallow ? ['--unshallow'] : []), remote, ...required.filter((s) => !hasCommit(root, s))]);
    for (const s of missing.filter((m) => !required.includes(m))) tryGit(root, ['fetch', '--quiet', '--no-tags', remote, s]);
  }
}

/**
 * The agent reads files from disk, so the disk must show exactly the PR head. Use the current
 * directory when it already is that commit with the base available; otherwise add a temporary
 * worktree to the current clone, or clone into a temp dir. (CI's default checkout is GitHub's
 * merge commit at depth 1, which is neither.)
 */
export function prepareCheckout(target: CheckoutTarget, cwd = process.cwd()): Checkout {
  const { headSha, baseSha } = target;
  const required = [headSha, baseSha];
  const wanted = [...required, ...(target.extraShas ?? [])];

  const root = sameRepoRoot(cwd, target.slug);
  if (root) {
    const remote = remoteFor(root, target.slug);
    const head = tryGit(root, ['rev-parse', 'HEAD']);
    const clean = tryGit(root, ['status', '--porcelain', '--untracked-files=no']) === '';
    if (head === headSha && clean) {
      fetchMissing(root, remote, wanted, required);
      if (required.every((s) => hasCommit(root, s))) {
        return { dir: root, source: 'current', cleanup: () => {} };
      }
    }

    fetchMissing(root, remote, wanted, required);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-worktree-'));
    git(root, ['worktree', 'add', '--quiet', '--detach', dir, headSha]);
    return {
      dir,
      source: 'worktree',
      cleanup: () => {
        tryGit(root, ['worktree', 'remove', '--force', dir]);
        fs.rmSync(dir, { recursive: true, force: true });
        tryGit(root, ['worktree', 'prune']);
      },
    };
  }

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-clone-'));
  const dir = path.join(parent, 'repo');
  target.clone(dir);
  fetchMissing(dir, 'origin', wanted, required);
  git(dir, ['checkout', '--quiet', '--detach', headSha]);
  return { dir, source: 'clone', cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
}

/** Unified diff `from...to` (from the merge base, as the provider shows a PR), or `from..to` with `twoDot`. */
export function gitDiff(dir: string, from: string, to: string, twoDot = false): string {
  return git(dir, ['diff', '--no-color', '--no-ext-diff', twoDot ? `${from}..${to}` : `${from}...${to}`]);
}

export function isAncestor(dir: string, ancestor: string, of: string): boolean {
  return tryGit(dir, ['merge-base', '--is-ancestor', ancestor, of]) !== null;
}

export function mergeBase(dir: string, a: string, b: string): string {
  return git(dir, ['merge-base', a, b]);
}
