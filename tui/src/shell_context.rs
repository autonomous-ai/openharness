//! Context owned by a shell pane. Helpers use bounded, nonce-scoped terminal
//! requests, so they also work over remote streams without a local socket path.
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::json;
use crate::app::{App, Placement};
use crate::modal::{Filter, Modal, PickerKind};
use crate::picker::{Picker, Row};
mod composition;
mod folders;

const PREFIX: &[u8] = b"\x1b]633;hn;";
const LIMIT: usize = 65536;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Route { pub grid: String, pub model: String, pub label: String }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Context {
    pub route: Option<Route>,
    /// One live shell per computer, private to this logical pane.
    pub hosts: HashMap<String, String>,
    pub previous: Option<String>,
    /// A session chosen from this shell temporarily occupies its view. When
    /// that agent exits, return to the same shell, including its editing state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    visit: Option<Visit>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Visit {
    #[serde(default = "visit_id")]
    id: String,
    pane: u64,
    machine: String,
    agent: String,
    source_machine: String,
    source_agent: String,
    source_cwd: Option<String>,
    #[serde(default)]
    source_runtime: String,
    #[serde(default)]
    source_created: String,
    #[serde(default)]
    started: bool,
    /// A shell_open invocation starts as a terminal before engine discovery. Its
    /// terminal label is not an agent exit; only its stopped process is one.
    #[serde(default)]
    terminal_process: bool,
    #[serde(skip)]
    returning_since: Option<Instant>,
    #[serde(skip)]
    checked_at: Option<Instant>,
    #[serde(skip)]
    checking: bool,
    #[serde(skip)]
    exited: bool,
    #[serde(skip)]
    resuming: bool,
}
fn visit_id() -> String { uuid::Uuid::new_v4().to_string() }
#[derive(Clone, Debug)]
pub struct Request { pub token: String, pub id: String, pub verb: String, pub query: String, pub pane: u64, pub at: Instant }
#[derive(Clone)]
struct Reply { request: Request, code: u8, text: String, data: Option<std::sync::Arc<serde_json::Value>>, at: Instant }

pub struct Inline {
    pub token: String, pub pane: u64, pub kind: String, id: String,
    hold: Option<Vec<String>>, at: Instant,
}
#[derive(Default)]
pub struct State {
    pub contexts: HashMap<String, Context>,
    parsers: HashMap<u64, Vec<u8>>,
    pub pending: Option<Request>,
    replies: VecDeque<Reply>,
    pub inline: Option<Inline>,
    routes: Vec<Route>,
    notice: String,
    connecting: bool,
    dirty: HashSet<String>,
    pub session_picker: Option<u64>,
    pub sessions_machine: Option<String>,
    pub catalog: Vec<crate::app::Said>,
    catalog_generation: u64,
    catalog_retry: Option<Instant>,
    catalog_started: Option<Instant>,
    pub catalog_notice: String,
    composition: Option<composition::Catalog>,
}

fn path() -> std::path::PathBuf { crate::app::sessions_path(None).with_extension("shell-context.json") }
impl State {
    pub fn load() -> Self {
        if cfg!(test) { return Self::default() }
        let contexts = std::fs::read(path()).ok().filter(|b| b.len() <= 1024 * 1024)
            .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { contexts, ..Self::default() }
    }
    pub fn save(&mut self) {
        if cfg!(test) { return }
        use std::os::unix::fs::OpenOptionsExt;
        use std::io::Write;
        let file = path();
        let Some(parent) = file.parent() else { return };
        if std::fs::create_dir_all(parent).is_err() { return }
        let Some(_lock) = crate::ipc::lock(&file) else { return };
        let mut merged: HashMap<String, Context> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        for token in &self.dirty { if let Some(context) = self.contexts.get(token) { merged.insert(token.clone(), context.clone()); } }
        let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
        if let Ok(mut out) = std::fs::OpenOptions::new().create(true).truncate(true).write(true).mode(0o600).open(&tmp) {
            if serde_json::to_writer(&mut out, &merged).is_ok() && out.flush().is_ok() { if std::fs::rename(&tmp, &file).is_ok() { self.dirty.clear(); } }
            else { let _ = std::fs::remove_file(&tmp); }
        }
    }
    pub fn token_for(&self, machine: &str, agent: &str) -> Option<String> {
        self.contexts.iter().find(|(_, c)| c.hosts.get(machine).is_some_and(|a| a == agent)).map(|(t, _)| t.clone())
    }
}

pub fn quote(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }

/// The focused shell's persistent context, not a guess at an agent's native default model.
pub fn status(app: &App, pane: Option<u64>) -> String {
    let Some(pane) = pane.and_then(|id| app.panes.get(&id)) else { return String::new() };
    let Some(token) = app.shell_context.token_for(&pane.machine_id, &pane.agent_id) else { return String::new() };
    let model = app.shell_context.contexts.get(&token).and_then(|c| c.route.as_ref())
        .map(|r| r.model.as_str()).unwrap_or("Agent default");
    format!("{} · {model}", app.fleet.machine_name(&pane.machine_id))
        .chars().filter(|c| !c.is_control()).collect::<String>().replace('#', "##")
}

/// The TUI's look as a shell picker draws it (see `shell_picker::Look`): colours of the chosen
/// theme, else the terminal's answer (empty until it answers: the picker keeps its default);
/// `lists` is "fzf" when the user chose fzf's lists, by `@hn-lists fzf` or fzf options of their own.
fn look_value() -> serde_json::Value { look_value_with(&crate::theme::default_opts()) }
/// [look_value] with the fzf options given, not read from the environment.
fn look_value_with(fzf_opts: &[String]) -> serde_json::Value {
    let (background, foreground) = crate::term_out::terminal_colours().unwrap_or_default();
    let accent = crate::term_out::accent_override()
        .or_else(|| crate::term_out::native_accent().map(|[r, g, b]| format!("#{r:02x}{g:02x}{b:02x}")))
        .unwrap_or_default();
    let fzf = crate::settings::fzf_lists() || !crate::shell_picker::composer_panel(fzf_opts);
    json!(crate::shell_picker::Look { background, foreground, accent, lists: if fzf { "fzf" } else { "" }.into() })
}

/// The look a new shell starts with, as `HN_LOOK` for its first picker frame.
fn look_arg() -> String { format!("--look={}", look_value()) }

/// Separate the `--look=` argument from the others.
fn split_look(args: &[String]) -> (Vec<String>, Option<String>) { split_option(args, "--look=") }
fn split_option(args: &[String], prefix: &str) -> (Vec<String>, Option<String>) {
    let value = args.iter().find_map(|a| a.strip_prefix(prefix)).map(String::from);
    (args.iter().filter(|a| !a.starts_with(prefix)).cloned().collect(), value)
}

/// The folder a new shell asked for, in its start arguments: on this computer only, where this
/// build's own binary starts it (a remote's older hn would refuse the argument).
pub fn start_in(init: &mut Vec<String>, cwd: Option<&str>, local: bool) {
    if let Some(cwd) = cwd.filter(|c| local && !c.is_empty()) { init.push(format!("--cwd={cwd}")); }
}

/// Where the shell starts: the folder it asked for; else where it was started, if that is still
/// a folder; else home. tmux (3.7c) starts a pane in its server's own folder, not the one asked for
/// (-c), when the server's folder was deleted: its getcwd fails and it skips the chdir. A shell
/// there is in a folder that is gone, and zsh-syntax-highlighting spins at its first redraw.
fn start_folder(asked: Option<&str>) -> std::path::PathBuf {
    use std::path::PathBuf;
    asked.map(PathBuf::from).filter(|p| p.is_dir())
        .or_else(|| std::env::current_dir().ok().filter(|d| d.is_dir()))
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_dir()))
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub fn bootstrap(token: &str, cli: Option<&str>, local: bool) -> Vec<String> {
    // The core receives only literal argv. Shell setup runs in the native helper after the PTY opens.
    let mut argv = if let Some(bin) = local.then(|| std::env::current_exe().ok()).flatten() {
        vec![bin.to_string_lossy().into_owned()]
    } else { vec![cli.unwrap_or("harness").into(), "tui".into()] };
    argv.extend(["--shell-init".into(), token.into()]);
    if let Some(cli) = cli { argv.push(cli.into()); }
    // Only this build's own binary is known to take it; a remote's older hn would refuse the argument.
    if local { argv.push(look_arg()); }
    argv
}

/// A connected shell uses the service's durable receipt, never an agent_create command string.
/// A folder that is gone on that computer (CWD_NOT_FOUND): the shell starts at its home instead.
pub async fn open_shell(link: &crate::daemon::Link, payload: serde_json::Value) -> Result<serde_json::Value, crate::daemon::RpcError> {
    let gone = |code: &str| code == "CWD_NOT_FOUND";
    let asked = payload["cwd"].as_str().is_some_and(|c| !c.is_empty());
    match open_shell_once(link, payload.clone()).await {
        // (A receipt says why it failed as `failure.code`; a refusal as `error`.)
        Ok(reply) if asked && [&reply["error"], &reply["failure"]["code"]].iter().any(|c| c.as_str().is_some_and(gone)) => {},
        Err(e) if asked && gone(&e.code) => {},
        other => return other,
    }
    let mut home = payload;
    home["cwd"] = json!("");
    home["creationId"] = json!(uuid::Uuid::new_v4().to_string());
    open_shell_once(link, home).await
}

async fn open_shell_once(link: &crate::daemon::Link, mut payload: serde_json::Value) -> Result<serde_json::Value, crate::daemon::RpcError> {
    if payload["cwd"].as_str().is_none_or(str::is_empty) {
        let folder = link.rpc("fs_list_dir", json!({"path":""}), Duration::from_secs(20)).await?;
        let path = folder["path"].as_str().ok_or_else(|| crate::daemon::RpcError::new("CWD_NOT_FOUND", "That computer's home folder is unavailable."))?;
        payload["cwd"] = json!(path);
    }
    let creation = payload["creationId"].clone();
    match link.rpc("shell_open", payload, Duration::from_secs(60)).await {
        Ok(reply) => Ok(reply),
        Err(error) => match link.rpc("shell_open_status", json!({"creationId":creation}), Duration::from_secs(15)).await {
            Ok(reply) if reply["state"] == "created" => Ok(reply),
            _ => Err(error),
        }
    }
}

/// The script a new shell runs first: its context, the picker, and (when given) the TUI's look.
fn init_script(token: &str, picker: &str, cli: &str, look: Option<&str>) -> String {
    let look = look.map(|l| format!("export HN_LOOK={}\n", quote(l))).unwrap_or_default();
    format!("export _HN_CONTEXT={}\nexport _HN_PICKER={}\nexport _HN_CLI={}\n{look}{}", quote(token), quote(picker), quote(cli),
        include_str!("shell_bootstrap.sh").replace("@INTEGRATION@", include_str!("shell_integration.sh")))
}

