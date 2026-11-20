//! The app in front on Linux X11: the window manager sets the root window's `_NET_ACTIVE_WINDOW`, and the X server
//! tells each change. No timer, no permission. Started for an X11 session only (`front::linux_front`).

use std::path::Path;
#[cfg(target_os = "linux")]
use {
    crate::front::{FrontSource, Source, Stop, on_thread},
    crate::types::Log,
    std::error::Error,
    std::sync::Arc,
    x11rb::connection::Connection,
    x11rb::protocol::Event,
    x11rb::protocol::xproto::{Atom, AtomEnum, ChangeWindowAttributesAux, ConnectionExt as _, EventMask, Window},
    x11rb::rust_connection::RustConnection,
};

/// The exe name of the process whose window is active: once at start, then on each change.
#[cfg(target_os = "linux")]
pub struct X11Front {
    pub log: Arc<dyn Log>,
    /// The session's DISPLAY.
    pub display: String,
}

#[cfg(target_os = "linux")]
impl FrontSource for X11Front {
    fn start(&self, changed: Box<dyn Fn(String) + Send + Sync>) {
        let display = self.display.clone();
        // Connecting can wait on a remote display: never on the thread that starts the app.
        on_thread(self.log.clone(), Source::X11, move || follow(&display, &*changed));
    }
}

/// Tells the app in front now, then on each change, until the connection ends.
#[cfg(target_os = "linux")]
fn follow(display: &str, changed: &dyn Fn(String)) -> Stop {
    let Ok((conn, root, active, wm_pid)) = subscribe(display) else { return Stop::NotFollowed };
    let front = || {
        let window =
            property32(&conn, root, active, AtomEnum::WINDOW, 1).first().copied().filter(|&w| w != x11rb::NONE);
        let pid = window.and_then(|window| property32(&conn, window, wm_pid, AtomEnum::CARDINAL, 1).first().copied());
        pid.and_then(|pid| exe_name(Path::new("/proc"), pid)).unwrap_or_default()
    };
    changed(front());
    loop {
        match conn.wait_for_event() {
            Err(_) => return Stop::Ended,
            Ok(Event::PropertyNotify(event)) if event.window == root && event.atom == active => changed(front()),
            Ok(_) => {}
        }
    }
}

/// A connection to `display` told each change of the root window's properties, with the root and the atoms of the
/// active window and of a window's pid.
#[cfg(target_os = "linux")]
fn subscribe(display: &str) -> Result<(RustConnection, Window, Atom, Atom), Box<dyn Error>> {
    let (conn, screen) = x11rb::connect(Some(display))?;
    let root = conn.setup().roots[screen].root;
    let (active, wm_pid) = (conn.intern_atom(false, b"_NET_ACTIVE_WINDOW")?, conn.intern_atom(false, b"_NET_WM_PID")?);
    let (active, wm_pid) = (active.reply()?.atom, wm_pid.reply()?.atom);
    // Asked for before the first read, so a change between the two is not missed.
    let mask = ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE);
    conn.change_window_attributes(root, &mask)?.check()?;
    Ok((conn, root, active, wm_pid))
}

/// Up to `length` values of a window's 32-bit property: none when it is unset, of another type, or the window is gone.
#[cfg(target_os = "linux")]
fn property32(conn: &impl Connection, window: Window, property: Atom, kind: AtomEnum, length: u32) -> Vec<u32> {
    let reply = conn.get_property(false, window, property, kind, 0, length).ok().and_then(|cookie| cookie.reply().ok());
    reply.and_then(|reply| reply.value32().map(Iterator::collect)).unwrap_or_default()
}

