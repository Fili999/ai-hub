# Packaged apps

`AI Hub.app` (Mac) and `AI-Hub-Setup.exe` (Windows). Each one carries its own Node.js, so people don't install anything:
download, open, and the hub starts in the browser. The zip/clone way of getting the hub keeps working as before.

## How it works

- The app contains the hub files (`hub/`) and a private Node. On first launch `scripts/app-launcher.mjs` copies the hub
  to **`~/AI Hub`** (Windows: `C:\Users\<you>\AI Hub`), a normal visible folder: skills, agents, memory, git sync all work
  as in a cloned hub. Override the place with the `AI_HUB_HOME` environment variable.
- Updating the app updates the program files in that folder but never overwrites a file you changed, never brings back a
  file you deleted, and never touches your own skills (`scripts/lib/appdata.mjs`, tested in `tests/app.test.mjs`).
- No terminal window: the hub stops by itself 5 minutes after the last browser page is closed (`--idle-minutes`).
  Opening the app again while it runs just opens the page again.
- **Mac**: a small stay-open applet (Dock icon, Quit really stops the hub) runs `Contents/Resources/start.sh`, which starts the
  bundled Node through a login shell so Homebrew tools are found. Log: `~/Library/Logs/AI Hub.log`.
- **Windows**: `AI Hub.exe` is a tiny windowless launcher (NSIS) that runs the bundled `node.exe` hidden. The installer is per-user
  (no administrator rights), adds Start menu + desktop shortcuts and an "Installed apps" entry. Uninstalling removes the
  program, not `AI Hub` in your user folder.

## Build

```
npm run package:mac            # on a Mac → dist/AI Hub.app + dist/AI-Hub-mac-<apple-silicon|intel>.zip   (--arch arm64|x64)
npm run package:win            # needs NSIS (brew install makensis | choco install nsis) → dist/AI-Hub-Setup.exe
```

Node is downloaded once into `.cache/` and checked against the official SHA-256 list (`AI_HUB_NODE_VERSION` changes the
version). Only tracked/new files from an allow-list ship (`packaging/build.mjs`): never tests, personal memory notes, or
this repository's `registry.json`/`teams.json`/`manifest.lock.json` (each person starts with empty ones).

Releases are built by `.github/workflows/release.yml`: push a tag `vX.Y.Z` equal to `version` in `package.json` and a **draft**
release appears with `AI-Hub-Setup.exe`, `AI-Hub-mac-apple-silicon.zip`, `AI-Hub-mac-intel.zip`. The names are fixed, so
`https://github.com/<owner>/<repo>/releases/latest/download/AI-Hub-Setup.exe` always works.

## Not signed: what people will see

The apps are **not signed** (that costs money every year), so the first launch shows a warning:

- **Mac** (ad-hoc signed, not notarised): open the zip, drag `AI Hub.app` to Applications, then right-click → **Open** → Open.
  On macOS 15 and later: try opening once, then System Settings → Privacy & Security → **Open Anyway**.
- **Windows** (SmartScreen): "Windows protected your PC" → **More info** → **Run anyway**.

To remove the warnings: Apple Developer ID + notarisation (99 USD/year) for the Mac, and a code-signing certificate or Azure
Trusted Signing for Windows.

## Not tested here

The Mac app was built and run on a Mac (start, second launch, Quit, idle shutdown). The Windows installer is compiled and
checked as a valid executable, and the workflow smoke-tests the bundled `node.exe` on a real Windows machine, but the installer
itself must be tried once by hand on Windows (install, shortcut, start, uninstall).
