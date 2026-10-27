fn main() {
    // The exe's icon (embedded here) and the window icon (baked in by generate_context!)
    // come from icons/, but cargo doesn't know that: without this a changed icon only shows
    // up after an unrelated rebuild.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
