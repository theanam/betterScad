# BetterSCAD brand assets

These follow the Claude Design project *BetterSCAD Brand + App*, supplied as
reference renders. Everything downstream reads from [`tokens.css`](tokens.css),
so a future revision is a one-file change.

## The idea

The mark is the canonical CSG operation, drawn literally:

```scad
difference() {
  cube(10, center = true);
  cylinder(h = 20, r = 2, center = true);
}
```

An isometric cube with a hole bored through its top face. It says what the tool
does in one shape, and it survives being scaled to 16px — which is why the hole
is drawn as a true circle rather than the ellipse the projection calls for.

## Palette

Five colours. The greys are mixed warm, from the same family as the amber, so
nothing in the chrome fights the model in the middle of it.

| Role | Colour | Used for |
| --- | --- | --- |
| **Amber** | `#EFA84E` | the mark's top face, the default viewport material, and — reserved — state and action: primary button, focus ring, active tab, dirty dot, `EXT` badge |
| **Terracotta** | `#C96B3C` | the amber ramp's deep end; the mark's shaded faces |
| **Off-white** | `#EDE8E2` | text on dark, the sunken surface on light |
| **Warm dark grey** | `#2A2523` → `#3F3833` | borders and raised surfaces on dark |
| **Near-black** | `#0E0C0B` | the page and the viewport ground |

Amber is the only accent. Spending it on decoration is what makes it stop
meaning anything, so a second emphasis colour is a bug, not an addition.

**Functional colours sit outside the palette** on purpose — the axis red/green/
blue, the `cut` cyan used by measurement and the `#` highlight modifier. They
have to be told apart from the model, and the model is amber.

The tagline is **CODE IT. SEE IT. PRINT IT.**, set in the mono stack with wide
tracking.

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
- Do not fill the hole, or lighten it toward the faces. The hole is the whole
  idea: without it the mark is a cube, which is every other CAD logo.
- The wordmark is one weight and one colour. An amber `SCAD` would spend the
  accent on decoration.
- On mid-tone backgrounds between roughly `#3F3833` and `#948980`, neither
  lockup has enough contrast. Put the mark on a solid surface instead.
- Amber is a light colour: text and icons on an amber fill take
  `--bs-brand-contrast` (near-black), never white.
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

The design source is the Claude Design project *BetterSCAD Brand + App*
(`claude.ai/design/p/8eeef3dd-eeaf-4d93-a206-690473e43252`). The SVGs here are
rebuilt to match its reference renders rather than exported from it, so they
stay small, themeable and legible at 16px.
