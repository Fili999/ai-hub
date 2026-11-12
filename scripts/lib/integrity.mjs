// Integrity of what gets installed: the bytes that were scanned are the bytes that are approved and activated.
//
// Flow used by install / update / approve:
//   1. snapshotItem(): copy the candidate (a skill folder, a whole package or an agent file) into a private staging
//      area and compute its SHA-256 (`h0`). From now on ONLY the snapshot is used: the scanner reads it, the
//      installer copies from it. Changes made to the original afterwards cannot reach the hub.
//   2. scan the snapshot, then assertHash(snapshot, h0): if the scanner (or any other process) changed it, stop.
//   3. Transaction.place(): copy snapshot → staging next to the hub, verify h0 again, move it into place with a
//      rename (atomic on the same volume; the old version is moved aside first and restored on any failure),
//      verify h0 once more on the final location. Only then is the approval recorded, for that exact hash.
//
// Immutability is enforced by verification (hash before / after), not by file permissions: those cannot stop a
// process running as the same user, and read-only trees make cleanup fail on Windows.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { packageHash } from './approval.mjs';
import { copyDir, rmrf } from './util.mjs';
import { relParts, safeDir } from './safefs.mjs';
import { tFor } from './i18n.mjs';

const t = tFor();

export class IntegrityError extends Error {}

const rand = () => crypto.randomBytes(6).toString('hex');

/** Copies `src` (folder or file) to `parentDir/name` and returns {path, hash}. Skips .git, node_modules, symlinks. */
export function snapshotItem(src, parentDir, name = path.basename(src)) {
  const dest = path.join(parentDir, name);
  fs.mkdirSync(parentDir, { recursive: true });
  if (fs.statSync(src).isDirectory()) copyDir(src, dest);
  else fs.copyFileSync(src, dest);
  return { path: dest, hash: packageHash(dest) };
}

/** Throws IntegrityError unless `p` still has the hash it had when it was snapshotted. */
export function assertHash(p, expected, what = p) {
  const actual = fs.existsSync(p) ? packageHash(p) : null;
  if (actual !== expected) throw new IntegrityError(t('integrity.changed', { what: path.basename(String(what)), expected: expected.slice(0, 19), actual: actual ? actual.slice(0, 19) : '—' }));
}

// Windows (antivirus, indexer) can hold a folder for a moment: retry the rename a few times.
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80 * (i + 1));
    }
  }
}

/**
 * A group of filesystem changes that is either completely applied or completely undone.
 * Everything stays under the hub's own `.tmp/` (same volume as the destinations, so renames are atomic).
 */
export class Transaction {
  constructor(root) {
    this.root = root;
    const tmpDir = safeDir(root, ['.tmp'], { create: true });
    this.dir = fs.mkdtempSync(path.join(tmpDir, 'staging-'));
    this.ops = [];
    this.unrecovered = false;
  }

  /** Moves an existing file/folder out of the way (restored by rollback). No-op when it does not exist. */
  removeAside(target) {
    try {
      fs.lstatSync(target);
    } catch {
      return;
    }
    const backup = path.join(this.dir, `bak-${this.ops.length}-${rand()}`);
    renameRetry(target, backup);
    this.ops.push({ type: 'removed', target, backup });
  }

  /**
   * Installs the snapshot at `dest` (absolute, inside the hub): copy → verify → rename → verify.
   * Any failure throws IntegrityError and the caller is expected to call rollback().
   */
  place(snapshotPath, dest, expectedHash) {
    assertHash(snapshotPath, expectedHash, 'snapshot');
    const staged = path.join(this.dir, `new-${this.ops.length}-${rand()}`);
    if (fs.statSync(snapshotPath).isDirectory()) copyDir(snapshotPath, staged);
    else fs.copyFileSync(snapshotPath, staged);
    assertHash(staged, expectedHash, 'staged copy');
    // the destination's parent must be a real folder chain inside the hub (never a link)
    const rel = path.relative(this.root, dest);
    safeDir(this.root, relParts(path.dirname(rel)), { create: true });
    this.removeAside(dest);
    renameRetry(staged, dest);
    this.ops.push({ type: 'placed', target: dest });
    assertHash(dest, expectedHash, 'installed copy');
  }

  /** Undoes everything, newest first. Never throws: it runs on error paths. */
  rollback() {
    for (const op of this.ops.reverse()) {
      try {
        if (op.type === 'placed') rmrf(op.target);
        else if (!fs.existsSync(op.target)) renameRetry(op.backup, op.target);
      } catch {
        this.unrecovered = true; // the staging folder is kept so the old version can be recovered by hand
      }
    }
    this.ops = [];
  }

  /** Success: drops the old versions and the staging area. */
  commit() {
    this.ops = [];
    rmrf(this.dir);
  }

  /** Always call in `finally`: removes the staging area unless a rollback could not restore something. */
  dispose() {
    if (!this.unrecovered) rmrf(this.dir);
  }
}
