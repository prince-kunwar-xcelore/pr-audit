# pr-audit

CLI tool that reviews pull requests / merge requests using AI and posts results back as native reviews with inline comments.

## Architecture

```
src/
  index.ts              CLI entry point, orchestration loop
  types.ts              Shared types: PrRef, PrData, ReviewOutput, BatchResult, etc.
  provider.ts           GitProvider interface + resolveProvider() auto-detection
  engine.ts             ReviewEngine interface + resolveEngine() factory
  claude.ts             Prompt building (buildPrompt, buildSynthesisPrompt) + mergeResults
  diff.ts               Unified diff parsing, file filtering, chunking, comment validation
  logger.ts             Dual-stream logging (console + file)
  providers/
    github.ts           GitHubProvider — fetches via `gh` CLI, posts via GitHub API
    gitlab.ts           GitLabProvider — fetches via `glab` CLI, posts discussions/notes/approve via GitLab API
  engines/
    claude-cli.ts       ClaudeCliEngine — calls `claude -p` CLI
    codex-cli.ts        CodexCliEngine — calls `codex exec --json --output-schema` CLI
    mock.ts             MockEngine — canned responses for testing
  mocks/
    provider.ts         MockProvider — canned PR data for testing
```

## Key Abstractions

**GitProvider** (`src/provider.ts`):
- `fetchPr(ref: PrRef): PrData` — get PR metadata + unified diff
- `postReview(ref, headSha, review, comments)` — post review back to platform
- `reportSkipped(ref, headSha, title, body)` — comment (+ neutral check run on GitHub) when no review was produced
- Auto-detected from input: `owner/repo#123` → GitHub, `group/project!123` → GitLab

**ReviewEngine** (`src/engine.ts`):
- `review(prompt, model): BatchResult` — structured JSON review of a diff batch
- `synthesize(prompt, model): string` — plain text summary synthesis
- `defaultModel` — each engine knows its default (e.g. `claude-sonnet-4-6`)
- Engines throw `UsageLimitError` (via `detectUsageLimit()`) when the agent subscription is out of quota; `index.ts` skips retries, calls `reportSkipped()`, and exits 0 on GitHub Actions / 3 elsewhere (`EXIT_USAGE_LIMIT`)

## Data Flow

```
parseArgs → resolveProvider + resolveEngine
  → provider.fetchPr()
  → parseDiffString() → chunkFiles()
  → for each batch: buildPrompt() → engine.review()
  → mergeResults()
  → if multi-batch: buildSynthesisPrompt() → engine.synthesize()
  → validateComments()
  → provider.postReview()
```

## CLI Flags

```
pr-audit <ref> [--engine <engine>] [--model <model>] [--auth-token <token>] [--provider <provider>] [--dry-run]
```

- `--engine`: Review engine — `claude-cli` (default) or `codex-cli`. Required if `--model` is set.
- `--model`: Model override. Uses engine's `defaultModel` if omitted.
- `--auth-token`: Auth token passed to the engine — `claude-cli`: Claude credentials JSON or OAuth access token; `codex-cli`: contents of `~/.codex/auth.json` or an OpenAI API key.
- `--provider`: Explicit git provider override (default: auto-detected from input).
- `--dry-run`: Run the review but log the would-be API payload instead of posting. Providers must honor the `dryRun` flag in `postReview()`.

## Tech Stack

- TypeScript (ESM, strict mode, target ES2022)
- pnpm, compiled with tsc to `dist/`
- Runtime dependency: `parse-diff`
- Testing: `vitest`
- External CLIs: `gh` (GitHub), `glab` (GitLab), `claude` (Claude Code), `codex` (Codex CLI)

## Build & Run

```bash
pnpm install && pnpm build       # compile
pnpm dev owner/repo#123          # run with tsx (no build needed)
pnpm link --global               # install as global CLI
```

## Logs

Written to `~/.pr-audit/logs/YYYY-MM-DDTHH-MM-SS_SLUG_NUM.log` with INFO + DEBUG levels.

## Tests

```bash
pnpm test                        # run once
pnpm test:watch                  # watch mode
```

Tests use `MockEngine` and `MockProvider` for isolation. The null logger is injected via `test/setup.ts`. Provider-specific tests live in `test/providers/<name>.test.ts` and mock `child_process.execSync` to assert on the exact shell command + payload (without hitting the network).

## Maintenance

After any change that affects CLI usage, flags, architecture, build commands, or tech stack, update both `CLAUDE.md` and `README.md` to reflect the change.

## Pending Work

See `plans/` for outstanding tasks:
- `plans/additional-engines.md` — OpenAI, Ollama, Anthropic API engines
