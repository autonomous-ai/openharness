//! New Harness: a compact keyboard-driven form, with a persistent draft and side choosers.
mod data;
mod receipt;
mod task;
pub(crate) use receipt::Creation;
mod view;
use crate::{
    app::App,
    modal::{self, Modal, What},
    picker::{Picker, Row},
    theme,
};
use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::{
    buffer::Buffer,
    layout::{Position, Rect},
    style::{Modifier, Style},
};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};
pub use view::draw;

#[derive(Clone, Debug)]
pub enum Project {
    Folder(String),
    New(String),
    Clone(String),
}
#[derive(Clone, Debug)]
pub struct Draft {
    pub machine: String,
    pub what: What,
    pub project: Project,
    pub task: String,
    pub permission: String,
    pub worktree: Option<bool>,
    pub branch: Option<String>,
    pub new_branch: Option<String>,
    /// Model route and profile are explicit choices; never silently replace either at launch.
    pub model: Option<(String, String, String)>,
    pub profile: Option<(String, String, String)>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Field {
    Agent,
    Project,
    Task,
    Model,
    Approvals,
    Profile,
    Branch,
    Worktree,
    Create,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProjectAction {
    Open,
    New,
    Clone,
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Choice {
    Agent,
    Compatible(String),
    Project,
    Machine(ProjectAction),
    Approvals,
    Model,
    Profile,
    Branch,
    Folder(String),
    Path,
    Clone,
    NewFolder,
    Task,
}
impl Choice {
    fn editing(&self) -> bool {
        matches!(self, Self::Path | Self::Clone | Self::NewFolder | Self::Task)
    }
}
struct Child {
    kind: Choice,
    picker: Picker,
    generation: String,
}

pub struct Form {
    pub draft: Draft,
    pub id: String,
    pub starting: bool,
    checking: bool,
    pub error: String,
    pub attempt: Option<Creation>,
    prepared_folder: Option<String>,
    focus: Field,
    child: Option<Child>,
    child_active: bool,
    trail: Vec<Child>,
    area: Rect,
    child_area: Rect,
    hits: Vec<(Rect, Field)>,
    machine_label: String,
    home: String,
    git: Value,
    git_key: Option<(String, String)>,
    git_loading: bool,
    git_generation: String,
    models: Value,
    profiles: Value,
    resource_generation: String,
    projects: HashMap<String, Project>,
    modes: HashMap<String, String>,
}
impl Form {
    fn project_payload(&self) -> Result<(Option<String>, Value), String> {
        // A confirmed failure may have already made a clone or worktree. Reuse that
        // exact folder until the user explicitly chooses another project/branch.
        if let Some(path) = &self.prepared_folder {
            if matches!(&self.draft.project, Project::Folder(p) if p == path)
                && self.draft.worktree == Some(false)
                && self.draft.branch.is_none()
                && self.draft.new_branch.is_none()
            {
                return Ok((Some(path.clone()), json!({})));
            }
        }
        data::project_payload(&self.draft, &self.git)
    }
    fn fields(&self) -> Vec<Field> {
        let mut fields = vec![Field::Agent, Field::Project, Field::Task, Field::Branch, Field::Worktree];
        if self.draft.what.engine != "terminal" {
            fields.push(Field::Model);
        }
        if !data::modes(&self.draft.what.engine).is_empty() {
            fields.push(Field::Approvals);
        }
        if self.draft.what.engine == "codex" && self.draft.model.is_none() {
            fields.push(Field::Profile);
        }
        fields.push(Field::Create);
        fields
    }
    fn move_by(&mut self, delta: isize) {
        let fields = self.fields();
        let at = fields.iter().position(|f| *f == self.focus).unwrap_or(0) as isize;
        self.focus = fields[(at + delta).rem_euclid(fields.len() as isize) as usize];
    }
    fn worktree(&self) -> bool {
        self.draft.what.engine != "terminal"
            && data::git(&self.git)
            && self.draft.worktree.unwrap_or(true)
    }
    fn blocked(&self, field: Field) -> Option<&str> {
        if field == Field::Task && !task::supported(&self.draft.what.engine) && self.draft.task.trim().is_empty() {
            Some("Not available for this agent")
        } else if matches!(field, Field::Branch | Field::Worktree) {
            if self.git_loading {
                Some("Checking Git…")
            } else if self.git["error"].is_string() {
                Some("Could not read Git · Enter to retry")
            } else if !data::git(&self.git) || self.draft.what.engine == "terminal" {
                Some("Not a Git repository")
            } else {
                None
            }
        } else {
            None
        }
    }
    fn project_name(&self) -> String {
        match &self.draft.project {
            Project::Folder(p) => p.trim_end_matches('/').rsplit('/').next()
                .filter(|name| !name.is_empty()).unwrap_or("/").into(),
            Project::New(n) => {
                if n.is_empty() {
                    "New Folder".into()
                } else {
                    format!("New Folder: {n}")
                }
            }
            Project::Clone(url) => format!("Clone: {url}"),
        }
    }
    fn project_label(&self) -> String {
        format!("{} @ {}", self.project_name(), self.machine_label)
    }
    fn save_task(&mut self) {
        if let Some(c) = &self.child {
            if c.kind == Choice::Task {
                self.draft.task.clone_from(&c.picker.query);
            }
        }
    }
    fn hint(&self) -> String {
        if self.starting { return "Esc close · launch continues".into() }
        if self.attempt.is_some() { return "Enter check status · Esc close".into() }
        if self.focus == Field::Project {
            if let Project::Folder(path) = &self.draft.project {
                return format!("{} @ {}", short_path(path, &self.home), self.machine_label);
            }
        }
        if self.focus == Field::Create {
            "↑/↓ fields · Enter start · Esc close".into()
        } else {
            "↑/↓ fields · Enter choose · Esc back".into()
        }
    }
    fn describe(&self, field: Field) -> (String, String) {
        let (label, value) = match field {
            Field::Agent => (
                if self.draft.what.dsh.is_some() {
                    "Harness"
                } else {
                    "Agent"
                },
                self.draft.what.label.clone(),
            ),
            Field::Project => ("Project", self.project_label()),
            Field::Task => ("Task", if self.draft.task.trim().is_empty() {
                "Add a task (optional)".into()
            } else {
                self.draft.task.split_whitespace().collect::<Vec<_>>().join(" ")
            }),
            Field::Model => (
                "Model",
                self.draft
                    .model
                    .as_ref()
                    .map(|(_, id, node)| {
                        if node.is_empty() {
                            id.clone()
                        } else {
                            format!("{id} · {node}")
                        }
                    })
                    .unwrap_or_else(|| data::subscription(&self.draft.what.engine).into()),
            ),
            Field::Approvals => (
                "Approvals",
                data::mode_label(&self.draft.what.engine, &self.draft.permission),
            ),
            Field::Profile => (
                "Profile",
                self.draft
                    .profile
                    .as_ref()
                    .map(|(_, _, n)| n.clone())
                    .unwrap_or_else(|| "Default".into()),
            ),
            Field::Branch => (
                "Branch",
                self.draft
                    .new_branch
                    .as_ref()
                    .map(|n| format!("{n} · new"))
                    .or_else(|| {
                        data::branch_ref(&self.draft, &self.git)
                            .map(|r| data::branch_name(&r).into())
                    })
                    .unwrap_or_else(|| {
                        if self.worktree() {
                            "Choose a branch"
                        } else {
                            "Detached HEAD"
                        }
                        .into()
                    }),
            ),
            Field::Worktree => (
                "Worktree",
                if self.worktree() { "[x]" } else { "[ ]" }.into(),
            ),
            Field::Create => (
                if self.starting {
                    if self.checking {
                        "Checking…"
                    } else {
                        "Starting…"
                    }
                } else if self.attempt.is_some() {
                    "Check status"
                } else {
                    "Start"
                },
                String::new(),
            ),
        };
        (
            if field == Field::Create && !self.starting && self.attempt.is_none() {
                format!("Start {}", self.draft.what.label)
            } else {
                label.into()
            },
            self.blocked(field).map(str::to_string).unwrap_or(value),
        )
    }
}
fn short_path(path: &str, home: &str) -> String {
    if !home.is_empty() && (path == home || path.starts_with(&format!("{home}/"))) {
        format!("~{}", &path[home.len()..])
    } else {
        path.into()
    }
}
fn machine_label(app: &App, machine: &str) -> String {
    if app.fleet.machines.iter().any(|m| m.id == machine && m.local) {
        "local".into()
    } else {
        app.fleet.machine_name(machine)
    }
}
fn defaults_path() -> std::path::PathBuf {
    crate::app::state_dir().join("new-harness.json")
}
fn defaults() -> Value {
    if cfg!(test) {
        return Value::Null;
    }
    std::fs::read(defaults_path())
        .ok()
        .and_then(|s| serde_json::from_slice(&s).ok())
        .unwrap_or(Value::Null)
}
fn remember(form: &Form) {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let path = defaults_path();
    let Some(parent) = path.parent() else { return };
    let mut saved = defaults();
    if !saved.is_object() {
        saved = json!({});
    }
    let d = &form.draft;
    if !saved["permissions"].is_object() {
        saved["permissions"] = json!({});
    }
    saved["permissions"][&d.what.engine] = json!(d.permission);
    saved["engine"] = json!(d.what.engine);
    saved["dsh"] = json!(d.what.dsh);
    saved["label"] = json!(d.what.label);
    if !saved["projects"].is_object() {
        saved["projects"] = json!({});
    }
    if let Project::Folder(p) = &d.project {
        saved["projects"][&d.machine] = json!(p);
    }
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(parent)?;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(saved.to_string().as_bytes())?;
        std::fs::rename(&tmp, &path)
    };
    if write().is_err() {
        let _ = std::fs::remove_file(tmp);
    }
}

pub fn open(app: &mut App, machine: Option<String>, cwd: Option<String>) {
    let machine = machine.map(|id| app.fleet.launch_machine_id(&id).to_string());
    if machine
        .as_ref()
        .is_some_and(|id| !app.fleet.machines.iter().any(|m| m.id == *id && m.usable()))
    {
        return app.error("That machine is not connected");
    }
    if app
        .new_harness_draft
        .as_ref()
        .is_some_and(|f| f.starting || f.attempt.is_some())
        || (machine.is_none() && cwd.is_none() && app.new_harness_draft.is_some())
    {
        let mut form = app.new_harness_draft.take().unwrap();
        resolve_launch_machine(app, &mut form);
        refresh_form(app, &mut form);
        app.modal = Some(Modal::NewHarness(form));
        return;
    }
    let saved = defaults();
    let machine = machine
        .filter(|id| app.fleet.machines.iter().any(|m| m.id == *id && m.usable()))
        .or_else(|| app.fleet.registered_local_machine().filter(|m| m.usable()).map(|m| m.id.clone()))
        .or_else(|| {
            app.fleet
                .machines
                .iter()
                .find(|m| m.local && m.usable())
                .map(|m| m.id.clone())
        })
        .or_else(|| {
            app.fleet
                .machines
                .iter()
                .find(|m| m.usable())
                .map(|m| m.id.clone())
        });
    let Some(machine) = machine else {
        return app.error("No machine is connected yet");
    };
    let current = app
        .focused()
        .and_then(|f| app.panes.get(&f))
        .filter(|p| p.machine_id == machine)
        .and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id));
    let engine = saved["engine"]
        .as_str()
        .unwrap_or("opencode")
        .to_string();
    let what = What {
        label: saved["label"]
            .as_str()
            .unwrap_or(theme::engine_label(&engine))
            .into(),
        engine: engine.clone(),
        dsh: saved["dsh"].as_str().map(str::to_string),
    };
    let project = cwd
        .or_else(|| saved["projects"][&machine].as_str().map(str::to_string))
        .or_else(|| current.map(|a| a.cwd.clone()).filter(|p| !p.is_empty()))
        .map(Project::Folder)
        .unwrap_or_else(|| Project::New(String::new()));
    let permission = saved["permissions"][&engine]
        .as_str()
        .map(str::to_string)
        .or_else(|| app.options.get("@hn-permission-mode", "", None))
        .filter(|p| data::modes(&engine).iter().any(|(id, _)| id == p))
        .unwrap_or_else(|| "auto".into());
    let draft = Draft {
        machine: machine.clone(),
        what,
        project,
        task: String::new(),
        permission,
        worktree: None,
        branch: None,
        new_branch: None,
        model: None,
        profile: None,
    };
    let mut form = Box::new(Form {
        draft,
        id: uuid::Uuid::new_v4().to_string(),
        starting: false,
        checking: false,
        error: String::new(),
        attempt: None,
        prepared_folder: None,
        focus: Field::Create,
        child: None,
        child_active: false,
        trail: vec![],
        area: Rect::default(),
        child_area: Rect::default(),
        hits: vec![],
        machine_label: String::new(),
        home: String::new(),
        git: Value::Null,
        git_key: None,
        git_loading: false,
        git_generation: String::new(),
        models: Value::Null,
        profiles: Value::Null,
        resource_generation: String::new(),
        projects: HashMap::new(),
        modes: HashMap::new(),
    });
    refresh_form(app, &mut form);
    sync_git(app, &mut form, false);
    app.modal = Some(Modal::NewHarness(form));
    crate::input::load_dsh(app, machine);
}
fn refresh_form(app: &App, form: &mut Form) {
    form.machine_label = machine_label(app, &form.draft.machine);
    form.home = app
        .homes
        .get(&form.draft.machine)
        .cloned()
        .unwrap_or_default();
    if form.draft.what.engine == "terminal"
        && matches!(&form.draft.project,Project::Folder(p) if p.is_empty())
        && !form.home.is_empty()
    {
        form.draft.project = Project::Folder(form.home.clone());
    }
    if let Some(dsh) = &form.draft.what.dsh {
        if let Some(row) = app
            .dsh
            .get(&form.draft.machine)
            .into_iter()
            .flatten()
            .find(|r| r["id"].as_str() == Some(dsh))
        {
            if let Some(name) = row["name"].as_str() {
                form.draft.what.label =
                    format!("{name} · {}", theme::engine_label(&form.draft.what.engine));
            }
        }
    }
    let Some(c) = &mut form.child else { return };
    let rows = match &c.kind {
        Choice::Agent => Some(agent_rows(app, &form.draft.machine)),
        Choice::Compatible(dsh) => Some(compatible_rows(app, &form.draft.machine, dsh)),
        Choice::Project => Some(project_rows(app, &form.draft)),
        Choice::Machine(_) => Some(modal::new_machine_rows(app, &app.fleet.local_id)),
        Choice::Approvals => Some(
            data::modes(&form.draft.what.engine)
                .iter()
                .map(|(id, label)| Row::new(*id, *label))
                .collect(),
        ),
        Choice::Model => Some(data::model_rows(&form.models, &form.draft.what.engine)),
        Choice::Profile => {
            let mut rows = vec![Row::new("default", "Default")];
            for p in form.profiles["profiles"].as_array().into_iter().flatten() {
                if let Some(path) = p["path"].as_str() {
                    rows.push(Row::new(path, p["label"].as_str().unwrap_or(path)).extra(path));
                }
            }
            Some(rows)
        }
        Choice::Branch => Some(data::branch_rows(
            &form.git,
            form.draft.worktree.unwrap_or(data::git(&form.git)),
            &c.picker.query,
        )),
        _ => None,
    };
    if let Some(rows) = rows {
        c.picker.set_rows(rows);
    }
}
pub fn refresh(app: &mut App) {
    if !matches!(app.modal, Some(Modal::NewHarness(_))) {
        return;
    }
    let Some(Modal::NewHarness(mut form)) = app.modal.take() else {
        return;
    };
    resolve_launch_machine(app, &mut form);
    refresh_form(app, &mut form);
    sync_git(app, &mut form, false);
    app.modal = Some(Modal::NewHarness(form));
}
fn resolve_launch_machine(app: &mut App, form: &mut Form) {
    // A pending receipt belongs to its original transport, even if the daemon has returned.
    if form.starting || form.attempt.is_some() { return }
    let machine = app.fleet.launch_machine_id(&form.draft.machine).to_string();
    if machine != form.draft.machine {
        let project = form.draft.project.clone();
        set_machine(app, form, &machine);
        set_project(form, project);
        sync_git(app, form, false);
    }
}
fn agent_rows(app: &App, machine: &str) -> Vec<Row> {
    modal::new_what_rows(app.dsh.get(machine).map(Vec::as_slice).unwrap_or(&[]))
}
fn compatible_rows(app: &App, machine: &str, dsh: &str) -> Vec<Row> {
    let row = app
        .dsh
        .get(machine)
        .into_iter()
        .flatten()
        .find(|r| r["id"].as_str() == Some(dsh));
    let engines: Vec<_> = row
        .and_then(|r| r["engines"].as_array())
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .filter(|a: &Vec<&str>| !a.is_empty())
        .unwrap_or_else(|| vec![row.and_then(|r| r["engine"].as_str()).unwrap_or("claude")]);
    engines
        .into_iter()
        .map(|e| Row::new(format!("engine:{e}"), theme::engine_label(e)))
        .collect()
}
fn project_rows(app: &App, draft: &Draft) -> Vec<Row> {
    const PER_MACHINE: usize = 50;
    let mut rows = vec![];
    if draft.what.engine != "terminal" {
        rows.push(Row::new("clone", "Clone Repository"));
    }
    rows.push(Row::new("folder", "Open Folder"));
    if draft.what.engine != "terminal" {
        rows.push(Row::new("new", "New Folder"));
    }
    let mut agents: Vec<_> = app
        .fleet
        .agents
        .values()
        .filter(|a| !a.cwd.is_empty())
        .collect();
    agents.sort_by_key(|a| {
        (
            app.fleet.launch_machine_id(&a.machine_id) != app.fleet.local_id,
            std::cmp::Reverse(a.recency()),
            a.cwd.as_str(),
            a.machine_id.as_str(),
        )
    });
    // Each destination gets its own recent-folder allowance. Duplicate sessions and local
    // shell aliases share that allowance; a large local history cannot consume a remote's.
    let mut seen = std::collections::HashSet::new();
    let mut counts = HashMap::new();
    for a in agents {
        let machine = app.fleet.launch_machine_id(&a.machine_id);
        if !seen.insert((machine.to_string(), a.cwd.clone())) {
            continue;
        }
        let count = counts.entry(machine).or_insert(0);
        if *count >= PER_MACHINE {
            continue;
        }
        *count += 1;
        let short = short_path(
            &a.cwd,
            app.homes
                .get(machine)
                .or_else(|| app.homes.get(&a.machine_id))
                .map(String::as_str)
                .unwrap_or(""),
        );
        let mut row = Row::new(
            format!("at:{machine}\t{}", a.cwd),
            format!("{short} @ {}", machine_label(app, machine)),
        )
        .extra(app.fleet.machine_name(machine))
        .group("Recent projects");
        row.disabled = !app
            .fleet
            .machines
            .iter()
            .any(|m| m.id == machine && m.usable());
        if row.disabled {
            row.label.push_str(" · offline");
        }
        rows.push(row);
    }
    rows
}
fn sync_git(app: &mut App, form: &mut Form, force: bool) {
    let path = if let Project::Folder(p) = &form.draft.project {
        Some(p.clone())
    } else {
        None
    };
    if form.draft.what.engine == "terminal" || path.is_none() {
        form.git = Value::Null;
        form.git_key = None;
        form.git_loading = false;
        form.git_generation.clear();
        return;
    }
    let path = path.unwrap();
    let key = (form.draft.machine.clone(), path.clone());
    if !force && form.git_key.as_ref() == Some(&key) {
        return;
    }
    let Some(link) = app.link(&form.draft.machine) else {
        form.git = json!({"error":"OFFLINE"});
        return;
    };
    form.git_key = Some(key.clone());
    form.git_loading = true;
    form.git = Value::Null;
    form.git_generation = uuid::Uuid::new_v4().to_string();
    let generation = form.git_generation.clone();
    let id = form.id.clone();
    app.spawn(
        async move {
            link.rpc(
                "git_project_info",
                json!({"path":path}),
                Duration::from_secs(20),
            )
            .await
        },
        move |app, reply| {
            with_form(app, &id, |app, form| {
                if form.git_generation != generation {
                    return;
                }
                form.git_loading = false;
                form.git = reply.unwrap_or_else(|_| json!({"error":"UNAVAILABLE"}));
                if let Some(main) = form.git["mainFolder"].as_str().map(str::to_string)
                    .filter(|_| !matches!(&form.draft.project, Project::Folder(p) if form.prepared_folder.as_ref() == Some(p)))
                {
                    if form.draft.worktree == Some(false) && form.draft.branch.is_none() {
                        form.draft.branch = form.git["branch"]
                            .as_str()
                            .map(|b| format!("refs/heads/{b}"));
                    }
                    form.draft.project = Project::Folder(main.clone());
                    form.git_key = Some((form.draft.machine.clone(), main));
                    form.git["branch"] = form.git["mainBranch"].clone();
                }
                refresh_form(app, form);
            });
        },
    );
}
fn with_form(app: &mut App, id: &str, f: impl FnOnce(&mut App, &mut Form)) {
    if matches!(&app.modal,Some(Modal::NewHarness(form)) if form.id==id) {
        let Some(Modal::NewHarness(mut form)) = app.modal.take() else {
            return;
        };
        f(app, &mut form);
        app.modal = Some(Modal::NewHarness(form));
    } else if app
        .new_harness_draft
        .as_ref()
        .is_some_and(|form| form.id == id)
    {
        let mut form = app.new_harness_draft.take().unwrap();
        f(app, &mut form);
        app.new_harness_draft = Some(form);
    }
}
fn load_resource(app: &mut App, form: &mut Form, models: bool) {
    let Some(link) = app.link(&form.draft.machine) else {
        return;
    };
    let id = form.id.clone();
    let generation = uuid::Uuid::new_v4().to_string();
    form.resource_generation = generation.clone();
    if let Some(c) = &mut form.child {
        c.picker.busy = Some("Loading…".into());
    }
    app.spawn(
        async move {
            link.rpc(
                if models {
                    "grid_models_list"
                } else {
                    "codex_profiles_list"
                },
                json!({"rowState":true}),
                Duration::from_secs(30),
            )
            .await
        },
        move |app, reply| {
            with_form(app, &id, |app, form| {
                if form.resource_generation != generation {
                    return;
                }
                let value = reply.unwrap_or_else(|_| json!({"error":"UNAVAILABLE"}));
                if value["error"].is_string() {
                    form.error = if models {
                        "Could not load models · choose Refresh models"
                    } else {
                        "Could not load profiles · reopen Profile to retry"
                    }
                    .into();
                }
                if models {
                    form.models = value
                } else {
                    form.profiles = value
                }
                if let Some(c) = &mut form.child {
                    c.picker.busy = None;
                }
                refresh_form(app, form);
            });
        },
    );
}
fn child(app: &mut App, form: &mut Form, kind: Choice, initial: &str) {
    let hint = match &kind {
        Choice::Agent => "Search agents and harnesses",
        Choice::Compatible(_) => "Choose a coding agent",
        Choice::Project => "Search projects",
        Choice::Machine(_) => "Choose a machine",
        Choice::Approvals => "Search approvals",
        Choice::Model => "Search models",
        Choice::Profile => "Search profiles",
        Choice::Branch => "Search or create a branch",
        Choice::Folder(_) => "Search folders · Ctrl-L path",
        Choice::Path => "/path/to/project or ~/project",
        Choice::Clone => "GitHub URL or owner/repository",
        Choice::NewFolder => "Folder name (optional)",
        Choice::Task => "Describe the task…",
    };
    let mut picker = Picker::new("", hint);
    picker.keep_order = kind != Choice::Project;
    picker.search_extra = kind == Choice::Project;
    picker.query = initial.into();
    picker.qcursor = initial.chars().count();
    picker.empty = "No matches".into();
    form.child = Some(Child {
        kind: kind.clone(),
        picker,
        generation: uuid::Uuid::new_v4().to_string(),
    });
    refresh_form(app, form);
    let selected = match &kind {
        Choice::Agent => Some(
            form.draft
                .what
                .dsh
                .as_ref()
                .map(|d| format!("dsh:{d}:{}", form.draft.what.engine))
                .unwrap_or_else(|| format!("engine:{}", form.draft.what.engine)),
        ),
        Choice::Compatible(_) => Some(format!("engine:{}", form.draft.what.engine)),
        Choice::Project => {
            if let Project::Folder(p) = &form.draft.project {
                Some(format!("at:{}\t{p}", form.draft.machine))
            } else {
                None
            }
        }
        Choice::Machine(_) => Some(app.fleet.local_id.clone()),
        Choice::Approvals => Some(form.draft.permission.clone()),
        Choice::Model => Some(
            form.draft
                .model
                .as_ref()
                .map(|(grid, id, _)| json!([grid, id]).to_string())
                .unwrap_or_else(|| "subscription".into()),
        ),
        Choice::Profile => Some(
            form.draft
                .profile
                .as_ref()
                .map(|(_, p, _)| p.clone())
                .unwrap_or_else(|| "default".into()),
        ),
        Choice::Branch => data::branch_ref(&form.draft, &form.git),
        _ => None,
    };
    if let (Some(c), Some(id)) = (&mut form.child, selected) {
        c.picker.select(&id);
    }
    match kind {
        Choice::Folder(path) => load_folder(app, form, path),
        Choice::Model => load_resource(app, form, true),
        Choice::Profile => load_resource(app, form, false),
        _ => {}
    }
}
fn load_folder(app: &mut App, form: &mut Form, path: String) {
    let Some(link) = app.link(&form.draft.machine) else {
        form.error = "That machine is not connected".into();
        return;
    };
    let id = form.id.clone();
    let Some(c) = &mut form.child else { return };
    let generation = c.generation.clone();
    c.picker.busy = Some("Loading folders…".into());
    app.spawn(
        async move {
            link.rpc("fs_list_dir", json!({"path":path}), Duration::from_secs(20))
                .await
        },
        move |app, reply| {
            with_form(app, &id, |_, form| {
                let Some(c) = &mut form.child else { return };
                if c.generation != generation {
                    return;
                }
                c.picker.busy = None;
                match reply {
                    Ok(v) if v["path"].is_string() => {
                        let path = v["path"].as_str().unwrap().to_string();
                        c.kind = Choice::Folder(path.clone());
                        c.picker.placeholder =
                            format!("{} · Ctrl-L path", short_path(&path, &form.home));
                        let mut rows = vec![Row::new("use", "Use this folder")];
                        if path != "/" {
                            rows.push(Row::new("up", ".. /"));
                        }
                        for entry in v["entries"].as_array().into_iter().flatten() {
                            if entry["isDir"] == false {
                                continue;
                            }
                            if let Some(name) = entry["name"]
                                .as_str()
                                .filter(|n| !n.contains('/') && *n != "." && *n != "..")
                            {
                                rows.push(Row::new(format!("dir:{name}"), format!("{name}/")));
                            }
                        }
                        c.picker.set_rows(rows);
                    }
                    _ => c.picker.empty = "Could not open folder · Ctrl-L to edit path".into(),
                }
            });
        },
    );
}
fn reveal(app: &mut App, form: &mut Form) {
    form.save_task();
    form.child = None;
    form.child_active = false;
    form.trail.clear();
    if form.blocked(form.focus).is_some() {
        return;
    }
    let kind = match form.focus {
        Field::Agent => Choice::Agent,
        Field::Project => Choice::Project,
        Field::Task => Choice::Task,
        Field::Model => Choice::Model,
        Field::Approvals => Choice::Approvals,
        Field::Profile => Choice::Profile,
        Field::Branch => Choice::Branch,
        _ => return,
    };
    let initial = if kind == Choice::Task { form.draft.task.clone() } else { String::new() };
    child(app, form, kind, &initial);
}
fn activate(app: &mut App, form: &mut Form) -> bool {
    form.error.clear();
    if form.blocked(form.focus).is_some() {
        if form.git["error"].is_string() {
            sync_git(app, form, true);
        }
        return false;
    }
    match form.focus {
        Field::Create => return true,
        Field::Worktree => {
            form.draft.worktree = Some(!form.worktree());
            form.draft.branch = None;
            form.draft.new_branch = None;
        }
        _ => {
            if form.child.is_none() {
                reveal(app, form);
            }
            form.child_active = true;
        }
    }
    false
}
fn set_project(form: &mut Form, project: Project) {
    form.prepared_folder = None;
    form.draft.project = project;
    form.draft.worktree = None;
    form.draft.branch = None;
    form.draft.new_branch = None;
    form.git_key = None;
}
fn set_machine(app: &mut App, form: &mut Form, machine: &str) {
    if form.draft.machine == machine {
        return;
    }
    form.projects
        .insert(form.draft.machine.clone(), form.draft.project.clone());
    form.draft.machine = machine.into();
    let project = form.projects.get(machine).cloned().unwrap_or_else(|| {
        if form.draft.what.engine == "terminal" {
            Project::Folder(app.homes.get(machine).cloned().unwrap_or_default())
        } else {
            Project::New(String::new())
        }
    });
    set_project(form, project);
    form.models = Value::Null;
    form.profiles = Value::Null;
    form.resource_generation.clear();
    crate::input::load_dsh(app, machine.into());
    refresh_form(app, form);
}
fn set_engine(form: &mut Form, engine: &str) {
    form.modes.insert(
        form.draft.what.engine.clone(),
        form.draft.permission.clone(),
    );
    form.draft.what.engine = engine.into();
    form.draft.permission = form
        .modes
        .get(engine)
        .filter(|p| data::modes(engine).iter().any(|(id, _)| id == p))
        .cloned()
        .unwrap_or_else(|| "auto".into());
    if engine == "terminal" {
        form.draft.model = None;
        form.draft.profile = None;
        form.draft.worktree = Some(false);
        if !matches!(form.draft.project, Project::Folder(_)) {
            form.draft.project = Project::Folder(form.home.clone());
        }
    }
    form.git_key = None;
}
fn step_into(app: &mut App, form: &mut Form, previous: Child, kind: Choice, initial: &str) {
    form.trail.push(previous);
    child(app, form, kind, initial);
    form.child_active = true;
}
fn choose(app: &mut App, form: &mut Form) {
    let Some(c) = form.child.take() else { return };
    let query = c.picker.query.trim().to_string();
    let id = c.picker.current_id().unwrap_or_default();
    if !c.kind.editing() && (id.is_empty() || c.picker.current().is_some_and(|r| r.disabled)) {
        form.child = Some(c);
        return;
    }
    match &c.kind {
        Choice::Agent | Choice::Compatible(_) => {
            if let Some((dsh, _)) = id.strip_prefix("dsh:").and_then(|s| s.rsplit_once(':')) {
                let dsh = dsh.to_string();
                step_into(app, form, c, Choice::Compatible(dsh), "");
                return;
            }
            let Some(engine) = id.strip_prefix("engine:") else {
                form.child = Some(c);
                return;
            };
            let dsh = if let Choice::Compatible(dsh) = &c.kind {
                Some(dsh.clone())
            } else {
                None
            };
            set_engine(form, engine);
            form.draft.what.dsh = dsh;
            form.draft.what.label = theme::engine_label(engine).into();
        }
        Choice::Project => match id.as_str() {
            "clone" | "new" | "folder" => {
                let action = match id.as_str() {
                    "clone" => ProjectAction::Clone,
                    "new" => ProjectAction::New,
                    _ => ProjectAction::Open,
                };
                step_into(app, form, c, Choice::Machine(action), "");
                return;
            }
            _ => {
                if let Some((machine, path)) =
                    id.strip_prefix("at:").and_then(|s| s.split_once('\t'))
                {
                    set_machine(app, form, machine);
                    set_project(form, Project::Folder(path.into()));
                } else {
                    form.child = Some(c);
                    return;
                }
            }
        },
        Choice::Machine(action) => {
            let action = *action;
            set_machine(app, form, &id);
            let next = match action {
                ProjectAction::Clone => Choice::Clone,
                ProjectAction::New => Choice::NewFolder,
                ProjectAction::Open => {
                    Choice::Folder(if let Project::Folder(p) = &form.draft.project {
                        p.clone()
                    } else {
                        form.home.clone()
                    })
                }
            };
            step_into(app, form, c, next, "");
            return;
        }
        Choice::Approvals => form.draft.permission = id,
        Choice::Model => {
            if id == "refresh" {
                form.child = Some(c);
                load_resource(app, form, true);
                return;
            } else if id == "subscription" {
                form.draft.model = None
            } else if let Ok(pair) = serde_json::from_str::<Vec<String>>(&id) {
                if pair.len() != 2 {
                    form.child = Some(c);
                    return;
                }
                let node = form.models["grids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|g| g["name"].as_str() == Some(&pair[0]))
                    .and_then(|g| g["models"].as_array())
                    .into_iter()
                    .flatten()
                    .find(|m| m["id"].as_str() == Some(&pair[1]))
                    .and_then(|m| m["node"].as_str())
                    .unwrap_or("")
                    .to_string();
                form.draft.model = Some((pair[0].clone(), pair[1].clone(), node));
            } else {
                form.child = Some(c);
                return;
            }
        }
        Choice::Profile => {
            form.draft.profile = if id == "default" {
                None
            } else {
                Some((
                    form.draft.machine.clone(),
                    id,
                    c.picker.current().unwrap().label.clone(),
                ))
            }
        }
        Choice::Branch => {
            if let Some(name) = id.strip_prefix("new:") {
                form.draft.new_branch = Some(name.into());
            } else {
                form.draft.branch = Some(id);
                form.draft.new_branch = None;
            }
        }
        Choice::Folder(path) => match id.as_str() {
            "use" => set_project(form, Project::Folder(path.clone())),
            "up" => {
                let parent = path
                    .rsplit_once('/')
                    .map(|(p, _)| if p.is_empty() { "/" } else { p })
                    .unwrap_or("/")
                    .to_string();
                step_into(app, form, c, Choice::Folder(parent), "");
                return;
            }
            _ => {
                if let Some(name) = id.strip_prefix("dir:") {
                    let next = format!("{}/{name}", path.trim_end_matches('/'));
                    step_into(app, form, c, Choice::Folder(next), "");
                    return;
                } else {
                    form.child = Some(c);
                    return;
                }
            }
        },
        Choice::Path => {
            if query.starts_with('~') && form.home.is_empty() {
                form.error = "Home is loading; enter an absolute path".into();
                form.child = Some(c);
                return;
            }
            let path = if query == "~" {
                form.home.clone()
            } else if let Some(rest) = query.strip_prefix("~/") {
                format!("{}/{rest}", form.home)
            } else {
                query
            };
            if !path.starts_with('/') {
                form.error = "Enter an absolute path or ~/folder".into();
                form.child = Some(c);
                return;
            }
            step_into(app, form, c, Choice::Folder(path), "");
            return;
        }
        Choice::Clone => {
            if query.is_empty() {
                form.error = "Enter a GitHub URL or owner/repository".into();
                form.child = Some(c);
                return;
            }
            set_project(form, Project::Clone(query));
        }
        Choice::NewFolder => set_project(form, Project::New(query)),
        Choice::Task => form.draft.task = c.picker.query.clone(),
    }
    form.child_active = false;
    form.trail.clear();
    form.focus = Field::Create;
    form.error.clear();
    refresh_form(app, form);
    sync_git(app, form, false);
}
fn back(app: &mut App, form: &mut Form) -> bool {
    form.save_task();
    if form.child_active {
        if let Some(previous) = form.trail.pop() {
            form.child = Some(previous);
            if let Some(c) = &mut form.child {
                if c.picker.busy.is_some() {
                    if let Choice::Folder(path) = &c.kind {
                        let path = path.clone();
                        c.generation = uuid::Uuid::new_v4().to_string();
                        load_folder(app, form, path);
                    }
                }
            }
        } else {
            form.child = None;
            form.child_active = false;
        }
        form.error.clear();
        true
    } else if form.child.take().is_some() {
        form.trail.clear();
        true
    } else {
        false
    }
}
fn terminal_selected(form: &Form) -> bool {
    form.child_active && form.child.as_ref().is_some_and(|child|
        child.kind == Choice::Agent && child.picker.current_id().as_deref() == Some("engine:terminal"))
}

fn open_terminal(app: &mut App, mut form: Box<Form>) {
    let machine = form.draft.machine.clone();
    let cwd = match &form.draft.project {
        Project::Folder(path) if !path.is_empty() => Some(path.clone()),
        _ => (!form.home.is_empty()).then(|| form.home.clone()),
    };
    // Terminal is an immediate action. Keep the agent draft (including its task)
    // for when New Harness is reopened; never send that task to a shell.
    form.child = None;
    form.child_active = false;
    form.trail.clear();
    app.new_harness_draft = Some(form);
    crate::input::new_shell_from(app, Some((machine, String::new())), crate::app::Placement::Auto(None), cwd, None);
}

pub fn key(app: &mut App, mut form: Box<Form>, key: KeyEvent) {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    if key.code == KeyCode::Esc || (ctrl && matches!(key.code, KeyCode::Char('c' | 'g'))) {
        if back(app, &mut form) {
            app.modal = Some(Modal::NewHarness(form));
        } else {
            app.new_harness_draft = Some(form);
        }
        return;
    }
    if form.starting || key.kind == KeyEventKind::Repeat && key.code == KeyCode::Enter {
        app.modal = Some(Modal::NewHarness(form));
        return;
    }
    if form.attempt.is_some() {
        let check = matches!(key.code, KeyCode::Enter | KeyCode::Char(' '));
        app.modal = Some(Modal::NewHarness(form));
        if check {
            start(app);
        }
        return;
    }
    if key.code == KeyCode::Enter && terminal_selected(&form) {
        open_terminal(app, form);
        return;
    }
    let mut launch = false;
    let task_width = form.child_area.width.saturating_sub(6).max(1) as usize;
    if form.child_active {
        if let Some(c) = &mut form.child {
            let editing = c.kind.editing();
            match key.code {
                KeyCode::Enter if c.kind == Choice::Task && key.modifiers.contains(KeyModifiers::ALT) => {
                    c.picker.type_char('\n');
                }
                KeyCode::Enter => choose(app, &mut form),
                KeyCode::Tab | KeyCode::BackTab => form.child_active = false,
                KeyCode::Char('l') if ctrl && matches!(c.kind, Choice::Folder(_)) => {
                    let path = if let Choice::Folder(path) = &c.kind {
                        path.clone()
                    } else {
                        String::new()
                    };
                    let previous = form.child.take().unwrap();
                    step_into(app, &mut form, previous, Choice::Path, &path);
                }
                KeyCode::Up if c.kind == Choice::Task => task::move_vertical(&mut c.picker, -1, task_width),
                KeyCode::Down if c.kind == Choice::Task => task::move_vertical(&mut c.picker, 1, task_width),
                KeyCode::Up if !editing => c.picker.move_by(-1),
                KeyCode::Down if !editing => c.picker.move_by(1),
                KeyCode::PageUp if !editing => c.picker.move_by(-c.picker.page_rows.get().max(1)),
                KeyCode::PageDown if !editing => c.picker.move_by(c.picker.page_rows.get().max(1)),
                KeyCode::Char('p') if ctrl && !editing => c.picker.move_by(-1),
                KeyCode::Char('n') if ctrl && !editing => c.picker.move_by(1),
                KeyCode::Backspace => c.picker.backspace(false),
                KeyCode::Delete => c.picker.delete_forward(),
                KeyCode::Left => c.picker.qmove(-1, ctrl),
                KeyCode::Right => c.picker.qmove(1, ctrl),
                KeyCode::Char('b') if ctrl => c.picker.qmove(-1, false),
                KeyCode::Char('f') if ctrl => c.picker.qmove(1, false),
                KeyCode::Home | KeyCode::Char('a') if key.code == KeyCode::Home || ctrl => {
                    c.picker.qhome()
                }
                KeyCode::End | KeyCode::Char('e') if key.code == KeyCode::End || ctrl => {
                    c.picker.qend()
                }
                KeyCode::Char('u') if ctrl => c.picker.clear_query(),
                KeyCode::Char('k') if ctrl => c.picker.kill_line(),
                KeyCode::Char('w') if ctrl => c.picker.backspace(true),
                KeyCode::Char('y') if ctrl => c.picker.yank(),
                KeyCode::Char(ch)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    c.picker.type_char(ch)
                }
                _ => {}
            }
        }
        if form
            .child
            .as_ref()
            .is_some_and(|c| c.kind == Choice::Branch)
        {
            refresh_form(app, &mut form);
        }
    } else {
        match key.code {
            KeyCode::Up => {
                form.move_by(-1);
                reveal(app, &mut form);
            }
            KeyCode::Down => {
                form.move_by(1);
                reveal(app, &mut form);
            }
            KeyCode::Tab | KeyCode::BackTab => {
                if form.child.is_some() {
                    form.child_active = true;
                } else {
                    form.move_by(if key.code == KeyCode::BackTab { -1 } else { 1 });
                    reveal(app, &mut form);
                }
            }
            KeyCode::Enter | KeyCode::Char(' ') => launch = activate(app, &mut form),
            KeyCode::Right if form.focus != Field::Create => {
                activate(app, &mut form);
            }
            KeyCode::Left | KeyCode::PageUp | KeyCode::PageDown
                if form.focus == Field::Worktree =>
            {
                activate(app, &mut form);
            }
            KeyCode::Char(ch)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                if form.child.is_none() && form.focus != Field::Create {
                    reveal(app, &mut form);
                }
                if form.child.is_some() {
                    form.child_active = true;
                    form.child.as_mut().unwrap().picker.type_char(ch);
                } else {
                    let field = match ch {
                        'a' => Some(Field::Agent),
                        'p' => Some(Field::Project),
                        't' => Some(Field::Task),
                        _ => None,
                    };
                    if let Some(field) = field {
                        form.focus = field;
                        activate(app, &mut form);
                    }
                }
            }
            _ => {}
        }
    }
    form.save_task();
    if form
        .child
        .as_ref()
        .is_some_and(|c| c.kind == Choice::Branch)
    {
        refresh_form(app, &mut form);
    }
    app.modal = Some(Modal::NewHarness(form));
    if launch {
        start(app);
    }
}
pub fn paste(form: &mut Form, text: &str) {
    if form.starting || form.attempt.is_some() {
        return;
    }
    if let Some(c) = &mut form.child {
        form.child_active = true;
        if c.kind == Choice::Task {
            let text: String = text.replace("\r\n", "\n").replace('\r', "\n").chars()
                .filter(|ch| *ch == '\n' || *ch == '\t' || !ch.is_control()).collect();
            let at = c.picker.query.char_indices().nth(c.picker.qcursor)
                .map(|(at, _)| at).unwrap_or(c.picker.query.len());
            c.picker.qcursor = c.picker.query[..at].chars().count() + text.chars().count();
            c.picker.query.insert_str(at, &text);
            form.save_task();
            return;
        }
        let mut line_break = false;
        for ch in text.chars() {
            if matches!(ch, '\r' | '\n') {
                if !line_break {
                    c.picker.type_char(' ');
                }
                line_break = true;
            } else {
                line_break = false;
                if !ch.is_control() {
                    c.picker.type_char(ch);
                }
            }
        }
    }
}
pub fn mouse(app: &mut App, mouse: MouseEvent) {
    let Some(Modal::NewHarness(mut form)) = app.modal.take() else {
        return;
    };
    let pos = Position::new(mouse.column, mouse.row);
    let mut launch = false;
    if !form.starting && form.attempt.is_some() {
        if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
            launch = form
                .hits
                .iter()
                .any(|(r, field)| *field == Field::Create && r.contains(pos));
            if !form.area.contains(pos) {
                app.new_harness_draft = Some(form);
                return;
            }
        }
    } else if !form.starting {
        if matches!(
            mouse.kind,
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
        ) && form.child_area.contains(pos)
        {
            if let Some(c) = &mut form.child {
                form.child_active = true;
                let delta = if mouse.kind == MouseEventKind::ScrollUp {
                    -1
                } else {
                    1
                };
                if c.kind == Choice::Task {
                    task::move_vertical(&mut c.picker, delta, form.child_area.width.saturating_sub(6).max(1) as usize);
                } else {
                    c.picker.move_by(delta as i64);
                }
            }
        } else if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
            if form.child.is_some() && form.child_area.contains(pos) {
                form.child_active = true;
                let c = form.child.as_mut().unwrap();
                if c.kind == Choice::Task {
                    task::click(&mut c.picker, form.child_area, pos);
                } else if let Some((_, index)) = c.picker.row_at.iter().find(|(y, _)| *y == mouse.row) {
                    c.picker.cursor = *index;
                    if terminal_selected(&form) {
                        open_terminal(app, form);
                        return;
                    }
                    choose(app, &mut form);
                }
            } else if let Some((_, field)) = form.hits.iter().find(|(r, _)| r.contains(pos)) {
                form.focus = *field;
                reveal(app, &mut form);
                launch = activate(app, &mut form);
            } else if !form.area.contains(pos) {
                if !back(app, &mut form) {
                    app.new_harness_draft = Some(form);
                    return;
                }
            }
        }
    }
    app.modal = Some(Modal::NewHarness(form));
    if launch {
        start(app);
    }
}

