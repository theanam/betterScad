#!/usr/bin/env sh
# Regenerates every raster brand asset from the SVG sources.
# Requires rsvg-convert (librsvg): `brew install librsvg`.
set -eu
cd "$(dirname "$0")"

command -v rsvg-convert >/dev/null 2>&1 || {
  echo "rsvg-convert not found. Install librsvg (brew install librsvg)." >&2
  exit 1
}

cp betterscad-mark.svg favicon.svg

rsvg-convert -w 192 -h 192 betterscad-mark.svg -o betterscad-icon-192.png
rsvg-convert -w 512 -h 512 betterscad-mark.svg -o betterscad-icon-512.png
rsvg-convert -w 512 -h 512 betterscad-icon-maskable.svg -o betterscad-icon-maskable-512.png
rsvg-convert -w 180 -h 180 -b '#111A24' betterscad-mark.svg -o apple-touch-icon.png
rsvg-convert -w 1280 -h 640 -b '#0d1117' betterscad-logo-dark.svg -o betterscad-social.png

echo "Brand rasters regenerated."
