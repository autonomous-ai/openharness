//! The Models view — `:` in the launcher, and Models… in the Commands panel: every model a harness
//! can run on, in the desktop picker's sections and order (Subscriptions, APIs, Your models, the
//! downloads that fit this computer, Shared with you), each row saying what Enter does on it. Enter is **Use**: a
//! local model is downloaded, started and waited for until it serves, then the focused harness is
//! moved onto it (`agent_retarget`); a shared or API model moves it at once; a subscription puts it
//! back on its own login. ^S stops a local model. One local model runs at a time: Use stops the one
//! running first (asked first when another harness answers with it).
//!
//! The daemon's replies are read here defensively, the way the desktop's `LocalModel`, `GridModels`
//! and `ApiConnection` read them: an older daemon's missing fields are absent, never a failure.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::{json, Value};

use crate::app::App;
use crate::daemon::RpcError;
use crate::fleet::Machine;
use crate::picker::{Picker, Row};
use crate::theme::{self, engine_label, fg};

pub const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
/// How long Use waits for a started model to serve before it says so (the desktop's three minutes).
const USE_WAIT: Duration = Duration::from_secs(180);
/// A pane waiting on a resting model says "Starting up…" this long, then that it may take longer —
/// and nothing past the cap: its own terminal is the better witness by then.
const START_STILL: Duration = Duration::from_secs(60);
const START_CAP: Duration = Duration::from_secs(180);
/// A section woken ("Show models") is read again this often, for at most this long: the daemon's
/// own wake gives up at 45 s.
const WAKE_EVERY: Duration = Duration::from_secs(5);
const WAKE_FOR: Duration = Duration::from_secs(60);
/// The downloads listed before "More models".
const SHOWN_DOWNLOADS: usize = 5;

fn num(v: &Value) -> Option<f64> { v.as_f64().filter(|n| n.is_finite() && *n >= 0.0) }
fn text(v: &Value) -> Option<String> { v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string) }
fn span(t: impl Into<String>, style: Style) -> Span<'static> { Span::styled(t.into(), style) }

// ── the replies ──────────────────────────────────────────────────────────────────

/// A download, start or stop the daemon owns (`operation`): it survives the view closing.
#[derive(Clone, Debug, PartialEq)]
pub struct Operation { pub id: String, pub model: String, pub action: String, pub stage: String, pub phase: String, pub progress: Option<f64>, pub error: Option<String> }

impl Operation {
    /// Read as the desktop's `LocalModelOperation.parse`: anything it does not know is no operation.
    pub fn parse(v: &Value) -> Option<Operation> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let (action, stage, phase) = (s("action")?, s("stage")?, s("phase")?);
        if !["download", "start", "stop"].contains(&action.as_str()) || !["checking", "downloading", "starting", "verifying", "stopping"].contains(&stage.as_str()) || !["running", "done", "failed"].contains(&phase.as_str()) { return None }
        Some(Operation { id: s("id")?, model: s("modelId")?, action, stage, phase, progress: v.get("progress").and_then(num).map(|p| p.clamp(0.0, 1.0)), error: s("error") })
    }
    pub fn active(&self) -> bool { self.phase == "running" }
    pub fn failed(&self) -> bool { self.phase == "failed" }
    pub fn label(&self) -> &'static str {
        match self.stage.as_str() { "downloading" => "Downloading", "starting" => "Starting", "verifying" => "Testing", "stopping" => "Stopping", _ => "Checking" }
    }
    /// `Downloading 42%`: what a row and its preview say while it runs.
    pub fn word(&self) -> String { match self.progress { Some(p) => format!("{} {}%", self.label(), (p * 100.0).floor() as u32), None => self.label().to_string() } }
}

/// One model of this computer's (`grid_fleet_models_list`): downloaded, running, or one the grid's
/// catalog says fits it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LocalModel {
    pub id: String, pub name: String, pub state: String, pub size: Option<f64>, pub quant: Option<String>, pub recommended: bool,
    pub can_start: bool, pub can_stop: bool, pub tok_s: Option<f64>, pub requests: Option<f64>, pub window_secs: Option<f64>,
    /// The catalog's word on it for this machine: its window, speed and billions of parameters.
    pub context: Option<f64>, pub est_tok_s: Option<f64>, pub params_b: Option<f64>,
    pub operation: Option<Operation>, pub asleep: bool,
    /// The app it runs in: `Ollama`, `LM Studio` or `llama.cpp` for one that app downloaded, `Grid`
    /// for Grid's own engine (absent from an older daemon).
    pub app: Option<String>,
}

impl LocalModel {
    fn from(v: &Value) -> Option<LocalModel> {
        let id = text(&v["id"])?;
        Some(LocalModel {
            name: text(&v["name"]).unwrap_or_else(|| id.clone()), state: text(&v["state"]).unwrap_or_else(|| "available".into()),
            size: num(&v["sizeBytes"]), quant: text(&v["quant"]), recommended: v["recommended"] == true, can_start: v["canStart"] == true, can_stop: v["canStop"] == true,
            tok_s: num(&v["tokensPerSecond"]), requests: num(&v["requests"]), window_secs: num(&v["windowSeconds"]),
            context: num(&v["contextWindow"]), est_tok_s: num(&v["estTokS"]), params_b: num(&v["paramsB"]),
            operation: Operation::parse(&v["operation"]), asleep: v["gridAsleep"] == true, app: text(&v["app"]), id,
        })
    }
    pub fn running(&self) -> bool { self.state == "running" }
    pub fn downloaded(&self) -> bool { self.state == "downloaded" || self.running() }
    /// Running, parked while this computer's models rest: it answers again on the next message.
    pub fn resting(&self) -> bool { self.running() && self.asleep }
    /// Its quantization: the daemon's, else the one its file name says (`…-Q4_K_M.gguf`) — never
    /// guessed from its size.
    pub fn quantization(&self) -> Option<String> {
        if let Some(q) = &self.quant { return Some(q.clone()) }
        self.id.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).find(|w| {
            let u = w.to_ascii_uppercase();
            let digit_after = |p: &str| u.strip_prefix(p).is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()));
            digit_after("IQ") || digit_after("Q") || digit_after("MXFP") || ["BF16", "FP16", "F16"].contains(&u.as_str())
        }).map(str::to_ascii_uppercase)
    }
}

/// What `grid_fleet_models_list` answers: the models, the machine's memory and free disk, and
/// whether an operation is under way.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot { pub models: Vec<LocalModel>, pub memory: Option<f64>, pub free_disk: Option<f64>, pub hardware: Option<String>, pub notice: Option<String>, pub busy: bool, pub supports_download: bool }

/// None when there is no list — a daemon too old for it, or a reply that failed.
pub fn parse_local(reply: &Value) -> Option<Snapshot> {
    let models = reply["models"].as_array()?.iter().filter_map(LocalModel::from).collect();
    Some(Snapshot {
        models, memory: num(&reply["memoryBytes"]).filter(|m| *m > 0.0), free_disk: num(&reply["freeDiskBytes"]), hardware: text(&reply["hardware"]),
        // A sentence beside the list, never a failure (an `error` fails the whole request).
        notice: text(&reply["notice"]), busy: reply["busy"] == true, supports_download: reply["supportsDownload"] == true,
    })
}

/// A model a grid serves; `offline` names the computer when every one serving it seems offline.
#[derive(Clone, Debug, PartialEq)]
pub struct GridModel { pub id: String, pub node: String, pub offline: Option<String> }

/// One grid this computer is signed into: the account's own, or a shared one, and how it answered
/// the daemon's last look (`awake`, `asleep`, `waking`, `unknown`; empty from an older daemon).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Section { pub name: String, pub own: bool, pub models: Vec<GridModel>, pub state: String, pub seen: bool, pub age: Option<u64>, pub outcome: String }

/// `grid_models_list`'s answer, and the `grid_models_changed` push (the same document).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grids { pub grid_name: Option<String>, pub sections: Vec<Section>, pub engines: Option<Vec<String>>, pub launch: bool, pub reachable: bool }

impl Grids {
    /// Whether [engine] may be pointed at a grid model: only an engine the daemon lists, when it
    /// sent a list (an older one did not, and refused nothing).
    pub fn can_run(&self, engine: &str) -> bool { self.engines.as_ref().is_none_or(|e| e.iter().any(|x| x.eq_ignore_ascii_case(engine))) }
    pub fn waking(&self) -> bool { self.sections.iter().any(|s| s.state == "waking") }
}

pub fn parse_grids(reply: &Value) -> Grids {
    let models = |raw: &Value| raw.as_array().into_iter().flatten().filter_map(|m| {
        let id = text(&m["id"])?;
        let node = m["node"].as_str().unwrap_or("").to_string();
        let offline = match &m["unavailable"] {
            Value::Object(u) if u.get("reason").and_then(Value::as_str) == Some("offline") => u.get("machine").and_then(text),
            Value::Bool(true) => Some(node.clone()),
            _ => None,
        };
        Some(GridModel { id, node, offline })
    }).collect::<Vec<_>>();
    let mut sections: Vec<Section> = reply["grids"].as_array().into_iter().flatten().filter_map(|g| Some(Section {
        name: text(&g["name"])?, own: g["own"] == true, models: models(&g["models"]), state: g["state"].as_str().unwrap_or("").to_string(),
        seen: g["seenAt"].is_string(), age: num(&g["lastKnownAge"]).map(|a| a.round() as u64), outcome: g["wakeOutcome"].as_str().unwrap_or("").to_string(),
    })).collect();
    let grid_name = text(&reply["gridName"]);
    // An older daemon names its own grid alone.
    if sections.is_empty() { if let Some(name) = &grid_name { sections.push(Section { name: name.clone(), own: true, models: models(&reply["models"]), ..Default::default() }) } }
    Grids {
        grid_name, sections,
        engines: reply["localModelEngines"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect()),
        launch: reply["supportsModelLaunch"] == true, reachable: reply.get("error").is_none_or(Value::is_null),
    }
}

/// What a resting section says beside its list — the desktop's `sectionWords`, word for word: a
/// subtitle under its heading, one sentence above its rows, and whether it offers "Show models".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Words { pub subtitle: Option<String>, pub sentence: Option<String>, pub offer_wake: bool }


pub const STARTING_UP_WAIT: &str = "Starting up… usually 15–40 s";

/// "just now", then whole minutes, hours and days — rounded down, never younger than it is.
pub fn list_age(seconds: u64) -> String {
    match seconds { s if s < 60 => "just now".into(), s if s < 3600 => format!("{}min ago", s / 60), s if s < 86400 => format!("{}h ago", s / 3600), s => format!("{}d ago", s / 86400) }
}

/// [asking]: a wake this view sent and has not heard back about.
pub fn section_words(s: &Section, asking: bool) -> Words {
    let has = !s.models.is_empty();
    let no_record = s.age.is_none();
    let subtitle = (s.state == "asleep" && has).then(|| match s.age { Some(a) => format!("Asleep {}", list_age(a)), None => "Asleep".to_string() });
    let mut offer_wake = false;
    let sentence = if s.state == "waking" { Some(STARTING_UP_WAIT.to_string()) }
        else if s.outcome == "not_started" { Some(format!("Couldn't start {} right now — it will start on your next message", if s.own { "your models" } else { s.name.as_str() })) }
        else if s.outcome == "nobody_serving" { Some("Nobody is serving a model here right now".to_string()) }
        else if s.state == "asleep" && !has && no_record { offer_wake = !asking; asking.then(|| STARTING_UP_WAIT.to_string()) }
        else if s.state == "asleep" && !has { Some("Nobody was serving here when it went to sleep".to_string()) }
        else if s.state == "unknown" && (has || s.seen || !no_record) { Some("Not answering right now".to_string()) }
        else { None };
    Words { subtitle, sentence, offer_wake }
}

/// An API saved on this computer (`api_connections`) — its key stays in the daemon.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Api { pub id: String, pub name: String, pub base_url: String, pub header: String, pub prefix: String }

impl Api {
    /// Coding agents send a custom endpoint only `Authorization: Bearer <key>`: only such an API
    /// lists models a harness can run on (the CLI's `servesModels`).
    pub fn serves_models(&self) -> bool { self.header.eq_ignore_ascii_case("authorization") && self.prefix.eq_ignore_ascii_case("bearer") }
    pub fn host(&self) -> String { let rest = self.base_url.split_once("://").map(|(_, r)| r).unwrap_or(&self.base_url); rest.split(['/', '?', '#']).next().unwrap_or(rest).to_string() }
}

/// One model an API lists: no key, only what the API says of it.
#[derive(Clone, Debug, PartialEq)]
pub struct ApiModel { pub id: String, pub name: Option<String>, pub context: Option<u64> }

/// The saved APIs, or why there are none to show.
pub fn parse_apis(reply: &Value) -> Result<Vec<Api>, String> {
    let rows = reply["connections"].as_array().ok_or("Update Harness on this computer to connect APIs.")?;
    Ok(rows.iter().filter_map(|c| {
        let s = |k: &str, d: &str| c[k].as_str().unwrap_or(d).to_string();
        let id = text(&c["id"])?;
        Some(Api { id, name: s("name", ""), base_url: s("baseUrl", ""), header: s("authHeader", "Authorization"), prefix: s("authPrefix", "Bearer") })
    }).collect())
}

pub fn parse_api_models(reply: &Value) -> Option<Vec<ApiModel>> {
    Some(reply["models"].as_array()?.iter().filter_map(|m| Some(ApiModel {
        id: text(&m["id"])?, name: text(&m["name"]), context: m["contextWindow"].as_u64().filter(|w| *w > 0),
    })).collect())
}

/// An agent account's subscription, from the usage the status line reads (`usage_read`): how much
/// of its tightest window is left.
#[derive(Clone, Debug, PartialEq)]
pub struct Sub { pub engine: String, pub title: String, pub account: String, pub left: Option<f64>, pub status: String, pub details: Vec<String> }

/// What is left of a window, as the desktop says it: never a positive remainder rounded to 0.
fn left_of(used: f64) -> String { let left = (100.0 - used).clamp(0.0, 100.0); if left > 0.0 && left < 1.0 { "<1%".into() } else { format!("{}%", left.floor() as u32) } }

pub fn subscriptions(app: &App) -> Vec<Sub> {
    let mut machines: Vec<&String> = app.usage.keys().collect();
    machines.sort_by_key(|m| (**m != app.fleet.local_id, (*m).clone()));
    let mut out: Vec<Sub> = Vec::new();
    for m in machines {
        for u in &app.usage[m] {
            let account = u.account.clone().unwrap_or_default();
            if out.iter().any(|s| s.engine == u.provider && s.account == account) { continue }
            let tightest = u.windows.iter().max_by(|a, b| a.used.total_cmp(&b.used));
            let title = match u.provider.as_str() { "claude" => "Anthropic".to_string(), "codex" => "OpenAI".to_string(), p => engine_label(p).to_string() };
            out.push(Sub {
                engine: u.provider.clone(), title, account,
                left: tightest.map(|w| (100.0 - w.used).clamp(0.0, 100.0)),
                status: tightest.map(|w| format!("{} left", left_of(w.used))).unwrap_or_else(|| "Usage unavailable".into()),
                details: u.windows.iter().map(|w| format!("{} — {} left", w.label, left_of(w.used))).collect(),
            });
        }
    }
    out
}

// ── what the view keeps ──────────────────────────────────────────────────────────

/// Where a Use is: getting the weights, stopping the model running here (one local model runs at a
/// time), starting them, waiting for the grid to list the model as served, or moving the harness
/// onto it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step { Get, Stop, Start, Serve, Switch }

/// Enter's Use on a local model, carried through its steps as the replies come in. It outlives
/// the view: a download takes minutes, and the view must not hold the terminal that long — the
/// harness moves when the model serves, and the status line says so.
#[derive(Clone, Debug)]
pub struct Use {
    pub model: String, pub name: String, pub machine: String, pub agent: String, pub step: Step, pub since: Instant,
    /// The model running here that it stops before this one starts (id, name) — after a download, so
    /// that one answers until this one can start.
    pub stops: Option<(String, String)>,
    pub identity: Option<crate::session_close::Identity>,
}

/// An `agent_retarget` sent: the harness, the model it goes to (empty: its own login), and when —
/// "Switching…" on the row and the pane until its frame says it is there (the pane restarts), or
/// a minute passes.
#[derive(Clone, Debug)]
pub struct Switch { pub machine: String, pub agent: String, pub to: String, pub name: String, pub since: Instant }

const SWITCH_FOR: Duration = Duration::from_secs(60);

/// A Use over: its row, its model's name, the step it reached, and why it failed (None: ready);
/// [seen]: the cursor has been on its row since (leaving the row then ends it).
#[derive(Clone, Debug)]
pub struct Ended { pub row: String, pub name: String, pub step: Step, pub failed: Option<String>, pub seen: bool, pub stops: Option<String> }

/// A Use's steps, as its preview lists them: a stop of the model running here only when it makes one.
pub fn steps(stops: Option<&str>) -> Vec<String> {
    let mut out = vec!["Download".to_string()];
    out.extend(stops.map(|name| format!("Stop {name}")));
    out.extend(["Start", "Serve", "Switch harness"].map(String::from));
    out
}

/// A step's mark: done ✓, under way ↻ (its progress, when the daemon sends one), failed ✗, or
/// still to come.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mark { Done, Now(Option<f64>), Failed, Later }

/// The marks of a Use at [step] ([stops]: it stops the model running here), [op] the operation on
/// its model; [ended]: Some(true) ready, Some(false) failed at [step], None under way.
pub fn checklist(step: Step, stops: bool, op: Option<&Operation>, ended: Option<bool>) -> Vec<Mark> {
    let order: Vec<Step> = [Step::Get, Step::Stop, Step::Start, Step::Serve, Step::Switch].into_iter().filter(|s| stops || *s != Step::Stop).collect();
    let at = order.iter().position(|s| *s == step).unwrap_or(0);
    (0..order.len()).map(|i| match (i.cmp(&at), ended) {
        (_, Some(true)) | (std::cmp::Ordering::Less, _) => Mark::Done,
        (std::cmp::Ordering::Equal, Some(false)) => Mark::Failed,
        (std::cmp::Ordering::Equal, None) => Mark::Now(progress(step, op)),
        _ => Mark::Later,
    }).collect()
}

/// How far the operation under [step] is, while it runs and the daemon says (a download's or a
/// start's; serving and switching have none).
fn progress(step: Step, op: Option<&Operation>) -> Option<f64> {
    op.filter(|o| matches!(step, Step::Get | Step::Start) && o.active()).and_then(|o| o.progress)
}

fn percent(p: f64) -> u32 { (p * 100.0).floor() as u32 }

/// The model the focused harness is being moved to, while it is.
fn switching_for<'a>(app: &'a App, t: Option<&Target>) -> Option<&'a str> {
    let (t, s) = (t?, app.models_view.switching.as_ref()?);
    (s.machine == t.machine && s.agent == t.agent && !switched(app, s)).then_some(s.to.as_str())
}

/// Whether [s] is over: the harness's frame says it is on the model now, or it took too long.
fn switched(app: &App, s: &Switch) -> bool {
    s.since.elapsed() >= SWITCH_FOR || app.fleet.agent(&s.machine, &s.agent).is_none_or(|a| a.grid_model.eq_ignore_ascii_case(&s.to))
}

/// Everything the Models view knows, kept on the App (and read by the pane headings).
#[derive(Clone, PartialEq)]
struct ReadEpoch { owner:String, connection:Option<u64>, token:String }