/// Validate launch choices using the selected machine; no side effects occur while browsing.
pub fn start(app: &mut App) {
    let Some(Modal::NewHarness(mut form)) = app.modal.take() else {
        return;
    };
    if form.starting {
        app.modal = Some(Modal::NewHarness(form));
        return;
    }
    if let Some(attempt) = form.attempt.clone() {
        form.starting = true;
        form.checking = true;
        form.error.clear();
        let id = form.id.clone();
        app.modal = Some(Modal::NewHarness(form));
        crate::input::check_creation(app, id, attempt);
        return;
    }
    resolve_launch_machine(app, &mut form);
    form.save_task();
    let fail = if let Some(error) = task::error(&form.draft.what.engine, &form.draft.task) {
        Some(error)
    } else if form.git_loading {
        Some("Checking the project…".into())
    } else if form.git["error"].is_string() {
        Some("Could not read this project. Choose Branch to retry.".into())
    } else {
        form.project_payload().err()
    };
    if let Some(error) = fail {
        form.error = error;
        app.modal = Some(Modal::NewHarness(form));
        return;
    }
    let Some(link) = app.link(&form.draft.machine) else {
        form.error = "That machine is not connected".into();
        app.modal = Some(Modal::NewHarness(form));
        return;
    };
    let id = form.id.clone();
    let model = form.draft.model.is_some();
    let profile = form.draft.what.engine == "codex"
        && form.draft.model.is_none()
        && form.draft.profile.is_some();
    let package = form.draft.what.dsh.is_some();
    if !model && !profile && !package {
        launch(app, form, true);
        return;
    }
    form.starting = true;
    form.error.clear();
    app.modal = Some(Modal::NewHarness(form));
    app.spawn(async move{
        let models=async{if model{link.rpc("grid_models_list",json!({"rowState":true}),Duration::from_secs(30)).await.ok()}else{None}};
        let profiles=async{if profile{link.rpc("codex_profiles_list",json!({}),Duration::from_secs(20)).await.ok()}else{None}};
        let packages=async{if package{link.rpc("dsh_list",json!({}),Duration::from_secs(20)).await.ok()}else{None}};
        tokio::join!(models,profiles,packages)
    },move|app,(models,profiles,packages)|{
        let visible=matches!(&app.modal,Some(Modal::NewHarness(f))if f.id==id);
        let mut result=None;with_form(app,&id,|_,form|{form.starting=false;
            if let Some((grid,id,_))=&form.draft.model{let expected=json!([grid,id]).to_string();if !data::model_rows(&models.unwrap_or(Value::Null),&form.draft.what.engine).iter().any(|r|r.id==expected&&!r.disabled){form.error="Model unavailable here. Choose a model or your subscription.".into();return}}
            if profile{let (machine,path,_)=form.draft.profile.as_ref().unwrap();if machine!=&form.draft.machine{form.error="Choose a profile on this machine.".into();return}if !profiles.unwrap_or(Value::Null)["profiles"].as_array().into_iter().flatten().any(|p|p["path"].as_str()==Some(path)){form.error="Profile unavailable here. Choose another profile.".into();return}}
            if let Some(dsh)=&form.draft.what.dsh{let catalog=packages.unwrap_or(Value::Null);let row=catalog["dsh"].as_array().into_iter().flatten().find(|r|r["id"].as_str()==Some(dsh));
                let Some(row)=row else{form.error="This harness is unavailable on this machine. Choose an agent or harness.".into();return};
                if row["installed"]==false{form.error="Install this harness from the Store first, then retry.".into();return}
                let compatible=row["engines"].as_array().filter(|a|!a.is_empty()).map(|a|a.iter().any(|e|e.as_str()==Some(&form.draft.what.engine))).unwrap_or_else(||row["engine"].as_str().unwrap_or("claude")==form.draft.what.engine);
                if !compatible{form.error="Choose a compatible coding agent for this harness.".into();return}
            }result=Some(());
        });
        if result.is_some(){let form=if visible{let Some(Modal::NewHarness(f))=app.modal.take()else{return};f}else{let Some(f)=app.new_harness_draft.take()else{return};f};launch(app,form,visible);}
    });
}
fn launch(app: &mut App, mut form: Box<Form>, visible: bool) {
    let d = form.draft.clone();
    let (cwd, mut extra) = match form.project_payload() {
        Ok(v) => v,
        Err(e) => {
            form.error = e;
            app.modal = Some(Modal::NewHarness(form));
            return;
        }
    };
    if d.what.engine == "terminal" && cwd.is_none() {
        form.error = "Choose an existing folder for a terminal".into();
        app.modal = Some(Modal::NewHarness(form));
        return;
    }
    extra["permissionMode"] = Value::Null;
    extra["bypassPermission"] = json!(false);
    if !data::modes(&d.what.engine).is_empty() {
        extra["permissionMode"] = json!(d.permission);
        extra["bypassPermission"] = json!(matches!(d.permission.as_str(), "auto" | "full"));
    }
    if let Some((grid, id, _)) = &d.model {
        extra["gridName"] = json!(grid);
        extra["gridModel"] = json!(id);
    }
    if d.what.engine == "codex" && d.model.is_none() {
        if let Some((_, path, _)) = &d.profile {
            extra["codexHome"] = json!(path);
        }
    }
    let id = form.id.clone();
    let previous = app.modal.take();
    app.modal = Some(Modal::NewHarness(form));
    crate::input::create_opts(
        app,
        d.machine,
        d.what,
        cwd,
        Some(d.task),
        false,
        crate::input::NewOpts {
            extra: Some(extra),
            form_id: Some(id),
            ..Default::default()
        },
    );
    if !visible {
        if let Some(Modal::NewHarness(form)) = app.modal.take() {
            app.new_harness_draft = Some(form);
        }
        app.modal = previous;
    }
}
/// Apply the daemon's receipt before deciding whether another launch is allowed.
/// A status check is read-only, even after a reconnect or a daemon upgrade.
pub fn creation_reply(
    app: &mut App,
    id: &str,
    reply: &Result<Value, crate::daemon::RpcError>,
    checking: bool,
) -> bool {
    let mut created = false;
    with_form(app, id, |app, form| {
        let Some(attempt) = &form.attempt else { return };
        let outcome = receipt::outcome(&attempt.id, reply, checking);
        form.starting = false;
        form.checking = false;
        match outcome {
            receipt::Outcome::Created => created = true,
            receipt::Outcome::Failed {
                message,
                prepared_folder,
            } => {
                form.attempt = None;
                form.error = message;
                if let Some(path) = prepared_folder {
                    set_project(form, Project::Folder(path.clone()));
                    form.prepared_folder = Some(path);
                    form.draft.worktree = Some(false);
                    sync_git(app, form, true);
                }
            }
            receipt::Outcome::Uncertain(message) => form.error = message,
        }
    });
    created
}

