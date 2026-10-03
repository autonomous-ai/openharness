//! The same creation form in an empty window, with a small, secondary session history.
use super::*;
use crate::{app::Placement, input::{HomeRow, LaunchTarget, NewOpts}};
use std::time::Instant;

#[derive(Default)]
pub(crate) struct Welcome {
    pub(super) forms: HashMap<String, Box<Form>>,
    searches: HashMap<String, Search>,
    shown: bool,
    generation: u64,
}
struct Search {
    pending: bool,
    discovering: bool,
    failed: bool,
    asked_at: Instant,
    next: Instant,
}

/// Changing a tab's sole harness gives its shared desk identity a fresh key; its local draft
/// and any receipt still belong to the same visible tab.
pub(crate) fn remap(app: &mut App, old: &str, new: &str) {
    if let Some(mut form) = app.welcome.forms.remove(old) {
        if matches!(&form.surface, Surface::Window(id) if id == old) { form.surface = Surface::Window(new.into()); }
        if let Some(target) = &mut form.launch_target { if target.tab == old { target.tab = new.into(); } }
        if let Some(target) = form.attempt.as_mut().and_then(|a| a.target.as_mut()) { if target.tab == old { target.tab = new.into(); } }
        app.welcome.forms.insert(new.into(), form);
    }
}

pub(super) fn account_changed(app: &mut App) {
    app.welcome.generation = app.welcome.generation.wrapping_add(1);
    app.welcome.searches.clear(); app.welcome.shown = false;
}

/// Context is captured before creating the window; switching windows never replaces its draft.
pub(crate) fn ensure(app: &mut App, from: Option<(String, String)>, cwd: Option<String>) {
    if crate::input::os_home(app) { return }
    let tab = app.tab().id.clone();
    if app.welcome.forms.contains_key(&tab) { return }
    let machine = from.as_ref().map(|(m, _)| app.fleet.launch_machine_id(m).to_string());
    let cwd = cwd.or_else(|| from.as_ref().and_then(|(m, a)| {
        app.find_pane(m, a).and_then(|(_, p)| app.panes.get(&p))
            .and_then(|p| p.cwd.clone().or_else(|| p.live_path.clone()))
            .or_else(|| app.fleet.agent(m, a).map(|a| a.cwd.clone()).filter(|c| !c.is_empty()))
    })).or_else(|| machine.is_none().then(|| std::env::current_dir().ok().map(|p| p.display().to_string())).flatten());
    let first = app.welcome.forms.is_empty() && defaults().is_null()
        && !crate::app::state_dir().join("welcome-seen").exists();
    if let Some(mut form) = make_form(app, machine, cwd, Surface::Window(tab)) {
        form.first_run = first;
        let machine = form.draft.machine.clone();
        store_form(app, form);
        crate::input::load_dsh(app, machine);
    }
}

fn seen() {
    if cfg!(test) { return }
    let path = crate::app::state_dir().join("welcome-seen");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
        let _ = std::fs::write(path, b"1\n");
    }
}

fn prepare(app: &App, form: &mut Form) {
    let available = crate::input::home_rows(app);
    let selected = if let Field::Recent(i) = form.focus { form.recent.get(i).map(HomeRow::key) } else { None };
    // Existing rows stay still while discovery adds results. A disappearing selection never
    // silently becomes a different conversation under Enter.
    form.recent.retain(|r| available.iter().any(|a| a.key() == r.key()));
    for row in available {
        if form.recent.len() >= 3 { break }
        if !form.recent.iter().any(|r| r.key() == row.key()) { form.recent.push(row) }
    }
    if let Some(key) = selected {
        form.focus = form.recent.iter().position(|r| r.key() == key).map(Field::Recent).unwrap_or(Field::Browse);
    }
    form.recent_labels = form.recent.iter().map(|r| match r {
        HomeRow::Harness(machine, id) => {
            let a = app.fleet.agent(machine, id).unwrap();
            (a.name.clone(), format!("{} · {}", app.fleet.machine_name(machine), if a.project.is_empty() { theme::engine_label(&a.engine) } else { &a.project }))
        }
        HomeRow::External(x) => (
            if x.title.is_empty() { "Untitled session".into() } else { x.title.clone() },
            format!("{} · {}", app.fleet.machine_name(&x.machine), theme::engine_label(&x.engine)),
        ),
    }).collect();
    let searches: Vec<_> = app.welcome.searches.iter()
        .filter(|(m, _)| app.fleet.machine(m).is_some_and(|m| m.usable())).map(|(_, s)| s).collect();
    let loading = searches.iter().any(|s| s.pending || s.discovering);
    let failed = searches.iter().any(|s| s.failed);
    form.recent_status = if loading {
        format!("{} Finding saved sessions…", theme::spinner(app.tick))
    } else if failed {
        "Some history is unavailable · Ctrl-R retry".into()
    } else if form.recent.is_empty() {
        if searches.is_empty() { "History appears when a machine connects".into() }
        else { "No recent sessions · start with a task above".into() }
    } else { "Recent sessions".into() };
}