#[derive(Default)]
pub struct Models {
    owner: Option<String>,
    reads: HashMap<(String, String), ReadEpoch>,
    /// The picker keeps the harness it opened for, even if another client changes focus.
    pub selection: Option<crate::session_close::Identity>,
    pub selection_fixed: bool,
    pub panel_generation: u64,
    pub switch_generation: u64,
    /// Each machine's local models, when they were last read, and a read out now.
    pub local: HashMap<String, Snapshot>,
    pub local_error: HashMap<String, String>,
    pub read_at: HashMap<String, Instant>,
    pub reading: HashSet<String>,
    /// The grids each machine reads (`grid_models_list`), the same way.
    pub grids: HashMap<String, Grids>,
    pub grids_at: HashMap<String, Instant>,
    pub grids_reading: HashSet<String>,
    /// This computer's saved APIs, each API's models, and those unfolded under their API.
    pub apis: Option<Result<Vec<Api>, String>>,
    pub api_models: HashMap<String, Result<Vec<ApiModel>, String>>,
    pub api_open: HashSet<String>,
    /// "More models": the whole catalog shown, not its first five.
    pub more: bool,
    /// A download, start or stop asked and not yet answered (machine, model, action), then its
    /// acknowledgement, until a read shows the daemon's own receipt.
    pub pending: Option<(String, String, &'static str)>,
    pub op: Option<(String, Operation)>,
    pub using: Option<Use>,
    /// A harness asked to move and not yet seen on its new model (its frame's `grid.model`).
    pub switching: Option<Switch>,
    /// Why the last Use of a row failed (row id, words): its preview says so.
    pub use_error: Option<(String, String)>,
    /// The first Enter's question on a row (row id, words), in its preview until Enter, Esc or the
    /// cursor leaves the row.
    pub confirm: Option<(String, String)>,
    /// How the last Use ended: its preview's checklist and ✓ / ✗ stay until the cursor leaves its
    /// row or another action starts.
    pub ended: Option<Ended>,
    /// Sections a wake was sent for and not yet answered; the re-reads that follow one.
    pub asking: HashSet<String>,
    pub follow_until: Option<Instant>,
    /// Harnesses sent a message while their model's computers rest: since when (the pane says
    /// "Starting up…" until the model answers).
    pub starts: HashMap<(String, String), Instant>,
    /// What the view asked of the daemons (machine, request, payload) — the tests read it.
    #[cfg(test)]
    pub sent: Vec<(String, String, Value)>,
}

impl Models {
    /// The operation on [m]: this view's acknowledgement while it is the newer word, else the
    /// daemon's receipt.
    pub fn op_for<'a>(&'a self, machine: &str, m: &'a LocalModel) -> Option<&'a Operation> {
        match &self.op { Some((at, o)) if at == machine && o.model == m.id => Some(o), _ => m.operation.as_ref() }
    }
    /// A download, start or stop is under way on [machine]: nothing else starts meanwhile.
    pub fn busy(&self, machine: &str) -> bool {
        self.local.get(machine).is_some_and(|s| s.busy) || self.pending.as_ref().is_some_and(|p| p.0 == machine) || self.op.as_ref().is_some_and(|(m, o)| m == machine && o.active())
    }
}

/// How often this computer's models are read: every 4 s while the view is open or something is
/// under way, else every minute.
pub fn poll_every(open: bool, busy: bool) -> Duration { Duration::from_secs(if open || busy { 4 } else { 60 }) }

/// How often the grids are read (pushes keep them current between): every 4 s while a Use waits
/// for its model to serve, every 5 s while a woken section starts up, every 20 s while the view is
/// open, else not at all.
pub fn grids_every(open: bool, serving: bool, waking: bool) -> Option<Duration> {
    if serving { Some(Duration::from_secs(4)) } else if waking { Some(WAKE_EVERY) } else if open { Some(Duration::from_secs(20)) } else { None }
}

fn due(last: Option<&Instant>, every: Duration, now: Instant) -> bool { last.is_none_or(|t| now.saturating_duration_since(*t) >= every) }

// ── the harness a Use is for ─────────────────────────────────────────────────────

/// The focused harness: what a Use moves, and what its grid fields say it is on now.
#[derive(Clone, Debug)]
pub struct Target { pub machine: String, pub agent: String, pub engine: String, pub grid_model: String, pub base_url: String }

/// The desktop offers pane model switches for these verified engines. Other engines keep
/// their own in-terminal controls; the global Models view still manages local models.
pub fn pane_supports(app: &App, pane: u64) -> bool {
    let Some(p) = app.panes.get(&pane) else { return false };
    app.fleet.machine(&p.machine_id).is_some_and(|m| !m.shared)
        && app.fleet.agent(&p.machine_id, &p.agent_id).is_some_and(|a| a.status != "stopped" && ["codex", "claude", "opencode"].contains(&a.engine.as_str()))
}

pub fn pane_label(app: &App, pane: u64) -> String {
    let observed = app.panes.get(&pane).and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).and_then(|a| {
        if !a.grid_model.is_empty() { Some(a.grid_model.clone()) }
        else { crate::runtime_model::details(&a.model, &a.id, &a.engine).map(|m| m.name) }
    });
    let label = observed.unwrap_or_else(|| "Model".into()).chars().filter(|c| !c.is_control()).collect::<String>();
    crate::format::clip_middle(&label, 24)
}

pub fn target(app: &App) -> Option<Target> {
    let of = |machine: String, agent: String| -> Option<Target> {
        if app.fleet.machine(&machine).is_some_and(|m| m.shared) { return None }
        let a = app.fleet.agent(&machine, &agent)?;
        let a = if app.models_view.selection_fixed { if a.status == "stopped" { return None } a } else { live_in_pane(app, a) };
        (a.engine != "terminal").then(|| Target { engine: a.engine.clone(), grid_model: a.grid_model.clone(), base_url: a.grid_base_url.clone(), machine, agent: a.id.clone() })
    };
    if app.models_view.selection_fixed {
        let selected = app.models_view.selection.as_ref()?;
        if !selected.matches(app) { return None }
        return of(selected.machine.clone(), selected.agent.clone());
    }
    if let Some(t) = crate::input::focused_agent(app).and_then(|(m, a)| of(m, a)) { return Some(t) }
    // No pane focused at all: the harness on screen, when it is the only one. (A pane that is
    // focused — a shell, a terminal — is the one meant: never another harness in its place.)
    if app.focused().is_some() { return None }
    let mut shown = app.rects.iter().filter_map(|(id, _)| app.panes.get(id)).filter_map(|p| of(p.machine_id.clone(), p.agent_id.clone()));
    let only = shown.next()?;
    shown.next().is_none().then_some(only)
}

/// The harness pane [a] is showing now. When an engine exits, the daemon retires its harness with the
/// conversation and the shell left in its tmux pane goes on under a new id — so does an engine started
/// in that shell next. A pane still on the retired id shows that one: Use moves it, never the archive
/// ("That harness is gone").
pub fn live_in_pane<'a>(app: &'a App, a: &'a crate::fleet::Agent) -> &'a crate::fleet::Agent {
    if a.status != "stopped" || a.tmux_pane.is_empty() { return a }
    app.fleet.agents.values().find(|o| o.machine_id == a.machine_id && o.id != a.id && o.status != "stopped" && o.tmux_pane == a.tmux_pane).unwrap_or(a)
}

/// Why there is no harness to move: what the focused pane is, said so a person can act on it.
pub fn no_target_why(app: &App) -> String {
    if selection_changed(app) {
        return "This session changed. Reopen Models for the harness you want to change.".into();
    }
    let Some(focus) = app.focused() else { return "No pane is focused — click a harness's pane, then open Models".into() };
    let Some(p) = app.panes.get(&focus) else { return "The focused pane is not a harness's".into() };
    if p.agent_id.is_empty() { return "The focused pane is a shell, not a harness — start one with New harness".into() }
    match app.fleet.agent(&p.machine_id, &p.agent_id) {
        None => format!("This pane's harness ({}) is not in the list yet — try again in a moment", p.agent_id.chars().take(8).collect::<String>()),
        Some(a) if a.engine == "terminal" => "The focused pane is a terminal — its model can not be switched; a harness's can".into(),
        Some(_) => NO_HARNESS.into(),
    }
}

/// Whether [engine] can be pointed at a model here: the daemon's picture says it may.
pub fn can_run(app: &App, engine: &str) -> bool { app.models_view.grids.get(&app.fleet.local_id).is_some_and(|g| g.reachable && g.can_run(engine)) }

fn up(app: &App, machine: &str) -> bool { app.fleet.machine(machine).is_some_and(Machine::usable) }

/// The own grid's listing of [m] once it serves — (section, the grid's id for it).
fn served_in(grids: Option<&Grids>, m: &LocalModel) -> Option<(String, String)> {
    grids?.sections.iter().filter(|s| s.own).find_map(|s| s.models.iter()
        .find(|x| x.offline.is_none() && (x.id.eq_ignore_ascii_case(&m.id) || x.id.eq_ignore_ascii_case(&m.name)))
        .map(|x| (s.name.clone(), x.id.clone())))
}

/// The model running on this computer besides [m]: the one a Use of [m] stops first.
fn other_running(app: &App, m: &LocalModel) -> Option<LocalModel> {
    app.models_view.local.get(&app.fleet.local_id)?.models.iter().find(|o| o.can_stop && o.id != m.id).cloned()
}

/// The harnesses answering with [m] besides [t], by name: what stopping it leaves without a model
/// until they move to another (the desktop's `_harnessesOn`).
fn harnesses_on(app: &App, m: &LocalModel, t: Option<&Target>) -> Vec<String> {
    let served = served_in(app.models_view.grids.get(&app.fleet.local_id), m).map(|(_, id)| id);
    let names = [Some(&m.name), Some(&m.id), served.as_ref()];
    let mut out: Vec<String> = app.fleet.agents.values()
        .filter(|a| !t.is_some_and(|t| t.machine == a.machine_id && t.agent == a.id))
        .filter(|a| !a.grid_model.is_empty() && names.iter().flatten().any(|n| n.eq_ignore_ascii_case(&a.grid_model)))
        .map(|a| a.name.clone()).collect();
    out.sort();
    out
}

/// What stopping [model] does to [users], the harnesses answering with it — the desktop's words.
fn stop_words(model: &str, users: &[String]) -> Option<String> {
    let first = users.first()?;
    let (who, uses, moves) = if users.len() == 1 { (first.clone(), "uses", "it moves") } else { (format!("{first} and {} more", users.len() - 1), "use", "they move") };
    Some(format!("{who} {uses} {model}, and will stop answering until {moves} to another model."))
}

/// Everything that decides a local model's row: what it says, and what Enter and ^S may do.
#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub op: Option<Operation>,
    /// The harness is being moved onto it right now.
    pub switching: bool,
    pub in_use: bool, pub active: bool, pub failed: bool,
    pub pending: Option<&'static str>,
    pub busy: bool,
    /// Use moves the harness onto it now (it serves); Use starts it first.
    pub use_running: bool, pub use_start: bool,
    /// Get downloads it; and goes on to start it and move the harness onto it.
    pub get: bool, pub get_use: bool,
    /// Another model running here — the one Use stops first: one local model runs at a time.
    pub other: Option<String>,
    pub served: Option<(String, String)>,
}

impl Facts {
    /// The word at the end of its row: what Enter does on it (Use, Get) unless something is
    /// happening to it or the harness is on it already; else its state.
    pub fn word(&self, m: &LocalModel) -> String {
        if self.switching { return SWITCHING.into() }
        if self.in_use { return "✓ In use".into() }
        if let Some(o) = self.op.as_ref().filter(|o| o.active()) { return o.word() }
        if let Some(p) = self.pending { return p.into() }
        if self.failed { return "Failed".into() }
        if self.use_running || self.use_start { return "Use".into() }
        if self.get { return "Get".into() }
        if m.running() { "Running".into() } else if m.downloaded() { "Downloaded".into() } else { String::new() }
    }
}

fn pending_word(action: &str) -> &'static str { match action { "download" => "Downloading", "start" => "Starting", _ => "Stopping" } }

pub fn facts(app: &App, m: &LocalModel, t: Option<&Target>) -> Facts {
    let v = &app.models_view;
    let machine = app.fleet.local_id.as_str();
    let op = v.op_for(machine, m).cloned();
    let active = op.as_ref().is_some_and(Operation::active);
    let busy = v.busy(machine);
    let online = up(app, machine) && v.local.contains_key(machine);
    let other = other_running(app, m).map(|o| o.name);
    let runs = t.is_some_and(|t| can_run(app, &t.engine));
    let served = served_in(v.grids.get(machine), m);
    let in_use = t.is_some_and(|t| m.running() && !t.grid_model.is_empty()
        && (served.as_ref().is_some_and(|(_, id)| id.eq_ignore_ascii_case(&t.grid_model)) || m.id.eq_ignore_ascii_case(&t.grid_model) || m.name.eq_ignore_ascii_case(&t.grid_model)));
    let get = !m.downloaded() && m.can_start && !busy && online;
    let names = |id: &str| m.id.eq_ignore_ascii_case(id) || m.name.eq_ignore_ascii_case(id) || served.as_ref().is_some_and(|(_, s)| s.eq_ignore_ascii_case(id));
    Facts {
        switching: switching_for(app, t).is_some_and(|to| !to.is_empty() && names(to)),
        failed: op.as_ref().is_some_and(Operation::failed),
        pending: v.pending.as_ref().filter(|p| p.0 == machine && p.1 == m.id).map(|p| pending_word(p.2)),
        use_running: runs && m.running() && !active && served.is_some(),
        use_start: runs && m.downloaded() && !m.running() && m.can_start && !busy && online,
        get_use: get && runs,
        op, in_use, active, busy, get, other, served,
    }
}

// ── sizes and words ──────────────────────────────────────────────────────────────

/// Bytes as a person reads a model's size: `2.7 GB` under ten, `27 GB` above.
pub fn gb(bytes: f64) -> String { let g = bytes / GIB; if g < 9.95 { format!("{g:.1} GB") } else { format!("{:.0} GB", g.round()) } }

/// A context window as people say it: `64K`, `128K` (binary sizes), `200K`, `1M`.
pub fn context_label(tokens: u64) -> String {
    if tokens >= 1_000_000 { let m = format!("{:.1}", tokens as f64 / 1e6); return format!("{}M", m.strip_suffix(".0").unwrap_or(&m)) }
    if tokens % 1024 == 0 { format!("{}K", tokens / 1024) } else { format!("{}K", (tokens as f64 / 1000.0).round() as u64) }
}

fn window_label(seconds: f64) -> String {
    let s = seconds.round() as u64;
    if s > 0 && s % 86400 == 0 { format!("{}d", s / 86400) } else if s > 0 && s % 3600 == 0 { format!("{}h", s / 3600) } else { format!("{}m", (seconds / 60.0).round() as u64) }
}

/// This computer as its owner calls it: `this Mac` on a Mac.
pub fn this_computer() -> &'static str { if cfg!(target_os = "macos") { "this Mac" } else { "this computer" } }

fn capital(s: &str) -> String { let mut c = s.chars(); c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default() }


/// `Get for this Mac · 64 GB`: the downloads, and the memory they were chosen for.
pub fn catalog_heading(snap: Option<&Snapshot>) -> String {
    let mut h = format!("Get for {}", this_computer());
    if let Some(m) = snap.and_then(|s| s.memory) { h.push_str(&format!(" · {}", gb(m))) }
    h
}

/// A row's size and speed in two columns that line up, then its word: `20 GB  ~78 tok/s  Get`.
fn columns(size: &str, speed: &str, word: &str) -> String { format!("{size:>6}  {speed:>9}  {word:>9}") }

/// A model's second column, as the desktop's: its speed — measured while it runs, else the catalog's
/// estimate for this machine (`~`) — else the app it runs in (`Ollama`).
fn speed(m: &LocalModel) -> String {
    match (m.running().then_some(m.tok_s).flatten(), m.est_tok_s) {
        (Some(s), _) => format!("{} tok/s", s.round() as u64),
        (None, Some(e)) => format!("~{} tok/s", e.round() as u64),
        _ => m.app.clone().unwrap_or_default(),
    }
}

// ── the rows ─────────────────────────────────────────────────────────────────────

/// The query without the launcher's `:`.
pub fn searched(picker: &Picker) -> &str {
    let q = picker.query.trim_start();
    if picker.prefixed { q.strip_prefix(':').unwrap_or(q) } else { q }
}

pub fn is_row(id: &str) -> bool { id.starts_with("mv:") }

fn note(key: &str, words: &str, group: &str) -> Row {
    Row::new(format!("mv:note:{key}"), words.to_string()).group(group.to_string()).lead(vec![span("  ", Style::default())]).extra("note")
}

fn local_row(app: &App, m: &LocalModel, t: Option<&Target>, group: &str) -> Row {
    let f = facts(app, m, t);
    let word = f.word(m);
    // (No round marks: `✓` in use, `↻` busy, `✗` failed, `▶` running, `·` downloaded, `↓` to get.)
    let (dot, color) = if f.in_use { ("✓ ", theme::accent()) } else if f.active || f.pending.is_some() { ("↻ ", theme::WARN) } else if f.failed { ("✗ ", theme::DANGER) }
        else if m.running() { ("▶ ", theme::ONLINE) } else if m.downloaded() { ("· ", theme::SOFT) } else { ("↓ ", theme::MUTED) };
    // As the desktop's row: the name alone, then its size and speed (or the app it runs in) in
    // columns that line up, then the word — the word alone where the list is narrow. Its
    // quantization and app are in the preview, and found by a search.
    let quant = m.quantization().unwrap_or_default();
    let app_name = m.app.clone().unwrap_or_default();
    Row::new(format!("mv:local:{}", m.id), m.name.clone()).group(group.to_string())
        .extra(format!("{} {quant} {app_name} {word} local{}", m.id, if m.recommended { " recommended" } else { "" }))
        .lead(vec![span(dot, fg(color))])
        .right(columns(&m.size.map(gb).unwrap_or_default(), &speed(m), &word))
        .right_narrow(word)
}

/// The word a grid model's row ends with: in use, Use, or why not.
fn grid_word(app: &App, x: &GridModel, t: Option<&Target>) -> String {
    match t {
        _ if switching_for(app, t).is_some_and(|to| to.eq_ignore_ascii_case(&x.id)) => SWITCHING.into(),
        Some(t) if t.grid_model.eq_ignore_ascii_case(&x.id) => "✓ In use".into(),
        _ if x.offline.is_some() => "Offline".into(),
        Some(t) if can_run(app, &t.engine) => "Use".into(),
        _ => String::new(),
    }
}

fn grid_row(app: &App, s: &Section, x: &GridModel, t: Option<&Target>, group: &str) -> Row {
    let word = grid_word(app, x, t);
    let (dot, color) = if word.starts_with('✓') { ("✓ ", theme::accent()) } else if x.offline.is_some() { ("· ", theme::MUTED) } else { ("◆ ", theme::TEAL) };
    Row::new(format!("mv:grid:{}\t{}\t{}", s.name, x.node, x.id), x.id.clone()).group(group.to_string())
        .extra(format!("{} {} {} {}", s.name, x.node, if s.own { "local" } else { "shared" }, word))
        .lead(vec![span(dot, fg(color))])
        .detail(vec![span(x.node.clone(), fg(theme::MUTED))])
        .right(word)
}

fn sub_word(app: &App, sub: &Sub, t: Option<&Target>) -> String {
    if t.is_some_and(|t| t.engine == sub.engine) && switching_for(app, t) == Some("") { return SWITCHING.into() }
    match sub_payload(app, sub, t) { Ok(_) => "Use".into(), Err(why) if why == IN_USE => "✓ In use".into(), Err(_) => String::new() }
}

/// Amber once the tightest window is nearly out (the desktop's low water).
const LOW_WATER: f64 = 20.0;


/// A subscription's row, as the desktop's: the account (`Anthropic 315df1`), then how much of it is
/// left (`20% remaining`) — the one figure worth a glance; Enter on it is the preview's to say. Its
/// mark says it is in use (✓) or running low (!).
fn sub_row(app: &App, sub: &Sub, t: Option<&Target>, group: &str, twin: bool) -> Row {
    let word = sub_word(app, sub, t);
    let low = sub.left.is_some_and(|l| l <= LOW_WATER);
    let short: String = sub.account.chars().take(6).collect();
    let label = if twin && !short.is_empty() { format!("{} · {short}", sub.title) } else { sub.title.clone() };
    let (dot, color) = if word.starts_with('✓') { ("✓ ", if low { theme::WARN } else { theme::accent() }) } else if low { ("! ", theme::WARN) } else { ("◇ ", theme::SOFT) };
    let left = sub.left.map(|l| format!("{} remaining", left_of(100.0 - l))).unwrap_or_else(|| sub.status.clone());
    Row::new(format!("mv:sub:{}\t{}", sub.engine, sub.account), label).group(group.to_string())
        .extra(format!("{} {} subscription own login {word}", sub.engine, sub.account))
        .lead(vec![span(dot, fg(color))])
        .detail(vec![span(if twin { String::new() } else { short }, fg(theme::MUTED))])
        .right(left)
}

/// The desktop picker's headings (`ModelSearchSection`), in its order.
const SUBSCRIPTIONS: &str = "Subscriptions";
const APIS: &str = "APIs";
const YOUR_MODELS: &str = "Your models";
const SHARED: &str = "Shared with you";

