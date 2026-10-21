//! The version and the base come from the release (spec §2.2); the resources are built only by a Windows host, whose
//! SDK has rc.exe. A check from another OS (cargo check --target x86_64-pc-windows-msvc) skips them.
use std::env;
use std::fs;
use std::path::PathBuf;

const PRODUCTION_BASE: &str = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/";
const STAGING_BASE: &str = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/";

/// `X.Y.Z` or `X.Y.Z-prerelease`, as the desktop release names its versions: the numbers for the binary version.
fn numbers(version: &str) -> Option<[u16; 3]> {
    let (core, prerelease) = match version.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (version, None),
    };
    let identifier = |id: &str| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric());
    if prerelease.is_some_and(|p| !p.split('.').all(identifier)) {
        return None;
    }
    let parts: Vec<u16> = core.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    <[u16; 3]>::try_from(parts).ok()
}

/// A path inside an .rc string: backslashes doubled.
fn rc_path(path: PathBuf) -> String {
    path.display().to_string().replace('\\', "\\\\")
}

fn main() {
    for name in ["HARNESS_INSTALL_BASE", "HARNESS_INSTALL_VERSION"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-changed=harness-install.manifest");
    println!("cargo:rerun-if-changed=../desktop/windows/runner/resources/app_icon.ico");
    if let Ok(base) = env::var("HARNESS_INSTALL_BASE") {
        assert!(
            base == PRODUCTION_BASE || base == STAGING_BASE,
            "HARNESS_INSTALL_BASE must be {PRODUCTION_BASE} or {STAGING_BASE}, not {base}"
        );
    }
    let version = env::var("HARNESS_INSTALL_VERSION").unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").unwrap());
    let [major, minor, patch] =
        numbers(&version).unwrap_or_else(|| panic!("HARNESS_INSTALL_VERSION must be X.Y.Z or X.Y.Z-prerelease, not {version}"));
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") || !cfg!(windows) {
        return;
    }
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let manifest = rc_path(crate_dir.join("harness-install.manifest"));
    let icon = rc_path(crate_dir.join("..").join("desktop").join("windows").join("runner").join("resources").join("app_icon.ico"));
    // Numbers, not <winres.h> names: rc.exe then needs no include path. 24 is RT_MANIFEST, 1 the process manifest.
    let script = format!(
        r#"1 ICON "{icon}"
1 24 "{manifest}"
1 VERSIONINFO
FILEVERSION {major},{minor},{patch},0
PRODUCTVERSION {major},{minor},{patch},0
FILEFLAGSMASK 0x3F
FILEFLAGS 0x0
FILEOS 0x40004
FILETYPE 0x1
FILESUBTYPE 0x0
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "Autonomous"
      VALUE "FileDescription", "Install Harness"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "harness-install"
      VALUE "OriginalFilename", "harness-install.exe"
      VALUE "ProductName", "Harness"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("harness-install.rc");
    fs::write(&out, script).unwrap();
    embed_resource::compile(&out, embed_resource::NONE).manifest_required().unwrap();
}
