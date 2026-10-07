//! Auto rename (`@hn-auto-rename on`, tui.toml `auto_rename`): a window with a repo is named for the
//! repo and the work its panes do — `Harness TUI LMStudio` — by the daemon (`window_name`,
//! cli/src/services/windowNames.ts; docs/plans/2026-10-07-002-window-auto-rename-daemon-plan.md). The
//! daemon holds the rules, picks a small model and keeps the names, so every app asking for the same
//! window gets the same name. Off (the default), no window is asked for and every name is as before.
//!
//! A window is asked of the machine most of its harness panes in a git repo are on, with that machine's
//! agents in pane order. Until its name comes — and with no repo, an older daemon or no model — the
//! window keeps the name it has. A name you set always wins.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::app::App;

/// What a window's name is asked from: the machine, its agents in pane order, and [key] — those agents
/// with the names they are shown by now, so a title changing asks again.
#[derive(Debug, PartialEq)]
pub struct Ask { pub machine: String, pub agents: Vec<String>, pub key: String }

/// What the daemon said of a window.
enum Answer { Name(String), None(Instant) }

/// The daemon's answers, by [Ask::key]; the windows asked now; the machines that could not answer.
#[derive(Default)]
pub struct Namer {
    answers: HashMap<String, Answer>,
    asking: HashMap<String, Instant>,
    quiet: HashMap<String, Instant>,
}

/// A window with no name (no repo, no model) or a machine that could not answer is asked again after this.
const RETRY: Duration = Duration::from_secs(600);
/// A window being named is asked again after this.
const AGAIN: Duration = Duration::from_secs(5);
/// What the daemon has to answer in (it answers at once: `pending` while it names the window).
const BUDGET: Duration = Duration::from_secs(15);

/// The ask for window [index]: the machine most of its harness panes in a git repo (a branch) are on —
/// a tie, the first in pane order — and that machine's agents in the window, in pane order, each once
/// (the daemon picks among them). None when no harness pane is in a repo.
pub fn ask(app: &App, index: usize) -> Option<Ask> {
    let tab = app.tabs.get(index)?;
    let mut agents: Vec<(String, String, String)> = Vec::new();
    let mut repo: Vec<(String, usize)> = Vec::new();
    for id in tab.panes() {
        let Some(pane) = app.panes.get(&id) else { continue };
        if agents.iter().any(|(m, a, _)| *m == pane.machine_id && *a == pane.agent_id) { continue }
        let Some(agent) = app.fleet.agent(&pane.machine_id, &pane.agent_id) else { continue };
        agents.push((pane.machine_id.clone(), pane.agent_id.clone(), agent.name.clone()));
        if agent.engine == "terminal" || agent.project.is_empty() || agent.branch.is_empty() { continue }
        match repo.iter_mut().find(|(m, _)| *m == pane.machine_id) { Some((_, n)) => *n += 1, None => repo.push((pane.machine_id.clone(), 1)) }
    }
    let machine = repo.iter().fold(None::<&(String, usize)>, |best, r| match best { Some(b) if b.1 >= r.1 => best, _ => Some(r) })?.0.clone();
    let mine: Vec<&(String, String, String)> = agents.iter().filter(|(m, _, _)| *m == machine).collect();
    let key = format!("{machine}\n{}", mine.iter().map(|(_, a, n)| format!("{a}\t{n}")).collect::<Vec<_>>().join("\n"));
    Some(Ask { machine, agents: mine.iter().map(|(_, a, _)| a.clone()).collect(), key })
}

/// Whether window [index] has auto rename's name now — `#{window_auto_named}`, so a status bar that
/// shows the selected pane's title shows this name instead.
pub fn named(app: &App, index: usize) -> bool {
    app.options.auto_rename() && app.tabs.get(index).is_some_and(|t| !t.named && !t.home)
        && ask(app, index).is_some_and(|a| matches!(app.autoname.answers.get(&a.key), Some(Answer::Name(_))))
}

/// The name auto rename has for window [index], the switch on or off — to tell its name from another.
pub fn given(app: &App, index: usize) -> Option<String> {
    if app.autoname.answers.is_empty() { return None }
    let ask = ask(app, index)?;
    match app.autoname.answers.get(&ask.key) { Some(Answer::Name(name)) => Some(name.clone()), _ => None }
}

