//! A computer's first `hn`: OpenCode in a new project with a first task typed in, where tmux, and hn on
//! every later start, opens a shell. It is the desktop app's first workspace for someone with no coding
//! agent (desktop/lib/state/first_arrival.dart), in a terminal: a fresh Mac's first `hn` was a shell
//! prompt with nothing saying what to do next, and its first harness wrote its files straight into the
//! home folder (macOS VM, 2026-10-09).
//!
//! Only where the installer found no agent and no Harness, with a person at the terminal
//! (cli/scripts/install.sh, step 4b): it downloads OpenCode and leaves the mark [take] removes, so
//! this happens once, on a plain `hn` started where the installer ran, the home folder, within a day.
//! Nothing is sent: the task is typed into OpenCode's box and waits for the person's Return.
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};
use crate::app::{App, Placement};

/// What the desktop app types for someone with no agent (`FirstArrival.starterTask`).
pub const STARTER_TASK: &str = "make a small web page that shows today's date";
/// How long OpenCode may take to show its box: its first start on a fresh computer, or its install in
/// the pane when the installer's download did not finish.
const WAIT: Duration = Duration::from_secs(180);
/// A moment for the box to take focus after it is first drawn, as the desktop waits.
const SETTLE: Duration = Duration::from_millis(800);
/// A mark older than this is not a first run any more: the person has had the computer, and maybe
/// other agents, since the install.
const FRESH: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default)]
pub struct State {
    since: Option<Instant>,
    /// The harness this made, from its creation reply: the one pane the task goes to.
    agent: Option<(String, String)>,
    ready_at: Option<Instant>,
}

/// The installer's mark (cli/scripts/install.sh step 4b).
pub fn mark() -> std::path::PathBuf { crate::app::state_dir().join("first-run") }

/// The installer's mark, taken: true once, when hn was started in the home folder (where the installer
/// ran and its "Start here" was typed) and the mark is fresh. Started anywhere else, hn opens its shell
/// there and the mark waits; a stale one is removed.
pub fn take() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let here = std::env::current_dir().unwrap_or_default();
    take_at(&mark(), &here, Path::new(&home), SystemTime::now())
}

fn take_at(mark: &Path, here: &Path, home: &Path, now: SystemTime) -> bool {
    let Ok(meta) = std::fs::metadata(mark) else { return false };
    let age = meta.modified().ok().and_then(|at| now.duration_since(at).ok()).unwrap_or_default();
    if age > FRESH {
        let _ = std::fs::remove_file(mark);
        return false;
    }
    if home.as_os_str().is_empty() || here != home { return false }
    std::fs::remove_file(mark).is_ok()
}

/// OpenCode on this computer, in a new project the daemon makes and names, with nothing sent.
pub fn start(app: &mut App) {
    let machine = app.fleet.local_id.clone();
    let what = crate::modal::What { engine: "opencode".into(), dsh: None, label: crate::theme::engine_label("opencode").into() };
    app.first_run = State { since: Some(Instant::now()), ..State::default() };
    let opts = crate::input::NewOpts { first_run: true, ..Default::default() };
    crate::input::create_opts(app, machine, what, None, None, false, opts);
}

/// The creation reply: the harness the task is typed into.
pub fn created(app: &mut App, machine: &str, agent: &str) {
    if app.first_run.since.is_some() { app.first_run.agent = Some((machine.into(), agent.into())) }
}

/// Nothing was made: the shell this window would have had, where hn was started, unless the person has
/// opened something meanwhile.
pub fn failed(app: &mut App) {
    app.first_run = State::default();
    if app.tab().root.is_some() { return }
    let cwd = std::env::current_dir().ok().map(|d| d.display().to_string());
    crate::input::new_shell_from(app, None, Placement::Auto(None), cwd, None);
}

/// Types the task into the harness this made once OpenCode shows its box there, a moment after it is
/// first seen. Nowhere else: not another OpenCode the person opened meanwhile, not a shell the pane
/// fell back to.
pub fn tick(app: &mut App) {
    let Some(since) = app.first_run.since else { return };
    if since.elapsed() > WAIT {
        app.first_run = State::default();
        return;
    }
    let Some((machine, agent)) = app.first_run.agent.clone() else { return };
    let Some((_, pane)) = app.find_pane(&machine, &agent) else { return };
    let opencode = app.fleet.agent(&machine, &agent).is_some_and(|a| a.engine == "opencode");
    if !opencode || !app.panes.get(&pane).is_some_and(|p| opencode_ready(&p.text_range(None, None))) {
        app.first_run.ready_at = None;
        return;
    }
    if app.first_run.ready_at.get_or_insert_with(Instant::now).elapsed() < SETTLE { return }
    app.send_input(pane, STARTER_TASK.as_bytes());
    app.first_run = State::default();
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
    fn the_mark_is_taken_once_from_home_while_fresh() {
        let dir = std::env::temp_dir().join(format!("hn-first-run-{}", std::process::id()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mark = dir.join("first-run");
        let now = SystemTime::now();
        std::fs::write(&mark, "").unwrap();
        assert!(!take_at(&mark, &home.join("project"), &home, now), "started elsewhere: its shell there");
        assert!(mark.exists(), "the mark waits for a start at home");
        assert!(take_at(&mark, &home, &home, now));
        assert!(!take_at(&mark, &home, &home, now), "a second start is an ordinary one");
        std::fs::write(&mark, "").unwrap();
        assert!(!take_at(&mark, &home, &home, now + FRESH + Duration::from_secs(60)));
        assert!(!mark.exists(), "a stale mark is removed");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
