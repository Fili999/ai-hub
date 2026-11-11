#!/usr/bin/env bash
# Builds the downloadable bundles from the current commit (no dependencies besides git, zip and Node).
#   .github/scripts/package.sh [output-folder]      (default: dist)
# Output: ai-hub-windows.zip, ai-hub-macos.zip, SHA256SUMS.txt
# The file names carry no version on purpose: https://github.com/<owner>/<repo>/releases/latest/download/<file> always works.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
case "${1:-dist}" in /*) OUT="${1}" ;; *) OUT="$(pwd)/${1:-dist}" ;; esac
VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short HEAD)"
rm -rf "$OUT" && mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# What a user needs to run the hub. Tests, CI files and README images stay in the repository.
EXCLUDES=(':!tests' ':!.github' ':!docs/assets' ':!.gitattributes')

bundle() { # $1 = windows | macos
  local os="$1" dir="$WORK/$1/ai-hub"
  mkdir -p "$dir"
  git archive --format=tar HEAD -- . "${EXCLUDES[@]}" | tar -x -C "$dir"
  echo "$VERSION ($COMMIT)" > "$dir/VERSION.txt"
  if [ "$os" = windows ]; then
    rm -f "$dir"/*.command "$dir"/bootstrap.sh
    rm -rf "$dir/.githooks"
    # Windows batch files need CRLF line endings (with LF, "goto" can jump to the wrong label)
    for f in "$dir"/*.cmd; do sed -i 's/\r$//; s/$/\r/' "$f"; done
    cp .github/scripts/START-HERE-WINDOWS.txt "$dir/START-HERE.txt"
    sed -i 's/$/\r/' "$dir/START-HERE.txt"
  else
    rm -f "$dir"/*.cmd
    chmod +x "$dir/start.command" "$dir/bootstrap.sh"
    cp .github/scripts/START-HERE-MACOS.txt "$dir/START-HERE.txt"
  fi
  (cd "$WORK/$os" && zip -X -q -r "$OUT/ai-hub-$os.zip" ai-hub)
}
bundle windows
bundle macos
(cd "$OUT" && sha256sum ./*.zip | sed 's# \./# #' > SHA256SUMS.txt)
ls -la "$OUT"
