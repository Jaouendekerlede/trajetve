fn main() {
  // Bibliothèques natives alignées sur des pages de 16 Ko : requis par les
  // téléphones Android récents (Android 15+), vérifié même en debug.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
    println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
  }
  tauri_build::build()
}
