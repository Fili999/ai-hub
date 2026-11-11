---
name: quality-gate
description: Check a deliverable against its acceptance criteria with real evidence before closing or proceeding, resulting in pass, fail, or blocked with gathered evidence. Use at the end of a task or phase, or before publishing or releasing.
capabilities: [quality-gate, artifact-verification]
categories: [testing]
---

# Quality Gate

Verifies that a deliverable genuinely satisfies its criteria, using real evidence rather than assertions.

## When to use

- Before declaring a task complete.
- At the end of a workflow phase, before proceeding to the next.
- Before publishing, sending, or releasing anything.

## When not to use

- On intermediate scratch drafts not yet consumed by anyone.
- As an infinite review loop: check once, fix, then re-check only what changed.

## Procedure

1. Retrieve the criteria (from `acceptance-criteria` or the request).
2. For each criterion gather **evidence**: test or command output, generated file, described manual check, primary source.
3. Run deterministic checks (tests, linting, validations, counts) instead of estimating the result.
4. Assign an outcome:
   - `pass`: all criteria have positive evidence;
   - `fail`: at least one criterion is not satisfied (specify what to fix);
   - `blocked`: something is missing to perform verification (access, data, user decision).
5. Explicitly list what you could **not** verify: never present unverified items as verified.

## Expected output

```
Outcome: pass | fail | blocked
1. <criterion> — ok | no | unverified — evidence: <test/command/file>
…
To fix: …
Unverified: … (reason)
```

## Attention

- Never mark "pass" without evidence. An agent claiming to be finished is not evidence.
- For security, releases, and external actions, this gate is mandatory and never skipped to save tokens.
