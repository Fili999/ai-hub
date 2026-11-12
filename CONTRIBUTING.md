# Contributing to AI Hub

Thanks for helping! AI Hub is a small, dependency-free Node.js project. Contributions of every size are welcome: fixes, tests, docs, new AI-tool adapters, starter skills and agents.

## Quick start

```bash
git clone https://github.com/Fili999/ai-hub.git
cd ai-hub
node --version        # 22 or newer
npm test              # no install step: there are no npm dependencies
npm start             # opens the interface
```

## Ground rules

- **No npm dependencies.** Node 22+ standard library only, ES modules (`.mjs`). Scripts must behave the same on Windows, macOS and Linux: use `path`, never shell-specific commands.
- **Small, surgical changes.** Touch only what the change needs; keep existing behavior and the file formats (`registry.json`, `manifest.lock.json`, `teams.json`, `providers.json`, `settings.json`) backwards compatible.
- **Tests with every change.** Add or update tests, run `npm test`, list new test files in the `test` script of `package.json`.
- **After changing skills, agents, `registry.json` or `hub.config.json`:** run `npm run inventory` then `npm run doctor`. After changing docs: `npm run guide`.
- **Security is not optional.** Commands are never free text (see `dependencies.json` and `scripts/lib/deps.mjs`); every new `POST` route of the server validates its input and gets a test in `tests/ui.test.mjs`; never add a way to skip the SkillSpector policy.
- **Messages live in one catalog.** User-visible text goes in `i18n/en.json` (English only). Do not hard-code messages.
- **No personal data.** No names, e-mails, usernames, machine names, paths or secrets in code, tests, docs or examples (use `example-owner`, `Jane`, `/Users/jane`).

## Adding an AI tool

Add an entry to `providers.json` (paths, agent format, models, effort levels) and, if the tool needs a new agent format, a converter in `scripts/lib/providers.mjs` with tests in `tests/providers.test.mjs`. Skills need no conversion: the open Agent Skills standard (`SKILL.md`) is shared.

## Docs

Docs live in `docs/`; run `npm run guide` after changing them.

## Pull requests

1. Fork, create a branch, make the change with tests.
2. `npm test` must pass (CI runs Linux with Node 22 and 24, Windows and macOS with Node 22).
3. Describe what changed and why; mention anything you could not test.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
