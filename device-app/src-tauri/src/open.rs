//! Opening things: a page, a file in its folder, the desktop app. Windows and Linux have no single `open` program.

use crate::desktop::{self, DESKTOP_BUNDLE_ID};
use crate::types::Log;
use std::env::consts::OS;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

/// What the app opens, each with arguments fixed in Rust: nothing from the webview becomes one.
pub trait Opener: Send + Sync {
    /// A page, in the person's browser.
    fn url(&self, url: &str) -> io::Result<()>;
    /// The logs' zip in its folder, selected where the file manager can.
    fn reveal(&self, zip: &Path) -> io::Result<()>;
    /// The desktop app.
    fn desktop(&self) -> io::Result<()>;
}

pub fn system(log: Arc<dyn Log>) -> Arc<dyn Opener> {
    Arc::new(SystemOpener { log })
}

/// What runs a URL on this OS: by its full path on macOS, so a PATH the app was started with never decides what opens
/// a sign-in URL. None on Windows, whose shell opens it.
pub fn url_args(os: &str, url: &str) -> Option<(&'static str, Vec<String>)> {
    match os {
        "macos" => Some(("/usr/bin/open", vec![url.into()])),
        "windows" => None,
        _ => Some(("xdg-open", vec![url.into()])),
    }
}

/// The URL Windows' shell may open: a web page, nothing it would run. Its handler puts the URL in a browser's command
/// line between quotes, so a quote, a space or a control character keeps it out too.
pub fn shell_url(url: &str) -> Option<&str> {
    let one_word = !url.chars().any(|c| c == '"' || c.is_whitespace() || c.is_control());
    (url.starts_with("https://") && one_word).then_some(url)
}

/// What shows the zip: selected in Finder (`-R`); Linux's `xdg-open` cannot select a file, so it opens its folder.
/// None on Windows, whose shell selects it: `explorer.exe /select,` may open the folder without selecting it.
pub fn reveal_args(os: &str, zip: &Path) -> Option<(&'static str, Vec<String>)> {
    match os {
        "macos" => Some(("/usr/bin/open", vec!["-R".into(), zip.display().to_string()])),
        "windows" => None,
        _ => Some(("xdg-open", vec![zip.parent().unwrap_or(zip).display().to_string()])),
    }
}

/// What opens the desktop app on macOS, by its bundle id. Elsewhere it is `desktop::desktop_app()`, run with no
/// argument.
pub fn desktop_args(os: &str) -> Option<(&'static str, Vec<String>)> {
    (os == "macos").then(|| ("/usr/bin/open", vec!["-b".into(), DESKTOP_BUNDLE_ID.into()]))
}

struct SystemOpener {
    log: Arc<dyn Log>,
}

impl Opener for SystemOpener {
    #[cfg(not(windows))]
    fn url(&self, url: &str) -> io::Result<()> {
        let (program, args) = url_args(OS, url).ok_or(io::ErrorKind::Unsupported)?;
        start(Command::new(program).args(args), Some(&self.log))
    }

    /// On a thread of its own: the shell may wait on the browser's handler, and the app has one event loop. A failure
    /// is the runner's line for it.
    #[cfg(windows)]
    fn url(&self, url: &str) -> io::Result<()> {
        let url = shell_url(url).ok_or(io::ErrorKind::InvalidInput)?.to_string();
        let log = self.log.clone();
        std::thread::spawn(move || {
            if let Err(error) = shell_open(&url) {
                log.line(&format!("browser: could not open: {error}"));
            }
        });
        Ok(())
    }

    #[cfg(not(windows))]
    fn reveal(&self, zip: &Path) -> io::Result<()> {
        let (program, args) = reveal_args(OS, zip).ok_or(io::ErrorKind::Unsupported)?;
        start(Command::new(program).args(args), Some(&self.log))
    }

