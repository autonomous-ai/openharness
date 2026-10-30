//! The built harness-install.exe in quiet mode, on real Windows (windows-desktop.yml, x64 and arm64). Each run gets
//! its own TEMP, which holds its log and its temp folder. The full install with the real launcher is
//! cli/src/scripts/installPs1App.spec.ts, held to the same expectations as install.ps1 -App.
#![cfg(windows)]

use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr::null;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};

use sha2::{Digest, Sha256};

const EXE: &str = env!("CARGO_BIN_EXE_harness-install");

/// One run at a time: the program takes a session-wide mutex, and a_second_copy_does_not_start_a_second_install
/// holds it on purpose.
fn one_at_a_time() -> MutexGuard<'static, ()> {
    static ONE: Mutex<()> = Mutex::new(());
    ONE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

/// A scratch folder whose name a shell or an ANSI code page would mangle (Review Focus 1).
fn scratch() -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir()
        .join(format!("harness-install-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)))
        .join("Nguyễn Văn A' & 100% !x");
    fs::create_dir_all(dir.join("temp")).unwrap();
    dir
}

fn quiet(dir: &Path, manifest: Option<&Path>, args: &[&str]) -> (i32, String) {
    let temp = dir.join("temp");
    let mut command = Command::new(EXE);
    command.args(args).env("TEMP", &temp).env("TMP", &temp).env_remove("HARNESS_INSTALL_MANIFEST");
    if let Some(manifest) = manifest {
        command.env("HARNESS_INSTALL_MANIFEST", manifest);
    }
    let status = command.status().unwrap();
    let log = fs::read_to_string(temp.join("harness-install.log")).unwrap_or_default();
    (status.code().unwrap(), log)
}

fn staging_left(dir: &Path) -> Vec<String> {
    fs::read_dir(dir.join("temp"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".harness-desktop-staging-"))
        .collect()
}

/// A local manifest for [file], with its real size and hash unless [sha256] says otherwise.
fn manifest_for(dir: &Path, file: &str, sha256: Option<&str>) -> PathBuf {
    let bytes = fs::read(dir.join(file)).unwrap();
    let hash = sha256.map(str::to_owned).unwrap_or_else(|| Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect());
    let entry = serde_json::json!({ "version": "9.8.7", "url": file, "sha256": hash, "size": bytes.len() });
    let path = dir.join("metadata.json");
    fs::write(&path, serde_json::json!({ "desktop-windows-x64": entry, "desktop-windows-arm64": entry }).to_string()).unwrap();
    path
}

/// A zip with one file that is not Harness.exe, made by Windows' own tar.
fn zip_without_launcher(dir: &Path) {
    let content = dir.join("content");
    fs::create_dir_all(&content).unwrap();
    fs::write(content.join("readme.txt"), "not a Harness app").unwrap();
    let tar = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32").join("tar.exe");
    let made = Command::new(tar).args(["-a", "-cf", "..\\other.zip", "readme.txt"]).current_dir(&content).status().unwrap();
    assert!(made.success());
}

#[test]
fn an_unknown_argument_is_a_usage_error() {
    let _one = one_at_a_time();
    let dir = scratch();
    let (code, log) = quiet(&dir, None, &["--quiet", "--manifest"]);
    assert_eq!(code, 1);
    assert!(log.contains("usage: harness-install [--quiet]"), "{log}");
}

#[test]
fn a_manifest_that_does_not_exist_fails_reading_it() {
    let _one = one_at_a_time();
    let dir = scratch();
    let (code, log) = quiet(&dir, Some(&dir.join("missing.json")), &["--quiet"]);
    assert_eq!(code, 1);
    assert!(log.contains("Harness could not be installed. The step that failed: Reading the release manifest."), "{log}");
    assert!(log.contains("does not exist."), "{log}");
}

#[test]
fn a_download_whose_hash_differs_installs_nothing_and_leaves_no_temp_folder() {
    let _one = one_at_a_time();
    let dir = scratch();
    fs::write(dir.join("app.zip"), b"some bytes").unwrap();
    let manifest = manifest_for(&dir, "app.zip", Some(&"f".repeat(64)));
    let (code, log) = quiet(&dir, Some(&manifest), &["--quiet"]);
    assert_eq!(code, 1);
    assert!(log.contains("The step that failed: Downloading Harness."), "{log}");
    assert!(log.contains("failed its checksum"), "{log}");
    assert_eq!(staging_left(&dir), Vec::<String>::new());
}

// tar.exe runs inside the temp folder on an ASCII name: a profile path outside the ANSI code page reached it as '?'.
#[test]
fn unpacks_under_a_unicode_profile_and_refuses_a_zip_with_no_launcher() {
    let _one = one_at_a_time();
    let dir = scratch();
    zip_without_launcher(&dir);
    let manifest = manifest_for(&dir, "other.zip", None);
    let (code, log) = quiet(&dir, Some(&manifest), &["--quiet"]);
    assert_eq!(code, 1);
    assert!(log.contains("The step that failed: Unpacking Harness."), "{log}");
    assert!(log.contains("The download has no Harness.exe, so it is not a Harness desktop app."), "{log}");
    assert_eq!(staging_left(&dir), Vec::<String>::new());
}

#[test]
fn a_second_copy_does_not_start_a_second_install() {
    let _one = one_at_a_time();
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let held = unsafe { CreateMutexW(null(), 0, wide(std::ffi::OsStr::new("Local\\HarnessInstall")).as_ptr()) };
    assert!(!held.is_null());
    let dir = scratch();
    let (code, log) = quiet(&dir, Some(&dir.join("missing.json")), &["--quiet"]);
    unsafe { CloseHandle(held) };
    assert_eq!(code, 1);
    assert!(log.contains("Another Harness installer is already running."), "{log}");
    assert!(!log.contains("Reading the release manifest"), "{log}");
}

// The log the failure box points people to: a second copy must not cut the running install's short.
#[test]
fn a_second_copy_keeps_the_first_copys_log() {
    let _one = one_at_a_time();
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let dir = scratch();
    let log = dir.join("temp").join("harness-install.log");
    fs::write(&log, "[   0.0s] the first copy's steps\n").unwrap();
    let held = unsafe { CreateMutexW(null(), 0, wide(std::ffi::OsStr::new("Local\\HarnessInstall")).as_ptr()) };
    assert!(!held.is_null());
    let (code, text) = quiet(&dir, Some(&dir.join("missing.json")), &["--quiet"]);
    unsafe { CloseHandle(held) };
    assert_eq!(code, 1);
    assert!(text.starts_with("[   0.0s] the first copy's steps\n"), "{text}");
    assert!(text.contains("Another Harness installer is already running."), "{text}");
}

/// The names the executable imports, read from its PE import table (PE32+).
fn imports(path: &str) -> std::collections::HashSet<String> {
    let b = fs::read(path).unwrap();
    let u16_at = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]) as usize;
    let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
    let pe = u32_at(0x3c);
    let optional = pe + 24;
    assert_eq!(u16_at(optional), 0x20b, "not PE32+");
    let sections = optional + u16_at(pe + 20);
    let offset = |rva: usize| {
        (0..u16_at(pe + 6))
            .map(|i| sections + i * 40)
            .find(|&s| rva >= u32_at(s + 12) && rva < u32_at(s + 12) + u32_at(s + 8).max(u32_at(s + 16)))
            .map(|s| rva - u32_at(s + 12) + u32_at(s + 20))
            .expect("an import outside every section")
    };
    let mut names = std::collections::HashSet::new();
    let mut descriptor = offset(u32_at(optional + 120)); // data directory 1: imports
    while u32_at(descriptor + 12) != 0 {
        let lookup = match u32_at(descriptor) { 0 => u32_at(descriptor + 16), rva => rva };
        let mut thunk = offset(lookup);
        loop {
            let entry = u64::from_le_bytes(b[thunk..thunk + 8].try_into().unwrap());
            if entry == 0 {
                break;
            }
            if entry >> 63 == 0 {
                let name = offset((entry & 0x7fff_ffff) as usize) + 2;
                let end = b[name..].iter().position(|&c| c == 0).unwrap();
                names.insert(String::from_utf8_lossy(&b[name..name + end]).into_owned());
            }
            thunk += 8;
        }
        descriptor += 20;
    }
    names
}