pub fn initialize(args: &[String]) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    let Some(token) = args.first().filter(|v| uuid::Uuid::parse_str(v).is_ok()) else {
        return Err(std::io::Error::other("Invalid shell context."))
    };
    let pick_agent = args.last().is_some_and(|arg| arg == "--pick-agent");
    let args = if pick_agent { &args[..args.len()-1] } else { args };
    let (args, look) = split_look(args);
    let (args, cwd) = split_option(&args, "--cwd=");
    if args.len()>2 { return Err(std::io::Error::other("Invalid shell initialization arguments.")) }
    let picker = std::env::current_exe()?;
    let script = init_script(token, &picker.to_string_lossy(), args.get(1).map(String::as_str).unwrap_or("harness"), look.as_deref());
    let folder = start_folder(cwd.as_deref());
    let mut command = std::process::Command::new("/bin/sh");
    command.args(["-c", &script]).current_dir(&folder).env("PWD", &folder);
    if pick_agent { command.env("_HN_START_PICKER", "1"); }
    Err(command.exec())
}

/// A split copies only the semantic route, never a conversation or parked shells.
pub fn prepare(app: &mut App, source: Option<&(String, String)>, inherit: bool) -> String {
    let route = if inherit { source.and_then(|(m,a)| app.shell_context.token_for(m,a))
        .and_then(|t| app.shell_context.contexts.get(&t)).and_then(|c| c.route.clone()) } else { None };
    let token = uuid::Uuid::new_v4().to_string();
    app.shell_context.contexts.insert(token.clone(), Context { route, ..Context::default() });
    token
}

pub fn bind(app: &mut App, token: &str, machine: &str, agent: &str) {
    if let Some(context) = app.shell_context.contexts.get_mut(token) {
        context.hosts.insert(machine.into(), agent.into());
        app.shell_context.dirty.insert(token.into());
        app.shell_context.save();
    }
}

/// Called after a shell picker replaced its source view with an agent. Do not
/// attach this lifecycle to ordinary workspace navigation or plain terminals.
pub fn visiting(app: &mut App, source: &(String, String), cwd: Option<String>, machine: &str, agent: &str) {
    visit(app, source, cwd, machine, agent, false, false);
}

/// A successful create/resume receipt proves this invocation was attempted,
/// even if it exited before the client observed its running state.
pub fn visiting_created(app: &mut App, source: &(String, String), cwd: Option<String>, machine: &str, agent: &str) {
    visit(app, source, cwd, machine, agent, true, false);
}

pub fn visiting_shell_launch(app: &mut App, source: &(String, String), cwd: Option<String>, machine: &str, agent: &str) {
    visit(app, source, cwd, machine, agent, true, true);
}

fn visit(app: &mut App, source: &(String, String), cwd: Option<String>, machine: &str, agent: &str, created: bool, terminal_process: bool) {
    let Some(token) = app.shell_context.token_for(&source.0, &source.1) else { return };
    if source.0 == machine && source.1 == agent { return }
    let Some(target) = app.fleet.agent(machine, agent).filter(|a| created || a.engine != "terminal") else { return };
    let started = created || target.status != "stopped";
    let Some(pane) = app.focused().filter(|p| app.panes.get(p).is_some_and(|p| p.machine_id == machine && p.agent_id == agent)) else { return };
    let original = app.fleet.agent(&source.0, &source.1);
    let source_runtime = original.map(|a| a.tmux_pane.clone()).unwrap_or_default();
    let source_created = original.map(|a| a.created_at_wire.clone()).unwrap_or_default();
    app.shell_context.contexts.get_mut(&token).unwrap().visit = Some(Visit {
        id: visit_id(),
        pane, machine:machine.into(), agent:agent.into(), source_machine:source.0.clone(), source_agent:source.1.clone(), source_cwd:cwd, started,
        source_runtime, source_created, terminal_process, returning_since:None,
        checked_at: None, checking: false, exited: false, resuming: false,
    });
    app.shell_context.dirty.insert(token);
    app.shell_context.save();
}

fn surviving_source(app: &App, visit: &Visit) -> Option<String> {
    let original = app.fleet.agent(&visit.source_machine, &visit.source_agent);
    if original.is_some_and(|a| a.status != "stopped") { return Some(visit.source_agent.clone()) }
    let runtime = if visit.source_runtime.is_empty() { original.map(|a| a.tmux_pane.as_str()).unwrap_or("") } else { &visit.source_runtime };
    let created = if visit.source_created.is_empty() { original.map(|a| a.created_at_wire.as_str()).unwrap_or("") } else { &visit.source_created };
    // Retiring a conversation preserves its physical shell and creation identity
    // under a new ID. A pane number alone can be reused after a daemon restart.
    if runtime.is_empty() || created.is_empty() { return None }
    let mut matching = app.fleet.agents.values().filter(|a| a.machine_id == visit.source_machine
        && a.status != "stopped" && a.tmux_pane == runtime && a.created_at_wire == created);
    let id = matching.next()?.id.clone();
    matching.next().is_none().then_some(id)
}

/// This pane temporarily shows a picked session in place of its parked shell.
/// A confirmed stop should return there, just as a normal agent exit does.
pub fn is_session_visit(app: &App, pane: u64) -> bool {
    app.panes.get(&pane).is_some_and(|p| app.shell_context.contexts.values().any(|context|
        context.visit.as_ref().is_some_and(|v| v.pane == pane && v.machine == p.machine_id && v.agent == p.agent_id)))
}

pub fn resuming(app: &mut App, pane: u64) -> Option<String> {
    let visit = app.shell_context.contexts.values_mut().filter_map(|c| c.visit.as_mut()).find(|v| v.pane == pane)?;
    visit.id = visit_id(); // Invalidate a probe started for the previous invocation.
    visit.resuming = true;
    visit.checking = false;
    visit.exited = false;
    Some(visit.id.clone())
}

pub fn resumed(app: &mut App, id: &str) {
    if let Some(visit) = app.shell_context.contexts.values_mut().filter_map(|c| c.visit.as_mut()).find(|v| v.id == id) {
        visit.resuming = false;
    }
}

fn return_from_sessions(app: &mut App) {
    let visits: Vec<_> = app.shell_context.contexts.iter().filter_map(|(t,c)| c.visit.clone().map(|v| (t.clone(),v))).collect();
    for (token, visit) in visits {
        let same = app.panes.get(&visit.pane).is_some_and(|p| p.machine_id == visit.machine && p.agent_id == visit.agent);
        // The user closed/replaced this view. Never reclaim a different pane.
        if !same {
            app.shell_context.contexts.get_mut(&token).unwrap().visit = None;
            app.shell_context.dirty.insert(token);
            continue;
        }
        // A previously stopped session must first finish resuming. Its cached
        // stopped row is not a new exit (and a failed resume keeps its error).
        if !visit.started {
            if app.fleet.agent(&visit.machine, &visit.agent).is_some_and(|a| a.engine == "terminal" || a.status != "stopped") {
                app.shell_context.contexts.get_mut(&token).unwrap().visit.as_mut().unwrap().started = true;
                app.shell_context.dirty.insert(token.clone());
            } else { continue; }
        }
        // A background exit must not steal focus or dismiss an open picker.
        // Its original shell is restored when the person returns to that pane.
        if app.focused() != Some(visit.pane) || app.modal.is_some() { continue }
        // A repeated picker selection asks the core to attach or resume. Do not
        // mistake the previous invocation's cached exit for that resume's result.
        if visit.resuming { continue }
        let exited = visit.exited || app.fleet.agent(&visit.machine, &visit.agent).is_some_and(|a| a.status == "stopped" || (!visit.terminal_process && a.engine == "terminal"));
        if !exited { check_visit(app, &token, &visit); }
        if !exited || app.link(&visit.source_machine).is_none() { continue }
        let live_source = surviving_source(app, &visit);
        if live_source.is_none() && visit.returning_since.is_none_or(|at| at.elapsed() < Duration::from_secs(2)) {
            // The archive/deletion can arrive before the surviving shell frame.
            // Give that handoff a bounded refresh before replacing a lost shell.
            if visit.returning_since.is_none() {
                app.shell_context.contexts.get_mut(&token).unwrap().visit.as_mut().unwrap().returning_since = Some(Instant::now());
                app.relist(&visit.source_machine);
            }
            continue;
        }
        app.shell_context.contexts.get_mut(&token).unwrap().visit = None;
        app.shell_context.dirty.insert(token.clone());
        let source = (visit.source_machine.clone(), visit.source_agent.clone());
        if let Some(agent) = live_source {
            app.shell_context.contexts.get_mut(&token).unwrap().hosts.insert(source.0.clone(), agent.clone());
            if app.shells.remove(&source) { app.shells.insert((source.0.clone(), agent.clone())); }
            app.open_agent(&source.0, &agent, Placement::Replace);
        } else {
            // A separately stopped/lost source cannot be revived. Make a new
            // integrated shell with its recorded cwd and semantic model route.
            crate::input::new_shell_from(app, Some(source), Placement::Replace, visit.source_cwd, None);
        }
        app.save_sessions();
    }
    if !app.shell_context.dirty.is_empty() { app.shell_context.save(); }
}

fn check_visit(app: &mut App, token: &str, visit: &Visit) {
    if visit.terminal_process || visit.checking || visit.checked_at.is_some_and(|at| at.elapsed() < Duration::from_millis(750)) { return }
    let Some(link) = app.link(&visit.machine) else { return };
    let generation = link.generation;
    let epoch = app.account_epoch;
    let (token, visit) = (token.to_string(), visit.clone());
    let current = app.shell_context.contexts.get_mut(&token).unwrap().visit.as_mut().unwrap();
    current.checking = true;
    current.checked_at = Some(Instant::now());
    let agent = visit.agent.clone();
    app.spawn(async move { link.rpc("shell_visit_status", json!({"agentId":agent}), Duration::from_secs(3)).await }, move |app, reply| {
        let current_connection = app.account_epoch == epoch && app.connection_generation(&visit.machine) == Some(generation);
        if let Some(current) = app.shell_context.contexts.get_mut(&token).and_then(|c| c.visit.as_mut()).filter(|v| v.id == visit.id) {
            current.checking = false;
            // A late reply cannot dismiss a replacement invocation or an account's new view.
            if current_connection && reply.is_ok_and(|r| r["exited"] == true) { current.exited = true; }
        }
    });
}

