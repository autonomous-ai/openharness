fn main() {
    // Each of the app's commands needs its permission (`allow-view`, `allow-act`), which capabilities/default.json
    // grants the window: nothing else is callable from the webview.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["view", "act"])),
    )
    .expect("tauri-build");
}