// Windows 10 before 1809 lacks IsWow64Process2 (1709) and the *ForDpi calls (1607). Imported, they stop the program
// loading at all there, before it can say that Harness needs 1809.
#[test]
fn the_executable_loads_on_older_windows_and_can_say_it_needs_1809() {
    let names = imports(EXE);
    assert!(names.contains("CreateMutexW"), "the import table was not read: {names:?}");
    for later in ["IsWow64Process2", "GetDpiForSystem", "GetDpiForWindow", "AdjustWindowRectExForDpi", "SystemParametersInfoForDpi"] {
        assert!(!names.contains(later), "{later} is imported");
    }
}

/// The resource Windows reads before it runs the program: never elevation, the themed controls, and the names
/// Explorer and SmartScreen show.
#[test]
fn the_executable_asks_for_no_elevation_and_names_harness() {
    let _one = one_at_a_time();
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    use windows_sys::Win32::System::LibraryLoader::{
        FindResourceW, LOAD_LIBRARY_AS_DATAFILE, LoadLibraryExW, LoadResource, LockResource, SizeofResource,
    };
    let path = wide(std::ffi::OsStr::new(EXE));
    let module = unsafe { LoadLibraryExW(path.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_AS_DATAFILE) };
    assert!(!module.is_null());
    let found = unsafe { FindResourceW(module, 1 as _, 24 as _) };
    assert!(!found.is_null(), "no application manifest");
    let manifest = unsafe {
        let data = LockResource(LoadResource(module, found)) as *const u8;
        String::from_utf8_lossy(std::slice::from_raw_parts(data, SizeofResource(module, found) as usize)).into_owned()
    };
    assert!(manifest.contains(r#"level="asInvoker""#), "{manifest}");
    assert!(manifest.contains("Microsoft.Windows.Common-Controls"), "{manifest}");
    assert!(manifest.contains("PerMonitorV2"), "{manifest}");

    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), std::ptr::null_mut()) };
    assert!(size > 0, "no version resource");
    let mut block = vec![0u8; size as usize];
    assert_ne!(unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, block.as_mut_ptr() as *mut _) }, 0);
    let value = |name: &str| -> String {
        let query = wide(std::ffi::OsStr::new(&format!("\\StringFileInfo\\040904B0\\{name}")));
        let (mut text, mut length) = (std::ptr::null_mut(), 0u32);
        assert_ne!(unsafe { VerQueryValueW(block.as_ptr() as *const _, query.as_ptr(), &mut text, &mut length) }, 0, "{name}");
        let chars = unsafe { std::slice::from_raw_parts(text as *const u16, length as usize) };
        String::from_utf16_lossy(chars).trim_end_matches('\0').to_owned()
    };
    assert_eq!(value("FileDescription"), "Install Harness");
    assert_eq!(value("ProductName"), "Harness");
    assert_eq!(value("CompanyName"), "Autonomous");
    assert_eq!(value("OriginalFilename"), "harness-install.exe");
}
