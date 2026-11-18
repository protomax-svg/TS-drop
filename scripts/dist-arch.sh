#!/usr/bin/env bash
# Build the Arch package (release/TSDROP-<version>.pacman), the one Omarchy wants.
#
# Arch ships Electron as a package, and Omarchy installs it. If the major
# matches what we build against, build on that copy instead of pulling 110 MB
# of identical runtime over the wire. No system Electron, no problem: this
# falls through to electron-builder's own download.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

major=$(node -p "require('./package.json').devDependencies.electron.match(/[0-9]+/)[0]")
dist="/usr/lib/electron$major"
args=()

if [[ -r $dist/version ]]; then
  version=$(tr -d 'v \n' < "$dist/version")
  args+=("-c.electronDist=$dist" "-c.electronVersion=$version")
  echo "building on the system electron $version ($dist)"
else
  echo "no system electron$major - electron-builder will fetch its own"
fi

npx vite build
npx electron-builder --linux pacman "${args[@]}"