/// Keep an incomplete escape, never unbounded program output. No request is
/// reconstructed from screen snapshots: only new output can ask for an action.
fn scan(carry: &mut Vec<u8>, bytes: &[u8], pane: u64) -> Vec<Request> {
    carry.extend_from_slice(bytes);
    let mut out = Vec::new();
    loop {
        let Some(start) = carry.windows(PREFIX.len()).position(|s| s == PREFIX) else {
            let keep = (1..PREFIX.len()).rev().find(|n| carry.ends_with(&PREFIX[..*n])).unwrap_or(0);
            carry.drain(..carry.len() - keep); break;
        };
        if start > 0 { carry.drain(..start); }
        let Some(end) = carry.iter().skip(PREFIX.len()).position(|b| *b == 7).map(|i| i + PREFIX.len()) else {
            if carry.len() > LIMIT { carry.clear(); } break;
        };
        if end <= LIMIT {
            if let Ok(raw) = std::str::from_utf8(&carry[PREFIX.len()..end]) {
                let parts: Vec<&str> = raw.splitn(4, ';').collect();
                if parts.len() == 4 && uuid::Uuid::parse_str(parts[0]).is_ok()
                    && !parts[1].is_empty() && parts[1].len() <= 80 && parts[1].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    && matches!(parts[2], "host" | "model" | "route" | "sessions" | "list-host" | "list-model" | "list-sessions" | "list-compose" | "compose-launch" | "host-inline" | "model-inline" | "session-inline" | "picker-ready" | "close-picker" | "cancel") {
                    if let Some(query) = STANDARD.decode(parts[3]).ok().and_then(|b| String::from_utf8(b).ok()).filter(|q| !q.chars().any(char::is_control)) {
                        out.push(Request { token:parts[0].into(), id:parts[1].into(), verb:parts[2].into(), query, pane, at:Instant::now() });
                    }
                }
            }
        }
        carry.drain(..=end);
    }
    out
}

fn reply(app: &mut App, request: &Request, code: u8, text: &str) {
    reply_data(app, request, code, text, None);
}
/// A picker's catalog reply, carrying how the TUI looks now. An `unchanged` one carries it too:
/// a theme change leaves a catalog's revision alone.
fn catalog_reply(app: &mut App, request: &Request, mut data: serde_json::Value) {
    if data.is_object() { data["look"] = look_value(); }
    reply_data(app, request, 0, "", Some(data));
}
fn reply_data(app: &mut App, request: &Request, code: u8, text: &str, data: Option<serde_json::Value>) {
    let data = data.map(std::sync::Arc::new);
    app.shell_context.replies.push_back(Reply { request: request.clone(), code, text: text.into(), data: data.clone(), at: Instant::now() });
    // Catalog retries are idempotent without retaining hundreds of large snapshots.
    while app.shell_context.replies.iter().filter(|r| r.data.is_some()).count() > 2 {
        if let Some(at) = app.shell_context.replies.iter().position(|r| r.data.is_some()) { app.shell_context.replies.remove(at); }
    }
    while app.shell_context.replies.len() > 256 { app.shell_context.replies.pop_front(); }
    send_reply(app, request, code, text, data.as_deref());
}
fn send_reply(app: &App, request: &Request, code: u8, text: &str, data: Option<&serde_json::Value>) {
    let Some(machine) = app.panes.get(&request.pane).map(|p| p.machine_id.clone()) else { return };
    if let Some(link) = app.link(&machine) {
        let mut value = json!({"context":request.token,"id":request.id,"code":code,"text":text});
        if let Some(data) = data { value["data"] = data.clone(); }
        link.send("shell_context_reply", value);
    }
}

/// Local fallback implements the same FIFO contract as the daemon. Open only an
/// existing private FIFO; a stale request cannot create files or block the server.
pub fn local_reply(value: &serde_json::Value) -> bool {
    use std::os::unix::fs::{OpenOptionsExt, MetadataExt, FileTypeExt};
    use std::io::Write;
    let (Some(token), Some(id), Some(code), Some(text)) = (value["context"].as_str(), value["id"].as_str(), value["code"].as_u64(), value["text"].as_str()) else { return false };
    if uuid::Uuid::parse_str(token).is_err() || token.len() != 36 || id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') || code > 1 || text.len() > 2048 { return false }
    let uid = unsafe { libc::geteuid() };
    let base = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".harness/shell-requests");
    for path in [&base, &base.join(token)] {
        if !std::fs::symlink_metadata(path).ok().is_some_and(|m| m.is_dir() && m.uid() == uid && m.mode() & 0o077 == 0) { return false }
    }
    let Ok(mut file) = std::fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW).open(base.join(token).join(id)) else { return false };
    if !file.metadata().ok().is_some_and(|m| m.file_type().is_fifo() && m.uid() == uid && m.mode() & 0o077 == 0) { return false }
    if let Some(data) = value.get("data") {
        let Ok(bytes) = serde_json::to_vec(data) else { return false };
        if bytes.len() > 8 * 1024 * 1024 { return false }
        let target = base.join(token).join(format!("{id}.json"));
        match std::fs::symlink_metadata(&target) {
            Ok(m) if !m.is_file() || m.uid() != uid || m.mode() & 0o077 != 0 || m.nlink() != 1 => return false,
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return false,
            _ => {},
        }
        let tmp = target.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let ok = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)
            .and_then(|mut f| f.write_all(&bytes)).and_then(|_| std::fs::rename(&tmp, &target)).is_ok();
        let _ = std::fs::remove_file(&tmp);
        if !ok { return false }
    }
    file.write_all(format!("HN:{id}:{code}:{}\n", STANDARD.encode(text)).as_bytes()).is_ok()
}

pub fn output(app: &mut App, pane: u64, bytes: &[u8]) {
    let requests = scan(app.shell_context.parsers.entry(pane).or_default(), bytes, pane);
    for request in requests {
        if !app.shell_context.contexts.contains_key(&request.token) {
            if let Some(context) = State::load().contexts.remove(&request.token) { app.shell_context.contexts.insert(request.token.clone(), context); }
        }
        let valid = app.panes.get(&pane).is_some_and(|p| !p.read_only && app.shell_context.token_for(&p.machine_id, &p.agent_id).as_deref() == Some(&request.token));
        if !valid { continue }
        if request.verb == "cancel" {
            if app.shell_context.pending.as_ref().is_some_and(|p| p.token == request.token && p.id == request.id) { cancel(app); }
            continue;
        }
        if request.verb == "close-picker" {
            if app.shell_context.inline.as_ref().is_some_and(|p| p.token == request.token && p.pane == request.pane) {
                app.shell_context.inline = None;
            }
            app.shell_context.composition = None;
            continue;
        }
        if let Some(previous) = app.shell_context.replies.iter().find(|r| r.request.token == request.token && r.request.id == request.id && r.at.elapsed() < Duration::from_secs(180)) {
            send_reply(app, &request, previous.code, &previous.text, previous.data.as_deref());
            continue;
        }
        if app.shell_context.pending.as_ref().is_some_and(|r| r.token == request.token && r.id == request.id) { continue }
        if request.verb == "route" {
            let route = app.shell_context.contexts.get(&request.token).and_then(|c| c.route.as_ref()).map(|r| format!("{}\n{}", r.grid, r.model)).unwrap_or_default();
            reply(app, &request, 0, &route); continue;
        }
        if app.focused() != Some(pane) || app.modal.is_some() || app.shell_context.pending.is_some() {
            reply(app, &request, 1, "Return to this pane and close the current picker first."); continue;
        }
        if request.verb == "picker-ready" {
            // The fresh shell installed its line-editor widgets. Queue a
            // private widget key only after that handshake, never on a timer.
            reply(app, &request, 0, "");
            crate::input::send_to_pane(app, pane, b"\x1b[9001~".to_vec());
            continue;
        }
        if request.verb == "list-compose" { composition::list(app, request); continue }
        if request.verb == "compose-launch" { composition::launch(app, request); continue }
        if request.verb.starts_with("list-") { inline_list(app, request); continue }
        if request.verb == "sessions" {
            reply(app, &request, 0, "");
            sessions(app, Some(pane), &request.query);
            continue;
        }
        app.shell_context.pending = Some(request.clone());
        app.shell_context.notice.clear();
        if request.verb == "session-inline" {
            crate::input::open_shell_session(app, pane, &request.query);
        } else if request.verb == "model-inline" {
            if request.query == "default" { set_route(app, None) }
            // A completed command can be recalled from shell history after hn
            // restarts. Resolve its exact value without reopening the picker.
            else if app.shell_context.routes.is_empty() { load_routes(app, request) }
            else { choose_inline_route(app, &request.query) }
        } else if request.verb == "model" {
            if request.query == "default" { set_route(app, None); continue }
            load_routes(app, request);
        } else {
            app.refresh_machines();
            if request.query == "-" {
                match app.shell_context.contexts.get(&request.token).and_then(|c| c.previous.clone()) {
                    Some(machine) => switch_host(app, &machine),
                    None => finish(app, 1, "There is no previous computer in this pane."),
                }
            } else if request.query == "local" {
                let machine = crate::input::shell_machine(app, None); switch_host(app, &machine);
            } else {
                let matches: Vec<_> = app.fleet.machines.iter().filter(|m| !m.shared && !request.query.is_empty() &&
                    (m.id == request.query || m.name.eq_ignore_ascii_case(&request.query))).map(|m| m.id.clone()).collect();
                if matches.len() == 1 { switch_host(app, &matches[0]) } else if request.verb == "host-inline" { finish(app, 1, "Computer not found. Run ch to choose one.") } else { show(app, &request.query) }
            }
        }
    }
}

pub fn sessions(app: &mut App, pane: Option<u64>, query: &str) {
    app.modal = None;
    crate::input::launch(app, "", Filter::All);
    let local = app.fleet.local_id.clone();
    if let Some(Modal::Picker { kind, picker }) = &mut app.modal {
        *kind = PickerKind::Open { filter: Filter::All, machine: Some(local.clone()), project: None };
        picker.title = "Sessions on this computer".into();
        picker.placeholder = "Search sessions".into();
        picker.prefixed = false;
        picker.query = query.into(); picker.qcursor = query.chars().count();
    }
    app.shell_context.session_picker = pane;
    app.shell_context.sessions_machine = Some(local.clone());
    app.shell_context.catalog.clear();
    app.shell_context.catalog_generation = app.shell_context.catalog_generation.wrapping_add(1);
    app.shell_context.catalog_retry = None;
    app.shell_context.catalog_started = Some(Instant::now());
    app.shell_context.catalog_notice = "Reading saved sessions…".into();
    catalog(app, local, String::new(), app.shell_context.catalog_generation);
    crate::input::refill(app);
}