    /// On a thread of its own: the shell waits for Explorer's window to select the zip in it, and the app has one
    /// event loop. A failure is the runner's line for it.
    #[cfg(windows)]
    fn reveal(&self, zip: &Path) -> io::Result<()> {
        let zip = zip.to_path_buf();
        let log = self.log.clone();
        std::thread::spawn(move || {
            if let Err(error) = shell_select(&zip) {
                log.line(&format!("logs: could not open: {error}"));
            }
        });
        Ok(())
    }

    fn desktop(&self) -> io::Result<()> {
        let (program, args) = match desktop_args(OS) {
            Some((program, args)) => (PathBuf::from(program), args),
            None => (desktop::desktop_app().ok_or(io::ErrorKind::NotFound)?, Vec::new()),
        };
        start(Command::new(program).args(args), Some(&self.log))
    }
}

/// Starts `command` and does not wait for it. With `log`, an exit that is not 0 is a log line without the arguments:
/// a sign-in URL carries its state in its query.
pub(crate) fn start(command: &mut Command, log: Option<&Arc<dyn Log>>) -> io::Result<()> {
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // Its own process group: a signal to the app's (a Ctrl-C where it was started from a shell) never reaches what it
    // opened.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(command, 0);
    #[cfg(any(target_os = "linux", all(test, unix)))]
    crate::appimage_env::remove(command);
    let mut child = {
        let _spawning = crate::cli::spawn_lock();
        command.spawn()?
    };
    let log = log.cloned();
    // Reaped off the caller's thread, so each click leaves no zombie behind.
    std::thread::spawn(move || match (child.wait(), log) {
        (Ok(status), Some(log)) if !status.success() => log.line(&match status.code() {
            Some(code) => format!("open: exit {code}"),
            None => "open: killed".to_string(),
        }),
        _ => {}
    });
    Ok(())
}

/// The shell's `open` on an https URL: the default browser, as Windows has no program to run for it. COM first, in a
/// single-threaded apartment without OLE1 DDE, as ShellExecute asks: a browser may be registered as a COM verb.
#[cfg(windows)]
fn shell_open(url: &str) -> io::Result<()> {
    use std::ptr;
    use windows_sys::Win32::System::Com::{
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
    };
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (verb, file) = (wide("open"), wide(url));
    // SAFETY: this thread's own apartment, set up before the shell call; nothing is reserved.
    let com = unsafe { CoInitializeEx(ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) };
    // SAFETY: both strings end in a NUL and outlive the call; the null ones ask for no window, parameters or folder.
    let done = unsafe {
        ShellExecuteW(ptr::null_mut(), verb.as_ptr(), file.as_ptr(), ptr::null(), ptr::null(), SW_SHOWNORMAL)
    };
    // Above 32 is success, for old programs' sake; at or under it, the reason is the thread's last error.
    let opened = if done as usize > 32 { Ok(()) } else { Err(io::Error::last_os_error()) };
    if com >= 0 {
        // SAFETY: once, for the CoInitializeEx above that succeeded, on the same thread.
        unsafe { CoUninitialize() };
    }
    opened
}

