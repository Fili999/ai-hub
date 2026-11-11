// Builds the files that start the hub with a double-click from the desktop (Windows and Mac). Pure functions: tested without touching the system.
import path from 'node:path';
import { tFor } from './i18n.mjs';

/** Encloses text in single quotes for POSIX shells (internal single quotes are escaped). */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A path for a .cmd file: quoted, with doubled "%"; Windows paths cannot contain ". */
export function cmdPath(p) {
  if (/["\r\n]/.test(p)) throw new Error('The path contains characters that are not allowed.');
  return `"${p.replace(/%/g, '%%')}"`;
}

/** Mac: a .command file to leave on the desktop; it forwards to start.command inside the hub folder. */
export function macLauncher(repoRoot) {
  if (/[\r\n\0]/.test(repoRoot)) throw new Error('The path contains characters that are not allowed.');
  return `#!/bin/zsh -l\n# Shortcut to ai-hub: opens the interface (close the Terminal window to stop it).\nexec ${shellQuote(path.posix.join(repoRoot, 'start.command'))} "$@"\n`;
}

/** Windows, if PowerShell is missing: a small .cmd to leave on the desktop (CRLF line endings). */
export function windowsLauncher(repoRoot) {
  return ['@echo off', 'rem Shortcut to ai-hub: opens the interface (close the window to stop it).', `call ${cmdPath(path.win32.join(repoRoot, 'start.cmd'))}`, ''].join('\r\n');
}

/**
 * Windows: FIXED PowerShell script that creates the shortcut (.lnk) with icon. Values come from environment
 * variables (AIHUB_LNK, AIHUB_TARGET, AIHUB_DIR, AIHUB_ICON), never concatenated into script text: no quote issues.
 */
export const WINDOWS_SHORTCUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:AIHUB_LNK)',
  '$s.TargetPath = $env:AIHUB_TARGET',
  '$s.WorkingDirectory = $env:AIHUB_DIR',
  '$s.IconLocation = $env:AIHUB_ICON',
  "$s.Description = 'ai-hub: AI agents and skills'",
  '$s.WindowStyle = 7', // minimized window: close from there to stop the hub
  '$s.Save()',
].join('; ');

export const WINDOWS_DESKTOP_SCRIPT = "[Environment]::GetFolderPath('Desktop')";

/** Do not overwrite a file with the same name if not created by us (identified by the word "ai-hub" in text). */
function ownFile(file, fs) {
  if (!fs.existsSync(file)) return true;
  try {
    return fs.readFileSync(file, 'utf8').includes('ai-hub');
  } catch {
    return false;
  }
}

/**
 * Creates the desktop shortcut. Everything touching the system is injected (fs, powershell) for testability.
 * Returns { ok, file, kind, message }. kind: 'command' (Mac) | 'lnk' | 'cmd' (Windows) | 'none'.
 */
export function createShortcut({ platform, dir, root, dry = false, fs, powershell, t = tFor() }) {
  const done = (ok, file, kind, message) => ({ ok, file, kind, message });
  if (platform === 'darwin') {
    const file = path.join(dir, 'ai-hub.command');
    if (!ownFile(file, fs)) return done(false, file, 'command', t('shortcut.macNotOwn', { file }));
    if (dry) return done(true, file, 'command', t('shortcut.macDryRun', { file }));
    fs.writeFileSync(file, macLauncher(root), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    return done(true, file, 'command', t('shortcut.macCreated', { file }));
  }
  if (platform === 'win32') {
    const lnk = path.join(dir, 'ai-hub.lnk');
    const icon = path.join(root, 'ui', 'public', 'brand', 'ai-hub.ico');
    if (dry) return done(true, lnk, 'lnk', t('shortcut.winDryRun', { lnk, icon }));
    const r = powershell(WINDOWS_SHORTCUT_SCRIPT, { AIHUB_LNK: lnk, AIHUB_TARGET: path.join(root, 'start.cmd'), AIHUB_DIR: root, AIHUB_ICON: `${icon},0` });
    if (r.status === 0 && fs.existsSync(lnk)) return done(true, lnk, 'lnk', t('shortcut.winLnkCreated', { lnk }));
    const file = path.join(dir, 'ai-hub.cmd');
    if (!ownFile(file, fs)) return done(false, file, 'cmd', t('shortcut.winPsFailedNotOwn', { file }));
    fs.writeFileSync(file, windowsLauncher(root));
    return done(true, file, 'cmd', t('shortcut.winCmdFallback', { file }));
  }
  return done(true, null, 'none', t('shortcut.notNeeded'));
}
