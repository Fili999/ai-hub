// Shared utilities for all scripts. No external dependencies (Node >= 22 only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { tFor } from './i18n.mjs';

const t = tFor();

export const HUB_ROOT = process.env.AI_HUB_ROOT
  ? path.resolve(process.env.AI_HUB_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const toPosix = (p) => p.split(path.sep).join('/');

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(t('util.error.badJson', { file, message: e.message }));
  }
}

/**
 * Writes JSON atomically: to a temporary file next to the target, then renamed over it. A crash never leaves a
 * half-written file, and a symlink planted at `file` is replaced instead of being written through.
 */
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Minimal argument parser: --key value, --key=value, --flag, positional args. */
export function parseArgs(argv, { boolean = [] } = {}) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (boolean.includes(key)) flags[key] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { flags, positional };
}

export const csv = (v) =>
  v === undefined || v === true || v === false
    ? []
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Safe name for files/folders (prevents path traversal). */
export const isSafeName = (n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(n) && !n.includes('..');

// Folders where "uv tool install" and winget place programs: often not yet in terminal PATH
// (on macOS requires "uv tool update-shell" and a fresh terminal; on Windows a new terminal).
export const toolBinDirs = (env = process.env, platform = process.platform) =>
  [
    env.UV_TOOL_BIN_DIR,
    env.XDG_BIN_HOME,
    path.join(env.HOME || env.USERPROFILE || os.homedir(), '.local', 'bin'),
    platform === 'win32' && env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : null,
  ].filter(Boolean);

/**
 * Can this file be executed? On Windows, Store-installed programs (winget.exe in WindowsApps) are
 * execution aliases: special files stat cannot inspect. Simply checking folder existence suffices.
 */
export function isRunnable(f, { platform = process.platform, fsx = fs } = {}) {
  try {
    if (!fsx.statSync(f).isFile()) return false;
    if (platform !== 'win32') fsx.accessSync(f, fs.constants.X_OK);
    return true;
  } catch {
    if (platform !== 'win32') return false;
    try {
      const name = path.win32.basename(f).toLowerCase();
      return fsx.readdirSync(path.win32.dirname(f)).some((n) => n.toLowerCase() === name);
    } catch {
      return false;
    }
  }
}

/**
 * Full path to a program: first in PATH, then in uv tool folders. null if missing.
 * Resolves whether the executable can be found in PATH directly.
 */
export function commandPath(cmd, env = process.env) {
  if (!/^[A-Za-z0-9._+-]+$/.test(cmd)) return null;
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const look = (dirs) => {
    for (const dir of dirs) {
      // a relative entry ("", ".", "bin") would resolve against the current folder: never trust it
      if (!dir || !path.isAbsolute(dir)) continue;
      for (const ext of exts) {
        const f = path.join(dir, cmd + ext);
        if (isRunnable(f)) return f;
      }
    }
    return null;
  };
  return look((env.PATH || '').split(path.delimiter)) ?? look(toolBinDirs(env));
}

export const commandExists = (cmd) => Boolean(commandPath(cmd));

export const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');

const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** List of files (POSIX relative paths) in a folder, excluding .git, node_modules, and symlinks. */
export function listFiles(dir, { maxDepth = 6, maxFiles = 2000 } = {}) {
  const out = [];
  (function walk(d, depth) {
    if (depth > maxDepth || out.length >= maxFiles) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name) || ent.isSymbolicLink()) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile()) out.push(toPosix(path.relative(dir, full)));
    }
  })(dir, 0);
  return out.sort();
}

/** Content hash of a file or folder (to detect local modifications). */
export function hashPath(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return sha1(fs.readFileSync(p));
  const h = crypto.createHash('sha1');
  for (const rel of listFiles(p, { maxFiles: 100000, maxDepth: 20 })) {
    h.update(rel + '\0');
    h.update(fs.readFileSync(path.join(p, rel)));
  }
  return h.digest('hex');
}

/** Copies a directory ignoring .git, node_modules, and symlinks. Returns count of skipped symlinks. */
export function copyDir(src, dest) {
  let skippedLinks = 0;
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const st = fs.lstatSync(s);
      if (st.isSymbolicLink()) {
        skippedLinks++;
        return false;
      }
      return !SKIP_DIRS.has(path.basename(s));
    },
  });
  return skippedLinks;
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export const claudeDir = () => path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question, def = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(question)).trim();
    return ans || def;
  } finally {
    rl.close();
  }
}

/** Yes/no question; Enter keeps the default. Accepts y/yes. */
export async function confirm(question, def = false) {
  const ans = (await ask(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  if (!ans) return def;
  return ['y', 'yes'].includes(ans);
}

export function fail(msg, code = 1) {
  console.error(`✖ ${msg}`);
  process.exit(code);
}
