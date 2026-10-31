import { describe, it, expect } from 'vitest';
import './setup.js';
import { parseDiffString } from '../src/diff.js';

const SIMPLE_DIFF = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;

const MULTI_FILE_DIFF = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 const z = 3;
diff --git a/bar.ts b/bar.ts
--- a/bar.ts
+++ b/bar.ts
@@ -1,1 +1,2 @@
 const m = 10;
+const n = 20;
`;

const LOCKFILE_DIFF = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,4 @@
 {}
+{"new": "dep"}
 {}
`;

const DELETE_ONLY_DIFF = `diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const removed = true;
-const gone = true;
`;

describe('parseDiffString', () => {
  it('parses a simple diff into one file', () => {
    const files = parseDiffString(SIMPLE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('file.ts');
  });

  it('parses multiple files', () => {
    const files = parseDiffString(MULTI_FILE_DIFF);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('foo.ts');
    expect(files[1].path).toBe('bar.ts');
  });

  it('skips lock files', () => {
    const files = parseDiffString(LOCKFILE_DIFF);
    expect(files).toHaveLength(0);
  });

  it('skips files in dist/', () => {
    const diff = SIMPLE_DIFF.replace(/file\.ts/g, 'dist/file.js');
    const files = parseDiffString(diff);
    expect(files).toHaveLength(0);
  });

  it('skips minified JS', () => {
    const diff = SIMPLE_DIFF.replace(/file\.ts/g, 'bundle.min.js');
    const files = parseDiffString(diff);
    expect(files).toHaveLength(0);
  });

  it('skips deleted files (/dev/null)', () => {
    const files = parseDiffString(DELETE_ONLY_DIFF);
    expect(files).toHaveLength(0);
  });

  it('builds commentable lines from adds and context', () => {
    const files = parseDiffString(SIMPLE_DIFF);
    const lines = files[0].commentableLines;
    expect(lines.has(2)).toBe(true);  // the added line
    expect(lines.has(1)).toBe(true);  // context line (ln2)
    expect(lines.has(3)).toBe(true);  // context line (ln2)
  });

});
