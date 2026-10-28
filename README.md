# pr-audit

CLI tool that fetches a PR/MR, sends its diff to an AI coding agent, and posts the results back as a native review with inline comments and a summary.

It drives the agents' own CLIs, so reviews can run on a **Claude or ChatGPT subscription** instead of API keys. In CI, pair it with [agent-gateway](https://github.com/prince-kunwar-xcelore/agent-gateway), which hands your local subscription credentials to allowlisted CI jobs (see [Running in CI](#running-in-ci)).

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
pr-audit owner/repo#123 --engine claude-cli --model claude-opus-5-5   # specific engine + model
pr-audit owner/repo#123 --engine codex-cli                            # review with Codex
pr-audit owner/repo#123 --effort high                                 # more reasoning (default: medium)
pr-audit owner/repo#123 --auth-token "$(cat ~/.claude/.credentials.json)"   # explicit Claude credentials
pr-audit owner/repo#123 --engine codex-cli --auth-token "$(cat ~/.codex/auth.json)"
pr-audit owner/repo#123 --provider github                             # explicit provider override
pr-audit owner/repo#123 --dry-run                                     # log payload, do not post
```

- **Provider** is auto-detected from the input format (`#` → GitHub, `!` → GitLab, URL hostname). Use `--provider` to override (e.g. self-hosted instances).
- **Engine** defaults to `claude-cli` with model `claude-sonnet-5-5`; `codex-cli` defaults to `gpt-6.1-sol`. Both run at **medium** reasoning effort; override with `--effort` (claude-cli: low, medium, high, xhigh, max; codex-cli: low, medium, high, xhigh, max, ultra). Use `--engine` to select an engine; `--model` requires `--engine`.
- **Auth**: without `--auth-token`, each engine uses your local login. `--auth-token` takes, for `claude-cli`, the contents of `~/.claude/.credentials.json` or a bare OAuth access token; for `codex-cli`, the contents of `~/.codex/auth.json` or an OpenAI API key. Credentials are written to a temporary home for the call and deleted afterwards.
- **Codex** runs `codex exec` in an empty read-only sandbox with your user config ignored, so local MCP servers and hooks don't leak into reviews. Its credentials live outside that sandbox directory, so the agent can't read them back into a review. It reports token usage but no dollar cost (subscription-billed).
- **Dry-run** runs the full review (it still uses your agent quota) but skips the final post. Use it to preview what would be sent.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Review posted (or dry-run finished). On GitHub Actions, also when the review was skipped for a usage limit. |
| `1` | Error (bad flags, fetch / engine / post failure). |
| `3` | Review skipped: the agent's usage limit was hit (outside GitHub Actions). |

## When the agent's usage limit is hit

Subscription quotas reset after hours, so pr-audit doesn't retry or fail the review. It stops at the
first quota error (Codex: "You've hit your usage limit…", Claude: "usage limit reached"), then:

- comments on the PR/MR: review skipped, with the reset time when the agent states one;
- **GitHub**: creates a neutral **AI review** check run on the head commit (needs `checks: write`),
  emits a `::warning` annotation and a job-summary note, and exits `0`;
- **elsewhere** (GitLab, local): exits `3`. In GitLab CI, `allow_failure: exit_codes: 3` shows the job
  as "passed with warnings".

Transient errors (HTTP 429, "model at capacity") are still retried.

## Running in CI

CI runners don't have your subscription login, so the workflow fetches it from
[agent-gateway](https://github.com/prince-kunwar-xcelore/agent-gateway) running on your machine:

1. Set up agent-gateway (`init --allow 'your-user/*'`, `service install`, `tunnel setup …`). See its README.
2. Add the repo secret `AGENT_GATEWAY_URL` with the gateway's public URL.
3. Copy a workflow template from agent-gateway's `examples/` (GitHub Actions or GitLab CI, Bun or Node) and set `REVIEW_AGENT` to `claude` or `codex`.

The GitHub template, in short:

```yaml
permissions:
  pull-requests: write   # post the review
  contents: read
  id-token: write        # prove the repo's identity to agent-gateway (OIDC)
  checks: write          # neutral "AI review" check when the usage limit is hit
...
- env:
    AGENT_GATEWAY_URL: ${{ secrets.AGENT_GATEWAY_URL }}
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PR_URL: ${{ github.event.pull_request.html_url }}
  run: |
    bun _pr-audit/src/index.ts "$PR_URL" --engine "$REVIEW_AGENT-cli" \
      --auth-token "$(bun _agent-gateway/src/index.ts decrypt-token --agent "$REVIEW_AGENT")"
```

This repo reviews its own PRs this way (`.github/workflows/pr-review.yml`).
Passing credentials via a file instead of the command line is tracked in [#8](https://github.com/prince-kunwar-xcelore/pr-audit/issues/8).

## How it works

1. Detects the git provider from the input format and fetches PR/MR metadata + diff via the provider's CLI
2. Filters out lock files and generated files
3. Prints a rough cost estimate based on diff size (API-equivalent pricing; subscription runs aren't billed per call)
4. Chunks the diff into batches (≤1000 rendered lines each), truncating files over 600 added lines with a notice so the agent knows the file is partial
5. Sends each batch to the configured review engine with a structured JSON prompt — failed batches are retried up to 3 times with exponential backoff (usage-limit errors are not retried)
6. Synthesizes all batch summaries into a single coherent review summary via a final engine call
7. Posts a native review with inline comments and the synthesized summary back to the provider

## Run logs

Every run is logged to `~/.pr-audit/logs/` with the filename pattern:

```
YYYY-MM-DDTHH-MM-SS_SLUG_PRNUM.log
```

Each log captures the full execution trace at two levels:

- **INFO** — high-level flow: PR metadata, batch sizes, verdict, comment count, total cost
- **DEBUG** — full detail: prompts, raw engine responses, token usage per batch, individual comments, review payload

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