pub(crate) fn draw(buf: &mut Buffer, app: &mut App, area: Rect) -> Option<Position> {
    ensure(app, None, None);
    let tab = app.tab().id.clone();
    let mut form = app.welcome.forms.remove(&tab)?;
    prepare(app, &mut form);
    let cursor = view::draw(buf, area, &mut form);
    store_form(app, form);
    if app.modal.is_none() && !app.prefix { cursor } else { None }
}

/// A plain prefix belongs to text while typing, and resumes navigation on a setting.
pub(crate) fn editing(app: &App) -> bool {
    app.welcome.forms.get(&app.tab().id).is_none_or(|form| form.focus == Field::Task || form.child_active)
}

pub(crate) fn key(app: &mut App, key: KeyEvent) {
    ensure(app, None, None);
    if key.code == KeyCode::Char('r') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.welcome.generation += 1;
        app.welcome.searches.clear();
        tick(app);
        return;
    }
    if let Some(mut form) = take_active(app) {
        prepare(app, &mut form);
        super::key(app, form, key);
    }
}
pub(crate) fn paste(app: &mut App, text: &str) {
    ensure(app, None, None);
    if let Some(mut form) = take_active(app) {
        super::paste(&mut form, text);
        store_form(app, form);
    }
}
pub(crate) fn mouse(app: &mut App, mouse: MouseEvent) { super::mouse(app, mouse); }

pub(super) fn activate(app: &mut App, mut form: Box<Form>) {
    let target = Some(LaunchTarget { session: app.session_id, tab: app.tab().id.clone() });
    match form.focus {
        Field::Browse => {
            store_form(app, form);
            crate::commands::execute(app, "choose-tree -Zs");
        }
        Field::Terminal => {
            // This action opens the selected folder without sending the task to a shell.
            let Project::Folder(cwd) = &form.draft.project else {
                form.error = "Choose an existing project folder for a terminal.".into();
                store_form(app, form);
                return;
            };
            let cwd = cwd.clone();
            let machine = crate::input::shell_machine(app, Some(&(form.draft.machine.clone(), String::new())));
            let backing = app.focused().and_then(|p| app.panes.get(&p)).is_some_and(|p| {
                app.fleet.agent(&p.machine_id, &p.agent_id).is_some_and(|a|
                    a.engine == "terminal" && app.fleet.launch_machine_id(&p.machine_id) == machine
                    && p.cwd.as_ref().or(p.live_path.as_ref()).unwrap_or(&a.cwd) == &cwd)
            });
            if backing {
                store_form(app, form);
                app.tab_mut().home = false;
                seen();
                return;
            }
            form.remember_choices = false;
            let id = form.id.clone();
            store_form(app, form);
            crate::input::create_opts(app, machine, What { engine: "terminal".into(), label: "Terminal".into(), dsh: None },
                Some(cwd), None, false, NewOpts { form_id: Some(id), target, ..Default::default() });
            seen();
        }
        Field::Recent(i) => {
            let row = form.recent.get(i).cloned();
            form.remember_choices = false;
            let id = form.id.clone();
            store_form(app, form);
            match row {
                Some(HomeRow::Harness(m, a)) => { app.open_agent(&m, &a, Placement::Auto(None)); seen(); }
                Some(HomeRow::External(x)) => {
                    crate::input::create_opts(app, x.machine,
                        What { label: theme::engine_label(&x.engine).into(), engine: x.engine, dsh: None },
                        Some(x.cwd), None, false, NewOpts { form_id: Some(id), target, name: Some(x.title),
                            extra: Some(json!({"resumeSessionId":x.session_id})), ..Default::default() });
                    seen();
                }
                None => {}
            }
        }
        _ => store_form(app, form),
    }
}

