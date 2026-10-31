# pr-audit

CLI tool that reviews pull requests / merge requests using AI and posts results back as native reviews with inline comments.

## Architecture

See `GLOSSARY.md` for the domain vocabulary (review session, verification, finding, inline / general finding, severity, kind, follow-up, …) and `docs/adr/` for the design decisions.

```
src/
  index.ts              CLI entry point: flags, fetch PR + history + linked issues, prepare checkout, runReview, usage report
  review.ts             runReview(): review session → verification session → placement → verdict → post → follow-ups
  prompt.ts             Review / verification prompts and their JSON schemas
  checkout.ts           prepareCheckout(): current dir, temp worktree, or blobless clone at the PR head; git helpers
  requirements.ts       Linked-issue references from provider links, title, description, branch, commits
  types.ts              Shared types: PrData, Finding, ReviewPost, session outputs, SessionUsage, …
  provider.ts           GitProvider interface + resolveProvider() auto-detection
  engine.ts             ReviewEngine interface (one agent session), engineEnv() allowlist, error types + detectors
  auth-token.ts         Credentials from --auth-token / --auth-token-file / env; argv redaction for logs
  diff.ts               Unified diff parsing: reviewable files and their commentable lines
  review-history.ts     SHA + body-findings markers, earlier pr-audit threads, finding tags
  logger.ts             Dual-stream logging (console + file)
  providers/
    github.ts           GitHubProvider — gh CLI: GraphQL PR metadata, issues, reviews, file comments, thread replies/resolution
    gitlab.ts           GitLabProvider — glab CLI: MR metadata, issues, discussions/notes/approve
  engines/
    claude-cli.ts       ClaudeCliEngine — `claude -p --restricted --safe-mode` read-only session in the checkout
    codex-cli.ts        CodexCliEngine — `codex exec --sandbox read-only` session in the checkout, live web search
    mock.ts             MockEngine — per-label queues of canned session answers
  mocks/
    provider.ts         MockProvider — canned PR data / history / issues for testing
```

## Key Abstractions

**GitProvider** (`src/provider.ts`):
- `fetchPr(ref): PrData` — title, description, URL, head/base SHAs and branches, commit messages, provider closing-issue links
- `cloneRepo(ref, dir)` — clone with the provider CLI (fallback checkout)
- `fetchIssue(issueRef)` — linked issue content + comments, or null (missing / a PR)
- `postReview(ref, headSha, ReviewPost, dryRun)` — inline findings on diff lines, `threaded` general findings as their own threads
- `threadsGeneralFinding(finding, prPaths)` — whether a general finding can be its own thread (GitHub: file in the PR; GitLab: always); the rest go in the review body
- `reportSkipped(ref, headSha, title, body)` — comment (+ neutral check run on GitHub) when no review was produced
- optional `fetchReviewHistory(ref)` / `applyFollowUps(ref, posts)` — incremental reviews and follow-ups (GitHub only so far)
- Auto-detected from input: `owner/repo#123` → GitHub, `group/project!123` → GitLab

