//! What harness-install decides, with no Windows call in it, so `cargo test` checks it on every OS
//! (docs/superpowers/specs/2026-10-19-windows-installer-design.md §1.1). Each rule is install.ps1's `-App` mode, the
//! one-command install C ships: the same manifest, the same entry choice, the same checks and the same messages.
//! tests/entry-vectors.json holds both installers to one answer for the choice.

use std::path::{Path, PathBuf};

use serde_json::Value;

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_CANCELLED: i32 = 2;

/// install.ps1's `$HarnessManifestBase`, and its staging copy's (upload-install-ps1.sh).
pub const PRODUCTION_BASE: &str = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/";
pub const STAGING_BASE: &str = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/";
/// The build's base. The release sets `HARNESS_INSTALL_BASE`; build.rs refuses anything but the two above.
pub const BASE: &str = match option_env!("HARNESS_INSTALL_BASE") {
    Some(base) => base,
    None => PRODUCTION_BASE,
};
/// The desktop version this copy was released with (the version resource says the same).
pub const VERSION: &str = match option_env!("HARNESS_INSTALL_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
/// A manifest to use instead of the build's, for tests: the name install.ps1 already reads.
pub const MANIFEST_ENV: &str = "HARNESS_INSTALL_MANIFEST";
pub const X64_KEY: &str = "desktop-windows-x64";
pub const ARM64_KEY: &str = "desktop-windows-arm64";
/// ConPTY, which the terminal host needs, arrived in Windows 10 1809 (install.ps1's Test-HarnessHost).
pub const MIN_BUILD: u32 = 17763;
/// A manifest is a few kilobytes; anything near this is not one.
pub const MANIFEST_LIMIT: u64 = 1 << 20;
/// Tries for a network read, as install.ps1's Invoke-HarnessRetry makes: a drop in the middle of a download is
/// common on Wi-Fi.
pub const ATTEMPTS: u32 = 3;
pub const USAGE: &str = "usage: harness-install [--quiet]";

/// Where the zips are published: the bucket, and the CDN in front of it at the same paths. The website's
/// `resolveDesktopDownload` accepts the same two.
const ORIGINS: [&str; 2] = [
    "https://storage.googleapis.com/s3-autonomous-upgrade-3/",
    "https://cdn.autonomous.ai/",
];

#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    Window,
    Quiet,
}

pub fn parse(args: &[String]) -> Result<Mode, String> {
    match args {
        [] => Ok(Mode::Window),
        [flag] if flag == "--quiet" => Ok(Mode::Quiet),
        _ => Err(USAGE.to_owned()),
    }
}

/// A staging build reads the staging manifest and may follow it into the staging folders.
pub fn is_staging(base: &str) -> bool {
    base == STAGING_BASE
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Check,
    Manifest,
    Download,
    Unpack,
    Install,
}

impl Step {
    /// install.ps1's `$step` names: its failure line and this program's say the same.
    pub fn name(self) -> &'static str {
        match self {
            Step::Check => "Checking this computer",
            Step::Manifest => "Reading the release manifest",
            Step::Download => "Downloading Harness",
            Step::Unpack => "Unpacking Harness",
            Step::Install => "Installing Harness",
        }
    }

    /// The window's status line while the step runs.
    pub fn status(self) -> &'static str {
        match self {
            Step::Check => "Checking this computer…",
            Step::Manifest => "Checking for the latest Harness…",
            Step::Download => "Downloading Harness…",
            Step::Unpack => "Unpacking Harness…",
            Step::Install => "Installing Harness…",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Machine {
    X64,
    Arm64,
}

impl Machine {
    /// `IsWow64Process2`'s native machine. This program is x64, so on an Arm PC it runs emulated and only the
    /// native answer names the app the PC should get.
    pub fn from_native(image: u16) -> Machine {
        const IMAGE_FILE_MACHINE_ARM64: u16 = 0xAA64;
        if image == IMAGE_FILE_MACHINE_ARM64 { Machine::Arm64 } else { Machine::X64 }
    }

    pub fn platform(self) -> &'static str {
        match self {
            Machine::X64 => "win32-x64",
            Machine::Arm64 => "win32-arm64",
        }
    }
}

pub fn check_build(build: u32) -> Result<(), String> {
    if build < MIN_BUILD {
        return Err(format!(
            "Harness needs Windows 10 version 1809 or later, and this computer runs build {build}. Update Windows, then run the installer again."
        ));
    }
    Ok(())
}

