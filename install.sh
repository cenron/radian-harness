#!/bin/sh
# Binds Radian into a workspace. Arguments pass through to the installer CLI,
# for example: ./install.sh --workspace ~/my-workspace
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Radian needs Node.js 22.18 or newer on PATH; install it and run this script again." >&2
  exit 2
fi

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/src/install/cli.ts" install "$@"
