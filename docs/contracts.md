# Contracts for Skills, Agents, Workflows, and Handoffs

This document describes fields **actually read by code** (`scripts/lib/scan.mjs`) and, separately, those that are **planned**. A planned field is currently ignored: do not rely on it as if it were functional.

## Skills — `SKILL.md` (Implemented)

YAML frontmatter (flat-key subset parsed by `scripts/lib/frontmatter.mjs`):

| Field | Required | Meaning |
|---|---|---|
| `name` | Recommended (default: directory name) | Technical identifier; must match directory |
| `description` | **Yes** | What it does and when to use it. Without it, the skill is never auto-selected |
| `categories` | No | Categories from `hub.config.json`; inferred if missing |
| `capabilities` | No | General capabilities provided, kebab-case id (e.g., `codebase-navigation`). Indexed and weighted like name in search |
| `allowed-tools` | No | Allowed tools while skill is active |
| `requires-commands` | No | Required command-line binaries (checked in PATH, never executed) |
| `requires-mcp` | No | Required MCP connectors |
| `depends` | No | Other skills or agents it depends on |
| `conflicts` | No | Incompatible elements |
| `model`, `effort` | No | Model and effort hints (parsed and displayed; not strictly enforced) |

Template: `templates/skill/SKILL.md`. The body describes when to use it, procedure, expected output, and user confirmation checkpoints.

## Agents — `agents/**/<name>.md` (Implemented)

| Field | Required | Meaning |
|---|---|---|
| `name` | **Yes** | Technical identifier |
| `description` | **Yes** | When to delegate to this agent |
| `tools` | No | Allowed tools (fewer tools = safer) |
| `model`, `effort` | No | Model and effort guidance |
| `skills` | No | Skills declared by agent (others linked in `registry.json`) |
| `categories`, `capabilities`, `requires-*`, `depends`, `conflicts` | No | Same as for skills |

Template: `templates/agent.md`. The body describes the role, operating procedure, and constraints.

## Claude Code Native Fields

The hub passes these through without parsing (sync links the files as they are). Defined in `scripts/lib/schema.mjs`:
- Skills: `allowed-tools`, `license`, `metadata`, `version`, `argument-hint`, `disable-model-invocation`, `user-invocable`, `context`, `agent`, `hooks`, `paths`, `when_to_use`;
- Agents: `tools`, `disallowedTools`, `skills`, `permissionMode`, `hooks`, `color`, `mcpServers`, `memory`, `maxTurns`, `background`, `isolation`, `initialPrompt`.

If Claude Code introduces a new native field, simply append it to that list.

## Validation (`npm run inventory`, `npm run doctor`)

| Check | Level | Target Items |
|---|---|---|
| Unreadable frontmatter | error | all |
| Duplicate names | error | all |
| Missing description (skills and agents) or formatted as list | warn | all |
| Name differs from directory name | warn | skills |
| Typo in known field (e.g. `requires-comands` → `requires-commands`) | warn | `own` only |
| Unknown field (neither hub nor Claude Code) | info | `own` only |
| Name not in kebab-case | info | `own` only |
| Capability not in kebab-case | warn | all |
| Non-existent skill, dependency, or link; conflicting elements; cyclic dependencies | warn | all |
| Missing system commands, risk flags, external integrity issues, `settings.json` | various | all |

New validation rules never produce breaking errors: working files continue working. Third-party items are not penalized for fields and naming choices made by upstream authors.

## Workflows — `workflows/<name>.md` (Implemented)

Read strictly by the hub (`scan.mjs`, `route.mjs`), not by Claude Code:

| Field | Required | Meaning |
|---|---|---|
| `name`, `description` | **Yes** | Name and when to use it: text used by `route.mjs` for discovery |
| `capabilities` | No | Required capabilities; for each, `route.mjs` selects the skill (own, then approved external, then review-pending; never hash-mismatched) |
| `optional-capabilities` | No | Helpful but non-essential capabilities (e.g., `codebase-navigation`) |
| `sizes` | No | Applicable sizes: `small`, `medium`, `large` (a small task never triggers a workflow) |
| `categories` | No | Same as for skills |

The body details when to use it and when not to, phases with **exit artifacts**, permitted delegations, and failure recovery. `doctor` reports missing required capabilities (warning), missing optional capabilities (info), invalid size values, and misspelled fields.

## Handoff Between Agents (`structured-handoff` skill; format not enforced by code)

Every handover between agents or phases contains:

1. Task or workflow and overall goal;
2. Files and sources read;
3. Actions executed;
4. Produced artifacts (file paths, not full dumps);
5. Verification checks and outcomes;
6. Open issues and unverified assumptions (separated from facts);
7. Next proposed action.

Prefer artifact paths over dumping file contents or histories: saves tokens and minimizes errors.

## Planned (Not Yet Read by Code)

| Element | Purpose | Phase |
|---|---|---|
| Comparison between skills sharing a capability | Currently selected by origin and approval; empirical comparison lands with continuous evaluation | J |
| Quality gates in workflows | `acceptance-criteria` and `quality-gate` skills exist; mandatory phase-end gates land with workflow engine | E |

Exact schema for planned fields will be finalized during their respective phases, accompanied by tests without breaking existing files (see `decisions.md`).
