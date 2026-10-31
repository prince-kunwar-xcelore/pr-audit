# pr-audit

Reviews a pull request / merge request with an AI coding agent and posts the result back as a native review.

## Language

### Running a review

**Host**:
The machine pr-audit runs on: a developer laptop or a CI VM. pr-audit behaves the same on both; only the source of credentials differs.
_Avoid_: local mode, CI mode

**Engine**:
The agent CLI that does the reviewing (Claude Code or Codex). All engines are first-class: every review feature must work on each.
_Avoid_: model, backend, agent (alone)

**Provider**:
The code-hosting platform the change lives on (GitHub or GitLab). Providers may gain features at different times.
_Avoid_: platform, forge

**Credentials**:
What an engine needs to authenticate to its subscription. They come from the engine's own login on the host, or from agent-gateway, which only hands out credentials and never runs a review.
_Avoid_: token (alone), key

**Review session**:
The engine run that produces a review: one agent session working in a checkout of the change at its head commit, free to read any file in the repo.
_Avoid_: batch, prompt, call

**Verification**:
An optional second, independent engine session that tries to disprove each candidate finding of a review session, and drops or downgrades the ones it can't confirm.
_Avoid_: self-check, second opinion

### Requirements

**Requirements**:
What the change is supposed to do: its title and description plus the content of its linked issues.
_Avoid_: spec, acceptance criteria

**Linked issue**:
A tracker ticket the change refers to, on the provider or an external tracker such as Jira. Always a ticket, never a finding.
_Avoid_: ticket, story, task

### Review output

**Review**:
One pr-audit result posted on a change: a summary, a verdict and zero or more findings.

**Finding**:
One point the review raises, labelled with a severity and a kind. Either an inline finding or a general finding.
_Avoid_: comment, issue

**Severity**:
How much a finding matters: critical, warning or suggestion. The only thing that decides the verdict.
_Avoid_: priority, level

**Kind**:
What a finding is about: bug, security, requirement, test, question, cleanup or naming. Says nothing about whether it blocks.
_Avoid_: category, type

**Question**:
A finding of kind question: something the review can't settle from the code, which the author must answer or confirm. Blocks only at warning severity or above.
_Avoid_: clarification, re-verification

**Inline finding**:
A finding anchored to a line of the change: the line with the problem, or the line that causes it elsewhere (e.g. a changed return type that breaks a caller in another file).
_Avoid_: line comment

**General finding**:
A finding with no sensible line in the change to anchor to, such as a new case that must be handled in untouched code, or an unmet requirement. Lives in the review body.
_Avoid_: summary comment, outside-the-diff finding

**Verdict**:
The review's overall decision, derived from severities: request changes if any critical or warning remains (new or open), comment if only suggestions, approve if nothing.

**Thread**:
A finding as it lives on the provider, together with its replies and resolved/outdated state.

**Open finding**:
A critical or warning finding from an earlier review that is still unresolved: an unresolved, non-outdated thread, or a body finding the latest review raised again. Open findings hold the verdict at request changes.

**Follow-up**:
What an incremental review does with pr-audit's own open threads: resolve them when fixed or answered, reply when the author disputes but the finding stands, stay silent otherwise. Never touches other reviewers' threads.
_Avoid_: re-review, nagging

### Across runs

**Incremental review**:
A review covering only the commits pushed since the last review.
_Avoid_: partial review, delta review

**Review marker**:
The hidden record in a review's body of the commit it covered; the starting point for the next incremental review.

**Skipped review**:
A run that produced no review because the engine's usage limit was hit; reported as neutral, not as a failure.
