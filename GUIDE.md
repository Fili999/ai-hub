<!-- File generated from docs/guide.md with "npm run guide": do not edit by hand. -->
# AI Hub Guide

The AI Hub is your own archive of **skills**, **agents** and **workflows**, usable from the AI coding tools you prefer: **Claude Code, Codex, Antigravity CLI** and **local models** (through OpenCode). You choose your tools; the hub installs the same skills and agents into each of them, converting agents to the format each tool expects. If you use more than one computer, you can optionally sync the hub through your own GitHub repository.

This guide updates automatically: numbers, lists, and tables below are read directly from the hub. Do not edit `GUIDE.md` by hand: the source text is written in `docs/guide.md`.

## In Brief

Today the hub contains **11 skills** and **4 agents**: 15 are yours, 0 come from GitHub. There are 8 links between agents and skills. No issues reported.

- **Skill**: a folder with a `SKILL.md` file (the open Agent Skills standard). Tells your AI tool *how* to do a task (edit video, write a newsletter, review website security).
- **Agent**: a `.md` file with a specific role and a list of skills it can use (e.g. "Video editor").
- **Orchestrator**: the lead skill. You provide a goal, it breaks it down, searches the catalog for matching skills and agents, checks that tools are available, and asks for confirmation before high-risk actions.
- **Catalog** (`index/skillindex.json`): the automatically generated index of everything in the hub. This is what the orchestrator consults instead of opening hundreds of files.
- **Graphical interface**: the local web page that displays the graph, dependencies, and allows installing and assigning.

## Installing the Hub on a New Computer

Scripts run on **Node.js** (version 22 or later): if it is missing, the startup script offers to install it. Everything else is installed by reading `dependencies.json`. **Git** is only needed to install skills from GitHub and to sync between computers.

