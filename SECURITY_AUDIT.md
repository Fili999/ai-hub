# Security audit and remediation

Status record of the security audit of AI Hub (audited version `0.1.1`, fixes released in `0.1.2`). Companion of [docs/security.md](docs/security.md) (design and rules) and [SECURITY.md](SECURITY.md) (how to report a problem).

Rule used throughout: **a finding is marked "Fixed" only when there is a regression test that fails on the old code and passes on the new code.** Whatever could not be verified is listed under [Not verified](#not-verified).

## Summary

| ID | Issue | Severity | Files | Status |
|---|---|---|---|---|
| SEC-001 | An incomplete SkillSpector scan (`complete: false`) with recommendation `SAFE` passed in every mode; a missing or invalid `score` was read as `0` | **High** | `scripts/lib/spector.mjs` | **Fixed**, tested |
| SEC-002 | `memory/` writes followed symlinks in intermediate folders (`memory/lessons -> /elsewhere`), also through `..`, absolute paths, hard links and a folder swapped between check and write | **High** | `scripts/lib/memory.mjs`, new `scripts/lib/safefs.mjs` | **Fixed**, tested (see TOCTOU limit) |
| SEC-003 | The scanned files, the hashed files and the installed files were three separate reads of a mutable folder; replacement was `rm` + copy; concurrent runs could lose lock updates; package shared files were installed without being scanned | **Medium-High** | `scripts/install.mjs`, new `scripts/lib/integrity.mjs`, new `scripts/lib/hublock.mjs` | **Fixed**, tested |
| SEC-004 | Filesystem containment relied on text checks: `--remove` and install followed a symlinked `skills/external`; a tampered `ai-hub.json` could make `sync` delete any path; `create` checked links only below `skills/own`; JSON writes followed a planted symlink; names differing only by case | **Medium-High** | `scripts/install.mjs`, `scripts/sync.mjs`, `scripts/lib/create.mjs`, `scripts/lib/approval.mjs`, `scripts/lib/util.mjs` | **Fixed**, tested |
| SEC-005 | Third-party skills are untrusted instructions; heuristics had blind spots (large/deep files skipped silently; no check for `.env`, exfiltration, security-config edits, prompt-injection phrases, invisible characters, obfuscated execution); no provenance shown | **Medium** (inherent) | `scripts/lib/scan.mjs`, `scripts/install.mjs`, docs | **Mitigated**, tested. Cannot be "fixed": see [Residual risks](#residual-risks) |
| SEC-006 | Local server: token accepted from the URL on every route, cross-site reads not refused, look-alike JSON content types accepted, malformed URL gave a 500, unlimited event streams, no request timeout, crash on odd tokens | **Low-Medium** | `ui/server.mjs` | **Fixed**, tested. Existing protections kept |
| SEC-007 | Command execution: reviewed (no shell, validated arguments). Gaps: `git clone` had no timeout and allowed any transport; relative `PATH` entries were trusted | **Low** | `scripts/lib/source.mjs`, `scripts/lib/util.mjs`, `scripts/lib/repo.mjs` | **Fixed**, tested |
| SEC-008 | Supply chain: SkillSpector installed from an unpinned git URL; GitHub Actions on movable tags | **Medium** | `dependencies.json`, `scripts/lib/deps.mjs`, `.github/workflows/*` | **Fixed**, tested. Open items listed below |

No critical vulnerability outside the list above was found, so no work was stopped to ask for a decision.

## Evidence that the fixes are effective

Each new test file was also run against the **original** code (restoring the old file with `git stash`). The tests that describe an attack fail there and pass now:

| Test file | Fails on old code | Passes now |
|---|---|---|
| `tests/security-spector.test.mjs` | 7 of 12 | 12 of 12 |
| `tests/security-memory.test.mjs` | 8 of 13 | 13 of 13 |
| `tests/security-install.test.mjs` | 8 of 13 | 13 of 13 |
| `tests/security-fs.test.mjs` | 4 of 9 | 9 of 9 |
| `tests/security-server.test.mjs` | 5 of 13 | 13 of 13 |
| `tests/security-commands.test.mjs` | 5 of 12 | 12 of 12 |

The remaining tests of each file guard behaviour that was already correct (for example, symlinks inside a downloaded repository were already skipped) so that it cannot regress. One of them (names differing only by case) passes on the old code on macOS only because that filesystem is case-insensitive; it protects Linux.

`tests/security-skills.test.mjs` covers SEC-005 (new heuristics; installing a hostile skill executes nothing and changes nothing outside the installer's files). These tests were not run against the old code.

The whole suite (`npm test`) passes.

## SEC-001: incomplete scans

**Problem.** `scanTarget()` computed `complete`, but `verdict()` never read it. A result `SAFE` + `complete: false` was `pass` even in `block` mode. `score: Number(ra.score) || 0` turned a missing or invalid score into `0`.

**Fix** (`spector.mjs`):

- `verdict()`: only a result with `complete === true` can be `pass`. Incomplete → `block` in block mode, `warn` in warn mode (the line says `INCOMPLETE analysis (not verified)`). `off` is unchanged.
- `complete` is strict: `analysis_completeness.is_complete === true` and no `execution_successful: false`. Missing, `null` or non-boolean values mean "not verified". (SkillSpector 2.12.0 emitted both fields on the harmless sample that was checked; if a future version stops doing so, `block` mode will refuse its results rather than trust them.)
- A missing, non-numeric, non-finite or out-of-range (`0..100`) score, an unknown recommendation, a non-object document, a process killed by a signal, and a `SAFE` document returned with exit code `1` (which means "risk > 50") are all "unreliable" (`ok: false`): `block` in block mode.
- Wording: the `SAFE` label now reads "no findings (not a guarantee of safety)".

**Behaviour change to know about:** a scanner that does not report completeness is now blocked in `block` mode. The scripted scanners in two existing tests were updated to report it like the real one does.

## SEC-002: symlinks in `memory/`

**Problem.** `notePath()` checked the final file with `lstat` only. A committed symlink `memory/lessons -> /some/dir` (git stores symlinks) made `memory/lessons/x.md` look internal and write outside the hub.

**Fix** (`safefs.mjs`, `memory.mjs`):

- Paths are walked from the **canonical** root (`realpath`) one component at a time with `lstat`; any symlink or junction (Node reports junctions as symbolic links) is refused, including `memory/` itself. Folders are created one at a time and re-checked.
- New files are created with `O_CREAT|O_EXCL|O_NOFOLLOW`; appends open the existing file with `O_NOFOLLOW`, verify, and only then read and write. Hard-linked files (`nlink > 1`) are refused for appends.
- `..`, absolute paths, drive letters, UNC paths, NUL, empty paths and non-`.md` files are rejected; both `/` and `\` separators are understood.
- **TOCTOU.** After opening, the descriptor is compared with the path (`realpath` unchanged, same device and inode). If a folder is swapped for a link between the check and the open, the write is refused. For a *new* file, the file that was already created is removed again through its own descriptor. Tests simulate the swap deterministically (`hooks.beforeOpen`).
- `readNotes()` ignores a `memory/` that is a link.
- Any new write into memory must use `createFileExclusive` / `appendFileSafe` / `safeDir`.

## SEC-003: integrity and races

**Problem.** The scanner read the clone, `packageHash` was computed later on the installed copy, and approval was recorded for whatever was on disk then. `rm` + copy replaced versions non-atomically. Two runs (terminal + web UI) could overwrite each other's `manifest.lock.json`. For a full package, shared files outside the skill folders were installed and approved but never scanned.

**Fix** (`integrity.mjs`, `hublock.mjs`, `install.mjs`):

1. **Snapshot.** Each candidate (skill folder, whole package, agent file) is copied to a private staging area and its SHA-256 `h0` is computed. Only the snapshot is scanned and installed.
2. **Re-hash after the scan.** If the snapshot changed, the operation stops: nothing installed, nothing approved.
3. **Transaction.** The snapshot is copied next to the destination (`<hub>/.tmp/staging-*`, same volume), verified against `h0`; the old version is moved aside; the new one is renamed into place and verified against `h0` again. Any failure restores the old version. The lock file is written last.
4. **Approval** is recorded for `h0`, which equals the hash of the installed copy. The same applies to `--update` (lock saved per unit) and to `--approve` (hash before the scan, scan of a snapshot, hash after; if the installed folder changed, no approval).
5. **Lock.** `install`, `--update`, `--approve`, `--remove` take a cross-process lock (`.tmp/locks/hub.lock`, mkdir-based, with owner pid). A second run is refused with a clear message; a lock left by a crashed run (dead pid) or older than 4 hours is taken over. Reads (`--list`, `--dry-run`, `--help`) do not need it.
6. Full packages are scanned **as a whole** as well as per skill.
7. Names that differ only by case are treated as the same installation.
8. A changed skill is never activated: `sync` already skipped `hash-mismatch` entries; a test now proves it (`security-skills`).

Immutability is enforced by verification, not by file permissions (permissions cannot stop a process of the same user and break cleanup on Windows).

## SEC-004: filesystem containment

Audited every function that creates, changes, deletes or copies files, or reads user-supplied paths.

| Area | Result |
|---|---|
| `install.mjs` remove / replace | Lock paths come from GitHub (untrusted). Now checked with `assertContained` (text containment **and** no link on the way). Before, `--remove` followed a symlinked `skills/external` and deleted the folder behind it |
| `sync.mjs` pruning | `ai-hub.json` is data; entries outside the tool's own skills/agents folders are never deleted or replaced |
| `create.mjs` | The new file is created through `createFileExclusive` (every folder from the hub root is checked; before, `skills/` or `skills/own` being a link was accepted) |
| JSON files (`lock`, `registry`, `settings`, `teams`, `config`, usage) | `writeJson` is atomic (temp file + rename): a half-written file is impossible and a planted symlink is replaced instead of written through |
| `approval.verifyEntry` | A lock path outside the hub is "missing": never hashed, approved or activated |
| Downloaded repositories | Symlinks are skipped in discovery, hashing and copying (already so; now covered by tests) |
| `--path`, `--ref`, source strings | `..`, option-looking values and exotic transports rejected (already so; tests added) |

Windows: junctions use the same code path (Node reports them as symbolic links) and the tests create junctions on Windows. **Not run on Windows in this session**; the CI matrix includes `windows-latest`.

## SEC-005: skills as untrusted content

A skill is text that an AI tool will follow. No scanner can prove it harmless. What changed:

- **Heuristics** (`analyzeRisk`) now flag: reads of `.env` and secret files, environment secrets, exfiltration (uploads, netcat, paste/webhook services), edits of permissions/hooks/instruction files/the scanner policy, prompt-injection phrasing ("ignore previous instructions", "do not tell the user", "without asking"), invisible Unicode (zero-width, bidi, tag characters), obfuscated execution (`base64 -d | sh`, `eval(atob())`), destructive git/disk commands. Any of them makes an external skill **high** risk.
- **Nothing is skipped silently.** Files that are too large, too many files, and binaries are reported (`unscanned-content`, `has-binaries`) and raise an external skill to at least medium.
- **Provenance** is printed at install: repository and path, exact commit, approved SHA-256. It is also stored in `manifest.lock.json` (source, commit, hash, approval time, scan result including `complete`).
- **Warnings come before approval**: the scan result and the first findings are printed before anything is written, together with the line "SkillSpector is a scanner, not a sandbox".
- **Nothing is executed** when installing or syncing: no npm lifecycle scripts, git hooks, filters or skill scripts (tested with a hostile fixture).
- A skill changed after approval is not activated (`hash-mismatch`), whatever its popularity or earlier scan.

**Capability / permission system for agents: evaluated, not implemented.** The hub already has the pieces (`tools` in agent files, `capabilities` in frontmatter, the `all-tools` and `uses-shell` flags). A backwards-compatible next step would be an opt-in setting `security.agentTools` (`off` / `warn` / `block`) making `doctor` and `sync` warn about, or refuse to link, an *external* agent that declares no `tools` (or allows Bash) unless the user lists it. It was not added because it changes what existing installs activate and needs a decision from the maintainer. Frontmatter alone never enforces permissions: the AI tool's own permission system and hooks do.

## SEC-006: local server

Reviewed all routes. Kept as they were: `127.0.0.1` only, `Host` check, token on every API route, `Origin` + `Content-Type: application/json` on every POST, CSP, body limit, serialized writes (`exclusive()`).

Added: the token in the URL is accepted **only** by the event stream; `Origin` / `Sec-Fetch-Site` are checked on **reads** too; exactly `application/json` (with or without `charset`); malformed percent-encoding → 400 (was 500); odd tokens → 401 (was a crash); at most 16 event streams; 60 s request timeout.

The test enumerates the routes from the source, so a **new route is automatically covered** by the "no token → 401", "no/foreign Origin → 403" and "wrong Content-Type → 415" checks.

The UI builds its DOM without `innerHTML`; Markdown links are filtered. Untrusted names and descriptions are rendered as text.

## SEC-007: command execution

Reviewed every `spawn` / `spawnSync` (no `exec*` exists; a test enforces it). All use argument arrays and no shell, except the validated Windows `.cmd` shim in `machine.mjs` (names and arguments restricted to a safe character set; a test asserts the shell option exists nowhere else). PowerShell and `osascript` receive text through environment variables or separate arguments, never interpolated.

Fixed: `git clone` has a 10-minute timeout and an output cap; only the `https` transport (and `file`, for a local folder given on purpose) is enabled; submodules are not fetched; `git` is resolved to an absolute path; relative `PATH` entries are ignored (a program planted in the current folder is not run); the commit checkout ends with `--`.

## SEC-008: dependencies and supply chain

- No npm dependencies (a test asserts it, and that no install-time lifecycle script exists).
- SkillSpector is pinned to the commit of tag `v2.12.0`; `deps.mjs` accepts `git+https://github.com/<owner>/<repo>.git@<40 hex>` and the repository's own file must be pinned (tested).
- GitHub Actions are pinned to commit SHAs (with a `# v4` comment); tokens are read-only by default; no `pull_request_target`; bootstrap scripts do not pipe downloads into a shell (tested).
- Node packaging verifies the SHA-256 of the downloaded Node archive.

Node.js minimum raised to **22** (Node 18 and 20 are end-of-life): `engines`, `dependencies.json`, bootstrap scripts, CI matrix (Linux 22 and 24, Windows and macOS 22), docs.

Open items (maintainer decisions, not changed):

- The Git minimum is 2.25. Older Git versions have known clone-related vulnerabilities (mostly submodules and local clones, which the hub does not use). Recommended minimum: a current release.
- `release.yml` installs NSIS with `choco install nsis` without a version pin.
- The packaging step trusts `SHASUMS256.txt` from the same server as the archive (integrity, not authenticity of a signature).
- `uv` resolves SkillSpector's Python dependencies at install time; there is no lock file of ours.

## Residual risks

- **SkillSpector is not a sandbox.** It finds known patterns. A skill with no findings can still contain instructions that harm you, and the AI tool will follow them. In LLM mode, the content is sent to the configured model provider.
- **Heuristics are regular expressions.** They raise the cost of obvious attacks and make hostile text visible; they do not stop a determined author.
- **TOCTOU on POSIX cannot be eliminated in plain Node** (no `openat`). The check after opening closes the window that matters (a folder swapped for a link) and undoes it, but a local attacker who can race the process can, for a moment, cause a file to exist outside before it is removed. This needs write access to the hub folder, which already is full control of the hub.
- **Link mode.** `sync` links skills by default: a change made after `sync` is live in the AI tool until the next `sync` / `doctor`. Use `--mode copy` for pinned copies.
- **Legacy entries.** Items installed before approvals existed (`review-pending`) and external folders without a lock entry are still active (with a warning) to stay compatible. Run `npm run add -- --approve <name>` to bring them under hash protection.
- **Anyone who controls the page can change settings.** `POST /api/settings` can set the SkillSpector mode to `off`. That is by design (it is the user's own UI); the CSP and the token protect it.
- The hub's own `.githooks/post-merge` runs `sync` after a pull if you enable hooks with `npm run setup-hooks`. Pulls done by the hub disable hooks; your own `git pull` does not.

## Recommended configuration

- Settings → Security: **Block** (the default). Keep SkillSpector installed (`npm run setup`).
- Prefer installing from a **pinned commit** (`--ref <sha>`), read the preview and the findings, and install only what you need.
- After installing, run `npm run doctor`. Use `--approve` for legacy items.
- Use `sync --mode copy` if you want AI tools to see only approved bytes.
- Keep agents' `tools` narrow and rely on your AI tool's permission prompts; do not use permission-bypass modes with third-party skills.
- Keep the repository private if `memory/` contains project notes.

## Not verified

- Windows behaviour (junctions, reparse points, `O_NOFOLLOW` absent, rename retry) was written to be portable and the tests create junctions on Windows, but they were **only run on macOS** here. CI covers Windows and Linux.
- SkillSpector was run only on a harmless sample to read its output format; the block / warn logic was tested with scripted scanners, not with real malicious samples.
- The web interface was tested through its HTTP API; no browser session was exercised.
- The packaging and release workflows were not executed.
- Dependency advisories were reviewed from general knowledge, not from a live vulnerability database.

## Changes made (project status)

New modules: `scripts/lib/safefs.mjs`, `scripts/lib/integrity.mjs`, `scripts/lib/hublock.mjs`.
Changed: `spector.mjs`, `memory.mjs`, `install.mjs`, `sync.mjs`, `create.mjs`, `approval.mjs`, `scan.mjs`, `source.mjs`, `repo.mjs`, `deps.mjs`, `util.mjs`, `ui/server.mjs`, `dependencies.json`, both workflows, `i18n/en.json`, `GUIDE.md` (regenerated).
Tests: seven new files `tests/security-*.test.mjs` (listed in `package.json`); two existing tests updated (`settings.test.mjs`, `approval.test.mjs`) because their scripted scanner did not report completeness.
