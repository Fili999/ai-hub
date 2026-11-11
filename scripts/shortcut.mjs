#!/usr/bin/env node
// Creates a desktop shortcut that opens the hub interface on double click (Windows and Mac).
//   node scripts/shortcut.mjs [--dry-run] [--dir <folder>]
// Windows: "ai-hub" shortcut with logo icon (via PowerShell; fallback .cmd). Mac: "ai-hub.command" file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HUB_ROOT, fail, parseArgs } from './lib/util.mjs';
import { WINDOWS_DESKTOP_SCRIPT, createShortcut } from './lib/shortcut.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags } = parseArgs(process.argv.slice(2), { boolean: ['dry-run'] });
const platform = process.platform;

// PowerShell runs fixed script; parameters are passed via environment variables
const powershell = (script, env = {}) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });

function desktopDir() {
  if (flags.dir && flags.dir !== true) return path.resolve(String(flags.dir));
  if (platform === 'win32') {
    const r = powershell(WINDOWS_DESKTOP_SCRIPT); // respects Desktop relocated to OneDrive
    const dir = r.status === 0 ? String(r.stdout).trim() : '';
    if (dir && fs.existsSync(dir)) return dir;
  }
  return path.join(os.homedir(), 'Desktop');
}

const dir = desktopDir();
if (['darwin', 'win32'].includes(platform) && !fs.existsSync(dir)) fail(t('shortcut.noDesktop', { dir }));
const r = createShortcut({ platform, dir, root: HUB_ROOT, dry: Boolean(flags['dry-run']), fs, powershell, t });
console.log(`${r.ok ? '✔' : '✖'} ${r.message}`);
process.exit(r.ok ? 0 : 1);
