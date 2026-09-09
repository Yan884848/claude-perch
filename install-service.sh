#!/bin/bash
# Install Claude Perch as a launchd agent (starts at login, restarts if it dies).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.claude-perch.plist"

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__DIR__|$DIR|g" -e "s|__HOME__|$HOME|g" "$DIR/com.claude-perch.plist" > "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Installed. Logs: $DIR/out.log"
sleep 2
[ -f "$DIR/.token" ] && echo "Token: $(cat "$DIR/.token")"
