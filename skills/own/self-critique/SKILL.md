---
name: self-critique
description: Honest retrospective with a per-dimension score on the result, skills, agents, and workflow used. Rate work from 1 to 5 across dimensions (correctness, completeness, robustness, simplicity, verification, process, tools) — what could be done better, which assumptions should have been questioned, which alternatives existed — with concrete proposals for improvement. Use after quality gate according to hub settings.
capabilities: [self-critique, retrospective]
categories: [testing, meta]
---

# Self-Critique and Improvement

Critically dissects both the outcome and how it was achieved, so the next iteration is better. A focused, actionable review.

## When to use

- After the quality gate of any non-trivial task (setting "at completion", default) or every phase ("at every phase"). Reported by `route.mjs`.
- Whenever a gate failed, attempts were repeated, or user corrections were required.

## When not to use

- If self-critique is disabled in Settings (`quality.selfCritique: off`).
- On small tasks with clean outcomes: the final check suffices.

## Point-by-point evaluation

Rate each dimension from 1 to 5, stating the rationale and what is needed to reach a 5. Ground scores in evidence (tests, checks, sources); when in doubt, choose the lower score.

| Dimension | Question |
|---|---|
| Correctness | Does it do what it should, without errors? |
| Completeness | Does it satisfy all acceptance criteria? |
| Robustness | Does it handle edge cases, errors, Mac and Windows? |
| Simplicity | Is it the minimal, readable solution? |
| Verification | How thoroughly is it proven (tests, commands)? |
| Process | Was execution efficient and well-ordered? |
| Tooling | Did used skills, agents, and workflows help? |

Scale: 5 excellent · 4 good · 3 sufficient · 2 weak · 1 inadequate. Any score under 4 must produce at least one weakness; proposals target lowest scores. No overall average: an average hides weaknesses.

## Procedure

1. **Outcome**: what is weak, incomplete, or merely acceptable? Actively seek defects rather than confirmation.
2. **Assumptions**: which assumptions went unverified? Which, if false, alters the result?
3. **Alternatives**: was there a simpler, more robust approach? Why was it not chosen?
4. **Process**: where was time or context wasted (redundant reads, superfluous agents, retries)? Where was deeper analysis needed?
5. **Tooling**: for each skill, agent, or workflow, what was missing, ambiguous, or misleading?
6. **Proposals**: at most 3 actionable improvements, prioritizing lowest scores (e.g. "add check X to quality-gate").
7. **Application**, per `quality.improvements` setting:
   - *propose* (default): present proposals to user;
   - *apply to own skills*: edit only `skills/own/`, `agents/own/`, or `workflows/`, run doctor and tests; never touch external items.
8. A single experience is a **hypothesis for improvement**, not a universal rule: clarify this when proposing.
9. **Record** (if enabled): `node "<hub>/scripts/evaluate.mjs" record '<json>'` with `request`, `size`, `workflow`, `skills`, `agents`, `gate`, `retries`, `routing`, and `scores` across the seven dimensions (`correctness`, `completeness`, `robustness`, `simplicity`, `verification`, `process`, `tools`).

## Expected output

```
Evaluation:
Correctness 4/5 — <rationale> → for 5: <what is needed>
Completeness …/5 · Robustness …/5 · Simplicity …/5 · Verification …/5 · Process …/5 · Tooling …/5
Weaknesses of deliverable: …
Assumptions to verify: …
Better alternatives: …
Process improvements: …
Skills/agents/workflow feedback: <name> — <issue>
Proposals (max 3): 1. … — where — how to verify
Applied: … | Proposed to user: …
```

## Attention

- Self-critique does not reopen user decisions without new facts.
- Honesty first: if the outcome has limitations, state them clearly even if the gate passed.
