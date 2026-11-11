# Naming Conventions

Stable and recognizable names across Windows, macOS, and Linux; identical in directory, frontmatter, and registry.

## Identifiers

- **New** agents, skills, and workflows: `kebab-case` in English, `^[a-z0-9]+(?:-[a-z0-9]+)*$` (e.g., `core-orchestrator`, `source-verification`, `content-production`).
- **Current validator** (`isSafeName` in `scripts/lib/util.mjs`): `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`, without `..`. It is more permissive so as not to break existing and third-party elements: the strict rule applies to new own elements; narrowing the validator requires a prior migration (Phase B).
- User-facing descriptions and contents in English.
- Never in the name: models, paths, computer names, dates, versions, or suffixes like `-v2-final`. The version is metadata.
- Do not rename an active element without updating all references (agents, `registry.json`, `depends`, workflows).

## By Type

| Type | Rule | Examples | Avoid |
|---|---|---|---|
| Agent | A role or responsibility | `research-analyst`, `release-operations` | `helper`, `agent-1`, `super-agent` |
| Skill | An action or result, without `-skill` suffix | `milestone-planning`, `rollback-planning` | Names that require a sentence to understand |
| Workflow | A recognizable process | `mobile-app-discovery`, `maintenance-incident` | Date, author, or version in the name |
| Category | Short ID from `hub.config.json` with separate label | `dev-app`, `video` | New categories if an existing one is sufficient |

External skills keep their original name: the name describes the capability, origin is recorded in the lockfile.

## Files

- Own skills: `skills/own/<id>/SKILL.md`; own agents: `agents/own/<id>.md`.
- Documents in `docs/`: `kebab-case.md` (the guide remains `guide.md`).
- ESM scripts `.mjs`; tests `tests/<area>.test.mjs`, listed in the `test` script in `package.json`.
- Generated files: only in the destinations expected by the scripts, never renamed manually.

## Fields

Reuse existing names (`name`, `description`, `skills`, `categories`, `requires-commands`, `requires-mcp`, `depends`, `conflicts`, `model`, `effort`). No synonyms (`dependencies`, `needs`...) without migration. Distinguish frontmatter relationships, links in `registry.json`, dependencies deduced by scripts, and native Claude Code fields (see `contracts.md`).

## Checklist for a New Name

- [ ] Specific, unambiguous, without existing synonyms.
- [ ] `kebab-case`, consistent across path, frontmatter, and registry.
- [ ] No paths, secrets, computer names, or temporary details.
- [ ] Uses an existing category when possible.
- [ ] `npm run doctor` does not report duplicates.
