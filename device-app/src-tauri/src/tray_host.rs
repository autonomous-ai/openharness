//! Linux: whether the session has a tray host to show the icon.

/// The name a StatusNotifier host owns on the session bus. With no owner the icon shows nowhere: stock GNOME has none
/// until the AppIndicator extension is on.
pub const WATCHER: &str = "org.kde.StatusNotifierWatcher";

/// The log line for the bus's answer: only a bus that says no watcher is there. A bus that cannot be asked says
/// nothing about the tray.
pub fn log_line(answer: Option<bool>) -> Option<&'static str> {
    (answer == Some(false)).then_some("tray: no host")
}

/// How long a watcher has to come: at login the panel may start after the app, and take its name then.
#[cfg(target_os = "linux")]
const HOST_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// Whether a watcher is on the session bus, or takes its name within HOST_WAIT; `None` when the bus cannot be asked.
#[cfg(target_os = "linux")]
pub fn host_there() -> Option<bool> {
    asks(&dbus::blocking::Connection::new_session().ok()?, HOST_WAIT)
}

/// Whether a watcher is on `bus` now, or takes its name before `wait` ends. The bus pushes the change: nothing polls.
#[cfg(target_os = "linux")]
fn asks(bus: &dbus::blocking::Connection, wait: std::time::Duration) -> Option<bool> {
    use std::time::Instant;
    let deadline = Instant::now() + wait;
    // Followed before the ask, so a name taken in between is a signal still to read.
    let rule = format!(
        "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',\
         arg0='{WATCHER}'"
    );
    bus.add_match_no_cb(&rule).ok()?;
    let daemon = bus.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", std::time::Duration::from_secs(2));
    let (owned,): (bool,) = daemon.method_call("org.freedesktop.DBus", "NameHasOwner", (WATCHER,)).ok()?;
    if owned {
        return Some(true);
    }
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Some(false);
        }
        if bus.channel().blocking_pop_message(left).ok()?.is_some_and(|message| taken(&message)) {
            return Some(true);
        }
    }
}

/// The bus saying the watcher's name has an owner now. Only the bus itself sends as `org.freedesktop.DBus`.
#[cfg(target_os = "linux")]
fn taken(message: &dbus::Message) -> bool {
    message.sender().is_some_and(|sender| &*sender == "org.freedesktop.DBus")
        && message.member().is_some_and(|member| &*member == "NameOwnerChanged")
        && message.read3::<&str, &str, &str>().is_ok_and(|(name, _, owner)| name == WATCHER && !owner.is_empty())
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

    #[cfg(target_os = "linux")]
    const WAIT: std::time::Duration = std::time::Duration::from_secs(5);

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
    fn a_watcher_on_the_bus_is_a_host_and_none_by_the_end_of_the_wait_is_no_host() {
        let bus = Bus::start();
        // Each ask on a connection of its own, as the app's is: none hears what an earlier one followed.
        let short = std::time::Duration::from_millis(100);
        assert_eq!(asks(&bus.connect(), short), Some(false));

        let watcher = bus.connect();
        watcher.request_name(WATCHER, false, false, true).unwrap();
        assert_eq!(asks(&bus.connect(), short), Some(true));

        watcher.release_name(WATCHER).unwrap();
        assert_eq!(asks(&bus.connect(), short), Some(false));
    }

    /// At login the panel may start after the app, and take the watcher's name a moment later.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_watcher_that_takes_its_name_after_the_first_ask_is_a_host() {
        let bus = Bus::start();
        // A monitor sees the app's NameHasOwner: the watcher takes its name only once the answer is no.
        let monitor = bus.connect();
        let rule = format!("type='method_call',member='NameHasOwner',arg0='{WATCHER}'");
        let daemon = monitor.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", WAIT);
        let () = daemon.method_call("org.freedesktop.DBus.Monitoring", "BecomeMonitor", (vec![rule], 0u32)).unwrap();
        let app = bus.connect();
        let asking = std::thread::spawn(move || asks(&app, WAIT));
        let deadline = std::time::Instant::now() + WAIT;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(!left.is_zero(), "the app asked NameHasOwner within {WAIT:?}");
            let message = monitor.channel().blocking_pop_message(left).unwrap();
            if message.is_some_and(|message| message.member().is_some_and(|member| &*member == "NameHasOwner")) {
                break;
            }
        }
        let watcher = bus.connect();
        watcher.request_name(WATCHER, false, false, true).unwrap();
        assert_eq!(asking.join().unwrap(), Some(true));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_bus_that_is_gone_cannot_be_asked() {
        let bus = Bus::start();
        let app = bus.connect();
        drop(bus);
        assert_eq!(asks(&app, WAIT), None);
    }
}