/// Explorer showing `zip`'s folder with `zip` selected, in a window already showing that folder if there is one. COM
/// first, in a single-threaded apartment, as the shell asks.
#[cfg(windows)]
fn shell_select(zip: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::System::Com::{
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
    };
    use windows_sys::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};
    let path = zip.as_os_str().encode_wide().chain([0]).collect::<Vec<u16>>();
    // SAFETY: this thread's own apartment, set up before the shell calls; nothing is reserved.
    let com = unsafe { CoInitializeEx(ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) };
    // SAFETY: the path ends in a NUL and outlives the call.
    let item = unsafe { ILCreateFromPathW(path.as_ptr()) };
    // Null: a path the shell cannot name, as one gone since the export.
    let selected = if item.is_null() {
        Err(io::ErrorKind::NotFound.into())
    } else {
        // SAFETY: `item` is the whole path of one item, which a count of 0 selects in its folder; freed once, after.
        let done = unsafe { SHOpenFolderAndSelectItems(item, 0, ptr::null(), 0) };
        unsafe { ILFree(item) };
        if done >= 0 { Ok(()) } else { Err(io::Error::from_raw_os_error(done)) }
    };
    if com >= 0 {
        // SAFETY: once, for the CoInitializeEx above that succeeded, on the same thread.
        unsafe { CoUninitialize() };
    }
    selected
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const URL: &str = "https://id.example/a?state=S";
    const ZIP: &str = "/Users/p/Desktop/harness-logs-20261118-1030.zip";

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn what_opens_a_url_on_each_os() {
        assert_eq!(url_args("macos", URL), Some(("/usr/bin/open", strings(&[URL]))));
        assert_eq!(url_args("linux", URL), Some(("xdg-open", strings(&[URL]))));
        // Windows' shell opens it: there is no program to run.
        assert_eq!(url_args("windows", URL), None);
    }

    #[test]
    fn only_an_https_url_goes_to_the_windows_shell() {
        assert_eq!(shell_url(URL), Some(URL));
        let refused = [
            "http://id.example/a",
            "HTTPS://id.example/a",
            " https://id.example/a",
            "file:///C:/Windows/System32/calc.exe",
            r"C:\Windows\System32\calc.exe",
            "calc",
            "",
            // The shell puts the URL in a browser's command line, between quotes.
            r#"https://id.example/a" --flag"#,
            "https://id.example/a --flag",
            "https://id.example/a\n",
        ];
        for url in refused {
            assert_eq!(shell_url(url), None, "{url:?}");
        }
    }

    #[test]
    fn what_shows_the_zip_on_each_os() {
        assert_eq!(reveal_args("macos", Path::new(ZIP)), Some(("/usr/bin/open", strings(&["-R", ZIP]))));
        assert_eq!(reveal_args("linux", Path::new(ZIP)), Some(("xdg-open", strings(&["/Users/p/Desktop"]))));
        // Windows' shell selects it: `explorer.exe /select,` opens the folder without selecting on a first call.
        let zip = r"C:\Users\p\Desktop\harness-logs-20261118-1030.zip";
        assert_eq!(reveal_args("windows", Path::new(zip)), None);
    }

    #[test]
    fn open_harness_is_one_fixed_command_on_a_mac_and_the_apps_own_file_elsewhere() {
        assert_eq!(desktop_args("macos"), Some(("/usr/bin/open", strings(&["-b", "ai.autonomous.harness"]))));
        // desktop::desktop_app(), run with no argument.
        assert_eq!(desktop_args("linux"), None);
        assert_eq!(desktop_args("windows"), None);
    }

    #[cfg(unix)]
    #[test]
    fn what_opens_starts_without_what_the_appimage_set() {
        use crate::appimage_env::tests::{PERSON_PATH, assert_outside, from_an_appimage};
        use std::{fs, sync::mpsc, thread, time::Duration};
        // A page, the logs' folder, Harness and Linux's terminal all start this way.
        let folder = tempfile::tempdir().unwrap();
        let fifo = folder.path().join("env");
        let made = {
            let _spawning = crate::cli::spawn_lock();
            Command::new("mkfifo").arg(&fifo).status().unwrap()
        };
        assert!(made.success());
        let mut command = Command::new("/bin/sh");
        command.args(["-c", r#"env > "$0""#]).arg(&fifo).envs(from_an_appimage(&[("PATH", PERSON_PATH)]));
        start(&mut command, None).unwrap();
        // Read on a thread, so a child that never writes fails the test instead of hanging it.
        let (send, printed) = mpsc::channel();
        thread::spawn(move || send.send(fs::read_to_string(fifo)));
        assert_outside(&printed.recv_timeout(Duration::from_secs(5)).unwrap().unwrap());
    }
}
