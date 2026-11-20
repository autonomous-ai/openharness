//! Which app is in front, for the dial to follow. The value (a bundle id, an exe name) goes on the watch's stdin and
//! nowhere else: never an Event, the log, the state file or the window.

use crate::types::Log;
use std::sync::Arc;

/// What an OS names an app is outside text: past this it is cut. With only `kept` characters the longest line is 140
/// bytes, one write a pipe takes whole on every OS (macOS's PIPE_BUF is 512): a slow watch never sees it torn.
pub const FRONT_MAX: usize = 128;

/// Where the app in front is read. The OS tells it: no source polls.
pub trait FrontSource: Send + Sync {
    /// `changed` gets the app in front now, once, then each new one. An app with no name is the empty string.
    fn start(&self, changed: Box<dyn Fn(String) + Send + Sync>);
}

/// Reports nothing: a Linux session with no common way to tell the app in front (GNOME or KDE on Wayland).
pub struct NoFront;

impl FrontSource for NoFront {
    fn start(&self, _changed: Box<dyn Fn(String) + Send + Sync>) {}
}

/// The source this platform and session have. A source that stops after it starts says so in `log`.
pub fn system(#[cfg_attr(target_os = "macos", expect(unused_variables))] log: Arc<dyn Log>) -> Arc<dyn FrontSource> {
    #[cfg(target_os = "macos")]
    return Arc::new(crate::front_macos::MacFront);
    #[cfg(windows)]
    return Arc::new(crate::front_windows::WinFront { log });
    #[cfg(target_os = "linux")]
    return match linux_front(&|name| std::env::var(name).ok()) {
        LinuxFront::X11(display) => Arc::new(crate::front_x11::X11Front { log, display }),
        LinuxFront::Sway => Arc::new(crate::front_sway::SwayFront { log }),
        LinuxFront::Hyprland => Arc::new(crate::front_hyprland::HyprlandFront { log }),
        LinuxFront::None => Arc::new(NoFront),
    };
}

/// Which window system a Linux session tells the app in front through.
#[derive(Debug, PartialEq, Eq)]
pub enum LinuxFront {
    /// The session's DISPLAY.
    X11(String),
    Sway,
    Hyprland,
    None,
}

/// X11 first: an X11 session started from inside sway or Hyprland keeps their variables, but its windows are X11's.
/// An empty value is unset.
pub fn linux_front(var: &dyn Fn(&str) -> Option<String>) -> LinuxFront {
    let set = |name| var(name).is_some_and(|value| !value.is_empty());
    let (session_type, wayland_display) = (var("XDG_SESSION_TYPE"), var("WAYLAND_DISPLAY"));
    match var("DISPLAY") {
        Some(display) if session_is_x11(session_type.as_deref(), wayland_display.as_deref(), Some(&display)) => {
            LinuxFront::X11(display)
        }
        _ if set("SWAYSOCK") => LinuxFront::Sway,
        _ if set("HYPRLAND_INSTANCE_SIGNATURE") => LinuxFront::Hyprland,
        _ => LinuxFront::None,
    }
}

/// Which source is following the app in front, so a line that it stopped names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    X11,
    Sway,
    Hyprland,
    Windows,
}

/// Why a source stopped telling; it tells nothing more. Each is one fixed log line, never the error's own text: that
/// carries a display, a socket path or the window system's words.
#[derive(Debug, PartialEq, Eq)]
pub enum Stop {
    /// The window system could not be reached, or no thread could follow it.
    NotFollowed,
    /// The connection to it ended.
    Ended,
}

impl Stop {
    pub fn line(&self, source: Source) -> &'static str {
        match (source, self) {
            (Source::X11, Stop::NotFollowed) => "front: X11 not followed",
            (Source::X11, Stop::Ended) => "front: X11 ended",
            (Source::Sway, Stop::NotFollowed) => "front: sway not followed",
            (Source::Sway, Stop::Ended) => "front: sway ended",
            (Source::Hyprland, Stop::NotFollowed) => "front: Hyprland not followed",
            (Source::Hyprland, Stop::Ended) => "front: Hyprland ended",
            (Source::Windows, Stop::NotFollowed) => "front: Windows not followed",
            (Source::Windows, Stop::Ended) => "front: Windows ended",
        }
    }
}