fn catalog(app: &mut App, machine: String, after: String, generation: u64) {
    let Some(link) = app.link(&machine) else {
        app.shell_context.catalog_notice = "Saved sessions need the local CLI running (harness start).".into();
        return;
    };
    let next_machine = machine.clone();
    app.spawn(async move { link.rpc("session_search", json!({"query":"", "catalogAfter":after, "limit":100, "from":0, "to":crate::fleet::now_ms()}), Duration::from_secs(15)).await }, move |app, result| {
        if app.shell_context.catalog_generation != generation || app.shell_context.sessions_machine.as_deref() != Some(&next_machine) { return }
        match result {
            Ok(mut reply) => {
                // Catalog pages include earlier conversations of an owned agent,
                // not just the one its current pane happens to be running.
                if let Some(hits) = reply["hits"].as_array_mut() {
                    for hit in hits {
                        if hit["external"].is_null() && hit["catalogEntry"].is_object() {
                            hit["external"] = hit["catalogEntry"].clone();
                        }
                    }
                }
                let hits = crate::app::said_hits(&next_machine, &reply);
                let next = hits.last().map(|h| h.session_id.clone());
                let more = hits.len() == 100 && reply["catalog"].as_bool() == Some(true);
                for hit in hits {
                    if let Some(old) = app.shell_context.catalog.iter_mut().find(|h| h.machine == hit.machine && h.session_id == hit.session_id) { *old = hit }
                    else { app.shell_context.catalog.push(hit); }
                }
                let indexing = reply["ready"].as_bool() == Some(false) && reply["catalog"].as_bool() == Some(true);
                let retry = !more && indexing && app.shell_context.catalog_started.is_some_and(|t| t.elapsed() < Duration::from_secs(30));
                if retry { app.shell_context.catalog_retry = Some(Instant::now() + Duration::from_secs(2)); }
                app.shell_context.catalog_notice = if more { "Reading saved sessions…".into() }
                    else if retry { "Finding saved sessions…".into() }
                    else if reply["ready"].as_bool() == Some(false) { "History is still indexing. Reopen sessions to refresh.".into() }
                    else if reply["catalog"].as_bool() != Some(true) { "Update the local CLI for all saved sessions; recent history is shown.".into() }
                    else { String::new() };
                if more { if let Some(next) = next { catalog(app, next_machine, next, generation); } }
            }
            Err(_) => app.shell_context.catalog_notice = "Saved sessions unavailable. Reopen sessions to retry.".into(),
        }
        crate::input::refill(app);
    });
}

fn show(app: &mut App, query: &str) {
    let Some(request) = &app.shell_context.pending else { return };
    if request.verb.ends_with("-inline") { return }
    let title = if request.verb == "host" { "Computer" } else { "Model" };
    let mut picker = Picker::new(title, "Search");
    picker.query = query.into(); picker.qcursor = query.chars().count();
    fill(app, &mut picker);
    app.modal = Some(Modal::Picker { kind:PickerKind::ShellContext, picker });
}

fn context_rows(app: &App, host: bool) -> Vec<Row> {
    if host {
        app.fleet.machines.iter().filter(|m| !m.shared).map(|m| {
            let mut row = Row::new(m.id.clone(), m.name.clone()).extra(m.id.clone())
                .right(if m.usable() { if m.local { "this computer" } else { "connected" } } else { "unavailable" });
            row.disabled = !m.usable(); row
        }).collect()
    } else {
        let mut rows = vec![Row::new("default", "Use agent default")];
        rows.extend(app.shell_context.routes.iter().enumerate().map(|(i, r)| Row::new(i.to_string(), r.model.clone()).right(r.label.clone()).extra(r.grid.clone())));
        rows
    }
}
pub fn fill(app: &App, picker: &mut Picker) {
    let Some(request) = &app.shell_context.pending else { return };
    picker.set_rows(context_rows(app, request.verb == "host"));
    picker.hints = vec![("enter", "choose"), ("esc", "cancel")];
    if !app.shell_context.notice.is_empty() { picker.say(&app.shell_context.notice) }
}
fn routes(value: &serde_json::Value) -> Vec<Route> {
    crate::models::parse_grids(value).sections.into_iter().flat_map(|s| s.models.into_iter().filter(|m| m.offline.is_none()).map(move |m| Route {
        grid:s.name.clone(), model:m.id, label:s.name.clone(),
    })).collect()
}
fn route_id(route: &Route) -> String { format!("model:{}", STANDARD.encode(serde_json::to_vec(route).unwrap_or_default())) }
fn choose_inline_route(app: &mut App, query: &str) {
    let matches:Vec<_> = app.shell_context.routes.iter().filter(|r|
        route_id(r) == query || format!("{} :: {}",r.grid,r.model)==query
    ).cloned().collect();
    if matches.len()==1 { set_route(app, matches.into_iter().next()) }
    else { finish(app, 1, "That model is unavailable or ambiguous. Run cm to choose it again.") }
}

/// Same rows, metadata/FTS filtering and previews as C-b s. Only the renderer lives
/// inside the requesting shell's PTY; no second session database or resume path.
fn inline_list(app: &mut App, request: Request) {
    let kind = request.verb.trim_start_matches("list-").to_string();
    let Ok(args) = serde_json::from_str::<serde_json::Value>(&request.query) else { return reply(app, &request, 1, "Invalid picker request.") };
    let query = args["query"].as_str().unwrap_or("");
    if query.len() > 512 || query.chars().any(char::is_control) { return reply(app, &request, 1, "Search is too long.") }
    let same = app.shell_context.inline.as_ref().is_some_and(|i| i.token == request.token && i.pane == request.pane && i.kind == kind);
    if !same {
        app.shell_context.inline = Some(Inline { token:request.token.clone(), pane:request.pane, kind:kind.clone(), id:request.id.clone(), hold:None, at:Instant::now() });
        app.shell_context.notice.clear();
        if kind == "host" { app.refresh_machines(); }
        if kind == "model" {
            app.shell_context.routes.clear();
            app.shell_context.notice = "Reading available models…".into();
            let machine = app.panes.get(&request.pane).map(|p| p.machine_id.clone()).unwrap_or_default();
            if let Some(link) = app.link(&machine) {
                let epoch = app.account_epoch;
                let token = request.token.clone();
                let opened = request.id.clone();
                app.spawn(async move { link.rpc("grid_models_list", json!({"rowState":true}), Duration::from_secs(30)).await }, move |app, result| {
                    if app.account_epoch != epoch || !app.shell_context.inline.as_ref().is_some_and(|i| i.kind == "model" && i.token == token && i.id == opened) { return }
                    match result {
                        Ok(value) => {
                            app.shell_context.routes = routes(&value);
                            app.shell_context.notice = if app.shell_context.routes.is_empty() { "No model routes available. Agent defaults still work.".into() } else { String::new() };
                        }
                        Err(e) => app.shell_context.notice = format!("Models unavailable: {e}"),
                    }
                });
            } else { app.shell_context.notice = "This computer is not connected.".into(); }
        }
        if kind == "sessions" {
            app.shell_context.sessions_machine = Some(app.fleet.local_id.clone());
            app.shell_context.catalog.clear();
            app.shell_context.catalog_generation = app.shell_context.catalog_generation.wrapping_add(1);
            app.shell_context.catalog_started = Some(Instant::now());
            app.shell_context.catalog_retry = None;
            app.shell_context.catalog_notice = "Reading saved sessions…".into();
            app.said.clear(); app.said_for.clear(); app.said_want.clear();
            app.said_generation = app.said_generation.wrapping_add(1);
            catalog(app, app.fleet.local_id.clone(), String::new(), app.shell_context.catalog_generation);
        }
    }
    if let Some(i) = &mut app.shell_context.inline { i.at = Instant::now(); }
    let mut picker = Picker::new("", "");
    picker.query = query.into(); picker.qcursor = query.chars().count();
    picker.text_w = args["width"].as_u64().unwrap_or(80).min(4096) as usize;
    let mut preview = Vec::new();
    let mut preview_bottom = false;
    if kind == "sessions" {
        let open = PickerKind::Open { filter:Filter::All, machine:Some(app.fleet.local_id.clone()), project:None };
        picker.hold = app.shell_context.inline.as_ref().and_then(|i| i.hold.clone());
        crate::input::schedule_said(app, &open, &picker);
        crate::input::fill(app, &open, &mut picker);
        if let Some(i) = &mut app.shell_context.inline { i.hold = picker.hold.clone(); }
        if let Some(id) = args["preview"].as_str().filter(|id| picker.rows.iter().any(|r| r.id == *id)) {
            app.ask_tail_for(id);
            preview_bottom = crate::preview::bottom_up(app, &open, id);
            preview = crate::preview::shell_lines(app, &open, id).into_iter().map(|line| line.spans.into_iter().map(|s| s.content.into_owned()).collect()).collect();
        }
    } else {
        let mut rows = context_rows(app, kind == "host");
        if kind == "model" {
            for (row, route) in rows.iter_mut().skip(1).zip(&app.shell_context.routes) { row.id = route_id(route); }
        }
        picker.set_rows(rows);
        picker.status = app.shell_context.notice.clone();
    }
    let mut items = crate::shell_picker::Items::from_picker(&picker);
    items.preview = preview;
    items.preview_bottom = preview_bottom;
    items.preview_id = args["preview"].as_str().map(str::to_string);
    let mut data = serde_json::to_value(items).unwrap_or_default();
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    data.to_string().hash(&mut hash);
    let revision = hash.finish().to_string();
    if args["revision"].as_str() == Some(revision.as_str()) { data = json!({"unchanged":true}); }
    data["revision"] = json!(revision);
    catalog_reply(app, &request, data);
}

fn load_routes(app: &mut App, request: Request) {
    let inline = request.verb == "model-inline";
    let machine = app.panes.get(&request.pane).map(|p| p.machine_id.clone()).unwrap_or_default();
    app.shell_context.routes.clear();
    app.shell_context.notice = "Reading available models…".into();
    if !inline { show(app, &request.query); }
    let Some(link) = app.link(&machine) else {
        if inline { finish(app, 1, "This computer is not connected."); }
        else { app.shell_context.notice = "This computer is not connected.".into(); crate::input::refill(app); }
        return
    };
    app.spawn(async move { link.rpc("grid_models_list", json!({"rowState":true}), Duration::from_secs(30)).await }, move |app, result| {
        if app.shell_context.pending.as_ref().is_none_or(|p| p.id != request.id || p.token != request.token) { return }
        match result {
            Ok(value) => {
                app.shell_context.routes = routes(&value);
                if inline { choose_inline_route(app, &request.query); return }
                app.shell_context.notice = if app.shell_context.routes.is_empty() { "No model routes are available. Agent defaults still work.".into() } else { String::new() };
                if !request.query.is_empty() {
                    let query = request.query.to_lowercase();
                    let matches: Vec<_> = app.shell_context.routes.iter().filter(|r| r.model.to_lowercase().contains(&query) || r.label.to_lowercase().contains(&query)).cloned().collect();
                    if matches.len() == 1 { set_route(app, matches.first().cloned()); return }
                }
            }
            Err(error) => {
                if inline { finish(app, 1, &format!("Models unavailable: {error}")); return }
                app.shell_context.notice = format!("Models unavailable: {error}");
            },
        }
        crate::input::refill(app);
    });
}

