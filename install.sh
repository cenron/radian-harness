#!/bin/sh
# Install Radian into a workspace: thin wrapper around the canonical installer
# (src/workspace/main.ts). The target is the current directory unless
# --workspace <dir> is given; it is shown, previewed, and only changed after
# you confirm the exact plan (or pass --apply <plan-hash> non-interactively).
# Nothing is installed globally.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if ! command -v node >/dev/null 2>&1; then
  echo "radian install: Node.js was not found on PATH; install Node 22.18 or later yourself." >&2
  exit 2
fi
exec node "$here/src/workspace/main.ts" install --local "$here" --workspace-default "$(pwd -P)" "$@"
