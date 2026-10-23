//! The Windows half (spec §1): the real [Host] (WinINet, `tar.exe`, `Harness.exe --install`), the log, the one-copy
//! rule, and the entry point that picks the window or quiet mode.

use std::env;
use std::ffi::{OsStr, c_void};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
use windows_sys::Win32::Networking::WinInet::{
    HTTP_QUERY_FLAG_NUMBER, HTTP_QUERY_STATUS_CODE, HttpQueryInfoW, INTERNET_FLAG_NO_CACHE_WRITE,
    INTERNET_FLAG_NO_AUTO_REDIRECT, INTERNET_FLAG_NO_COOKIES, INTERNET_FLAG_NO_UI, INTERNET_FLAG_PRAGMA_NOCACHE, INTERNET_FLAG_RELOAD,
    INTERNET_FLAG_SECURE, INTERNET_OPEN_TYPE_PRECONFIG, INTERNET_OPTION_CONNECT_TIMEOUT,
    INTERNET_OPTION_RECEIVE_TIMEOUT, INTERNET_OPTION_SEND_TIMEOUT, InternetCloseHandle, InternetOpenUrlW,
    InternetOpenW, InternetReadFile, InternetSetOptionW,
};
use windows_sys::Win32::System::Diagnostics::Debug::{
    FORMAT_MESSAGE_FROM_HMODULE, FORMAT_MESSAGE_FROM_SYSTEM, FORMAT_MESSAGE_IGNORE_INSERTS, FormatMessageW,
};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Win32::System::Threading::{CreateMutexW, GetCurrentProcess};

use crate::flow::{self, Host, Report};
use crate::model::{self, Machine, Source};
use crate::ui;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub const LOG_NAME: &str = "harness-install.log";
/// One installer per sign-in session: a double double-click must not run two installs into one folder.
pub const MUTEX_NAME: &str = "Local\\HarnessInstall";
/// Harness.exe says a failure in a message box unless this is set (pty/src/desktop/system.rs, NO_DIALOG_ENV). Quiet
/// mode sets it: nothing answers a dialog there, and the exit code and launch.log say it instead.
pub const NO_DIALOG_ENV: &str = "HARNESS_DESKTOP_NO_DIALOG";
/// A stalled connection fails after this: no byte at all, or none for this long in the middle.
const NETWORK_TIMEOUT_MS: u32 = 30_000;

pub fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

/// The text Windows has for an error, from WinINet's own table first (its codes are not the system's).
fn error_text(code: u32) -> String {
    let module = unsafe { GetModuleHandleW(wide("wininet.dll").as_ptr()) };
    let mut buffer = [0u16; 512];
    let length = unsafe {
        FormatMessageW(
            FORMAT_MESSAGE_FROM_HMODULE | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
            module as *const c_void,
            code,
            0,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            null(),
        )
    };
    let text = String::from_utf16_lossy(&buffer[..length as usize]);
    let text = text.trim();
    if text.is_empty() { format!("Windows error {code}") } else { format!("{text} (Windows error {code})") }
}

struct Internet(*mut c_void);

impl Drop for Internet {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { InternetCloseHandle(self.0) };
        }
    }
}

