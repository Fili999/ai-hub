---
name: structured-handoff
description: Compact, reference-based summary to pass work to another agent or phase without dumping context. Prepares a compact handoff when a task passes between agents or phases — goal, work done, artifacts, checks, open issues, next step — referencing files instead of dumping contents. Use when delegating to an agent, passing work, or resuming work.
capabilities: [structured-handoff]
categories: [meta]
---

# Structured Handoff

Passes work to the next agent or phase with minimal overhead, avoiding conversation dumps.

## When to use

- When delegating a subtask to an agent or receiving its results.
- At the end of a workflow phase or a session that will resume later.

## When not to use

- Work completed entirely within the same session without handovers.
- To summarize context already accessible to the receiver.

## Procedure

1. State the **objective** of the assignment and the success criteria.
2. List **files and sources read** (paths), without pasting contents.
3. Summarize **actions executed** in a few concise lines.
4. List **artifacts produced** with their file paths.
5. Report **checks executed** and their outcomes (tests, quality gates).
6. Separate **verified facts** from **assumptions** and **open issues**.
7. Specify the proposed **next step**.

## Expected output

```
Assignment: … — criteria: …
Read: <paths>
Done: …
Artifacts: <paths>
Checks: <test/gate> → outcome
Facts: … | Assumptions: … | Open: …
Next step: …
```

## Attention

- No secrets or personal credentials in handoffs.
- If the handoff exceeds roughly twenty lines, you are likely copying content rather than referencing paths.
