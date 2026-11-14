//! Which app is in front, for the dial to follow. The value (a bundle id, an exe name) goes on the watch's stdin and
//! nowhere else: never an Event, the log, the state file or the window.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
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
        // Cut on a character boundary, never inside one.
        let cut = format!("{}é", "a".repeat(FRONT_MAX - 1));
        assert_eq!(front_line(&format!("{cut}z")), line(&cut));
        assert_eq!(front_line(&"🦀".repeat(200)), line(&"🦀".repeat(FRONT_MAX)));
    }

    #[test]
    fn a_quote_or_a_newline_stays_one_json_line() {
        let value = "a\"b\nc\\d\r\u{1}";
        let written = front_line(value);
        assert!(!written.contains(['\n', '\r']), "{written}");
        assert_eq!(serde_json::from_str::<Value>(&written).unwrap(), json!({ "front": value }));
        // Characters are counted before they are escaped, and the longest line stays under the 1 KiB the watch takes.
        let escaped = front_line(&"\u{1}".repeat(200));
        assert_eq!(serde_json::from_str::<Value>(&escaped).unwrap(), json!({ "front": "\u{1}".repeat(FRONT_MAX) }));
        assert!(escaped.len() < 1024, "{}", escaped.len());
    }

    #[test]
    fn no_front_reports_nothing() {
        let told = Arc::new(Mutex::new(Vec::new()));
        let into = told.clone();
        NoFront.start(Box::new(move |value| into.lock().unwrap().push(value)));
        assert!(told.lock().unwrap().is_empty());
    }
}