pub fn tar_path(system_root: &Path) -> PathBuf {
    // The fixed path, so a GNU tar on PATH is never used: it cannot read a zip.
    system_root.join("System32").join("tar.exe")
}

pub fn missing_tar(tar: &Path) -> String {
    format!(
        "Windows' own tar.exe is missing ({}). It is part of Windows 10 1803 and later.",
        tar.display()
    )
}

/// install.ps1's ConvertTo-HarnessVersionKey: `X.Y.Z` or `X.Y.Z-prerelease`, ordered by the three numbers only, each
/// within PowerShell's `[version]` (an Int32). Anything else has no key, and its entry is skipped.
pub fn version_key(value: &str) -> Option<(u32, u32, u32)> {
    let (core, prerelease) = match value.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (value, None),
    };
    if let Some(prerelease) = prerelease {
        let valid = prerelease
            .split('.')
            .all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric()));
        if !valid {
            return None;
        }
    }
    let number = |part: &str| -> Option<u32> {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse::<u32>().ok().filter(|n| *n <= i32::MAX as u32)
    };
    let mut parts = core.split('.');
    let key = (number(parts.next()?)?, number(parts.next()?)?, number(parts.next()?)?);
    parts.next().is_none().then_some(key)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub key: &'static str,
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: i64,
}

fn entry(document: &serde_json::Map<String, Value>, key: &'static str) -> Option<Entry> {
    let fields = document.get(key)?.as_object()?;
    let text = |name: &str| fields.get(name).and_then(Value::as_str).map(str::to_owned);
    // PowerShell's ConvertFrom-Json makes a whole number an [int] or [long], which is all install.ps1 takes; 1.5,
    // 1e3, a string or a number past Int64 become another type, and the entry is skipped.
    let size = fields.get("size").filter(|v| v.is_i64() || v.is_u64()).and_then(Value::as_i64)?;
    Some(Entry { key, version: text("version")?, url: text("url")?, sha256: text("sha256")?, size })
}

/// install.ps1's Select-HarnessAppEntry. x64 takes `desktop-windows-x64`. Arm64 takes the newer of the arm64 and x64
/// entries, and arm64 wins a tie: the x64 app runs emulated until an arm64 build of that version is out.
pub fn select_entry(document: &Value, machine: Machine) -> Result<Entry, String> {
    let none = || {
        format!(
            "The desktop manifest has no Harness desktop app for this computer ({}) yet.",
            machine.platform()
        )
    };
    let document = document.as_object().ok_or_else(none)?;
    let keys: &[&'static str] = match machine {
        Machine::X64 => &[X64_KEY],
        Machine::Arm64 => &[ARM64_KEY, X64_KEY],
    };
    let mut best: Option<((u32, u32, u32), Entry)> = None;
    for &key in keys {
        let Some(candidate) = entry(document, key) else { continue };
        let Some(order) = version_key(&candidate.version) else { continue };
        if best.as_ref().is_none_or(|(current, _)| order > *current) {
            best = Some((order, candidate));
        }
    }
    best.map(|(_, entry)| entry).ok_or_else(none)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Https(String),
    File(PathBuf),
}

impl Source {
    pub fn display(&self) -> String {
        match self {
            Source::Https(url) => url.clone(),
            Source::File(path) => path.display().to_string(),
        }
    }
}

/// install.ps1's `-match '^https://'`, which ignores case.
fn is_https(value: &str) -> bool {
    value.len() >= 8 && value.as_bytes()[..8].eq_ignore_ascii_case(b"https://")
}

/// Any other `scheme://`. A drive path (`C:\…`) has no `//` and is a file.
fn has_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once("://") else { return false };
    let mut bytes = scheme.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        && bytes.all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b))
}

fn untrusted(value: &str) -> String {
    format!("Only https:// addresses are trusted, and {value} is not one.")
}

/// The manifest: `HARNESS_INSTALL_MANIFEST` (a file, or an https:// address) when it is set, else the build's.
pub fn manifest_source(override_value: Option<&str>, base: &str) -> Result<Source, String> {
    match override_value.filter(|value| !value.is_empty()) {
        None => Ok(Source::Https(format!("{base}desktop/metadata.json"))),
        Some(value) if is_https(value) => Ok(Source::Https(value.to_owned())),
        Some(value) if has_scheme(value) => Err(untrusted(value)),
        Some(value) => Ok(Source::File(PathBuf::from(value))),
    }
}

