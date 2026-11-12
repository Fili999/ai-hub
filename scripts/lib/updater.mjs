// In-app updates for the copy of the hub that comes with the downloaded app (AI Hub.app / AI-Hub-Setup.exe).
//
//   check  → asks GitHub for the latest published release (at most every 12 hours, nothing personal is sent);
//   apply  → downloads the update archive of that release, verifies it, and copies the files with the same rules
//            the app uses at startup (appdata.syncManaged): a file YOU changed is never overwritten.
//
// What makes it safe to run on its own:
//   - only https, only github.com / *.githubusercontent.com, redirects followed by hand and re-checked, size limits;
//   - the archive must match the SHA-256 published in the same release (SHA256SUMS.txt);
//   - archive entries are checked before and after extraction (no "..", no absolute paths, no links), every file is
//     compared with the hash in its manifest, and manifest paths are validated and filtered (your data files,
//     external skills, memory and settings are never part of an update);
//   - a release that needs a newer Node.js than the one inside the app is refused (that needs a new download);
//   - the files about to change are copied aside first and restored if anything fails;
//   - one lock shared with install/update/approve: no update while a skill is being installed;
//   - a copy that is not an installed app (git clone, classic bundle) only gets a notice, never an automatic change.
//
// Trust: the same as downloading the app from the release page. The checksum protects against a corrupted or
// swapped file in transit, not against someone who controls the repository (docs/security.md).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { STATE_FILE, cmpVersion, hashFile, readManifest, syncManaged } from './appdata.mjs';
import { acquireHubLock } from './hublock.mjs';
import { relParts, safeDir } from './safefs.mjs';
import { commandPath, readJson, rmrf, writeJson } from './util.mjs';
import { readSettings } from './settings.mjs';
import { tFor } from './i18n.mjs';

export const ARCHIVE_NAME = 'ai-hub-update.tar.gz';
export const SUMS_NAME = 'SHA256SUMS.txt';
export const CHECK_TTL_MS = 12 * 60 * 60 * 1000;

const MAX_API = 1024 * 1024;
const MAX_SUMS = 64 * 1024;
const MAX_ARCHIVE = 80 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
// the user's own data and anything the installer manages: never replaced by an update, whatever the archive says
const NEVER = [/^registry\.json$/, /^teams\.json$/, /^manifest\.lock\.json$/, /^settings\.json$/, /^\.app-state\.json$/, /^skills\/external(\/|$)/, /^agents(\/|$)/, /^memory\/(?!README\.md$)/, /^index(\/|$)/, /^\.tmp(\/|$)/, /^usage(\/|$)/, /^local\.json$/];

export class UpdateError extends Error {}

const hostAllowed = (h) => h === 'github.com' || h === 'api.github.com' || h.endsWith('.githubusercontent.com');

/** {owner, repo} of the repository this hub was published from (package.json "repository"), or null. */
export function repoOf(root) {
  const url = readJson(path.join(root, 'package.json'), {}).repository?.url ?? '';
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(String(url));
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** An installed app keeps a state file (what the app copied, and its hashes). A git clone or a classic bundle does not. */
export const isInstalledApp = (root) => fs.existsSync(path.join(root, STATE_FILE));

/** GET with every hop checked: https only, GitHub hosts only, a size cap. Returns a Buffer. */
async function httpGet(url, { fetchImpl, max, accept = '*/*', timeout = 30000, t }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:' || !hostAllowed(u.hostname)) throw new UpdateError(t('update.error.badHost', { host: u.hostname }));
    const res = await fetchImpl(current, { redirect: 'manual', headers: { Accept: accept, 'User-Agent': 'ai-hub-updater' }, signal: AbortSignal.timeout(timeout) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new UpdateError(t('update.error.http', { status: res.status }));
      current = new URL(loc, current).href;
      continue;
    }
    if (!res.ok) throw new UpdateError(t('update.error.http', { status: res.status }));
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) throw new UpdateError(t('update.error.tooLarge'));
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > max) throw new UpdateError(t('update.error.tooLarge'));
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }
  throw new UpdateError(t('update.error.tooManyRedirects'));
}

/**
 * The latest published release, reduced to what we need and validated. The asset URLs must be GitHub release
 * downloads of THIS tag under the same owner as the hub's repository. The repository NAME may differ: a renamed
 * repository (GitHub redirects the old name) keeps the owner, and older copies still carry the old name.
 */
