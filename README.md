# pr-audit

CLI tool that reviews a PR/MR with an AI coding agent and posts the result back as a native review with inline comments and a summary.

The agent works in a checkout of the PR's head commit: it runs `git diff` itself, reads any file it needs (callers, types, tests, the repo's own guidance), and checks the change against the issues it links to. A second, independent agent session then verifies the findings before anything is posted. See [GLOSSARY.md](GLOSSARY.md) for the vocabulary and [docs/adr/](docs/adr/) for why it works this way.

It drives the agents' own CLIs, so reviews can run on a **Claude or ChatGPT subscription** instead of API keys. In CI, pair it with [agent-gateway](https://github.com/prince-kunwar-xcelore/agent-gateway), which hands your local subscription credentials to allowlisted CI jobs (see [Running in CI](#running-in-ci)).

Supports multiple git providers and review engines:
- **Git providers**: GitHub, GitLab
- **Review engines**: Claude CLI, Codex CLI

## Prerequisites

- A review engine CLI, installed and authenticated:
  - **claude-cli**: [Claude Code CLI](https://claude.ai/code)
  - **codex-cli**: [Codex CLI](https://github.com/openai/codex) (ChatGPT subscription login or API key)
- `git`
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
pr-audit owner/repo#123 --auth-token-file ~/.claude/.credentials.json  # explicit Claude credentials
pr-audit owner/repo#123 --engine codex-cli --auth-token-file ~/.codex/auth.json
pr-audit owner/repo#123 --provider github                             # explicit provider override
pr-audit owner/repo#123 --full                                        # review the whole PR, not just new commits
pr-audit owner/repo#123 --no-verify                                   # skip the verification session
pr-audit owner/repo#123 --timeout 40                                  # review session limit in minutes (default 20)
pr-audit owner/repo#123 --dry-run                                     # log payload, do not post
```

- **Provider** is auto-detected from the input format (`#` → GitHub, `!` → GitLab, URL hostname). Use `--provider` to override (e.g. self-hosted instances).
- **Engine** defaults to `claude-cli` with model `claude-sonnet-5-5`; `codex-cli` defaults to `gpt-6.1-sol`. Both run at **medium** reasoning effort; override with `--effort` (claude-cli: low, medium, high, xhigh, max; codex-cli: low, medium, high, xhigh, max, ultra). Use `--engine` to select an engine; `--model` requires `--engine`.
- **Auth**: by default each engine uses your local login. To pass credentials explicitly, use `--auth-token-file <path>` (preferred: keeps them out of the process list), `--auth-token <value>`, or the `PR_AUDIT_AUTH_TOKEN` env var, in that order of precedence. The value is, for `claude-cli`, the contents of `~/.claude/.credentials.json` or a bare OAuth access token; for `codex-cli`, the contents of `~/.codex/auth.json` or an OpenAI API key. A given-but-empty value (empty file, `--auth-token ""`, empty env var) is an error rather than a silent fallback to the local login. Credentials are written to a temporary home for the call and deleted afterwards, and the `--auth-token` value is redacted from the run log.
- **Checkout**: the agent reads files from disk, so pr-audit makes sure the disk shows the PR head. If the current directory is a clean clone of the repo already at the head commit, it's used as is. Otherwise pr-audit adds a temporary `git worktree` to the current clone (fetching the head, base and, if needed, full history), or makes a blobless clone with `gh`/`glab` in a temp dir, and removes it afterwards. CI's default checkout (GitHub's merge commit, depth 1) takes the worktree path, so workflows need no special checkout settings.
- **What the agent may do**: read and search files, run read-only git (`diff`, `log`, `show`, `merge-base`, `rev-parse`; flags that write or read outside the checkout, `--output`, `-O`, `--no-index`, `--ext-diff`, are denied; `grep`, `blame` and `ls-files` are left out because some of their options run commands or read arbitrary files), and use web search / fetch to read linked issues or docs. It can't modify files or run the project. Claude runs with `--restricted --safe-mode` (file tools confined to the checkout, no project settings, hooks, MCP servers or auto-loaded `CLAUDE.md`); Codex runs `codex exec` with `--sandbox read-only`, live web search and user config ignored. The agent's environment holds only basic variables (`PATH`, `HOME`, locale, proxies) plus its own credentials: `GH_TOKEN` and other CI secrets are not passed on. Claude's credentials sit in a temp home outside the checkout, where its file tools can't reach; Codex's read-only sandbox can read them, an accepted risk since agent-gateway serves no refresh token ([ADR 0002](docs/adr/0002-agent-network-access.md)).
- **Repo guidance**: the agent follows the reviewed repo's `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `CONTRIBUTING.md` as they are on the **base** branch, so a PR can't rewrite its own review rules.
- **Requirements**: pr-audit collects the issues a PR links to (the provider's closing links, plus `#12`, `owner/repo#12` and issue URLs in the title, description and commit messages; a number in the branch name, like `12-csv-export`, only when nothing else is found), fetches up to 10 with their comments, and hands them to the agent with their links. An unmet requirement is a warning when the PR claims to close the issue (`Closes #12`, `Fixes #12`, or the provider's closing link), a suggestion when it only mentions it.
- **Findings** have a severity (critical, warning, suggestion) and a kind (bug, security, requirement, test, question, cleanup, naming). A **question** is something the code can't settle that the author must answer; it blocks only at warning. An **inline finding** goes on a line of the PR diff (where the problem is, or the change that causes it); a **general finding** has no such line. General findings become their own threads where the provider allows (GitHub: a file-level comment on a file in the PR; GitLab: an MR discussion), and otherwise go under **Other findings** in the review body.
- **Verification** (on by default, `--no-verify` to skip): a second session, same engine and model, gets the candidate findings without the reviewer's reasoning and tries to disprove each: keep, drop, downgrade or move it to a better line. It adds nothing new. It also confirms "fixed" / "answered" claims before pr-audit resolves a thread. If it fails or times out, the review is posted with the findings marked unverified.
- **Verdict** is set by pr-audit, not the model: REQUEST_CHANGES if any critical or warning remains (new findings and earlier threads still open), COMMENT if only suggestions, APPROVE if nothing.
- **Incremental** (GitHub): each review records the commit it covered in a hidden `<!-- pr-audit:sha=… -->` marker (and its body findings in `<!-- pr-audit:general=… -->`). Only markers and threads posted by pr-audit itself count (the `github-actions[bot]` account or the `gh` user running it), and only replies from the repo's owners, members and collaborators are passed on. The next run raises findings only on changes pushed since then, with the whole PR and repo as context. The agent gets its open threads in full, with replies, and resolved / outdated ones as one-liners. It follows up on the open ones: resolves them (with a reply) when fixed or convincingly answered, replies when the author disputes but the finding stands, and otherwise stays quiet. Where its own reply is the last word, it doesn't reply again until the author answers. Resolving a thread through GitHub's API needs `contents: write`, which the workflow templates don't grant (see #25). Without it, the reply still goes up with a hidden `<!-- pr-audit:resolved -->` marker, pr-audit treats the thread as resolved from then on, and it stays open on GitHub for a human to close. Last review's body findings are re-checked and either raised again or dropped. If the head commit was already reviewed, it exits without posting. After a force-push that drops the commit, or with `--full`, it reviews the whole PR. GitLab always reviews the full diff.
- **Limits**: the review session gets 20 minutes and verification 10 (`--timeout <min>` sets the review limit; verification gets half). A crash or network error is retried once; timeouts, usage limits and authentication errors are not.
- **Usage**: after the run, pr-audit logs each session's tokens, cache reads, duration and (Claude) API-equivalent cost, and on GitHub Actions adds a table to the job summary. Nothing about usage goes in the posted review.
- **Dry-run** runs the full review (it still uses your agent quota) but skips posting the review and follow-ups. Use it to preview what would be sent.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Review posted (or dry-run finished). On GitHub Actions, also when the review was skipped for a usage limit. |
| `1` | Error (bad flags, fetch / engine / post failure, agent authentication failure, review session timeout). |
| `3` | Review skipped: the agent's usage limit was hit (outside GitHub Actions). |

## When the agent's usage limit is hit

Subscription quotas reset after hours, so pr-audit doesn't retry or fail the review. It stops at the
first quota error (Codex: "You've hit your usage limit…"; Claude: "usage limit reached", "You've hit
your 5-hour limit · resets …", or the weekly limit), then:

- comments on the PR/MR: review skipped, with the reset time when the agent states one;
- **GitHub**: creates a neutral **AI review** check run on the head commit (needs `checks: write`),
  emits a `::warning` annotation and a job-summary note, and exits `0`;
- **elsewhere** (GitLab, local): exits `3`. In GitLab CI, `allow_failure: exit_codes: 3` shows the job
  as "passed with warnings".

Transient errors (HTTP 429, "hit your rate limit", "model at capacity") are still retried once.

## When the agent's credentials are rejected

Expired or invalid credentials (Claude: "Not logged in", "Failed to authenticate: OAuth session
expired…"; Codex: 401 Unauthorized) aren't retried either. pr-audit stops with one line, e.g.

```
Claude CLI authentication failed: Not logged in · Please run /login — refresh the login on the machine the credentials come from (run `claude` there once), or check the auth token
```

On GitHub Actions the same line is emitted as an `::error` annotation. Unlike a usage limit, this is a
real failure: the job fails with exit code `1`.

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
- name: Fetch agent credentials
  env:
    AGENT_GATEWAY_URL: ${{ secrets.AGENT_GATEWAY_URL }}
  run: |
    set -euo pipefail
    umask 077
    bun _agent-gateway/src/index.ts decrypt-token --agent "$REVIEW_AGENT" > "$RUNNER_TEMP/agent-auth"
    # mask every line and every JSON string value, so the credentials never show in logs
    { cat "$RUNNER_TEMP/agent-auth"; echo; jq -r '.. | strings' "$RUNNER_TEMP/agent-auth" 2>/dev/null || true; } |
      while IFS= read -r secret; do
        if [ "${#secret}" -ge 8 ]; then echo "::add-mask::$secret"; fi
      done
- env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PR_URL: ${{ github.event.pull_request.html_url }}
  run: |
    bun _pr-audit/src/index.ts "$PR_URL" --engine "$REVIEW_AGENT-cli" \
      --auth-token-file "$RUNNER_TEMP/agent-auth"
```

The credentials never appear in a command line, and if `decrypt-token` fails the job stops at that
step with its real error instead of reviewing with an empty token.

**Codex on GitHub-hosted Ubuntu runners** needs one more step before the review. Codex reads files only through shell
commands in its bubblewrap sandbox, and Ubuntu 24.04 runners restrict the unprivileged user namespaces that sandbox
needs (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`):

```yaml
- name: Allow the Codex sandbox
  if: env.REVIEW_AGENT == 'codex'
  run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

pr-audit checks the sandbox before the first Codex session and fails with this hint rather than letting the agent
review without being able to read the checkout.

The templates check out agent-gateway and pr-audit at pinned commits (the `# pin: … main` lines), so a push to
either tool doesn't change what runs with your credentials. To move the pins to the current `main`, run
agent-gateway's `scripts/pin-review-tools.sh <workflow files…>` and commit the result.

This repo reviews its own PRs this way (`.github/workflows/pr-review.yml`), with pr-audit itself pinned too, so a PR
is never reviewed by its own unreviewed code. PRs from forks are skipped there: they get no secrets, no OIDC token
and a read-only `GITHUB_TOKEN`.

## How it works

1. Detects the git provider from the input format and fetches PR/MR metadata (title, description, head / base commits, branch names, commit messages, closing issue links) via the provider's CLI
2. On GitHub, reads the last pr-audit review's commit marker, body findings and earlier pr-audit threads (exits if the head commit was already reviewed)
3. Collects linked issues and fetches their content
4. Prepares a checkout of the head commit (see **Checkout** above)
5. Computes the PR's files from `git diff <merge-base> <head>`, ignoring lock files and generated files; on an incremental run, exits if nothing reviewable changed since the last review
6. **Review session**: one agent session in the checkout, with the PR, requirements, open threads and last body findings in its prompt, returns a summary, findings and thread follow-ups as structured JSON
7. **Verification session** (unless `--no-verify` or there's nothing to verify) filters the findings and confirms resolutions
8. Places findings (inline on diff lines, general ones as their own threads or in the body), derives the verdict, and posts a native review whose body ends with the commit and body-findings markers
9. Posts the follow-ups: replies on earlier threads and resolves the fixed / answered ones
10. Logs usage per session

## Run logs

Every run is logged to `~/.pr-audit/logs/` with the filename pattern:

```
YYYY-MM-DDTHH-MM-SS_SLUG_PRNUM.log
```

Each log captures the full execution trace at two levels:

- **INFO** — high-level flow: PR metadata, linked issues, checkout, verification decisions with reasons, verdict, usage per session
- **DEBUG** — full detail: prompts, raw engine responses, individual findings, review payload

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

See [CLAUDE.md](CLAUDE.md) for the source layout and the provider / engine interfaces.
