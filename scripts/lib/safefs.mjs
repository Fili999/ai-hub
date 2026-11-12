// Filesystem helpers that never write "through" a symbolic link, junction or reparse point.
//
// Textual checks on a path ("startsWith", ".." filtering) are not enough: `memory/lessons` may be a symlink
// (a repository can contain symlinks!) pointing outside the hub, and then `memory/lessons/x.md` looks internal
// but lands elsewhere. So every helper here:
//   1. starts from the CANONICAL root (realpath) and walks the path one component at a time with lstat;
//   2. refuses any component that is a symlink/junction (Node reports Windows junctions as symbolic links);
//   3. opens the final file with O_NOFOLLOW where the platform has it (no effect on Windows: step 2 covers it);
//   4. after opening, checks that the file we hold is the one at the canonical path inside the root
//      (same device/inode, realpath unchanged). That closes the TOCTOU window where a directory is swapped
//      for a symlink between the check and the open: if it happens the write is refused and undone.
//
// Zero dependencies, same behaviour on Windows, macOS and Linux.
import fs from 'node:fs';
import path from 'node:path';
import { tFor } from './i18n.mjs';

export class UnsafePathError extends Error {}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

const lstatOrNull = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/** True when `target` is strictly inside `base` (both absolute). Uses path.relative: separator/case aware. */
export function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Splits a user-supplied relative path ("/" or "\" separators, mixed allowed) into safe components.
 * Rejects absolute paths, drive letters, "..", NUL and empty results. "." and empty segments are dropped.
 */
export function relParts(rel, t = tFor()) {
  const s = String(rel ?? '');
  if (!s || s.includes('\0') || /^([\\/]|[A-Za-z]:)/.test(s)) throw new UnsafePathError(t('safefs.badPath'));
  const parts = s.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) throw new UnsafePathError(t('safefs.badPath'));
  return parts;
}

/**
 * Walks `parts` below `root`, component by component, and returns the canonical absolute path.
 * Every component must be a real directory (never a symlink/junction). With `create`, missing
 * directories are created one at a time (so a created directory is checked before the next step).
 * Throws UnsafePathError for symlinks, and UnsafePathError with code ENOENT for a missing component without `create`.
 */
