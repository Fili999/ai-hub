---
name: decision-record
description: Log a significant decision with context, options, choice, and consequences so it is not reopened without reason. Use when choosing an architecture, tool, policy, data format, or project direction.
capabilities: [decision-record]
categories: [project-mgmt]
---

# Decision Record

Records a decision in concise form where the project tracks architectural and design decisions.

## When to use

- When a choice impacts architecture, security, persistent data, compatibility, costs, or direction.
- When the user chooses among proposed alternatives.

## When not to use

- Trivial or easily reversible choices (a variable name, a temporary color).
- To log activity narrative: activity belongs in handoffs or task reports.

## Procedure

1. Locate the project decision log (e.g. `docs/decisions.md`); if none exists, propose creating one without creating it unprompted.
2. Draft the entry:
   - **Date and concise title**;
   - **Context**: the underlying problem in one or two sentences;
   - **Options** considered (including rejected alternatives);
   - **Decision** and **rationale**;
   - **Consequences**: what changes, what tradeoffs emerge, when to revisit.
3. If this supersedes a previous decision, link them explicitly.
4. Keep unresolved questions in a separate section, not among finalized decisions.

## Expected output

```
**YYYY-MM-DD — Title.**
Context: … Options: … Decision: … because … Consequences: …
```

## Attention

- Record only decisions genuinely finalized (by the user or with mutual consent), never speculative assumptions.
- No secrets or personal credentials in the record.