/// GET [url] over HTTPS with WinINet, handing each piece to [sink] until it says stop.
///
/// WinINet, not WinHTTP: it takes the person's own proxy settings (`INTERNET_OPEN_TYPE_PRECONFIG`), as Edge and
/// PowerShell 5.1 do. The program writes the bytes itself, so the file gets no Zone.Identifier: no file of the app is
/// marked as downloaded, and SmartScreen asks only about this program (spec §1.1, step 5). A redirect from https to
/// http fails: INTERNET_FLAG_SECURE without INTERNET_FLAG_IGNORE_REDIRECT_TO_HTTP.
fn fetch(url: &str, sink: &mut dyn FnMut(&[u8]) -> bool) -> Result<(), String> {
    let agent = wide(&format!("Harness-Install/{}", model::VERSION));
    let session = Internet(unsafe { InternetOpenW(agent.as_ptr(), INTERNET_OPEN_TYPE_PRECONFIG, null(), null(), 0) });
    if session.0.is_null() {
        return Err(format!("Could not start a download: {}", error_text(unsafe { GetLastError() })));
    }
    for option in [INTERNET_OPTION_CONNECT_TIMEOUT, INTERNET_OPTION_RECEIVE_TIMEOUT, INTERNET_OPTION_SEND_TIMEOUT] {
        let timeout = NETWORK_TIMEOUT_MS;
        unsafe { InternetSetOptionW(session.0, option, &timeout as *const u32 as *const c_void, 4) };
    }
    let flags = INTERNET_FLAG_RELOAD
        | INTERNET_FLAG_PRAGMA_NOCACHE
        | INTERNET_FLAG_NO_CACHE_WRITE
        | INTERNET_FLAG_NO_COOKIES
        | INTERNET_FLAG_NO_UI
        | INTERNET_FLAG_SECURE
        // The folder rule is checked on the address the manifest names: a redirect would take the download elsewhere.
        | INTERNET_FLAG_NO_AUTO_REDIRECT;
    let address = wide(url);
    let request = Internet(unsafe { InternetOpenUrlW(session.0, address.as_ptr(), null(), 0, flags, 0) });
    if request.0.is_null() {
        return Err(format!("Could not download {url}: {}", error_text(unsafe { GetLastError() })));
    }
    let mut status = 0u32;
    let mut length = 4u32;
    let asked = unsafe {
        HttpQueryInfoW(
            request.0,
            HTTP_QUERY_STATUS_CODE | HTTP_QUERY_FLAG_NUMBER,
            &mut status as *mut u32 as *mut c_void,
            &mut length,
            null_mut(),
        )
    };
    if asked == 0 {
        return Err(model::not_the_file(url, Err(&error_text(unsafe { GetLastError() }))));
    }
    if status != 200 {
        return Err(model::not_the_file(url, Ok(status)));
    }
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let mut read = 0u32;
        let ok = unsafe { InternetReadFile(request.0, buffer.as_mut_ptr() as *mut c_void, buffer.len() as u32, &mut read) };
        if ok == 0 {
            return Err(format!("The download of {url} stopped: {}", error_text(unsafe { GetLastError() })));
        }
        if read == 0 {
            return Ok(());
        }
        if !sink(&buffer[..read as usize]) {
            return Err("stopped".to_owned());
        }
    }
}

/// What GetProcAddress hands back, before it is cast to the call's own signature.
pub type Later = unsafe extern "system" fn() -> isize;

/// A call newer than Windows 10 1507, found when the program runs. Imported, it would stop the program loading at all
/// on an older Windows 10, before it could say that Harness needs 1809 (`model::check_build`). [name] ends in NUL.
pub fn later_call(module: &str, name: &[u8]) -> Option<Later> {
    let handle = unsafe { GetModuleHandleW(wide(module).as_ptr()) };
    if handle.is_null() {
        return None;
    }
    unsafe { GetProcAddress(handle, name.as_ptr()) }
}

pub struct Real;

impl Host for Real {
    fn windows_build(&self) -> u32 {
        let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        // RtlGetVersion: GetVersionExW answers what the manifest declares support for, not the build that runs.
        if unsafe { RtlGetVersion(&mut info) } == 0 { info.dwBuildNumber } else { 0 }
    }

    fn system_root(&self) -> PathBuf {
        env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
    }

    fn machine(&self) -> Machine {
        type IsWow64Process2 = unsafe extern "system" fn(HANDLE, *mut u16, *mut u16) -> i32;
        // Windows 10 1709 and later; an older one is told it needs 1809 before the machine matters.
        let Some(call) = later_call("kernel32.dll", b"IsWow64Process2\0") else { return Machine::X64 };
        let call = unsafe { std::mem::transmute::<Later, IsWow64Process2>(call) };
        let (mut process, mut native) = (0u16, 0u16);
        if unsafe { call(GetCurrentProcess(), &mut process, &mut native) } == 0 {
            return Machine::X64;
        }
        Machine::from_native(native)
    }

