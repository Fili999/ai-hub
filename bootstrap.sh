#!/usr/bin/env bash
# Start on macOS / Linux: makes sure Node.js (>= 18) is there, then runs "node scripts/setup.mjs", which installs
# the rest by reading dependencies.json. Usage:   ./bootstrap.sh [setup options, e.g. --yes]
set -u
cd "$(dirname "$0")" || exit 1

need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
  [ "${major:-0}" -ge 18 ] && need_node=0
fi

if [ "$need_node" -eq 1 ]; then
  echo "Node.js 18 or newer not found."
  if command -v brew >/dev/null 2>&1; then
    printf "Install it with Homebrew (brew install node)? [y/N] "
    read -r ans
    case "$ans" in
      y|Y|yes|YES) brew install node || exit 1 ;;
      *) echo "Install Node.js from https://nodejs.org/en/download and run ./bootstrap.sh again"; exit 1 ;;
    esac
  else
    echo "Install Node.js from https://nodejs.org/en/download (on a Mac, Homebrew first is easier: https://brew.sh)"
    echo "then run ./bootstrap.sh again"
    exit 1
  fi
fi

exec node scripts/setup.mjs "$@"
