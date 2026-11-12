#!/usr/bin/env node
// Entry point of the packaged apps (AI Hub.app on Mac, AI Hub.exe on Windows). The app carries its own Node, so nobody
// needs to install it. What this does, in order:
//   1. finds the user's hub folder ("AI Hub" in the home folder, or AI_HUB_HOME) and copies the files shipped with the
//      app there (first run, or after an update) without overwriting anything the user changed;
//   2. if a hub is already running, just opens it in the browser;
//   3. otherwise starts the interface from that folder and opens the browser. With no terminal window to close, the
//      hub stops by itself a few minutes after the last browser page is closed.
// Run from a source checkout (no app-manifest.json) it serves that checkout itself, which is handy for trying it out.
//   node scripts/app-launcher.mjs [--no-open] [--stop] [--idle-minutes 5]
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clearRuntime, dataDir, isAlive, readManifest, readRuntime, syncManaged, writeRuntime } from './lib/appdata.mjs';
import { tFor } from './lib/i18n.mjs';

const SHIPPED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // the hub files inside the app
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const packaged = readManifest(SHIPPED) !== null;
const home = dataDir();
const root = packaged ? home : SHIPPED; // the hub this process serves
const t = tFor(root);

/** A native message box: the app has no terminal, so errors must be shown some other way. The text never goes through a shell. */
function showError(message) {
  const title = t('app.error.title');
  try {
    if (process.platform === 'darwin') {
      spawnSync('osascript', ['-e', 'on run argv', '-e', 'display alert (item 1 of argv) message (item 2 of argv) as critical', '-e', 'end run', title, message], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      const script = 'Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:AI_HUB_MSG, $env:AI_HUB_TITLE, "OK", "Error")';
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { stdio: 'ignore', windowsHide: true, env: { ...process.env, AI_HUB_MSG: message, AI_HUB_TITLE: title } });
    }
  } catch {
    /* nothing else we can do */
  }
  console.error(`${title}: ${message}`);
}

function openBrowser(url) {
  // The URL is built by this program (127.0.0.1 + numeric port): no outside input.
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the address stays in the log */
  }
}

/** Is the hub described by the runtime file really answering? */
async function runningHub() {
  const rt = readRuntime(root);
  if (!rt || !isAlive(rt.pid) || typeof rt.url !== 'string') return null;
  try {
    const r = await fetch(new URL('api/health', rt.url), { signal: AbortSignal.timeout(2500) });
    const body = await r.json();
    return body?.name === 'ai-hub-ui' ? rt : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- --stop (used by the Windows installer before updating)
if (flag('stop')) {
  const rt = readRuntime(root);
  if (rt && isAlive(rt.pid)) {
    try {
      process.kill(rt.pid);
    } catch {
      /* already gone */
    }
  }
  clearRuntime(root, rt?.pid);
  process.exit(0);
}

try {
  // 1. the user's copy of the hub
  if (packaged) syncManaged(SHIPPED, home);

  // 2. already running: open it and leave
  const existing = await runningHub();
  if (existing) {
    if (!flag('no-open')) openBrowser(existing.url);
    process.exit(0);
  }

  // 3. start it
  process.env.AI_HUB_ROOT = root; // read by the hub scripts when they load: set it before importing them
  const { startServer } = await import(pathToFileURL(path.join(root, 'ui', 'server.mjs')).href);
  const minutes = Number(option('idle-minutes') ?? process.env.AI_HUB_IDLE_MINUTES ?? 5);
  const idleExitMs = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0;

  let app;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearRuntime(root);
    try {
      await app?.close();
    } finally {
      process.exit(0);
    }
  };
  // the updater lives in the user's copy of the hub, so an in-app update also updates the updater itself
  const { createUpdater } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'updater.mjs')).href);
  app = await startServer({ root, port: 4173, open: !flag('no-open'), quiet: true, idleExitMs, onIdle: stop, updater: createUpdater(root) });
  writeRuntime(root, { pid: process.pid, url: app.url });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => clearRuntime(root));
  console.log(`AI Hub — ${app.url}`);
  console.log(`  ${root}`);
} catch (e) {
  showError(t('app.error.start', { message: e?.message ?? String(e), folder: home }));
  process.exit(1);
}