/// `follow` on a thread named for its source, then the line of why it stopped.
pub fn on_thread(log: Arc<dyn Log>, source: Source, follow: impl FnOnce() -> Stop + Send + 'static) {
    let name = match source {
        Source::X11 => "front-x11",
        Source::Sway => "front-sway",
        Source::Hyprland => "front-hyprland",
        Source::Windows => "front-windows",
    };
    let told = log.clone();
    let spawned = std::thread::Builder::new().name(name.into()).spawn(move || told.line(follow().line(source)));
    if spawned.is_err() {
        log.line(Stop::NotFollowed.line(source));
    }
}

/// Under Wayland, XWayland's DISPLAY sees only X11 windows, never the app in front: read X11 only in an X11 session.
pub fn session_is_x11(session_type: Option<&str>, wayland_display: Option<&str>, display: Option<&str>) -> bool {
    let set = |value: Option<&str>| value.is_some_and(|value| !value.is_empty());
    session_type != Some("wayland") && !set(wayland_display) && set(display)
}

/// `{"front":"…"}`, one line: the value cut to FRONT_MAX characters. A value with a character that is not `kept` is the
/// empty value.
pub fn front_line(value: &str) -> String {
    let cut: String = value.chars().take(FRONT_MAX).collect();
    let value = if value.chars().all(kept) { cut } else { String::new() };
    serde_json::json!({ "front": value }).to_string()
}

/// `[A-Za-z0-9._ -]`: every bundle id and exe name the watch's table maps is ASCII, so any other value is no app.
fn kept(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ' ' | '-')
}

/// What the watch has been told: a line only for a change, and the last one again for a watch that has just started.
#[derive(Default)]
pub struct FrontFeed {
    last: Option<String>,
}

impl FrontFeed {
    /// The line to write; None when the watch was told it already.
    pub fn changed(&mut self, value: &str) -> Option<String> {
        let line = front_line(value);
        if self.last.as_ref() == Some(&line) {
            return None;
        }
        self.last = Some(line.clone());
        Some(line)
    }

