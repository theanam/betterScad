# Desktop packaging

**Status: scaffolded, not yet built.** The configuration below is complete and
correct as far as it can be verified without a Rust toolchain, but no desktop
binary has been produced or run. Treat it as a starting point, not a shipped
feature.

## Approach

Tauri rather than Electron. The app is already a static site with its heavy
lifting in WebAssembly, so the shell needs to do almost nothing — and Tauri's
shell is a few megabytes against Electron's ~120, using the platform's own
webview.

The same `packages/app/dist` bundle is used for web and desktop. There is no
desktop-specific UI code.

```
packages/desktop/
├── package.json
└── src-tauri/
    ├── tauri.conf.json     window, bundle targets, CSP
    ├── Cargo.toml
    ├── build.rs
    ├── icons/              generated from brand/
    └── src/main.rs         the shell — plugin registration and nothing else
```

## Why a shell at all

The web build already does everything except one thing: on Firefox and Safari
there is no File System Access API, so Save falls back to a download. The
desktop shell exists to give real save-in-place on every platform, via Tauri's
`fs` and `dialog` plugins.

That is the whole justification. If a browser is acceptable, use the browser
build — it is the same app.

## Building

Requires the [Rust toolchain](https://rustup.rs) and your platform's Tauri
[prerequisites](https://tauri.app/start/prerequisites/).

`packages/desktop` is deliberately **not** an npm workspace: the Tauri CLI is a
large platform binary, and nobody building only the web app should pay to
download it. Install it separately:

```sh
npm install                          # root: engine, app, cli
npm run build -w @betterscad/app     # the web bundle the shell hosts

cd packages/desktop
npm install                          # the Tauri CLI
npm run build                        # installers land in src-tauri/target/release/bundle
```

Development, with hot reload against the Vite dev server:

```sh
cd packages/desktop && npm run dev
```

## Notes

**CSP.** `script-src` includes `'wasm-unsafe-eval'`, without which the Manifold
kernel cannot instantiate. `connect-src` allows
`raw.githubusercontent.com` for on-demand Google Fonts downloads; drop it if you
want a strictly offline build, and the bundled fonts still work.

**Icons.** `src-tauri/icons/` holds PNGs generated from `brand/`. Platform icon
formats (`.icns`, `.ico`) are produced by `npm run icons -w @betterscad/desktop`,
which shells out to `tauri icon` — they are not checked in.

**File associations.** Not configured yet. Registering `.scad` and `.bscad` means
adding a `fileAssociations` block to `tauri.conf.json` and handling the launch
argument in `main.rs`.

## Remaining work

- Build and test on macOS, Windows and Linux.
- Wire the app's save/open paths to the Tauri `fs` plugin when running in the
  shell, so the File System Access fallback is never hit there. Today the shell
  would use the download fallback, which works but is not the point.
- File associations and a "recent files" list.
- Code signing and notarisation for distribution.
