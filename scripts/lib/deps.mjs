// System dependencies: read dependencies.json, verify, installation plan.
// Security principle: commands are never free text. We declare {manager, package} and code
// builds the command line; managers and package names are validated. Third-party skills do not choose
// what gets executed: they can only declare the NAME of a required command (checked without running it).
import path from 'node:path';
import { commandExists, readJson } from './util.mjs';
import { availableManagers, compareVersions, parseVersion, runCommand } from './machine.mjs';
import { hubLanguage, tFor } from './i18n.mjs';

export const MANAGERS = ['winget', 'brew', 'npm', 'uv'];
const PKG_RE = /^[A-Za-z0-9@][A-Za-z0-9@._/+-]{0,99}$/;
// uv installs Python tools: a package name or a GitHub repository (git+https://github.com/owner/repo.git)
// git packages must be pinned to a full commit (a branch or tag can be moved after review): .git@<40 hex>
const UV_GIT_RE = /^git\+https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\.git(@[0-9a-f]{40})?$/;
const CMD_RE = /^[A-Za-z0-9._+-]+$/;
const LEVELS = ['required', 'recommended', 'optional'];
export const PLATFORMS = ['win32', 'darwin', 'linux'];

/** A text or {en, it, …}: the hub language, then English. */
const pick = (v, lang) => (v && typeof v === 'object' ? (v[lang] ?? v.en ?? Object.values(v)[0] ?? '') : v);

export function loadDependencies(root, lang = hubLanguage(root)) {
  const data = readJson(path.join(root, 'dependencies.json'), { version: 1, tools: [], commandProviders: {} });
  return {
    version: data.version ?? 1,
    tools: (Array.isArray(data.tools) ? data.tools : []).map((t) => ({ ...t, why: pick(t.why, lang) })),
    commandProviders: Object.fromEntries(Object.entries(data.commandProviders ?? {}).filter(([k]) => !k.startsWith('_'))),
  };
}

// uv can lock the tool's Python version (e.g. "3.12": some prebuilt wheels only exist
// for certain versions, and with the latest Python uv would attempt to build them from source)
const PY_RE = /^3\.\d{1,2}$/;

function validInstall(spec) {
  if (!spec || !MANAGERS.includes(spec.manager) || typeof spec.package !== 'string') return false;
  if (spec.python !== undefined && !(spec.manager === 'uv' && typeof spec.python === 'string' && PY_RE.test(spec.python))) return false;
  return PKG_RE.test(spec.package) || (spec.manager === 'uv' && UV_GIT_RE.test(spec.package));
}

/** List of issues in the file (human-readable strings); empty if valid. */
export function validateDependencies(deps, t = tFor()) {
  const errors = [];
  const seen = new Set();
  for (const tool of deps.tools) {
    const where = `tools[${tool.id ?? '?'}]`;
    if (!tool.id || !CMD_RE.test(tool.id)) errors.push(t('deps.missingOrInvalidId', { where }));
    if (seen.has(tool.id)) errors.push(t('deps.duplicateId', { where }));
    seen.add(tool.id);
    if (!LEVELS.includes(tool.level)) errors.push(t('deps.badLevel', { where, levels: LEVELS.join(' | ') }));
    if (!tool.check || !CMD_RE.test(tool.check.command ?? '')) errors.push(t('deps.badCheckCommand', { where }));
    for (const [p, spec] of Object.entries(tool.install ?? {})) {
      if (!PLATFORMS.includes(p)) errors.push(t('deps.unknownPlatform', { where, p }));
      else if (!validInstall(spec)) errors.push(t('deps.badInstallSpec', { where, managers: MANAGERS.join('/'), p }));
    }
  }
  for (const [cmd, prov] of Object.entries(deps.commandProviders)) {
    if (!CMD_RE.test(cmd)) errors.push(t('deps.badCommandProviderName', { cmd }));
    for (const [p, spec] of Object.entries(prov.install ?? {})) {
      if (!PLATFORMS.includes(p) || !validInstall(spec)) errors.push(t('deps.badCommandProviderInstall', { cmd, p }));
    }
  }
  return errors;
}