/// Read-only discovery continues while the page is visible. Older daemons have no readiness
/// flag, so an empty first result is revisited while their initial index warms up.
pub(crate) fn tick(app: &mut App) {
    let windows: std::collections::HashSet<_> = app.tabs.iter().chain(app.sessions.iter().flat_map(|s| s.tabs.iter()))
        .map(|t| t.id.clone()).collect();
    app.welcome.forms.retain(|tab, form| windows.contains(tab) || form.starting || form.attempt.is_some());
    let shown = app.home_visible();
    if shown && !app.welcome.shown {
        for s in app.welcome.searches.values_mut() { if !s.pending { s.next = Instant::now() } }
    }
    app.welcome.shown = shown;
    if !shown { return }
    let now = Instant::now();
    let machines: Vec<_> = app.fleet.visible_machines().filter(|m| m.usable() && !crate::local::is_local(&m.id))
        .filter(|m| app.welcome.searches.get(&m.id).is_none_or(|s| !s.pending && now >= s.next))
        .map(|m| m.id.clone()).collect();
    for machine in machines {
        let Some(link) = app.link(&machine) else { continue };
        let generation = app.welcome.generation;
        let search = app.welcome.searches.entry(machine.clone()).or_insert(Search {
            pending: false, discovering: true, failed: false, asked_at: now, next: now,
        });
        search.pending = true;
        let end = crate::fleet::now_ms();
        let payload = json!({"query":"", "from":end.saturating_sub(30 * 86_400_000), "to":end, "limit":30});
        app.spawn(async move { link.rpc("session_search", payload, Duration::from_secs(10)).await }, move |app, result| {
            if app.welcome.generation != generation { return }
            let Some(search) = app.welcome.searches.get_mut(&machine) else { return };
            search.pending = false;
            match result {
                Ok(reply) => {
                    let external = crate::app::externals(&machine, &reply);
                    search.failed = reply["discoveryError"] == true;
                    search.discovering = !search.failed && reply["ready"].as_bool().map(|ready| !ready).unwrap_or_else(||
                        reply["pending"].as_u64().unwrap_or(0) > 0 ||
                        external.is_empty() && reply["indexed"].as_u64().unwrap_or(0) == 0 && search.asked_at.elapsed() < Duration::from_secs(20));
                    search.next = Instant::now() + Duration::from_secs(if search.discovering { 1 } else { 30 });
                    app.home_external.retain(|x| x.machine != machine);
                    app.home_external.extend(external.into_iter().filter(|x| !x.open));
                }
                Err(_) => {
                    search.failed = true;
                    search.discovering = false;
                    search.next = Instant::now() + Duration::from_secs(15);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (150, 42));
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(crate::fleet::Machine {
            id: "local".into(), name: "office".into(), local: true, shared: false,
            status: "online".into(), reach: crate::fleet::Reach::Ready,
        });
        app.tab_mut().home = true;
        app
    }
    fn event(app: &mut App, code: KeyCode, modifiers: KeyModifiers) {
        crate::input::handle(app, crossterm::event::Event::Key(KeyEvent::new(code, modifiers)));
    }

    #[tokio::test]
    async fn each_window_keeps_its_task_and_paste_never_reaches_the_backing_shell() {
        let mut app = app();
        ensure(&mut app, None, Some("/work/first".into()));
        let first = app.tab().id.clone();
        let buffer = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        app.shell_inputs.insert(first.clone(), buffer.clone());
        for ch in "123 fix login".chars() { event(&mut app, KeyCode::Char(ch), KeyModifiers::NONE); }
        crate::input::handle(&mut app, crossterm::event::Event::Paste("\r\nKeep café and 界.".into()));
        assert!(buffer.lock().unwrap().is_empty());
        assert_eq!(app.welcome.forms[&first].draft.task, "123 fix login\nKeep café and 界.");
        app.new_tab();
        let second = app.tab().id.clone();
        ensure(&mut app, None, Some("/work/second".into()));
        event(&mut app, KeyCode::Char('x'), KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&second].draft.task, "x");
        let index = app.tabs.iter().position(|t| t.id == first).unwrap();
        app.select_tab(index);
        assert!(matches!(&app.welcome.forms[&first].draft.project, Project::Folder(p) if p == "/work/first"));
        assert_eq!(app.welcome.forms[&first].draft.task, "123 fix login\nKeep café and 界.");
        event(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert!(app.home_visible());
        assert!(buffer.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn page_resource_replies_do_not_replace_other_windows_or_a_modal() {
        let mut app = app();
        ensure(&mut app, None, None);
        let first = app.tab().id.clone();
        let id = app.welcome.forms[&first].id.clone();
        app.new_tab();
        ensure(&mut app, None, None);
        let second = app.tab().id.clone();
        app.modal = Some(Modal::Confirm { prompt: "keep me".into(), command: "".into(), key: 'y', enter_yes: false });
        with_form(&mut app, &id, |_, form| { form.error = "Only the first window".into() });
        assert!(matches!(app.modal, Some(Modal::Confirm { .. })));
        assert_eq!(app.welcome.forms[&first].error, "Only the first window");
        assert!(app.welcome.forms[&second].error.is_empty());
    }

    #[tokio::test]
    async fn tmux_paste_and_forwarded_prefix_edit_the_task_without_reaching_a_pane() {
        let mut app = app();
        ensure(&mut app, None, Some("/work/project".into()));
        let tab = app.tab().id.clone();
        app.open_agent("local", "backing-shell", Placement::Fill(tab.clone()));
        let pane = app.focused().unwrap();
        app.paste.add("first\r\nsecond".into(), 10);
        crate::commands::execute(&mut app, "paste-buffer -d");
        assert!(app.paste.top().is_none());
        assert_eq!(app.welcome.forms[&tab].draft.task, "first\nsecond");
        crate::commands::execute(&mut app, "send-prefix");
        event(&mut app, KeyCode::Char('!'), KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].draft.task, "first\nsecon!d");
        assert!(app.panes[&pane].queued.is_empty());
        // An explicitly targeted pane remains a scriptable terminal, as in tmux.
        app.paste.add("explicit shell input".into(), 10);
        crate::commands::execute(&mut app, &format!("paste-buffer -t {}", crate::pane::tag(pane)));
        assert_eq!(app.welcome.forms[&tab].draft.task, "first\nsecon!d");
        assert_eq!(app.panes[&pane].queued, vec![b"explicit shell input".to_vec()]);
    }

    #[tokio::test]
    async fn a_plain_prefix_is_text_in_the_task_and_navigation_on_a_setting() {
        let mut app = app();
        ensure(&mut app, None, None);
        app.keymap.prefix = crate::keys::parse("`").unwrap();
        let tab = app.tab().id.clone();
        event(&mut app, KeyCode::Char('`'), KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].draft.task, "`");
        assert!(!app.prefix);
        event(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        event(&mut app, KeyCode::Char('`'), KeyModifiers::NONE);
        assert!(app.prefix, "Tab out of text must restore a custom plain prefix");
        assert_eq!(app.welcome.forms[&tab].draft.task, "`");
    }

    #[tokio::test]
    async fn a_draft_typed_before_connection_follows_the_local_daemon_when_it_arrives() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (150, 42));
        ensure(&mut app, None, Some("/work/project".into()));
        let tab = app.tab().id.clone();
        event(&mut app, KeyCode::Char('1'), KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].draft.machine, crate::local::MACHINE);
        app.fleet.local_id = "registered-local".into();
        app.fleet.machines.push(crate::fleet::Machine {
            id: "registered-local".into(), name: "office".into(), local: true, shared: false,
            status: "online".into(), reach: crate::fleet::Reach::Ready,
        });
        super::super::refresh(&mut app);
        let form = &app.welcome.forms[&tab];
        assert_eq!(form.draft.machine, "registered-local");
        assert_eq!(form.draft.task, "1");
        assert!(matches!(&form.draft.project, Project::Folder(p) if p == "/work/project"));
    }

    #[tokio::test]
    async fn welcome_stays_anchored_and_reachable_with_history_long_tasks_and_small_terminals() {
        let mut app = app();
        ensure(&mut app, None, Some("/work/project".into()));
        let mut form = take_active(&mut app).unwrap();
        set_engine(&mut form, "codex");
        for (width, height) in [(150, 41), (80, 23), (45, 14), (22, 5), (1, 1)] {
            let area = Rect::new(0, 0, width, height);
            form.recent.clear();
            form.draft.task.clear();
            view::draw(&mut Buffer::empty(area), area, &mut form);
            let anchor = form.area;
            form.draft.task = "Fix café and 界.\n".repeat(80);
            form.recent = (0..3).map(|i| HomeRow::Harness("local".into(), format!("{i}"))).collect();
            form.recent_labels = (0..3).map(|i| (format!("Previous work {i}"), "office · app".into())).collect();
            for focus in form.fields() {
                form.focus = focus;
                let cursor = view::draw(&mut Buffer::empty(area), area, &mut form);
                assert_eq!(form.area, anchor);
                assert!(cursor.is_none_or(|p| area.contains(p)));
                if width >= 22 && height >= 5 { assert!(form.hits.iter().any(|(_, f)| *f == focus), "{width}x{height}: {focus:?}"); }
                assert!(form.hits.iter().all(|(r, _)| r.intersection(area) == *r));
            }
        }
    }

    #[tokio::test]
    async fn discovery_removal_cannot_move_enter_to_another_conversation() {
        let mut app = app();
        for i in 0..3 {
            let a = crate::fleet::agent_from("local", &json!({"id":format!("{i}"), "name":format!("Work {i}"), "engine":"codex"}), None);
            app.fleet.agents.insert(a.key(), a);
        }
        ensure(&mut app, None, None);
        let mut form = take_active(&mut app).unwrap();
        prepare(&app, &mut form);
        form.focus = Field::Recent(1);
        let key = form.recent[1].key();
        app.fleet.agents.remove(&key);
        prepare(&app, &mut form);
        assert_eq!(form.focus, Field::Browse);
    }

    #[tokio::test]
    async fn closing_a_pending_window_preserves_its_receipt_and_the_other_dialog_draft() {
        let mut app = app();
        super::super::open(&mut app, None, Some("/work/dialog".into()));
        let mut dialog = take_active(&mut app).unwrap();
        dialog.draft.task = "Keep my separate dialog draft".into();
        let dialog_id = dialog.id.clone();
        dismiss(&mut app, dialog);
        ensure(&mut app, None, Some("/work/page".into()));
        let mut pending = take_active(&mut app).unwrap();
        let id = pending.id.clone();
        pending.surface = Surface::Window("closed-window".into());
        pending.attempt = Some(Creation { id: "receipt".into(), machine: "local".into(),
            session: app.session_id, target: Some(LaunchTarget { session: app.session_id, tab: "closed-window".into() }) });
        store_form(&mut app, pending);
        tick(&mut app);
        assert!(app.welcome.forms.contains_key("closed-window"));
        super::super::open(&mut app, None, None);
        let pending = take_active(&mut app).unwrap();
        assert_eq!(pending.id, id);
        assert_eq!(pending.describe(Field::Create).0, "Check status");
        dismiss(&mut app, pending);
        assert!(app.welcome.forms.contains_key("closed-window"));
        assert_eq!(app.new_harness_draft.as_ref().unwrap().id, dialog_id);
        assert_eq!(app.new_harness_draft.as_ref().unwrap().draft.task, "Keep my separate dialog draft");
        assert!(super::super::creation_reply(&mut app, &id,
            &Ok(json!({"creationId":"receipt", "state":"created", "agent":{"id":"created"}})), true));
        super::super::created(&mut app, &id, &json!({"id":"created"}));
        assert!(!app.welcome.forms.contains_key("closed-window"));
        assert_eq!(app.new_harness_draft.as_ref().unwrap().id, dialog_id);
    }

    #[tokio::test]
    async fn disconnected_history_does_not_leave_a_stale_spinner_or_resume_target() {
        let mut app = app();
        ensure(&mut app, None, None);
        app.home_external = crate::app::externals("local", &json!({"hits":[{
            "sessionId":"previous", "engine":"codex", "lastAt":1,
            "external":{"title":"Previous task", "cwd":"/work"}
        }]}));
        app.welcome.searches.insert("local".into(), Search { pending: true, discovering: true,
            failed: false, asked_at: Instant::now(), next: Instant::now() });
        let mut form = take_active(&mut app).unwrap();
        prepare(&app, &mut form);
        assert_eq!(form.recent.len(), 1);
        form.focus = Field::Recent(0);
        app.fleet.machine_mut("local").unwrap().reach = crate::fleet::Reach::Offline;
        prepare(&app, &mut form);
        assert!(form.recent.is_empty());
        assert_eq!(form.focus, Field::Browse);
        assert_eq!(form.recent_status, "History appears when a machine connects");
    }
}
