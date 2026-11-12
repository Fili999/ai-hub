# Security policy

AI Hub installs instructions (skills, agents) that AI tools will follow, and runs a local web interface, so security is a core part of the project. See [docs/security.md](docs/security.md) for the design (and [SECURITY_AUDIT.md](SECURITY_AUDIT.md) for the latest audit, fixes and known limits) (approvals by exact hash, optional NVIDIA SkillSpector scan, fail-closed installs, no free-text commands).

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and the version (see `VERSION.txt` or `package.json`). You will get an answer within a few days; a fix and a coordinated disclosure follow for confirmed issues.

## What is in scope

- The local server (`ui/server.mjs`): authentication token, Host/Origin checks, input validation.
- Installing from GitHub (`scripts/install.mjs`, `scripts/lib/approval.mjs`, `scripts/lib/spector.mjs`): anything that lets unapproved or altered content become active.
- Command construction (`scripts/lib/deps.mjs`, `scripts/lib/machine.mjs`): any path to free-text command execution.
- Secret handling: files that should be refused (`scripts/lib/repo.mjs`, `scripts/lib/memory.mjs`).

Skills and agents downloaded from third parties are **untrusted input**: a malicious skill that the hub correctly flagged is not a vulnerability of the hub; a skill that gets around the checks is.
