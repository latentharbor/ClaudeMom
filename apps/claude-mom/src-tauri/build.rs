fn main() {
    println!("cargo:rerun-if-env-changed=CLAUDE_MOM_LAB_BUILD");
    tauri_build::build()
}
