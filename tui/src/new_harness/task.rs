//! The first task: inline editing and the launch contract shared with desktop.
use super::*;
mod editor;
pub(super) use editor::Editor;

// Keep these aligned with cli/src/lib/engineLaunch.ts and desktop/lib/core/first_task.dart.
pub(super) const MAX_LENGTH: usize = 2000;

pub(super) fn length(text: &str) -> usize { text.trim().encode_utf16().count() }

pub(super) fn supported(engine: &str) -> bool {
    matches!(engine, "claude" | "codex" | "opencode" | "hermes")
}

pub(super) fn error(engine: &str, text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        None
    } else if !supported(engine) {
        Some("This agent cannot start with a task. Clear Task or choose another agent.".into())
    } else if text.encode_utf16().count() > MAX_LENGTH {
        Some(format!(
            "Task is too long. Shorten it to {MAX_LENGTH} characters."
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_task_matches_the_launch_contract() {
        assert!(error("terminal", "   ").is_none());
        assert!(error("terminal", "do work").is_some());
        for engine in ["claude", "codex", "opencode", "hermes"] {
            assert!(error(engine, &"🦀".repeat(1000)).is_none());
            assert!(error(engine, &"🦀".repeat(1001)).is_some());
            assert!(error(engine, &format!("  {}  ", "a".repeat(2000))).is_none());
        }
    }
}