impl App {
    /// Window [index]'s name by auto rename: the daemon's, else None — asked once (again while the
    /// daemon names it), the window keeping its name meanwhile.
    pub fn auto_name(&mut self, index: usize) -> Option<String> {
        let ask = ask(self, index)?;
        match self.autoname.answers.get(&ask.key) {
            Some(Answer::Name(name)) => return Some(name.clone()),
            Some(Answer::None(at)) if at.elapsed() < RETRY => return None,
            _ => {}
        }
        if self.autoname.quiet.get(&ask.machine).is_some_and(|at| at.elapsed() < RETRY) { return None }
        if self.autoname.asking.get(&ask.key).is_some_and(|at| at.elapsed() < BUDGET + AGAIN) { return None }
        let Some(link) = self.link(&ask.machine) else { return None };
        self.autoname.asking.insert(ask.key.clone(), Instant::now());
        let Ask { machine, agents, key } = ask;
        self.spawn(async move { link.rpc("window_name", json!({ "agentIds": agents }), BUDGET).await.ok() }, move |app: &mut App, answer: Option<Value>| {
            app.window_name_answer(&machine, key, answer);
        });
        None
    }

    /// The daemon's answer for the window [key] (on [machine]): its name; `pending` — asked again in a
    /// moment; none (no repo, no model) — asked again in a while; no answer or an error (an older
    /// daemon, the service off) — that machine is not asked for a while.
    pub fn window_name_answer(&mut self, machine: &str, key: String, answer: Option<Value>) {
        match answer {
            Some(a) if a.get("error").is_none() => match a.get("name").and_then(Value::as_str) {
                Some(name) => { self.autoname.asking.remove(&key); self.autoname.answers.insert(key, Answer::Name(name.to_string())); }
                None if a.get("pending").and_then(Value::as_bool) == Some(true) => {
                    // Asked again once it has had a moment: until then the window is not asked.
                    self.autoname.asking.insert(key, Instant::now() - BUDGET);
                    self.spawn(tokio::time::sleep(AGAIN), |app: &mut App, _| { app.sync_titles(); app.redraw_all = true });
                    return;
                }
                None => { self.autoname.asking.remove(&key); self.autoname.answers.insert(key, Answer::None(Instant::now())); }
            },
            _ => { self.autoname.asking.remove(&key); self.autoname.quiet.insert(machine.to_string(), Instant::now()); }
        }
        self.sync_titles();
        self.redraw_all = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Tab;
    use crate::fleet::{Machine, Reach};
    use crate::layout::{Dir, Node};
    use crate::pane::{Pane, Phase};

    /// The user's window: two harnesses in autonomous-harness, one in aptis-notes (no git), a shell —
    /// and, on another machine, a harness in a repo.
    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19791, sink, (120, 36));
        for (id, name) in [("m", "Mac Auto"), ("b", "Box")] {
            app.fleet.machines.push(Machine { id: id.into(), name: name.into(), local: id == "m", shared: false, status: "running".into(), reach: Reach::Ready });
        }
        app.fleet.merge_roster("m", &[
            json!({"id": "a1", "name": "TUI layout spacing consistency", "engine": "claude", "project": {"name": "autonomous-harness", "branch": "main"}}),
            json!({"id": "a2", "name": "Lm studio respawn on quit", "engine": "claude", "project": {"name": "autonomous-harness", "branch": "lm-studio-stays-closed"}}),
            json!({"id": "a3", "name": "pi:c", "engine": "pi", "project": {"name": "aptis-notes"}}),
            json!({"id": "a4", "name": "Terminal harness 10-6 11:25", "engine": "terminal", "project": {"name": "autonomous-harness", "branch": "main"}}),
        ]);
        app.fleet.merge_roster("b", &[json!({"id": "b1", "name": "Grid relay respawn prod", "engine": "codex", "project": {"name": "autonomous-grid-cli", "branch": "main"}})]);
        for (i, (machine, agent)) in [("m", "a1"), ("m", "a2"), ("m", "a3"), ("m", "a4"), ("b", "b1")].into_iter().enumerate() {
            let mut pane = Pane::new(i as u64 + 1, machine, agent, 80, 24);
            pane.phase = Phase::Live;
            app.panes.insert(i as u64 + 1, pane);
        }
        app
    }

    fn window(app: &mut App, panes: &[u64]) {
        let mut tab = Tab::with_wid("before", 1);
        let mut root = Node::new(panes[0], 80, 23);
        for p in &panes[1..] { root.split(panes[0], *p, Dir::Horizontal); }
        tab.root = Some(root);
        tab.order = panes.to_vec();
        tab.focus = panes.last().copied();
        app.tabs = vec![tab];
        app.active = 0;
    }

    #[test]
    fn a_window_is_asked_of_the_machine_most_of_its_repo_harnesses_are_on() {
        let mut app = app();
        window(&mut app, &[1, 2, 3, 4, 5]);
        let first = ask(&app, 0).unwrap();
        // This machine's agents in pane order (the daemon picks among them); not the other machine's.
        assert_eq!((first.machine.as_str(), first.agents.clone()), ("m", vec!["a1".to_string(), "a2".into(), "a3".into(), "a4".into()]));
        // A title changing is another question.
        app.fleet.merge_roster("b", &[json!({"id": "b1", "name": "Grid relay respawn prod", "engine": "codex", "project": {"name": "autonomous-grid-cli", "branch": "main"}})]);
        app.fleet.agents.get_mut(&("m".to_string(), "a2".to_string())).unwrap().name = "Ship the release notes".into();
        assert_ne!(ask(&app, 0).unwrap().key, first.key);
        // The other machine's one repo harness against this one's none: that machine is asked.
        window(&mut app, &[3, 4, 5]);
        assert_eq!(ask(&app, 0).unwrap().machine, "b");
        // No harness in a repo (a folder without git, a shell): nothing to ask.
        window(&mut app, &[3, 4]);
        assert_eq!(ask(&app, 0), None);
    }

    #[tokio::test]
    async fn the_daemons_name_names_the_window_while_auto_rename_is_on() {
        let mut app = app();
        window(&mut app, &[1, 2, 3]);
        let key = ask(&app, 0).unwrap().key;
        app.window_name_answer("m", key.clone(), Some(json!({"name": "Harness TUI LMStudio"})));
        // Off (the default): as before.
        app.sync_titles();
        assert_ne!(app.tabs[0].name, "Harness TUI LMStudio");
        crate::commands::execute(&mut app, "set -g @hn-auto-rename on");
        assert_eq!(app.tabs[0].name, "Harness TUI LMStudio", "on: at once");
        // A name you set wins; given back, the window is the daemon's again.
        app.rename_tab_at(0, "release");
        app.sync_titles();
        assert_eq!(app.tabs[0].name, "release");
        app.rename_tab_at(0, "");
        assert_eq!(app.tabs[0].name, "Harness TUI LMStudio");
        crate::commands::execute(&mut app, "set -g @hn-auto-rename off");
        assert_ne!(app.tabs[0].name, "Harness TUI LMStudio", "off: as before");
        // automatic-rename off keeps the name a window found: auto rename's is not one to keep.
        crate::commands::execute(&mut app, "set -g automatic-rename off");
        crate::commands::execute(&mut app, "set -g @hn-auto-rename on");
        assert_eq!(app.tabs[0].name, "Harness TUI LMStudio");
        crate::commands::execute(&mut app, "set -g @hn-auto-rename off");
        assert_eq!(app.tabs[0].name, "TUI layout spacing consistency", "its first harness's name, as before");
    }

    /// `@hn-window-name` / `@hn-window-active` set by hand derive the tab's format again — never over
    /// one the user wrote.
    #[tokio::test]
    async fn the_tab_options_set_by_hand_keep_a_format_the_user_wrote() {
        let mut app = app();
        window(&mut app, &[1, 2]);
        crate::commands::execute(&mut app, "set -g window-status-format '#I #W'");
        crate::commands::execute(&mut app, "set -g @hn-window-active star");
        crate::commands::execute(&mut app, "set -g @hn-window-name tmux");
        assert_eq!(app.options.get("window-status-format", "", None).as_deref(), Some("#I #W"));
        crate::commands::execute(&mut app, "set -gu window-status-format");
        crate::commands::execute(&mut app, "set -g @hn-window-name pane");
        assert!(app.options.get("window-status-format", "", None).is_some_and(|f| crate::options::derived_window_status(&f)));
    }

    #[tokio::test]
    async fn pending_none_and_errors_keep_the_name_the_window_has() {
        let mut app = app();
        crate::commands::execute(&mut app, "set -g @hn-auto-rename on");
        window(&mut app, &[1, 2]);
        app.tabs[0].name = "kept".into();
        let key = ask(&app, 0).unwrap().key;
        for answer in [Some(json!({"name": null, "pending": true})), Some(json!({"name": null})), Some(json!({"error": "UNSUPPORTED"})), None] {
            app.window_name_answer("m", key.clone(), answer.clone());
            assert!(app.auto_name(0).is_none(), "{answer:?}");
            assert!(!named(&app, 0), "{answer:?}");
        }
        // No link to the machine here: nothing is asked, nothing breaks.
        window(&mut app, &[5]);
        assert_eq!(app.auto_name(0), None);
    }

    /// The status bar shows the daemon's name, whole — also where it shows the selected pane's title
    /// (`@hn-window-name pane`, the default); without one, as before.
    #[tokio::test]
    async fn the_status_bar_shows_the_name_whole_in_either_tab_name_mode() {
        let mut app = app();
        window(&mut app, &[1, 2]);
        let key = ask(&app, 0).unwrap().key;
        app.window_name_answer("m", key, Some(json!({"name": "Harness Deploy Release"})));
        let tab = |app: &App| crate::format::expand(app, &app.options.get("window-status-format", "", None).unwrap_or_default(), 0, app.tabs[0].focus, false);
        for mode in ["pane", "tmux"] {
            crate::commands::execute(&mut app, &format!("set -g @hn-window-name {mode}"));
            crate::commands::execute(&mut app, "set -g @hn-auto-rename on");
            assert!(tab(&app).contains("Harness Deploy Release"), "{mode}: {}", tab(&app));
            crate::commands::execute(&mut app, "set -g @hn-auto-rename off");
            assert!(!tab(&app).contains("Harness Deploy Release"), "{mode}, off: {}", tab(&app));
        }
        crate::commands::execute(&mut app, "set -g @hn-window-name pane");
        assert!(tab(&app).contains("Lm studio respawn on quit"), "the selected pane's title: {}", tab(&app));
    }

    /// A client of a server an older build started takes that build's status bar formats; it derives
    /// them again, or auto rename's name never shows. (The format is the one the user's own server held,
    /// read from it on 2026-10-07: the old `pane` one, a closing brace short.)
    #[tokio::test]
    async fn an_older_servers_status_bar_formats_are_derived_again_but_never_a_written_one() {
        let mut app = app();
        window(&mut app, &[1, 2]);
        let key = ask(&app, 0).unwrap().key;
        app.window_name_answer("m", key, Some(json!({"name": "Harness TUI LMStudio"})));
        let g = crate::options::SetFlags { global: true, ..Default::default() };
        let old = "#I:#{pane_title}#{?window_active,*,#{?window_last_flag,-,}}#{s/[*-]//:window_flags}#{?#{==:#{window_agent_state},idle},,#{?window_agent_icon, #{window_agent_icon},}";
        for (name, value) in [("@hn-window-name", "pane"), ("@hn-auto-rename", "on"), ("window-status-format", old), ("window-status-current-format", old)] {
            let _ = app.options.set(name, Some(value), &g, "", 0);
        }
        app.sync_titles();
        let tab = |app: &App| crate::format::expand(app, &app.options.get("window-status-format", "", None).unwrap_or_default(), 0, app.tabs[0].focus, false);
        assert!(!tab(&app).contains("Harness TUI LMStudio"), "the old format shows the pane's title: {}", tab(&app));
        assert!(app.rederive_window_status());
        assert!(tab(&app).contains("Harness TUI LMStudio"), "{}", tab(&app));
        assert!(!app.rederive_window_status(), "derived already: nothing to do");
        let _ = app.options.set("window-status-format", Some("#I #W"), &g, "", 0);
        assert!(!app.rederive_window_status());
        assert_eq!(app.options.get("window-status-format", "", None).as_deref(), Some("#I #W"));
    }
}