export function safeDir(root, parts, { create = false, t = tFor() } = {}) {
  let cur = fs.realpathSync(root);
  for (const seg of parts) {
    const next = path.join(cur, seg);
    let st = lstatOrNull(next);
    if (!st) {
      if (!create) throw Object.assign(new UnsafePathError(t('safefs.notFound', { segment: seg })), { code: 'ENOENT' });
      try {
        fs.mkdirSync(next);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      st = lstatOrNull(next);
    }
    if (!st || st.isSymbolicLink()) throw new UnsafePathError(t('safefs.isSymlink', { segment: seg }));
    if (!st.isDirectory()) throw new UnsafePathError(t('safefs.notDirectory', { segment: seg }));
    cur = next;
  }
  if (fs.realpathSync(cur) !== cur) throw new UnsafePathError(t('safefs.isSymlink', { segment: parts.at(-1) ?? '' }));
  return cur;
}

/**
 * The file behind `fd` must be exactly the file at the canonical path `file`: same device and inode, and the
 * path still resolves to itself. A directory swapped for a symlink after the check makes this fail.
 */
function sameFile(fd, file) {
  try {
    if (fs.realpathSync(file) !== file) return false;
    const a = fs.fstatSync(fd);
    const b = fs.lstatSync(file);
    if (b.isSymbolicLink() || !b.isFile()) return false;
    // Windows may report ino 0 for some volumes: then realpath + lstat above are all we can check.
    return a.ino === 0 || b.ino === 0 || (a.ino === b.ino && a.dev === b.dev);
  } catch {
    return false;
  }
}

/**
 * Creates a NEW file at root/parts (directories are created safely), never overwriting. Returns its canonical path.
 * `hooks.beforeOpen` runs between the directory check and the open: tests use it to simulate a race.
 */
export function createFileExclusive(root, parts, data, { hooks = {}, t = tFor() } = {}) {
  const dir = safeDir(root, parts.slice(0, -1), { create: true, t });
  const file = path.join(dir, parts.at(-1));
  hooks.beforeOpen?.(file);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o644);
  } catch (e) {
    if (e.code === 'ELOOP') throw new UnsafePathError(t('safefs.isSymlink', { segment: parts.at(-1) }));
    throw e;
  }
  try {
    if (!sameFile(fd, file)) {
      // The directory was redirected after our check: the file we just created is NOT where we meant.
      // O_EXCL guarantees we created it, so removing the file behind our own descriptor is safe.
      undoCreated(fd, file);
      throw new UnsafePathError(t('safefs.raceDetected'));
    }
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

function undoCreated(fd, intended) {
  // Find where the descriptor's file really is: resolve the intended parent through realpath.
  try {
    const real = fs.realpathSync(path.dirname(intended));
    const actual = path.join(real, path.basename(intended));
    const a = fs.fstatSync(fd);
    const b = fs.lstatSync(actual);
    if (b.isFile() && a.ino === b.ino && a.dev === b.dev) fs.unlinkSync(actual);
  } catch {
    /* nothing more can be done safely */
  }
}

/**
 * Appends to an EXISTING regular file at root/parts without following links. `build(currentText)` returns the
 * text to append (or throws to refuse). The file is opened first, verified, and only then read and written.
 */
export function appendFileSafe(root, parts, build, { hooks = {}, t = tFor() } = {}) {
  const dir = safeDir(root, parts.slice(0, -1), { t });
  const file = path.join(dir, parts.at(-1));
  const st = lstatOrNull(file);
  if (!st) throw Object.assign(new UnsafePathError(t('safefs.notFound', { segment: parts.at(-1) })), { code: 'ENOENT' });
  if (st.isSymbolicLink()) throw new UnsafePathError(t('safefs.isSymlink', { segment: parts.at(-1) }));
  hooks.beforeOpen?.(file);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | NOFOLLOW);
  } catch (e) {
    if (e.code === 'ELOOP') throw new UnsafePathError(t('safefs.isSymlink', { segment: parts.at(-1) }));
    throw e;
  }
  try {
    if (!sameFile(fd, file)) throw new UnsafePathError(t('safefs.raceDetected'));
    const info = fs.fstatSync(fd);
    if (!info.isFile()) throw new UnsafePathError(t('safefs.notFile'));
    // A hard link would let a write here modify a file that also lives outside the hub.
    if (info.nlink > 1) throw new UnsafePathError(t('safefs.hardLink'));
    const current = fs.readFileSync(fd, 'utf8');
    const extra = build(current);
    fs.writeSync(fd, Buffer.from(extra, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

/**
 * Checks that deleting/replacing `target` stays inside `base` (a directory below `root`): textual containment, and
 * every directory between root and target is a real directory (the last component itself may be a link: removing a
 * link removes the link, never its destination). Returns the absolute target. Throws UnsafePathError.
 */
export function assertContained(root, base, target, { t = tFor() } = {}) {
  const baseAbs = path.resolve(root, base);
  const targetAbs = path.resolve(root, target);
  if (!isInside(baseAbs, targetAbs)) throw new UnsafePathError(t('safefs.outside', { path: String(target) }));
  const chain = path.relative(path.resolve(root), targetAbs).split(path.sep).filter(Boolean);
  let cur = fs.realpathSync(root);
  chain.forEach((seg, i) => {
    cur = path.join(cur, seg);
    const st = lstatOrNull(cur);
    if (st?.isSymbolicLink() && i < chain.length - 1) throw new UnsafePathError(t('safefs.isSymlink', { segment: seg }));
  });
  return targetAbs;
}
