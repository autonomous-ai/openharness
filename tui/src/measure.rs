//! hn's product measurement, the Desktop's (desktop/lib/measurement/product_measurement.dart and
//! product_runtime_health.dart) in a terminal: a flow's start, outcome and coarse duration, and the
//! first-use milestones once per app session. Each is a `product_observe` frame on this computer's
//! own daemon link, which counts it in the daemon's product-usage queue under the account's choice
//! (cli/src/localWsServer.ts) and drops anything outside the fixed vocabulary. Signed in only, as the
//! Desktop's account channel: what happens while hn is signed out is never recorded, and a sign-in,
//! sign-out or account change ends what the previous one had under way. Only fixed names and a duration leave hn: no
//! machine, harness, path, text or event history, and nothing is kept on disk.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::app::App;

/// Observations waiting for the daemon, at most: the Desktop keeps 64 in flight. More are dropped.
const QUEUE_CAP: usize = 64;
/// Connection and resume observations open at once, at most, as the Desktop's maps.
const OPEN_CAP: usize = 64;
/// A flow still open after this long is unknown, as the Desktop's are after 15 minutes.
const EXPIRE: Duration = Duration::from_secs(15 * 60);

pub const WORKSPACE_READY: &str = "funnel_workspace_ready";
pub const FIRST_WORK: &str = "funnel_first_work";
pub const FIRST_RESPONSE: &str = "funnel_first_response";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome { Ok, Failed, Cancelled, Unknown }

impl Outcome {
    fn wire(self) -> &'static str {
        match self { Outcome::Ok => "ok", Outcome::Failed => "failed", Outcome::Cancelled => "cancelled", Outcome::Unknown => "unknown" }
    }
}