/// The rows of the Models view: the desktop picker's sections in its order (`model_search_catalog.dart`)
/// — Subscriptions, APIs, Your models, the downloads for this computer, Shared with you — drawn from
/// the top as the desktop's are (`settings::top_down`). [query]: what is typed (a search lists what
/// "More models" and a folded API hide).
pub fn rows(app: &App, query: &str) -> Vec<Row> {
    let searching = !query.trim().is_empty();
    let t = target(app);
    let t = t.as_ref();
    let v = &app.models_view;
    let machine = app.fleet.local_id.clone();
    let snap = v.local.get(&machine);
    let mut out = Vec::new();

    // Subscriptions: every account's, as the desktop lists them — how much of it is left and whether
    // that is running low; the harness's own login says it is in use.
    let subs = subscriptions(app);
    out.extend(subs.iter().map(|sub| sub_row(app, sub, t, SUBSCRIPTIONS, subs.iter().filter(|s| s.title == sub.title).count() > 1)));

    // APIs saved on this computer: each folds its models until Enter (or a search) opens it.
    match &v.apis {
        Some(Err(why)) if !searching => out.push(note("apis", why, APIS)),
        Some(Ok(apis)) => for api in apis {
            let listed = v.api_models.get(&api.id);
            let open = v.api_open.contains(&api.id) || searching;
            let hint = match listed { _ if !api.serves_models() => "Tools".to_string(), Some(Ok(l)) if !l.is_empty() => format!("{} model{}", l.len(), if l.len() == 1 { "" } else { "s" }), None => "Loading…".into(), _ => "Tools".into() };
            out.push(Row::new(format!("mv:api:{}", api.id), api.name.clone()).group(APIS).extra(format!("{} api", api.host()))
                .lead(vec![span(if open && api.serves_models() { "▾ " } else { "▸ " }, fg(theme::MUTED))])
                .detail(vec![span(api.host(), fg(theme::MUTED))]).right(hint));
            if !open { continue }
            if let Some(Ok(models)) = listed {
                for m in models {
                    let word = match api_payload(app, api, &m.id, t) {
                        _ if switching_for(app, t) == Some(m.id.as_str()) => SWITCHING.to_string(),
                        Ok(_) => "Use".to_string(), Err(w) if w == IN_USE => "✓ In use".into(), Err(_) => String::new(),
                    };
                    out.push(Row::new(format!("mv:apimodel:{}\t{}", api.id, m.id), m.id.clone()).group(APIS)
                        .extra(format!("{} {} api", api.name, m.name.clone().unwrap_or_default()))
                        .lead(vec![span("  ", Style::default()), span(if word.starts_with('✓') { "✓ " } else { "· " }, fg(if word.starts_with('✓') { theme::accent() } else { theme::MUTED }))])
                        .detail(vec![span(m.context.map(|w| format!("{} context", context_label(w))).unwrap_or_default(), fg(theme::MUTED))])
                        .right(format!("{word:>9}")));
                }
            }
        },
        _ => {}
    }

    // Your models: this computer's — being started, running, downloaded, in the daemon's order
    // within each — then the own grid's models the account's other machines serve.
    if let Some(t) = t.filter(|t| v.grids.contains_key(&machine) && !can_run(app, &t.engine)) {
        out.push(note("engine", &format!("{} can only run on its own login.", engine_label(&t.engine)), YOUR_MODELS));
    }
    let own = |g: &Grids| -> Vec<(Section, GridModel)> {
        g.sections.iter().filter(|s| s.own).flat_map(|s| s.models.iter().map(move |x| (s.clone(), x.clone()))).collect()
    };
    match snap {
        None => {
            out.push(note("local", if !up(app, &machine) { "Connect this computer to see its models." } else { v.local_error.get(&machine).map(String::as_str).unwrap_or("Finding models that fit…") }, YOUR_MODELS));
            // (Without this computer's list yet, the own grid's models as they come.)
            if let Some(g) = v.grids.get(&machine) { for (s, x) in own(g) { out.push(grid_row(app, &s, &x, t, YOUR_MODELS)) } }
        }
        Some(s) => {
            if let Some(n) = &s.notice { out.push(note("notice", n, YOUR_MODELS)) }
            let rank = |m: &LocalModel| if v.op_for(&machine, m).is_some_and(Operation::active) || v.pending.as_ref().is_some_and(|p| p.1 == m.id) { 0 } else if m.running() { 1 } else { 2 };
            let mut mine: Vec<(u8, usize, Row)> = s.models.iter().enumerate().filter(|(_, m)| m.downloaded() || m.can_stop)
                .map(|(i, m)| (rank(m), i, local_row(app, m, t, YOUR_MODELS))).collect();
            mine.sort_by_key(|(r, i, _)| (*r, *i));
            // (This computer's running ones are listed by their local names, above.)
            let here: Vec<&LocalModel> = s.models.iter().filter(|m| m.running()).collect();
            let theirs: Vec<Row> = v.grids.get(&machine).map(own).unwrap_or_default().into_iter()
                .filter(|(_, x)| !here.iter().any(|m| x.id.eq_ignore_ascii_case(&m.id) || x.id.eq_ignore_ascii_case(&m.name)))
                .map(|(s, x)| grid_row(app, &s, &x, t, YOUR_MODELS)).collect();
            if mine.is_empty() && theirs.is_empty() && !searching { out.push(note("none", "No models here yet — get one below", YOUR_MODELS)) }
            out.extend(mine.into_iter().map(|(_, _, r)| r));
            out.extend(theirs);
        }
    }

    // The downloads that fit this computer, under `Get for this Mac · 64 GB`: one being got first,
    // then the daemon's order (its best for a coding agent first) — five, then "More models".
    if let Some(s) = snap {
        let head = catalog_heading(snap);
        let busy = |m: &LocalModel| v.op_for(&machine, m).is_some_and(Operation::active) || v.pending.as_ref().is_some_and(|p| p.1 == m.id);
        let (now, rest): (Vec<&LocalModel>, Vec<&LocalModel>) = s.models.iter().filter(|m| !m.downloaded() && !m.can_stop).partition(|m| busy(m));
        let shown = if v.more || searching { rest.len() } else { rest.len().min(SHOWN_DOWNLOADS) };
        out.extend(now.iter().chain(rest.iter().take(shown)).map(|m| local_row(app, m, t, &head)));
        if !searching && rest.len() > SHOWN_DOWNLOADS {
            let label = if v.more { "Show fewer".to_string() } else { format!("More models ({})", rest.len() - SHOWN_DOWNLOADS) };
            out.push(Row::new("mv:more", label).group(head).extra("more models").lead(vec![span(if v.more { "− " } else { "+ " }, fg(theme::accent()))]));
        }
    }

    // Shared with you: every grid shared with this account, one section as on the desktop — each
    // row naming the machine and the grid it is on, and a resting grid saying so.
    if let Some(g) = v.grids.get(&machine) {
        for s in g.sections.iter().filter(|s| !s.own) {
            let words = section_words(s, v.asking.contains(&s.name));
            // (A grid with no model to show is not shown — "Nobody was serving here…" says nothing
            // you can use; one that is resting with models to wake keeps its "Show models".)
            let asleep_empty = s.state == "asleep" && !words.offer_wake && !v.asking.contains(&s.name);
            if s.models.is_empty() && (searching || asleep_empty || (words.subtitle.is_none() && words.sentence.is_none() && !words.offer_wake)) { continue }
            if !searching {
                if let Some(sentence) = &words.sentence { out.push(note(&format!("grid:{}", s.name), &format!("{} · {sentence}", s.name), SHARED)) }
                if words.offer_wake {
                    out.push(Row::new(format!("mv:wake:{}", s.name), format!("Show models · {}", s.name)).group(SHARED).extra(format!("{} wake", s.name))
                        .lead(vec![span("↻ ", fg(theme::accent()))]).right("usually 15–40 s"));
                }
            }
            for x in &s.models {
                let detail = [x.node.as_str(), s.name.as_str(), words.subtitle.as_deref().unwrap_or("")].into_iter().filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" · ");
                out.push(grid_row(app, s, x, t, SHARED).detail(vec![span(detail, fg(theme::MUTED))]));
            }
        }
        if !g.reachable && !searching { out.push(note("shared", "Shared models are unavailable.", SHARED)) }
    }

    out
}

/// The row the harness is on now, if the view lists it: where the cursor starts.
pub fn in_use_row(rows: &[Row]) -> Option<String> {
    rows.iter().find(|r| is_row(&r.id) && (r.right.trim_end().ends_with("✓ In use") || (r.id.starts_with("mv:sub:") && r.extra.ends_with("✓ In use")))).map(|r| r.id.clone())
}

// ── what Enter and ^S do ─────────────────────────────────────────────────────────

/// Why Use does nothing on the row the harness is already on.
const IN_USE: &str = "This harness is on it";
/// The word on a row, and on the pane, while the harness moves onto it.
pub const SWITCHING: &str = "Switching…";
const NO_HARNESS: &str = "Focus a harness to move it onto a model";

/// What a key on a row comes to — decided here, done by [run]; the tests read the plan.
#[derive(Clone, Debug, PartialEq)]
pub enum Plan {
    Nothing,
    Say(String),
    /// Something that writes and costs: said first, done on the same key again (the picker's
    /// `armed`).
    Arm(String, Box<Plan>),
    /// `agent_retarget` on [machine] with [payload] (its `agentId` in it).
    Retarget { machine: String, payload: Value, name: String },
    /// A local model got ready for the harness and the harness moved onto it.
    Use { model: String, download: bool },
    /// A download, start or stop alone (no harness to move).
    Act { model: String, action: &'static str },
    Wake(String),
    More,
    Api(String),
}

fn local_model(app: &App, id: &str) -> Option<LocalModel> { app.models_view.local.get(&app.fleet.local_id)?.models.iter().find(|m| m.id == id).cloned() }

fn sub_payload(app: &App, sub: &Sub, t: Option<&Target>) -> Result<Value, String> {
    let t = t.ok_or(NO_HARNESS)?;
    if t.engine != sub.engine { return Err(format!("Use this subscription in a {} harness.", engine_label(&sub.engine))) }
    // The harness's machine's own login for that engine, when its usage was read: the same account.
    if let Some(theirs) = app.usage.get(&t.machine).and_then(|u| u.iter().find(|u| u.provider == sub.engine)) {
        if theirs.account.clone().unwrap_or_default() != sub.account { return Err("This account is not signed in on the harness's machine.".into()) }
    }
    if t.grid_model.is_empty() { return Err(IN_USE.into()) }
    Ok(json!({ "agentId": t.agent, "clearGrid": true }))
}

/// A URL's root as the daemon compares two: no trailing slash, no `/v1`.
fn url_root(url: &str) -> &str { let u = url.trim_end_matches('/'); u.strip_suffix("/v1").unwrap_or(u) }

fn api_payload(app: &App, api: &Api, model: &str, t: Option<&Target>) -> Result<Value, String> {
    let t = t.ok_or(NO_HARNESS)?;
    if !api.serves_models() { return Err("Tools only".into()) }
    if t.machine != app.fleet.local_id { return Err("Only a harness on this computer can use its saved APIs.".into()) }
    if !can_run(app, &t.engine) { return Err(format!("{} runs only on its own login", engine_label(&t.engine))) }
    if t.grid_model == model && !t.base_url.is_empty() && url_root(&t.base_url) == url_root(&api.base_url) { return Err(IN_USE.into()) }
    Ok(json!({ "agentId": t.agent, "apiConnection": api.id, "apiModel": model }))
}

/// What Enter does on row [id].
pub fn plan_enter(app: &App, id: &str) -> Plan {
    let t = target(app);
    let t = t.as_ref();
    let v = &app.models_view;
    let say = |s: &str| Plan::Say(s.to_string());
    if id == "mv:more" { return Plan::More }
    if let Some(name) = id.strip_prefix("mv:wake:") { return if v.asking.contains(name) { say(STARTING_UP_WAIT) } else { Plan::Wake(name.to_string()) } }
    if let Some(key) = id.strip_prefix("mv:api:") { return Plan::Api(key.to_string()) }
    if let Some(rest) = id.strip_prefix("mv:apimodel:") {
        let Some((api, model)) = rest.split_once('\t') else { return Plan::Nothing };
        let Some(api) = v.apis.as_ref().and_then(|a| a.as_ref().ok()).and_then(|l| l.iter().find(|x| x.id == api)) else { return Plan::Nothing };
        return match api_payload(app, api, model, t) { Ok(payload) => Plan::Retarget { machine: app.fleet.local_id.clone(), payload, name: model.to_string() }, Err(why) => Plan::Say(why) };
    }
    if let Some(rest) = id.strip_prefix("mv:sub:") {
        let Some(sub) = subscriptions(app).into_iter().find(|s| format!("{}\t{}", s.engine, s.account) == rest) else { return Plan::Nothing };
        let machine = t.map(|t| t.machine.clone()).unwrap_or_default();
        return match sub_payload(app, &sub, t) { Ok(payload) => Plan::Retarget { machine, payload, name: format!("its {} login", sub.title) }, Err(why) => Plan::Say(why) };
    }
    if let Some(rest) = id.strip_prefix("mv:grid:") {
        let mut parts = rest.splitn(3, '\t');
        let (Some(grid), Some(_node), Some(model)) = (parts.next(), parts.next(), parts.next()) else { return Plan::Nothing };
        let offline = v.grids.get(&app.fleet.local_id).and_then(|g| g.sections.iter().find(|s| s.name == grid)).and_then(|s| s.models.iter().find(|x| x.id == model)).and_then(|x| x.offline.clone());
        let Some(t) = t else { return say(NO_HARNESS) };
        if t.grid_model.eq_ignore_ascii_case(model) { return say(IN_USE) }
        if !can_run(app, &t.engine) { return Plan::Say(format!("{} runs only on its own login", engine_label(&t.engine))) }
        let go = Plan::Retarget { machine: t.machine.clone(), payload: json!({ "agentId": t.agent, "gridModel": model, "gridName": grid }), name: model.to_string() };
        return match offline { Some(who) => Plan::Arm(format!("{who} seems offline — Enter again to switch anyway"), Box::new(go)), None => go };
    }
    let Some(model) = id.strip_prefix("mv:local:") else { return Plan::Nothing };
    let Some(m) = local_model(app, model) else { return say("This model is gone. Try again in a moment.") };
    let f = facts(app, &m, t);
    if f.in_use { return say(IN_USE) }
    if let Some(u) = v.using.as_ref().filter(|u| u.model == m.id) { return Plan::Say(using_label(app, u)) }
    if f.active || f.pending.is_some() || f.busy { return say("Wait for the current model operation to finish.") }
    if let (true, Some(t), Some((grid, served))) = (f.use_running, t, f.served.clone()) {
        return Plan::Retarget { machine: t.machine.clone(), payload: json!({ "agentId": t.agent, "gridModel": served, "gridName": grid }), name: m.name.clone() };
    }
    if m.running() {
        return match t {
            None => say("Running — ^S stops it"),
            Some(t) if !can_run(app, &t.engine) => Plan::Say(format!("{} runs only on its own login", engine_label(&t.engine))),
            Some(_) => say("Not serving yet — try again in a moment"),
        };
    }
    // One local model runs at a time: Use stops the one running here, then starts this one — asked
    // first when another harness answers with that one.
    let other = other_running(app, &m);
    let users = other.as_ref().map(|o| harnesses_on(app, o, t)).unwrap_or_default();
    let stop_said = other.as_ref().and_then(|o| stop_words(&o.name, &users));
    if m.downloaded() {
        if f.use_start {
            let go = Plan::Use { model: m.id.clone(), download: false };
            return match (&other, &stop_said) { (Some(o), Some(said)) => Plan::Arm(format!("Stop {}? {said} Enter · Esc", o.name), Box::new(go)), _ => go };
        }
        if let Some(o) = &f.other { return Plan::Say(format!("Stop {o} first: one local model runs at a time — ^S on it")) }
        return match t {
            None if m.can_start && up(app, &app.fleet.local_id) => Plan::Act { model: m.id.clone(), action: "start" },
            Some(t) if !can_run(app, &t.engine) => Plan::Say(format!("{} runs only on its own login", engine_label(&t.engine))),
            _ => say("It cannot start now. Try again in a moment."),
        };
    }
    if !f.get { return say(if !m.can_start { "This model does not fit here now." } else { "It cannot be got now. Try again in a moment." }) }
    let supports = v.local.get(&app.fleet.local_id).is_some_and(|s| s.supports_download);
    let go = if f.get_use { Plan::Use { model: m.id.clone(), download: true } } else { Plan::Act { model: m.id.clone(), action: if supports { "download" } else { "start" } } };
    // A download is gigabytes: the first Enter asks, in the preview, what the second will do.
    let size = m.size.map(gb).map(|s| format!(" ({s})")).unwrap_or_default();
    let then = match (f.get_use, &f.other) { (true, Some(o)) => format!(", stop {o}, start it, move this harness onto it"), (true, None) => ", start it, move this harness onto it".into(), _ => String::new() };
    let said = stop_said.filter(|_| f.get_use).map(|s| format!(" {s}")).unwrap_or_default();
    Plan::Arm(format!("Get {}{size}{then}?{said} Enter · Esc", m.name), Box::new(go))
}

/// What ^S does on row [id]: stop a local model (asked first).
pub fn plan_stop(app: &App, id: &str) -> Plan {
    let Some(m) = id.strip_prefix("mv:local:").and_then(|model| local_model(app, model)) else { return Plan::Nothing };
    let f = facts(app, &m, None);
    if f.busy { return Plan::Say("Wait for the current model operation to finish.".into()) }
    if !m.can_stop { return Plan::Say(if m.running() { "Other models share its engine — stop it from the desktop's Model Manager".into() } else { "It is not running".into() }) }
    Plan::Arm(format!("^S again stops {} — the download is kept", m.name), Box::new(Plan::Act { model: m.id.clone(), action: "stop" }))
}

/// Enter (or ^S, [stop]) on row [id] of the view: planned, then done.
pub fn choose(app: &mut App, picker: &mut Picker, id: &str, stop: bool) {
    if app.read_only() { picker.say("This client is read-only"); return }
    if selection_changed(app) {
        picker.say(no_target_why(app)); return;
    }
    let key = format!("{id}\u{1f}{}", if stop { "stop" } else { "enter" });
    let plan = if stop { plan_stop(app, id) } else { plan_enter(app, id) };
    run(app, picker, plan, &key);
}

fn current_identity(app: &App, identity: &crate::session_close::Identity) -> bool {
    identity.matches(app) && app.fleet.agent(&identity.machine, &identity.agent).is_some_and(|a| a.status != "stopped")
}

fn selection_changed(app: &App) -> bool {
    app.models_view.selection_fixed && app.models_view.selection.as_ref().is_some_and(|s| !current_identity(app, s))
}

fn run(app: &mut App, picker: &mut Picker, plan: Plan, key: &str) {
    if !matches!(plan, Plan::Arm(..)) { picker.armed = None; app.models_view.confirm = None }
    // (Anything but words starts another action: the last Use's end leaves its preview.)
    if !matches!(plan, Plan::Nothing | Plan::Say(_)) { app.models_view.ended = None }
    match plan {
        Plan::Nothing => {}
        // (No harness: why, from what the focused pane is.)
        Plan::Say(s) if s == NO_HARNESS => picker.say(no_target_why(app)),
        Plan::Say(s) => picker.say(s),
        Plan::Arm(words, then) => {
            app.models_view.confirm = None;
            if picker.armed.as_deref() == Some(key) { picker.armed = None; run(app, picker, *then, key) }
            // Enter on a local model asks in its preview, where it stays until answered.
            else if let Some(row) = key.strip_suffix("\u{1f}enter").filter(|id| id.starts_with("mv:local:")) { picker.armed = Some(key.to_string()); app.models_view.confirm = Some((row.to_string(), words)) }
            else { picker.armed = Some(key.to_string()); picker.say(words) }
        }
        Plan::Retarget { machine, payload, name } => {
            let who = payload["agentId"].as_str().and_then(|a| app.fleet.agent(&machine, a)).map(|a| a.name.clone()).unwrap_or_else(|| "the harness".into());
            picker.say(format!("Switching {who} to {name}…"));
            retarget(app, &machine, payload, &name, false);
        }
        // (Its steps are the preview's checklist.)
        Plan::Use { model, download } => start_use(app, &model, download),
        Plan::Act { model, action } => { picker.say(format!("{}…", pending_word(action))); act(app, &model, action) }
        Plan::Wake(name) => { wake(app, &name); picker.say(STARTING_UP_WAIT) }
        Plan::More => app.models_view.more = !app.models_view.more,
        Plan::Api(key) => {
            let v = &mut app.models_view;
            if !v.api_open.remove(&key) { v.api_open.insert(key.clone()); if !v.api_models.contains_key(&key) { read_api_models(app, &key) } }
        }
    }
}

/// What a Use is doing, for the footer: `Downloading 42%…`, `Starting…`, `Moving it…`.
pub fn using_label(app: &App, u: &Use) -> String {
    let m = local_model(app, &u.model);
    let op = m.as_ref().and_then(|m| app.models_view.op_for(&app.fleet.local_id, m));
    match (u.step, op) {
        (Step::Get, Some(o)) if o.active() && o.stage == "downloading" => format!("{}…", o.word()),
        (Step::Get, _) => format!("Getting {}…", u.name),
        (Step::Stop, _) => format!("Stopping {}…", stopping(u)),
        (Step::Start, _) => format!("Starting {}…", u.name),
        (Step::Serve, _) => format!("Waiting for {} to serve…", u.name),
        (Step::Switch, _) => format!("Moving the harness onto {}…", u.name),
    }
}

/// The model [u] stops first, by name.
fn stopping(u: &Use) -> &str { u.stops.as_ref().map(|(_, n)| n.as_str()).unwrap_or("the model running here") }

/// Esc on the view: a first Enter's question taken back (true), the view left open.
pub fn cancel(app: &mut App, picker: &mut Picker) -> bool {
    let asked = app.models_view.confirm.take().is_some();
    if asked { picker.armed = None }
    asked
}

/// The status bar's word on a Use while it runs (`#{model_progress}`): `↻ qwen3-coder 42%`, or
/// the step under way where the daemon sends no progress.
/// What the model list is waiting on now, for its title (beside a spinner): a Use's step, else a
/// harness being moved. None: nothing.
pub fn working(app: &App) -> Option<String> {
    if let Some(s) = status_text(app) { return Some(s.trim_start_matches("↻ ").to_string()) }
    app.models_view.switching.as_ref().map(|s| format!("switching to {}", s.name))
}

pub fn status_text(app: &App) -> Option<String> {
    let u = app.models_view.using.as_ref()?;
    let op = local_model(app, &u.model).and_then(|m| app.models_view.op_for(&app.fleet.local_id, &m).cloned());
    let doing = match u.step { Step::Get => "downloading".to_string(), Step::Stop => format!("waiting for {} to stop", stopping(u)), Step::Start => "starting".into(), Step::Serve => "waiting to serve".into(), Step::Switch => "switching".into() };
    Some(match progress(u.step, op.as_ref()) { Some(p) => format!("↻ {} {}%", u.name, percent(p)), None => format!("↻ {} {doing}", u.name) })
}

/// The cursor's row in the open view: a question, or a Use's end, is its row's until the cursor
/// leaves it (or the view closes).
fn follow(app: &mut App) {
    let here = match &app.modal { Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Models, picker }) => picker.current_id(), _ => None };
    let v = &mut app.models_view;
    if v.confirm.as_ref().is_some_and(|(row, _)| here.as_ref() != Some(row)) {
        v.confirm = None;
        if let Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Models, picker }) = app.modal.as_mut() { picker.armed = None }
    }
    let v = &mut app.models_view;
    if let Some(e) = v.ended.as_mut() { if here.as_ref() == Some(&e.row) { e.seen = true } else if e.seen { v.ended = None } }
}

