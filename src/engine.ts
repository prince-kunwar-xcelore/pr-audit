import type { BatchResult } from './types.js';
import { ClaudeCliEngine } from './engines/claude-cli.js';
import { CodexCliEngine } from './engines/codex-cli.js';

export interface ReviewEngine {
  readonly name: string;
  readonly defaultModel: string;

  review(prompt: string, model: string): BatchResult;
  synthesize(prompt: string, model: string): string;
}

export function resolveEngine(name: string, authToken = ''): ReviewEngine {
  switch (name) {
    case 'claude-cli':
      return new ClaudeCliEngine(authToken);
    case 'codex-cli':
      return new CodexCliEngine(authToken);
    default:
      throw new Error(`Unsupported engine: "${name}". Supported: claude-cli, codex-cli`);
  }
}
