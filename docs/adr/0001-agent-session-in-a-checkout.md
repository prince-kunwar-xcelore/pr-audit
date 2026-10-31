# A review is one agent session in a checkout, not a diff prompt

pr-audit used to paste the diff (3 lines of context) into tool-less `claude -p` / `codex exec` calls, split into fixed 1000-line batches with a synthesis call on top. The agent could not open callers, types, tests or the repo's own guidance, every batch started cold, and files over 600 added lines were silently cut. We now run one review session per review: the engine's working directory is a checkout of the change at its head commit, it computes the diff itself and reads whatever it needs, and returns the same structured output. Batching, truncation and synthesis are gone, and review quality is put ahead of quota: a session reads far more than the diff and costs more.

## Considered Options

- **Keep the pipeline, paste whole changed files.** Cheaper, but the agent still can't follow a reference into an unchanged file, which is where cross-file breakage lives.
- **Agent session in a checkout (chosen).** The CLIs are agents already; the old design used them as plain completion endpoints.

## Consequences

- pr-audit must guarantee the checkout is the PR head with history (CI's default checkout is the merge commit, depth 1), so it prepares its own when the current directory isn't.
- The verdict is no longer the model's: pr-audit derives it from the severities of the findings that survive verification, so one inconsistent model answer can't approve past a warning.
- Findings can land outside the diff, so findings are inline (anchored to a line of the change) or general (their own thread, or the review body).