/// The file name of `/proc/<pid>/exe`, which the watch maps to an app (`code`, `ghostty`). None when the process is
/// gone or is another person's.
pub fn exe_name(proc_root: &Path, pid: u32) -> Option<String> {
    let exe = std::fs::read_link(proc_root.join(pid.to_string()).join("exe")).ok()?;
    let name = exe.file_name()?.to_str()?;
    // The kernel's mark on a binary replaced while it runs (a package upgrade): still the same app.
    Some(name.strip_suffix(" (deleted)").unwrap_or(name).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    #[test]
    fn the_exe_name_is_the_file_name_of_the_proc_link() {
        let proc_root = tempfile::tempdir().unwrap();
        fs::create_dir(proc_root.path().join("4242")).unwrap();
        // The link's target need not exist: only its name is read.
        symlink("/usr/share/code/code", proc_root.path().join("4242").join("exe")).unwrap();
        assert_eq!(exe_name(proc_root.path(), 4242), Some("code".into()));
        // A binary replaced while it runs (a package upgrade) is still the same app.
        fs::create_dir(proc_root.path().join("4343")).unwrap();
        symlink("/usr/bin/ghostty (deleted)", proc_root.path().join("4343").join("exe")).unwrap();
        assert_eq!(exe_name(proc_root.path(), 4343), Some("ghostty".into()));
    }

    #[test]
    fn a_process_that_is_gone_has_no_name() {
        let proc_root = tempfile::tempdir().unwrap();
        assert_eq!(exe_name(proc_root.path(), 4242), None);
        // Another person's process: its folder is there and its link cannot be read.
        fs::create_dir(proc_root.path().join("4343")).unwrap();
        assert_eq!(exe_name(proc_root.path(), 4343), None);
    }

    #[cfg(target_os = "linux")]
    const WAIT: std::time::Duration = std::time::Duration::from_secs(5);

    /// A log that hands each line on, so a test waits for it without a sleep.
    #[cfg(target_os = "linux")]
    struct Lines(std::sync::mpsc::Sender<String>);
    #[cfg(target_os = "linux")]
    impl Log for Lines {
        fn line(&self, text: &str) {
            let _ = self.0.send(text.into());
        }
    }

    #[cfg(target_os = "linux")]
    fn lines() -> (Arc<dyn Log>, std::sync::mpsc::Receiver<String>) {
        let (send, lines) = std::sync::mpsc::channel();
        (Arc::new(Lines(send)), lines)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_display_with_no_server_is_one_line_that_names_nothing() {
        let (log, lines) = lines();
        // A socket no server listens on: no TCP is tried for a `unix:` display.
        on_thread(log, Source::X11, || follow("unix:59000", &|_| {}));
        assert_eq!(lines.recv_timeout(WAIT).as_deref(), Ok("front: X11 not followed"));
        assert_eq!(lines.recv_timeout(WAIT), Err(std::sync::mpsc::RecvTimeoutError::Disconnected));
    }

    /// Run by PR CI under Xvfb (device-app-checks): `X11_LIVE_CLIENTS` names two X clients, split by ':'.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs an X server, a window manager and xdotool"]
    fn x11_live() {
        use std::process::{Child, Command};
        use std::sync::mpsc;

        /// Ends the clients the test started, whatever it ends with.
        struct Clients(Vec<Child>);
        impl Drop for Clients {
            fn drop(&mut self) {
                for client in &mut self.0 {
                    let _ = client.kill();
                    let _ = client.wait();
                }
            }
        }

        let paths = std::env::var("X11_LIVE_CLIENTS").expect("X11_LIVE_CLIENTS: two X clients, split by ':'");
        let (conn, screen) = x11rb::connect(None).expect("an X server on DISPLAY");
        let root = conn.setup().roots[screen].root;
        let [supported, active, client_list, wm_pid] =
            [b"_NET_SUPPORTED".as_slice(), b"_NET_ACTIVE_WINDOW", b"_NET_CLIENT_LIST", b"_NET_WM_PID"]
                .map(|name| conn.intern_atom(false, name).unwrap().reply().unwrap().atom);
        let changes = root_changes(screen);

        until(&changes, "the window manager", |_| {
            property32(&conn, root, supported, AtomEnum::ATOM, 1024).contains(&active)
        });
        let (tell, told) = mpsc::channel();
        // Through the app's own door, so a Linux build that gets another source fails here.
        crate::front::system(Arc::new(crate::types::MemoryLog::default())).start(Box::new(move |value| {
            let _ = tell.send(value);
        }));

        let mut clients = Clients(Vec::new());
        for path in paths.split(':') {
            let client = Command::new(path).spawn().unwrap();
            let pid = client.id();
            clients.0.push(client);
            let mut window = None;
            until(&changes, path, |_| {
                window = property32(&conn, root, client_list, AtomEnum::WINDOW, 1024)
                    .into_iter()
                    .find(|&window| property32(&conn, window, wm_pid, AtomEnum::CARDINAL, 1) == [pid]);
                window.is_some()
            });
            let activated = Command::new("xdotool").args(["windowactivate", &window.unwrap().to_string()]).status();
            assert!(activated.unwrap().success());
            let name = Path::new(path).file_name().unwrap().to_str().unwrap();
            until(&told, name, |value| value.as_deref() == Some(name));
        }
    }

    /// Each change of a root window property, from a connection of its own: asked for before this returns.
    #[cfg(target_os = "linux")]
    fn root_changes(screen: usize) -> std::sync::mpsc::Receiver<()> {
        let (conn, _) = x11rb::connect(None).unwrap();
        let root = conn.setup().roots[screen].root;
        let mask = ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE);
        conn.change_window_attributes(root, &mask).unwrap().check().unwrap();
        let (tell, changes) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(event) = conn.wait_for_event() {
                if matches!(event, Event::PropertyNotify(_)) && tell.send(()).is_err() {
                    return;
                }
            }
        });
        changes
    }

    /// Waits, up to 10 s, until `ready` holds: asked once at once, then with each item `items` gives.
    #[cfg(target_os = "linux")]
    fn until<T>(items: &std::sync::mpsc::Receiver<T>, what: &str, mut ready: impl FnMut(Option<T>) -> bool) {
        use std::time::{Duration, Instant};
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut item = None;
        while !ready(item) {
            let left = deadline.saturating_duration_since(Instant::now());
            item = Some(items.recv_timeout(left).unwrap_or_else(|error| panic!("{what}: {error} within 10 s")));
        }
    }
}
