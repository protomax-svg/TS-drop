// Turn the mark in build/logo.svg into an Android VectorDrawable for the adaptive launcher
// icon, so it stays sharp at any launcher size (a PNG layer gets stretched to 108dp and blurs).
// Usage: node scripts/logo-vector.mjs build/logo.svg > res/drawable/ic_launcher_mark.xml
//
// Handles what logo.svg uses: absolute M L H V A commands, one translate() on the mark group.
import { readFileSync } from 'node:fs'

const svg = readFileSync(process.argv[2], 'utf8')
const group = /<g id="mark"([^>]*)>([\s\S]*?)<\/g>/.exec(svg)
if (!group) throw new Error('no <g id="mark"> in ' + process.argv[2])
const attr = (s, n) => (new RegExp(`${n}="([^"]*)"`).exec(s) || [])[1]
const [tx, ty] = (/translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(attr(group[1], 'transform') || '') || [0, 0, 0]).slice(1).map(Number)
const width = Number(attr(group[1], 'stroke-width'))
const paths = [...group[2].matchAll(/\sd="([^"]+)"/g)].map(m => m[1])

// 108dp canvas; the mark's bounding box (stroke included) is centred and scaled so its
// diagonal fits the 66dp safe zone, which every launcher mask shape leaves visible.
const SAFE = 66
const pts = []
const walk = (d, fn) => {
  const out = []
  let x = 0; let y = 0
  for (const [, c, args] of d.matchAll(/([MLHVA])([^MLHVA]*)/g)) {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (c === 'H') { x = n[0]; out.push(['L', fn(x, y)]) } else if (c === 'V') { y = n[0]; out.push(['L', fn(x, y)]) } else if (c === 'A') {
      x = n[5]; y = n[6]; out.push(['A', n.slice(0, 5), fn(x, y)])
    } else { x = n[0]; y = n[1]; out.push([c, fn(x, y)]) }
  }
  return out
}
for (const d of paths) walk(d, (x, y) => pts.push([x + tx, y + ty]))
const pad = width / 2
const xs = pts.map(p => p[0]); const ys = pts.map(p => p[1])
const box = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]
const k = SAFE / Math.hypot(box[2] - box[0], box[3] - box[1])
const cx = (box[0] + box[2]) / 2; const cy = (box[1] + box[3]) / 2
const f = v => +v.toFixed(2)
const map = (x, y) => [f(54 + (x + tx - cx) * k), f(54 + (y + ty - cy) * k)]

const data = paths.map(d => walk(d, map).map(([c, a, b]) => c === 'A'
  ? `A${f(a[0] * k)},${f(a[1] * k)} ${a[2]} ${a[3]},${a[4]} ${b[0]},${b[1]}`
  : `${c}${a[0]},${a[1]}`).join(' ')).join(' ')

process.stdout.write(`<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from build/logo.svg by scripts/make-icons.sh. Edit the SVG, not this. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
    <path android:pathData="${data}"
        android:fillColor="#00000000" android:strokeColor="#f4f2ef" android:strokeWidth="${f(width * k)}"
        android:strokeLineCap="square" android:strokeLineJoin="miter" />
</vector>
`)