/// Only Harness's own release folders, at either origin: the rule the website's download routes apply to the same
/// field. A staging build also follows the staging folders. Only plain path characters, so nothing in the address
/// can step out of the folder.
pub fn allowed_url(url: &str, staging: bool) -> bool {
    let folders: &[&str] = if staging {
        &["harness/desktop/", "harness/staging/desktop/"]
    } else {
        &["harness/desktop/"]
    };
    let plain = |rest: &str| {
        !rest.is_empty()
            && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
            && rest.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
    };
    ORIGINS.iter().any(|origin| {
        folders.iter().any(|folder| {
            url.strip_prefix(origin).and_then(|rest| rest.strip_prefix(folder)).is_some_and(plain)
        })
    })
}

/// install.ps1's Resolve-HarnessRef, plus the release-folder rule: where an entry's file is. A published manifest
/// names https:// addresses only; a local one (a test, a build of this tree) may name a file, beside it or rooted.
pub fn resolve_ref(reference: &str, manifest: &Source, staging: bool) -> Result<Source, String> {
    if is_https(reference) {
        if !allowed_url(reference, staging) {
            return Err(format!(
                "The manifest names {reference}, which is not one of Harness's downloads."
            ));
        }
        return Ok(Source::Https(reference.to_owned()));
    }
    if has_scheme(reference) {
        return Err(untrusted(reference));
    }
    match manifest {
        Source::Https(url) => Err(format!(
            "The manifest {url} names {reference}, which is not an https:// address."
        )),
        Source::File(path) => {
            let named = Path::new(reference);
            Ok(Source::File(if named.is_absolute() {
                named.to_path_buf()
            } else {
                path.parent().unwrap_or(Path::new("")).join(named)
            }))
        }
    }
}

pub fn check_sha256(sha256: &str, source: &str) -> Result<(), String> {
    if sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err(format!("The manifest gives no valid SHA-256 for {source}."))
}

/// The size the download may reach before it is already wrong.
pub fn size_limit(size: i64) -> u64 {
    u64::try_from(size).unwrap_or(0)
}

/// install.ps1's Save-HarnessVerified: the manifest is the trust, and the bytes are not until they match it.
pub fn check_download(source: &str, length: u64, size: i64, got: &str, expected: &str) -> Result<(), String> {
    if i64::try_from(length).ok() != Some(size) {
        return Err(format!(
            "{source} is {length} bytes, but the manifest says {size}: the download is incomplete, or is not the published file."
        ));
    }
    if got != expected.to_ascii_lowercase() {
        return Err(format!(
            "{source} failed its checksum (expected {expected}, got {got}): it is not the published file."
        ));
    }
    Ok(())
}

/// An HTTP answer other than 200, or none Windows could read (its own error says why).
pub fn not_the_file(url: &str, status: Result<u32, &str>) -> String {
    match status {
        Ok(code) => format!("{url} answered HTTP {code}, not the file."),
        Err(why) => format!("{url} sent no answer Harness could read: {why}."),
    }
}

pub fn no_launcher() -> String {
    "The download has no Harness.exe, so it is not a Harness desktop app.".to_owned()
}

pub fn install_stopped(code: i32, local_app_data: &str) -> String {
    format!(
        "Harness's installer stopped (exit code {code}). Its log is launch.log, in Programs\\Harness under {local_app_data}."
    )
}

