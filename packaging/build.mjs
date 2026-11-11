#!/usr/bin/env node
// Builds the downloadable apps. Output goes to dist/. Needs Node >= 18 and internet (it downloads Node once, checks its
// SHA-256 against the official list, and keeps it in .cache/).
//   node packaging/build.mjs mac [--arch arm64|x64]   → dist/AI Hub.app and dist/AI-Hub-mac-<apple-silicon|intel>.zip   (run on a Mac)
//   node packaging/build.mjs win                      → dist/AI-Hub-Setup.exe                                            (needs NSIS "makensis")
//   node packaging/build.mjs stage <folder>           → only the hub files, as shipped (what the tests check)
// Nothing from the working folder that is personal gets in: only the program, the built-in skills, and empty settings.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MANIFEST_FILE, buildManifest } from '../scripts/lib/appdata.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_VERSION = process.env.AI_HUB_NODE_VERSION || '24.15.0';

// What ships inside the app. Everything else in the repository (tests, packaging, site, personal notes) stays out.
export const SHIPPED_DIRS = ['ui', 'scripts', 'i18n', 'templates', 'docs', 'workflows', 'skills/own', '.githooks'];
export const SHIPPED_FILES = ['hub.config.json', 'dependencies.json', 'providers.json', 'package.json', 'GUIDE.md', '.gitignore', '.gitattributes', 'memory/README.md'];
// Each person starts with their own empty copies, whatever this repository's copies contain.
export const BLANK_FILES = {
  'registry.json': { version: 1, overrides: {} },
  'teams.json': { version: 1, teams: [] },
  'manifest.lock.json': { version: 2, entries: [] },
};
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|node_modules)(\/|$)/;

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error || r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
};
const version = () => JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

/** Files of the repository to ship: tracked or new-but-not-ignored (what a commit would contain), inside the allow-list. */
export function shippedFiles(repo = REPO) {
  const roots = [...SHIPPED_DIRS, ...SHIPPED_FILES];
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots], { cwd: repo, encoding: 'utf8' });
  let files;
  if (git.status === 0) {
    files = git.stdout.split('\0').filter(Boolean);
  } else {
    files = [];
    const walk = (rel) => {
      const abs = path.join(repo, rel);
      if (!fs.existsSync(abs)) return;
      if (fs.statSync(abs).isDirectory()) for (const n of fs.readdirSync(abs)) walk(`${rel}/${n}`);
      else files.push(rel);
    };
    roots.forEach(walk);
  }
  return [...new Set(files)].filter((f) => fs.existsSync(path.join(repo, f)) && !JUNK.test(f)).sort();
}

