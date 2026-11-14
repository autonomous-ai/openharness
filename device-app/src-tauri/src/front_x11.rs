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

    #[test]
    fn a_wayland_session_is_not_x11() {
        let x11 = [
            (Some("x11"), None, Some(":0")),
            // startx from a console, or a session manager that sets no type.
            (Some("tty"), None, Some(":0")),
            (None, None, Some(":1")),
        ];
        for (session_type, wayland_display, display) in x11 {
            assert!(session_is_x11(session_type, wayland_display, display), "{session_type:?} {display:?}");
        }
        let not_x11 = [
            // XWayland's DISPLAY under Wayland: X11 windows only, never the app in front.
            (Some("wayland"), Some("wayland-0"), Some(":0")),
            (Some("wayland"), None, Some(":0")),
            (None, Some("wayland-0"), Some(":0")),
            (Some("x11"), Some("wayland-1"), Some(":0")),
            (Some("x11"), None, None),
            (Some("x11"), None, Some("")),
            (None, None, None),
        ];
        for (session_type, wayland_display, display) in not_x11 {
            assert!(
                !session_is_x11(session_type, wayland_display, display),
                "{session_type:?} {wayland_display:?} {display:?}"
            );
        }
        // An empty WAYLAND_DISPLAY names no display.
        assert!(session_is_x11(Some("x11"), Some(""), Some(":0")));
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
        X11Front.start(Box::new(move |value| {
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