pub fn choose(app: &mut App, id: Option<&str>) {
    let Some(request) = app.shell_context.pending.as_ref() else { return };
    let Some(id) = id else { return cancel(app) };
    if request.verb == "host" { switch_host(app, id) }
    else if id == "default" { set_route(app, None) }
    else if let Some(route) = id.parse::<usize>().ok().and_then(|i| app.shell_context.routes.get(i)).cloned() { set_route(app, Some(route)) }
}

fn set_route(app: &mut App, route: Option<Route>) {
    let Some(request) = &app.shell_context.pending else { return };
    if let Some(context) = app.shell_context.contexts.get_mut(&request.token) { context.route = route.clone(); }
    app.shell_context.dirty.insert(request.token.clone());
    app.shell_context.save();
    let message = route.map(|r| format!("{} · {}\n", r.model, r.label)).unwrap_or_else(|| "Using the agent's own defaults.\n".into());
    finish(app, 0, &message);
}

pub fn cancel(app: &mut App) { finish(app, 1, ""); }
pub fn finish(app: &mut App, code: u8, message: &str) {
    app.shell_context.connecting = false;
    if let Some(request) = app.shell_context.pending.take() { reply(app, &request, code, message); }
    if matches!(app.modal, Some(Modal::Picker { kind:PickerKind::ShellContext, .. })) { app.modal = None; }
}

fn switch_host(app: &mut App, machine: &str) {
    if app.shell_context.connecting { return }
    let Some(request) = app.shell_context.pending.clone() else { return };
    let Some(source) = app.panes.get(&request.pane).map(|p| (p.machine_id.clone(), p.agent_id.clone())) else { return cancel(app) };
    if source.0 == machine { return finish(app, 0, "") }
    let Some(link) = app.link(machine) else { return finish(app, 1, "That computer is unavailable. Your current shell is unchanged.") };
    let old = app.shell_context.contexts.get(&request.token).and_then(|c| c.hosts.get(machine)).cloned();
    if let Some(agent) = old.filter(|a| app.fleet.agent(machine, a).is_some_and(|a| a.status != "stopped")) {
        return replace(app, &request, &source, machine, &agent);
    }
    let machine = machine.to_string();
    let local = app.fleet.machine(&machine).is_some_and(|m| m.local);
    let cli = if local { std::env::var("HARNESS_SHELL_CLI").ok() } else { None };
    let mut init = bootstrap(&request.token, cli.as_deref(), local);
    start_in(&mut init, app.homes.get(&machine).map(String::as_str), local);
    let mut payload = json!({"engine":"terminal", "creationId":uuid::Uuid::new_v4().to_string(), "bypassPermission":false, "argv":init});
    if let Some(home) = app.homes.get(&machine) { payload["cwd"] = json!(home); }
    crate::input::configure_local_shell(app, &machine, &mut payload);
    app.shell_context.connecting = true;
    app.shell_context.notice = "Connecting…".into();
    show(app, "");
    let epoch = app.account_epoch;
    let standalone = crate::local::is_local(&machine);
    app.spawn(async move {
        if standalone { link.rpc("agent_create", payload, Duration::from_secs(60)).await }
        else { open_shell(&link, payload).await }
    }, move |app, result| {
        if app.account_epoch != epoch { return }
        let current = app.shell_context.pending.as_ref().is_some_and(|r| r.id == request.id && r.token == request.token);
        if !current {
            if let Some(agent) = result.as_ref().ok().and_then(|v| v.pointer("/agent/id")).and_then(|a| a.as_str()) {
                if let Some(link) = app.link(&machine) { link.send("agent_delete", json!({"agentId":agent})); }
            }
            return;
        }
        app.shell_context.connecting = false;
        match result {
            Ok(result) => if let Some(agent) = result.pointer("/agent/id").and_then(|a| a.as_str()) {
                app.fleet.agents.insert((machine.clone(), agent.into()), crate::fleet::agent_from(&machine, &result["agent"], None));
                app.shells.insert((machine.clone(), agent.into()));
                bind(app, &request.token, &machine, agent);
                if app.shell_context.pending.as_ref().is_some_and(|r| r.id == request.id && r.token == request.token) {
                    replace(app, &request, &source, &machine, agent);
                }
            } else { finish(app, 1, "That computer did not create a shell.") },
            Err(error) => finish(app, 1, &format!("Could not connect: {error}")),
        }
    });
}

fn replace(app: &mut App, request: &Request, source: &(String, String), machine: &str, agent: &str) {
    if app.focused() != Some(request.pane) { return finish(app, 1, "The active pane changed. Your original shell is unchanged.") }
    if let Some(context) = app.shell_context.contexts.get_mut(&request.token) { context.previous = Some(source.0.clone()); }
    finish(app, 0, "");
    // Replace the view, retaining the process and its jobs for ch -.
    let shell = app.shells.remove(source);
    app.open_agent(machine, agent, Placement::Replace);
    if shell { app.shells.insert(source.clone()); }
    app.shell_context.dirty.insert(request.token.clone());
    app.shell_context.save();
}

pub fn account_changed(app: &mut App, old: &str, new: &str, migrate: bool) {
    cancel(app);
    app.shell_context.replies.clear();
    app.shell_context.inline = None;
    app.shell_context.composition = None;
    app.shell_context.session_picker = None;
    app.shell_context.sessions_machine = None;
    app.shell_context.catalog.clear();
    app.shell_context.catalog_generation = app.shell_context.catalog_generation.wrapping_add(1);
    for (token, context) in &mut app.shell_context.contexts {
        let local = if migrate { context.hosts.remove(old) } else { None };
        context.hosts.retain(|machine, _| crate::local::is_local(machine));
        if let Some(agent) = local { context.hosts.insert(new.into(), agent); }
        context.route = None;
        context.previous = None;
        context.visit = None;
        app.shell_context.dirty.insert(token.clone());
    }
    app.shell_context.save();
}