/// A flow under way: its name, when it began, and the sign-in it began under. Its start is counted
/// when it begins, as the Desktop's `begin()` counts it; one begun signed out counts nothing, start
/// included, and one finished under another account counts no outcome (the Desktop's account epoch).
#[derive(Debug)]
pub struct Flow { name: &'static str, at: Instant, epoch: Option<u64> }

pub fn begin(app: &mut App, flow: &'static str) -> Flow {
    let epoch = recording(app).then_some(app.measure.epoch);
    if epoch.is_some() { record(app, json!({ "flow": flow })) }
    Flow { name: flow, at: Instant::now(), epoch }
}

impl Flow {
    pub fn finish(self, app: &mut App, outcome: Outcome) {
        if self.epoch.is_some_and(|e| e == app.measure.epoch) { observed(app, self.name, outcome, self.at.elapsed()) }
    }
}

/// A flow begun and finished at once (the Desktop's `begin(flow)(outcome)`).
pub fn once(app: &mut App, flow: &'static str, outcome: Outcome) { begin(app, flow).finish(app, outcome) }

pub struct State {
    /// When hn started (main.rs sets the process's own start): app_start runs from it, as the
    /// Desktop's launch clock does.
    pub since: Instant,
    /// Bumped at every sign-in and sign-out, as the Desktop's account epoch.
    epoch: u64,
    queue: VecDeque<Value>,
    /// The queue has dropped an observation this sign-in, and said so (`observation_overflow`).
    overflowed: bool,
    /// The milestones this sign-in has counted, and when its first one was: first work and first
    /// response are timed from it (the Desktop's `_funnelSeen` / `_funnelStarted`).
    funnel_seen: HashSet<&'static str>,
    funnel_since: Option<Instant>,
    /// Harnesses with a live turn (a `turn_started` that was not a re-read), until it ends: the first
    /// text from one of them is the first response (the Desktop's `liveTurnAgents`).
    live: HashSet<(String, String)>,
    /// workspace_ready under way since this sign-in, and whether this sign-in reached it.
    workspace: Option<Flow>,
    ready_counted: bool,
    /// Connections being dialled (workspace_connect, remote_connect), by machine.
    dialling: HashMap<String, Flow>,
    /// Resumes waiting for their harness's next turn, oldest first.
    resumes: Vec<((String, String), Flow)>,
    #[cfg(test)]
    pub sent: Vec<Value>,
}

impl Default for State {
    fn default() -> State {
        State { since: Instant::now(), epoch: 0, queue: VecDeque::new(), overflowed: false, funnel_seen: HashSet::new(), funnel_since: None,
            live: HashSet::new(), workspace: None, ready_counted: false, dialling: HashMap::new(), resumes: Vec::new(),
            #[cfg(test)]
            sent: Vec::new() }
    }
}

/// Recorded at all: signed in, and a terminal (hn with no terminal is a script's server).
fn recording(app: &App) -> bool { app.signed_in && !app.headless }

/// A flow that has finished, [took] long.
fn observed(app: &mut App, flow: &'static str, outcome: Outcome, took: Duration) {
    let ms = took.as_millis().min(u64::MAX as u128) as u64;
    record(app, json!({ "flow": flow, "outcome": outcome.wire(), "durationMs": ms }));
}

/// A first-use milestone, once per sign-in of this app session. First work and first response add
/// how long after this session's first milestone they came, in the Desktop's buckets.
fn milestone(app: &mut App, measure: &'static str) {
    if !recording(app) || !app.measure.funnel_seen.insert(measure) { return }
    let since = *app.measure.funnel_since.get_or_insert_with(Instant::now);
    record(app, json!({ "measure": measure }));
    let step = match measure { FIRST_WORK => "first_work", FIRST_RESPONSE => "first_response", _ => return };
    let secs = since.elapsed().as_secs();
    let bucket = if secs < 60 { "under_1m" } else if secs < 300 { "1m_to_5m" } else { "over_5m" };
    record(app, json!({ "measure": format!("{step}_{bucket}") }));
}

/// The daemon on this computer signed in or out, or now answers for another account (app.rs
/// `follow_account`, account_scope.rs `adopt_daemon_identity`): what the previous one had (waiting,
/// under way, counted) goes with it, and a signed-in account starts its own workspace_ready.
pub fn account_changed(app: &mut App) {
    let m = &mut app.measure;
    m.epoch += 1;
    m.queue.clear();
    m.funnel_seen.clear();
    m.funnel_since = None;
    m.live.clear();
    m.workspace = None;
    m.ready_counted = false;
    m.overflowed = false;
    m.dialling.clear();
    m.resumes.clear();
    if recording(app) {
        let flow = begin(app, "workspace_ready");
        app.measure.workspace = Some(flow);
    }
}

/// A first response is still being watched for: signed in, not yet counted, a turn live.
pub fn watching(app: &App) -> bool { !app.measure.live.is_empty() && recording(app) }

fn is_live(app: &App, machine: &str, agent: &str) -> bool {
    app.measure.live.iter().any(|(m, a)| m == machine && a == agent)
}

/// A harness's live turn began: the first work, and the next turn a resume waited for.
pub fn turn_started(app: &mut App, machine: &str, agent: &str) {
    if !recording(app) { return }
    milestone(app, FIRST_WORK);
    if !app.measure.funnel_seen.contains(FIRST_RESPONSE) && !is_live(app, machine, agent) {
        app.measure.live.insert((machine.to_string(), agent.to_string()));
    }
    if let Some(i) = app.measure.resumes.iter().position(|((m, a), _)| m == machine && a == agent) {
        let (_, flow) = app.measure.resumes.remove(i);
        flow.finish(app, Outcome::Ok);
    }
}

pub fn turn_ended(app: &mut App, machine: &str, agent: &str) {
    if app.measure.live.is_empty() { return }
    app.measure.live.retain(|(m, a)| m != machine || a != agent);
}

/// Text from a harness's turn (not a re-read): the first response, when that turn is live. Called for
/// every text delta, so it costs nothing once there is no live turn to watch (signed out, or the
/// first response already counted).
pub fn text(app: &mut App, machine: &str, agent: &str) {
    if !watching(app) || !is_live(app, machine, agent) { return }
    app.measure.live.clear();
    milestone(app, FIRST_RESPONSE);
}

/// A resume asked for: ok at the harness's next live turn. Another for the same harness cancels the
/// one before; past the bound the oldest is unknown and the overflow is said.
pub fn resuming(app: &mut App, machine: &str, agent: &str) {
    if !recording(app) { return }
    let key = (machine.to_string(), agent.to_string());
    if app.measure.resumes.len() >= OPEN_CAP {
        record(app, json!({ "measure": "observation_overflow" }));
        let (_, oldest) = app.measure.resumes.remove(0);
        oldest.finish(app, Outcome::Unknown);
    }
    if let Some(i) = app.measure.resumes.iter().position(|(k, _)| *k == key) {
        let (_, before) = app.measure.resumes.remove(i);
        before.finish(app, Outcome::Cancelled);
    }
    let flow = begin(app, "resume_recovery");
    app.measure.resumes.push((key, flow));
}

/// The daemon refused the resume.
pub fn resume_failed(app: &mut App, machine: &str, agent: &str) {
    let key = (machine.to_string(), agent.to_string());
    if let Some(i) = app.measure.resumes.iter().position(|(k, _)| *k == key) {
        let (_, flow) = app.measure.resumes.remove(i);
        flow.finish(app, Outcome::Failed);
    }
}

/// hn dials [machine]: this computer's daemon (workspace_connect) or another machine (remote_connect).
/// hn's own shells are not a connection. A redial while the connection is still open here (its
/// last dial failed and hn tried again) is the same connection, not another: counted per dial, the
/// backoff's retries made prod's first day (2026-10-16) read remote_connect 51 started, 30 failed.
pub fn dialling(app: &mut App, machine: &str) {
    if !recording(app) || crate::local::is_local(machine) || app.measure.dialling.len() >= OPEN_CAP || app.measure.dialling.contains_key(machine) { return }
    let flow = begin(app, if app.this_computer(machine) { "workspace_connect" } else { "remote_connect" });
    app.measure.dialling.insert(machine.into(), flow);
}

/// [machine]'s link connected, or hn stopped dialling it before it did (app.rs `on_machine`: a
/// failure it dials again after is not an answer).
pub fn dialled(app: &mut App, machine: &str, connected: bool) {
    if let Some(flow) = app.measure.dialling.remove(machine) { flow.finish(app, if connected { Outcome::Ok } else { Outcome::Failed }) }
}

/// [machine]'s link was let go without an answer (this computer took another machine id).
pub fn forget(app: &mut App, machine: &str) { app.measure.dialling.remove(machine); }

/// Every tick: the workspace becoming ready, flows open too long, and sending what waits.
pub fn tick(app: &mut App) {
    if !recording(app) { return }
    // The Desktop's `ready()`: signed in with a machine connected. app_start is the launch to here.
    if !app.measure.ready_counted && app.fleet.machines.iter().any(|m| m.usable() && !crate::local::is_local(&m.id)) {
        app.measure.ready_counted = true;
        if let Some(flow) = app.measure.workspace.take() { flow.finish(app, Outcome::Ok) }
        // Started and finished at once, as the Desktop's `observedStartup` counts it.
        let took = app.measure.since.elapsed();
        record(app, json!({ "flow": "app_start" }));
        observed(app, "app_start", Outcome::Ok, took);
        milestone(app, WORKSPACE_READY);
    }
    if app.measure.workspace.as_ref().is_some_and(|f| f.at.elapsed() >= EXPIRE) {
        if let Some(flow) = app.measure.workspace.take() { flow.finish(app, Outcome::Unknown) }
    }
    let late: Vec<String> = app.measure.dialling.iter().filter(|(_, f)| f.at.elapsed() >= EXPIRE).map(|(m, _)| m.clone()).collect();
    for machine in late { if let Some(flow) = app.measure.dialling.remove(&machine) { flow.finish(app, Outcome::Unknown) } }
    while app.measure.resumes.first().is_some_and(|(_, f)| f.at.elapsed() >= EXPIRE) {
        let (_, flow) = app.measure.resumes.remove(0);
        flow.finish(app, Outcome::Unknown);
    }
    flush(app);
}

/// The queue's last place is kept for `observation_overflow`: the first observation it has no room
/// for is dropped and said, once per sign-in, so the loss shows beside what was counted.
fn record(app: &mut App, payload: Value) {
    if !recording(app) { return }
    let m = &mut app.measure;
    if m.queue.len() + 1 < QUEUE_CAP { m.queue.push_back(payload); return }
    if !m.overflowed && m.queue.len() < QUEUE_CAP {
        m.overflowed = true;
        m.queue.push_back(json!({ "measure": "observation_overflow" }));
    }
}

/// What waits goes once this computer's daemon link is connected.
fn flush(app: &mut App) {
    let local = app.fleet.local_id.clone();
    if app.measure.queue.is_empty() || crate::local::is_local(&local) || !app.fleet.machine(&local).is_some_and(|m| m.usable()) { return }
    while let Some(payload) = app.measure.queue.pop_front() {
        if !deliver(app, &local, payload.clone()) { app.measure.queue.push_front(payload); break }
    }
}

fn deliver(app: &mut App, machine: &str, payload: Value) -> bool {
    // Under test no daemon is told: what would be sent is written down.
    #[cfg(test)]
    { let _ = machine; app.measure.sent.push(payload); true }
    #[cfg(not(test))]
    { app.link(machine).is_some_and(|link| link.send("product_observe", payload)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::{Machine, Reach};

    fn fixture() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19811, sink, (80, 24));
        app.fleet.local_id = "this-computer".into();
        app.fleet.machines.push(Machine { shared: false, id: "this-computer".into(), name: "Mac".into(), local: true, status: "running".into(), reach: Reach::Connecting });
        app
    }
    fn sign_in(app: &mut App) { app.follow_account(true); }
    fn connected(app: &mut App) { app.fleet.machine_mut("this-computer").unwrap().reach = Reach::Ready; }
    fn measures(app: &App) -> Vec<&str> { app.measure.sent.iter().filter_map(|v| v["measure"].as_str()).collect() }
    fn flows(app: &App) -> Vec<(&str, &str)> { app.measure.sent.iter().filter_map(|v| Some((v["flow"].as_str()?, v["outcome"].as_str()?))).collect() }
    fn starts(app: &App) -> Vec<&str> { app.measure.sent.iter().filter(|v| v.as_object().unwrap().len() == 1).filter_map(|v| v["flow"].as_str()).collect() }
    fn outcome<'a>(app: &'a App, flow: &str) -> &'a Value { app.measure.sent.iter().find(|v| v["flow"] == flow && v.get("outcome").is_some()).unwrap() }

    #[tokio::test]
    async fn nothing_recorded_signed_out_counts_even_after_a_sign_in() {
        let mut app = fixture();
        let flow = begin(&mut app, "computer_link");
        once(&mut app, "viewer_open", Outcome::Ok);
        resuming(&mut app, "this-computer", "a");
        dialling(&mut app, "this-computer");
        turn_started(&mut app, "this-computer", "a");
        tick(&mut app);
        assert!(app.measure.queue.is_empty(), "not even a start: {:?}", app.measure.queue);
        sign_in(&mut app);
        flow.finish(&mut app, Outcome::Ok);
        dialled(&mut app, "this-computer", true);
        turn_ended(&mut app, "this-computer", "a");
        text(&mut app, "this-computer", "a");
        assert_eq!(app.measure.queue, [json!({ "flow": "workspace_ready" })], "only the sign-in's own start");
    }

    #[tokio::test]
    async fn a_flow_starts_when_it_begins_and_its_outcome_counts_only_under_the_same_account() {
        let mut app = fixture();
        sign_in(&mut app);
        connected(&mut app);
        let link = begin(&mut app, "computer_link");
        let late = begin(&mut app, "remote_connect");
        tick(&mut app);
        assert_eq!(starts(&app), ["workspace_ready", "computer_link", "remote_connect", "app_start"], "started at begin()");
        link.finish(&mut app, Outcome::Ok);
        once(&mut app, "viewer_open", Outcome::Failed);
        tick(&mut app);
        assert_eq!(outcome(&app, "computer_link")["outcome"], "ok");
        assert!(outcome(&app, "computer_link")["durationMs"].as_u64().unwrap() < 1000);
        assert!(starts(&app).contains(&"viewer_open") && flows(&app).contains(&("viewer_open", "failed")));
        assert!(app.measure.sent.iter().all(|v| v.as_object().unwrap().len() <= 3), "names, an outcome and a duration only");
        app.follow_account(false);
        late.finish(&mut app, Outcome::Ok);
        sign_in(&mut app);
        tick(&mut app);
        assert!(!flows(&app).iter().any(|(f, _)| *f == "remote_connect"), "the late flow belonged to the old sign-in");
    }

    #[tokio::test]
    async fn the_queue_is_bounded_says_its_overflow_once_and_goes_with_its_sign_in() {
        let overflow = json!({ "measure": "observation_overflow" });
        let overflows = |app: &App| app.measure.sent.iter().filter(|v| **v == overflow).count();
        let mut app = fixture();
        sign_in(&mut app);
        for _ in 0..QUEUE_CAP + 10 { once(&mut app, "remote_connect", Outcome::Failed) }
        assert_eq!(app.measure.queue.len(), QUEUE_CAP);
        assert_eq!(app.measure.queue.back(), Some(&overflow), "the last place says the loss");
        // Sent, then full again: the loss was said this session, so nothing more is.
        connected(&mut app);
        tick(&mut app);
        for _ in 0..QUEUE_CAP + 10 { once(&mut app, "remote_connect", Outcome::Failed) }
        tick(&mut app);
        assert_eq!(overflows(&app), 1);
        assert_eq!(app.measure.sent.len(), 2 * (QUEUE_CAP - 1) + 1);
        // A new sign-in is a new session: its own overflow is said again.
        app.follow_account(false);
        assert!(app.measure.queue.is_empty(), "the next sign-in is not told the last one's");
        sign_in(&mut app);
        for _ in 0..QUEUE_CAP { once(&mut app, "remote_connect", Outcome::Failed) }
        tick(&mut app);
        assert_eq!(overflows(&app), 2);
    }

    #[tokio::test]
    async fn the_workspace_is_ready_at_the_first_connection_signed_in_with_app_start_from_launch() {
        let mut app = fixture();
        app.measure.since = Instant::now() - Duration::from_secs(12);
        sign_in(&mut app);
        tick(&mut app);
        assert!(app.measure.sent.is_empty());
        connected(&mut app);
        tick(&mut app);
        tick(&mut app);
        assert_eq!(flows(&app), [("workspace_ready", "ok"), ("app_start", "ok")]);
        assert_eq!(starts(&app), ["workspace_ready", "app_start"]);
        assert!(outcome(&app, "workspace_ready")["durationMs"].as_u64().unwrap() < 12_000, "workspace_ready runs from the sign-in");
        assert!(outcome(&app, "app_start")["durationMs"].as_u64().unwrap() >= 12_000, "app_start runs from the launch");
        assert_eq!(measures(&app), [WORKSPACE_READY]);
        // Signed out and in again: a new sign-in, measured again, as the Desktop's runtime health is.
        app.follow_account(false);
        sign_in(&mut app);
        tick(&mut app);
        assert_eq!(measures(&app), [WORKSPACE_READY, WORKSPACE_READY]);
    }

    #[tokio::test]
    async fn milestones_count_once_per_session_from_live_turns_with_the_desktops_buckets() {
        let mut app = fixture();
        sign_in(&mut app);
        // The funnel's clock: its first milestone, here six minutes ago.
        app.measure.funnel_since = Some(Instant::now() - Duration::from_secs(6 * 60));
        turn_started(&mut app, "m", "a1");
        turn_started(&mut app, "m", "a2");
        turn_ended(&mut app, "m", "a1");
        text(&mut app, "m", "a1");
        assert!(watching(&app));
        text(&mut app, "m", "a2");
        text(&mut app, "m", "a2");
        turn_started(&mut app, "m", "a3");
        // Counted: nothing watches text deltas for the rest of the session.
        assert!(!watching(&app));
        connected(&mut app);
        tick(&mut app);
        assert_eq!(measures(&app), [FIRST_WORK, "first_work_over_5m", FIRST_RESPONSE, "first_response_over_5m", WORKSPACE_READY]);
        // Another sign-in, or the next hn, counts them again: once per session, not per installation.
        app.follow_account(false);
        sign_in(&mut app);
        turn_started(&mut app, "m", "a1");
        text(&mut app, "m", "a1");
        tick(&mut app);
        assert_eq!(measures(&app)[5..], [FIRST_WORK, "first_work_under_1m", FIRST_RESPONSE, "first_response_under_1m", WORKSPACE_READY]);
    }

    #[tokio::test]
    async fn a_resume_is_ok_at_its_next_turn_failed_when_refused_and_cancelled_when_asked_again() {
        let mut app = fixture();
        sign_in(&mut app);
        connected(&mut app);
        resuming(&mut app, "m", "a");
        turn_started(&mut app, "m", "other");
        turn_started(&mut app, "m", "a");
        resuming(&mut app, "m", "b");
        resume_failed(&mut app, "m", "b");
        resuming(&mut app, "m", "c");
        resuming(&mut app, "m", "c");
        app.measure.resumes[0].1.at -= EXPIRE;
        tick(&mut app);
        let resumes: Vec<&str> = flows(&app).into_iter().filter(|(f, _)| *f == "resume_recovery").map(|(_, o)| o).collect();
        assert_eq!(resumes, ["ok", "failed", "cancelled", "unknown"]);
        for i in 0..OPEN_CAP + 1 { resuming(&mut app, "m", &format!("x{i}")); tick(&mut app) }
        assert!(measures(&app).contains(&"observation_overflow"));
        assert_eq!(app.measure.resumes.len(), OPEN_CAP);
    }

    #[tokio::test]
    async fn a_dial_is_this_computers_or_another_machines_connection() {
        let mut app = fixture();
        sign_in(&mut app);
        dialling(&mut app, "this-computer");
        dialled(&mut app, "this-computer", true);
        dialling(&mut app, "peer");
        dialled(&mut app, "peer", false);
        dialling(&mut app, "peer");
        dialled(&mut app, "peer", true);
        dialled(&mut app, "peer", false);
        dialling(&mut app, crate::local::MACHINE);
        dialled(&mut app, crate::local::MACHINE, true);
        connected(&mut app);
        tick(&mut app);
        let dials: Vec<(&str, &str)> = flows(&app).into_iter().filter(|(f, _)| f.ends_with("_connect")).collect();
        assert_eq!(dials, [("workspace_connect", "ok"), ("remote_connect", "failed"), ("remote_connect", "ok")]);
    }

    /// While the daemon is down hn's own shells are `local_id` (app.rs `boot`): this computer's dials
    /// were counted as remote_connect then, and failed DAEMON_UNREACHABLE (prod, 2026-10-16).
    #[tokio::test]
    async fn a_dial_of_this_computer_while_the_daemon_is_down_is_still_its_workspace_connect() {
        let mut app = fixture();
        sign_in(&mut app);
        app.fleet.local_id = crate::local::MACHINE.into();
        dialling(&mut app, "this-computer");
        dialling(&mut app, "peer");
        dialled(&mut app, "this-computer", true);
        dialled(&mut app, "peer", true);
        app.fleet.local_id = "this-computer".into();
        connected(&mut app);
        tick(&mut app);
        let dials: Vec<(&str, &str)> = flows(&app).into_iter().filter(|(f, _)| f.ends_with("_connect")).collect();
        assert_eq!(dials, [("workspace_connect", "ok"), ("remote_connect", "ok")]);
    }

    #[tokio::test]
    async fn hn_with_no_terminal_observes_nothing() {
        let mut app = fixture();
        app.headless = true;
        sign_in(&mut app);
        connected(&mut app);
        once(&mut app, "viewer_open", Outcome::Ok);
        turn_started(&mut app, "this-computer", "a");
        dialling(&mut app, "this-computer");
        dialled(&mut app, "this-computer", true);
        tick(&mut app);
        assert!(app.measure.queue.is_empty() && app.measure.sent.is_empty());
    }
}