// ── talking to the daemon ────────────────────────────────────────────────────────

/// One request of the view's to [machine]'s daemon, its reply applied on the loop. False when the
/// machine is not connected (nothing was sent).
fn rpc(app: &mut App, machine: &str, ty: &'static str, payload: Value, wait: Duration, then: impl FnOnce(&mut App, Result<Value, RpcError>) + Send + 'static) -> bool {
    // Under test no daemon is ever asked: the request is written down, and the test answers it.
    #[cfg(test)]
    {
        let _ = (wait, then);
        app.models_view.sent.push((machine.to_string(), ty.to_string(), payload));
        true
    }
    #[cfg(not(test))]
    {
        let Some(link) = app.link(machine) else { return false };
        app.spawn(async move { link.rpc(ty, payload, wait).await }, then);
        true
    }
}

fn release_read(app: &mut App, machine: &str, kind: &str) {
    match kind {
        "local" => { app.models_view.reading.remove(machine); },
        "grids" => { app.models_view.grids_reading.remove(machine); },
        "act" => { app.models_view.pending = None; },
        _ => if let Some(name) = kind.strip_prefix("wake:") { app.models_view.asking.remove(name); },
    }
}

/// Reconnecting must not leave a spinner stuck, and a previous owner cannot fill a new
/// account's model/API lists. Request tokens keep an old reply from clearing a newer read.
fn reconcile_reads(app: &mut App) {
    let owner = app.fleet.local_id.clone();
    if app.models_view.owner.as_ref().is_some_and(|old| old != &owner) {
        let switch_generation = app.models_view.switch_generation.wrapping_add(1);
        let panel_generation = app.models_view.panel_generation.wrapping_add(1);
        app.models_view = Models { switch_generation, panel_generation, ..Default::default() };
    }
    app.models_view.owner = Some(owner.clone());
    let stale: Vec<_> = app.models_view.reads.iter().filter(|((machine, _), read)| read.owner != owner || read.connection != app.connection_generation(machine))
        .map(|(key, _)| key.clone()).collect();
    for (machine, kind) in stale {
        app.models_view.reads.remove(&(machine.clone(), kind.clone()));
        release_read(app, &machine, &kind);
        if kind == "local" { app.models_view.read_at.remove(&machine); }
        if kind == "grids" { app.models_view.grids_at.remove(&machine); }
    }
}

pub(crate) fn account_changed(app: &mut App) { reconcile_reads(app); }

fn begin_read(app: &mut App, machine: &str, kind: &str) -> ReadEpoch {
    let read = ReadEpoch { owner:app.fleet.local_id.clone(), connection:app.connection_generation(machine), token:uuid::Uuid::new_v4().simple().to_string() };
    app.models_view.reads.insert((machine.into(), kind.into()), read.clone());
    read
}

fn finish_read(app: &mut App, machine: &str, kind: &str, read: &ReadEpoch) -> bool {
    let key = (machine.to_string(), kind.to_string());
    if app.models_view.reads.get(&key) != Some(read) { return false }
    app.models_view.reads.remove(&key);
    release_read(app, machine, kind);
    read.owner == app.fleet.local_id && read.connection == app.connection_generation(machine)
}

fn read_rpc(app: &mut App, machine: &str, kind: &str, ty: &'static str, payload: Value, wait: Duration,
    then: impl FnOnce(&mut App, Result<Value, RpcError>) + Send + 'static) -> bool {
    let read = begin_read(app, machine, kind);
    let (m, k, epoch) = (machine.to_string(), kind.to_string(), read.clone());
    let sent = rpc(app, machine, ty, payload, wait, move |app, reply| {
        if finish_read(app, &m, &k, &epoch) { then(app, reply); }
    });
    if !sent { finish_read(app, machine, kind, &read); }
    sent
}

/// A daemon's refusal in its own words (the sentence it put in `error`, or its detail).
fn why(e: &RpcError) -> String { if e.detail.is_empty() { e.code.clone() } else { e.detail.clone() } }

fn read_local(app: &mut App, machine: &str) {
    app.models_view.reading.insert(machine.to_string());
    let m = machine.to_string();
    if !read_rpc(app, machine, "local", "grid_fleet_models_list", json!({ "refresh": false }), Duration::from_secs(30), move |app, r| on_local(app, &m, r)) {
        app.models_view.reading.remove(machine);
        app.models_view.read_at.insert(machine.to_string(), Instant::now());
    }
}

/// A read of [machine]'s local models answered.
pub fn on_local(app: &mut App, machine: &str, reply: Result<Value, RpcError>) {
    let v = &mut app.models_view;
    v.reading.remove(machine);
    v.read_at.insert(machine.to_string(), Instant::now());
    match reply.ok().as_ref().and_then(parse_local) {
        Some(s) => {
            // The daemon's receipt supersedes this view's acknowledgement.
            if v.op.as_ref().is_some_and(|(m, o)| m == machine && (!s.busy || s.models.iter().any(|x| x.operation.as_ref().is_some_and(|y| y.id == o.id)))) { v.op = None }
            v.local_error.remove(machine);
            v.local.insert(machine.to_string(), s);
        }
        None => { v.local_error.insert(machine.to_string(), "Models are unavailable. Try again.".into()); }
    }
    advance(app);
    crate::input::refill(app);
    crate::workspace_controls::refresh_workspace(app);
}

/// The workspace menu uses owned machines' cached inventories, never API catalogs or shared
/// grids. Read only through connections already open; a count must not wake another computer.
pub fn refresh_inventory(app: &mut App) {
    reconcile_reads(app);
    let machines: Vec<_> = app.fleet.visible_machines().filter(|m| !m.shared && m.usable() && m.online()
        && !app.models_view.reading.contains(&m.id) && due(app.models_view.read_at.get(&m.id), Duration::from_secs(30), Instant::now()))
        .map(|m| m.id.clone()).collect();
    for machine in machines { read_local(app, &machine); }
}

fn read_grids(app: &mut App, machine: &str) {
    app.models_view.grids_reading.insert(machine.to_string());
    let m = machine.to_string();
    // rowState: offline rows come as `unavailable`, and this window's pushes in the same form.
    if !read_rpc(app, machine, "grids", "grid_models_list", json!({ "rowState": true }), Duration::from_secs(30), move |app, r| on_grids(app, &m, r)) {
        app.models_view.grids_reading.remove(machine);
        app.models_view.grids_at.insert(machine.to_string(), Instant::now());
    }
}

/// A read of the grids answered. One that could not reach the machine keeps what was shown.
pub fn on_grids(app: &mut App, machine: &str, reply: Result<Value, RpcError>) {
    let v = &mut app.models_view;
    v.grids_reading.remove(machine);
    v.grids_at.insert(machine.to_string(), Instant::now());
    match reply {
        Ok(r) => { v.grids.insert(machine.to_string(), parse_grids(&r)); }
        Err(_) => { v.grids.entry(machine.to_string()).or_insert_with(|| Grids { reachable: false, ..Default::default() }); }
    }
    advance(app);
    crate::input::refill(app);
}

/// `grid_models_changed`: the daemon's picture changed — the whole document, taken as it is.
pub fn on_push(app: &mut App, machine: &str, payload: &Value) {
    reconcile_reads(app);
    // The push is the daemon's complete newer picture. An earlier list/wake reply must
    // not replace it, nor keep its spinner alive after the requested state has arrived.
    let stale: Vec<_> = app.models_view.reads.keys().filter(|(m, kind)| m == machine && (kind == "grids" || kind.starts_with("wake:"))).cloned().collect();
    for (m, kind) in stale { app.models_view.reads.remove(&(m.clone(), kind.clone())); release_read(app, &m, &kind); }
    let grids = parse_grids(payload);
    if grids.waking() && app.models_view.follow_until.is_none() { app.models_view.follow_until = Some(Instant::now() + WAKE_FOR); }
    app.models_view.grids.insert(machine.to_string(), grids);
    app.models_view.grids_at.insert(machine.to_string(), Instant::now());
    advance(app);
    crate::input::refill(app);
}

/// "Show models": wake a resting section. The daemon answers at once with it `waking`; the view
/// reads again every 5 s until it is up, or a minute has passed.
pub fn wake(app: &mut App, name: &str) {
    let machine = app.fleet.local_id.clone();
    if !app.models_view.asking.insert(name.to_string()) { return }
    let (m, n) = (machine.clone(), name.to_string());
    read_rpc(app, &machine, &format!("wake:{name}"), "grid_models_list", json!({ "rowState": true, "wake": [name] }), Duration::from_secs(12), move |app, r| on_wake(app, &m, &n, r));
}

pub fn on_wake(app: &mut App, machine: &str, name: &str, reply: Result<Value, RpcError>) {
    let v = &mut app.models_view;
    v.asking.remove(name);
    if let Ok(r) = reply {
        let grids = parse_grids(&r);
        if grids.waking() { v.follow_until = Some(Instant::now() + WAKE_FOR) }
        v.grids.insert(machine.to_string(), grids);
        v.grids_at.insert(machine.to_string(), Instant::now());
    }
    crate::input::refill(app);
}

fn read_apis(app: &mut App) {
    let machine = app.fleet.local_id.clone();
    read_rpc(app, &machine, "apis", "api_connections", json!({ "action": "list" }), Duration::from_secs(20), on_apis);
}

pub fn on_apis(app: &mut App, reply: Result<Value, RpcError>) {
    let list = match reply { Ok(r) => parse_apis(&r), Err(e) => Err(if e.detail.is_empty() { "APIs are unavailable. Try again.".into() } else { e.detail.clone() }) };
    let serving: Vec<String> = list.as_ref().map(|l| l.iter().filter(|a| a.serves_models()).map(|a| a.id.clone()).collect()).unwrap_or_default();
    app.models_view.apis = Some(list);
    for id in serving { if !app.models_view.api_models.contains_key(&id) { read_api_models(app, &id) } }
    crate::input::refill(app);
}

fn read_api_models(app: &mut App, id: &str) {
    let machine = app.fleet.local_id.clone();
    let key = id.to_string();
    read_rpc(app, &machine, &format!("api:{id}"), "api_connections", json!({ "action": "models", "id": id }), Duration::from_secs(25), move |app, r| on_api_models(app, &key, r));
}

pub fn on_api_models(app: &mut App, id: &str, reply: Result<Value, RpcError>) {
    let listed = match reply {
        Ok(r) => parse_api_models(&r).ok_or_else(|| "Update Harness on this computer to use API models.".to_string()),
        Err(e) => Err(if e.detail.is_empty() { "Models are unavailable. Try again.".into() } else { e.detail.clone() }),
    };
    app.models_view.api_models.insert(id.to_string(), listed);
    crate::input::refill(app);
}

/// A download, start or stop of this computer's [model].
fn act(app: &mut App, model: &str, action: &'static str) {
    let machine = app.fleet.local_id.clone();
    app.models_view.pending = Some((machine.clone(), model.to_string(), action));
    app.models_view.use_error = None;
    let ty = match action { "download" => "grid_fleet_model_download", "start" => "grid_fleet_model_start", _ => "grid_fleet_model_stop" };
    let m = machine.clone();
    if !read_rpc(app, &machine, "act", ty, json!({ "modelId": model }), Duration::from_secs(30), move |app, r| on_act(app, &m, r)) {
        app.models_view.pending = None;
        app.say("This computer is not connected", theme::WARN);
    }
}

/// The daemon took (or refused) a download, start or stop: read again for its receipt.
pub fn on_act(app: &mut App, machine: &str, reply: Result<Value, RpcError>) {
    app.models_view.pending = None;
    match reply {
        Ok(r) => app.models_view.op = Operation::parse(&r["operation"]).map(|o| (machine.to_string(), o)),
        Err(e) => { let w = why(&e); if app.models_view.using.is_some() { fail(app, &w) } else { app.say(w, theme::WARN) } }
    }
    read_local(app, machine);
    advance(app);
    crate::input::refill(app);
}

/// Move the harness in [payload] (`agent_retarget`): its pane restarts on the model.
fn retarget(app: &mut App, machine: &str, payload: Value, name: &str, job: bool) {
    let n = name.to_string();
    let agent = payload["agentId"].as_str().unwrap_or("").to_string();
    // Where it goes: a grid's or an API's model, or (clearGrid) back to its own login.
    let to = payload["gridModel"].as_str().or_else(|| payload["apiModel"].as_str()).unwrap_or("").to_string();
    app.models_view.switch_generation = app.models_view.switch_generation.wrapping_add(1);
    let generation = app.models_view.switch_generation;
    let panel = app.models_view.panel_generation;
    let owner = app.fleet.local_id.clone();
    let connection = app.connection_generation(machine);
    let target_machine = machine.to_string();
    app.models_view.switching = Some(Switch { machine: machine.to_string(), agent, to, name: name.to_string(), since: Instant::now() });
    if !rpc(app, machine, "agent_retarget", payload, Duration::from_secs(60), move |app, r| {
        if generation == app.models_view.switch_generation && owner == app.fleet.local_id && connection == app.connection_generation(&target_machine) { on_retarget_for(app, &n, job, r, panel); }
    }) {
        app.models_view.switching = None;
        if job { fail(app, "That machine is not connected") } else { app.say("That machine is not connected", theme::WARN) }
    }
}

/// A refusal of `agent_retarget` in words a person can act on.
fn retarget_error(e: &RpcError) -> String {
    match e.code.as_str() {
        _ if !e.detail.is_empty() => e.detail.clone(),
        "UNSUPPORTED_ON_REMOTE" => "That machine cannot switch models — update Harness there.".into(),
        "OWNER_REQUIRED" => "Only this computer's owner can use its saved APIs.".into(),
        "GRID_UNAVAILABLE" => "Could not read the machine's grid. Try again.".into(),
        "MISSING_AGENT_ID" | "AGENT_NOT_FOUND" => "That harness is gone.".into(),
        code => code.to_string(),
    }
}

/// The daemon moved the harness (its pane restarts on the model — "Switching…" stays until its
/// frame says so), or said why not.
#[cfg(test)]
pub fn on_retarget(app: &mut App, name: &str, job: bool, reply: Result<Value, RpcError>) {
    let panel = app.models_view.panel_generation;
    on_retarget_for(app, name, job, reply, panel);
}

fn on_retarget_for(app: &mut App, name: &str, job: bool, reply: Result<Value, RpcError>, panel: u64) {
    let same_panel = panel == app.models_view.panel_generation;
    let used = if job { app.models_view.using.take() } else { None };
    let who = app.models_view.switching.as_ref().and_then(|s| app.fleet.agent(&s.machine, &s.agent)).map(|a| a.name.clone()).unwrap_or_else(|| "the harness".into());
    // (A Use's last step: its end, and the one toast that says it.)
    let end = |app: &mut App, failed: Option<String>| if let Some(u) = &used { app.models_view.ended = Some(Ended { row: format!("mv:local:{}", u.model), name: u.name.clone(), step: Step::Switch, failed, seen: false, stops: u.stops.as_ref().map(|(_, n)| n.clone()) }) };
    match reply {
        // Moved: the list has done its job — it closes, and the status line says so.
        Ok(_) if used.is_some() => { end(app, None); if same_panel { close(app); } app.say(format!("✓ {name} is ready · {who} is on it"), theme::ONLINE) }
        Ok(_) => { if same_panel { close(app); } app.say(format!("✓ Switching {who} to {name}…"), theme::ONLINE) }
        Err(e) => {
            let why = retarget_error(&e);
            let w = format!("Could not switch {who} to {name}: {why}");
            if let Some(s) = app.models_view.switching.take() { app.models_view.use_error = Some((format!("mv:switch:{}", s.to), w.clone())) }
            if used.is_some() { end(app, Some(format!("Could not switch {who}: {why}"))); app.say(format!("✗ {w}"), theme::DANGER) } else { app.say(w, theme::DANGER) }
        }
    }
    crate::input::refill(app);
}

/// The model list, if it is what is open: closed (a harness moved onto a model — its job done).
pub fn close(app: &mut App) {
    if matches!(app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Models, .. })) { app.modal = None }
}

// ── Use, step by step ────────────────────────────────────────────────────────────

/// What a Use does next, from what the daemon last said.
#[derive(Clone, Debug, PartialEq)]
pub enum Next { Wait, Stop, Start, Serve, Retarget { grid: String, model: String }, Fail(String) }

/// The model [job] stops first, still able to stop in [snap]: it runs here yet.
fn still_running(job: &Use, snap: Option<&Snapshot>) -> bool {
    job.stops.as_ref().is_some_and(|(id, _)| snap.is_some_and(|s| s.models.iter().any(|o| &o.id == id && o.can_stop)))
}

/// Where [job] goes from here, given this computer's models ([snap]), the operation on its model
/// ([op] — on the model it stops, while it stops one), whether a request is still out ([pending])
/// and the grids ([grids]).
pub fn next(job: &Use, snap: Option<&Snapshot>, op: Option<&Operation>, pending: bool, grids: Option<&Grids>, now: Instant) -> Next {
    if pending { return Next::Wait }
    let m = snap.and_then(|s| s.models.iter().find(|m| m.id == job.model));
    let active = op.is_some_and(Operation::active);
    let late = now.saturating_duration_since(job.since) > USE_WAIT;
    const STILL: &str = "The model is still starting. Try Enter again when it is ready.";
    match job.step {
        // A download takes as long as it takes: no deadline, its progress on the row.
        Step::Get => {
            if let Some(o) = op.filter(|o| o.failed()) { return Next::Fail(o.error.clone().unwrap_or_else(|| "Could not download this model. Try again.".into())) }
            match m {
                Some(m) if m.downloaded() && !active && !snap.is_some_and(|s| s.busy) => if m.running() { Next::Serve } else if still_running(job, snap) { Next::Stop } else { Next::Start },
                _ => Next::Wait,
            }
        }
        Step::Stop => {
            let name = job.stops.as_ref().map(|(_, n)| n.as_str()).unwrap_or("the model running here");
            if let Some(o) = op.filter(|o| o.failed()) { return Next::Fail(o.error.clone().unwrap_or_else(|| format!("Could not stop {name}. Try again."))) }
            if !still_running(job, snap) && !active && !snap.is_some_and(|s| s.busy) { return Next::Start }
            if late { Next::Fail(format!("{name} is still stopping. Try again in a moment.")) } else { Next::Wait }
        }
        Step::Start => {
            if let Some(o) = op.filter(|o| o.failed()) { return Next::Fail(o.error.clone().unwrap_or_else(|| "Could not start this model. Try again.".into())) }
            if m.is_some_and(|m| m.running()) && !active { return Next::Serve }
            if late { Next::Fail(STILL.into()) } else { Next::Wait }
        }
        Step::Serve => {
            if let Some((grid, model)) = m.and_then(|m| served_in(grids, m)) { return Next::Retarget { grid, model } }
            if late { Next::Fail(STILL.into()) } else { Next::Wait }
        }
        Step::Switch => Next::Wait,
    }
}

/// Use on [model]: download it (or start it), then carry on from each reply (see [advance]).
fn start_use(app: &mut App, model: &str, download: bool) {
    let Some(t) = target(app) else { return };
    let Some(m) = local_model(app, model) else { return };
    let supports = app.models_view.local.get(&app.fleet.local_id).is_some_and(|s| s.supports_download);
    // One local model runs at a time: the one running here stops first — after a download, so it
    // answers until this one is ready to start.
    let stops = other_running(app, &m).map(|o| (o.id, o.name));
    let step = match (&stops, download && supports) { (_, true) => Step::Get, (Some(_), false) => Step::Stop, (None, false) => if download { Step::Get } else { Step::Start } };
    let identity = app.fleet.agent(&t.machine, &t.agent).map(|a| crate::session_close::Identity::capture(app, a));
    app.models_view.using = Some(Use { model: m.id.clone(), name: m.name.clone(), machine: t.machine, agent: t.agent, step, stops: stops.clone(), since: Instant::now(), identity });
    app.models_view.ended = None;
    match (step, stops) {
        (Step::Stop, Some((other, _))) => act(app, &other, "stop"),
        _ => act(app, &m.id, if download && supports { "download" } else { "start" }),
    }
}