    fn local_app_data(&self) -> String {
        env::var("LOCALAPPDATA").unwrap_or_else(|_| "%LOCALAPPDATA%".to_owned())
    }

    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }

    fn read(&mut self, source: &Source) -> Result<Vec<u8>, String> {
        let too_big = || format!("The manifest {} is larger than a manifest can be.", source.display());
        match source {
            Source::Https(url) => {
                let mut bytes = Vec::new();
                let mut full = false;
                fetch(url, &mut |piece| {
                    bytes.extend_from_slice(piece);
                    full = bytes.len() as u64 > model::MANIFEST_LIMIT;
                    !full
                })
                .map_err(|why| if full { too_big() } else { why })?;
                Ok(bytes)
            }
            Source::File(path) => match fs::metadata(path) {
                Ok(meta) if meta.is_file() && meta.len() > model::MANIFEST_LIMIT => Err(too_big()),
                Ok(meta) if meta.is_file() => {
                    fs::read(path).map_err(|err| format!("Could not read the manifest {}: {err}", path.display()))
                }
                _ => Err(format!("The manifest {} does not exist.", path.display())),
            },
        }
    }

    fn staging(&mut self) -> Result<PathBuf, String> {
        let time = SystemTime::now().duration_since(UNIX_EPOCH).map(|t| t.as_nanos() / 100).unwrap_or(0);
        let dir = env::temp_dir().join(model::staging_name(std::process::id(), time));
        fs::create_dir_all(&dir).map_err(|err| format!("Could not create {}: {err}", dir.display()))?;
        Ok(dir)
    }

    fn download(&mut self, source: &Source, to: &Path, received: &mut dyn FnMut(u64) -> bool) -> Result<(), String> {
        let mut file = File::create(to).map_err(|err| format!("Could not create {}: {err}", to.display()))?;
        let mut count = 0u64;
        let mut failed_write = None;
        let mut sink = |piece: &[u8]| {
            if let Err(err) = file.write_all(piece) {
                failed_write = Some(format!("Could not write {}: {err}", to.display()));
                return false;
            }
            count += piece.len() as u64;
            received(count)
        };
        let result = match source {
            Source::Https(url) => fetch(url, &mut sink),
            // A local manifest's file (a test, a build of this tree) is copied, not downloaded.
            Source::File(path) => {
                let mut from = File::open(path).map_err(|err| format!("Could not read {}: {err}", path.display()))?;
                let mut buffer = vec![0u8; 1 << 16];
                loop {
                    match from.read(&mut buffer) {
                        Ok(0) => break Ok(()),
                        Ok(read) if sink(&buffer[..read]) => {}
                        Ok(_) => break Err("stopped".to_owned()),
                        Err(err) => break Err(format!("Could not read {}: {err}", path.display())),
                    }
                }
            }
        };
        match failed_write {
            Some(why) => Err(why),
            None => result,
        }
    }

    fn unpack(&mut self, tar: &Path, archive: &Path, into: &Path) -> Result<(), String> {
        fs::create_dir_all(into).map_err(|err| format!("Could not create {}: {err}", into.display()))?;
        // tar.exe reads its arguments in the ANSI code page, so a profile path with a letter outside it reached it as
        // '?' and the archive could not be opened (install.ps1's Expand-HarnessZip, seen on the VM 2026-10-16). It
        // runs inside the folder on an ASCII name instead: the working directory is handed over in Unicode.
        let name = format!(".harness-archive-{}.zip", std::process::id());
        let local = into.join(&name);
        fs::rename(archive, &local).map_err(|err| format!("Could not move {}: {err}", archive.display()))?;
        let status = Command::new(tar)
            .args(["-xf", &name])
            .current_dir(into)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = fs::remove_file(&local);
        match status {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!(
                "Could not unpack {} (tar.exe exit code {}).",
                archive.display(),
                status.code().unwrap_or(-1)
            )),
            Err(err) => Err(format!("Could not run {}: {err}", tar.display())),
        }
    }

    fn install(&mut self, launcher: &Path) -> Result<i32, String> {
        Command::new(launcher)
            .arg("--install")
            .current_dir(launcher.parent().unwrap_or(Path::new(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.code().unwrap_or(model::EXIT_FAILED))
            .map_err(|err| format!("Could not start {}: {err}", launcher.display()))
    }

    fn remove(&mut self, dir: &Path) -> Result<(), String> {
        fs::remove_dir_all(dir).map_err(|err| err.to_string())
    }

    fn pause(&mut self, time: Duration) {
        std::thread::sleep(time);
    }
}

/// `%TEMP%\harness-install.log`, rewritten by each run: the steps, the manifest, the chosen entry and any error.
pub struct Log {
    file: Option<File>,
    started: Instant,
}

impl Log {
    pub fn create() -> Log {
        Log { file: File::create(env::temp_dir().join(LOG_NAME)).ok(), started: Instant::now() }
    }

    /// For a second copy: it adds its line to the running install's log instead of cutting it short.
    pub fn append() -> Log {
        let file = fs::OpenOptions::new().create(true).append(true).open(env::temp_dir().join(LOG_NAME)).ok();
        Log { file, started: Instant::now() }
    }

    pub fn line(&mut self, text: &str) {
        if let Some(file) = &mut self.file {
            let _ = writeln!(file, "[{:6.1}s] {text}", self.started.elapsed().as_secs_f64());
            let _ = file.flush();
        }
    }
}

/// Held for the run: the named mutex no second copy can create anew.
pub struct OneCopy(HANDLE);

impl OneCopy {
    /// None when another copy holds it. A mutex Windows will not create at all does not stop the install.
    pub fn take() -> Option<OneCopy> {
        let name = wide(MUTEX_NAME);
        let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
        if !handle.is_null() && unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe { CloseHandle(handle) };
            return None;
        }
        Some(OneCopy(handle))
    }
}

