# pr-audit

CLI tool that fetches a PR/MR, sends its diff to an AI review engine, and posts the results back as a native review with inline comments and a summary.

Supports multiple git providers and review engines:
- **Git providers**: GitHub, GitLab
- **Review engines**: Claude CLI, Codex CLI

## Prerequisites

- A review engine CLI, installed and authenticated:
  - **claude-cli**: [Claude Code CLI](https://claude.ai/code)
  - **codex-cli**: [Codex CLI](https://github.com/openai/codex) (ChatGPT subscription login or API key)
- A supported git provider CLI, installed and authenticated:
  - **GitHub**: [GitHub CLI](https://cli.github.com/) (`gh`)
  - **GitLab**: [GLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`) — set `GITLAB_HOST` for self-hosted instances
- Node.js 18+, pnpm

## Install

```bash
pnpm install
pnpm build
pnpm link --global
```

## Usage

```bash
# GitHub
pr-audit owner/repo#123
pr-audit https://github.com/owner/repo/pull/123

# GitLab
pr-audit group/project!123
pr-audit https://gitlab.com/group/project/-/merge_requests/123

# Options
pr-audit owner/repo#123 --engine claude-cli --model claude-opus-4-5   # specific engine + model
pr-audit owner/repo#123 --engine codex-cli                            # review with Codex
pr-audit owner/repo#123 --auth-token sk-ant-...                       # specific auth token
pr-audit owner/repo#123 --engine codex-cli --auth-token "$(cat ~/.codex/auth.json)"
pr-audit owner/repo#123 --provider github                             # explicit provider override
pr-audit owner/repo#123 --dry-run                                     # log payload, do not post
```

- **Provider** is auto-detected from the input format (`#` → GitHub, `!` → GitLab, URL hostname). Use `--provider` to override (e.g. self-hosted instances).
- **Engine** defaults to `claude-cli` with model `claude-sonnet-4-6`; `codex-cli` defaults to `gpt-6.1-sol`. Use `--engine` to select an engine; `--model` requires `--engine`.
- **Codex** runs `codex exec` in an empty read-only sandbox with your user config ignored, so local MCP servers/hooks don't leak into reviews. It reports token usage but no dollar cost (subscription-billed).
- **Dry-run** runs the full review (you still pay for Claude tokens) but skips the final post — useful for previewing what would be sent before committing to it.

## When the agent's usage limit is hit

Subscription quotas reset after hours, so pr-audit doesn't retry or fail the review. It stops at the
first quota error (Codex: "You've hit your usage limit…", Claude: "usage limit reached"), then:

- comments on the PR/MR: review skipped, with the reset time when the agent states one;
- **GitHub**: creates a neutral **AI review** check run on the head commit (needs `checks: write`),
  emits a `::warning` annotation and a job-summary note, and exits `0`;
- **elsewhere** (GitLab, local): exits `3`. In GitLab CI, `allow_failure: exit_codes: 3` shows the job
  as "passed with warnings".

Transient errors (HTTP 429, "model at capacity") are still retried.

## How it works

1. Detects the git provider from the input format and fetches PR/MR metadata + diff via the provider's CLI
2. Filters out lock files and generated files
3. Prints a cost estimate based on diff size before any Claude calls
4. Chunks the diff into batches (≤1000 rendered lines each), truncating files over 600 added lines with a notice so Claude knows the file is partial
5. Sends each batch to the configured review engine with a structured JSON prompt — failed batches are retried up to 3 times with exponential backoff
6. Synthesizes all batch summaries into a single coherent review summary via a final engine call
7. Posts a native review with inline comments and the synthesized summary back to the provider

## Run logs

Every run is logged to `~/.pr-audit/logs/` with the filename pattern:

```
YYYY-MM-DDTHH-MM-SS_SLUG_PRNUM.log
```

Each log captures the full execution trace at two levels:

- **INFO** — high-level flow: PR metadata, batch sizes, verdict, comment count, total cost
- **DEBUG** — full detail: Claude prompts, raw API responses, token usage per batch, individual comments, GitHub review payload

The log file path is printed at the end of every run.

```bash
# View latest run
cat ~/.pr-audit/logs/$(ls -1t ~/.pr-audit/logs/ | head -1)

# View only errors across all runs
grep "\[ERROR\]" ~/.pr-audit/logs/*.log

# View summaries across all runs
grep -A 5 "RUN SUMMARY" ~/.pr-audit/logs/*.log
```

## Development

```bash
pnpm dev owner/repo#123   # run with tsx (no build needed)
pnpm build                # compile to dist/
pnpm test                 # run tests
pnpm test:watch           # watch mode
```
