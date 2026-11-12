# AI Hub Architecture

AI Hub is the personal infrastructure that lets you use AI coding systems (such as Claude Code, Codex, Antigravity, OpenCode) as an organization of specialized agents, reusable skills, and coordinated workflows, synchronized across Windows, macOS, and Linux via this GitHub repository.

Each section specifies what is **implemented** (verified by automated tests) and what is **planned** (see `roadmap.md`). A planned component does not exist until it has code and tests.

## Core Concepts (Keep Distinct)

| Concept | What It Is | Location | Status |
|---|---|---|---|
| Agent | A role: responsibilities, constraints, tools, expected output | `agents/own/*.md`, `agents/external/*.md` | Implemented (format); no core agents created yet |
| Skill | A reusable procedure, loaded only when needed | `skills/*/<name>/SKILL.md` | Implemented |
| Workflow | Phases, dependencies, checkpoints, and quality gates of a process | `workflows/<name>.md` | Implemented (first: `code-change`); selected by `route.mjs` |
| Tool, script, hook | Deterministic actions and checks | `scripts/`, `.githooks/` | Implemented |
| Registry | Authoritative source of metadata and relationships | `registry.json`, `manifest.lock.json` | Implemented |
| Memory | Persistent, retrievable knowledge | — | Planned (Phase H) |
| Quality gate | Mandatory check before proceeding | `quality-gate` skill (with `acceptance-criteria`) | Procedure implemented; automated use in workflows: Phase E |

Rules: an agent may have zero, one, or multiple skills; a skill is shared across agents without copying; never create an agent for a single task. The orchestrator activates only the minimal sub-team required: simple tasks are handled directly without agents.

## Universal and Customizable

AI Hub is not tied to a single domain (apps, social, websites): today those are needed, tomorrow others. Therefore:

- **The core is domain-agnostic.** Inventory, search, routing, security, approvals, sync, and UI work identically across any domain. No code contains domain-specific logic.
- **A new domain is added through data, not code**: categories and synonyms in `hub.config.json`, skills and agents from templates (Create tab or `templates/`), and in the future workflows and capabilities. Cross-cutting skills (research, verification, quality gates, handoff, memory) are reused across every domain.
- **Adding a skill or agent must remain simple**: Create tab or a file from template, then `npm run inventory` and `npm run doctor`.
- **Every significant behavior is a setting** declared in `SCHEMA` (`scripts/lib/settings.mjs`), with a safe default: the Settings tab renders it automatically. This extends access permissions, dependencies, security, and appearance. A setting can never bypass mandatory safeguards (such as confirmation for irreversible actions).

## Authoritative Sources and Generated Files

| File | Role | Written By | Tracked in Git |
|---|---|---|---|
| `skills/**/SKILL.md`, `agents/**/*.md` | Skill and agent definitions | User (`own`), installer (`external`) | Yes |
| `registry.json` | Agent→skill links, user-selected categories and overrides | `scripts/link.mjs`, UI, installer | Yes |
| `manifest.lock.json` | Provenance of external items (version 2): repo, commit, path, package, SHA-256 hash, approval, SkillSpector recommendation | `scripts/install.mjs` | Yes |
| `hub.config.json` | Categories and search synonyms | User | Yes |
| `dependencies.json` | System packages and how to install them (`{manager, package}`) | User | Yes |
| `settings.json` | Settings (AI installations, SkillSpector, graph view) | Settings tab | Yes |
| `brand/brand-kit.json` | Brand identity for video: colors, fonts, logo, captions, motion graphics, audio, music | `brand-kit` skill, `video.mjs brand` | Yes |
| `local.json` | Machine-specific settings (audio library folder) | `video.mjs library set` | **No** |
| `teams.json` | Domain teams: roles with agents and skills | Teams tab, `scripts/team.mjs` | Yes |
| `memory/` | Memory: decisions, lessons, metrics (Markdown, Obsidian vault format; `.obsidian/` excluded) | `scripts/memory.mjs`, `memory` skill, or manual | Yes |
| `evaluations/<machine>.jsonl` | One line per task: self-critique scores, gate outcome, attempts, routing | `scripts/evaluate.mjs` (`self-critique` skill) | Yes |
| `usage/<machine>.json` | Daily skill and agent usages (names and counts only), one per machine | `scripts/usage.mjs` and `/api/usage`, from AI session history | Yes |
| `index/skillindex.json` | Derived index (catalog, graph edges, diagnostics) | `scripts/inventory.mjs` (auto-regenerated) | **No** |
| `GUIDE.md` | Guide generated from `docs/guide.md` | `scripts/guide.mjs` | Yes, but generated |

No duplicate registries exist. Future extensions (approvals, capabilities) belong in the existing files with backwards-compatible schemas, not in parallel registries (see `decisions.md`).

## Data Flow

1. **Discovery**: `scan.mjs` reads skill and agent frontmatter, applies `registry.json` and `manifest.lock.json`, and produces the index.
2. **Search and Routing**: `search.mjs` searches the index (synonyms); `route.mjs` suggests execution mode (direct, workflow, general method), workflow, and skills per capability, plus token saving level if enabled. Used by orchestrator.
3. **Verification**: `doctor.mjs` checks missing commands, dependencies, duplicates, conflicts, external integrity, and `settings.json`.
4. **Activation**: `sync.mjs` links each skill and agent to target AI directories (symlink on macOS/Linux, junction on Windows, copy as fallback).
5. **Cross-Machine Sync**: Git via GitHub (`repo.mjs`: fast-forward only, never `--force`, secret scan before push). Following a `git pull`, the `post-merge` hook runs sync.

## Hub Fields and Native AI Assistant Fields

`sync.mjs` links files directly to AI assistant directories: it does not alter them. Assistants read their own native fields (for skills: `name`, `description`, `allowed-tools`; for agents: `name`, `description`, `tools`, `model`); hub metadata (`categories`, `requires-commands`, `requires-mcp`, `depends`, `conflicts`, `skills` in agents, and capabilities) is read only by hub scripts. Always verify native fields against official assistant documentation.

## Extension Guidelines

1. Incremental changes, not rewrites; runtime dependencies only if native Node APIs are insufficient.
2. New fields start optional, then potentially become required via migration, parser, template, guide, and test updates.
3. Schemas in `manifest.lock.json` and `registry.json` change only with verified justification and compatible migrations.
4. Generated files must be deterministically reproducible and never treated as parallel source of truth.
5. No workflow engines or MCP servers "for the sake of it": only when addressing concrete requirements.
6. Most format validations must run deterministically without LLM calls.

## Windows / macOS / Linux Compatibility

- Pure Node 22+ and standard library: no OS-specific shell commands.
- Line endings normalized by `.gitattributes` (LF, CRLF only for `.cmd`).
- External content: exact-byte SHA-256 (`approval.mjs`), clone with `core.autocrlf=false`, and `skills/external/**`, `agents/external/**` marked `-text` in `.gitattributes`: approved hash matches identically across platforms (tested in `tests/approval.test.mjs`).
- Tests run on every push across Linux, Windows, and macOS (`.github/workflows/test.yml`).

## Related Documents

- `contracts.md` — skill and agent fields, handoff formats, future contracts.
- `external-skills.md` — importing, SkillSpector, approvals.
- `principles.md` — working principles, token efficiency, model selection.
- `design.md` — when and how to design agents, skills, and workflows.
- `naming.md` — naming conventions.
- `security.md` — security policy and implemented controls.
- `roadmap.md` — phases and status.
- `decisions.md` — recorded decisions and architectural tradeoffs.
- `guide.md` — user guide template (`GUIDE.md`).
