// Current machine information and controlled command execution. No external dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claudeDir, commandExists, commandPath, readJson } from './util.mjs';
import { loadProviders, providerPaths } from './providers.mjs';
import { readSettings } from './settings.mjs';
import { tFor } from './i18n.mjs';

export const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
export const platformLabel = (p = process.platform) => PLATFORM_LABEL[p] ?? p;

const SAFE_CMD = /^[A-Za-z0-9._+-]+$/;
const SAFE_ARG = /^[A-Za-z0-9@._:/=+,-]+$/;

/**
 * Executes a FIXED command (name and arguments chosen by code or dependencies.json, never from third-party skills).
 * Name and arguments are validated; on Windows uses shell only for .cmd shims (npm), after validation.
 */
export function runCommand(cmd, args = [], { inherit = false, timeout = 0, cwd, t = tFor() } = {}) {
  if (!SAFE_CMD.test(cmd)) throw new Error(t('machine.invalidCommandName', { cmd }));
  for (const a of args) if (!SAFE_ARG.test(a)) throw new Error(t('machine.invalidArgument', { arg: a }));
  const needsShell = process.platform === 'win32' && /^(npm|npx|pnpm|yarn|claude)$/i.test(cmd);
  // a program installed with uv but not yet in PATH is launched via the full path found by commandPath
  const exe = needsShell ? cmd : (commandPath(cmd) ?? cmd);
  // with shell (only for Windows .cmd shims) pass a single line: name and args are already validated and
  // contain no spaces or special characters. Passing an array with shell: true is deprecated by Node (DEP0190).
  const r = spawnSync(needsShell ? [exe, ...args].join(' ') : exe, needsShell ? [] : args, {
    encoding: 'utf8',
    shell: needsShell,
    cwd,
    windowsHide: true,
    timeout: timeout || undefined,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    error: r.error ? r.error.message : null,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/;
const BARE_VERSION_RE = /^\s*v?(\d+)\s*$/;

/** Reads "git version 2.43.0", "v22.1.0", "1.2" and single numbers ("18", used as minimum version). */
export function parseVersion(text) {
  const t = String(text ?? '');
  const m = VERSION_RE.exec(t);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const b = BARE_VERSION_RE.exec(t);
  return b ? [Number(b[1]), 0, 0] : null;
}

/** -1, 0, 1 comparing two versions ("18", "18.2", "v22.1.0" ...). */
export function compareVersions(a, b) {
  const x = Array.isArray(a) ? a : parseVersion(a);
  const y = Array.isArray(b) ? b : parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Package managers available to install tools on this machine. */
export function availableManagers() {
  const out = {};
  for (const m of ['winget', 'brew', 'npm', 'uv']) out[m] = commandExists(m);
  return out;
}

/** Machine snapshot: independent of the repo, safe to display in the UI. */
export function machineInfo(root) {
  const cdir = claudeDir();
  let state = null;
  try {
    state = readJson(path.join(cdir, 'ai-hub.json'), null);
  } catch {
    /* unreadable file: treated as "never synced" */
  }
  let claudeMdBlock = false;
  try {
    claudeMdBlock = fs.readFileSync(path.join(cdir, 'CLAUDE.md'), 'utf8').includes('<!-- ai-hub:begin -->');
  } catch {
    /* no CLAUDE.md */
  }
  // every AI tool: chosen in Settings, installed, where it reads skills and agents, last sync, instructions block
  const settings = readSettings(root);
  const aiTools = Object.values(loadProviders(root)).map((p) => {
    const paths = providerPaths(p);
    let info = null;
    try {
      info = readJson(path.join(paths.home, 'ai-hub.json'), null);
    } catch {
      /* unreadable: never synced */
    }
    let block = false;
    try {
      block = fs.readFileSync(paths.instructionsFile, 'utf8').includes('<!-- ai-hub:begin -->');
    } catch {
      /* no instructions file */
    }
    return {
      id: p.id,
      name: p.name,
      enabled: Boolean(settings[`providers.${p.id}`]),
      installed: commandExists(p.command),
      command: p.command,
      paths,
      docs: p.docs ?? null,
      instructionsBlock: block,
      sync: info ? { active: Boolean(info.root) && path.resolve(info.root) === path.resolve(root), root: info.root ?? null, syncedAt: info.syncedAt ?? null, items: Array.isArray(info.entries) ? info.entries.length : 0 } : { active: false, root: null, syncedAt: null, items: 0 },
    };
  });
  return {
    aiTools,
    platform: process.platform,
    platformLabel: platformLabel(),
    arch: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    node: process.versions.node,
    claudeDir: cdir,
    claudeDirExists: fs.existsSync(cdir),
    managers: availableManagers(),
    isGitRepo: fs.existsSync(path.join(root, '.git')),
    claudeMdBlock,
    sync: state
      ? {
          active: Boolean(state.root) && path.resolve(state.root) === path.resolve(root),
          root: state.root ?? null,
          syncedAt: state.syncedAt ?? null,
          items: Array.isArray(state.entries) ? state.entries.length : 0,
        }
      : { active: false, root: null, syncedAt: null, items: 0 },
  };
}
