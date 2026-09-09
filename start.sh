#!/bin/bash
# Start Claude Perch. Generates an access token on first run.
set -e
cd "$(dirname "$0")"

if [ ! -f .token ]; then
  head -c 18 /dev/urandom | base64 | tr -d '/+=' > .token
  chmod 600 .token
fi
export PERCH_TOKEN="$(cat .token)"
export PORT="${PORT:-7788}"

# Screen mode needs two small Swift helpers. They are built here rather than
# committed because a TCC grant is tied to a binary's signature: shipping a
# prebuilt one would hand you a binary macOS has never seen you approve.
build_helper() {
  local name="$1"
  if [ ! -x "bin/$name" ] || [ "input/$name.swift" -nt "bin/$name" ]; then
    if command -v swiftc >/dev/null 2>&1; then
      mkdir -p bin
      echo "  building $name…"
      swiftc -O -o "bin/$name" "input/$name.swift" || echo "  ! $name failed to build; screen mode will be unavailable"
    else
      echo "  ! swiftc not found (install Xcode Command Line Tools); screen mode will be unavailable"
    fi
  fi
}
build_helper perch-capture
build_helper perch-input

TS_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
if command -v tailscale >/dev/null 2>&1; then
  IP=$(tailscale ip -4 2>/dev/null | head -1)
elif [ -x "$TS_BIN" ]; then
  IP=$("$TS_BIN" ip -4 2>/dev/null | head -1)
fi
[ -z "$IP" ] && IP=$(ipconfig getifaddr en0 2>/dev/null)
[ -z "$IP" ] && IP="<your-ip>"

echo ""
echo "  Open this on your phone (then Add to Home Screen):"
echo "  http://$IP:$PORT/?token=$PERCH_TOKEN"
echo ""

exec node server.js
