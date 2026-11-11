---
name: code-change
description: Focused change to code in an existing project — fix a bug, add or change a feature, refactor a part — with criteria, targeted tests and a quality gate.
capabilities: [task-intake, acceptance-criteria, quality-gate]
optional-capabilities: [codebase-navigation]
sizes: [medium, large]
categories: [dev-app, dev-web, testing]
---

# Workflow: focused code change

For changing existing code with a verified result. Phases that do not apply are skipped; no phase is closed because it "looks done".

## When to use / when not

- **Yes**: a bug to fix, a feature to add or change, a part to refactor, in a project that already exists.
- **No**: small tasks (a typo, an obvious one-liner: just do them); brand-new projects; market research or discovery (other workflows).

## Phases

1. **Intake** (`task-intake`) — goal, constraints, what not to touch.
   *Output*: a clear assignment, size confirmed.
2. **Criteria** (`acceptance-criteria`) — expected behavior, edge cases, compatibility (e.g. Windows and macOS).
   *Output*: verifiable criteria, each with its own check.
3. **Orientation** — understand where to act: files involved, existing tests, conventions. In a large or unfamiliar repository use the `codebase-navigation` capability if available (for example an up-to-date code graph); otherwise targeted search. Then **read the real files** before changing them.
   *Output*: the list of files to touch and the relevant tests.
4. **Change** — the smallest change that meets the criteria, in the style of the existing code; tests added or updated for the changed behavior. For a bug: first reproduce it with a failing test; if the test fails for a reason other than the defect (wrong test, intended behavior), fix the test first and review the criteria.
   *Output*: a bounded diff plus tests.
5. **Verification** (`quality-gate`) — run the project's tests and checks, re-read the diff critically, verify each criterion with evidence.
   *Output*: `pass` (close), `fail` (back to phase 4 with the reason), `blocked` (a decision or access is needed: ask).
6. **Close** — report: what changed, evidence, what was not verified. Important decisions with `decision-record`.

## Delegation

Normally no agent. One at most, with `structured-handoff`, if a part is truly independent (for example a broad code search that returns a summary). Never two agents on the same files.

## Errors and retries

A test that fails twice in the same way is not retried identically: go back to diagnosis. If the cause is still unclear after a serious diagnosis, switch to the `deep-review` profile instead of insisting.
