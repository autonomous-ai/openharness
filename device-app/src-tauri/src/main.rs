fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Harness Device could not start");
}
