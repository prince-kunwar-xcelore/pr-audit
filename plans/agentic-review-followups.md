# Agentic review: deferred work

Decided during the agentic-review design (see `GLOSSARY.md`, `docs/adr/`), not built yet.

- **Config file**: `.pr-audit.yml` in the reviewed repo, read from the **base** branch so a PR can't change its own
  review settings (verification, review rules, trackers, …). CLI flags override it.
- **Jira tracker**: a tracker (separate from providers) that turns `PROJ-123` references (title, description,
  branch, commits) into linked issues, with its own credentials (base URL + API token). Only scan for Jira keys when
  configured.
- **Verification engine / effort**: `--verify-engine`, `--verify-model`, `--verify-effort` (default: same as the
  review session). A different engine needs a second set of credentials from agent-gateway.
- **GitLab incremental reviews and follow-ups**: `fetchReviewHistory` (marker in the summary note, discussions with
  resolved state) and `applyFollowUps` (reply + resolve discussion) in `src/providers/gitlab.ts`.
- **Shorter-lived Codex tokens** in agent-gateway, to shrink the exposure accepted in ADR 0002.
- **Network allowlist** (fallback in ADR 0002): restrict the agent's fetches to the provider's and tracker's domains.
