// Cross-process lock for operations that change what is installed (add, update, approve, remove).
// Two concurrent runs (a terminal and the web interface, or two terminals) would read the same manifest.lock.json,
// each write their own version and one of the two changes would be lost, or one could replace a folder that the
// other is hashing. mkdir is atomic on every platform, so a directory is the lock. It records the owner's pid:
// a lock whose process is gone (crash) or that is older than STALE_MS is taken over.
import fs from 'node:fs';
import path from 'node:path';
import { rmrf } from './util.mjs';
import { isAlive } from './appdata.mjs';
import { safeDir } from './safefs.mjs';
import { tFor } from './i18n.mjs';

export class HubLockError extends Error {}

const STALE_MS = 4 * 60 * 60 * 1000; // no install runs this long: a lock this old is leftover
const OWNERLESS_MS = 30 * 1000; // lock folder created but owner file not written yet (or lost)

function readOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function isStale(dir, now) {
  const owner = readOwner(dir);
  if (owner && Number.isInteger(owner.pid)) {
    if (!isAlive(owner.pid)) return true;
    return now - Date.parse(owner.at) > STALE_MS;
  }
  try {
    return now - fs.statSync(dir).mtimeMs > OWNERLESS_MS;
  } catch {
    return true;
  }
}

/** Takes the lock or throws HubLockError. Returns a `release()` function (safe to call twice). */
export function acquireHubLock(root, label = 'install', { now = Date.now() } = {}) {
  const t = tFor(root);
  const locks = safeDir(root, ['.tmp', 'locks'], { create: true, t });
  const dir = path.join(locks, 'hub.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, label, at: new Date(now).toISOString() }));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (readOwner(dir)?.pid === process.pid) rmrf(dir);
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (isStale(dir, now)) {
        rmrf(dir); // leftover of a crashed run: take over and retry once
        continue;
      }
      const owner = readOwner(dir);
      throw new HubLockError(t('lock.busy', { label: owner?.label ?? '?', pid: owner?.pid ?? '?', at: owner?.at ?? '?' }));
    }
  }
  throw new HubLockError(t('lock.busy', { label: '?', pid: '?', at: '?' }));
}