impl Drop for OneCopy {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct Quiet(Log);

impl Report for Quiet {
    fn step(&mut self, _: model::Step) {}
    fn progress(&mut self, _: u64, _: u64) {}
    fn cancelled(&self) -> bool {
        false
    }
    fn log(&mut self, line: &str) {
        self.0.line(line);
    }
}

pub fn main(args: &[String]) -> i32 {
    // The mutex first: the log is the running install's until it ends.
    let Some(_copy) = OneCopy::take() else {
        Log::append().line("Another Harness installer is already running.");
        if model::parse(args) == Ok(model::Mode::Quiet) {
            return model::EXIT_FAILED;
        }
        ui::bring_forward();
        return model::EXIT_OK;
    };
    let mut log = Log::create();
    let staging = model::is_staging(model::BASE);
    log.line(&format!(
        "harness-install {} ({})",
        model::VERSION,
        if staging { "staging" } else { "production" }
    ));
    let mode = match model::parse(args) {
        Ok(mode) => mode,
        Err(usage) => {
            log.line(&usage);
            return model::EXIT_FAILED;
        }
    };
    let manifest = match model::manifest_source(env::var(model::MANIFEST_ENV).ok().as_deref(), model::BASE) {
        Ok(manifest) => manifest,
        Err(why) => {
            log.line(&why);
            if mode == model::Mode::Window {
                ui::say(&why);
            }
            return model::EXIT_FAILED;
        }
    };
    match mode {
        model::Mode::Quiet => {
            // Still one thread: nothing else reads the environment while it changes.
            unsafe { env::set_var(NO_DIALOG_ENV, "1") };
            flow::run(&mut Real, &mut Quiet(log), &manifest, staging).exit_code()
        }
        model::Mode::Window => ui::run(log, manifest, staging),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_machine_is_the_pcs_own_even_when_this_program_runs_emulated() {
        // The registry keeps the native architecture for the whole system (install.ps1's Get-HarnessPlatform).
        let output = Command::new("reg")
            .args(["query", r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "/v", "PROCESSOR_ARCHITECTURE"])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout).to_uppercase();
        let expected = if text.contains("ARM64") { Machine::Arm64 } else { Machine::X64 };
        assert_eq!(Real.machine(), expected);
    }

    #[test]
    fn this_windows_is_new_enough_and_has_its_tar() {
        assert!(model::check_build(Real.windows_build()).is_ok());
        assert!(Real.is_file(&model::tar_path(&Real.system_root())));
    }

    // The case that runs WinINet on CI: a local manifest's file is copied, not downloaded.
    #[test]
    fn downloads_over_https_with_no_mark_of_the_web() {
        let dir = env::temp_dir().join(format!("harness-install-wininet-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let to = dir.join("metadata.json");
        let url = format!("{}desktop/metadata.json", model::PRODUCTION_BASE);
        let mut last = 0;
        Real.download(&Source::Https(url.clone()), &to, &mut |count| {
            last = count;
            true
        })
        .unwrap();
        let bytes = fs::read(&to).unwrap();
        assert_eq!(bytes.len() as u64, last);
        assert!(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap().is_object());
        let mut stream = to.clone().into_os_string();
        stream.push(":Zone.Identifier");
        assert!(File::open(PathBuf::from(stream)).is_err(), "the download is marked as from the internet");
        let manifest = Real.read(&Source::Https(url)).unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&manifest).unwrap().is_object());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_address_fails_with_its_status() {
        let url = format!("{}desktop/no-such-file-{}.json", model::PRODUCTION_BASE, std::process::id());
        let why = Real.read(&Source::Https(url.clone())).unwrap_err();
        assert!(why.starts_with(&format!("{url} answered HTTP 404")), "{why}");
    }

    // The folder rule is checked on the address the manifest names; a redirect would leave it unchecked.
    #[test]
    fn a_redirect_is_not_followed() {
        let url = "https://harness.autonomous.ai/desktop/download-macos";
        let why = Real.read(&Source::Https(url.into())).unwrap_err();
        assert!(why.starts_with(&format!("{url} answered HTTP 30")), "{why}");
    }

    #[test]
    fn a_second_copy_finds_the_first() {
        let first = OneCopy::take().expect("the first copy takes the mutex");
        assert!(OneCopy::take().is_none());
        drop(first);
        assert!(OneCopy::take().is_some());
    }
}
