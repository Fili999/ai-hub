// Helpers for the packaged apps (AI Hub.app, AI Hub.exe): where the user's hub lives and how the files shipped with
// the app are copied there without ever overwriting what the user changed. Zero dependencies, no HUB_ROOT access
// (the launcher imports this before it knows which hub it is serving).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MANIFEST_FILE = 'app-manifest.json'; // written by the build, lives next to the shipped files
export const STATE_FILE = '.app-state.json'; // lives in the user's hub: what was copied from the app, and its hash
export const RUNTIME_FILE = path.join('.tmp', 'app.json'); // pid + address of the running hub

/** Folder of the user's hub: AI_HUB_HOME if set, otherwise "AI Hub" in the home folder (visible, outside OneDrive/iCloud). */
export function dataDir({ env = process.env, home = os.homedir() } = {}) {
  return env.AI_HUB_HOME ? path.resolve(env.AI_HUB_HOME) : path.join(home, 'AI Hub');
}

export const hashFile = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

/** Compares "1.2.3" style versions: -1, 0, 1 (missing or malformed parts count as 0; a leading "v" is ignored). */
export function cmpVersion(a, b) {
  const parts = (v) => String(v ?? '').replace(/^v/i, '').split('.').slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  return 0;
}

const readJsonSafe = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Manifest of the shipped files ({version, id, files: {relativePath: sha1}}) or null (e.g. running from a source checkout). */
export const readManifest = (srcDir) => {
  const m = readJsonSafe(path.join(srcDir, MANIFEST_FILE));
  return m && typeof m.files === 'object' && m.files ? m : null;
};

/** Build-time: manifest for a staged folder. `id` changes whenever any shipped file changes. */
export function buildManifest(srcDir, files, version) {
  const entries = {};
  for (const rel of [...files].sort()) entries[rel] = hashFile(path.join(srcDir, rel));
  const id = crypto.createHash('sha1').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
  return { version, id, files: entries };
}

function pruneEmptyDirs(dir, stop) {
  for (let d = dir; d.startsWith(stop) && d !== stop; d = path.dirname(d)) {
    try {
      fs.rmdirSync(d); // only succeeds when empty
    } catch {
      return;
    }
  }
}

/**
 * Copies the app's files into the user's hub. Rules, per file listed in the manifest:
 *  - never copied before and missing → copied;
 *  - same content already there → nothing to do;
 *  - there, unchanged since the app copied it → replaced with the new version;
 *  - changed by the user → left alone; deleted by the user → not brought back.
 * Files an older version shipped and the new one dropped are removed only if the user never touched them.
 * Returns {skipped, copied, updated, kept, removed}; `skipped` is true when this exact version was already applied.
 * Never goes back: if the hub already holds a NEWER version (for example after an in-app update, while the app
 * itself is still the old download), nothing is touched, otherwise the old app would undo the update at every start.
 * Options: `manifest` (use this instead of reading app-manifest.json, e.g. one already checked and filtered) and
 * `dry` (only compute what would change: nothing is written).
 */
export function syncManaged(srcDir, destDir, { manifest: given = null, dry = false } = {}) {
  const result = { skipped: false, copied: [], updated: [], kept: [], removed: [] };
  const manifest = given ?? readManifest(srcDir);
  if (!manifest) return { ...result, skipped: true };

  const stateFile = path.join(destDir, STATE_FILE);
  const state = readJsonSafe(stateFile) ?? {};
  const seeded = state.files && typeof state.files === 'object' ? { ...state.files } : {};
  if (state.id === manifest.id && fs.existsSync(destDir)) return { ...result, skipped: true };
  if (state.version && manifest.version && cmpVersion(state.version, manifest.version) > 0 && fs.existsSync(destDir)) return { ...result, skipped: true };

  if (!dry) fs.mkdirSync(destDir, { recursive: true });
  const copy = (rel) => {
    if (dry) return;
    const to = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(srcDir, rel), to);
  };

  for (const [rel, sha] of Object.entries(manifest.files)) {
    const to = path.join(destDir, rel);
    if (!fs.existsSync(to)) {
      if (Object.hasOwn(seeded, rel)) continue; // the user deleted it: stays deleted
      copy(rel);
      seeded[rel] = sha;
      result.copied.push(rel);
      continue;
    }
    const current = hashFile(to);
    if (current === sha) {
      seeded[rel] = sha;
    } else if (Object.hasOwn(seeded, rel) && current === seeded[rel]) {
      copy(rel);
      seeded[rel] = sha;
      result.updated.push(rel);
    } else {
      result.kept.push(rel);
    }
  }

  for (const rel of Object.keys(seeded)) {
    if (Object.hasOwn(manifest.files, rel)) continue;
    const to = path.join(destDir, rel);
    try {
      if (!fs.existsSync(to) || hashFile(to) === seeded[rel]) {
        if (!dry) {
          fs.rmSync(to, { force: true });
          pruneEmptyDirs(path.dirname(to), destDir);
        }
        result.removed.push(rel);
        delete seeded[rel];
      }
    } catch {
      /* in use or unreadable: try again at the next upgrade */
    }
  }

  if (!dry) fs.writeFileSync(stateFile, JSON.stringify({ version: manifest.version, id: manifest.id, files: seeded }, null, 2) + '\n');
  return result;
}

/** Is a process with this pid alive? (signal 0 only checks) */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export const readRuntime = (destDir) => readJsonSafe(path.join(destDir, RUNTIME_FILE));

export function writeRuntime(destDir, data) {
  const file = path.join(destDir, RUNTIME_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data) + '\n');
}

/** Removes the runtime file, but only if it still describes this process (a newer instance may have replaced it). */
export function clearRuntime(destDir, pid = process.pid) {
  try {
    if (readRuntime(destDir)?.pid === pid) fs.rmSync(path.join(destDir, RUNTIME_FILE), { force: true });
  } catch {
    /* already gone */
  }
}
