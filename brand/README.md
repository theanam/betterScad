# BetterSCAD brand assets

> **Provisional.** These were authored from scratch because the Claude Design
> project (`BetterSCAD Brand + App.dc.html`) could not be reached — see
> [Brand provenance](#brand-provenance) below. Replace them with the imported
> design when access is available; everything downstream reads from
> [`tokens.css`](tokens.css), so a swap is a one-file change.

## The idea

The mark is the canonical CSG operation, drawn literally:

```scad
difference() {
  cube(10, center = true);
  translate([0, -5, -5]) sphere(4.5);
}
```

An isometric cube with a spherical cavity cut out of its near edge. It says
what the tool does in one shape, and it survives being scaled to 16px.

The palette follows from the same metaphor and carries through the whole
product:

| Role | Colour | Used for |
| --- | --- | --- |
| **Solid** | amber `#E8862A` | the mark's faces, the default viewport material, primary actions |
| **Cut** | cyan `#12718A` → `#5FE3F7` | the cavity, the `#` highlight modifier, informational UI |

## Files

| File | Use |
| --- | --- |
| `betterscad-mark.svg` | Square mark. The primary icon. |
| `betterscad-logo-light.svg` | Full lockup for light backgrounds. |
| `betterscad-logo-dark.svg` | Full lockup for dark backgrounds. |
| `favicon.svg` | Browser tab icon (same artwork as the mark). |
| `betterscad-icon-192.png`, `-512.png` | PWA icons (spec feature 17). |
| `betterscad-icon-maskable.svg`, `-maskable-512.png` | Android maskable icon; the mark is inset to 90% so a circular mask does not clip the cube. |
| `apple-touch-icon.png` | iOS home-screen icon, on an opaque ground. |
| `betterscad-social.png` | Open Graph / social preview. |
| `tokens.css` | The design tokens the app imports. Single source of truth — `packages/app/src/styles/index.css` imports this file directly rather than keeping a copy, so the two cannot drift. |

## Usage

- Keep clear space around the mark equal to **half the cube's width**.
- Do not recolour the cavity to match the faces — the amber/cyan contrast *is*
  the mark; without it the shape reads as a plain cube.
- On backgrounds between roughly `#3A4654` and `#8B9BAB`, neither lockup has
  enough contrast. Put the mark on a solid surface instead.
- The `--bs-syntax-*` tokens are separate from the brand ramps on purpose. The
  ramps are tuned for UI chrome, where a tint on a surface reads fine; code is
  dense body text, so every syntax colour clears WCAG AA (4.5:1) against the
  editor surface in its own theme. Re-check that if you change them.
- The wordmark uses Inter with a system fallback stack. It is set as live text
  rather than outlines so it stays editable; if you need guaranteed-identical
  rendering in a fixed context, convert to paths at that point.

## Regenerating the rasters

The PNGs are derived from the SVGs. After editing any SVG:

```sh
./brand/build-icons.sh
```

## Brand provenance

These assets are a from-scratch stand-in, not the imported Claude Design
project. To replace them:

1. Run `/design-login` once in an interactive Claude Code session.
2. Re-run the import against
   `claude.ai/design/p/8eeef3dd-eeaf-4d93-a206-690473e43252`.
3. Update `tokens.css` and the SVGs; nothing else in the app hardcodes brand
   colours.
