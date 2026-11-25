#!/bin/bash
# Runs the player tests in headless Chromium: the desktop <audio> player, the Android player's page
# side (against a simulated native engine), the embed fallback, and the whole page in desktop mode.
# Needs Python 3, Node and Playwright (`npm install --no-save playwright`, then
# `npx playwright install chromium` if the browser isn't there yet).
set -e
cd "$(dirname "$0")"
python3 make_audio.py
python3 servers.py > servers.log 2>&1 &
servers=$!
trap 'kill $servers 2>/dev/null; rm -f a.wav b.wav servers.log' EXIT
until grep -q ready servers.log 2>/dev/null; do sleep 0.2; done
status=0
for test in element native hybrid app web; do
  echo "== $test"
  node "$test.test.cjs" || status=1
done
exit $status