function releaseFrom(json, { owner, repo }, t) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease || !TAG_RE.test(String(json.tag_name))) throw new UpdateError(t('update.error.badRelease'));
  const tag = json.tag_name;
  let repoName = null;
  const asset = (name) => {
    const a = (Array.isArray(json.assets) ? json.assets : []).find((x) => x?.name === name);
    if (!a || typeof a.browser_download_url !== 'string') return null;
    let u;
    try {
      u = new URL(a.browser_download_url);
    } catch {
      return null;
    }
    const [o, r, releases, download, tg, file, ...rest] = u.pathname.split('/').filter(Boolean);
    const ok = u.protocol === 'https:' && u.hostname === 'github.com' && !u.search && !u.hash && rest.length === 0 && o?.toLowerCase() === owner.toLowerCase() && /^[\w.-]+$/.test(r ?? '') && releases === 'releases' && download === 'download' && tg === tag && file === name;
    if (!ok || (repoName && repoName !== r)) return null;
    repoName = r;
    return a.browser_download_url;
  };
  const archiveUrl = asset(ARCHIVE_NAME);
  const sumsUrl = asset(SUMS_NAME);
  return {
    tag,
    version: tag.slice(1),
    url: `https://github.com/${owner}/${repoName ?? repo}/releases/tag/${tag}`,
    archiveUrl,
    sumsUrl,
    notes: String(json.body ?? '').slice(0, 800),
  };
}

const cacheFile = (root) => path.join(root, '.tmp', 'update-check.json');

async function latestRelease(root, { fetchImpl, force, now, t }) {
  const repo = repoOf(root);
  if (!repo) throw new UpdateError(t('update.error.noRepo'));
  const cached = readJson(cacheFile(root), null);
  if (!force && cached?.release && now - Date.parse(cached.checkedAt) < CHECK_TTL_MS) return cached.release;
  const body = await httpGet(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, { fetchImpl, max: MAX_API, accept: 'application/vnd.github+json', t });
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    throw new UpdateError(t('update.error.badRelease'));
  }
  const release = releaseFrom(json, repo, t);
  safeDir(root, ['.tmp'], { create: true, t });
  writeJson(cacheFile(root), { checkedAt: new Date(now).toISOString(), release });
  return release;
}

/** Is there a newer release? Never throws: a network problem is reported in `error`. */
export async function checkForUpdate(root, { fetchImpl = fetch, force = false, now = Date.now() } = {}) {
  const t = tFor(root);
  const current = String(readJson(path.join(root, 'package.json'), {}).version ?? '0.0.0');
  const out = { current, latest: null, available: false, canApply: false, url: null, notes: '', error: null };
  try {
    const release = await latestRelease(root, { fetchImpl, force, now, t });
    out.latest = release.version;
    out.url = release.url;
    out.notes = release.notes;
    out.available = cmpVersion(release.version, current) > 0;
    out.canApply = out.available && Boolean(release.archiveUrl && release.sumsUrl) && isInstalledApp(root);
    out.release = release;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The hash listed for `name` in a SHA256SUMS.txt ("<64 hex>  name"), or null. */
export function sumFor(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2].replace(/^\.\//, '') === name) return m[1].toLowerCase();
  }
  return null;
}

function tarPath(t) {
  const tar = commandPath('tar');
  if (!tar) throw new UpdateError(t('update.error.noTar'));
  return tar;
}

/** Extracts the archive into `dir` after checking the list of entries; afterwards refuses anything but plain files. */
function extract(archive, dir, t) {
  const tar = tarPath(t);
  const list = spawnSync(tar, ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true });
  if (list.status !== 0) throw new UpdateError(t('update.error.badArchive'));
  for (const raw of list.stdout.split(/\r?\n/).filter(Boolean)) {
    const name = raw.replace(/^\.\//, '');
    if (name === '.' || name === '') continue;
    try {
      relParts(name.replace(/\/$/, ''), t);
    } catch {
      throw new UpdateError(t('update.error.unsafeEntry', { name: raw.slice(0, 80) }));
    }
  }
  const x = spawnSync(tar, ['-xzf', archive, '-C', dir], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, windowsHide: true });
  if (x.status !== 0) throw new UpdateError(t('update.error.badArchive'));
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink > 1)) throw new UpdateError(t('update.error.unsafeEntry', { name: ent.name }));
      if (st.isDirectory()) walk(full);
    }
  })(dir);
}

/** Reads the extracted manifest, checks every file against it and drops what an update may never touch. */
function verifiedManifest(dir, release, t) {
  const manifest = readManifest(dir);
  if (!manifest || manifest.version !== release.version) throw new UpdateError(t('update.error.badManifest'));
  const files = {};
  for (const [rel, sha] of Object.entries(manifest.files)) {
    let parts;
    try {
      parts = relParts(rel, t);
    } catch {
      throw new UpdateError(t('update.error.unsafeEntry', { name: rel.slice(0, 80) }));
    }
    const full = path.join(dir, ...parts);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      throw new UpdateError(t('update.error.badManifest'));
    }
    if (!st.isFile() || hashFile(full) !== sha) throw new UpdateError(t('update.error.badManifest'));
    if (NEVER.some((re) => re.test(parts.join('/')))) continue;
    files[parts.join('/')] = sha;
  }
  return { ...manifest, files };
}

/** An archive whose package.json asks for a newer Node.js than the one running cannot be applied by this app. */
function checkEngines(dir, t) {
  const need = /(\d+)/.exec(String(readJson(path.join(dir, 'package.json'), {}).engines?.node ?? ''))?.[1];
  const have = Number(process.versions.node.split('.')[0]);
  if (need && have < Number(need)) throw new UpdateError(t('update.error.needsNewerNode', { need, have }));
}