pub fn tick(app: &mut App) {
    return_from_sessions(app);
    app.shell_context.replies.retain(|r| r.at.elapsed() < Duration::from_secs(180));
    if app.shell_context.catalog_retry.is_some_and(|t| Instant::now() >= t) {
        app.shell_context.catalog_retry = None;
        if matches!(app.modal, Some(Modal::Picker { kind:PickerKind::Open { .. }, .. })) || app.shell_context.inline.as_ref().is_some_and(|i| i.kind == "sessions") {
            if let Some(machine) = app.shell_context.sessions_machine.clone() {
                catalog(app, machine, String::new(), app.shell_context.catalog_generation);
            }
        }
    }
    app.shell_context.parsers.retain(|p, _| app.panes.contains_key(p));
    if app.shell_context.inline.as_ref().is_some_and(|i| i.at.elapsed() > Duration::from_secs(5) || !app.panes.contains_key(&i.pane)) { app.shell_context.inline = None; }
    // Composed launches wait for folder/capability checks and the remote creation
    // receipt at the shell prompt. They never open the legacy context modal.
    if app.shell_context.pending.as_ref().is_some_and(|r| r.verb != "compose-launch" && !r.verb.ends_with("-inline")) && !matches!(app.modal, Some(Modal::Picker { kind:PickerKind::ShellContext, .. })) {
        cancel(app);
    }
    // A line-editor request is kept 5 s past the shell's own wait for that action
    // (shell_integration.sh `_hn_attempts`), so the shell always gives up first.
    let limit = |verb: &str| match verb { "compose-launch" => 180, "host-inline" => 105, "session-inline" => 185, "model-inline" => 65, _ => 100 };
    if app.shell_context.pending.as_ref().is_some_and(|r| r.at.elapsed() > Duration::from_secs(limit(&r.verb))) {
        finish(app, 1, "The request timed out. Your shell is unchanged.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_requests_and_untrusted_output() {
        let token = uuid::Uuid::new_v4().to_string();
        let message = format!("\x1b]633;hn;{token};1-2-3;host;{}\x07", STANDARD.encode("Office"));
        for split in 0..message.len() {
            let mut carry = Vec::new();
            let mut got = scan(&mut carry, &message.as_bytes()[..split], 3);
            got.extend(scan(&mut carry, &message.as_bytes()[split..], 3));
            assert_eq!(got.len(), 1); assert_eq!(got[0].query, "Office"); assert_eq!(got[0].pane, 3);
        }
        let mut carry = Vec::new();
        assert!(scan(&mut carry, &vec![b'x'; 20000], 1).is_empty()); assert!(carry.is_empty());
        assert!(scan(&mut carry, format!("\x1b]633;hn;{token};bad\n;host;eA==\x07").as_bytes(), 1).is_empty());
        assert!(scan(&mut carry, format!("\x1b]633;hn;{token};1;exec;eA==\x07").as_bytes(), 1).is_empty());
    }
    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19448, sink, (100, 35));
        // The fixture installs pane 1 directly. Reserve that first allocator id
        // so a replacement cannot reuse it when this test runs in isolation.
        let _ = crate::ids::next(crate::ids::Kind::Pane);
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(crate::fleet::Machine { shared:false, id:"local".into(), name:"Test".into(), local:true, status:"online".into(), reach:crate::fleet::Reach::Ready });
        app.panes.insert(1, crate::pane::Pane::new(1, "local", "shell", 100, 32));
        app.tab_mut().root = Some(crate::layout::Node::new(1, 100, 32));
        app.tab_mut().focus = Some(1);
        app.tab_mut().home = false;
        app
    }
    fn request(token: &str, verb: &str, query: &str) -> Vec<u8> {
        format!("\x1b]633;hn;{token};{};{verb};{}\x07", uuid::Uuid::new_v4(), STANDARD.encode(query)).into_bytes()
    }
    fn visit_fixture(stopped: bool) -> (App, String, u64) {
        let mut app = app();
        app.connect("local");
        app.fleet.machines[0].reach = crate::fleet::Reach::Ready;
        for (id,engine,status) in [("shell","terminal","active"),("chosen","claude",if stopped {"stopped"} else {"active"}),("other","terminal","active")] {
            app.fleet.agents.insert(("local".into(),id.into()), crate::fleet::agent_from("local", &json!({"id":id,"engine":engine,"status":status,"cwd":"/saved project"}), None));
        }
        let token = prepare(&mut app,None,false);
        bind(&mut app,&token,"local","shell");
        app.shell_context.contexts.get_mut(&token).unwrap().route = Some(Route {grid:"route".into(),model:"model".into(),label:"Saved".into()});
        app.panes.get_mut(&1).unwrap().agent_id = "chosen".into();
        app.panes.get_mut(&1).unwrap().phase = crate::pane::Phase::Live;
        visiting(&mut app,&("local".into(),"shell".into()),Some("/saved project".into()),"local","chosen");
        (app,token,1)
    }
    #[tokio::test]
    async fn verified_exit_returns_without_waiting_for_discovery_but_not_during_resume() {
        let (mut app,token,pane) = visit_fixture(false);
        app.shell_context.contexts.get_mut(&token).unwrap().visit.as_mut().unwrap().exited = true;
        let old_id = app.shell_context.contexts[&token].visit.as_ref().unwrap().id.clone();
        let id = resuming(&mut app, pane).unwrap();
        assert_ne!(old_id, id);
        assert!(!app.shell_context.contexts[&token].visit.as_ref().unwrap().exited);
        resumed(&mut app, &old_id);
        app.shell_context.contexts.get_mut(&token).unwrap().visit.as_mut().unwrap().exited = true;
        return_from_sessions(&mut app);
        assert_eq!(app.panes[&pane].agent_id, "chosen");
        resumed(&mut app, &id);
        return_from_sessions(&mut app);
        assert_eq!(app.panes[&app.focused().unwrap()].agent_id, "shell");
        assert_eq!(app.fleet.agent("local", "chosen").unwrap().status, "active");
    }
    #[tokio::test]
    async fn session_exit_returns_to_original_context_and_survives_persistence() {
        let (mut app,token,_) = visit_fixture(false);
        // Reattaching reloads the relationship, not just the selected model.
        let saved = serde_json::to_vec(&app.shell_context.contexts).unwrap();
        app.shell_context.contexts = serde_json::from_slice(&saved).unwrap();
        app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap().status = "stopped".into();
        return_from_sessions(&mut app);
        let p = &app.panes[&app.focused().unwrap()];
        assert_eq!(p.agent_id,"shell");
        assert_eq!(app.shell_context.token_for("local","shell"),Some(token.clone()));
        assert_eq!(app.shell_context.contexts[&token].route.as_ref().unwrap().model,"model");
        assert!(app.shell_context.contexts[&token].visit.is_none());
    }
    #[tokio::test]
    async fn stop_from_a_picked_session_returns_to_its_shell_but_close_tab_closes_the_view() {
        for whole_tab in [false, true] {
            let (mut app, token, pane) = visit_fixture(false);
            let chosen = app.fleet.agents.get_mut(&("local".into(), "chosen".into())).unwrap();
            chosen.close_supported = true;
            chosen.created_at_wire = "2026-10-05T00:00:00.123Z".into();
            app.session_close.replies.extend([
                Ok(json!({"activity":"idle"})), Ok(json!({"closed":true,"activity":"idle"}))
            ]);
            if whole_tab { let tab = app.active; crate::session_close::tab(&mut app, tab); }
            else { crate::session_close::pane(&mut app, pane); }
            assert_eq!(app.session_close.sent.len(), 2);
            if whole_tab { assert!(!app.panes.contains_key(&pane)); }
            else {
                assert!(app.panes.contains_key(&pane), "stop closed the shell's last view");
                return_from_sessions(&mut app);
                assert_eq!(app.panes[&app.focused().unwrap()].agent_id, "shell");
                assert!(app.shell_context.contexts[&token].visit.is_none());
            }
        }
    }
    #[tokio::test]
    async fn retired_source_returns_to_its_surviving_shell_even_after_archive_is_removed() {
        let (mut app,token,_) = visit_fixture(false);
        let original = app.fleet.agents.get_mut(&("local".into(),"shell".into())).unwrap();
        original.tmux_pane = "%7".into(); original.created_at_wire = "2026-10-05T01:00:00.123Z".into();
        visiting(&mut app,&("local".into(),"shell".into()),Some("/original".into()),"local","chosen");
        app.shells.insert(("local".into(),"shell".into()));
        let mut surviving = app.fleet.agents.remove(&("local".into(),"shell".into())).unwrap();
        surviving.id = "surviving".into();
        app.fleet.agents.insert(("local".into(),"surviving".into()),surviving);
        app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap().status = "stopped".into();
        let saved = serde_json::to_vec(&app.shell_context.contexts).unwrap();
        app.shell_context.contexts = serde_json::from_slice(&saved).unwrap();
        return_from_sessions(&mut app);
        assert_eq!(app.panes[&app.focused().unwrap()].agent_id,"surviving");
        assert_eq!(app.shell_context.token_for("local","surviving"),Some(token.clone()));
        assert!(app.shells.contains(&("local".into(),"surviving".into())));
        assert!(!app.shells.contains(&("local".into(),"shell".into())));
        assert_eq!(app.shell_context.contexts[&token].route.as_ref().unwrap().model,"model");
    }
    #[tokio::test]
    async fn retired_source_waits_for_its_frame_without_adopting_a_reused_or_foreign_pane() {
        let (mut app,token,_) = visit_fixture(false);
        let original = app.fleet.agents.get_mut(&("local".into(),"shell".into())).unwrap();
        original.tmux_pane = "%7".into(); original.created_at_wire = "2026-10-05T01:00:00.123Z".into();
        original.status = "stopped".into();
        let mut surviving = original.clone(); surviving.id = "surviving".into(); surviving.status = "active".into();
        let mut reused = surviving.clone(); reused.id = "reused".into(); reused.created_at_wire = "2026-10-05T02:00:00.123Z".into();
        let mut foreign = surviving.clone(); foreign.id = "foreign".into(); foreign.machine_id = "other-machine".into();
        app.fleet.agents.insert(("local".into(),"reused".into()),reused);
        app.fleet.agents.insert(("other-machine".into(),"foreign".into()),foreign);
        app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap().status = "stopped".into();
        return_from_sessions(&mut app);
        assert_eq!(app.panes[&app.focused().unwrap()].agent_id,"chosen");
        assert!(app.shell_context.contexts[&token].visit.as_ref().unwrap().returning_since.is_some());
        app.fleet.agents.insert(("local".into(),"surviving".into()),surviving);
        return_from_sessions(&mut app);
        assert_eq!(app.panes[&app.focused().unwrap()].agent_id,"surviving");
    }
    #[tokio::test]
    async fn created_session_can_exit_before_its_first_running_snapshot() {
        for (engine,status) in [("terminal","active"),("claude","stopped")] {
            let (mut app,token,_) = visit_fixture(false);
            app.shell_context.contexts.get_mut(&token).unwrap().visit = None;
            let agent=app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap();
            agent.engine=engine.into();agent.status=status.into();
            visiting_created(&mut app,&("local".into(),"shell".into()),Some("/original".into()),"local","chosen");
            assert!(app.shell_context.contexts[&token].visit.as_ref().unwrap().started);
            return_from_sessions(&mut app);
            assert_eq!(app.panes[&app.focused().unwrap()].agent_id,"shell");
            assert!(app.shell_context.contexts[&token].visit.is_none());
        }
    }
    #[tokio::test]
    async fn composed_terminal_waits_for_process_exit_even_before_engine_discovery() {
        for discovered in [false, true] {
            let (mut app,token,_) = visit_fixture(false);
            app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap().engine="terminal".into();
            visiting_shell_launch(&mut app,&("local".into(),"shell".into()),Some("/original".into()),"local","chosen");
            let saved=serde_json::to_vec(&app.shell_context.contexts).unwrap();
            app.shell_context.contexts=serde_json::from_slice(&saved).unwrap();
            return_from_sessions(&mut app);
            assert_eq!(app.panes[&app.focused().unwrap()].agent_id,"chosen", "the launch receipt precedes engine discovery");
            if discovered {
                app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap().engine="claude".into();
                return_from_sessions(&mut app);
                assert_eq!(app.panes[&app.focused().unwrap()].agent_id,"chosen");
            }
            app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap().status="stopped".into();
            return_from_sessions(&mut app);
            assert_eq!(app.panes[&app.focused().unwrap()].agent_id,"shell");
            assert!(app.shell_context.contexts[&token].visit.is_none());
        }
    }
    #[tokio::test]
    async fn awaiting_resume_can_return_when_it_becomes_a_terminal_without_a_running_snapshot() {
        let (mut app,token,_) = visit_fixture(true);
        let agent=app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap();
        agent.engine="terminal".into();agent.status="active".into();
        return_from_sessions(&mut app);
        assert_eq!(app.panes[&app.focused().unwrap()].agent_id,"shell");
        assert!(app.shell_context.contexts[&token].visit.is_none());
    }
    #[tokio::test]
    async fn choosing_an_existing_terminal_does_not_arm_agent_exit_tracking() {
        let (mut app,token,_) = visit_fixture(false);
        app.shell_context.contexts.get_mut(&token).unwrap().visit = None;
        app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap().engine="terminal".into();
        visiting(&mut app,&("local".into(),"shell".into()),None,"local","chosen");
        assert!(app.shell_context.contexts[&token].visit.is_none());
    }
    #[tokio::test]
    async fn stopped_session_is_allowed_to_resume_before_an_exit_can_return() {
        let (mut app,token,pane) = visit_fixture(true);
        return_from_sessions(&mut app);
        assert_eq!(app.focused(),Some(pane)); assert_eq!(app.panes[&pane].agent_id,"chosen");
        app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap().status = "active".into();
        return_from_sessions(&mut app);
        assert!(app.shell_context.contexts[&token].visit.as_ref().unwrap().started);
        app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap().status = "stopped".into();
        return_from_sessions(&mut app);
        assert_eq!(app.panes[&app.focused().unwrap()].agent_id,"shell");
    }
    #[tokio::test]
    async fn selecting_full_text_hit_before_its_catalog_page_starts_the_resume() {
        let (mut app,token,pane) = visit_fixture(false);
        app.panes.get_mut(&pane).unwrap().agent_id = "shell".into();
        app.shell_context.contexts.get_mut(&token).unwrap().visit = None;
        app.shell_context.sessions_machine = Some("local".into());
        app.said_for = "saved words".into();
        app.said = crate::app::said_hits("local", &json!({"hits":[{"sessionId":"saved-session", "engine":"claude", "external":{"title":"saved words", "cwd":"/saved project"}}]}));
        let raw = request(&token,"session-inline","external:local:saved-session");
        output(&mut app,pane,&raw);
        assert!(app.shell_context.pending.is_some(),"selection was rejected before sending the resume request");
        assert!(app.shell_context.replies.is_empty());
    }
    #[tokio::test]
    async fn background_exit_does_not_steal_focus_and_a_replaced_view_is_not_reclaimed() {
        let (mut app,token,pane) = visit_fixture(false);
        app.panes.insert(99,crate::pane::Pane::new(99,"local","other",100,32));
        app.tab_mut().focus = Some(99);
        app.fleet.agents.get_mut(&("local".into(),"chosen".into())).unwrap().status = "stopped".into();
        return_from_sessions(&mut app);
        assert_eq!(app.focused(),Some(99)); assert!(app.shell_context.contexts[&token].visit.is_some());
        app.panes.get_mut(&pane).unwrap().agent_id = "replacement".into();
        app.tab_mut().focus = Some(pane);
        return_from_sessions(&mut app);
        assert_eq!(app.panes[&pane].agent_id,"replacement");
        assert!(app.shell_context.contexts[&token].visit.is_none());
    }
    #[tokio::test]
    async fn startup_picker_handshake_is_authenticated_and_idempotent() {
        let mut app = app();
        let token = prepare(&mut app,None,false); bind(&mut app,&token,"local","shell");
        output(&mut app,1,&request(&uuid::Uuid::new_v4().to_string(),"picker-ready",""));
        assert!(app.shell_context.replies.is_empty());
        let ready = request(&token,"picker-ready","");
        output(&mut app,1,&ready);
        assert_eq!(app.shell_context.replies.len(),1);
        assert_eq!(app.shell_context.replies[0].code,0);
        output(&mut app,1,&ready);
        assert_eq!(app.shell_context.replies.len(),1);
        assert!(app.shell_context.pending.is_none() && app.modal.is_none());
    }
    #[tokio::test]
    async fn retried_request_keeps_picker_open_and_completed_action_is_not_repeated() {
        let mut app = app();
        let token = prepare(&mut app, None, false);
        bind(&mut app, &token, "local", "shell");
        let host = request(&token, "host", "");
        output(&mut app, 1, &host);
        let opened = app.shell_context.pending.as_ref().unwrap().at;
        output(&mut app, 1, &host);
        assert_eq!(app.shell_context.pending.as_ref().unwrap().at, opened);
        assert!(app.shell_context.replies.is_empty());
        cancel(&mut app);
        output(&mut app, 1, &host);
        assert!(app.modal.is_none());
        assert!(app.shell_context.pending.is_none());
        assert_eq!(app.shell_context.replies.len(), 1);
        let reset = request(&token, "model", "default");
        output(&mut app, 1, &reset);
        let route = Route { grid:"new".into(), model:"model".into(), label:"New".into() };
        app.shell_context.contexts.get_mut(&token).unwrap().route = Some(route.clone());
        output(&mut app, 1, &reset);
        assert_eq!(app.shell_context.contexts[&token].route, Some(route));
        assert_eq!(app.shell_context.replies.len(), 2);
        for _ in 0..260 { output(&mut app, 1, &request(&token, "route", "")); }
        assert_eq!(app.shell_context.replies.len(), 256);
        for r in &mut app.shell_context.replies { r.at = Instant::now() - Duration::from_secs(181); }
        tick(&mut app);
        assert!(app.shell_context.replies.is_empty());
    }
    #[tokio::test]
    async fn split_copies_route_and_window_starts_native_without_sharing_parked_shells() {
        let mut app = app();
        let token = prepare(&mut app, None, false);
        bind(&mut app, &token, "local", "shell");
        let route = Route {grid:"grid".into(),model:"model".into(),label:"grid".into()};
        assert_eq!(status(&app, Some(1)), "Test · Agent default");
        app.shell_context.contexts.get_mut(&token).unwrap().route = Some(route.clone());
        assert_eq!(status(&app, Some(1)), "Test · model");
        let source = ("local".into(),"shell".into());
        let split = prepare(&mut app, Some(&source), true);
        let window = prepare(&mut app, Some(&source), false);
        assert_eq!(app.shell_context.contexts[&split].route, Some(route));
        assert!(app.shell_context.contexts[&split].hosts.is_empty());
        assert!(app.shell_context.contexts[&window].route.is_none());
        app.shell_context.contexts.get_mut(&split).unwrap().route = None;
        assert!(app.shell_context.contexts[&token].route.is_some());
        bind(&mut app, &window, "local", "other-shell");
        app.panes.get_mut(&1).unwrap().agent_id = "other-shell".into();
        assert_eq!(status(&app, Some(1)), "Test · Agent default", "each pane shows its own model route");
        app.panes.get_mut(&1).unwrap().agent_id = "unmanaged".into();
        assert!(status(&app, Some(1)).is_empty(), "ordinary panes keep their existing footer");
    }
    #[tokio::test]
    async fn helpers_require_their_own_writable_pane_and_escape_always_releases_them() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = app();
        let token = prepare(&mut app, None, false);
        bind(&mut app, &token, "local", "shell");
        output(&mut app, 1, &request(&uuid::Uuid::new_v4().to_string(), "host", ""));
        assert!(app.shell_context.pending.is_none());
        app.panes.get_mut(&1).unwrap().read_only = true;
        output(&mut app, 1, &request(&token, "host", ""));
        assert!(app.shell_context.pending.is_none());
        app.panes.get_mut(&1).unwrap().read_only = false;
        for key in [KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), KeyEvent::new(KeyCode::Char('c'),KeyModifiers::CONTROL)] {
            output(&mut app, 1, &request(&token, "host", ""));
            assert!(app.shell_context.pending.is_some());
            assert!(matches!(app.modal,Some(Modal::Picker {kind:PickerKind::ShellContext,..})));
            crate::input::modal_key(&mut app, key);
            assert!(app.shell_context.pending.is_none());
            assert!(app.modal.is_none());
        }
        output(&mut app, 1, &request(&token, "model", "default"));
        assert!(app.shell_context.pending.is_none());
    }
    #[tokio::test]
    async fn lost_picker_timeout_and_account_change_do_not_leave_helpers_or_routes_behind() {
        let mut app = app();
        let token = prepare(&mut app, None, false);
        bind(&mut app,&token,"local","shell");
        output(&mut app,1,&request(&token,"host",""));
        app.modal = None;
        tick(&mut app);
        assert!(app.shell_context.pending.is_none());
        output(&mut app,1,&request(&token,"host",""));
        app.shell_context.pending.as_mut().unwrap().at = Instant::now()-Duration::from_secs(110);
        tick(&mut app);
        assert!(app.shell_context.pending.is_none());
        assert!(app.modal.is_none());
        app.shell_context.contexts.get_mut(&token).unwrap().route = Some(Route {grid:"old-account".into(),model:"old-model".into(),label:"old".into()});
        bind(&mut app,&token,"remote","parked");
        account_changed(&mut app,"local","new-local",true);
        let context = &app.shell_context.contexts[&token];
        assert_eq!(context.hosts.get("new-local").map(String::as_str),Some("shell"));
        assert!(!context.hosts.contains_key("remote"));
        assert!(context.route.is_none());
    }
    #[tokio::test]
    async fn session_picker_searches_old_catalog_rows_and_escape_returns_to_shell() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = app();
        sessions(&mut app,Some(1),"");
        app.shell_context.catalog = crate::app::said_hits("local", &json!({"hits":[{"sessionId":"old-saved", "engine":"claude", "external":{"title":"Fix workspace navigation", "cwd":"/projects/workspace"}}]}));
        crate::input::refill(&mut app);
        for c in "fxwsp".chars() { crate::input::modal_key(&mut app,KeyEvent::new(KeyCode::Char(c),KeyModifiers::NONE)); }
        let Some(Modal::Picker {picker,..}) = &app.modal else { panic!("closed") };
        assert_eq!(picker.current_id().as_deref(),Some("external:local:old-saved"));
        crate::input::modal_key(&mut app,KeyEvent::new(KeyCode::Esc,KeyModifiers::NONE));
        assert!(app.modal.is_none());
        assert_eq!(app.focused(),Some(1));
        assert_eq!(app.panes.len(),1);
        assert!(app.shell_context.sessions_machine.is_none());
    }

    #[tokio::test]
    async fn session_catalog_merges_by_activity_and_late_pages_keep_selection() {
        let mut app = app();
        let mut agent = crate::fleet::agent_from("local", &json!({"id":"shell", "engine":"terminal", "status":"active", "name":"Middle"}), None);
        agent.updated_at = 2000; agent.created_at = 0; agent.active_at = 0;
        app.fleet.agents.insert(agent.key(),agent);
        app.shell_context.sessions_machine = Some("local".into());
        let hit = |id:&str,title:&str,at:u64| json!({"sessionId":id,"engine":"claude","lastAt":at,"external":{"title":title,"cwd":"/project"}});
        app.shell_context.catalog = crate::app::said_hits("local", &json!({"hits":[hit("001-old","Old work",1000),hit("002-new","Recent work",3000),hit("003-unknown","No timestamp",0)]}));
        let kind = PickerKind::Open {filter:Filter::All,machine:Some("local".into()),project:None};
        let mut picker = Picker::new("", "");
        crate::input::fill(&app,&kind,&mut picker);
        let ids = |p:&Picker| p.visible.iter().map(|(i,_)|p.rows[*i].id.as_str()).collect::<Vec<_>>().join(",");
        assert_eq!(ids(&picker),"external:local:002-new,local:shell,external:local:001-old,external:local:003-unknown");
        picker.select("external:local:001-old");
        app.shell_context.catalog.extend(crate::app::said_hits("local",&json!({"hits":[hit("999-late","Newest work",4000)]})));
        crate::input::fill(&app,&kind,&mut picker);
        assert_eq!(picker.rows[picker.visible[0].0].id,"external:local:999-late");
        assert_eq!(picker.current_id().as_deref(),Some("external:local:001-old"));
        for c in "old work".chars() { picker.type_char(c); }
        assert_eq!(picker.current_id().as_deref(),Some("external:local:001-old"));
    }

    #[tokio::test]
    async fn inline_list_uses_shared_rows_and_does_not_open_a_modal() {
        let mut app = app();
        let token = prepare(&mut app,None,false); bind(&mut app,&token,"local","shell");
        let message=request(&token,"list-host",r#"{"query":"","revision":""}"#);
        output(&mut app,1,&message);
        assert!(app.modal.is_none()); assert!(app.shell_context.pending.is_none());
        let response=app.shell_context.replies.back().unwrap();
        let data=response.data.as_ref().unwrap();
        assert_eq!(data["rows"][0]["label"],"Test"); assert_eq!(data["rows"][0]["id"],"local");
        let revision=data["revision"].as_str().unwrap().to_string();
        output(&mut app,1,&request(&token,"list-host",&json!({"query":"","revision":revision}).to_string()));
        assert_eq!(app.shell_context.replies.back().unwrap().data.as_ref().unwrap()["unchanged"],true);
        output(&mut app,1,&request(&token,"close-picker",""));
        assert!(app.shell_context.inline.is_none()); assert_eq!(app.focused(),Some(1));
        assert_eq!(app.panes.len(),1);
    }
    #[tokio::test]
    async fn catalog_replies_carry_the_tuis_theme() {
        let _l = crate::term_out::colours_lock();
        let _restore = LookGuard;
        crate::term_out::set_theme_colours(Some(("#101010".into(), "#eeeeee".into())));
        crate::term_out::set_accent_override(Some("#ff0000".into()));
        crate::settings::set_fzf_lists(true);
        let mut app = app();
        let token = prepare(&mut app,None,false); bind(&mut app,&token,"local","shell");
        output(&mut app,1,&request(&token,"list-host",r#"{"query":"","revision":""}"#));
        let data = app.shell_context.replies.back().unwrap().data.as_ref().unwrap();
        assert_eq!(data["look"]["accent"],"#ff0000");
        assert_eq!(data["look"]["background"],"#101010");
        assert_eq!(data["look"]["foreground"],"#eeeeee");
        assert_eq!(data["look"]["lists"],"fzf");
        let revision = data["revision"].as_str().unwrap().to_string();
        crate::settings::set_fzf_lists(false);
        output(&mut app,1,&request(&token,"list-host",&json!({"query":"","revision":revision}).to_string()));
        let data = app.shell_context.replies.back().unwrap().data.as_ref().unwrap();
        assert_eq!(data["unchanged"],true);
        assert_eq!(data["look"]["accent"],"#ff0000","an unchanged reply still says the theme");
        // A reply that is no catalog (a plan, an acknowledgement) carries no look.
        let plan = request(&token,"model-inline","0");
        output(&mut app,1,&plan);
        assert!(app.shell_context.replies.back().unwrap().data.as_ref().is_none_or(|d| d.get("look").is_none()));
    }
    /// Puts hn's process-wide colours and list style back, even when an assertion fails.
    struct LookGuard;
    impl Drop for LookGuard {
        fn drop(&mut self) {
            crate::term_out::set_theme_colours(None); crate::term_out::set_accent_override(None);
            crate::settings::set_fzf_lists(false);
        }
    }
    #[test]
    fn the_looks_lists_follow_the_choice_not_the_developers_environment() {
        let _l = crate::term_out::colours_lock();
        let _restore = LookGuard;
        let words = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        assert_eq!(look_value_with(&[])["lists"], "");
        assert_eq!(look_value_with(&words("--layout=reverse --border"))["lists"], "fzf");
        crate::settings::set_fzf_lists(true);
        assert_eq!(look_value_with(&[])["lists"], "fzf", "@hn-lists fzf");
    }
    #[test]
    fn a_new_shell_starts_with_the_tuis_look_in_its_environment() {
        let script = init_script("tok","/bin/hn","harness",Some(r##"{"background":"#101010","accent":"it's"}"##));
        assert!(script.starts_with("export _HN_CONTEXT='tok'\n"));
        assert!(script.contains(r##"export HN_LOOK='{"background":"#101010","accent":"it'\''s"}'"##),"{script}");
        assert!(!init_script("tok","/bin/hn","harness",None).contains("HN_LOOK"));
    }
    #[test]
    fn a_new_shell_starts_in_the_folder_it_asked_for_whatever_tmux_left_it_in() {
        let mut local = bootstrap("tok", Some("cli"), true);
        start_in(&mut local, Some("/work/project"), true);
        let mut remote = bootstrap("tok", Some("cli"), false);
        start_in(&mut remote, Some("/work/project"), false);
        assert!(!remote.iter().any(|a| a.starts_with("--cwd=")), "a remote's older hn would refuse it");
        let (args, look) = split_look(&local[2..]);
        let (args, cwd) = split_option(&args, "--cwd=");
        assert_eq!((args, cwd.as_deref()), (vec!["tok".to_string(), "cli".to_string()], Some("/work/project")));
        assert!(look.is_some());
        // The asked folder when it is one; else where the helper was started, while that is a folder.
        let there = tempfile_dir();
        assert_eq!(start_folder(Some(there.to_str().unwrap())), there);
        let here = std::env::current_dir().unwrap();
        assert_eq!(start_folder(Some("/no/such/folder/for/hn")), here);
        assert_eq!(start_folder(None), here);
        let _ = std::fs::remove_dir(&there);
    }
    fn tempfile_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hn-start-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        dir
    }
    #[test]
    fn the_look_travels_in_the_shell_start_arguments() {
        let _l = crate::term_out::colours_lock();
        let _restore = LookGuard;
        crate::term_out::set_theme_colours(Some(("#101010".into(),"#eeeeee".into())));
        let argv = bootstrap("tok",Some("cli"),true);
        let remote = bootstrap("tok",Some("cli"),false);
        crate::term_out::set_theme_colours(None);
        assert!(argv.iter().any(|a| a.starts_with("--look={") && a.contains("#101010")),"{argv:?}");
        assert!(!remote.iter().any(|a| a.starts_with("--look=")),"a remote's older hn would refuse it");
        let (args, look) = split_look(&argv[2..]);
        assert_eq!(args, ["tok".to_string(),"cli".to_string()]);
        assert!(look.unwrap().contains("#eeeeee"));
    }
    #[tokio::test]
    async fn inline_model_selection_uses_stable_ids_and_retry_does_not_repeat_it() {
        let mut app=app();
        let token=prepare(&mut app,None,false);bind(&mut app,&token,"local","shell");
        let route=Route{grid:"computer".into(),model:"model".into(),label:"Computer".into()};
        app.shell_context.routes=vec![route.clone()];
        output(&mut app,1,&request(&token,"model-inline","0"));
        assert_eq!(app.shell_context.replies.back().unwrap().code,1);
        assert!(app.shell_context.contexts[&token].route.is_none());
        let choose=request(&token,"model-inline",&route_id(&route));
        output(&mut app,1,&choose);
        assert_eq!(app.shell_context.contexts[&token].route,Some(route));
        output(&mut app,1,&request(&token,"model-inline","default"));
        // Background catalog snapshots cannot evict the action's retry receipt.
        for _ in 0..10 {output(&mut app,1,&request(&token,"list-host",r#"{"query":""}"#));}
        output(&mut app,1,&choose);
        assert!(app.shell_context.contexts[&token].route.is_none());
        assert!(app.modal.is_none());
    }
    #[tokio::test]
    async fn completed_model_commands_require_one_exact_route() {
        let mut app=app();
        let token=prepare(&mut app,None,false);bind(&mut app,&token,"local","shell");
        let route=Route{grid:"Studio 日本".into(),model:"qwen/coder".into(),label:"Studio".into()};
        app.shell_context.routes=vec![route.clone()];
        output(&mut app,1,&request(&token,"model-inline","Studio 日本 :: qwen/coder"));
        assert_eq!(app.shell_context.contexts[&token].route,Some(route.clone()));
        output(&mut app,1,&request(&token,"model-inline","default"));
        output(&mut app,1,&request(&token,"model-inline","Studio 日本 :: qwen"));
        assert_eq!(app.shell_context.replies.back().unwrap().code,1);
        assert!(app.shell_context.contexts[&token].route.is_none());
        app.shell_context.routes.push(route);
        output(&mut app,1,&request(&token,"model-inline","Studio 日本 :: qwen/coder"));
        assert_eq!(app.shell_context.replies.back().unwrap().code,1);
        assert!(app.shell_context.contexts[&token].route.is_none());
        assert!(app.modal.is_none());
    }
    #[tokio::test]
    async fn a_composed_remote_launch_stays_pending_without_a_modal_until_cancelled() {
        let mut app=app();
        let token=prepare(&mut app,None,false);bind(&mut app,&token,"local","shell");
        let id=uuid::Uuid::new_v4().to_string();
        app.shell_context.pending=Some(Request{token:token.clone(),id:id.clone(),pane:1,verb:"compose-launch".into(),query:"{}".into(),at:Instant::now()});
        tick(&mut app);
        assert!(app.shell_context.pending.is_some(), "remote RPCs must finish before replying to the shell");
        assert!(app.shell_context.replies.is_empty());
        output(&mut app,1,format!("\x1b]633;hn;{token};{id};cancel;\x07").as_bytes());
        assert!(app.shell_context.pending.is_none());
        assert_eq!(app.shell_context.replies.back().unwrap().code,1);
    }

    #[tokio::test]
    async fn an_inline_request_the_shell_gave_up_on_is_dropped_and_frees_the_picker() {
        let mut app=app();
        let token=prepare(&mut app,None,false);bind(&mut app,&token,"local","shell");
        let id=uuid::Uuid::new_v4().to_string();
        let waiting=|verb:&str,age:u64|Some(Request{token:token.clone(),id:uuid::Uuid::new_v4().to_string(),pane:1,verb:verb.into(),query:"Gone".into(),at:Instant::now()-Duration::from_secs(age)});
        // the shell waits as long as the TUI's own budget for each action; the TUI
        // keeps the request 5 s longer than that
        for (verb,limit) in [("host-inline",100),("session-inline",180),("model-inline",60)] {
            app.shell_context.pending=waiting(verb,limit+2);
            tick(&mut app);assert!(app.shell_context.pending.is_some(),"{verb} outlives the shell's {limit} s wait");
            app.shell_context.pending=waiting(verb,limit+6);
            tick(&mut app);
            assert!(app.shell_context.pending.is_none(),"{verb} expires 5 s after the shell gives up");
            assert_eq!(app.shell_context.replies.back().unwrap().code,1);
        }
        let pending=|age:u64|Some(Request{token:token.clone(),id:id.clone(),pane:1,verb:"host-inline".into(),query:"Gone".into(),at:Instant::now()-Duration::from_secs(age)});
        // a later request is served, not refused with "close the current picker first"
        output(&mut app,1,&request(&token,"model-inline","default"));
        assert_eq!(app.shell_context.replies.back().unwrap().code,0);
        // a cancel for a waiting -inline request frees the picker at once
        app.shell_context.pending=pending(1);
        output(&mut app,1,format!("\x1b]633;hn;{token};{id};cancel;\x07").as_bytes());
        assert!(app.shell_context.pending.is_none());
        output(&mut app,1,&request(&token,"model-inline","default"));
        assert_eq!(app.shell_context.replies.back().unwrap().code,0);
    }

    #[tokio::test]
    async fn inline_cancel_and_invalid_session_return_to_the_same_shell() {
        let mut app=app();
        let token=prepare(&mut app,None,false);bind(&mut app,&token,"local","shell");
        let id=uuid::Uuid::new_v4().to_string();
        app.shell_context.pending=Some(Request{token:token.clone(),id:id.clone(),pane:1,verb:"host-inline".into(),query:"remote".into(),at:Instant::now()});
        tick(&mut app);assert!(app.shell_context.pending.is_some(),"inline requests do not require a modal");
        output(&mut app,1,format!("\x1b]633;hn;{token};{id};cancel;\x07").as_bytes());
        assert!(app.shell_context.pending.is_none());
        output(&mut app,1,&request(&token,"session-inline","external:other:forged"));
        assert_eq!(app.shell_context.replies.back().unwrap().code,1);
        assert!(app.modal.is_none());assert_eq!(app.focused(),Some(1));
    }

}
