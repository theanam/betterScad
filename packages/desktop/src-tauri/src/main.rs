// BetterSCAD desktop shell (spec feature 9).
//
// Deliberately thin: it hosts the same web UI and the same WASM engine the
// browser build uses. The only reason the shell exists at all is to give
// Firefox- and Safari-class file access on every platform — the fs and dialog
// plugins back the app's save/open paths without a download round-trip.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running BetterSCAD");
}
