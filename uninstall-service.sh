#!/bin/bash
PLIST="$HOME/Library/LaunchAgents/com.claude-perch.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Uninstalled."
