# Bundled fonts

These ship with the app so `text()` works offline (spec feature 23). All are
SIL Open Font License 1.1, which permits bundling, redistribution and
modification.

| File | Family | Licence | Source |
| --- | --- | --- | --- |
| `NotoSans.ttf` | Noto Sans | OFL-1.1 | [google/fonts](https://github.com/google/fonts/tree/main/ofl/notosans) |
| `NotoSerif.ttf` | Noto Serif | OFL-1.1 | [google/fonts](https://github.com/google/fonts/tree/main/ofl/notoserif) |
| `Inter.ttf` | Inter | OFL-1.1 | [google/fonts](https://github.com/google/fonts/tree/main/ofl/inter) |
| `JetBrainsMono.ttf` | JetBrains Mono | OFL-1.1 | [google/fonts](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono) |

`Noto Sans` is the default family for a bare `text("…")`.

All four are variable fonts, so one file covers the whole weight range.

## `google-fonts-index.json`

A catalogue of ~50 additional families the Fonts dialog can download on demand.
Each entry records the family, its licence and its path within the
[`google/fonts`](https://github.com/google/fonts) repository, which serves TTF
over a CORS-enabled CDN. Downloads are cached in IndexedDB, so a family stays
available offline once fetched.

The Google Fonts *CSS* API is deliberately not used: it returns WOFF2, which
cannot be turned into glyph outlines without shipping a Brotli decompressor.

To regenerate the index, see the note in
[`packages/app/src/files/font-library.ts`](../../src/files/font-library.ts).
