#!/bin/sh
# Makes the site's icons and the house's badge from the house's logo, src/assets/house/mise-en-place.png
# (1024 px square: Mise en Place's picture, a red map pin wearing a chef's hat, on cream). macOS only: it
# uses sips. Run it from anywhere after the logo changes, look at each file, and commit them all.
# tests/icons.test.ts checks their sizes.
#
# The pin and hat sit within x 290-735, y 150-890 of the logo, centred on (512, 520).
#   - The tab icon is cut to 800 px around them first, so at 32 px they fill it with a pixel to spare.
#   - The badge is cut to 860 px, so a circle drawn in it keeps the whole hat and the pin's point.
#   - The larger icons keep the logo's own margin, which a phone's home screen expects.
set -eu

cd "$(dirname "$0")/.."
logo=src/assets/house/mise-en-place.png
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --cropOffset takes the top, then the left.
sips --cropToHeightWidth 800 800 --cropOffset 120 112 "$logo" --out "$work/tab.png" >/dev/null
sips --cropToHeightWidth 860 860 --cropOffset 90 82 "$logo" --out "$work/badge.png" >/dev/null

sips --resampleHeightWidth 32 32 "$work/tab.png" --out public/favicon-32.png >/dev/null
sips --resampleHeightWidth 180 180 "$logo" --out public/apple-touch-icon.png >/dev/null
sips --resampleHeightWidth 192 192 "$logo" --out public/icon-192.png >/dev/null
sips --resampleHeightWidth 512 512 "$logo" --out public/icon-512.png >/dev/null
sips --resampleHeightWidth 64 64 "$work/badge.png" --out src/assets/house/house-64.png >/dev/null
sips --resampleHeightWidth 96 96 "$work/badge.png" --out src/assets/house/house-96.png >/dev/null