/**
 * Downloads, verifies and applies the latest release. Throws UpdateError (nothing changed) or returns
 * {from, to, copied, updated, kept, removed}. The running program keeps its old code until it is restarted.
 */
export async function applyUpdate(root, { fetchImpl = fetch, now = Date.now() } = {}) {
  const t = tFor(root);
  const info = await checkForUpdate(root, { fetchImpl, force: true, now });
  if (info.error) throw new UpdateError(info.error);
  if (!info.available) throw new UpdateError(t('update.error.noUpdate'));
  if (!info.canApply) throw new UpdateError(t('update.error.cannotApply'));
  const release = info.release;

  const unlock = acquireHubLock(root, 'app-update');
  const work = fs.mkdtempSync(path.join(safeDir(root, ['.tmp'], { create: true, t }), 'update-'));
  try {
    const sums = (await httpGet(release.sumsUrl, { fetchImpl, max: MAX_SUMS, t })).toString('utf8');
    const expected = sumFor(sums, ARCHIVE_NAME);
    if (!expected) throw new UpdateError(t('update.error.noChecksum'));
    const archive = await httpGet(release.archiveUrl, { fetchImpl, max: MAX_ARCHIVE, t });
    if (sha256(archive) !== expected) throw new UpdateError(t('update.error.badChecksum'));
    const file = path.join(work, 'update.tar.gz');
    fs.writeFileSync(file, archive);
    const dir = path.join(work, 'files');
    fs.mkdirSync(dir);
    extract(file, dir, t);
    const manifest = verifiedManifest(dir, release, t);
    checkEngines(dir, t);

    // plan first (writes nothing), copy the files that are about to change, then apply; restore on any failure
    const plan = syncManaged(dir, root, { manifest, dry: true });
    if (plan.skipped) throw new UpdateError(t('update.error.noUpdate'));
    const backup = path.join(work, 'backup');
    const touched = [...plan.updated, ...plan.removed, STATE_FILE];
    for (const rel of touched) {
      const from = path.join(root, ...rel.split('/'));
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true });
      fs.copyFileSync(from, path.join(backup, rel));
    }
    let result;
    try {
      result = syncManaged(dir, root, { manifest });
    } catch (e) {
      for (const rel of touched) {
        const saved = path.join(backup, rel);
        if (fs.existsSync(saved)) fs.copyFileSync(saved, path.join(root, ...rel.split('/')));
      }
      for (const rel of plan.copied) rmrf(path.join(root, ...rel.split('/')));
      throw new UpdateError(t('update.error.applyFailed', { message: e.message }));
    }
    return { from: info.current, to: release.version, copied: result.copied.length, updated: result.updated.length, kept: result.kept.length, removed: result.removed.length };
  } finally {
    rmrf(work);
    unlock();
  }
}

/**
 * The updater the app runs: remembers the last result, checks in the background (settings: updates.mode
 * off | notify | auto) and applies by itself only in "auto". Nothing happens at all in "off", except what you start by hand.
 */
export function createUpdater(root, { fetchImpl = fetch, firstCheckMs = 20_000, everyMs = 6 * 60 * 60 * 1000, onChange = () => {} } = {}) {
  let timers = [];
  let busy = false;
  const state = { phase: 'idle', info: null, result: null, error: null };
  const snapshot = () => {
    const { release: _release, ...info } = state.info ?? {};
    return { enabled: true, mode: readSettings(root)['updates.mode'], installed: isInstalledApp(root), phase: state.phase, info: state.info ? info : null, result: state.result, error: state.error };
  };
  const emit = () => onChange(snapshot());
  const wrap = async (phase, fn) => {
    if (busy) return snapshot();
    busy = true;
    state.phase = phase;
    state.error = null;
    emit();
    try {
      await fn();
    } catch (e) {
      state.error = e.message;
    } finally {
      busy = false;
      if (state.phase === 'checking' || state.phase === 'applying') state.phase = 'idle';
      emit();
    }
    return snapshot();
  };
  const api = {
    status: snapshot,
    check: (force = false) =>
      wrap('checking', async () => {
        state.info = await checkForUpdate(root, { fetchImpl, force });
        if (state.info.error) state.error = state.info.error;
      }),
    apply: () =>
      wrap('applying', async () => {
        state.result = await applyUpdate(root, { fetchImpl });
        state.phase = 'restart';
        state.info = { ...(state.info ?? {}), available: false, canApply: false, latest: state.result.to, current: state.result.to };
      }),
    /** Background checks (never in "off"). In "auto", an available update is applied right away. */
    start() {
      const tick = async () => {
        const mode = readSettings(root)['updates.mode'];
        if (mode === 'off' || state.phase === 'restart') return;
        await api.check(false);
        if (mode === 'auto' && state.info?.canApply) await api.apply();
      };
      timers = [setTimeout(tick, firstCheckMs), setInterval(tick, everyMs)];
      timers.forEach((x) => x.unref?.());
    },
    stop() {
      timers.forEach((x) => (clearTimeout(x), clearInterval(x)));
      timers = [];
    },
  };
  return api;
}
