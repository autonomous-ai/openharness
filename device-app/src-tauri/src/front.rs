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

/// Reports nothing: a platform with no source of its own yet (Windows, until its wave).
pub struct NoFront;

impl FrontSource for NoFront {
    fn start(&self, _changed: Box<dyn Fn(String) + Send + Sync>) {}
}

/// The source this platform has. Only the X11 one can fail after it starts, and says so in `log`.
pub fn system(
    #[cfg_attr(not(target_os = "linux"), expect(unused_variables))] log: Arc<dyn Log>,
) -> Arc<dyn FrontSource> {
    #[cfg(target_os = "macos")]
    let source = crate::front_macos::MacFront;
    #[cfg(target_os = "linux")]
    let source = crate::front_x11::X11Front { log };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let source = NoFront;
    Arc::new(source)
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
    fn no_front_reports_nothing() {
        let told = Arc::new(Mutex::new(Vec::new()));
        let into = told.clone();
        NoFront.start(Box::new(move |value| into.lock().unwrap().push(value)));
        assert!(told.lock().unwrap().is_empty());
    }
}