**ReviewEngine** (`src/engine.ts`):
- `run<T>({ label, prompt, schema, cwd, model, timeoutMs }): { output: T, usage }` — one agent session working in `cwd` (the checkout), answering with JSON matching `schema`
- Read-only: file read/search, read-only git (`READ_ONLY_GIT`), web search/fetch; never writes or runs the project
- The agent CLI's environment is `engineEnv()`: an allowlist (PATH, HOME, locale, proxies, engine config dirs) plus its credentials — no `GH_TOKEN` or CI secrets
- `defaultModel` — `claude-sonnet-5-5` / `gpt-6.1-sol`; effort from `--effort` (default medium) as `claude --effort` / codex `-c model_reasoning_effort`
- Engines throw `UsageLimitError` (via `detectUsageLimit()`) when the subscription is out of quota; `index.ts` calls `reportSkipped()` and exits 0 on GitHub Actions / 3 elsewhere (`EXIT_USAGE_LIMIT`)
- Engines throw `AgentAuthError` (via `detectAuthError()`) on missing/expired/rejected credentials; exit 1 with one line (plus `::error` on GitHub Actions)
- Engines throw `SessionTimeoutError` when the session exceeds `timeoutMs`; a review timeout exits 1, a verification timeout posts the review unverified
- Detectors only see failure text (Claude's error envelope `result`, Codex `turn.failed`/`error` events, stderr), never agent messages that may quote the PR
- `review.ts` retries a session once on other errors; never on usage limit, auth or timeout

## Data Flow

```
parseArgs → resolveProvider + resolveEngine
  → provider.fetchPr() → provider.fetchReviewHistory?()   (exit if head already reviewed)
  → findIssueMentions() → provider.fetchIssue() ×≤10
  → prepareCheckout()   (current dir | worktree | clone, at headSha with baseSha [+ lastSha])
  → runReview():
      git diff mergeBase..head → prFiles; incremental scope lastSha..head (exit if nothing reviewable)
      → engine.run(review)        buildReviewPrompt: PR, requirements, open threads T1…, closed one-liners, last body findings
      → engine.run(verification)  buildVerifyPrompt: candidates F1…, resolutions to confirm   (unless --no-verify / nothing to verify)
      → placeFindings() inline | general → threaded | body
      → deriveVerdict(findings + still-open blocking threads)
      → provider.postReview()  body ends with reviewMarker(head) + generalMarker(body findings)
      → provider.applyFollowUps?()
  → checkout.cleanup() → usage report (log + GITHUB_STEP_SUMMARY)
```

## CLI Flags

```
pr-audit <ref> [--engine <engine>] [--model <model>] [--effort <level>] [--auth-token <token> | --auth-token-file <path>] [--provider <provider>] [--full] [--no-verify] [--timeout <minutes>] [--dry-run]
```

- `--engine`: Review engine — `claude-cli` (default) or `codex-cli`. Required if `--model` is set.
- `--model`: Model override. Uses engine's `defaultModel` if omitted.
- `--effort`: Reasoning effort (default `medium`), validated per engine against `ENGINE_EFFORTS` in `src/engine.ts`.
- `--auth-token` / `--auth-token-file` / `$PR_AUDIT_AUTH_TOKEN` (that precedence, see `src/auth-token.ts`): Auth token passed to the engine — `claude-cli`: Claude credentials JSON or OAuth access token; `codex-cli`: contents of `~/.codex/auth.json` or an OpenAI API key. Empty-but-given is an error; the `--auth-token` value is redacted from the logged command line.
- `--provider`: Explicit git provider override (default: auto-detected from input).
- `--full`: Review the whole PR even if an earlier pr-audit review exists (default: only changes since the commit in the last review's `<!-- pr-audit:sha=… -->` marker; GitHub only).
- `--no-verify`: Skip the verification session (default: on).
- `--timeout`: Review session limit in minutes (default 20); verification gets half (default 10).
- `--dry-run`: Run the review but log the would-be API payloads (review, file comments, follow-ups) instead of posting. Providers must honor the `dryRun` flag.

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

Tests use `MockEngine` and `MockProvider` for isolation (`test/review.test.ts` drives `runReview()` end to end with a fake `Workspace`). The null logger is injected via `test/setup.ts`. Provider and engine tests live in `test/providers/` and `test/engines/` and mock `child_process.execFileSync` to assert on the exact command arguments + payload (without hitting the network). `test/checkout.test.ts` uses real temporary git repos.

## Maintenance

After any change that affects CLI usage, flags, architecture, build commands, or tech stack, update both `CLAUDE.md` and `README.md` to reflect the change.

## Pending Work

See `plans/` for outstanding tasks:
- `plans/additional-engines.md` — OpenAI, Ollama, Anthropic API engines
- `plans/agentic-review-followups.md` — config file, Jira tracker, verify engine/effort flags, GitLab incremental + follow-ups
