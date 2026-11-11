#!/bin/zsh -l
# Starts the AI Hub in the background and prints its process id (AI Hub.app reads it to know when the hub has stopped).
# "-l" loads the login profile, so Homebrew and other tools are found even though the app was opened from Finder.
RES="${0:A:h}" # .../AI Hub.app/Contents/Resources
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
LOG="$HOME/Library/Logs/AI Hub.log"
mkdir -p "$HOME/Library/Logs"
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 1000000 ]; then : > "$LOG"; fi
cd "$HOME" || exit 1
nohup "$RES/node/bin/node" "$RES/hub/scripts/app-launcher.mjs" "$@" >>"$LOG" 2>&1 </dev/null &
echo $!
