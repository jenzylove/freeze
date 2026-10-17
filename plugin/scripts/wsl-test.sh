#!/usr/bin/env bash
# Run the plugin's checks with the reference toolchain (Node 24.21.0, pnpm 11.11.0) inside WSL.
# Copies the plugin to a WSL-native folder because pnpm on /mnt/c is slow and flaky.
set -e
source ~/.nvm/nvm.sh
nvm use 24.21.0 >/dev/null
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK=~/freeze-plugin
mkdir -p "$WORK"
rsync -a --delete --exclude node_modules --exclude dist "$SRC/" "$WORK/"
cd "$WORK"
pnpm install --frozen-lockfile >/dev/null
echo "== unit tests"
node --test "test/*.test.ts"
echo "== starter checks (typecheck, two identical builds, conformance)"
pnpm --silent test
mkdir -p "$SRC/dist"
cp dist/plugin.mjs "$SRC/dist/plugin.mjs"
sha256sum dist/plugin.mjs
