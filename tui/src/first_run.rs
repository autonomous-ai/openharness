//! A computer's first `hn`: OpenCode in a new project with a first task typed in, where tmux, and hn on
//! every later start, opens a shell. It is the desktop app's first workspace for someone with no coding
//! agent (desktop/lib/state/first_arrival.dart), in a terminal: a fresh Mac's first `hn` was a shell
//! prompt with nothing saying what to do next, and its first harness wrote its files straight into the
//! home folder (macOS VM, 2026-10-09).
//!
//! Only where the installer found no agent and no Harness (cli/scripts/install.sh, NEW_COMPUTER): it
//! downloads OpenCode and leaves the mark [take] removes, so this happens once. Nothing is sent: the task
//! is typed into OpenCode's box and waits for the person's Return.
use std::time::{Duration, Instant};
use crate::app::App;

/// What the desktop app types for someone with no agent (`FirstArrival.starterTask`).
pub const STARTER_TASK: &str = "make a small web page that shows today's date";
/// How long OpenCode may take to show its box: its first start on a fresh computer, or its install in
/// the pane when the installer's download did not finish.
const WAIT: Duration = Duration::from_secs(180);
/// A moment for the box to take focus after it is first drawn, as the desktop waits.
const SETTLE: Duration = Duration::from_millis(800);

#[derive(Default)]
pub struct State { since: Option<Instant>, ready_at: Option<Instant> }

/// The installer's mark (cli/scripts/install.sh step 3d).
pub fn mark() -> std::path::PathBuf { crate::app::state_dir().join("first-run") }

/// The installer's mark, taken: true once, on the computer it was left on.
pub fn take() -> bool {
    let mark = mark();
    mark.exists() && std::fs::remove_file(&mark).is_ok()
}

/// OpenCode on this computer, in a new project the daemon makes and names, with nothing sent.
pub fn start(app: &mut App) {
    let machine = app.fleet.local_id.clone();
    let what = crate::modal::What { engine: "opencode".into(), dsh: None, label: crate::theme::engine_label("opencode").into() };
    app.first_run = State { since: Some(Instant::now()), ready_at: None };
    crate::input::create_opts(app, machine, what, None, None, false, Default::default());
}

/// Types the task once OpenCode shows its box, a moment after it is first seen, and only into
/// OpenCode: a start that failed leaves a shell in the pane.
pub fn tick(app: &mut App) {
    let Some(since) = app.first_run.since else { return };
    if since.elapsed() > WAIT {
        app.first_run = State::default();
        return;
    }
    let Some(pane) = opencode_pane(app) else { return };
    if !app.panes.get(&pane).is_some_and(|p| opencode_ready(&p.text_range(None, None))) {
        app.first_run.ready_at = None;
        return;
    }
    if app.first_run.ready_at.get_or_insert_with(Instant::now).elapsed() < SETTLE { return }
    app.send_input(pane, STARTER_TASK.as_bytes());
    app.first_run = State::default();
}

fn opencode_pane(app: &App) -> Option<u64> {
    app.tab().panes().into_iter().find(|id| {
        app.panes.get(id).and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).is_some_and(|a| a.engine == "opencode")
    })
}

/// OpenCode's home screen: the key hints under its box or its placeholder, phrases only OpenCode
/// prints, so a shell or an install in progress never passes (desktop `FirstArrival.openCodeReady`).
pub fn opencode_ready(screen: &str) -> bool {
    let text = screen.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    text.contains("ctrl+p commands") || text.contains("ask anything")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencodes_box_is_known_by_its_own_words_only() {
        assert!(opencode_ready("  ┃ make a page\n  Build  auto · Muse Spark 1.3\n tab agents  ctrl+p   commands"));
        assert!(opencode_ready("> Ask anything... \"Fix a TODO in the codebase\""));
        assert!(!opencode_ready("admin@mac ~ % "));
        assert!(!opencode_ready("Installing OpenCode… almost there"));
    }

    #[test]
    fn the_mark_is_taken_once() {
        let mark = mark();
        std::fs::create_dir_all(mark.parent().unwrap()).unwrap();
        std::fs::write(&mark, "").unwrap();
        assert!(take());
        assert!(!take(), "a second start is an ordinary one");
    }
}
