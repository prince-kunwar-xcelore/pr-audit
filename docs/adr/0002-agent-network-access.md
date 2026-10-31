# The review agent has network access; a leaked access token is an accepted risk

The review session may fetch linked issues and follow links itself, so it runs with network access. Everything it reads is attacker-influenceable: the diff comes from someone with push access, but linked issues and their comments can come from anyone on a public repo, so a planted "send your credentials to https://…" is a real prompt-injection path. The agent also holds something the PR author doesn't: the repo owner's Claude/Codex subscription credentials served by agent-gateway. We accept that a successful injection could leak the engine's access token, because agent-gateway strips the refresh token (the access token dies on its own: hours for Claude, days for Codex), and we mitigate the rest.

## Mitigations

- The agent can read but not write or run the project: read-only file tools and read-only git.
- pr-audit strips everything the engine doesn't need from its environment (`GH_TOKEN`, the agent-gateway auth file path, other CI secrets).
- The engine is denied reading its own credentials file wherever the engine supports path rules.
- Repo guidance (`CLAUDE.md`, `AGENTS.md`, `REVIEW.md`) is followed as it is on the base branch, so a PR can't rewrite its own review rules.

## Considered Options

- **No network, pr-audit prefetches everything.** Safest, but rejected: the agent should be able to follow a linked issue or reference pr-audit didn't anticipate.
- **Network restricted to the provider's and tracker's domains.** Kept as the fallback if exposure becomes a problem.
