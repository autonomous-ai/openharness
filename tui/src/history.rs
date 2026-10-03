//! tmux's typed prompt history: shared by clients, loaded and saved with history-file.

use std::path::PathBuf;
use crate::app::App;

const TYPES: [&str; 4] = ["command", "search", "target", "window-target"];
pub type History = [Vec<String>; 4];

/// Changes are replayed under the server file's lock. Two clients that typed before either
/// heard from the other must both keep their lines; clearing an empty stale copy still clears.
#[derive(Clone)]
pub enum Change { Add { kind: usize, line: String, limit: usize }, Clear(usize) }

impl Change {
    pub fn apply(&self, history: &mut History) {
        match self {
            Self::Clear(kind) => history[*kind].clear(),
            Self::Add { kind, line, limit } => {
                let h = &mut history[*kind];
                if h.last() != Some(line) { h.push(line.clone()) }
                // A repeated last line still trims when prompt-history-limit was reduced.
                if h.len() > *limit { h.drain(..h.len() - limit); }
            }
        }
    }
}

fn record(app: &mut App, change: Change) {
    change.apply(&mut app.history);
    app.history_changes.push(change);
    app.server_dirty = true;
}

pub fn add(app: &mut App, kind: usize, line: &str) {
    let limit = app.options.get("prompt-history-limit", "", None).and_then(|v| v.parse().ok()).unwrap_or(100);
    record(app, Change::Add { kind: kind.min(3), line: line.to_string(), limit });
}

pub fn clear(app: &mut App, kind: usize) { record(app, Change::Clear(kind.min(3))) }

fn path(file: &str) -> Option<PathBuf> {
    if file.starts_with('/') { return Some(PathBuf::from(file)) }
    file.strip_prefix("~/").and_then(|rest| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(rest)))
}

pub fn load(app: &mut App) {
    let Some(file) = app.options.get("history-file", "", None).and_then(|file| path(&file)) else { return };
    let Ok(text) = std::fs::read_to_string(file) else { return };
    for line in text.lines() {
        let (kind, value) = line.split_once(':').and_then(|(ty, value)| TYPES.iter().position(|t| *t == ty).map(|i| (i, value))).unwrap_or((0, line));
        add(app, kind, value);
    }
}

/// The server lock covers reading the current merged history and saving it to disk: a client
/// detaching with an older local copy cannot replace the newer file another client saved.
pub fn save(app: &App) { crate::server::save_history(app) }

pub fn save_file(file: &str, history: &History) {
    let Some(file) = path(file) else { return };
    let mut text = String::new();
    for (kind, lines) in history.iter().enumerate() {
        for line in lines { text.push_str(TYPES[kind]); text.push(':'); text.push_str(line); text.push('\n'); }
    }
    let temp = file.with_extension(format!("{}.tmp", std::process::id()));
    if std::fs::write(&temp, text).is_ok() {
        if std::fs::rename(&temp, &file).is_err() { let _ = std::fs::remove_file(&temp); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add(kind: usize, line: &str, limit: usize) -> Change { Change::Add { kind, line: line.into(), limit } }

    #[test]
    fn concurrent_prompt_additions_preserve_both_clients() {
        let mut shared = History::default();
        add(0, "first", 100).apply(&mut shared);
        // Both clients began with just "first". Their pending additions are independent.
        let a = [add(0, "from a", 100)];
        let b = [add(0, "from b", 100), add(1, "needle", 100)];
        for change in a.iter().chain(&b) { change.apply(&mut shared) }
        assert_eq!(shared[0], ["first", "from a", "from b"]);
        assert_eq!(shared[1], ["needle"]);
    }

    #[test]
    fn clear_from_stale_client_and_append_keep_their_order() {
        let mut shared = History::default();
        add(0, "another client's line", 100).apply(&mut shared);
        add(1, "search", 100).apply(&mut shared);
        // The clearing client can still have an empty local history when it asks to clear.
        for change in [Change::Clear(0), add(0, "after clear", 100)] { change.apply(&mut shared) }
        assert_eq!(shared[0], ["after clear"]);
        assert_eq!(shared[1], ["search"]);
    }

    #[test]
    fn repeated_lines_respect_reduced_history_limit() {
        let mut shared = History::default();
        for line in ["a", "b", "c"] { add(0, line, 100).apply(&mut shared) }
        add(0, "c", 2).apply(&mut shared);
        assert_eq!(shared[0], ["b", "c"]);
        add(0, "d", 2).apply(&mut shared);
        assert_eq!(shared[0], ["c", "d"]);
        add(0, "d", 0).apply(&mut shared);
        assert!(shared[0].is_empty());
    }
}
