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
    let first = app.tabs.iter().all(|t| t.panes().is_empty()) && app.welcome.forms.is_empty() && defaults().is_null()
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
        if form.recent.len() >= 9 { break }
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
        else { "No recent harnesses".into() }
    } else { "Recent harnesses".into() };
}

pub(crate) fn draw(buf: &mut Buffer, app: &mut App, area: Rect) -> Option<Position> {
    ensure(app, None, None);
    let tab = app.tab().id.clone();
    let mut form = app.welcome.forms.remove(&tab)?;
    prepare(app, &mut form);
    let cursor = if area.width >= 58 && area.height >= 22 {
        super::welcome_view::draw(buf, app, area, &mut form)
    } else { view::draw(buf, area, &mut form) };
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
            // This action opens the selected folder without sending the task to a shell; a new project
            // has none yet, so the shell opens at home, where the form was opened from.
            let cwd = match &form.draft.project {
                Project::Folder(cwd) => cwd.clone(),
                Project::New(_) if !form.home.is_empty() => form.home.clone(),
                _ => {
                    form.error = "Choose an existing project folder for a terminal.".into();
                    store_form(app, form);
                    return;
                }
            };
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

    fn render(app: &mut App) {
        let area = Rect::new(0, 0, 150, 41);
        draw(&mut Buffer::empty(area), app, area);
    }

    #[tokio::test]
    async fn welcome_composer_keeps_controls_and_recent_rows_inside_the_window() {
        let mut app=app();
        for i in 0..9 {
            app.home_external.push(crate::app::External { machine:"local".into(),session_id:format!("s{i}"),engine:"codex".into(),
                title:format!("Recent task {i}"),cwd:format!("/home/test/project-{i}"),open:false,last_at:crate::fleet::now_ms()-i*1000 });
        }
        ensure(&mut app,None,None);
        let tab=app.tab().id.clone();
        for (w,h) in [(58,22),(80,24),(94,34),(150,41),(240,60)] {
            let area=Rect::new(0,0,w,h);
            let mut buf=Buffer::empty(area);
            draw(&mut buf,&mut app,area);
            let text=(0..h).map(|y|(0..w).map(|x|buf[(x,y)].symbol()).collect::<String>()).collect::<Vec<_>>().join("\n");
            for expected in ["What should it do?","New Harness","All","New Terminal","Recent task"] {
                assert!(text.contains(expected),"{w}x{h} missing {expected}: {text}");
            }
            for removed in ["machines connected", " Task ", "Browse All Harnesses", "Open Terminal", "Enter start", "Task is optional"] {
                assert!(!text.contains(removed), "{w}x{h} still shows {removed}: {text}");
            }
            let form=&app.welcome.forms[&tab];
            for (hit,_) in &form.hits { assert_eq!(hit.intersection(area),*hit); }
            for field in [Field::Agent,Field::Machine,Field::Project,Field::Task,Field::Worktree,Field::Branch,Field::Model,Field::Create] {
                assert!(form.hits.iter().any(|(_,f)|*f==field),"{w}x{h}: {field:?}");
            }
            let form=app.welcome.forms.get_mut(&tab).unwrap();form.focus=Field::Recent(8);
            draw(&mut Buffer::empty(area),&mut app,area);
            assert!(app.welcome.forms[&tab].hits.iter().any(|(_,f)|*f==Field::Recent(8)),"selected recent row must scroll into view");
            app.welcome.forms.get_mut(&tab).unwrap().focus=Field::Task;
        }
    }

    #[tokio::test]
    async fn the_welcome_chooser_drops_down_under_the_settings_and_leaves_the_task_in_view() {
        let mut app = app();
        ensure(&mut app, None, Some("/work/project".into()));
        let tab = app.tab().id.clone();
        let mut form = take_active(&mut app).unwrap();
        form.focus = Field::Project;
        child(&mut app, &mut form, Choice::Project, "");
        store_form(&mut app, form);
        let area = Rect::new(0, 0, 120, 40);
        let mut buf = Buffer::empty(area);
        draw(&mut buf, &mut app, area);
        assert!(app.welcome.forms[&tab].child_area.is_empty(), "not entered yet: nothing drops down");
        app.welcome.forms.get_mut(&tab).unwrap().child_active = true;
        draw(&mut buf, &mut app, area);
        let form = &app.welcome.forms[&tab];
        let chips = form.hits.iter().find(|(_, f)| *f == Field::Model).unwrap().0;
        assert_eq!((form.child_area.x, form.child_area.y), (form.area.x, chips.y + 1), "under the settings row");
        assert_eq!(form.child_area.width, form.area.width.min(60));
        assert!(form.task_area.intersection(form.child_area).is_empty(), "the task box stays visible");
        assert_eq!(buf[(form.child_area.x + 1, form.child_area.y)].symbol(), "›");
    }

    #[tokio::test]
    async fn the_welcome_task_box_says_when_the_agent_takes_no_task() {
        let mut app = app();
        ensure(&mut app, None, None);
        let mut form = take_active(&mut app).unwrap();
        set_engine(&mut form, "terminal");
        form.draft.what.label = "Terminal".into();
        form.focus = Field::Task;
        store_form(&mut app, form);
        let area = Rect::new(0, 0, 120, 40);
        let mut buf = Buffer::empty(area);
        draw(&mut buf, &mut app, area);
        let text = (0..40).map(|y| (0..120).map(|x| buf[(x, y)].symbol()).collect::<String>()).collect::<Vec<_>>().join("\n");
        assert!(text.contains("Not available for Terminal"), "{text}");
        assert!(!text.contains("What should it do?"), "{text}");
    }

    #[tokio::test]
    async fn a_chosen_recent_row_on_the_small_page_uses_the_panels_chosen_row() {
        let _l = crate::term_out::colours_lock();
        let mut app = app();
        ensure(&mut app, None, Some("/work/project".into()));
        let mut form = take_active(&mut app).unwrap();
        form.recent = (0..3).map(|i| HomeRow::Harness("local".into(), format!("{i}"))).collect();
        form.recent_labels = (0..3).map(|i| (format!("Previous work {i}"), "office · app".into())).collect();
        form.focus = Field::Recent(1);
        let area = Rect::new(0, 0, 50, 30);
        let mut buf = Buffer::empty(area);
        view::draw(&mut buf, area, &mut form);
        let row = form.hits.iter().find(|(_, f)| *f == Field::Recent(1)).unwrap().0;
        let c = crate::settings::chrome();
        let cell = &buf[(row.x + 2, row.y)];
        assert_eq!(cell.symbol(), "P");
        assert_eq!(cell.bg, c.selected.bg.unwrap_or(ratatui::style::Color::Reset));
        assert!(cell.modifier.contains(c.selected.add_modifier));
    }

    #[tokio::test]
    async fn machine_header_scopes_projects_and_remembers_each_destinations_folder() {
        let mut app = app();
        app.homes.insert("local".into(), "/home/test".into());
        app.homes.insert("remote".into(), "/srv/test".into());
        app.fleet.machines.push(crate::fleet::Machine {
            id: "remote".into(), name: "remote-server".into(), local: false, shared: false,
            status: "online".into(), reach: crate::fleet::Reach::Ready,
        });
        for (machine, folder) in [("local", "/home/test/repo"), ("remote", "/srv/test/repo")] {
            let agent = crate::fleet::agent_from(machine, &json!({
                "id":"test", "engine":"codex", "project":{"cwd":folder},
            }), None);
            app.fleet.agents.insert(agent.key(), agent);
        }
        ensure(&mut app, None, Some("/home/test/repo".into()));
        let mut form = take_active(&mut app).unwrap();
        form.draft.task = "Keep this task while changing computers".into();
        form.draft.profile = Some(("local".into(), "profile".into(), "Local account".into()));
        form.focus = Field::Machine;
        reveal(&mut app, &mut form);
        assert_eq!(form.child.as_ref().unwrap().picker.current_id().as_deref(), Some("local"));
        form.child.as_mut().unwrap().picker.select("remote");
        choose(&mut app, &mut form);
        assert_eq!(form.draft.machine, "remote");
        assert!(matches!(&form.draft.project, Project::New(_)), "never reuse a local path on another computer");
        assert!(form.draft.profile.is_none(), "profiles belong to their computer");
        assert_eq!(form.focus, Field::Create);
        assert!(!form.starting);

        child(&mut app, &mut form, Choice::Project, "");
        let folders: Vec<_> = form.child.as_ref().unwrap().picker.rows.iter()
            .filter(|row| row.id.starts_with("at:")).map(|row| row.id.as_str()).collect();
        assert_eq!(folders, vec!["at:remote\t/srv/test/repo"]);
        form.child.as_mut().unwrap().picker.select("folder");
        choose(&mut app, &mut form);
        assert_eq!(form.child.as_ref().unwrap().kind, Choice::Folder("/srv/test".into()),
            "Open Folder goes directly to the selected machine");
        set_project(&mut form, Project::Folder("/srv/test/repo".into()));

        for (machine, folder) in [("local", "/home/test/repo"), ("remote", "/srv/test/repo")] {
            child(&mut app, &mut form, Choice::Machine(None), "");
            form.child.as_mut().unwrap().picker.select(machine);
            choose(&mut app, &mut form);
            assert_eq!(form.draft.machine, machine);
            assert!(matches!(&form.draft.project, Project::Folder(path) if path == folder));
        }
        assert_eq!(form.draft.task, "Keep this task while changing computers");

        child(&mut app, &mut form, Choice::Machine(None), "");
        form.child.as_mut().unwrap().picker.select("local");
        app.fleet.machine_mut("local").unwrap().reach = crate::fleet::Reach::Offline;
        choose(&mut app, &mut form);
        assert_eq!(form.draft.machine, "remote", "a stale enabled row cannot pick an offline machine");
        assert!(form.error.contains("not connected"));
    }

    #[tokio::test]
    async fn a_new_window_keeps_its_remote_machine_and_folder_while_disconnected() {
        for known in [true, false] {
            let mut app = app();
            if known {
                app.fleet.machines.push(crate::fleet::Machine {
                    id: "remote".into(), name: "remote-server".into(), local: false, shared: false,
                    status: "offline".into(), reach: crate::fleet::Reach::Offline,
                });
            }
            ensure(&mut app, Some(("remote".into(), "previous-pane".into())), Some("/srv/remote-project".into()));
            let tab = app.tab().id.clone();
            assert_eq!(app.welcome.forms[&tab].draft.machine, "remote",
                "an explicit remote context must never fall back to the local machine");
            assert!(matches!(&app.welcome.forms[&tab].draft.project,
                Project::Folder(path) if path == "/srv/remote-project"));
            crate::input::handle(&mut app, crossterm::event::Event::Paste("keep this remote task".into()));
            // One Enter with a task submits it.
            event(&mut app, KeyCode::Enter, KeyModifiers::NONE);
            let form = &app.welcome.forms[&tab];
            assert_eq!(form.draft.machine, "remote");
            assert_eq!(form.draft.task, "keep this remote task");
            assert!(form.error.contains("machine is not connected"), "{}", form.error);
            assert!(!form.starting);
            assert!(form.attempt.is_none());
            event(&mut app, KeyCode::Esc, KeyModifiers::NONE);
            assert!(!editing(&app));
        }
    }

    // A window opened from home gets a new project for its harness; its terminal still opens at home.
    #[tokio::test]
    async fn a_terminal_from_a_window_opened_at_home_opens_at_home() {
        let mut app = app();
        let home = std::env::var("HOME").unwrap();
        app.homes.insert(crate::local::MACHINE.into(), home.clone());
        ensure(&mut app, None, Some(home.clone()));
        let tab = app.tab().id.clone();
        assert!(matches!(&app.welcome.forms[&tab].draft.project, Project::New(_)));
        let mut form = take_active(&mut app).unwrap();
        form.focus = Field::Terminal;
        activate(&mut app, form);
        let error = app.welcome.forms.get(&tab).map(|f| f.error.clone()).unwrap_or_default();
        assert!(!error.contains("existing project folder"), "{error}");
    }

    #[tokio::test]
    async fn task_arrows_leave_at_visual_edges_and_keep_multiline_editing_inside() {
        let mut app = app();
        ensure(&mut app, None, None);
        let tab = app.tab().id.clone();
        crate::input::handle(&mut app, crossterm::event::Event::Paste("first\nsecond".into()));
        render(&mut app);
        event(&mut app, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].focus, Field::Task);
        assert_eq!(app.welcome.forms[&tab].task_editor.cursor, "first".len());
        event(&mut app, KeyCode::Down, KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].focus, Field::Task);
        assert_eq!(app.welcome.forms[&tab].task_editor.cursor, "first\nsecond".len());
        event(&mut app, KeyCode::Down, KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].focus, Field::Agent);
        event(&mut app, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].focus, Field::Task);
        event(&mut app, KeyCode::Home, KeyModifiers::CONTROL);
        event(&mut app, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].focus, Field::Terminal);
        assert_eq!(app.welcome.forms[&tab].draft.task, "first\nsecond");
    }

    #[tokio::test]
    async fn escape_leaves_a_rejected_task_and_restores_plain_prefix_navigation() {
        let mut app = app();
        ensure(&mut app, None, None);
        let tab = app.tab().id.clone();
        let mut form = take_active(&mut app).unwrap();
        form.task_editor.insert(&mut form.draft.task, "fsf");
        set_engine(&mut form, "terminal");
        form.focus = Field::Task;
        store_form(&mut app, form);
        render(&mut app);
        event(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert!(app.welcome.forms[&tab].error.contains("cannot start with a task"));
        event(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].focus, Field::Agent);
        assert!(!editing(&app));
        assert_eq!(app.welcome.forms[&tab].draft.task, "fsf");
        assert!(app.welcome.forms[&tab].error.is_empty());
        app.keymap.prefix = crate::keys::parse("`").unwrap();
        event(&mut app, KeyCode::Char('`'), KeyModifiers::NONE);
        assert!(app.prefix, "Escape must release the task's ownership of plain keys");
    }

    #[tokio::test]
    async fn unsupported_empty_task_rejects_text_and_paste_but_allows_navigation() {
        let mut app = app();
        ensure(&mut app, None, None);
        let tab = app.tab().id.clone();
        let mut form = take_active(&mut app).unwrap();
        set_engine(&mut form, "terminal");
        form.focus = Field::Task;
        store_form(&mut app, form);
        render(&mut app);
        event(&mut app, KeyCode::Char('x'), KeyModifiers::NONE);
        crate::input::handle(&mut app, crossterm::event::Event::Paste("do not execute this".into()));
        assert!(app.welcome.forms[&tab].draft.task.is_empty());
        event(&mut app, KeyCode::Down, KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].focus, Field::Agent);
    }

    #[tokio::test]
    async fn escape_returns_to_the_previous_window_without_discarding_the_new_window_draft() {
        let mut app = app();
        let first = app.tab().id.clone();
        app.new_tab();
        ensure(&mut app, None, None);
        let second = app.tab().id.clone();
        crate::input::handle(&mut app, crossterm::event::Event::Paste("unfinished task".into()));
        event(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(app.tab().id, second, "first Escape leaves text editing");
        event(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(app.tab().id, first, "second Escape returns to the previous window");
        assert_eq!(app.welcome.forms[&second].draft.task, "unfinished task");
        let index = app.tabs.iter().position(|t| t.id == second).unwrap();
        app.select_tab(index);
        assert_eq!(app.welcome.forms[&second].draft.task, "unfinished task");
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
    async fn forwarded_prefix_edits_a_welcome_tab_without_a_backing_pane() {
        let mut app = app();
        ensure(&mut app, None, Some("/work/project".into()));
        let tab = app.tab().id.clone();
        assert!(app.focused().is_none());
        paste(&mut app, "word.");
        event(&mut app, KeyCode::Char('b'), KeyModifiers::CONTROL);
        event(&mut app, KeyCode::Char('b'), KeyModifiers::CONTROL);
        event(&mut app, KeyCode::Char('!'), KeyModifiers::NONE);
        assert_eq!(app.welcome.forms[&tab].draft.task, "word!.");
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

    /// A bare app with three agents, the page on `focus`, and the key pressed.
    fn press_on(focus: Field, code: KeyCode) -> (App, String) {
        let mut app = app();
        for i in 0..3 {
            let a = crate::fleet::agent_from("local", &json!({"id":format!("{i}"), "name":format!("Work {i}"), "engine":"codex"}), None);
            app.fleet.agents.insert(a.key(), a);
        }
        ensure(&mut app, None, Some("/work/project".into()));
        let tab = app.tab().id.clone();
        let mut form = take_active(&mut app).unwrap();
        prepare(&app, &mut form);
        form.focus = focus;
        store_form(&mut app, form);
        event(&mut app, code, KeyModifiers::NONE);
        (app, tab)
    }

    #[tokio::test]
    async fn right_opens_a_recent_row_and_left_goes_back_to_the_task() {
        let (app, tab) = press_on(Field::Recent(1), KeyCode::Left);
        assert_eq!(app.welcome.forms[&tab].focus, Field::Task);
        assert!(app.tab().home, "← opens nothing");
        // Enter is the reference: whatever it does to the app, → does the same.
        let (enter, etab) = press_on(Field::Recent(1), KeyCode::Enter);
        let (right, rtab) = press_on(Field::Recent(1), KeyCode::Right);
        assert!(!enter.tab().home && !right.tab().home, "the harness opened, so the page is left");
        assert_eq!((right.tab().home, right.welcome.forms.contains_key(&rtab)),
            (enter.tab().home, enter.welcome.forms.contains_key(&etab)));
        assert!(right.welcome.forms.get(&rtab).is_none_or(|f| f.child.is_none() && !f.child_active),
            "→ on a row never leaves an empty chooser open");
    }

    #[tokio::test]
    async fn right_on_browse_and_terminal_does_what_enter_does() {
        for field in [Field::Browse, Field::Terminal] {
            let (enter, etab) = press_on(field, KeyCode::Enter);
            let (right, rtab) = press_on(field, KeyCode::Right);
            assert_eq!(right.welcome.forms.contains_key(&rtab), enter.welcome.forms.contains_key(&etab), "{field:?}");
            assert!(right.welcome.forms.get(&rtab).is_none_or(|f| f.child.is_none() && !f.child_active),
                "{field:?}: → leaves no empty chooser");
        }
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