/// The temp folder's name: install.ps1's New-HarnessStaging pattern (`.<name>-staging-<pid>-<time>`).
pub fn staging_name(pid: u32, time: u128) -> String {
    format!(".harness-desktop-staging-{pid}-{time}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn takes_no_argument_or_quiet_and_nothing_else() {
        assert_eq!(parse(&args(&[])), Ok(Mode::Window));
        assert_eq!(parse(&args(&["--quiet"])), Ok(Mode::Quiet));
        for bad in [&["--Quiet"][..], &["--quiet", "x"][..], &["/S"][..], &["--manifest"][..]] {
            assert_eq!(parse(&args(bad)), Err(USAGE.to_owned()), "{bad:?}");
        }
    }

    #[test]
    fn the_build_is_production_unless_the_release_built_it_for_staging() {
        assert!(!is_staging(PRODUCTION_BASE));
        assert!(is_staging(STAGING_BASE));
        assert!(BASE == PRODUCTION_BASE || BASE == STAGING_BASE);
    }

    #[test]
    fn the_steps_are_named_as_install_ps1_names_them() {
        let names: Vec<_> = [Step::Check, Step::Manifest, Step::Download, Step::Unpack, Step::Install]
            .iter()
            .map(|step| step.name())
            .collect();
        assert_eq!(
            names,
            ["Checking this computer", "Reading the release manifest", "Downloading Harness", "Unpacking Harness", "Installing Harness"]
        );
    }

    #[test]
    fn an_arm_pc_is_told_apart_from_an_x64_one_by_its_native_machine() {
        assert_eq!(Machine::from_native(0xAA64), Machine::Arm64);
        assert_eq!(Machine::from_native(0x8664), Machine::X64);
        assert_eq!(Machine::from_native(0), Machine::X64);
    }

    #[test]
    fn windows_10_1809_is_the_oldest_it_installs_on() {
        assert!(check_build(17763).is_ok());
        assert!(check_build(26200).is_ok());
        assert_eq!(
            check_build(17134).unwrap_err(),
            "Harness needs Windows 10 version 1809 or later, and this computer runs build 17134. Update Windows, then run the installer again."
        );
    }

    #[test]
    fn versions_order_by_their_three_numbers() {
        assert_eq!(version_key("1.2.3"), Some((1, 2, 3)));
        assert_eq!(version_key("1.10.0-rc.1"), Some((1, 10, 0)));
        assert_eq!(version_key("01.2.3"), Some((1, 2, 3)));
        assert_eq!(version_key("2147483647.0.0"), Some((2147483647, 0, 0)));
        for bad in ["", "1.2", "1.2.3.4", "1.2.3-", "1.2.3-rc..1", "1.2.3+build", "1.9.0junk", "v1.2.3", "2147483648.0.0", "9999999999.0.0", "1.2.-3", "１.2.3"] {
            assert_eq!(version_key(bad), None, "{bad}");
        }
    }

    // The vectors install.ps1's own spec runs against Select-HarnessAppEntry (cli/src/scripts/installPs1App.spec.ts).
    #[test]
    fn chooses_the_entry_install_ps1_chooses() {
        let vectors: Value = serde_json::from_str(include_str!("../tests/entry-vectors.json")).unwrap();
        let vectors = vectors.as_array().unwrap();
        assert!(vectors.len() >= 10);
        for vector in vectors {
            let name = vector["name"].as_str().unwrap();
            let machine = match vector["platform"].as_str().unwrap() {
                "win32-x64" => Machine::X64,
                "win32-arm64" => Machine::Arm64,
                other => panic!("{name}: platform {other}"),
            };
            let got = match select_entry(&vector["document"], machine) {
                Ok(entry) => format!("{} {}", entry.version, entry.url),
                Err(message) => message,
            };
            assert_eq!(got, vector["expect"].as_str().unwrap(), "{name}");
        }
    }

    #[test]
    fn an_entry_needs_text_fields_and_a_whole_number_size() {
        let doc = |size: Value| json!({ X64_KEY: { "version": "1.2.0", "url": "https://x/a.zip", "sha256": "0", "size": size } });
        assert_eq!(select_entry(&doc(json!(5)), Machine::X64).unwrap().size, 5);
        for size in [json!(1.5), json!(1e3), json!("5"), json!(null), json!(18446744073709551615u64)] {
            assert!(select_entry(&doc(size.clone()), Machine::X64).is_err(), "{size}");
        }
        assert!(select_entry(&json!([1, 2]), Machine::X64).is_err());
    }

    #[test]
    fn the_manifest_is_the_builds_unless_a_test_names_another() {
        assert_eq!(
            manifest_source(None, PRODUCTION_BASE),
            Ok(Source::Https(format!("{PRODUCTION_BASE}desktop/metadata.json")))
        );
        assert_eq!(manifest_source(Some(""), STAGING_BASE), Ok(Source::Https(format!("{STAGING_BASE}desktop/metadata.json"))));
        assert_eq!(manifest_source(Some("HTTPS://h/m.json"), PRODUCTION_BASE), Ok(Source::Https("HTTPS://h/m.json".into())));
        assert_eq!(manifest_source(Some(r"C:\build\metadata.json"), PRODUCTION_BASE), Ok(Source::File(r"C:\build\metadata.json".into())));
        assert_eq!(
            manifest_source(Some("http://h/m.json"), PRODUCTION_BASE),
            Err("Only https:// addresses are trusted, and http://h/m.json is not one.".into())
        );
    }

    #[test]
    fn a_download_must_be_in_harnesss_release_folders() {
        for good in [
            "https://cdn.autonomous.ai/harness/desktop/1.2.3/Harness-windows-x64.zip",
            "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.2.3/Harness-windows-arm64.zip",
        ] {
            assert!(allowed_url(good, false), "{good}");
            assert!(allowed_url(good, true), "{good}");
        }
        let staged = "https://cdn.autonomous.ai/harness/staging/desktop/1.2.3-rc1/harness-desktop-1.2.3-rc1-windows-x64.zip";
        assert!(allowed_url(staged, true));
        assert!(!allowed_url(staged, false));
        for bad in [
            "https://cdn.autonomous.ai/harness/desktop/",
            "https://cdn.autonomous.ai/harness/desktop/../cli/x.zip",
            "https://cdn.autonomous.ai/harness/desktop/1.2.3//x.zip",
            "https://cdn.autonomous.ai/harness/desktop/1.2.3/x.zip?x=1",
            "https://cdn.autonomous.ai/harness/desktop/1.2.3/x%2e.zip",
            "https://cdn.autonomous.ai.evil.example/harness/desktop/1.2.3/x.zip",
            "https://storage.googleapis.com/another-bucket/harness/desktop/1.2.3/x.zip",
            "https://cdn.autonomous.ai/harness/cli/1.2.3/x.zip",
            "https://CDN.autonomous.ai/harness/desktop/1.2.3/x.zip",
        ] {
            assert!(!allowed_url(bad, true), "{bad}");
        }
    }

    #[test]
    fn an_entrys_file_is_an_allowed_address_or_beside_a_local_manifest() {
        let published = Source::Https(format!("{PRODUCTION_BASE}desktop/metadata.json"));
        let local = Source::File(PathBuf::from("build").join("metadata.json"));
        let url = "https://cdn.autonomous.ai/harness/desktop/1.2.3/Harness-windows-x64.zip";
        assert_eq!(resolve_ref(url, &published, false), Ok(Source::Https(url.into())));
        assert_eq!(resolve_ref(url, &local, false), Ok(Source::Https(url.into())));
        assert_eq!(
            resolve_ref("https://example.com/x.zip", &published, false),
            Err("The manifest names https://example.com/x.zip, which is not one of Harness's downloads.".into())
        );
        assert_eq!(
            resolve_ref("file:///C:/x.zip", &local, false),
            Err("Only https:// addresses are trusted, and file:///C:/x.zip is not one.".into())
        );
        assert_eq!(
            resolve_ref("x.zip", &published, false),
            Err(format!("The manifest {PRODUCTION_BASE}desktop/metadata.json names x.zip, which is not an https:// address."))
        );
        assert_eq!(resolve_ref("x.zip", &local, false), Ok(Source::File(PathBuf::from("build").join("x.zip"))));
    }

    #[test]
    fn a_download_is_kept_only_when_its_size_and_hash_are_the_manifests() {
        let hash = "a".repeat(64);
        assert!(check_sha256(&hash, "s").is_ok());
        assert!(check_sha256(&"A".repeat(64), "s").is_ok());
        assert_eq!(check_sha256("abc", "s"), Err("The manifest gives no valid SHA-256 for s.".into()));
        assert!(check_download("s", 10, 10, &hash, &hash.to_uppercase()).is_ok());
        assert_eq!(
            check_download("s", 9, 10, &hash, &hash),
            Err("s is 9 bytes, but the manifest says 10: the download is incomplete, or is not the published file.".into())
        );
        let other = "b".repeat(64);
        assert_eq!(
            check_download("s", 10, 10, &other, &hash),
            Err(format!("s failed its checksum (expected {hash}, got {other}): it is not the published file."))
        );
        assert_eq!(size_limit(-1), 0);
        assert_eq!(size_limit(7), 7);
    }

    #[test]
    fn an_answer_that_is_not_the_file_says_its_status_or_why_there_was_none() {
        assert_eq!(not_the_file("https://h/x", Ok(404)), "https://h/x answered HTTP 404, not the file.");
        assert_eq!(
            not_the_file("https://h/x", Err("The operation timed out (Windows error 12002)")),
            "https://h/x sent no answer Harness could read: The operation timed out (Windows error 12002)."
        );
    }

    #[test]
    fn the_temp_folder_is_named_as_install_ps1_names_its_own() {
        assert_eq!(staging_name(42, 7), ".harness-desktop-staging-42-7");
    }
}
