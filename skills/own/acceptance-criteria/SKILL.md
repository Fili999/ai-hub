---
name: acceptance-criteria
description: Define measurable, testable success criteria before starting work, so completion is clear and verifiable. Use for features, documents, content, campaigns, or any non-trivial deliverable.
capabilities: [acceptance-criteria]
categories: [project-mgmt, testing]
---

# Acceptance Criteria

Defines what must be true for work to be considered complete, and how to verify it.

## When to use

- Before implementing, writing, or producing anything non-trivial.
- When "done" is not obvious or needs to be aligned with the user.

## When not to use

- Trivial fixes with an evident outcome (a typo, a name).
- If criteria already exist and have not changed: reuse them.

## Procedure

1. Start from the goal (from intake if available).
2. Write 3 to 7 criteria, each **observable**: a behavior, a file, a metric, a format.
3. For each criterion specify **how it is verified**: an automated test, a command, a manual check, a primary source.
4. Add essential **edge cases** (empty input, failure modes, different platforms).
5. Specify what is **out of scope**, preventing unrequested work.
6. If a criterion depends on a user decision, ask now.

## Expected output

```
Criteria:
1. <what must be true> — verification: <how>
…
Edge cases: …
Out of scope: …
```

## Attention

- Avoid vague criteria ("works well", "is clear"): transform them into something verifiable.
- Criteria are verified at the end using `quality-gate`, never assumed to be satisfied.
