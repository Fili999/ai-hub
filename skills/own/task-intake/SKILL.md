---
name: task-intake
description: Clarify goal, scope, size and risk of a new request and choose the lightest way to do it. Analyzes a request before starting work — goal, constraints, size, risk — and decides how to proceed: main session, how many agents are needed (often none), or a workflow with the right model profile. Use at the start of any non-trivial work.
capabilities: [task-intake, token-budget]
categories: [meta]
---

# Task Intake

Turn a request into a clear assignment, choosing the lightest execution path that guarantees the outcome.

## When to use

- At the start of a task with multiple steps, files, or decisions.
- When the request is ambiguous or it is unclear which skills or agents are needed.

## When not to use

- Simple questions or obvious modifications to one or two files: answer or implement directly.
- Work already defined by a previous intake that has not changed.

## Procedure

1. **Goal** in one or two sentences: what must exist or be true upon completion.
2. **Constraints**: deadlines, tools, files not to touch, sensitive data, actions requiring confirmation.
3. **Size and risk**:
   - *small*: few files, reversible → main session, no agents;
   - *medium*: multiple independent parts → at most one agent for an isolatable piece (e.g. research);
   - *large or risky*: multiple phases, external effects, security → a workflow with quality gates.
4. **Clarifying questions**: at most one, and only if the answer changes the outcome. Otherwise, state a reasonable assumption.
5. **Model profile**: `deterministic` (a script suffices), `fast`, `standard`, or `deep-review` (architecture, complex debugging, high risk). **Quality comes before token savings**: when in doubt choose the more capable profile and more thorough checks; save only on redundant work (repeated reads, superfluous agents). See `docs/principles.md`.
6. **Success criteria**: if the task is not small, define them using `acceptance-criteria`.
7. **Required capabilities**: list them (e.g. "verifiable research", "video editing") and search for skills using `search.mjs` instead of reading the entire catalog.

## Expected output

```
Goal: …
Constraints: …
Size/risk: small | medium | large — rationale
Mode: main session | agent <role> for <subtask> | workflow <name>
Profile: deterministic | fast | standard | deep-review
Capabilities: …
Assumptions: … (to be confirmed if significant)
```

## Attention

- Do not launch agents "just to be safe": every delegation costs context and must yield a clear benefit. But never forgo an agent, check, or read that genuinely improves output quality just to save tokens.
- Irreversible or external actions (publishing, sending data, deleting, spending) always require explicit confirmation.