/// The Use stops at its step: its row's preview says why (✗) and how to try again, and one toast.
fn fail(app: &mut App, why: &str) {
    let Some(job) = app.models_view.using.take() else { return };
    let row = format!("mv:local:{}", job.model);
    app.models_view.use_error = Some((row.clone(), why.to_string()));
    app.models_view.ended = Some(Ended { row, name: job.name.clone(), step: job.step, failed: Some(why.to_string()), seen: false, stops: job.stops.as_ref().map(|(_, n)| n.clone()) });
    app.say(format!("✗ {}: {why}", job.name), theme::DANGER);
}

/// Take the Use on as far as what the daemon has said allows.
pub fn advance(app: &mut App) {
    let Some(job) = app.models_view.using.clone() else { return };
    if job.identity.as_ref().is_some_and(|i| !current_identity(app, i)) {
        fail(app, "The session or connection changed. Reopen Models before switching it."); return;
    }
    let machine = app.fleet.local_id.clone();
    let v = &app.models_view;
    let snap = v.local.get(&machine);
    // (While it stops the model running here, that model's operation is the one it waits on.)
    let watched = match (job.step, &job.stops) { (Step::Stop, Some((other, _))) => other.as_str(), _ => job.model.as_str() };
    let m = snap.and_then(|s| s.models.iter().find(|m| m.id == watched));
    let op = match m { Some(m) => v.op_for(&machine, m).cloned(), None => v.op.as_ref().filter(|(_, o)| o.model == watched).map(|(_, o)| o.clone()) };
    let pending = v.pending.as_ref().is_some_and(|p| p.1 == watched);
    let step = |app: &mut App, step: Step| if let Some(u) = app.models_view.using.as_mut() { u.step = step; u.since = Instant::now() };
    match next(&job, snap, op.as_ref(), pending, v.grids.get(&machine), Instant::now()) {
        Next::Wait => {}
        Next::Stop => { step(app, Step::Stop); if let Some((other, _)) = &job.stops { act(app, other, "stop") } }
        Next::Start => { step(app, Step::Start); act(app, &job.model, "start") }
        Next::Serve => { step(app, Step::Serve); read_grids(app, &machine) }
        Next::Retarget { grid, model } => {
            step(app, Step::Switch);
            retarget(app, &job.machine, json!({ "agentId": job.agent, "gridModel": model, "gridName": grid }), &job.name, true);
        }
        Next::Fail(why) => fail(app, &why),
    }
}

// ── opening, polling, pushes ─────────────────────────────────────────────────────

/// The view opened: read what it shows now (what was read in the last 20 s of the grids is kept).
pub fn open(app: &mut App) {
    reconcile_reads(app);
    app.models_view.selection_fixed = false;
    app.models_view.selection = target(app).and_then(|t| app.fleet.agent(&t.machine, &t.agent)).map(|a| crate::session_close::Identity::capture(app, a));
    app.models_view.selection_fixed = true;
    app.models_view.panel_generation = app.models_view.panel_generation.wrapping_add(1);
    let machine = app.fleet.local_id.clone();
    if machine.is_empty() || app.link(&machine).is_none() { return }
    if !app.models_view.reading.contains(&machine) { read_local(app, &machine) }
    if !app.models_view.grids_reading.contains(&machine) && due(app.models_view.grids_at.get(&machine), Duration::from_secs(20), Instant::now()) { read_grids(app, &machine) }
    read_apis(app);
}

/// Whether the view is still reading what it shows (its spinner turns).
pub fn loading(app: &App) -> bool { !app.models_view.reading.is_empty() || !app.models_view.grids_reading.is_empty() }

/// Every tick: read this computer's models as often as [poll_every] says, the grids as often as
/// [grids_every] says, and take a Use on (its deadlines).
pub fn tick(app: &mut App) {
    reconcile_reads(app);
    let open = matches!(&app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Models, .. }));
    if !open { app.models_view.selection_fixed = false; app.models_view.selection = None; }
    follow(app);
    app.models_view.starts.retain(|_, at| at.elapsed() < START_CAP);
    if app.models_view.switching.as_ref().is_some_and(|s| switched(app, s)) { app.models_view.switching = None }
    let machine = app.fleet.local_id.clone();
    if machine.is_empty() || app.link(&machine).is_none() { return }
    let now = Instant::now();
    let v = &app.models_view;
    let busy = v.busy(&machine) || v.using.is_some();
    let local_due = !v.reading.contains(&machine) && due(v.read_at.get(&machine), poll_every(open, busy), now);
    let serving = v.using.as_ref().is_some_and(|u| u.step == Step::Serve);
    let waking = v.follow_until.is_some_and(|t| now < t) && v.grids.get(&machine).is_some_and(Grids::waking);
    let grids_due = !v.grids_reading.contains(&machine) && grids_every(open, serving, waking).is_some_and(|e| due(v.grids_at.get(&machine), e, now));
    if !waking { app.models_view.follow_until = None }
    if local_due { read_local(app, &machine) }
    if grids_due { read_grids(app, &machine) }
    advance(app);
}

// ── the pane's note ──────────────────────────────────────────────────────────────

/// A turn event of a harness: a message sent while its model's computers rest starts the pane's
/// "Starting up…"; the model answering (or the turn ending) ends it.
pub fn watch_turn(app: &mut App, machine: &str, ty: &str, payload: &Value) {
    let answered = matches!(ty, "text_delta" | "tool_start" | "turn_ended" | "done" | "agent_deleted");
    if !answered && ty != "turn_started" { return }
    let flag = |k: &str| payload.get(k).and_then(Value::as_bool).unwrap_or(false);
    let Some(a) = app.fleet.event_agent(machine, payload) else { return };
    let (key, resting) = (a.key(), matches!(a.grid_state.as_str(), "asleep" | "waking"));
    if answered { app.models_view.starts.remove(&key); return }
    // A turn picked back up at attach, or a sub-agent's, is not a message sent now.
    if flag("replay") || flag("subagent") || !resting { return }
    app.models_view.starts.entry(key).or_insert_with(Instant::now);
}

/// What a harness's pane heading says about its model, when it will not answer now: waiting on
/// its resting computers, or the daemon's note (`grid.note`) — offline, or not served (then which
/// key picks another).
pub fn pane_note(app: &App, machine: &str, agent: &str) -> Option<String> {
    let agent = app.fleet.agent(machine, agent).map(|a| live_in_pane(app, a).id.as_str()).unwrap_or(agent);
    if let Some(s) = app.models_view.switching.as_ref().filter(|s| s.machine == machine && s.agent == agent && !switched(app, s)) {
        return Some(format!("Switching to {}…", s.name));
    }
    if let Some(at) = app.models_view.starts.get(&(machine.to_string(), agent.to_string())) {
        let e = at.elapsed();
        if e < START_STILL { return Some("Starting up…".into()) }
        if e < START_CAP { return Some("Still starting — this can take up to a minute".into()) }
    }
    let (reason, model, who) = app.fleet.agent(machine, agent)?.grid_note.clone()?;
    match reason.as_str() {
        "offline" => Some(format!("{who} seems offline — {model} won't answer until it's back")),
        "not_served" => Some(format!("{model} isn't being served right now · Pick another: {}", app.keymap.hint("choose-tree -i").unwrap_or_else(|| "Models…".into()))),
        _ => None,
    }
}

// ── the preview ──────────────────────────────────────────────────────────────────

fn kv(k: &str, v: impl Into<String>) -> Line<'static> { Line::from(vec![span(format!("{k:<9}"), Style::default().add_modifier(Modifier::DIM)), Span::raw(v.into())]) }
fn bold(t: impl Into<String>) -> Line<'static> { Line::from(span(t, Style::default().add_modifier(Modifier::BOLD))) }
fn warn(t: impl Into<String>) -> Line<'static> { Line::from(span(t, fg(theme::WARN))) }
fn dim(t: impl Into<String>) -> Line<'static> { Line::from(span(t, Style::default().add_modifier(Modifier::DIM))) }

/// A local row's first-Enter question, or its Use's checklist — Download · Start · Serve · Switch
/// harness — and how it ended: what its preview says under its status.
fn use_lines(app: &App, m: &LocalModel, id: &str) -> Vec<Line<'static>> {
    let v = &app.models_view;
    if let Some((_, words)) = v.confirm.as_ref().filter(|(row, _)| row == id) { return vec![Line::raw(""), Line::from(span(words.clone(), theme::bold(theme::accent())))] }
    let ended = v.ended.as_ref().filter(|e| e.row == id);
    let (step, op, since, stops) = match (v.using.as_ref().filter(|u| u.model == m.id), ended) {
        (Some(u), _) => (u.step, v.op_for(&app.fleet.local_id, m).cloned(), Some(u.since), u.stops.as_ref().map(|(_, n)| n.clone())),
        (None, Some(e)) => (e.step, None, None, e.stops.clone()),
        _ => return vec![],
    };
    let ended = ended.filter(|_| since.is_none());
    let mut out = vec![Line::raw("")];
    for (name, mark) in steps(stops.as_deref()).iter().zip(checklist(step, stops.is_some(), op.as_ref(), ended.map(|e| e.failed.is_none()))) {
        out.push(match mark {
            Mark::Done => Line::from(span(format!("✓ {name}"), fg(theme::ONLINE))),
            Mark::Now(Some(p)) => Line::from(span(format!("↻ {name}  {} {}%", bar(p), percent(p)), fg(theme::accent()))),
            Mark::Now(None) => Line::from(span(format!("↻ {name} · {}", elapsed(since.map(|s| s.elapsed().as_secs()).unwrap_or(0))), fg(theme::accent()))),
            Mark::Failed => Line::from(span(format!("✗ {name}"), fg(theme::DANGER))),
            Mark::Later => dim(format!("  {name}")),
        });
    }
    match ended.map(|e| (e.failed.as_ref(), &e.name)) {
        Some((None, name)) => { out.push(Line::raw("")); out.push(Line::from(span(format!("✓ Ready · this harness is on {name}"), theme::bold(theme::ONLINE)))) }
        Some((Some(why), _)) => { out.push(Line::raw("")); out.push(Line::from(span(format!("✗ Failed · {why}"), fg(theme::DANGER)))); out.push(Line::from(span("Enter tries again.", fg(theme::accent())))) }
        None => {}
    }
    out
}

/// [p] of a bar 16 cells wide.
fn bar(p: f64) -> String { let n = ((p * 16.0).round() as usize).min(16); format!("{}{}", "█".repeat(n), "░".repeat(16 - n)) }

/// A step's time so far: `12s`, `3m 05s`.
fn elapsed(secs: u64) -> String { if secs < 60 { format!("{secs}s") } else { format!("{}m {:02}s", secs / 60, secs % 60) } }