**Easiest:** download the ready-made bundle from the [Releases page](https://github.com/Fili999/ai-hub/releases/latest): `ai-hub-windows.zip` or `ai-hub-macos.zip`, unzip it and follow `START-HERE.txt`. Minimum requirements: Windows 10/11 (64-bit) or macOS 12+, Node.js 22+ (offered automatically), about 200 MB of free disk space and a modern browser. **Developers:** clone the repository as shown below.

### Windows

1. Download and unzip `ai-hub-windows.zip` (or install Git with `winget install --id Git.Git -e` and run `git clone https://github.com/Fili999/ai-hub.git`, then `cd ai-hub`).
2. Double-click `bootstrap.cmd` (or run `.\bootstrap.cmd` in PowerShell).
3. The script checks Node.js and your AI tools, reports what is missing, installs it only after your confirmation, and then asks which AI tools you use and installs the hub's skills and agents into them.
4. If the script installed anything, restart PowerShell and rerun `.\bootstrap.cmd`: this updates environment paths on Windows.
5. To use it like an app: `npm run shortcut` places an **ai-hub** shortcut on your desktop. Double-clicking it (or `start.cmd` in the folder) launches the hub. The terminal window minimizes to the taskbar; close it to stop the hub.

### Mac

1. Open Terminal. If you do not have Homebrew, install it from <https://brew.sh>.
2. Download and unzip `ai-hub-macos.zip` (or `git clone https://github.com/Fili999/ai-hub.git`), then `cd ai-hub`.
3. `./bootstrap.sh`: checks Node.js and your AI tools, installs missing dependencies (with Homebrew, after confirmation), asks which AI tools you use and installs the hub's skills and agents into them.
4. To use it like an app: `npm run shortcut` places the **ai-hub.command** file on your desktop. Double-click to launch (on first launch macOS may require right-click → *Open*). Close the Terminal window to shut down the hub.

### After Installation

- `npm start` opens the graphical interface in your browser.
- `npm run setup -- --check` tells you at any time whether the machine has all required tools without changing anything.
- `npm run setup -- --yes` automatically accepts all installation prompts: the fastest path on a new machine.

### What Gets Installed

Dependencies are declared in `dependencies.json`. The script constructs commands automatically (using only `winget`, `brew`, `npm`, or `uv`, with verified package names) and displays each command before running. `uv` is used to install NVIDIA SkillSpector, which analyzes the security of GitHub skills.

| Tool | Level | Purpose | Windows | Mac |
|---|---|---|---|---|
| Node.js | required | Runs every hub script and the web interface. | winget OpenJS.NodeJS.LTS | brew node |
| Git | required | Installs skills and agents from GitHub and, if you turn it on, syncs the hub between your computers. | winget Git.Git | brew git |
| Claude Code | optional | AI tool: reads the hub's skills and agents from ~/.claude. Install it only if you use it. | winget Anthropic.ClaudeCode | brew claude-code |
| Codex CLI (OpenAI) | optional | AI tool: reads skills from ~/.agents/skills and agents from ~/.codex/agents. Install it only if you use it. | npm @openai/codex | npm @openai/codex |
| Antigravity CLI | optional | AI tool: reads skills from ~/.gemini/config/skills and agents from ~/.gemini/config/agents. Install it only if you use it. | — | — |
| OpenCode (local models) | optional | AI tool for local models (Ollama, LM Studio…) and many providers: reads skills from ~/.agents/skills and agents from ~/.config/opencode/agents. | npm opencode-ai | npm opencode-ai |
| uv | recommended | Installs Python tools such as NVIDIA SkillSpector (downloads the Python version it needs by itself). | winget astral-sh.uv | brew uv |
| NVIDIA SkillSpector | recommended | Scans skills and agents downloaded from GitHub for security problems before they are installed (Settings → Security). Apache-2.0. | uv git+https://github.com/NVIDIA/skillspector.git@c7958a3268d9498644b22edb75d0f051bbc8cbfc | uv git+https://github.com/NVIDIA/skillspector.git@c7958a3268d9498644b22edb75d0f051bbc8cbfc |
| GitHub CLI | optional | Handy for private repositories (gh auth login) and for creating repositories from the terminal. | winget GitHub.cli | brew gh |

If a skill declares `requires-commands: ffmpeg` and `ffmpeg` is missing, `npm run setup` finds it and offers to install it (if listed in the `commandProviders` table of `dependencies.json`; otherwise it flags it).

### Missing Programs: Can Your AI Assistant Install Them?

You decide under **Settings → Programs required by skills and agents** (gear icon in the top right of the interface; saved in `settings.json`).

- **Disabled** (default): when a skill misses a program, your AI assistant informs you and asks before installing.
- **Enabled**: your AI assistant installs it automatically with `npm run needs -- <skill> --install` and proceeds.

In both cases, identical restrictions apply: only programs listed in `dependencies.json` can be installed, using hub-generated commands (never commands authored by a skill); unlisted programs must be installed manually. Your AI tool may still ask you to approve commands. `npm run needs` by itself inspects missing tools without installing; if permission is off, `--install` exits with code 3.

### Status of This Computer

_The status of this computer depends on the machine, so it is not stored in this file. You can see it in the **System** tab of the interface, or with `npm run setup -- --check`._

## How the Hub Is Structured

```text
ai-hub/
  skills/own/            your skills — now 11
  agents/own/            your agents — now 4
  registry.json          your choices: agent→skill links, categories
  manifest.lock.json     where each external item comes from and its version
  hub.config.json        categories and synonyms for search
  dependencies.json      programs to install on each computer
  index/skillindex.json  generated catalog (not versioned)
  scripts/               commands (Node, zero dependencies)
  ui/                    local web interface
  templates/             templates for new skills and agents
  docs/                  source templates of the guide
  tests/                 automated tests
  bootstrap.sh           startup on Mac/Linux
  bootstrap.cmd          startup on Windows
  GUIDE.md               this guide (generated)
  CLAUDE.md              rules for Claude Code when working on the repo
  README.md              quick overview
```

Rules to remember:

- **Your** skills and **your** agents live in `skills/own/` and `agents/own/`. Start from templates in `templates/`.
- Items from GitHub go into `external/`. Do not edit them by hand: managed by the installer, which records source repository and commit in `manifest.lock.json`.
- **Your custom choices** (which skill is linked to which agent, categories) live in `registry.json`, so GitHub updates will not overwrite them.
- `index/skillindex.json` is not committed to GitHub: each machine regenerates it when files change.

### How Skills and Agents Are Written

At the start of every `SKILL.md` or agent file is frontmatter between two `---` lines. `name` and `description` are required; other fields are optional.

| Field | Applies to | Purpose |
|---|---|---|
| `name` | skills, agents | name; letters, digits, `-`, `_`, `.` only |
| `description` | skills, agents | what it does and **when to use it**: used by orchestrator for discovery, so write it in English (adding a second language is fine: the search reads both) |
| `allowed-tools` / `tools` | skills / agents | tools used; factored into risk scoring |
| `skills` | agents | skills used by the agent; rendered as graph edges |
| `model-tier`, `effort-tier` | agents | portable choice (`high` / `balanced` / `fast`; `low` … `max`) that each AI tool turns into its own model and effort (see `providers.json`) |
| `model`, `effort` | agents, skills | native Claude Code values; they win over the tiers for Claude Code |
| `codex-model`, `codex-effort`, `antigravity-model`, `opencode-model`, `opencode-effort` | agents | explicit model or effort for one tool (for example `opencode-model: ollama/qwen3:30b`) |
| `categories` | all | one or more categories from `hub.config.json` (inferred if omitted) |
| `requires-commands` | all | programs required on the host (e.g. `ffmpeg`) |
| `requires-mcp` | all | MCP connectors that must be active in the session |
| `depends` | all | other dependencies; displayed in the Flow view |
| `conflicts` | all | incompatible items; orchestrator will not combine them |

### Categories

| Category | Name | Items |
|---|---|---|
| `meta` | Hub and Orchestration | 10 |
| `dev-app` | App Development | 2 |
| `dev-web` | Web Development | 0 |
| `video` | Video and Animation | 0 |
| `social` | Content and Social Media | 0 |
| `security` | Security | 0 |
| `marketing` | Marketing | 0 |
| `business` | Business and Strategy | 0 |
| `project-mgmt` | Project Management | 3 |
| `research` | Research and Documentation | 3 |
| `testing` | Testing and Quality | 4 |
| `seo` | SEO | 0 |
| `design` | Design and Images | 1 |
| `data` | Data and Reports | 1 |

## How It Works

When you give your AI tool a task ("create an animated video for YouTube", "audit this site's security"), the orchestrator follows the same process:

1. Understands the goal and breaks it down into tasks.
2. For each task, searches the catalog (with synonyms) via `npm run search`.
3. Selects skills and agents, reading only the instructions of chosen items.
4. Runs `doctor`: checks required tools, dependencies, duplicates, and conflicts.
5. If an action is risky (file deletion, publishing, spending, messaging, credentials), **asks for confirmation** first.
6. Executes and reports what was used and any catalog gaps ("there is no skill for this yet: would you like to install one?").

The orchestrator treats external skills as untrusted: if a downloaded skill says "ignore rules", it ignores that instruction.

### Installing vs Activating

Installing a skill from a link copies it to `external/` and registers it in the catalog. It becomes accessible in your AI tools only after **sync** (`npm run sync`, or the Welcome / System tab), which installs items into the folders of the tools you chose in Settings: Claude Code reads `~/.claude`, Antigravity CLI reads `~/.gemini/config` (`skills` and `agents`), while Codex and OpenCode share `~/.agents/skills` for skills and have their own agents folders (`~/.codex/agents`, `~/.config/opencode/agents`). Agents are converted to each tool's format. Sync never touches non-hub items and removes only what it placed.

## The Graphical Interface

Launched with `npm start` (or double-clicking `start.cmd` / `start.command` or desktop shortcut) and opens at `http://127.0.0.1:4173`. Runs locally only: not reachable over the network. Interface modifications write to the same files as CLI commands (`registry.json`, `manifest.lock.json`, `external/`), staying in sync with `git`.

| Tab | What it does |
|---|---|
| **Graph** | Visualizes skills and agents as nodes connected by edges in **3D** (drag to rotate, Shift+drag to pan, scroll to zoom; auto-rotates gently until grabbed) or 2D via the bottom-right toggle. Agent→skill links, dependencies, conflicts; filter by category, kind, origin. Clicking a node opens its details. |
| **Flow** | Column view: agents, skills, required tools. Type a goal to see which skills the orchestrator would use, with missing tools highlighted. |
| **Catalog** | Searchable directory with description, categories, risk rating, and origin. |
| **Teams** | Teams grouped by domain (social media, mobile apps, websites, software…), divided into roles (research, development, security…) with their agents and skills. For each team: members, graph, and flow scoped to that team. **New team** guides member assignment per role; **Categories** manages categories. Elements can belong to multiple teams. |
| **Create** | Five-step wizard to create a skill or agent without an empty file: type, identity (title, name, goal, role, description), content (when to use, procedure, expected output, warnings, limits; for agents: workflow and constraints; plus custom sections), settings (model, effort, tools, category, commands, MCP servers, dependencies, conflicts, connected agent/skills), and save destination. Live preview on the right with manual editing in final step. Fields have no length limits. |
| **Files** | Project folder and file tree with explanations for each component. Search by name, expand/collapse all, copy tree as text. Clicking a skill or agent opens its details. |
| **Install** | Paste a GitHub link, inspect contents and estimated risk (including large repositories with hundreds of skills: filter and check what you need), run **NVIDIA SkillSpector** analysis, choose scope (specific agent or global), and confirm. Update or remove installed items here. |
| **Guide** | This guide, always kept up to date. |
| **System** | Programs detected on this computer, status of each AI tool (installed, folders, last sync), `doctor` diagnostics. Run sync from here. |

The **Welcome** page (first launch, or *First-time setup* in Settings) asks for your language, your AI tools, the security level and whether you sync between computers, then installs the hub's skills and agents into your tools.

Top bar: **GitHub** button (sync status), catalog hash (`#a1b2c3d`: changes on modifications), **Settings** gear, and **light/dark** theme toggle.

**Settings** (`settings.json`) controls: which AI tools the hub installs into, whether your AI assistant can auto-install missing programs, whether sync between computers through GitHub is on, SkillSpector behavior (Block, Warn, Off; with or without AI analysis), and whether graph opens in 3D or 2D. New options declared in `scripts/lib/settings.mjs` appear automatically. Theme follows OS until overridden.

### Interface Security

The server listens only on `127.0.0.1`, verifies the `Host` header and origin of requests (preventing malicious websites from contacting your machine), and requires a session token (rotated on each startup) for every request. Link installation always previews items and requires explicit confirmation; GitHub push requires confirmation in the request body, and git operations use hardcoded commands only, never arbitrary shell input.

## Adding Items to the Hub

### Your Own Skill or Agent

The easiest way is through the **Create** tab in the interface. Fill in the fields, and the hub generates the file and suggests where to place it.

1. Choose skill or agent and provide a title: technical identifier (lowercase, numbers, dashes) is generated automatically.
2. Enter goal, description (what it does and when to use it), procedure, expected output, warnings, limits. For an agent: role and workflow, with no length limits.
3. Choose model, effort, tools, and category; for skills, specify required commands, MCP servers, dependencies, conflicts, and connected agent; for agents, connected skills.
4. In the final step, pick a destination folder: the hub suggests one based on category and text, or you can select an existing folder or create a new one (at most two levels under `skills/own/` or `agents/own/`). Then create.

The file is always created fresh: **never overwrites** existing files, and warns if the name already exists. Alternatively, you can create files manually:

1. Copy `templates/skill/SKILL.md` to `skills/own/<name>/SKILL.md` (or `templates/agent.md` to `agents/own/<name>.md`).
2. Write `name` and a `description` explaining what it does and when to use it.
3. Run `npm run inventory` and then `npm run doctor`: diagnostics will flag any issues.

In both cases, `npm run sync` (or linking from the catalog) makes it available in your AI tools; if you sync between computers, follow with commit and push.

### From a GitHub Link

Via the interface (**Install** tab) or terminal:

- Preview without writing: `npm run add -- <link> --dry-run`
- Install with specific assignment: `npm run add -- <link> --only name --to agent:my-agent` or `--to global`
- Full package (entire repo or subfolder with shared files): `npm run add -- <link> --package` (optionally `--path <subfolder>`)
- Update, list, remove: `npm run add -- --update`, `--list`, `--remove name --yes`
- Approve an item installed prior to approvals: `npm run add -- --approve name`

Accepted links: `https://github.com/user/repo`, links to subfolders or branches, `user/repo`, `git@github.com:user/repo.git`, or local folders.

**Scope assignment.** A skill can be *global* (visible to all agents and orchestrator) or *assigned* to specific agents (scoped to their context). Assignment can be changed anytime in item details or via `npm run link`.

**Before trusting.** An external skill contains instructions and potentially executable scripts. The preview estimates risk (`low`, `medium`, `high`) by checking for scripts, shell commands, network access, `curl | sh`, and destructive operations. This is an aid, not an audit: review what you install.

**Full package.** Many skills reference files located elsewhere in their repository. If the preview flags "accesses files outside its folder", check **Install full package**: the hub copies the repository (or subfolder, excluding `.git` and `node_modules`) into `skills/external/<owner>-<repo>/` and registers all its skills. A package updates and removes as a single unit.

**Approval and second computer.** Installing after reviewing preview and analysis records your approval: the hub stores it in the lock file bound to the exact file SHA-256. On another computer, after `git pull`, matching files activate automatically; modified files remain disabled and `doctor` flags them. Items installed before approvals are marked "needs review": the **Scan and approve** button in the Install tab analyzes them via SkillSpector and approves them.

**NVIDIA SkillSpector.** Before writing to disk (install or update), each item from GitHub is checked by [SkillSpector](https://github.com/NVIDIA/SkillSpector), which scans for prompt injections, data exfiltration, dangerous scripts, and over 70 known patterns, returning `SAFE`, `CAUTION`, or `DO_NOT_INSTALL`. Under **Block** mode (default), items recommended against, failed scans, or missing scanner prevent installation; **Warn** shows the verdict but lets you proceed; **Off** disables scanning. Verdict is recorded in `manifest.lock.json`. In the Install tab you can scan during preview (up to 20 items at a time); from terminal: `npm run add -- <link> --dry-run --scan --only name`. Static analysis takes a few seconds per item; AI analysis (configured in Settings) requires `SKILLSPECTOR_PROVIDER`.

## Updating AI Hub itself

- **The app you downloaded** (`AI Hub.app`, `AI-Hub-Setup.exe`) checks GitHub once a day for a new version and shows a banner at the top: press **Update now**. It downloads the update, verifies it against the checksum published with the release, and replaces only the files the app itself put there: **anything you changed stays as it is**, your skills, memory, settings and links are never touched. Then close and reopen AI Hub. In Settings → *Updates* you can choose *Tell me* (default), *Update automatically*, or *Never check* (no automatic request to GitHub at all).
- A **git clone** keeps using the GitHub button below. A copy from the classic `.zip` bundle only gets the banner with a link to the release page.
- The first version that can update itself is 0.1.3: older downloads need one manual download of the new app.

## Keeping Computers in Sync

**This part is optional** and off by default: turn it on in Settings → *Multi-computer sync* (or in the first-time setup) if you keep your hub in your own GitHub repository and use it on more than one computer. Then Mac and Windows share the same repository and only git diffs are transferred.

### From the Interface

The **GitHub** button in the top bar checks status automatically (on page load, every 5 minutes, and on focus) and updates:

| Button | Meaning | Action |
|---|---|---|
| **Up to date** (green) | Local copy and GitHub match. | None. |
| **↓ 3 updates** (amber) | 3 changes arrived on GitHub from another machine. | Click, then *Download updates*. Pulls only if fast-forward: never overwrites uncommitted work or creates merge commits. |
| **↑ to send** (blue) | You have modified files or local commits GitHub lacks. | Click, review list, enter optional message, and click *Save and send to GitHub*. |
| **Conflict** (red) | Both copies diverged with conflicting edits. | Resolve manually (ask Claude Code or run `git pull --rebase` in terminal). The interface never forces merges. |
| **Not checked** (gray) | GitHub unreachable (offline) or authentication failed. | Dialog message explains which. |

After pulling, the dialog offers to install the updates into your AI tools (equivalent to `npm run sync`) and warns if dependencies changed (run `npm run setup`).

Push triggers **only** when clicking the button, displaying exactly what will be committed. It refuses to push if remote updates are pending, never forces (`--force`), and rejects files that resemble keys or secrets (`.env`, `*.pem`, `id_rsa`, `credentials.json`…): remove them or add to `.gitignore`.

### From Terminal

- `npm run update`: checks status and reports summary.
- `npm run update -- --pull`: pulls changes (fast-forward only).
- `npm run update -- --push`: previews changes, asks confirmation, commits and pushes. `--message "text"` sets message; `--yes` skips prompt.

### Good to Know

1. **First login.** If your hub repository is private, Git needs access to your GitHub account (Windows/Mac typically open browser for authentication; alternatively `gh auth login`). The button indicates if credentials are missing. Background checks never spawn login popups.
2. **Name and email.** Git needs your identity to record commits: `git config --global user.name "Your Name"` and `git config --global user.email "your@email.com"` (once per computer).
3. **Skills installed in Claude desktop app** live on your account, not on disk: Git cannot sync them. Copy them into `skills/own/` or install from GitHub to include them in the hub.
4. On **Windows**, skill directories are linked via *junctions* (no elevated permissions needed). Agent files require symlinks (Windows Developer Mode enabled): if disabled, files are *copied* and must be resynced after edits.
5. If you prefer terminal: standard `git add -A`, `git commit`, `git push`, and `git pull` work identically. With git hooks enabled (prompted by `npm run setup`), your AI tools refresh automatically after every `git pull`.

## Commands

All commands are run from the hub directory. This table is read directly from script definitions.

| Command | What it does |
|---|---|
| `npm run start` | Local web interface for the hub. Zero dependencies: Node built-in modules only. |
| `npm run ui` | Local web interface for the hub. Zero dependencies: Node built-in modules only. |
| `npm run setup` | Guided setup of this computer: language, AI tools, security, programs (dependencies.json), git hooks, sync to your AI tools. |
| `npm run needs` | Programs required by skills and agents: shows what is missing and installs if Settings allow Claude. |
| `npm run guide` | Regenerate GUIDE.md with current hub state. |
| `npm run inventory` | Automated inventory: scans skills/ and agents/ and generates index/skillindex.json. |
| `npm run search` | Searchable catalog: find skills and agents by capability. |
| `npm run route` | Task routing: mode of operation, workflow, capabilities and skills to use (used by orchestrator). |
| `npm run usage` | Usage, estimated token consumption, and recommendations for each skill and agent (updates counts for this computer). |
| `npm run memory` | Hub memory: search, save and update notes (decisions, lessons, metrics) in memory/, openable with Obsidian. |
| `npm run evaluate` | Continuous evaluation: records metrics for a task (self-critique scores, gate, retries) and shows report. |
| `npm run team` | Agent and skill teams by domain (teams.json): listing, role breakdown, members, suggestions for a new team. |
| `npm run doctor` | Pre-flight check: tools, dependencies, duplicates, conflicts, integrity of installed files. |
| `npm run add` | Installs, updates, and removes skills and agents from GitHub. Tracked in manifest.lock.json. |
| `npm run link` | Agent → skill links and categories. Saved to registry.json (versioned). |
| `npm run sync` | Installs the hub's skills and agents into your AI tools (Claude Code, Codex, Antigravity CLI, OpenCode), on Mac, Windows and Linux. |
| `npm run update` | Syncs the hub with GitHub: checks for updates, pulls them (without reinstalling), and pushes your changes. |
| `npm run shortcut` | Creates a desktop shortcut that opens the hub interface on double click (Windows and Mac). |
| `npm run setup-hooks` | Enable git hooks: after every "git pull" the link to Claude refreshes automatically. |
| `npm run package:mac` | Builds the downloadable apps. Output goes to dist/. Needs Node >= 22 and internet (it downloads Node once, checks its |
| `npm run package:win` | Builds the downloadable apps. Output goes to dist/. Needs Node >= 22 and internet (it downloads Node once, checks its |
| `npm run test` | Run automated tests (before every commit). |

Before each commit: `npm test`.

## Current Hub Status

### Your Skills and Agents

- **Skill `acceptance-criteria`** — Define measurable, testable success criteria before starting work, so completion is clear and verifiable.
- **Skill `decision-record`** — Log a significant decision with context, options, choice, and consequences so it is not reopened without reason.
- **Skill `hub-manager`** — Manages the hub of skills and agents: install, update, remove, link to agents, categorize, rebuild inventory, and sync AI systems.
- **Skill `memory`** — Recall and save decisions, lessons, and metrics across sessions.
- **Skill `orchestrator`** — Lead skill to use FIRST before tackling any multi-step goal in any domain (app/web development, video, social content, security, marketing,…
- **Skill `quality-gate`** — Check a deliverable against its acceptance criteria with real evidence before closing or proceeding, resulting in pass, fail, or blocked wi…
- **Skill `report-pdf`** — Generate a comprehensive, detailed, and elegant PDF report reconstructing the entire project journey from concept through development, arch…
- **Skill `self-critique`** — Honest retrospective with a per-dimension score on the result, skills, agents, and workflow used.
- **Skill `source-verification`** — Check claims against reliable, dated sources, separating verified facts, assumptions, and opinions, and reporting the date and limits of ea…
- **Skill `structured-handoff`** — Compact, reference-based summary to pass work to another agent or phase without dumping context.
- **Skill `task-intake`** — Clarify goal, scope, size and risk of a new request and choose the lightest way to do it.
- **Agent `implementer`** — Makes a focused change to code, documents or configuration following an agreed plan, with tests and a short report.
- **Agent `planner`** — Turns a vague or large request into a short plan with acceptance criteria, before any work starts.
- **Agent `researcher`** — Finds and checks information from reliable, dated sources and separates verified facts from assumptions.
- **Agent `reviewer`** — Checks a result against its acceptance criteria with real evidence and gives a clear pass, fail or blocked, then an honest per-point critiq…

### Installed from GitHub

_None yet. Paste a GitHub link in the **Install** tab or use `npm run add -- <link>`._

### Agent → Skill Links

- `agent:implementer` → `skill:structured-handoff` (selected in registry.json)
- `agent:planner` → `skill:acceptance-criteria` (selected in registry.json)
- `agent:planner` → `skill:decision-record` (selected in registry.json)
- `agent:planner` → `skill:task-intake` (selected in registry.json)
- `agent:researcher` → `skill:memory` (selected in registry.json)
- `agent:researcher` → `skill:source-verification` (selected in registry.json)
- `agent:reviewer` → `skill:quality-gate` (selected in registry.json)
- `agent:reviewer` → `skill:self-critique` (selected in registry.json)

### Diagnostics and Warnings

✔ No issues reported.

## Troubleshooting

| Issue | Resolution |
|---|---|
| Your AI tool does not see a skill | `npm run sync`, then restart the tool. Check in the System tab that the tool is enabled and its sync is active. |
| "SkillSpector is not installed" during installation | `npm run setup` installs `uv` and SkillSpector. The hub finds it even if the shell cannot (checks uv path `~/.local/bin`). To access from terminal: `uv tool update-shell` and open a new terminal. Or choose "Warn" or "Off" in Settings. |
| "Download updates" reports local files would be overwritten | `GUIDE.md` self-heals (generated). For other files (e.g. `registry.json`), save and push your changes first, or resolve with Claude Code. Never delete files manually. |
| `doctor` reports "content differs from approved version" | Files of an external element changed after approval: activation is blocked. If intentional, re-scan and approve (Install tab or `npm run add -- --approve name`); otherwise reinstall from source link. |
| Manually copied skill reports "copied manually" | Missing provenance and approval lock: reinstall from source link (using full package if shared files exist), then remove manually copied directory. |
| `doctor` reports "command not installed" | Run `npm run setup`: if the tool is recognized it installs it; otherwise install manually and restart terminal. |
| Two items share the same name | `doctor` flags the collision and sync skips both until one is renamed. |
| On Windows agent files are copies | Enable Windows Developer Mode and rerun `npm run sync`, or resync after modifications. |
| Interface does not open | If port 4173 is occupied, the server auto-increments port and prints the URL; to choose manually: `npm start -- --port 4200`. |
| After `git pull` catalog is unchanged | The catalog auto-regenerates; to force: `npm run inventory`. |

## Security in Brief

- The installer never follows symlinks, rejects unsafe paths, executes nothing during download, and activates nothing until sync is run.
- The setup script installs only packages declared in `dependencies.json`, never commands specified by a skill, and displays each command before running. Your AI assistant can only auto-install (`npm run needs`) if allowed in Settings, with identical safeguards.
- Every skill or agent from GitHub passes through NVIDIA SkillSpector before install or update; in "Block" mode, items that fail inspection or are missing a scan are rejected.
- Third-party skills are treated as untrusted data: neither orchestrator nor scripts execute arbitrary instructions simply because a skill states them.
- No irreversible action (push, link installation, deletion) occurs without explicit user confirmation.