pub fn created(app: &mut App, id: &str, agent: &Value) {
    with_form(app, id, |_, form| {
        if !matches!(form.draft.project, Project::Folder(_)) {
            if let Some(cwd) = agent
                .pointer("/project/cwd")
                .or_else(|| agent.get("cwd"))
                .and_then(Value::as_str)
            {
                form.draft.project = Project::Folder(cwd.into());
            }
        }
    });
    completed(app, id, None);
}
pub fn completed(app: &mut App, id: &str, error: Option<String>) {
    let mut success = false;
    with_form(app, id, |_, form| {
        form.starting = false;
        if let Some(error) = error {
            form.error = error;
        } else {
            remember(form);
            success = true;
        }
    });
    if success {
        if matches!(&app.modal,Some(Modal::NewHarness(f))if f.id==id) {
            app.modal = None;
        }
        if app.new_harness_draft.as_ref().is_some_and(|f| f.id == id) {
            app.new_harness_draft = None;
        }
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
            id: "local".into(),
            name: "studio".into(),
            local: true,
            status: "online".into(),
            reach: crate::fleet::Reach::Ready,
        });
        app.homes.insert("local".into(), "/home/dev".into());
        app
    }

    /// Opening a chooser leaves the main form where it was, on a wide window and a narrow one.
    #[tokio::test]
    async fn the_form_stays_put_when_a_chooser_opens() {
        let mut app = app();
        open(&mut app, None, Some("/home/dev/project".into()));
        let Some(Modal::NewHarness(mut form)) = app.modal.take() else { panic!() };
        for body in [Rect::new(0, 0, 150, 41), Rect::new(0, 0, 90, 30)] {
            form.child = None;
            draw(&mut Buffer::empty(body), body, &mut form);
            let alone = form.area;
            child(&mut app, &mut form, Choice::Agent, "codex");
            draw(&mut Buffer::empty(body), body, &mut form);
            assert_eq!(form.area, alone, "the form moved at {}x{}", body.width, body.height);
        }
    }

    #[tokio::test]
    async fn local_shell_entry_does_not_override_the_registered_launch_machine() {
        let mut app = app();
        let shell = crate::local::MACHINE;
        app.fleet.machines.insert(0, crate::fleet::Machine {
            id: shell.into(), name: "m0".into(), local: true,
            status: "running".into(), reach: crate::fleet::Reach::Ready,
        });
        for explicit in [None, Some(shell.into())] {
            open(&mut app, explicit, None);
            let Some(Modal::NewHarness(form)) = &app.modal else { panic!() };
            assert_eq!(form.draft.machine, "local");
            assert_eq!(form.project_label(), "New Folder @ local");
            for rows in [modal::machine_rows(&app), modal::new_machine_rows(&app, shell)] {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].id, "local");
                assert_eq!(rows[0].label, "studio");
            }
        }
        // Recent local-shell folders use that same machine and collapse duplicate paths.
        for machine in [shell, "local"] {
            let agent = crate::fleet::agent_from(machine, &json!({"id":"agent", "engine":"terminal", "project":{"cwd":"/home/dev/repo"}}), None);
            app.fleet.agents.insert(agent.key(), agent);
        }
        let Some(Modal::NewHarness(form)) = &app.modal else { panic!() };
        let rows = project_rows(&app, &form.draft);
        let recent: Vec<_> = rows.iter().filter(|r| r.id.starts_with("at:")).collect();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, "at:local\t/home/dev/repo");
        assert_eq!(recent[0].label, "~/repo @ local");
    }

    #[tokio::test]
    async fn project_search_reaches_remote_machines_after_a_large_local_history() {
        let mut app = app();
        for name in ["office", "m2"] {
            app.fleet.machines.push(crate::fleet::Machine {
                id: name.into(), name: name.into(), local: false,
                status: "running".into(), reach: crate::fleet::Reach::Ready,
            });
            app.homes.insert(name.into(), "/home/dev".into());
        }
        for (machine, count) in [("local", 100), ("office", 1), ("m2", 1)] {
            for i in 0..count {
                let agent = crate::fleet::agent_from(machine, &json!({
                    "id": format!("agent-{i}"), "engine": "codex",
                    "project": {"cwd": format!("/home/dev/harnesses/autonomous-harness-2026-{i:03}")},
                }), None);
                app.fleet.agents.insert(agent.key(), agent);
            }
        }
        open(&mut app, None, None);
        let Some(Modal::NewHarness(mut form)) = app.modal.take() else { panic!() };
        child(&mut app, &mut form, Choice::Project, "");
        assert_eq!(form.child.as_ref().unwrap().picker.rows.iter().filter(|r| r.id.starts_with("at:")).count(), 52);
        for machine in ["office", "m2"] {
            for query in [format!("{machine} harness"), format!("harness {machine}")] {
                let picker = &mut form.child.as_mut().unwrap().picker;
                picker.set_query(&query);
                let selected = picker.current().expect("the remote project is searchable");
                assert_eq!(selected.id, format!("at:{machine}\t/home/dev/harnesses/autonomous-harness-2026-000"), "{query}");
                assert!(selected.label.ends_with(&format!(" @ {machine}")));
                assert!(!selected.disabled);
            }
            choose(&mut app, &mut form);
            assert_eq!(form.draft.machine, machine);
            assert!(matches!(&form.draft.project, Project::Folder(path) if path == "/home/dev/harnesses/autonomous-harness-2026-000"));
            child(&mut app, &mut form, Choice::Project, "");
        }
    }

    #[tokio::test]
    async fn project_limits_count_unique_folders_per_machine_by_recent_activity() {
        let mut app = app();
        let shell = crate::local::MACHINE;
        for (id, local) in [(shell, true), ("office", false)] {
            app.fleet.machines.push(crate::fleet::Machine {
                id: id.into(), name: id.into(), local,
                status: "running".into(), reach: crate::fleet::Reach::Ready,
            });
        }
        for machine in ["local", "office"] {
            for i in 0..70 {
                let mut agent = crate::fleet::agent_from(machine, &json!({
                    "id": format!("agent-{i}"), "engine": "codex",
                    "project": {"cwd": format!("/home/dev/repo-{i:02}")},
                }), None);
                agent.updated_at = 1000 - i;
                app.fleet.agents.insert(agent.key(), agent);
            }
            // Many sessions in the oldest folder make it most recent but use just one slot.
            // A local shell is the same destination as its registered local daemon.
            let source = if machine == "local" { shell } else { machine };
            for i in 0..10 {
                let mut agent = crate::fleet::agent_from(source, &json!({
                    "id": format!("duplicate-{i}"), "engine": "terminal",
                    "project": {"cwd": "/home/dev/repo-69"},
                }), None);
                agent.active_at = 2000 + i;
                app.fleet.agents.insert(agent.key(), agent);
            }
        }
        open(&mut app, None, None);
        let Some(Modal::NewHarness(form)) = &app.modal else { panic!() };
        let rows = project_rows(&app, &form.draft);
        for machine in ["local", "office"] {
            let prefix = format!("at:{machine}\t");
            let actual: Vec<_> = rows.iter().filter(|r| r.id.starts_with(&prefix)).map(|r| r.id.clone()).collect();
            let expected: Vec<_> = std::iter::once(69).chain(0..49)
                .map(|i| format!("at:{machine}\t/home/dev/repo-{i:02}")).collect();
            assert_eq!(actual, expected);
        }
        assert!(!rows.iter().any(|r| r.id.starts_with(&format!("at:{shell}\t"))));
    }

    #[tokio::test]
    async fn project_search_keeps_the_short_local_machine_name_searchable() {
        let mut app = app();
        app.fleet.machine_mut("local").unwrap().name = "M2".into();
        let agent = crate::fleet::agent_from("local", &json!({
            "id": "agent", "engine": "codex", "project": {"cwd": "/home/dev/harnesses/repo"},
        }), None);
        app.fleet.agents.insert(agent.key(), agent);
        open(&mut app, None, None);
        let Some(Modal::NewHarness(mut form)) = app.modal.take() else { panic!() };
        child(&mut app, &mut form, Choice::Project, "");
        let picker = &mut form.child.as_mut().unwrap().picker;
        for query in ["m2 harness", "harness m2", "M2 harness", "local harness"] {
            picker.set_query(query);
            let selected = picker.current().expect("the real machine name and local both work");
            assert_eq!(selected.id, "at:local\t/home/dev/harnesses/repo", "{query}");
            assert_eq!(selected.label, "~/harnesses/repo @ local");
            assert!(picker.visible.iter().all(|(i, hits)| hits.iter().all(|at| (*at as usize) < picker.rows[*i].label.chars().count())));
        }
    }

    #[tokio::test]
    async fn daemon_return_redirects_an_idle_local_draft_but_keeps_a_pending_receipt() {
        for pending in [false, true] {
            let mut app = app();
            let shell = crate::local::MACHINE;
            app.fleet.machines.insert(0, crate::fleet::Machine {
                id: shell.into(), name: "m0".into(), local: true,
                status: "running".into(), reach: crate::fleet::Reach::Ready,
            });
            app.homes.insert(shell.into(), "/home/dev".into());
            app.fleet.machine_mut("local").unwrap().reach = crate::fleet::Reach::Offline;
            open(&mut app, Some(shell.into()), Some("/home/dev/repo".into()));
            let Some(Modal::NewHarness(form)) = &mut app.modal else { panic!() };
            if pending {
                form.attempt = Some(Creation { id: "original".into(), machine: shell.into(), session: app.session_id });
            }
            app.fleet.machine_mut("local").unwrap().reach = crate::fleet::Reach::Ready;
            app.fleet.machine_mut("local").unwrap().name = "office".into();
            refresh(&mut app);
            let Some(Modal::NewHarness(form)) = &app.modal else { panic!() };
            assert_eq!(form.draft.machine, if pending { shell } else { "local" });
            assert_eq!(form.project_label(), "repo @ local");
            if pending { assert_eq!(form.attempt.as_ref().unwrap().machine, shell); }
        }
    }

    #[tokio::test]
    async fn draft_survives_picker_escape_and_late_refresh() {
        let mut app = app();
        open(&mut app, None, Some("/home/dev/project".into()));
        let Some(Modal::NewHarness(mut form)) = app.modal.take() else {
            panic!()
        };
        form.focus = Field::Agent;
        child(&mut app, &mut form, Choice::Agent, "codex");
        app.modal = Some(Modal::NewHarness(form));
        refresh(&mut app);
        let Some(Modal::NewHarness(form)) = app.modal.take() else {
            panic!()
        };
        assert_eq!(form.child.as_ref().unwrap().picker.query, "codex");
        key(
            &mut app,
            form,
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
        );
        let Some(Modal::NewHarness(form)) = &app.modal else {
            panic!()
        };
        assert!(form.child.is_none());
        assert!(matches!(&form.draft.project, Project::Folder(p) if p == "/home/dev/project"));
        let Some(Modal::NewHarness(form)) = app.modal.take() else { panic!() };
        key(&mut app, form, KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
        let Some(Modal::NewHarness(form)) = app.modal.take() else { panic!() };
        assert!(form.child_active);
        key(&mut app, form, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        let Some(Modal::NewHarness(form)) = app.modal.take() else { panic!() };
        key(&mut app, form, KeyEvent::new(KeyCode::Char('c'), KeyModifiers::NONE));
        let Some(Modal::NewHarness(form)) = &app.modal else { panic!() };
        assert!(form.child_active);
        assert_eq!(form.child.as_ref().unwrap().picker.query, "c");
        app.modal = Some(Modal::Confirm {
            prompt: "keep me".into(),
            command: "".into(),
            key: 'y',
            enter_yes: false,
        });
        refresh(&mut app);
        assert!(matches!(app.modal, Some(Modal::Confirm { .. })));
    }

    #[tokio::test]
    async fn multiline_task_survives_editing_dismissal_and_agent_changes() {
        let mut app = app();
        open(&mut app, None, Some("/home/dev/project".into()));
        let Some(Modal::NewHarness(mut form)) = app.modal.take() else { panic!() };
        form.focus = Field::Task;
        assert!(!activate(&mut app, &mut form));
        paste(&mut form, "Fix café\r\n\r\nKeep 界 and 🦀 intact.");
        let expected = "Fix café\n\nKeep 界 and 🦀 intact.";
        assert_eq!(form.draft.task, expected);
        key(&mut app, form, KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT));
        let Some(Modal::NewHarness(form)) = app.modal.take() else { panic!() };
        assert_eq!(form.draft.task, format!("{expected}\n"));
        // Escape leaves the editor with its text, then dismisses the draft.
        key(&mut app, form, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        let Some(Modal::NewHarness(form)) = app.modal.take() else { panic!() };
        key(&mut app, form, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        open(&mut app, None, None);
        let Some(Modal::NewHarness(mut form)) = app.modal.take() else { panic!() };
        assert_eq!(form.draft.task, format!("{expected}\n"));
        set_engine(&mut form, "terminal");
        assert!(task::error(&form.draft.what.engine, &form.draft.task).is_some());
        assert!(form.blocked(Field::Task).is_none(), "a retained task can still be cleared");
        set_engine(&mut form, "claude");
        reveal(&mut app, &mut form);
        assert_eq!(form.child.as_ref().unwrap().picker.query, format!("{expected}\n"));
        choose(&mut app, &mut form);
        assert_eq!(form.focus, Field::Create);
        assert_eq!(form.draft.task, format!("{expected}\n"));
    }

    #[tokio::test]
    async fn compact_form_and_side_choosers_stay_anchored_at_every_terminal_size() {
        let mut app = app();
        open(&mut app, None, None);
        let Some(Modal::NewHarness(mut form)) = app.modal.take() else {
            panic!()
        };
        for width in [
            1, 10, 21, 22, 45, 80, 109, 110, 120, 128, 130, 131, 132, 150, 220,
        ] {
            for height in [1, 4, 5, 10, 14, 24, 42] {
                let area = Rect::new(3, 2, width, height);
                let mut anchor = None;
                for engine in ["claude", "codex", "terminal"] {
                    set_engine(&mut form, engine);
                    for chooser in [None, Some(Choice::Agent), Some(Choice::Clone), Some(Choice::Task), None] {
                        if let Some(kind) = chooser {
                            let text = if kind == Choice::Task { "A long task with 界 and 🦀.\n".repeat(50) } else { String::new() };
                            child(&mut app, &mut form, kind, &text);
                        } else {
                            form.child = None;
                        }
                        for active in [false, true] {
                            form.child_active = active;
                            let mut buf = Buffer::empty(area);
                            if let Some(cursor) = draw(&mut buf, area, &mut form) {
                                assert!(active, "a preview must not take keyboard focus");
                                assert!(area.contains(cursor), "{area:?} {cursor:?}");
                            }
                            for (hit, _) in &form.hits {
                                assert_eq!(hit.intersection(area), *hit);
                            }
                            if form.area.width > 0 {
                                // The form's panel: its own height, one size and place whatever is open.
                                assert_eq!(form.area, crate::settings::area(area, crate::settings::PanelSize::Form, view::HEIGHT));
                                assert!(form.area.width <= 60 && form.area.height <= 17);
                                let left = form.area.x - area.x;
                                let right = area.right() - form.area.right();
                                assert!(left.abs_diff(right) <= 1, "not centered in {area:?}");
                                let top = form.area.y - area.y;
                                let bottom = area.bottom() - form.area.bottom();
                                assert!(top.abs_diff(bottom) <= 1, "not centered in {area:?}");
                                assert_eq!(
                                    *anchor.get_or_insert(form.area),
                                    form.area,
                                    "form moved in {area:?}: engine={engine}, active={active}"
                                );
                                assert_eq!(form.area.intersection(area), form.area);
                            }
                            if form.child_area.width > 0 {
                                assert_eq!(form.child_area.intersection(area), form.child_area);
                                assert_eq!(form.child_area.y, form.area.y);
                                if form.child_area.x == form.area.x {
                                    assert!(active, "narrow previews must leave the form visible");
                                    assert_eq!(form.child_area, form.area);
                                } else {
                                    assert_eq!(form.child_area.x, form.area.right() + 2);
                                    assert!(form.child_area.width >= 32);
                                }
                            }
                            if width >= 80 && height >= 24
                                && (form.child_area.is_empty() || form.child_area.x > form.area.x)
                            {
                                assert_eq!(form.hits.len(), form.fields().len(), "all settings stay visible");
                            }
                        }
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn project_chooser_keeps_the_selected_row_visible_past_the_action_separator() {
        let mut app = app();
        open(&mut app, None, None);
        let Some(Modal::NewHarness(mut form)) = app.modal.take() else { panic!() };
        child(&mut app, &mut form, Choice::Project, "");
        form.child_active = true;
        let mut rows = vec![Row::new("clone", "Clone Repository"), Row::new("folder", "Open Folder"), Row::new("new", "New Folder")];
        rows.extend((0..50).map(|n| Row::new(format!("at:local\t/project-{n}"), format!("project-{n} @ local"))));
        form.child.as_mut().unwrap().picker.set_rows(rows);
        for width in [80, 150] {
            let area = Rect::new(0, 0, width, 42);
            let count = form.child.as_ref().unwrap().picker.visible.len();
            for cursor in (0..count).chain((0..count).rev()) {
                form.child.as_mut().unwrap().picker.cursor = cursor;
                draw(&mut Buffer::empty(area), area, &mut form);
                let picker = &form.child.as_ref().unwrap().picker;
                assert!(picker.row_at.iter().any(|(_, row)| *row == cursor), "selected row {cursor} is hidden at width {width}");
            }
        }
    }

    #[tokio::test]
    async fn terminal_resize_before_its_input_event_keeps_the_form_and_choosers_in_frame() {
        for choice in [None, Some(Choice::Agent), Some(Choice::Task)] {
            let mut app = app();
            open(&mut app, None, None);
            if let Some(kind) = choice {
                let Some(Modal::NewHarness(mut form)) = app.modal.take() else { panic!() };
                child(&mut app, &mut form, kind, "");
                app.modal = Some(Modal::NewHarness(form));
            }
            // The backend has already resized, but no Resize input event has been delivered.
            for (width, height) in [(80, 24), (45, 14), (22, 5), (1, 1), (150, 42)] {
                let mut terminal = ratatui::Terminal::new(
                    ratatui::backend::TestBackend::new(width, height),
                ).unwrap();
                terminal.draw(|frame| crate::ui::draw(frame, &mut app)).unwrap();
                let bounds = Rect::new(0, 0, width, height);
                let Some(Modal::NewHarness(form)) = &app.modal else { panic!() };
                assert_eq!(form.area.intersection(bounds), form.area);
                assert_eq!(form.child_area.intersection(bounds), form.child_area);
                assert!(form.hits.iter().all(|(hit, _)| hit.intersection(bounds) == *hit));
            }
        }
    }

    #[tokio::test]
    async fn project_error_keeps_its_recovery_instruction_and_action_visible() {
        let mut app = app();
        open(&mut app, None, None);
        let Some(Modal::NewHarness(mut form)) = app.modal.take() else { panic!() };
        form.error = "Could not start it: “My-First-Claude-Project” already exists. Select that folder from your projects.".into();
        for width in [45, 80, 130] {
            let area = Rect::new(0, 0, width, 38);
            let mut buf = Buffer::empty(area);
            draw(&mut buf, area, &mut form);
            let text: String = (form.area.y..form.area.bottom()).map(|y| {
                (form.area.x + 2..form.area.right() - 2)
                    .map(|x| buf[(x, y)].symbol()).collect::<String>().trim().to_string()
            }).collect::<Vec<_>>().join(" ");
            assert!(text.contains("already exists. Select that folder from your projects."), "{text}");
            assert!(form.hits.iter().any(|(_, f)| *f == Field::Create));
            assert_eq!(form.area.intersection(area), form.area);
        }
        form.error = "项目".repeat(100);
        for height in [5, 10, 24] {
            let area = Rect::new(0, 0, 22, height);
            let mut buf = Buffer::empty(area);
            draw(&mut buf, area, &mut form);
            assert_eq!(form.area.intersection(area), form.area);
            assert!(form.hits.iter().any(|(_, f)| *f == Field::Create));
        }
    }

    #[tokio::test]
    async fn terminal_and_agent_options_match_the_launch_contract() {
        let mut app = app();
        open(&mut app, None, Some("/home/dev/repo".into()));
        let Some(Modal::NewHarness(mut f)) = app.modal.take() else {
            panic!()
        };
        assert_eq!(f.draft.what.engine, "opencode");
        assert_eq!(f.draft.permission, "auto");
        // Exercise remembered per-engine choices independently of the launch default.
        set_engine(&mut f, "codex");
        f.draft.permission = "readOnly".into();
        set_engine(&mut f, "claude");
        assert_eq!(f.draft.permission, "auto");
        f.draft.permission = "plan".into();
        set_engine(&mut f, "codex");
        assert_eq!(f.draft.permission, "readOnly");
        set_engine(&mut f, "terminal");
        assert!(!f.fields().contains(&Field::Approvals));
        assert!(!f.fields().contains(&Field::Model));
        assert!(!f.fields().contains(&Field::Profile));
        child(&mut app, &mut f, Choice::Clone, "");
        paste(&mut f, "owner/\r\nrepository");
        assert_eq!(f.child.as_ref().unwrap().picker.query, "owner/ repository");
    }

    #[tokio::test]
    async fn delayed_callbacks_only_update_their_own_dismissed_draft() {
        let mut app = app();
        open(&mut app, None, Some("/home/dev/repo".into()));
        let Some(Modal::NewHarness(f)) = app.modal.take() else {
            panic!()
        };
        let id = f.id.clone();
        key(&mut app, f, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.modal.is_none());
        app.modal = Some(Modal::Confirm {
            prompt: "stay here".into(),
            command: "".into(),
            key: 'y',
            enter_yes: false,
        });
        with_form(&mut app, &id, |_, f| f.error = "late error".into());
        assert!(matches!(app.modal, Some(Modal::Confirm { .. })));
        assert_eq!(app.new_harness_draft.as_ref().unwrap().error, "late error");
        with_form(&mut app, "stale-id", |_, _| panic!("wrong draft"));
    }

    #[tokio::test]
    async fn uncertain_launch_keeps_its_machine_and_choices_until_confirmed() {
        let mut app = app();
        open(&mut app, None, None);
        let Some(Modal::NewHarness(mut f)) = app.modal.take() else {
            panic!()
        };
        let id = f.id.clone();
        f.attempt = Some(Creation {
            id: "intent".into(),
            machine: "local".into(),
            session: 0,
        });
        app.modal = Some(Modal::NewHarness(f));
        assert!(!creation_reply(
            &mut app,
            &id,
            &Err(crate::daemon::RpcError::new("TIMEOUT", "")),
            false
        ));
        let Some(Modal::NewHarness(f)) = app.modal.take() else {
            panic!()
        };
        key(
            &mut app,
            f,
            KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE),
        );
        let Some(Modal::NewHarness(f)) = app.modal.take() else {
            panic!()
        };
        assert!(
            f.child.is_none(),
            "choices cannot change an unresolved launch"
        );
        key(&mut app, f, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        // Even an explicit new destination must recover the existing attempt first.
        open(&mut app, Some("local".into()), Some("/another".into()));
        let Some(Modal::NewHarness(f)) = &app.modal else {
            panic!()
        };
        assert_eq!(f.id, id);
        assert_eq!(f.describe(Field::Create).0, "Check status");
        assert!(!creation_reply(
            &mut app,
            &id,
            &Ok(json!({"creationId":"wrong", "state":"created", "agent":{"id":"wrong"}})),
            true
        ));
        assert!(creation_reply(
            &mut app,
            &id,
            &Ok(json!({"creationId":"intent", "state":"created", "agent":{"id":"original"}})),
            true
        ));
    }

    #[tokio::test]
    async fn confirmed_failure_reuses_prepared_worktree_without_preparing_another() {
        let mut app = app();
        open(&mut app, None, None);
        let Some(Modal::NewHarness(mut f)) = app.modal.take() else {
            panic!()
        };
        let id = f.id.clone();
        f.attempt = Some(Creation {
            id: "intent".into(),
            machine: "local".into(),
            session: 0,
        });
        app.modal = Some(Modal::NewHarness(f));
        assert!(!creation_reply(
            &mut app,
            &id,
            &Ok(
                json!({"creationId":"intent", "state":"failed", "failure":{"code":"ENGINE_UNAVAILABLE"}, "preparedFolder":"/repo/worktree"})
            ),
            true
        ));
        let Some(Modal::NewHarness(f)) = &mut app.modal else {
            panic!()
        };
        assert!(
            f.attempt.is_none(),
            "a new deliberate retry gets a fresh receipt"
        );
        f.git = json!({"isGit":true, "branch":"feature", "defaultRef":"refs/heads/main"});
        assert_eq!(
            f.project_payload().unwrap(),
            (Some("/repo/worktree".into()), json!({}))
        );
        set_project(f, Project::Folder("/another".into()));
        assert!(f.prepared_folder.is_none());
    }

    #[test]
    fn home_abbreviation_requires_a_path_boundary() {
        assert_eq!(short_path("/home/dev/project", "/home/dev"), "~/project");
        assert_eq!(
            short_path("/home/developer/project", "/home/dev"),
            "/home/developer/project"
        );
    }
}