/// The preview of row [id]: what decides between models, and what Enter does.
pub fn preview(app: &App, id: &str) -> Vec<Line<'static>> {
    let t = target(app);
    let t = t.as_ref();
    let v = &app.models_view;
    let machine = app.fleet.local_id.clone();
    // Why its last Use or switch failed: by the row, or by the model the switch went to.
    let failed = |to: &str| v.use_error.as_ref().filter(|(row, _)| row == id || *row == format!("mv:switch:{to}")).map(|(_, w)| warn(w.clone()));
    if let Some(model) = id.strip_prefix("mv:local:") {
        let Some(m) = local_model(app, model) else { return vec![dim("(gone)")] };
        let snap = v.local.get(&machine);
        let f = facts(app, &m, t);
        let failed = failed(f.served.as_ref().map(|(_, s)| s.as_str()).unwrap_or(&m.id));
        let active = f.op.as_ref().is_some_and(Operation::active);
        let status = if let Some(o) = f.op.as_ref().filter(|o| o.active()) { o.word() } else if let Some(p) = f.pending { p.to_string() } else if f.failed { "Failed · try again".into() }
            else if m.running() { "Running".into() } else if m.downloaded() { "Downloaded".into() } else { "Not downloaded".into() };
        let status = if f.switching { format!("{SWITCHING} this harness is moving onto it") } else if f.in_use { format!("{status} · this harness is on it") } else { status };
        let mut out = vec![bold(m.name.clone()), Line::raw(status)];
        // (A Use's end says why it failed itself.)
        if !v.ended.as_ref().is_some_and(|e| e.row == id) { out.extend(failed) }
        out.extend(use_lines(app, &m, id));
        out.push(Line::raw(""));
        if let Some(a) = &m.app { out.push(kv("Runs in", a.clone())) }
        let here = this_computer();
        if let Some(size) = m.size {
            let free = snap.and_then(|s| s.free_disk).filter(|_| !m.downloaded()).map(|d| format!(" · {} free", gb(d))).unwrap_or_default();
            out.push(kv(if m.downloaded() { "Size" } else { "Download" }, format!("{}{free}", gb(size))));
            if let Some(mem) = snap.and_then(|s| s.memory) { out.push(kv("Memory", format!("{} · {here} has {}", if size <= mem { "fits".to_string() } else { format!("needs {}", gb(size)) }, gb(mem)))) }
        }
        match (m.running().then_some(m.tok_s).flatten(), m.est_tok_s) {
            (Some(s), _) => out.push(kv("Speed", format!("{s:.1} tok/s"))),
            (None, Some(e)) => out.push(kv("Speed", format!("~{} tok/s on {here} (estimate)", e.round() as u64))),
            _ => {}
        }
        if let Some(w) = m.context { out.push(kv("Context", format!("{} window", context_label(w as u64)))) }
        if let Some(p) = m.params_b { out.push(kv("Params", format!("{p}B"))) }
        out.push(kv("Quant", m.quantization().unwrap_or_else(|| "—".into())));
        out.push(kv("Machine", capital(here)));
        if let (true, Some(r), Some(w)) = (m.running(), m.requests, m.window_secs) { out.push(kv("Window", format!("{} req / {}", r as u64, window_label(w)))) }
        if m.resting() { out.push(kv("State", "Resting until your next message")) }
        let short = !m.downloaded() && f.pending.is_none() && !active && m.size.zip(snap.and_then(|s| s.free_disk)).is_some_and(|(s, d)| s + GIB > d);
        if short { out.push(warn(format!("Free up disk space on {here} to get it."))) }
        else if !m.downloaded() && !snap.is_some_and(|s| s.supports_download) && m.can_start && f.pending.is_none() && !active { out.push(warn(format!("Downloads and starts on {here}."))) }
        let mut said = Vec::new();
        if !f.in_use {
            if f.get_use { said.push(match &f.other { None => "Enter gets it: downloads it, starts it, and moves this harness onto it.".to_string(), Some(o) => format!("Enter gets it: downloads it, stops {o}, starts it, and moves this harness onto it.") }) }
            else if f.get { said.push(match &f.other { None => "Enter downloads it.".into(), Some(o) => format!("Enter downloads it. Stop {o} to run it: one local model runs at a time.") }) }
            else if f.use_running { said.push("Enter moves this harness onto it.".into()) }
            else if f.use_start { said.push(match &f.other { None => "Enter starts it and moves this harness onto it.".into(), Some(o) => format!("Enter stops {o}, starts this one, and moves this harness onto it.") }) }
            else if t.is_none() && m.downloaded() && !m.running() && m.can_start { said.push("Enter starts it.".into()) }
        }
        if m.can_stop { said.push("^S stops it and frees its memory. The download is kept.".into()) }
        if !said.is_empty() { out.push(Line::raw("")); out.extend(said.into_iter().map(|s| Line::from(span(s, fg(theme::accent()))))) }
        if let Some(e) = f.op.as_ref().and_then(|o| o.error.clone()) { out.push(warn(e)) }
        if let Some(e) = snap.and_then(|s| s.notice.clone()).or_else(|| v.local_error.get(&machine).cloned()) { out.push(warn(e)) }
        return out;
    }
    if let Some(rest) = id.strip_prefix("mv:grid:") {
        let mut parts = rest.splitn(3, '\t');
        let (grid, node, model) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let section = v.grids.get(&machine).and_then(|g| g.sections.iter().find(|s| s.name == grid));
        let x = section.and_then(|s| s.models.iter().find(|x| x.id == model));
        let own = section.is_some_and(|s| s.own);
        let status = match x.and_then(|x| x.offline.clone()) { Some(who) => format!("{who} seems offline — its models come back when it does"), None => "Available".into() };
        let status = match grid_word(app, x.cloned().as_ref().unwrap_or(&GridModel { id: model.to_string(), node: node.to_string(), offline: None }), t).as_str() {
            SWITCHING => format!("{SWITCHING} this harness is moving onto it"),
            "✓ In use" => format!("{status} · this harness is on it"),
            _ => status,
        };
        let mut out = vec![bold(model.to_string()), Line::raw(status)];
        out.extend(failed(model));
        out.push(Line::raw(""));
        out.push(kv("Machine", node.to_string()));
        out.push(kv("Source", if own { "On your machines".to_string() } else { format!("Shared · {grid}") }));
        let said = match plan_enter(app, id) { Plan::Retarget { .. } => "Enter moves this harness onto it.".to_string(), Plan::Arm(..) => "Enter twice moves this harness onto it anyway.".into(), Plan::Say(w) if w == NO_HARNESS => no_target_why(app), Plan::Say(w) => w, _ => String::new() };
        if !said.is_empty() { out.push(Line::raw("")); out.push(Line::from(span(said, fg(theme::accent())))) }
        return out;
    }
    if let Some(name) = id.strip_prefix("mv:wake:") {
        return vec![bold(format!("Shared · {name}")), Line::raw("Resting to save resources. It starts by itself when you send a message."), Line::raw(""),
            Line::from(span("Enter wakes it to show its models (usually 15–40 s).", fg(theme::accent())))];
    }
    if let Some(rest) = id.strip_prefix("mv:sub:") {
        let Some(sub) = subscriptions(app).into_iter().find(|s| format!("{}\t{}", s.engine, s.account) == rest) else { return vec![] };
        let low = sub.left.is_some_and(|l| l <= LOW_WATER);
        let mut out = vec![bold(if sub.account.is_empty() { sub.title.clone() } else { format!("{} · key ···{}", sub.title, sub.account) })];
        out.push(match sub.left { Some(_) if low => warn(format!("{} · Running low", sub.status)), Some(_) => Line::raw(format!("{} · Healthy", sub.status)), None => Line::raw(sub.status.clone()) });
        match sub_word(app, &sub, t).as_str() {
            SWITCHING => out.push(Line::raw(format!("{SWITCHING} this harness is going back to its own login"))),
            "✓ In use" => out.push(Line::raw("This harness is on it".to_string())),
            _ => {}
        }
        out.extend(failed(""));
        out.push(Line::raw(""));
        out.extend(sub.details.iter().take(3).map(|d| kv("Window", d.clone())));
        out.push(kv("Agent", engine_label(&sub.engine).to_string()));
        out.push(kv("Source", "Subscription"));
        let said = match sub_payload(app, &sub, t) { Ok(_) => "Enter puts this harness back on its own login.".to_string(), Err(w) => w };
        out.push(Line::raw(""));
        out.push(Line::from(span(said, fg(theme::accent()))));
        if low && sub_word(app, &sub, t).starts_with('✓') { out.push(Line::from(span("Running low: Enter on a model below moves this harness onto it.", fg(theme::WARN)))) }
        return out;
    }
    if let Some(key) = id.strip_prefix("mv:api:") {
        let Some(api) = v.apis.as_ref().and_then(|a| a.as_ref().ok()).and_then(|l| l.iter().find(|x| x.id == key)) else { return vec![] };
        let mut out = vec![bold(api.name.clone()), Line::raw(api.host()), Line::raw("")];
        match v.api_models.get(&api.id) {
            _ if !api.serves_models() => out.push(Line::raw("For harness tools: it lists no models a harness can run on.")),
            Some(Ok(l)) => out.push(kv("Models", l.len().to_string())),
            Some(Err(e)) => out.push(warn(e.clone())),
            None => out.push(dim("Reading its models…")),
        }
        if api.serves_models() { out.push(Line::raw("")); out.push(Line::from(span(if v.api_open.contains(&api.id) { "Enter folds its models." } else { "Enter shows its models." }, fg(theme::accent())))) }
        return out;
    }
    if let Some(rest) = id.strip_prefix("mv:apimodel:") {
        let Some((key, model)) = rest.split_once('\t') else { return vec![] };
        let Some(api) = v.apis.as_ref().and_then(|a| a.as_ref().ok()).and_then(|l| l.iter().find(|x| x.id == key)) else { return vec![] };
        let listed = v.api_models.get(key).and_then(|r| r.as_ref().ok()).and_then(|l| l.iter().find(|m| m.id == model)).cloned();
        let mut out = vec![bold(model.to_string()), Line::raw(api.name.clone())];
        out.extend(failed(model));
        out.push(Line::raw(""));
        if let Some(n) = listed.as_ref().and_then(|m| m.name.clone()) { out.push(kv("Name", n)) }
        if let Some(w) = listed.and_then(|m| m.context) { out.push(kv("Context", format!("{} window", context_label(w)))) }
        out.push(kv("Source", format!("API · {}", api.host())));
        let said = match api_payload(app, api, model, t) { Ok(_) => "Enter moves this harness onto it.".to_string(), Err(w) => w };
        out.push(Line::raw(""));
        out.push(Line::from(span(said, fg(theme::accent()))));
        return out;
    }
    if id == "mv:more" {
        let n = v.local.get(&machine).map(|s| s.models.iter().filter(|m| !m.downloaded()).count()).unwrap_or(0);
        return vec![bold(format!("{n} models that fit {}", this_computer())), Line::raw(""), Line::from(span(if v.more { "Enter shows the first five." } else { "Enter lists them all." }, fg(theme::accent())))];
    }
    id.strip_prefix("mv:note:").map(|_| vec![]).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::{Reach, Usage, Window};

    /// This computer, one Claude harness focused in the one pane, on its own login — its
    /// subscription at 12% left.
    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19791, sink, (150, 42));
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(Machine { shared: false, id: "local".into(), name: "studio".into(), local: true, status: "online".into(), reach: Reach::Ready });
        frame(&mut app, json!({}));
        let mut tab = crate::app::Tab::with_wid("work", 1);
        tab.root = Some(crate::layout::Node::new(1, 150, 40));
        tab.focus = Some(1);
        app.panes.insert(1, crate::pane::Pane::new(1, "local", "a1", 150, 40));
        app.tabs = vec![tab];
        app.active = 0;
        app.usage.insert("local".into(), vec![Usage { provider: "claude".into(), account: Some("7f0c".into()), windows: vec![Window { label: "5h".into(), used: 88.0, resets: None }, Window { label: "week".into(), used: 40.0, resets: None }] }]);
        app
    }

    #[test]
    fn disconnected_inventory_reads_release_loading_without_clearing_a_newer_request() {
        let mut app = app(); reconcile_reads(&mut app);
        let mut old = begin_read(&mut app, "local", "local");
        // This request belonged to a connection that has since gone away.
        old.connection = Some(7);
        app.models_view.reads.insert(("local".into(), "local".into()), old.clone());
        app.models_view.reading.insert("local".into());
        app.models_view.read_at.insert("local".into(), Instant::now());
        reconcile_reads(&mut app);
        assert!(!loading(&app)); assert!(!app.models_view.read_at.contains_key("local"));
        app.models_view.reading.insert("local".into());
        let new = begin_read(&mut app, "local", "local");
        assert!(!finish_read(&mut app, "local", "local", &old));
        assert!(loading(&app), "the old completion cannot clear the replacement read");
        assert!(finish_read(&mut app, "local", "local", &new));
        assert!(!loading(&app));
    }

    #[test]
    fn switching_owner_drops_model_and_api_caches_and_rejects_old_replies() {
        let mut app = app(); reconcile_reads(&mut app);
        let old = begin_read(&mut app, "local", "apis");
        app.models_view.apis = Some(Ok(vec![]));
        app.models_view.grids.insert("local".into(), Grids::default());
        app.models_view.switch_generation = 5;
        app.fleet.local_id = "another-owner".into();
        reconcile_reads(&mut app);
        assert!(app.models_view.apis.is_none() && app.models_view.grids.is_empty());
        assert_eq!(app.models_view.switch_generation, 6);
        assert!(!finish_read(&mut app, "local", "apis", &old));
        app.fleet.local_id = "local".into(); reconcile_reads(&mut app);
        let new = begin_read(&mut app, "local", "apis");
        assert!(!finish_read(&mut app, "local", "apis", &old), "even after returning to the original owner");
        assert!(finish_read(&mut app, "local", "apis", &new));
        assert_eq!(app.models_view.switch_generation, 7);
    }

    /// The harness's frame, its `grid` as given (`{}`: on its own login).
    fn frame(app: &mut App, grid: Value) {
        let key = ("local".to_string(), "a1".to_string());
        let row = json!({ "id": "a1", "name": "fix-login", "engine": "claude", "selectedModel": "opus", "grid": grid });
        let a = crate::fleet::agent_from("local", &row, app.fleet.agents.get(&key));
        app.fleet.agents.insert(key, a);
    }

    /// Your models, as the desktop's: this computer's — running, then downloaded — then the own
    /// grid's models the account's other machines serve, in the grid's order.
    #[test]
    fn your_models_are_this_computer_s_then_the_own_grid_s() {
        let mut app = app();
        on_local(&mut app, "local", Ok(local_reply(qwen("running", Value::Null), false)));
        let mut g = grids_reply(&["box-model"]);
        g["grids"][0]["models"].as_array_mut().unwrap().push(json!({ "id": "away-model", "node": "lap", "unavailable": { "reason": "offline", "machine": "lap" } }));
        on_grids(&mut app, "local", Ok(g));
        let mine: Vec<String> = super::rows(&app, "").into_iter().filter(|r| r.group.as_deref() == Some("Your models") && is_row(&r.id)).map(|r| r.id).collect();
        assert_eq!(mine, vec!["mv:local:qwen-35b".to_string(), "mv:local:gemma-12b".into(), "mv:grid:own-grid\tstudio\tbox-model".into(), "mv:grid:own-grid\tlap\taway-model".into()]);
    }

    /// Which harness Enter moves: the focused pane's. A focused terminal is the one meant — never
    /// the harness beside it — and the panel says why there is none; with nothing focused, the one
    /// harness on screen.
    #[test]
    fn the_focused_pane_is_the_harness_meant_and_why_none_is_said() {
        let mut app = app();
        assert_eq!(target(&app).map(|t| t.agent).as_deref(), Some("a1"));
        let key = ("local".to_string(), "t1".to_string());
        let a = crate::fleet::agent_from("local", &json!({ "id": "t1", "name": "shell", "engine": "terminal" }), None);
        app.fleet.agents.insert(key, a);
        app.panes.insert(2, crate::pane::Pane::new(2, "local", "t1", 75, 40));
        app.rects = vec![(1, ratatui::layout::Rect::new(0, 0, 75, 40)), (2, ratatui::layout::Rect::new(75, 0, 75, 40))];
        app.tabs[0].focus = Some(2);
        assert!(target(&app).is_none(), "not the claude harness beside it");
        assert!(no_target_why(&app).contains("terminal"), "{}", no_target_why(&app));
        app.tabs[0].focus = None;
        assert_eq!(target(&app).map(|t| t.agent).as_deref(), Some("a1"), "nothing focused: the one harness on screen");
        assert!(no_target_why(&app).contains("No pane is focused"));
        app.panes.insert(3, crate::pane::Pane::new(3, "local", "zz9abc", 75, 40));
        app.tabs[0].focus = Some(3);
        assert!(no_target_why(&app).contains("zz9abc"), "{}", no_target_why(&app));
    }

    fn model(id: &str, state: &str, gib: f64) -> Value {
        json!({ "id": id, "name": id, "state": state, "sizeBytes": gib * GIB, "canStart": state != "running", "canStop": state == "running", "estTokS": 40 })
    }

    /// The daemon's `grid_fleet_models_list`: a 20 GB catalog pick, a downloaded model, and six
    /// more downloads (the catalog is longer than five).
    fn local_reply(qwen: Value, busy: bool) -> Value {
        let mut models = vec![qwen, model("gemma-12b", "downloaded", 7.5)];
        models.extend((1..=6).map(|i| model(&format!("extra-{i}"), "available", 4.0)));
        json!({ "models": models, "memoryBytes": 64.0 * GIB, "freeDiskBytes": 120.0 * GIB, "busy": busy, "supportsDownload": true, "observedAt": "2026-09-30T00:00:00.000Z" })
    }

    fn qwen(state: &str, operation: Value) -> Value {
        json!({ "id": "qwen-35b", "name": "Qwen3.6-35B-A3B", "state": state, "sizeBytes": 20.0 * GIB, "quant": "Q4_K_M", "canStart": state != "running", "canStop": state == "running",
            "contextWindow": 131072, "estTokS": 78.2, "paramsB": 35, "operation": operation })
    }

    fn op(action: &str, stage: &str, phase: &str, progress: Option<f64>) -> Value {
        json!({ "id": format!("op-{action}"), "modelId": "qwen-35b", "action": action, "stage": stage, "phase": phase, "progress": progress, "updatedAt": "2026-09-30T00:00:00.000Z" })
    }

    /// `grid_models_list`: the own grid serving [served], a shared grid with one row offline, and
    /// a shared grid asleep with no record.
    fn grids_reply(served: &[&str]) -> Value {
        let own: Vec<Value> = served.iter().map(|id| json!({ "id": id, "node": "studio" })).collect();
        json!({ "gridName": "own-grid", "localModelEngines": ["claude", "codex"], "supportsModelLaunch": true, "grids": [
            { "name": "own-grid", "own": true, "state": "awake", "models": own },
            { "name": "team", "own": false, "state": "awake", "models": [{ "id": "llama-70b", "node": "gpu-box" }, { "id": "mistral", "node": "lap", "unavailable": { "reason": "offline", "machine": "lap" } }] },
            { "name": "night", "own": false, "state": "asleep", "models": [] },
        ] })
    }

    fn loaded() -> App {
        let mut app = app();
        on_local(&mut app, "local", Ok(local_reply(qwen("available", Value::Null), false)));
        on_grids(&mut app, "local", Ok(grids_reply(&[])));
        app
    }

    #[test]
    fn an_open_picker_keeps_its_original_harness_after_focus_moves() {
        let mut app = loaded();
        open(&mut app);
        let second = crate::fleet::agent_from("local", &json!({"id":"a2", "engine":"codex", "name":"other"}), None);
        app.fleet.agents.insert(second.key(), second);
        app.panes.insert(2, crate::pane::Pane::new(2, "local", "a2", 75, 40));
        app.tabs[0].focus = Some(2);
        assert_eq!(target(&app).unwrap().agent, "a1");
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:grid:team\tgpu-box\tllama-70b", false);
        assert_eq!(last_sent(&app).2["agentId"], "a1");
        assert_eq!(app.focused(), Some(2), "selecting a model does not move keyboard focus");
    }

    #[test]
    fn a_replaced_stopped_or_shared_session_cannot_be_switched_from_a_stale_picker() {
        for change in ["session", "stopped", "shared", "owner", "missing"] {
            let mut app = loaded();
            open(&mut app);
            let key = ("local".into(), "a1".into());
            match change {
                "session" => app.fleet.agents.get_mut(&key).unwrap().session_id = "new-session".into(),
                "stopped" => app.fleet.agents.get_mut(&key).unwrap().status = "stopped".into(),
                "shared" => app.fleet.machines[0].shared = true,
                "owner" => app.fleet.local_id = "new-owner".into(),
                _ => { app.fleet.agents.remove(&key); }
            }
            assert!(target(&app).is_none(), "{change}");
            let before = app.models_view.sent.len();
            let mut picker = Picker::new("models", "");
            choose(&mut app, &mut picker, "mv:grid:team\tgpu-box\tllama-70b", false);
            choose(&mut app, &mut picker, "mv:local:qwen-35b", false);
            assert_eq!(app.models_view.sent.len(), before, "{change}: no fallback download or switch");
            assert!(flash(&picker).contains("session changed"), "{change}");
        }
    }

    #[test]
    fn an_ongoing_download_does_not_switch_a_replacement_session() {
        let mut app = loaded();
        open(&mut app);
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:local:qwen-35b", false);
        choose(&mut app, &mut picker, "mv:local:qwen-35b", false);
        assert_eq!(last_sent(&app).1, "grid_fleet_model_download");
        app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().session_id = "replacement".into();
        on_local(&mut app, "local", Ok(local_reply(qwen("downloaded", Value::Null), false)));
        assert!(app.models_view.using.is_none());
        assert!(!app.models_view.sent.iter().any(|(_, kind, _)| kind == "agent_retarget" || kind == "grid_fleet_model_start"));
        assert!(toast(&app).contains("session or connection changed"));
    }

    #[test]
    fn a_late_switch_receipt_keeps_a_new_picker_open() {
        let mut app = loaded();
        open(&mut app);
        let old_panel = app.models_view.panel_generation;
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:grid:team\tgpu-box\tllama-70b", false);
        open(&mut app);
        app.modal = Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Models, picker });
        on_retarget_for(&mut app, "llama-70b", false, Ok(json!({"retargeted":true})), old_panel);
        assert!(matches!(app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Models, .. })));
    }

    fn row<'a>(rows: &'a [Row], id: &str) -> &'a Row { rows.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("no row {id}: {:?}", rows.iter().map(|r| &r.id).collect::<Vec<_>>())) }
    fn last_sent(app: &App) -> (String, String, Value) { app.models_view.sent.last().cloned().expect("nothing sent") }
    fn toast(app: &App) -> String { app.toast.as_ref().map(|t| t.0.clone()).unwrap_or_default() }
    fn flash(p: &Picker) -> String { p.flash.as_ref().map(|f| f.0.clone()).unwrap_or_default() }
    fn text(lines: &[Line]) -> String { lines.iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>()).collect::<Vec<_>>().join("\n") }

    /// The owner's flow, end to end on fake replies: the subscription runs low, so the focused
    /// harness is moved onto a local model that is not downloaded yet — Get (asked twice) →
    /// download → start → wait until the grid lists it → `agent_retarget {agentId, gridModel,
    /// gridName}` → "Switching…" until its frame says it is there → back to the subscription with
    /// `clearGrid`.
    #[test]
    fn the_focused_harness_moves_onto_a_local_model_and_back() {
        let mut app = loaded();
        let rows = rows(&app, "");
        // The subscriptions first, as on the desktop: the harness's own login, how much is left, its
        // mark saying it is in use (amber: running low).
        assert_eq!(rows[0].group.as_deref(), Some("Subscriptions"));
        assert_eq!((rows[0].label.as_str(), rows[0].right.as_str()), ("Anthropic", "12% remaining"));
        assert_eq!(rows[0].lead[0].content, "✓ ");
        assert_eq!(in_use_row(&rows).as_deref(), Some("mv:sub:claude\t7f0c"));
        assert!(row(&rows, "mv:local:qwen-35b").right.ends_with("Get"));

        // Get: the first Enter only asks, in the preview, what the second will do.
        let mut picker = Picker::new("models", "");
        let qwen_preview = |app: &App| text(&preview(app, "mv:local:qwen-35b"));
        choose(&mut app, &mut picker, "mv:local:qwen-35b", false);
        assert!(app.models_view.sent.is_empty(), "nothing downloads on the first Enter");
        assert!(flash(&picker).is_empty(), "no fading flash: {}", flash(&picker));
        assert!(qwen_preview(&app).contains("Get Qwen3.6-35B-A3B (20 GB), start it, move this harness onto it? Enter · Esc"), "{}", qwen_preview(&app));
        choose(&mut app, &mut picker, "mv:local:qwen-35b", false);
        assert_eq!(last_sent(&app), ("local".into(), "grid_fleet_model_download".into(), json!({ "modelId": "qwen-35b" })));
        assert_eq!(app.models_view.using.as_ref().map(|u| u.step), Some(Step::Get));
        assert!(!qwen_preview(&app).contains("Enter · Esc"), "{}", qwen_preview(&app));

        // The daemon takes it; its progress is the row's word, the checklist's bar and the status bar's.
        on_act(&mut app, "local", Ok(json!({ "operation": op("download", "downloading", "running", Some(0.1)) })));
        assert_eq!(last_sent(&app).1, "grid_fleet_models_list");
        on_local(&mut app, "local", Ok(local_reply(qwen("available", op("download", "downloading", "running", Some(0.42))), true)));
        assert!(row(&rows_of(&app), "mv:local:qwen-35b").right.ends_with("Downloading 42%"));
        assert_eq!(app.models_view.using.as_ref().map(|u| u.step), Some(Step::Get), "a download has no deadline");
        let p = qwen_preview(&app);
        assert!(p.contains("↻ Download") && p.contains("█") && p.contains("42%") && p.contains("\n  Start\n  Serve\n  Switch harness"), "{p}");
        assert_eq!(status_text(&app).as_deref(), Some("↻ Qwen3.6-35B-A3B 42%"));
        assert_eq!(crate::format::expand(&app, "#{?model_progress,#{model_progress},none}", app.active, app.focused(), false), "↻ Qwen3.6-35B-A3B 42%");

        // Downloaded: it is started.
        on_local(&mut app, "local", Ok(local_reply(qwen("downloaded", op("download", "downloading", "done", None)), false)));
        assert_eq!(last_sent(&app), ("local".into(), "grid_fleet_model_start".into(), json!({ "modelId": "qwen-35b" })));
        assert_eq!(app.models_view.using.as_ref().map(|u| u.step), Some(Step::Start));
        let p = qwen_preview(&app);
        assert!(p.contains("✓ Download") && p.contains("↻ Start · 0s") && !p.contains("█"), "{p}");
        assert_eq!(status_text(&app).as_deref(), Some("↻ Qwen3.6-35B-A3B starting"));
        on_act(&mut app, "local", Ok(json!({ "operation": op("start", "starting", "running", None) })));
        on_local(&mut app, "local", Ok(local_reply(qwen("downloaded", op("start", "starting", "running", None)), true)));
        assert_eq!(app.models_view.using.as_ref().map(|u| u.step), Some(Step::Start), "still starting");

        // Running: the grid is asked whether it serves it — not yet, then yes.
        on_local(&mut app, "local", Ok(local_reply(qwen("running", op("start", "verifying", "done", None)), false)));
        assert_eq!(last_sent(&app), ("local".into(), "grid_models_list".into(), json!({ "rowState": true })));
        on_grids(&mut app, "local", Ok(grids_reply(&[])));
        assert_eq!(app.models_view.using.as_ref().map(|u| u.step), Some(Step::Serve));
        on_grids(&mut app, "local", Ok(grids_reply(&["qwen-35b"])));
        assert_eq!(last_sent(&app), ("local".into(), "agent_retarget".into(), json!({ "agentId": "a1", "gridModel": "qwen-35b", "gridName": "own-grid" })));

        // Switching… on the row and on the pane, until the harness's frame says it is there.
        assert!(row(&rows_of(&app), "mv:local:qwen-35b").right.ends_with(SWITCHING));
        assert_eq!(pane_note(&app, "local", "a1").as_deref(), Some("Switching to Qwen3.6-35B-A3B…"));
        on_retarget(&mut app, "Qwen3.6-35B-A3B", true, Ok(json!({ "retargeted": true })));
        assert!(app.models_view.using.is_none());
        assert_eq!(toast(&app), "✓ Qwen3.6-35B-A3B is ready · fix-login is on it");
        let p = qwen_preview(&app);
        assert!(p.contains("✓ Switch harness") && p.contains("✓ Ready · this harness is on Qwen3.6-35B-A3B"), "{p}");
        assert!(status_text(&app).is_none(), "nothing runs");
        frame(&mut app, json!({ "model": "qwen-35b", "state": "awake" }));
        let rows = rows_of(&app);
        assert!(row(&rows, "mv:local:qwen-35b").right.ends_with("✓ In use"));
        assert!(pane_note(&app, "local", "a1").is_none());
        // (A subscription's row says how much is left; what Enter does is its preview's, and its mark's.)
        assert!(rows[0].extra.ends_with("Use") && rows[0].lead[0].content != "✓ ", "its own login is a Use away: {}", rows[0].extra);

        // And back to the subscription.
        let before = app.models_view.sent.len();
        choose(&mut app, &mut picker, "mv:sub:claude\t7f0c", false);
        assert_eq!(app.models_view.sent.len(), before + 1);
        assert_eq!(last_sent(&app), ("local".into(), "agent_retarget".into(), json!({ "agentId": "a1", "clearGrid": true })));
        assert!(rows_of(&app)[0].extra.ends_with(SWITCHING));
        frame(&mut app, json!({}));
        assert!(rows_of(&app)[0].extra.ends_with("✓ In use") && rows_of(&app)[0].lead[0].content == "✓ ");
    }

    fn rows_of(app: &App) -> Vec<Row> { rows(app, "") }

    /// A switch the daemon refuses says why — on the status line and in the row's preview — and
    /// the row is no longer "Switching…".
    #[test]
    fn a_refused_switch_says_why() {
        let mut app = loaded();
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:grid:team\tgpu-box\tllama-70b", false);
        assert_eq!(last_sent(&app), ("local".into(), "agent_retarget".into(), json!({ "agentId": "a1", "gridModel": "llama-70b", "gridName": "team" })));
        assert!(row(&rows_of(&app), "mv:grid:team\tgpu-box\tllama-70b").right.ends_with(SWITCHING));
        on_retarget(&mut app, "llama-70b", false, Err(RpcError::new("GRID_UNAVAILABLE", "Could not read this machine's grid endpoint.")));
        assert_eq!(toast(&app), "Could not switch fix-login to llama-70b: Could not read this machine's grid endpoint.");
        assert!(row(&rows_of(&app), "mv:grid:team\tgpu-box\tllama-70b").right.ends_with("Use"));
        assert!(text(&preview(&app, "mv:grid:team\tgpu-box\tllama-70b")).contains("Could not switch fix-login"));
        assert_eq!(retarget_error(&RpcError::new("UNSUPPORTED_ON_REMOTE", "")), "That machine cannot switch models — update Harness there.");
    }

    /// A Use that fails on the way — a refused start, a failed download, a model that never
    /// serves — stops, says why, and the preview keeps it.
    #[test]
    fn a_use_that_fails_says_why() {
        let mut app = loaded();
        let mut picker = Picker::new("models", "");
        // The downloaded model: Use starts it (no second Enter: nothing to download).
        choose(&mut app, &mut picker, "mv:local:gemma-12b", false);
        assert_eq!(last_sent(&app), ("local".into(), "grid_fleet_model_start".into(), json!({ "modelId": "gemma-12b" })));
        on_act(&mut app, "local", Err(RpcError::new("Stop a running model to make room, then try again.", "")));
        assert!(app.models_view.using.is_none());
        assert_eq!(toast(&app), "✗ gemma-12b: Stop a running model to make room, then try again.");
        assert!(text(&preview(&app, "mv:local:gemma-12b")).contains("✗ Failed · Stop a running model to make room"));

        // A download the daemon reports failed.
        let job = Use { identity: None, model: "qwen-35b".into(), name: "Qwen".into(), machine: "local".into(), agent: "a1".into(), step: Step::Get, since: Instant::now(), stops: None };
        let failed = Operation::parse(&op("download", "downloading", "failed", None)).map(|mut o| { o.error = Some("The download stopped. Start again to resume.".into()); o });
        assert_eq!(next(&job, None, failed.as_ref(), false, None, Instant::now()), Next::Fail("The download stopped. Start again to resume.".into()));
        // Started, but never listed as served: after three minutes it says so.
        let snap = parse_local(&local_reply(qwen("running", Value::Null), false)).unwrap();
        let late = Instant::now() + USE_WAIT + Duration::from_secs(1);
        let serving = Use { step: Step::Serve, ..job.clone() };
        assert_eq!(next(&serving, Some(&snap), None, false, Some(&parse_grids(&grids_reply(&[]))), Instant::now()), Next::Wait);
        assert!(matches!(next(&serving, Some(&snap), None, false, Some(&parse_grids(&grids_reply(&[]))), late), Next::Fail(w) if w.contains("still starting")));
        // A request still out: nothing moves.
        assert_eq!(next(&serving, Some(&snap), None, true, Some(&parse_grids(&grids_reply(&["qwen-35b"]))), Instant::now()), Next::Wait);
        assert_eq!(next(&serving, Some(&snap), None, false, Some(&parse_grids(&grids_reply(&["QWEN-35B"]))), Instant::now()), Next::Retarget { grid: "own-grid".into(), model: "QWEN-35B".into() });
    }

    /// A Use's steps, from where it is and the operation on its model: done, the one under way
    /// (with its progress only while the daemon sends one), failed, or still to come — and a stop
    /// of the model running here among them only when it makes one.
    #[test]
    fn the_steps_follow_the_use_and_its_operation() {
        use Mark::*;
        let o = |action: &str, stage: &str, phase: &str, p: Option<f64>| Operation::parse(&op(action, stage, phase, p));
        assert_eq!(checklist(Step::Get, false, o("download", "downloading", "running", Some(0.42)).as_ref(), None), [Now(Some(0.42)), Later, Later, Later]);
        assert_eq!(checklist(Step::Get, false, None, None), [Now(None), Later, Later, Later]);
        assert_eq!(checklist(Step::Get, false, o("download", "downloading", "done", Some(1.0)).as_ref(), None), [Now(None), Later, Later, Later], "a finished operation is no bar");
        assert_eq!(checklist(Step::Start, false, o("start", "starting", "running", None).as_ref(), None), [Done, Now(None), Later, Later]);
        assert_eq!(checklist(Step::Serve, false, None, None), [Done, Done, Now(None), Later]);
        assert_eq!(checklist(Step::Switch, false, None, None), [Done, Done, Done, Now(None)]);
        assert_eq!(checklist(Step::Switch, false, None, Some(true)), [Done, Done, Done, Done]);
        assert_eq!(checklist(Step::Start, false, o("start", "starting", "failed", None).as_ref(), Some(false)), [Done, Failed, Later, Later]);
        assert_eq!(checklist(Step::Get, false, None, Some(false)), [Failed, Later, Later, Later]);
        assert_eq!(steps(None), ["Download", "Start", "Serve", "Switch harness"]);
        assert_eq!(steps(Some("Phi")), ["Download", "Stop Phi", "Start", "Serve", "Switch harness"]);
        assert_eq!(checklist(Step::Stop, true, None, None), [Done, Now(None), Later, Later, Later]);
        assert_eq!(checklist(Step::Start, true, None, None), [Done, Done, Now(None), Later, Later]);
        assert_eq!(checklist(Step::Stop, true, None, Some(false)), [Done, Failed, Later, Later, Later]);
    }

    /// How a Use ended stays in its row's preview — past the 3 s a flash lasts — until the cursor
    /// leaves the row; Esc takes back a confirm without closing the view.
    #[test]
    fn the_end_state_stays_until_the_cursor_leaves_the_row() {
        let mut app = loaded();
        let mut picker = Picker::new("models", "");
        picker.set_rows(rows(&app, ""));
        choose(&mut app, &mut picker, "mv:local:gemma-12b", false);
        on_act(&mut app, "local", Err(RpcError::new("Stop a running model to make room, then try again.", "")));
        picker.select("mv:local:gemma-12b");
        picker.flash = Some(("old".into(), Instant::now() - Duration::from_secs(10)));
        app.modal = Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Models, picker });
        let gemma = |app: &App| text(&preview(app, "mv:local:gemma-12b"));
        for _ in 0..3 { tick(&mut app) }
        assert!(gemma(&app).contains("✗ Failed · Stop a running model") && gemma(&app).contains("Enter tries again."), "{}", gemma(&app));
        let Some(crate::modal::Modal::Picker { picker, .. }) = app.modal.as_mut() else { panic!() };
        picker.select("mv:local:qwen-35b");
        tick(&mut app);
        assert!(!gemma(&app).contains("✗ Failed"), "{}", gemma(&app));

        // A confirm: Esc takes it back, and the next Enter asks again.
        let Some(crate::modal::Modal::Picker { mut picker, .. }) = app.modal.take() else { panic!() };
        choose(&mut app, &mut picker, "mv:local:qwen-35b", false);
        assert!(text(&preview(&app, "mv:local:qwen-35b")).contains("? Enter · Esc"));
        assert!(cancel(&mut app, &mut picker));
        assert!(!text(&preview(&app, "mv:local:qwen-35b")).contains("? Enter · Esc"));
        assert!(!cancel(&mut app, &mut picker), "nothing left to take back: Esc closes");
        choose(&mut app, &mut picker, "mv:local:qwen-35b", false);
        assert!(app.models_view.sent.iter().all(|s| s.1 != "grid_fleet_model_download"), "asked again, not started");
        // Moving off the row takes the confirm back too.
        picker.select("mv:local:gemma-12b");
        app.modal = Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Models, picker });
        tick(&mut app);
        assert!(!text(&preview(&app, "mv:local:qwen-35b")).contains("? Enter · Esc"));
        let Some(crate::modal::Modal::Picker { picker, .. }) = &app.modal else { panic!() };
        assert!(picker.armed.is_none());
    }

    /// The daemon's list with Phi running here (the one model that runs at a time), [gemma] and
    /// [qwen] as given.
    fn with_phi(gemma: Value, qwen: Value, phi: Value) -> Value {
        let mut reply = local_reply(qwen, false);
        reply["models"][1] = gemma;
        reply["models"].as_array_mut().unwrap().push(phi);
        reply
    }

    fn phi(state: &str, operation: Value) -> Value {
        json!({ "id": "phi", "name": "Phi", "state": state, "sizeBytes": 3.0 * GIB, "canStart": state != "running", "canStop": state == "running", "tokensPerSecond": 91.3, "operation": operation })
    }

    fn gemma(state: &str, operation: Value) -> Value {
        json!({ "id": "gemma-12b", "name": "gemma-12b", "state": state, "sizeBytes": 7.5 * GIB, "canStart": state != "running", "canStop": state == "running", "operation": operation })
    }

    fn op_on(model: &str, action: &str, stage: &str, phase: &str) -> Value {
        json!({ "id": format!("op-{action}-{model}"), "modelId": model, "action": action, "stage": stage, "phase": phase, "updatedAt": "2026-09-30T00:00:00.000Z" })
    }

    /// One local model runs at a time: with another running, Use stops it first and Get goes on to
    /// stop it once downloaded — Enter says so. While an operation runs, nothing else starts.
    #[test]
    fn one_local_model_runs_at_a_time() {
        let mut app = app();
        on_local(&mut app, "local", Ok(with_phi(gemma("downloaded", Value::Null), qwen("available", Value::Null), phi("running", Value::Null))));
        on_grids(&mut app, "local", Ok(grids_reply(&["phi"])));
        // Nobody else is on Phi: no question, Use goes.
        assert_eq!(plan_enter(&app, "mv:local:gemma-12b"), Plan::Use { model: "gemma-12b".into(), download: false });
        assert!(text(&preview(&app, "mv:local:gemma-12b")).contains("Enter stops Phi, starts this one, and moves this harness onto it."), "{}", text(&preview(&app, "mv:local:gemma-12b")));
        match plan_enter(&app, "mv:local:qwen-35b") {
            Plan::Arm(words, then) => {
                assert_eq!(words, "Get Qwen3.6-35B-A3B (20 GB), stop Phi, start it, move this harness onto it? Enter · Esc");
                assert_eq!(*then, Plan::Use { model: "qwen-35b".into(), download: true });
            }
            p => panic!("{p:?}"),
        }
        assert!(text(&preview(&app, "mv:local:qwen-35b")).contains("Enter gets it: downloads it, stops Phi, starts it, and moves this harness onto it."));
        let rows = rows_of(&app);
        assert!(row(&rows, "mv:local:phi").right.contains("91 tok/s") && row(&rows, "mv:local:phi").right.ends_with("Use"), "measured speed, and it serves: Use");
        assert!(row(&rows, "mv:local:qwen-35b").right.contains("~78 tok/s"), "an estimate before it runs");
        // ^S stops, asked first.
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:local:phi", true);
        assert!(app.models_view.sent.iter().all(|s| s.1 != "grid_fleet_model_stop"));
        assert!(flash(&picker).starts_with("^S again stops Phi"));
        choose(&mut app, &mut picker, "mv:local:phi", true);
        assert_eq!(last_sent(&app), ("local".into(), "grid_fleet_model_stop".into(), json!({ "modelId": "phi" })));
        // While it stops, the daemon is busy: nothing else starts.
        assert_eq!(plan_enter(&app, "mv:local:qwen-35b"), Plan::Say("Wait for the current model operation to finish.".into()));
        assert!(row(&rows_of(&app), "mv:local:phi").right.ends_with("Stopping"));
    }

    /// Use on a model while another runs here: Phi stops (its stop the checklist's step), then
    /// gemma starts, serves, and the harness moves onto it — one Enter.
    #[test]
    fn use_stops_the_model_running_then_starts_this_one() {
        let mut app = app();
        on_local(&mut app, "local", Ok(with_phi(gemma("downloaded", Value::Null), qwen("available", Value::Null), phi("running", Value::Null))));
        on_grids(&mut app, "local", Ok(grids_reply(&["phi"])));
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:local:gemma-12b", false);
        assert_eq!(last_sent(&app), ("local".into(), "grid_fleet_model_stop".into(), json!({ "modelId": "phi" })));
        assert_eq!(app.models_view.using.as_ref().map(|u| u.step), Some(Step::Stop));
        let gemma_preview = |app: &App| text(&preview(app, "mv:local:gemma-12b"));
        let p = gemma_preview(&app);
        assert!(p.contains("✓ Download\n↻ Stop Phi · 0s\n  Start\n  Serve\n  Switch harness"), "{p}");
        assert_eq!(status_text(&app).as_deref(), Some("↻ gemma-12b waiting for Phi to stop"));
        assert_eq!(using_label(&app, app.models_view.using.as_ref().unwrap()), "Stopping Phi…");

        // Still stopping: nothing starts.
        on_act(&mut app, "local", Ok(json!({ "operation": op_on("phi", "stop", "stopping", "running") })));
        on_local(&mut app, "local", Ok(with_phi(gemma("downloaded", Value::Null), qwen("available", Value::Null), phi("running", op_on("phi", "stop", "stopping", "running")))));
        assert!(app.models_view.sent.iter().all(|s| s.1 != "grid_fleet_model_start"));
        // Stopped: gemma starts.
        on_local(&mut app, "local", Ok(with_phi(gemma("downloaded", Value::Null), qwen("available", Value::Null), phi("downloaded", op_on("phi", "stop", "stopping", "done")))));
        assert_eq!(last_sent(&app), ("local".into(), "grid_fleet_model_start".into(), json!({ "modelId": "gemma-12b" })));
        assert_eq!(app.models_view.using.as_ref().map(|u| u.step), Some(Step::Start));
        assert!(gemma_preview(&app).contains("✓ Stop Phi\n↻ Start"), "{}", gemma_preview(&app));
        on_act(&mut app, "local", Ok(json!({ "operation": op_on("gemma-12b", "start", "starting", "running") })));
        on_local(&mut app, "local", Ok(with_phi(gemma("running", op_on("gemma-12b", "start", "verifying", "done")), qwen("available", Value::Null), phi("downloaded", Value::Null))));
        on_grids(&mut app, "local", Ok(grids_reply(&["gemma-12b"])));
        assert_eq!(last_sent(&app), ("local".into(), "agent_retarget".into(), json!({ "agentId": "a1", "gridModel": "gemma-12b", "gridName": "own-grid" })));
        on_retarget(&mut app, "gemma-12b", true, Ok(json!({ "retargeted": true })));
        assert_eq!(toast(&app), "✓ gemma-12b is ready · fix-login is on it");
        assert!(gemma_preview(&app).contains("✓ Stop Phi") && gemma_preview(&app).contains("✓ Ready"), "{}", gemma_preview(&app));
        let sent: Vec<&str> = app.models_view.sent.iter().map(|s| s.1.as_str()).filter(|t| *t != "grid_fleet_models_list" && *t != "grid_models_list").collect();
        assert_eq!(sent, ["grid_fleet_model_stop", "grid_fleet_model_start", "agent_retarget"]);
    }

    /// Another harness on the model running here is asked about first — the first Enter only asks,
    /// in the preview; a refused stop ends the Use and says why.
    #[test]
    fn another_harness_on_the_running_model_is_asked_about_first() {
        let mut app = app();
        let row = json!({ "id": "r2", "name": "review", "engine": "codex", "grid": { "model": "Phi", "state": "awake" } });
        let other = crate::fleet::agent_from("local", &row, None);
        app.fleet.agents.insert(("local".into(), "r2".into()), other);
        on_local(&mut app, "local", Ok(with_phi(gemma("downloaded", Value::Null), qwen("available", Value::Null), phi("running", Value::Null))));
        on_grids(&mut app, "local", Ok(grids_reply(&["phi"])));
        let words = "Stop Phi? review uses Phi, and will stop answering until it moves to another model. Enter · Esc";
        match plan_enter(&app, "mv:local:gemma-12b") { Plan::Arm(w, then) => { assert_eq!(w, words); assert_eq!(*then, Plan::Use { model: "gemma-12b".into(), download: false }) } p => panic!("{p:?}") }
        match plan_enter(&app, "mv:local:qwen-35b") { Plan::Arm(w, _) => assert!(w.ends_with("stop Phi, start it, move this harness onto it? review uses Phi, and will stop answering until it moves to another model. Enter · Esc"), "{w}"), p => panic!("{p:?}") }
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:local:gemma-12b", false);
        assert!(app.models_view.sent.iter().all(|s| s.1 != "grid_fleet_model_stop"), "the first Enter only asks");
        assert!(text(&preview(&app, "mv:local:gemma-12b")).contains(words));
        choose(&mut app, &mut picker, "mv:local:gemma-12b", false);
        assert_eq!(last_sent(&app), ("local".into(), "grid_fleet_model_stop".into(), json!({ "modelId": "phi" })));
        on_act(&mut app, "local", Err(RpcError::new("Phi is busy. Try again.", "")));
        assert!(app.models_view.using.is_none());
        assert_eq!(toast(&app), "✗ gemma-12b: Phi is busy. Try again.");
        assert!(text(&preview(&app, "mv:local:gemma-12b")).contains("✗ Stop Phi"), "{}", text(&preview(&app, "mv:local:gemma-12b")));
    }

    /// Get while another model runs: the download first — the running one answers meanwhile — then
    /// it stops, and this one starts.
    #[test]
    fn get_downloads_before_it_stops_the_model_running() {
        let mut app = app();
        on_local(&mut app, "local", Ok(with_phi(gemma("downloaded", Value::Null), qwen("available", Value::Null), phi("running", Value::Null))));
        on_grids(&mut app, "local", Ok(grids_reply(&["phi"])));
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:local:qwen-35b", false);
        choose(&mut app, &mut picker, "mv:local:qwen-35b", false);
        assert_eq!(last_sent(&app), ("local".into(), "grid_fleet_model_download".into(), json!({ "modelId": "qwen-35b" })));
        assert_eq!(app.models_view.using.as_ref().map(|u| u.step), Some(Step::Get));
        on_act(&mut app, "local", Ok(json!({ "operation": op("download", "downloading", "running", Some(0.5)) })));
        on_local(&mut app, "local", Ok(with_phi(gemma("downloaded", Value::Null), qwen("downloaded", op("download", "downloading", "done", None)), phi("running", Value::Null))));
        assert_eq!(last_sent(&app), ("local".into(), "grid_fleet_model_stop".into(), json!({ "modelId": "phi" })));
        assert_eq!(app.models_view.using.as_ref().map(|u| u.step), Some(Step::Stop));
        on_act(&mut app, "local", Ok(json!({ "operation": op_on("phi", "stop", "stopping", "running") })));
        on_local(&mut app, "local", Ok(with_phi(gemma("downloaded", Value::Null), qwen("downloaded", Value::Null), phi("downloaded", op_on("phi", "stop", "stopping", "done")))));
        assert_eq!(last_sent(&app), ("local".into(), "grid_fleet_model_start".into(), json!({ "modelId": "qwen-35b" })));
        // Phi stopped already by the time the download ends: straight to the start.
        let job = Use { identity: None, model: "qwen-35b".into(), name: "Qwen".into(), machine: "local".into(), agent: "a1".into(), step: Step::Get, since: Instant::now(), stops: Some(("phi".into(), "Phi".into())) };
        let snap = parse_local(&with_phi(gemma("downloaded", Value::Null), qwen("downloaded", Value::Null), phi("downloaded", Value::Null))).unwrap();
        assert_eq!(next(&job, Some(&snap), None, false, None, Instant::now()), Next::Start);
        // A stop that never ends says so after three minutes.
        let stopping = Use { step: Step::Stop, ..job };
        let still = parse_local(&with_phi(gemma("downloaded", Value::Null), qwen("downloaded", Value::Null), phi("running", Value::Null))).unwrap();
        assert_eq!(next(&stopping, Some(&still), None, false, None, Instant::now()), Next::Wait);
        assert_eq!(next(&stopping, Some(&still), None, false, None, Instant::now() + USE_WAIT + Duration::from_secs(1)), Next::Fail("Phi is still stopping. Try again in a moment.".into()));
    }

    /// A model's row as the desktop's: its name, then its size and speed — the catalog's estimate
    /// here (`~`), else the app it runs in (Ollama, LM Studio, llama.cpp, Grid) — then its word, the
    /// word alone in a narrow list. The app is "Runs in" in its preview, and a search finds it.
    #[test]
    fn a_model_says_the_app_it_runs_in() {
        let mut app = app();
        let mut reply = local_reply(qwen("downloaded", Value::Null), false);
        reply["models"][0]["app"] = json!("Grid");
        reply["models"].as_array_mut().unwrap().push(json!({ "id": "app:ollama:llama3.2:3b", "name": "llama3.2:3b", "state": "downloaded", "sizeBytes": 1.9 * GIB, "canStart": true, "canStop": false, "app": "Ollama" }));
        on_local(&mut app, "local", Ok(reply));
        on_grids(&mut app, "local", Ok(grids_reply(&[])));
        let rows = rows_of(&app);
        let squeezed = |r: &Row| r.right.split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(squeezed(row(&rows, "mv:local:qwen-35b")), "20 GB ~78 tok/s Use");
        assert_eq!(squeezed(row(&rows, "mv:local:app:ollama:llama3.2:3b")), "1.9 GB Ollama Use");
        assert!(row(&rows, "mv:local:qwen-35b").detail.iter().all(|s| s.content.is_empty()), "the name alone");
        assert_eq!(row(&rows, "mv:local:qwen-35b").right_at(40), "Use", "a narrow list: the word");
        assert!(text(&preview(&app, "mv:local:app:ollama:llama3.2:3b")).contains("Runs in  Ollama"), "{}", text(&preview(&app, "mv:local:app:ollama:llama3.2:3b")));
        assert!(!text(&preview(&app, "mv:local:gemma-12b")).contains("Runs in"), "an older daemon says nothing");
        assert!(row(&rows, "mv:local:app:ollama:llama3.2:3b").extra.contains("Ollama"), "typing its app finds it");
    }

    /// A terminal harness whose Claude Code exited is retired with its conversation, and the shell
    /// left in its tmux pane goes on under a new id — so does the Claude Code started in it next. The
    /// pane still on the retired id moves that one: never the archive ("That harness is gone").
    #[test]
    fn a_pane_on_a_retired_harness_moves_the_one_its_shell_runs_now() {
        let mut app = loaded();
        let key = ("local".to_string(), "a1".to_string());
        let row = |id: &str, status: &str, pane: Value| json!({ "id": id, "name": format!("Terminal harness {id}"), "engine": "claude", "status": status, "tmuxPane": pane, "grid": {} });
        let live = crate::fleet::agent_from("local", &row("a1", "active", json!("%141")), app.fleet.agents.get(&key));
        app.fleet.agents.insert(key.clone(), live);
        // Retired: the row no longer says its pane; the shell's new harness runs Claude Code there.
        let retired = crate::fleet::agent_from("local", &row("a1", "stopped", Value::Null), app.fleet.agents.get(&key));
        assert_eq!(retired.tmux_pane, "%141", "the pane it was in is kept");
        app.fleet.agents.insert(key, retired);
        app.fleet.agents.insert(("local".into(), "a2".into()), crate::fleet::agent_from("local", &row("a2", "active", json!("%141")), None));
        assert_eq!(target(&app).map(|t| t.agent).as_deref(), Some("a2"));
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:grid:team\tgpu-box\tllama-70b", false);
        assert_eq!(last_sent(&app), ("local".into(), "agent_retarget".into(), json!({ "agentId": "a2", "gridModel": "llama-70b", "gridName": "team" })));
        assert_eq!(pane_note(&app, "local", "a1").as_deref(), Some("Switching to llama-70b…"), "the pane's heading follows it too");
        // Nothing live in that pane: the retired one stays the pane's (and the view says so as before).
        app.fleet.agents.remove(&("local".to_string(), "a2".to_string()));
        assert_eq!(target(&app).map(|t| t.agent).as_deref(), Some("a1"));
    }

    /// The sections, in the desktop picker's order (`ModelSearchSection`): Subscriptions, APIs, Your
    /// models, the downloads under `Get for this Mac · 64 GB` (five, then "More models (N)"), Shared
    /// with you (every shared grid's rows, a resting one offering "Show models").
    #[test]
    fn rows_are_in_sections() {
        let mut app = loaded();
        on_apis(&mut app, Ok(json!({ "connections": [{ "id": "or", "name": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1" }], "presets": [] })));
        let rows = rows_of(&app);
        let mut groups: Vec<&str> = rows.iter().filter_map(|r| r.group.as_deref()).collect();
        groups.dedup();
        let here = this_computer();
        assert_eq!(groups, vec!["Subscriptions".to_string(), "APIs".into(), "Your models".into(), format!("Get for {here} · 64 GB"), "Shared with you".into()]);
        assert!(row(&rows, "mv:grid:team\tlap\tmistral").right.ends_with("Offline"));
        let detail = |r: &Row| r.detail.iter().map(|s| s.content.as_ref()).collect::<String>();
        assert_eq!(detail(row(&rows, "mv:grid:team\tgpu-box\tllama-70b")), "gpu-box · team", "the machine and the grid it is on");
        assert!(row(&rows, "mv:wake:night").label == "Show models · night");
        let downloads: Vec<&Row> = rows.iter().filter(|r| r.group.as_deref().is_some_and(|g| g.starts_with("Get for"))).collect();
        assert_eq!(downloads.len(), 6, "five, then More models");
        assert_eq!(downloads[5].label, "More models (2)");
        // More models lists them all; a search too, without the row.
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:more", false);
        assert_eq!(rows_of(&app).iter().filter(|r| r.id.starts_with("mv:local:extra")).count(), 6);
        assert_eq!(row(&rows_of(&app), "mv:more").label, "Show fewer");
        app.models_view.more = false;
        assert_eq!(super::rows(&app, "extra").iter().filter(|r| r.id.starts_with("mv:local:extra")).count(), 6);
        assert!(super::rows(&app, "extra").iter().all(|r| r.id != "mv:more"));
        // No harness in front: every subscription, and nothing to Use.
        app.tabs[0].focus = None;
        let rows = rows_of(&app);
        assert_eq!(rows[0].group.as_deref(), Some("Subscriptions"));
        assert!(row(&rows, "mv:grid:team\tgpu-box\tllama-70b").right.trim().is_empty());
        assert_eq!(plan_enter(&app, "mv:grid:team\tgpu-box\tllama-70b"), Plan::Say(NO_HARNESS.into()));
    }

    /// An engine the daemon cannot point at a model says so, and offers only its own login.
    #[test]
    fn an_engine_that_runs_only_on_its_login_says_so() {
        let mut app = loaded();
        let key = ("local".to_string(), "a1".to_string());
        app.fleet.agents.get_mut(&key).unwrap().engine = "cursor".into();
        let rows = rows_of(&app);
        assert!(rows.iter().any(|r| r.label == "Cursor can only run on its own login."), "{:?}", rows.iter().map(|r| &r.label).collect::<Vec<_>>());
        assert_eq!(plan_enter(&app, "mv:grid:team\tgpu-box\tllama-70b"), Plan::Say("Cursor runs only on its own login".into()));
    }

    /// An offline row is listed, and Enter on it asks before switching anyway.
    #[test]
    fn an_offline_row_asks_before_switching() {
        let app = loaded();
        match plan_enter(&app, "mv:grid:team\tlap\tmistral") {
            Plan::Arm(words, then) => {
                assert_eq!(words, "lap seems offline — Enter again to switch anyway");
                assert!(matches!(*then, Plan::Retarget { ref payload, .. } if payload["gridModel"] == "mistral"));
            }
            p => panic!("{p:?}"),
        }
    }

    /// "Show models" wakes a resting section, and the view reads again every 5 s while it starts.
    #[test]
    fn show_models_wakes_a_resting_section() {
        let mut app = loaded();
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:wake:night", false);
        assert_eq!(last_sent(&app), ("local".into(), "grid_models_list".into(), json!({ "rowState": true, "wake": ["night"] })));
        assert!(rows_of(&app).iter().any(|r| r.label == format!("night · {STARTING_UP_WAIT}")), "the wake in flight says so");
        assert_eq!(plan_enter(&app, "mv:wake:night"), Plan::Say(STARTING_UP_WAIT.into()), "once, however often it is pressed");
        let mut waking = grids_reply(&[]);
        waking["grids"][2]["state"] = json!("waking");
        on_wake(&mut app, "local", "night", Ok(waking));
        assert!(app.models_view.follow_until.is_some());
        assert_eq!(grids_every(false, false, true), Some(Duration::from_secs(5)));
        let rows = rows_of(&app);
        assert!(rows.iter().any(|r| r.label == format!("night · {STARTING_UP_WAIT}") && r.group.as_deref() == Some("Shared with you")));
    }

    #[test]
    fn polling_is_every_four_seconds_while_busy_or_open_else_a_minute() {
        assert_eq!(poll_every(true, false), Duration::from_secs(4));
        assert_eq!(poll_every(false, true), Duration::from_secs(4));
        assert_eq!(poll_every(false, false), Duration::from_secs(60));
        assert_eq!(grids_every(true, false, false), Some(Duration::from_secs(20)));
        assert_eq!(grids_every(false, true, false), Some(Duration::from_secs(4)));
        assert_eq!(grids_every(false, false, false), None);
        let now = Instant::now();
        assert!(due(None, Duration::from_secs(4), now));
        assert!(!due(Some(&now), Duration::from_secs(4), now));
    }

    /// `grid_models_changed` is the whole list: taken as it is, the rows follow.
    #[test]
    fn a_push_replaces_the_grids() {
        let mut app = loaded();
        let pending_list = begin_read(&mut app, "local", "grids");
        let pending_wake = begin_read(&mut app, "local", "wake:own-grid");
        app.models_view.grids_reading.insert("local".into());
        app.models_view.asking.insert("own-grid".into());
        on_push(&mut app, "local", &json!({ "gridName": "own-grid", "grids": [{ "name": "own-grid", "own": true, "models": [{ "id": "big", "node": "tower" }] }] }));
        assert!(!finish_read(&mut app, "local", "grids", &pending_list));
        assert!(!finish_read(&mut app, "local", "wake:own-grid", &pending_wake));
        assert!(!app.models_view.grids_reading.contains("local"));
        assert!(!app.models_view.asking.contains("own-grid"));
        let rows = rows_of(&app);
        assert!(rows.iter().any(|r| r.id == "mv:grid:own-grid\ttower\tbig"));
        assert!(rows.iter().all(|r| !r.id.starts_with("mv:grid:team")));
    }

    #[test]
    fn replies_are_read_defensively() {
        let s = parse_local(&local_reply(qwen("available", op("download", "downloading", "running", Some(1.7))), true)).unwrap();
        let q = &s.models[0];
        assert_eq!((q.context, q.est_tok_s, q.params_b, q.quantization().as_deref()), (Some(131072.0), Some(78.2), Some(35.0), Some("Q4_K_M")));
        assert_eq!(q.operation.as_ref().and_then(|o| o.progress), Some(1.0), "progress held to 0–1");
        assert!(s.busy && s.supports_download && s.memory == Some(64.0 * GIB));
        assert!(parse_local(&json!({ "error": "x" })).is_none());
        assert!(Operation::parse(&json!({ "id": "x", "modelId": "m", "action": "fly", "stage": "checking", "phase": "running" })).is_none());
        let unnamed = LocalModel::from(&json!({ "id": "unsloth/Qwen3-8B-UD-Q4_K_XL.gguf" })).unwrap();
        assert_eq!(unnamed.quantization().as_deref(), Some("Q4_K_XL"));
        assert_eq!(unnamed.state, "available");

        let g = parse_grids(&grids_reply(&["a"]));
        assert_eq!(g.sections.len(), 3);
        assert_eq!(g.sections[1].models[1].offline.as_deref(), Some("lap"));
        assert!(g.can_run("Claude") && !g.can_run("cursor") && g.reachable);
        let old = parse_grids(&json!({ "gridName": "mine", "models": [{ "id": "m", "node": "n" }] }));
        assert!(old.sections[0].own && old.can_run("anything"), "an older daemon: its own grid, nothing refused");
        assert!(!parse_grids(&json!({ "error": "GRID_MODELS_FAILED" })).reachable);

        let apis = parse_apis(&json!({ "connections": [{ "id": "or", "name": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1" }, { "id": "x", "name": "X", "baseUrl": "https://x.dev", "authHeader": "x-api-key", "authPrefix": "" }], "presets": [] })).unwrap();
        assert!(apis[0].serves_models() && !apis[1].serves_models());
        assert_eq!(apis[0].host(), "openrouter.ai");
        assert!(parse_apis(&json!({})).is_err());
        let models = parse_api_models(&json!({ "models": [{ "id": "a", "contextWindow": 200000 }, { "id": " " }] })).unwrap();
        assert_eq!(models, vec![ApiModel { id: "a".into(), name: None, context: Some(200000) }]);

        let a = crate::fleet::agent_from("m", &json!({ "id": "a", "grid": { "model": "q", "baseUrl": "http://x/v1", "state": "asleep", "note": { "reason": "offline", "model": "q", "machine": "lap" } } }), None);
        assert_eq!((a.grid_model.as_str(), a.grid_state.as_str(), a.grid_note.clone()), ("q", "asleep", Some(("offline".into(), "q".into(), "lap".into()))));
        let b = crate::fleet::agent_from("m", &json!({ "id": "a", "grid": { "note": { "reason": "offline", "model": "q" } } }), None);
        assert!(b.grid_note.is_none(), "an offline note needs its computer");
    }

    /// The desktop's table of what a resting section says.
    #[test]
    fn a_resting_section_says_what_the_desktop_says() {
        let s = |state: &str, models: usize, age: Option<u64>, outcome: &str| Section { name: "team".into(), state: state.into(), age, outcome: outcome.into(),
            models: (0..models).map(|i| GridModel { id: format!("m{i}"), node: "n".into(), offline: None }).collect(), ..Default::default() };
        assert_eq!(section_words(&s("asleep", 1, Some(180), ""), false).subtitle.as_deref(), Some("Asleep 3min ago"));
        assert!(section_words(&s("asleep", 0, None, ""), false).offer_wake);
        assert_eq!(section_words(&s("asleep", 0, None, ""), true), Words { subtitle: None, sentence: Some(STARTING_UP_WAIT.into()), offer_wake: false });
        assert_eq!(section_words(&s("asleep", 0, Some(60), ""), false).sentence.as_deref(), Some("Nobody was serving here when it went to sleep"));
        assert_eq!(section_words(&s("awake", 0, None, "nobody_serving"), false).sentence.as_deref(), Some("Nobody is serving a model here right now"));
        assert_eq!(section_words(&s("awake", 0, None, "not_started"), false).sentence.as_deref(), Some("Couldn't start team right now — it will start on your next message"));
        assert_eq!(section_words(&s("unknown", 2, None, ""), false).sentence.as_deref(), Some("Not answering right now"));
        let w = section_words(&s("awake", 2, None, ""), false);
        assert!(w.subtitle.is_none() && w.sentence.is_none() && !w.offer_wake);
        assert_eq!(list_age(30), "just now");
        assert_eq!(list_age(7200), "2h ago");
    }

    /// Saved APIs fold their models until Enter; a model of one is used on a harness here.
    #[test]
    fn saved_apis_fold_and_their_models_are_used() {
        let mut app = loaded();
        on_apis(&mut app, Ok(json!({ "connections": [{ "id": "or", "name": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1" }], "presets": [] })));
        assert_eq!(last_sent(&app), ("local".into(), "api_connections".into(), json!({ "action": "models", "id": "or" })));
        on_api_models(&mut app, "or", Ok(json!({ "models": [{ "id": "deepseek/v4", "contextWindow": 131072 }] })));
        let rows = rows_of(&app);
        assert_eq!(row(&rows, "mv:api:or").right, "1 model");
        assert!(rows.iter().all(|r| !r.id.starts_with("mv:apimodel:")), "folded");
        let mut picker = Picker::new("models", "");
        choose(&mut app, &mut picker, "mv:api:or", false);
        assert!(row(&rows_of(&app), "mv:apimodel:or\tdeepseek/v4").right.ends_with("Use"));
        choose(&mut app, &mut picker, "mv:apimodel:or\tdeepseek/v4", false);
        assert_eq!(last_sent(&app), ("local".into(), "agent_retarget".into(), json!({ "agentId": "a1", "apiConnection": "or", "apiModel": "deepseek/v4" })));
        assert!(text(&preview(&app, "mv:apimodel:or\tdeepseek/v4")).contains("128K window"));
        frame(&mut app, json!({ "model": "deepseek/v4", "baseUrl": "https://openrouter.ai/api/v1/" }));
        assert!(row(&rows_of(&app), "mv:apimodel:or\tdeepseek/v4").right.ends_with("✓ In use"));
    }

    /// The preview: what decides between models, and what Enter does.
    #[test]
    fn the_preview_says_what_decides_and_what_enter_does() {
        let mut app = loaded();
        let here = this_computer();
        let s = text(&preview(&app, "mv:local:qwen-35b"));
        for want in ["Qwen3.6-35B-A3B", "Not downloaded", "Download 20 GB · 120 GB free", &format!("Memory   fits · {here} has 64 GB"), &format!("Speed    ~78 tok/s on {here} (estimate)"),
            "Context  128K window", "Params   35B", "Quant    Q4_K_M", "Machine  This", "Enter gets it: downloads it, starts it, and moves this harness onto it."] {
            assert!(s.contains(want), "{want:?} missing:\n{s}");
        }
        // Not room on the disk for it: said before Get.
        on_local(&mut app, "local", Ok({ let mut r = local_reply(qwen("available", Value::Null), false); r["freeDiskBytes"] = json!(10.0 * GIB); r }));
        assert!(text(&preview(&app, "mv:local:qwen-35b")).contains(&format!("Free up disk space on {here} to get it.")));
        let sub = text(&preview(&app, "mv:sub:claude\t7f0c"));
        assert!(sub.contains("12% left · Running low") && sub.contains("5h — 12% left") && sub.contains("This harness is on it") && sub.contains("Running low: Enter on a model below"), "{sub}");
        assert!(text(&preview(&app, "mv:wake:night")).contains("Enter wakes it"));
        assert!(text(&preview(&app, "mv:grid:team\tlap\tmistral")).contains("lap seems offline"));
        assert!(text(&preview(&app, "mv:more")).contains("7 models that fit"));
        assert!(crate::preview::lines(&app, &crate::modal::PickerKind::Models, "mv:local:gemma-12b").iter().any(|l| l.spans.iter().any(|s| s.content.contains("Enter starts it and moves this harness onto it."))));
    }

    /// The pane's note: "Starting up…" from a message sent while the model's computers rest
    /// until the model answers; the daemon's note when its model will not answer.
    #[test]
    fn the_pane_says_when_its_model_will_not_answer() {
        let mut app = loaded();
        frame(&mut app, json!({ "model": "llama-70b", "state": "asleep" }));
        watch_turn(&mut app, "local", "turn_started", &json!({ "agentId": "a1", "replay": true }));
        assert!(pane_note(&app, "local", "a1").is_none(), "a replayed turn is not a message sent now");
        watch_turn(&mut app, "local", "turn_started", &json!({ "agentId": "a1" }));
        assert_eq!(pane_note(&app, "local", "a1").as_deref(), Some("Starting up…"));
        app.models_view.starts.insert(("local".into(), "a1".into()), Instant::now() - Duration::from_secs(90));
        assert_eq!(pane_note(&app, "local", "a1").as_deref(), Some("Still starting — this can take up to a minute"));
        watch_turn(&mut app, "local", "text_delta", &json!({ "agentId": "a1" }));
        assert!(pane_note(&app, "local", "a1").is_none());
        frame(&mut app, json!({ "model": "llama-70b", "state": "awake" }));
        watch_turn(&mut app, "local", "turn_started", &json!({ "agentId": "a1" }));
        assert!(pane_note(&app, "local", "a1").is_none(), "an awake model starts no wait");
        frame(&mut app, json!({ "model": "llama-70b", "note": { "reason": "offline", "model": "llama-70b", "machine": "gpu-box" } }));
        assert_eq!(pane_note(&app, "local", "a1").as_deref(), Some("gpu-box seems offline — llama-70b won't answer until it's back"));
        frame(&mut app, json!({ "model": "llama-70b", "note": { "reason": "not_served", "model": "llama-70b" } }));
        assert!(pane_note(&app, "local", "a1").is_some_and(|n| n.starts_with("llama-70b isn't being served right now · Pick another")));
    }

    #[test]
    fn sizes_and_windows_read_as_the_desktop_says_them() {
        assert_eq!(gb(2.7 * GIB), "2.7 GB");
        assert_eq!(gb(27.4 * GIB), "27 GB");
        assert_eq!(context_label(131072), "128K");
        assert_eq!(context_label(200000), "200K");
        assert_eq!(context_label(1_000_000), "1M");
        assert_eq!(context_label(1_500_000), "1.5M");
        assert_eq!(window_label(3600.0), "1h");
        assert_eq!(left_of(99.6), "<1%");
        assert_eq!(left_of(88.0), "12%");
    }

    fn screen(app: &mut App, w: u16, h: u16) -> String {
        let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(w, h)).unwrap();
        term.draw(|f| crate::ui::draw(f, app)).unwrap();
        let buf = term.backend().buffer().clone();
        (0..h).map(|y| (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    /// The `:` scope and Models… open the panel on the focused harness's row, in sections — at
    /// 150×42 and at 80×24.
    #[test]
    fn models_draws_as_the_panel() {
        // Opened before the replies come: each lands in its own section, not after the rest.
        let mut app = app();
        on_grids(&mut app, "local", Ok(grids_reply(&[])));
        crate::input::run(&mut app, "models");
        on_local(&mut app, "local", Ok(local_reply(qwen("available", Value::Null), false)));
        let Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Models, picker }) = &app.modal else { panic!("not open") };
        assert_eq!(picker.current_id().as_deref(), Some("mv:sub:claude\t7f0c"), "on the row the harness is on");
        let s = screen(&mut app, 150, 42);
        for want in ["Models", "Subscriptions", "Anthropic", "12% left · Running low", "Your models", "gemma-12b", "Shared with you", "llama-70b", "Show models"] {
            assert!(s.contains(want), "{want:?} missing at 150×42:\n{s}");
        }
        let at = |w: &str| s.find(w).unwrap_or(usize::MAX);
        // Top to bottom as on the desktop, each heading over its rows (the launcher's lists read
        // from the bottom, so the last section is by the query).
        assert!(at("Subscriptions") < at("Your models") && at("Your models") < at("gemma-12b") && at("gemma-12b") < at("Get for")
            && at("Get for") < at("Shared with you") && at("Shared with you") < at("llama-70b"), "sections out of order:\n{s}");
        app.size = (80, 24);
        app.fit_panes();
        let s = screen(&mut app, 80, 24);
        // (On the row in use, the top one: at this height the list starts at it, its heading above.)
        for want in ["Models", "Anthropic", "Your models"] { assert!(s.contains(want), "{want:?} missing at 80×24:\n{s}") }
        // Further down, the downloads and what is shared.
        let s = { crate::input::modal_key(&mut app, crossterm::event::KeyEvent::new(crossterm::event::KeyCode::PageDown, crossterm::event::KeyModifiers::NONE)); crate::input::modal_key(&mut app, crossterm::event::KeyEvent::new(crossterm::event::KeyCode::PageDown, crossterm::event::KeyModifiers::NONE)); screen(&mut app, 80, 24) };
        assert!(s.contains("Shared with you") || s.contains("llama-70b"), "{s}");
        // It is in the Commands panel, in the Harness group.
        assert!(crate::modal::command_rows(&app).iter().any(|r| r.id == "cmd:models" && r.group.as_deref() == Some("Harness")));
    }
}
