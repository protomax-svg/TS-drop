#!/usr/bin/env bash
# Render every app icon from build/logo.svg. Needs rsvg-convert (librsvg) and ImageMagick 7.
#
#   desktop   build/icon.png, build/icon.ico, public/icon.png, electron/icon.png
#   tray      electron/tray.png, electron/tray@2x.png
#   android   drawable/ic_launcher_mark.xml (the adaptive icon's foreground and monochrome layer,
#             a vector so it stays sharp), mipmap-*/ic_launcher.png (pre-Android 8),
#             drawable*/splash.png (pre-Android 12; 12+ shows the adaptive icon)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SRC=build/logo.svg
RES=android/app/src/main/res
TILE='#4f4e4c'   # the adaptive icon's background: the logo's grey box, made solid
SPLASH='#2c2f33' # colorPrimaryDark, the window colour the app opens on
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

png() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }

png "$SRC" 512 build/icon.png
cp build/icon.png public/icon.png
png "$SRC" 256 electron/icon.png
png "$SRC" 32 electron/tray.png
png "$SRC" 64 electron/tray@2x.png
for s in 16 24 32 48 64 128 256; do png "$SRC" $s "$tmp/ico-$s.png"; done
magick "$tmp"/ico-{16,24,32,48,64,128,256}.png build/icon.ico

for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  dir=$RES/mipmap-${d%%:*} s=${d##*:}
  png "$SRC" "$s" "$dir/ic_launcher.png"
done
node scripts/logo-vector.mjs "$SRC" > "$RES/drawable/ic_launcher_mark.xml"
cat > "$RES/mipmap-anydpi-v26/ic_launcher.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_mark"/>
    <monochrome android:drawable="@drawable/ic_launcher_mark"/>
</adaptive-icon>
XML
printf '<?xml version="1.0" encoding="utf-8"?><resources><color name="ic_launcher_background">%s</color></resources>\n' "$TILE" \
  > "$RES/values/ic_launcher_background.xml"

png "$SRC" 512 "$tmp/big.png"
for f in "$RES"/drawable*/splash.png; do
  read -r w h < <(magick identify -format '%w %h\n' "$f")
  s=$(( (w < h ? w : h) * 22 / 100 ))
  magick -size "${w}x$h" "xc:$SPLASH" \( "$tmp/big.png" -resize "${s}x$s" \) -gravity center -composite "$f"
done
echo "icons rendered from $SRC"
