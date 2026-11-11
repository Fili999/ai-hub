#!/bin/zsh -l
# Starts the ai-hub interface on Mac: double-click. It opens in the browser; close the Terminal window to stop it.
# "-l" loads the Homebrew PATH, so Node.js is found even when the file is opened with a double-click.
# If Node.js is missing (first time) it runs bootstrap.sh, which installs it after asking permission.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1 || [ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)" -lt 18 ]; then
  echo "Before starting, this computer needs to be prepared (Node.js)."
  exec ./bootstrap.sh
fi
exec node ui/server.mjs "$@"
