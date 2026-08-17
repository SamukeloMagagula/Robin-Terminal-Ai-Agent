#!/usr/bin/env bash
#
# Installs Robin from source on macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/SamukeloMagagula/Robin-Terminal-Ai-Agent/main/install.sh | bash
#
# Deliberately boring: clone, install exactly what the lockfile says, build,
# link. Everything it does is a command you could run yourself, and it prints
# each one, because piping a script from the internet into a shell is a lot of
# trust to ask for silently.

set -euo pipefail

REPO="${ROBIN_REPO:-https://github.com/SamukeloMagagula/Robin-Terminal-Ai-Agent.git}"
DIR="${ROBIN_DIR:-$HOME/.robin-src}"
MIN_NODE=18

say() { printf '\033[36m›\033[0m %s\n' "$*"; }
die() { printf '\033[31m✖\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required."
command -v node >/dev/null 2>&1 || die "Node $MIN_NODE or newer is required. See https://nodejs.org."
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$MIN_NODE" ] || die "Node $NODE_MAJOR is too old; Robin needs $MIN_NODE or newer."

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"

# ci, not install: dependencies are exact-pinned and the lockfile is the point.
#
# --ignore-scripts is not paranoia here, it is what makes this work at all. npm
# compiles any dependency carrying a binding.gyp, and better-sqlite3 carries
# one — so without this, installing needs a full C++ toolchain and fails
# outright on a machine that has not got one. It also ships prebuilt binaries
# for every platform Robin runs on, so there is nothing to compile and nothing
# is lost. Not running arbitrary install scripts is the smaller benefit.
say "Installing dependencies"
npm ci --ignore-scripts

say "Building"
npm run build

say "Linking the robin command"
if ! npm link 2>/dev/null; then
  printf '\033[33m!\033[0m npm link needs permissions it does not have.\n'
  printf '  Run it yourself with sudo, or use it in place:\n\n    node %s/dist/cli.js chat\n\n' "$DIR"
  exit 0
fi

printf '\n\033[32m✓\033[0m Installed. Next:\n\n'
printf '    robin doctor      # check the install\n'
printf '    robin login       # pick a provider\n'
printf '    robin chat        # start talking\n\n'
