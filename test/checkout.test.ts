import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import './setup.js';
import { execFileSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitDiff, prepareCheckout, type CheckoutTarget } from '../src/checkout.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

let root: string;
let origin: string;
let baseSha: string;
let headSha: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-test-'));
  // A local "remote" whose path ends in the slug, so it is recognised as the same repo
  origin = path.join(root, 'owner', 'repo');
  fs.mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q');
  fs.writeFileSync(path.join(origin, 'app.ts'), 'const a = 1;\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'base');
  baseSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(origin, 'app.ts'), 'const a = 1;\nconst b = 2;\n');
  git(origin, 'commit', '-qam', 'head');
  headSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', 'main');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const target = (over: Partial<CheckoutTarget> = {}): CheckoutTarget => ({
  slug: 'owner/repo',
  headSha,
  baseSha,
  clone: (dir) => git(root, 'clone', '-q', origin, dir),
  ...over,
});

describe('prepareCheckout', () => {
  it('uses the current directory when it is already the PR head', () => {
    const clone = path.join(root, 'at-head');
    git(root, 'clone', '-q', origin, clone);
    git(clone, 'checkout', '-q', headSha);
    const co = prepareCheckout(target(), clone);
    expect(co.source).toBe('current');
    expect(co.dir).toBe(fs.realpathSync(clone));
  });

  it('adds a temporary worktree at the head when the clone is elsewhere (e.g. a shallow merge checkout)', () => {
    const clone = path.join(root, 'shallow');
    git(root, 'clone', '-q', '--depth', '1', `file://${origin}`, clone);
    git(clone, 'remote', 'set-url', 'origin', origin);
    const co = prepareCheckout(target(), clone);
    try {
      expect(co.source).toBe('worktree');
      expect(git(co.dir, 'rev-parse', 'HEAD')).toBe(headSha);
      expect(gitDiff(co.dir, baseSha, headSha)).toContain('+const b = 2;');
    } finally {
      co.cleanup();
    }
    expect(fs.existsSync(co.dir)).toBe(false);
  });

  it('clones when the current directory is not the same repo', () => {
    const elsewhere = fs.mkdtempSync(path.join(root, 'elsewhere-'));
    const co = prepareCheckout(target(), elsewhere);
    try {
      expect(co.source).toBe('clone');
      expect(git(co.dir, 'rev-parse', 'HEAD')).toBe(headSha);
    } finally {
      co.cleanup();
    }
    expect(fs.existsSync(co.dir)).toBe(false);
  });

  it('tolerates an optional commit that no longer exists', () => {
    const elsewhere = fs.mkdtempSync(path.join(root, 'gone-'));
    const co = prepareCheckout(target({ extraShas: ['0123456789abcdef0123456789abcdef01234567'] }), elsewhere);
    try {
      expect(git(co.dir, 'rev-parse', 'HEAD')).toBe(headSha);
    } finally {
      co.cleanup();
    }
  });
});
