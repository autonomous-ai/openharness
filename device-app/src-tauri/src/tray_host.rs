//! Linux: whether the session has a tray host to show the icon.

/// The name a StatusNotifier host owns on the session bus. With no owner the icon shows nowhere: stock GNOME has none
/// until the AppIndicator extension is on.
pub const WATCHER: &str = "org.kde.StatusNotifierWatcher";

/// The log line for the bus's answer: only a bus that says no watcher is there. A bus that cannot be asked says
/// nothing about the tray.
pub fn log_line(answer: Option<bool>) -> Option<&'static str> {
    (answer == Some(false)).then_some("tray: no host")
}

/// Whether a watcher is on the session bus; `None` when the bus cannot be asked.
#[cfg(target_os = "linux")]
pub fn host_there() -> Option<bool> {
    asks(&dbus::blocking::Connection::new_session().ok()?)
}

#[cfg(target_os = "linux")]
fn asks(bus: &dbus::blocking::Connection) -> Option<bool> {
    let daemon = bus.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", std::time::Duration::from_secs(2));
    let (owned,): (bool,) = daemon.method_call("org.freedesktop.DBus", "NameHasOwner", (WATCHER,)).ok()?;
    Some(owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_bus_with_no_watcher_logs_no_host() {
        assert_eq!(log_line(Some(false)), Some("tray: no host"));
        assert_eq!(log_line(Some(true)), None);
        // A bus that cannot be asked says nothing about the tray.
        assert_eq!(log_line(None), None);
    }

    /// A session bus of the test's own, so no test reads or changes the environment's.
    #[cfg(target_os = "linux")]
    struct Bus {
        daemon: std::process::Child,
        address: String,
    }

    #[cfg(target_os = "linux")]
    impl Bus {
        fn start() -> Bus {
            use std::io::{BufRead, BufReader};
            use std::process::{Command, Stdio};
            let mut daemon = Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--print-address=1"])
                .stdout(Stdio::piped())
                .spawn()
                .expect("dbus-daemon starts");
            // The daemon prints its address once it listens: the read ends on that line, no sleep.
            let mut address = String::new();
            BufReader::new(daemon.stdout.take().unwrap()).read_line(&mut address).unwrap();
            Bus { daemon, address: address.trim().to_string() }
        }

        fn connect(&self) -> dbus::blocking::Connection {
            let mut channel = dbus::channel::Channel::open_private(&self.address).unwrap();
            channel.register().unwrap();
            channel.into()
        }
    }

    #[cfg(target_os = "linux")]
    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.daemon.kill();
            let _ = self.daemon.wait();
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_watcher_on_the_bus_is_a_host_and_none_is_no_host() {
        let bus = Bus::start();
        let app = bus.connect();
        assert_eq!(asks(&app), Some(false));

        let watcher = bus.connect();
        watcher.request_name(WATCHER, false, false, true).unwrap();
        assert_eq!(asks(&app), Some(true));

        watcher.release_name(WATCHER).unwrap();
        assert_eq!(asks(&app), Some(false));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_bus_that_is_gone_cannot_be_asked() {
        let bus = Bus::start();
        let app = bus.connect();
        drop(bus);
        assert_eq!(asks(&app), None);
    }
}
