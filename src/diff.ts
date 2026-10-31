import parseDiff from 'parse-diff';
import type { ParsedFile } from './types.js';
import { log } from './logger.js';

// Generated or vendored files: not reviewed, and not counted as reviewable changes
export const SKIP_PATTERNS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /\.lock$/,
  /\.min\.js$/,
  /^dist\//,
  /^\.next\//,
  /^build\//,
  /^out\//,
];

export function shouldSkip(path: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(path));
}

function commentableLines(chunks: parseDiff.Chunk[]): Set<number> {
  const lines = new Set<number>();
  for (const chunk of chunks) {
    for (const change of chunk.changes) {
      if (change.type === 'add') lines.add(change.ln);
      else if (change.type === 'normal') lines.add(change.ln2);
    }
  }
  return lines;
}

/** The reviewable files of a unified diff, with the head-side lines an inline comment can go on. */
export function parseDiffString(rawDiff: string): ParsedFile[] {
  const result: ParsedFile[] = [];
  for (const file of parseDiff(rawDiff)) {
    const path = file.to ?? file.from ?? '';
    if (!path || path === '/dev/null') continue;
    if (shouldSkip(path)) {
      log.debug(`Skipping file: ${path}`);
      continue;
    }
    result.push({ path, commentableLines: commentableLines(file.chunks) });
  }
  return result;
}