    /// The line a new watch is told first; None until the source has told one.
    pub fn current(&self) -> Option<String> {
        self.last.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    fn line(value: &str) -> String {
        json!({ "front": value }).to_string()
    }

    #[test]
    fn one_line_per_change_and_none_for_a_repeat() {
        let mut feed = FrontFeed::default();
        assert_eq!(feed.current(), None);
        assert_eq!(feed.changed("com.mitchellh.ghostty"), Some(r#"{"front":"com.mitchellh.ghostty"}"#.into()));
        assert_eq!(feed.changed("com.mitchellh.ghostty"), None);
        // An app with no name is a change too.
        assert_eq!(feed.changed(""), Some(r#"{"front":""}"#.into()));
        assert_eq!(feed.changed("Code.exe"), Some(r#"{"front":"Code.exe"}"#.into()));
        assert_eq!(feed.current(), Some(r#"{"front":"Code.exe"}"#.into()));
        // Two values the cut makes one are a repeat: the watch would be told the same line.
        let long = "x".repeat(FRONT_MAX);
        assert_eq!(feed.changed(&format!("{long}a")), Some(line(&long)));
        assert_eq!(feed.changed(&format!("{long}b")), None);
        assert_eq!(feed.current(), Some(line(&long)));
    }

    #[test]
    fn a_value_is_cut_to_128_characters() {
        let whole = "a".repeat(FRONT_MAX);
        assert_eq!(front_line(&whole), line(&whole));
        assert_eq!(front_line(&"a".repeat(200)), line(&whole));
    }

    #[test]
    fn a_value_with_a_character_the_watch_never_maps_is_the_empty_value() {
        // Bundle ids and exe names, spaces and underscores too.
        for kept in ["com.mitchellh.ghostty", "wezterm-gui", "Code.exe", "Visual Studio Code", "a_b", "A1"] {
            assert_eq!(front_line(kept), line(kept));
        }
        for other in [
            "a\"b",
            "a\nb",
            "a\\b",
            "a\u{1}b",
            "caf\u{e9}",
            "\u{1f980}",
            "a/b",
            "a+b",
            &format!("{}\u{e9}", "a".repeat(200)),
        ] {
            assert_eq!(front_line(other), line(""), "{other:?}");
        }
    }

    #[test]
    fn the_longest_line_is_one_atomic_pipe_write() {
        // macOS writes up to PIPE_BUF, 512 bytes, to a pipe whole or not at all: a longer line could be torn when
        // the watch is slow to read.
        for value in ["a", "\u{1}", "\u{1f980}", "\""] {
            let written = front_line(&value.repeat(200));
            assert!(written.len() <= 512, "{value:?}: {}", written.len());
            assert!(!written.contains(['\n', '\r']), "{written}");
        }
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

    #[test]
    fn the_linux_source_is_x11_then_sway_then_hyprland_then_none() {
        let front = |vars: &[(&str, &str)]| {
            let vars: Vec<(String, String)> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            linux_front(&|name| vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()))
        };
        let both = [("SWAYSOCK", "/run/user/1000/sway-ipc.sock"), ("HYPRLAND_INSTANCE_SIGNATURE", "abc_1_2")];
        assert_eq!(
            front(&[[("XDG_SESSION_TYPE", "x11"), ("DISPLAY", ":0")].as_slice(), &both[..1]].concat()),
            LinuxFront::X11(":0".into())
        );
        let wayland = [("XDG_SESSION_TYPE", "wayland"), ("WAYLAND_DISPLAY", "wayland-1"), ("DISPLAY", ":0")];
        assert_eq!(front(&[wayland.as_slice(), &both].concat()), LinuxFront::Sway);
        assert_eq!(front(&[wayland.as_slice(), &both[1..]].concat()), LinuxFront::Hyprland);
        // GNOME or KDE on Wayland: no common way to tell the app in front.
        assert_eq!(front(&wayland), LinuxFront::None);
        // An empty value counts as unset.
        let empty = [("SWAYSOCK", ""), ("HYPRLAND_INSTANCE_SIGNATURE", "abc_1_2")];
        assert_eq!(front(&[wayland.as_slice(), &empty].concat()), LinuxFront::Hyprland);
        let empty = [("SWAYSOCK", ""), ("HYPRLAND_INSTANCE_SIGNATURE", "")];
        assert_eq!(front(&[wayland.as_slice(), &empty].concat()), LinuxFront::None);
    }

    const WAIT: std::time::Duration = std::time::Duration::from_secs(5);

    /// A log that hands each line on, so a test waits for it without a sleep.
    struct Lines(std::sync::mpsc::Sender<String>);
    impl Log for Lines {
        fn line(&self, text: &str) {
            let _ = self.0.send(text.into());
        }
    }

    #[test]
    fn why_following_stopped_is_one_fixed_line_per_source() {
        let cases = [
            (Source::X11, "front-x11", "front: X11 not followed", "front: X11 ended"),
            (Source::Sway, "front-sway", "front: sway not followed", "front: sway ended"),
            (Source::Hyprland, "front-hyprland", "front: Hyprland not followed", "front: Hyprland ended"),
            (Source::Windows, "front-windows", "front: Windows not followed", "front: Windows ended"),
        ];
        for (source, thread, not_followed, ended) in cases {
            for (stop, line) in [(Stop::NotFollowed, not_followed), (Stop::Ended, ended)] {
                let (send, lines) = std::sync::mpsc::channel();
                let (name, named) = std::sync::mpsc::channel();
                on_thread(Arc::new(Lines(send)), source, move || {
                    let _ = name.send(std::thread::current().name().map(String::from));
                    stop
                });
                assert_eq!(named.recv_timeout(WAIT), Ok(Some(thread.into())));
                assert_eq!(lines.recv_timeout(WAIT).as_deref(), Ok(line));
                // The thread has ended and dropped the log: one line, then nothing.
                assert_eq!(lines.recv_timeout(WAIT), Err(std::sync::mpsc::RecvTimeoutError::Disconnected));
            }
        }
    }

    #[test]
    fn no_front_reports_nothing() {
        let told = Arc::new(Mutex::new(Vec::new()));
        let into = told.clone();
        NoFront.start(Box::new(move |value| into.lock().unwrap().push(value)));
        assert!(told.lock().unwrap().is_empty());
    }
}