/** Copies the hub files to `dest` (emptied first) and writes the manifest. Returns the manifest. */
export function stageHub(dest, repo = REPO) {
  // the destination is emptied: only ever do that to a folder that is new, empty or a previous staging of ours
  const target = path.resolve(dest);
  if (path.resolve(repo).startsWith(target + path.sep) || path.resolve(repo) === target) throw new Error(`Refusing to empty ${target}: it contains the repository.`);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0 && !fs.existsSync(path.join(target, MANIFEST_FILE))) throw new Error(`Refusing to empty ${target}: not empty and not a previous staging.`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const files = shippedFiles(repo);
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(path.join(repo, rel), path.join(dest, rel));
  }
  for (const [rel, data] of Object.entries(BLANK_FILES)) {
    fs.writeFileSync(path.join(dest, rel), JSON.stringify(data, null, 2) + '\n');
    files.push(rel);
  }
  const manifest = buildManifest(dest, files, JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version);
  fs.writeFileSync(path.join(dest, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// ---------------------------------------------------------------- Node runtime
async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

/** Downloads (once) the official Node archive and verifies it. Returns the local file. */
export async function fetchNode(archiveName, cacheDir = path.join(REPO, '.cache', 'node')) {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const file = path.join(cacheDir, `v${NODE_VERSION}-${archiveName}`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${archiveName}`));
  if (!line) throw new Error(`${archiveName} not in the official checksum list for Node ${NODE_VERSION}`);
  const expected = line.trim().split(/\s+/)[0];
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (!fs.existsSync(file) || sha(file) !== expected) {
    console.log(`Downloading ${archiveName}…`);
    await download(`${base}/${archiveName}`, file);
    if (sha(file) !== expected) {
      fs.rmSync(file, { force: true });
      throw new Error(`Checksum mismatch for ${archiveName}: refusing to use it.`);
    }
  }
  return file;
}

// ---------------------------------------------------------------- macOS
export async function buildMac({ arch = process.arch === 'arm64' ? 'arm64' : 'x64', out = path.join(REPO, 'dist') } = {}) {
  if (process.platform !== 'darwin') throw new Error('The Mac app is built on a Mac (it needs osacompile, codesign and ditto).');
  if (!['arm64', 'x64'].includes(arch)) throw new Error('--arch must be arm64 or x64');
  const label = arch === 'arm64' ? 'apple-silicon' : 'intel';
  const app = path.join(out, 'AI Hub.app');
  const res = path.join(app, 'Contents', 'Resources');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-build-'));
  try {
    fs.mkdirSync(out, { recursive: true });
    fs.rmSync(app, { recursive: true, force: true });

    // the shell: a stay-open applet (Dock icon, working Quit)
    run('osacompile', ['-s', '-o', app, path.join(REPO, 'packaging', 'mac', 'AIHub.applescript')]);
    fs.copyFileSync(path.join(REPO, 'packaging', 'mac', 'AppIcon.icns'), path.join(res, 'applet.icns'));
    const plist = path.join(app, 'Contents', 'Info.plist');
    // osacompile also writes Assets.car and CFBundleIconName=applet; macOS prefers those over applet.icns and would show the generic script icon
    fs.rmSync(path.join(res, 'Assets.car'), { force: true });
    try { run('plutil', ['-remove', 'CFBundleIconName', plist]); } catch { /* not present: fine */ }
    const set =(key, type, value) => run('plutil', ['-replace', key, `-${type}`, value, plist]);
    set('CFBundleName', 'string', 'AI Hub');
    set('CFBundleDisplayName', 'string', 'AI Hub');
    set('CFBundleIdentifier', 'string', 'app.ai-hub.desktop');
    set('CFBundleShortVersionString', 'string', version());
    set('CFBundleVersion', 'string', version());
    set('LSMinimumSystemVersion', 'string', '13.5'); // what Node 24 supports
    set('NSHumanReadableCopyright', 'string', 'AI Hub');

    // Node + the hub
    const archive = await fetchNode(`node-v${NODE_VERSION}-darwin-${arch}.tar.gz`);
    const inner = `node-v${NODE_VERSION}-darwin-${arch}`;
    run('tar', ['-xzf', archive, '-C', work, '--strip-components=1', `${inner}/bin/node`, `${inner}/LICENSE`]);
    fs.mkdirSync(path.join(res, 'node', 'bin'), { recursive: true });
    fs.copyFileSync(path.join(work, 'bin', 'node'), path.join(res, 'node', 'bin', 'node'));
    fs.copyFileSync(path.join(work, 'LICENSE'), path.join(res, 'node', 'LICENSE'));
    fs.chmodSync(path.join(res, 'node', 'bin', 'node'), 0o755);
    stageHub(path.join(res, 'hub'));
    fs.copyFileSync(path.join(REPO, 'packaging', 'mac', 'start.sh'), path.join(res, 'start.sh'));
    fs.chmodSync(path.join(res, 'start.sh'), 0o755);

    // Without a seal that matches the contents, macOS calls a downloaded app "damaged". An ad-hoc signature is free;
    // it does not remove the "unidentified developer" prompt (that needs an Apple Developer ID).
    run('codesign', ['--force', '--deep', '--sign', '-', app]);
    run('codesign', ['--verify', '--deep', '--strict', app]);

    const zip = path.join(out, `AI-Hub-mac-${label}.zip`);
    fs.rmSync(zip, { force: true });
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
    console.log(`\n✔ ${app}\n✔ ${zip}`);
    return { app, zip };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- Windows
function findMakensis() {
  const names = process.platform === 'win32' ? ['makensis.exe', 'makensis'] : ['makensis'];
  const candidates = [
    ...names,
    ...(process.platform === 'win32' ? [path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'NSIS', 'makensis.exe'), path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NSIS', 'makensis.exe')] : []),
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ['-VERSION'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  throw new Error('NSIS (makensis) not found. Install it: "brew install makensis" (Mac), "choco install nsis" (Windows) or "apt install nsis" (Linux).');
}

export async function buildWindows({ out = path.join(REPO, 'dist') } = {}) {
  const makensis = findMakensis();
  const v = version();
  const v4 = `${v.split('-')[0]}.0`;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4)) throw new Error(`package.json version "${v}" must look like 1.2.3`);
  const stage = path.join(out, 'win-stage');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-build-'));
  try {
    fs.mkdirSync(out, { recursive: true });
    fs.rmSync(stage, { recursive: true, force: true });
    const icon = path.join(REPO, 'packaging', 'windows', 'ai-hub.ico');

    // Node (only node.exe + its licence)
    const archive = await fetchNode(`node-v${NODE_VERSION}-win-x64.zip`);
    const inner = `node-v${NODE_VERSION}-win-x64`;
    const unzip = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;
    if (unzip) run('unzip', ['-q', '-o', '-j', archive, `${inner}/node.exe`, `${inner}/LICENSE`, '-d', work]);
    else run('tar', ['-xf', archive, '-C', work, '--strip-components=1', `${inner}/node.exe`, `${inner}/LICENSE`]);
    fs.mkdirSync(path.join(stage, 'node'), { recursive: true });
    fs.copyFileSync(path.join(work, 'node.exe'), path.join(stage, 'node', 'node.exe'));
    fs.copyFileSync(path.join(work, 'LICENSE'), path.join(stage, 'node', 'LICENSE'));
    stageHub(path.join(stage, 'hub'));
    fs.copyFileSync(icon, path.join(stage, 'ai-hub.ico'));

    run(makensis, ['-V2', `-DVERSION=${v4}`, `-DICON=${icon}`, `-DOUTFILE=${path.join(stage, 'AI Hub.exe')}`, path.join(REPO, 'packaging', 'windows', 'launcher.nsi')]);
    const setup = path.join(out, 'AI-Hub-Setup.exe');
    run(makensis, ['-V2', `-DVERSION=${v}`, `-DVERSION4=${v4}`, `-DSTAGE=${stage}`, `-DICON=${icon}`, `-DOUTFILE=${setup}`, path.join(REPO, 'packaging', 'windows', 'installer.nsi')]);
    console.log(`\n✔ ${setup}`);
    return { setup, stage };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- command line
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, ...rest] = process.argv.slice(2);
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    if (target === 'mac') await buildMac({ arch: opt('arch') });
    else if (target === 'win') await buildWindows();
    else if (target === 'stage' && rest[0]) console.log(`${Object.keys(stageHub(path.resolve(rest[0])).files).length} files staged`);
    else {
      console.error('Usage: node packaging/build.mjs mac [--arch arm64|x64] | win | stage <folder>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(1);
  }
}