/** Checks a dependencies.json tool (only executes the command declared in the repo file). */
export function checkTool(tool, probe = runCommand, t = tFor()) {
  const base = { id: tool.id, name: tool.name ?? tool.id, level: tool.level, why: tool.why ?? '', found: false, version: null, ok: false, reason: '' };
  if (!commandExists(tool.check.command)) return { ...base, reason: t('deps.notFoundInPath') };
  let version = null;
  if (tool.check.args?.length) {
    const r = probe(tool.check.command, tool.check.args, { timeout: 10000 });
    version = parseVersion(r.stdout || r.stderr);
    if (!r.ok && !version) return { ...base, found: true, reason: t('deps.foundNotResponding') };
  }
  const vText = version ? version.join('.') : null;
  if (tool.check.minVersion && version && compareVersions(version, tool.check.minVersion) < 0) {
    return { ...base, found: true, version: vText, reason: t('deps.versionTooOld', { version: vText, minVersion: tool.check.minVersion }) };
  }
  return { ...base, found: true, version: vText, ok: true };
}

export function checkAll(deps, probe, t = tFor()) {
  return deps.tools.map((tool) => checkTool(tool, probe, t));
}

/** Installation plan for this platform, or null with the reason why it is not automated. */
export function installPlan(spec, manual, { platform = process.platform, managers = availableManagers(), t = tFor() } = {}) {
  const s = spec?.[platform];
  if (!s) return { auto: false, reason: t('deps.noAutoInstallForPlatform', { platform }), manual };
  if (!validInstall(s)) return { auto: false, reason: t('deps.invalidInstallSpec'), manual };
  if (!managers[s.manager]) {
    const hint = s.manager === 'brew' ? t('deps.brewNotInstalled') : s.manager === 'winget' ? t('deps.wingetNotAvailable') : s.manager === 'uv' ? t('deps.uvNotInstalled') : t('deps.managerNotInstalled', { manager: s.manager });
    return { auto: false, reason: hint, manual };
  }
  let args;
  if (s.manager === 'winget') args = ['install', '--id', s.package, '-e', '--accept-package-agreements', '--accept-source-agreements'];
  else if (s.manager === 'brew') args = ['install', ...(s.cask ? ['--cask'] : []), s.package];
  else if (s.manager === 'uv') args = ['tool', 'install', ...(s.python ? ['--python', s.python] : []), s.package];
  else args = ['install', '-g', s.package];
  return { auto: true, manager: s.manager, args, display: `${s.manager} ${args.join(' ')}`, manual };
}

/** Commands required by indexed skills/agents that are missing, with who requires them. */
export function missingSkillCommands(index, exists = commandExists) {
  const need = new Map();
  for (const e of [...index.skills, ...index.agents]) {
    for (const c of e.requires?.commands ?? []) {
      if (!need.has(c)) need.set(c, []);
      need.get(c).push(e.id);
    }
  }
  return [...need].filter(([c]) => !exists(c)).map(([command, requiredBy]) => ({ command, requiredBy }));
}

/** Executes a plan (displays manager output). */
// Winget exit codes that mean "already installed": APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE
// (no update, 0x8A15002B) and PACKAGE_ALREADY_INSTALLED (0x8A150061). These are not errors.
const WINGET_ALREADY = new Set([0x8a15002b, 0x8a150061]);

export function runPlan(plan, runner = runCommand, t = tFor()) {
  if (!plan.auto) return { ok: false, error: plan.reason };
  const r = runner(plan.manager, plan.args, { inherit: true });
  if (!r.ok && plan.manager === 'winget' && WINGET_ALREADY.has(r.status >>> 0)) return { ok: true, error: null, already: true };
  return { ok: r.ok, error: r.ok ? null : r.error || t('deps.exitCode', { code: r.status }) };
}
