import { describe, it, expect } from 'vitest';
import './setup.js';
import { resolveEngine } from '../src/engine.js';

describe('resolveEngine', () => {
  it('resolves claude-cli engine', () => {
    const engine = resolveEngine('claude-cli');
    expect(engine.name).toBe('Claude CLI');
  });

  it('resolves codex-cli engine', () => {
    const engine = resolveEngine('codex-cli');
    expect(engine.name).toBe('Codex CLI');
  });

  it('throws on unknown engine', () => {
    expect(() => resolveEngine('unknown-engine')).toThrow('Unsupported engine');
  });

  it('passes auth token to claude-cli', () => {
    const engine = resolveEngine('claude-cli', 'my-token');
    expect(engine).toBeDefined();
  });

  it('defaults to medium effort and accepts supported levels', () => {
    expect(resolveEngine('claude-cli').effort).toBe('medium');
    expect(resolveEngine('codex-cli', '', 'ultra').effort).toBe('ultra');
  });

  it('rejects effort levels the engine does not support', () => {
    expect(() => resolveEngine('claude-cli', '', 'ultra')).toThrow('Unsupported effort "ultra" for claude-cli');
  });
});
