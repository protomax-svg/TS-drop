#!/usr/bin/env bash
# Teach Hyprland about TSDROP: float the popup in the corner, and give it a key.
#
#   ./omarchy/install.sh            install (or update) the rules
#   ./omarchy/install.sh --remove   take them out again
#
# Touches two files, both yours, both backed up first:
#   ~/.config/hypr/tsdrop.lua     the rules themselves (a copy of omarchy/tsdrop.lua)
#   ~/.config/hypr/hyprland.lua   one require() line pointing at them
set -euo pipefail

HYPR="$HOME/.config/hypr"
RULES="$HYPR/tsdrop.lua"
MAIN="$HYPR/hyprland.lua"
LINE='require("hypr.tsdrop")'
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tsdrop.lua"

command -v hyprctl >/dev/null || { echo "hyprctl not found - this is for Hyprland (Omarchy)."; exit 1; }
[[ -f $MAIN ]] || { echo "No $MAIN - is this Omarchy?"; exit 1; }

backup() { cp "$1" "$1.bak.$(date +%s)"; }

if [[ ${1:-} == --remove ]]; then
  if grep -qF "$LINE" "$MAIN"; then
    backup "$MAIN"
    grep -vF "$LINE" "$MAIN" | grep -v '^-- TSDROP window rules and keybinding$' > "$MAIN.tmp"
    mv "$MAIN.tmp" "$MAIN"
  fi
  rm -f "$RULES"
  hyprctl reload >/dev/null
  echo "removed. TSDROP tiles like any other window again."
  exit 0
fi

[[ -f $RULES ]] && backup "$RULES"
cp "$SRC" "$RULES"

if ! grep -qF "$LINE" "$MAIN"; then
  backup "$MAIN"
  printf '\n-- TSDROP window rules and keybinding\n%s\n' "$LINE" >> "$MAIN"
fi

hyprctl reload >/dev/null
errors=$(hyprctl configerrors)
if [[ $errors != *"no errors"* && -n $errors ]]; then
  echo "Hyprland reported:"
  echo "$errors"
  exit 1
fi

echo "installed:"
echo "  $RULES          floats TSDROP bottom-right, at the size it remembers"
echo "  Super+Insert    shows and hides it (edit $RULES to change)"
