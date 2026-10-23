//! The pane table: ids, owner tags, held panes, and the control ops over them.
//!
//! Every pane's events reach one channel (`Panes::new` returns its receiver); one dispatcher
//! thread feeds them to `Panes::event`, which keeps the table's view of exits current and says
//! what to tell the control connections.
//!
//! Lifetimes, as tmux has them:
//! - a pane whose process exits is removed, unless it is held (`hold` at create, or `holdOpen`):
//!   then it stays `dead` with its last grid until `respawn`, `releaseHold` or `kill`;
//! - `kill` removes the pane whether or not it is held (tmux `kill-pane`).
//!
//! `create` and `respawn` spawn under the table lock, so the new child's exit (handled under the
//! same lock) always finds its entry.
//!
//! A child started with an `afterExit` does not end its pane by exiting: its status becomes the pane's
//! `engineExit` and the pane runs that command next, held or not (`Panes::hand_off`). That is a Unix
//! launch script's `harness_after` (cli/src/lib/engineLaunch.ts), which a Windows engine has no script
//! for: the engine leaves, the pane is the person's shell, and the daemon reads why from `engineExit`.
//!
//! `respawn` is tmux's `respawn-pane -k`: a child still running is killed first (outside the
//! lock), then the next one spawned. Each child of a pane has a generation (`PaneEvent::Exited`),
//! and an exit applies only while its child is the pane's current one: a replaced child's exit,
//! however late it is dispatched, neither ends nor marks dead the pane that now runs another.
//!
//! Stream subscribers (`stream.rs`) live in `streams`, beside the table: the dispatcher queues
//! each output there without taking the table lock. A pane that leaves the table closes its
//! streams (`exited`, or `killed` at `kill`); no thread holds the table lock while it takes the
//! registry's.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use alacritty_terminal::term::TermMode;
use base64::Engine;
use serde_json::{Map, Value, json};

use crate::pane::{Pane, PaneEvent, PaneSpec};
use crate::pane_ids::PaneIds;
use crate::protocol::{AfterExit, Op};
use crate::stream::{Registry, Subscriber};

/// The longest grace a `kill` gives a child before it is killed outright.
const MAX_GRACE: Duration = Duration::from_secs(60);

/// How long `respawn` waits, after the kill, for the killed child's exit to be recorded
/// (`Killing::finish` returns once it is, or at most this long after a SIGKILL).
const EXIT_REPORT: Duration = Duration::from_secs(1);

/// How long `respawn` gives a running child after SIGHUP before it is killed outright: the
/// daemon's own kill grace (ptyHostBackend.ts). tmux's `respawn-pane -k` gives none.
const RESPAWN_GRACE: Duration = Duration::from_secs(2);

/// What a native launch's start command carries (cli/src/lib/nativePaneHold.ts
/// `NATIVE_LAUNCH_MARKER`): such a pane is not a held one.
const NATIVE_LAUNCH_MARKER: &str = "HARNESS_NATIVE_LAUNCH_TOKEN=";

/// Whether a pane started as `start_command` is held under `token`: tmux's `heldPaneFormat`
/// (cli/src/lib/nativePaneHold.ts) over `#{pane_start_command}`, which is all a held shell is.
fn held_by(start_command: &str, token: &str) -> bool {
    !token.is_empty()
        && !start_command.contains(NATIVE_LAUNCH_MARKER)
        && start_command.contains("harness-held")
        && start_command.contains(token)
}

/// A `kill`'s `graceMs`, held to `MAX_GRACE`.
fn kill_grace(ms: u64) -> Duration {
    Duration::from_millis(ms).min(MAX_GRACE)
}

/// A failed op: one of the protocol's error codes, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError {
    pub code: &'static str,
    pub reason: String,
}

impl OpError {
    fn new(code: &'static str, reason: impl Into<String>) -> Self {
        OpError {
            code,
            reason: reason.into(),
        }
    }
    fn no_pane(pane: &str) -> Self {
        OpError::new("no_pane", format!("no pane {pane}"))
    }
}

/// The fields of a successful reply, beside `id` and `ok`.
pub type Reply = Map<String, Value>;

/// Something every control connection is told, unasked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    Exit { pane: String, status: Option<i32> },
    Title { pane: String, title: String },
}

impl Notice {
    /// The event's line on a control connection.
    pub fn to_line(&self) -> String {
        match self {
            Notice::Exit { pane, status } => {
                json!({"event": "exit", "pane": pane, "status": status}).to_string()
            }
            Notice::Title { pane, title } => {
                json!({"event": "title", "pane": pane, "title": title}).to_string()
            }
        }
    }
}

struct PaneEntry {
    /// Shared so an op can use the pane outside the table lock.
    pane: Arc<Pane>,
    owner: String,
    label: Option<String>,
    /// The environment the pane was created with: tmux's session environment, which every
    /// `respawn-pane` inherits. A respawn adds its own on top for that child only, and takes out
    /// only the names it clears.
    env: HashMap<String, String>,
    /// The argv of the current (or last) child.
    command: Vec<String>,
    /// That argv joined by single spaces: tmux's `#{pane_start_command}`, which `respawn`'s
    /// `expectedHeldToken` is checked against.
    start_command: String,
    hold: bool,
    /// The generation of the pane's current (or last) child.
    generation: u64,
    /// The process exited and the pane is held.
    dead: bool,
    exit_status: Option<i32>,
    engine_exit: Option<i32>,
    /// What the current child hands the pane to once it exits by itself (`AfterExit`).
    after_exit: Option<AfterExit>,
    /// Names the current child, and the shell it hands the pane to, do not get from the host's own
    /// environment: the launch's `clearInherited` (a grid launch's provider keys). Per launch, as a
    /// Unix launch script unsets them for its own launch: each create and respawn replaces it, so an
    /// agent moved off a grid gets the person's own variables back.
    clear_inherited: Vec<String>,
}

pub struct Panes {
    table: Mutex<HashMap<String, PaneEntry>>,
    /// Pane numbers, never repeated for the host's home (pane_ids.rs).
    ids: Mutex<PaneIds>,
    history_limit: usize,
    sink: Sender<(String, PaneEvent)>,
    /// The host's instance, for each child's `HARNESS_PANE`.
    instance: String,
    /// Every pane's stream subscribers.
    pub(crate) streams: Registry,
    /// Set by a `shutdown` that found no pane, under the table's lock: from then on no pane is
    /// made, so none can be lost with the host as it exits.
    closing: AtomicBool,
    /// Running panes `kill` took out of the table: the one exit each still owes is told when it comes.
    /// Any other exit of a pane no longer in the table was told already (a failed respawn's stand-in
    /// goes first when it wins the race with the killed child's own).
    killed: Mutex<HashSet<String>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn reply(value: Value) -> Result<Reply, OpError> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Ok(Reply::new()),
    }
}

fn spec(
    command: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    cleared: &[String],
) -> PaneSpec {
    // What the child sets itself is set: only the rest is kept from what the host inherited.
    let clear_env = cleared
        .iter()
        .filter(|name| !env.keys().any(|key| same_name(key, name)))
        .cloned()
        .collect();
    PaneSpec {
        command,
        cwd: cwd.map(PathBuf::from),
        env,
        cols,
        rows,
        clear_env,
        seed: None,
    }
}

/// Whether two environment names are one: Windows compares them without case.
fn same_name(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// The names a request asks cleared that can be names at all.
fn clearable(names: Vec<String>) -> Vec<String> {
    names
        .into_iter()
        .filter(|name| !name.is_empty() && !name.contains(['=', '\0']))
        .collect()
}

fn pane_number(id: &str) -> u64 {
    id.strip_prefix('%')
        .and_then(|n| n.parse().ok())
        .unwrap_or(u64::MAX)
}

impl Panes {
    /// An empty table, and the receiving end of its panes' events (for the dispatcher).
    pub fn new(
        history_limit: usize,
        instance: impl Into<String>,
    ) -> (Panes, Receiver<(String, PaneEvent)>) {
        Panes::with_ids(history_limit, instance, PaneIds::in_memory())
    }

    /// The table of the host serving `run_dir`: its pane ids follow every id an earlier host of
    /// the same home handed out, so an old `<instance>:<id>` never names a new pane.
    pub fn persistent(
        history_limit: usize,
        instance: impl Into<String>,
        run_dir: &std::path::Path,
    ) -> std::io::Result<(Panes, Receiver<(String, PaneEvent)>)> {
        Ok(Panes::with_ids(
            history_limit,
            instance,
            PaneIds::persistent(run_dir)?,
        ))
    }

    fn with_ids(
        history_limit: usize,
        instance: impl Into<String>,
        ids: PaneIds,
    ) -> (Panes, Receiver<(String, PaneEvent)>) {
        let (sink, events) = mpsc::channel();
        let panes = Panes {
            table: Mutex::new(HashMap::new()),
            ids: Mutex::new(ids),
            history_limit,
            sink,
            instance: instance.into(),
            streams: Registry::default(),
            closing: AtomicBool::new(false),
            killed: Mutex::default(),
        };
        (panes, events)
    }

    /// Apply one pane event to the table and its streams; what to tell the control connections,
    /// if anything.
    pub fn event(&self, id: &str, event: &PaneEvent) -> Option<Notice> {
        match event {
            PaneEvent::Output { seq, bytes } => {
                self.streams.deliver(id, *seq, bytes);
                None
            }
            PaneEvent::Title(title) => Some(Notice::Title {
                pane: id.to_owned(),
                title: title.clone(),
            }),
            PaneEvent::Exited { generation, status } => {
                let removed = {
                    let mut table = lock(&self.table);
                    match table.get_mut(id) {
                        // A child a respawn replaced: the pane runs another, nobody is told.
                        Some(entry) if entry.generation != *generation => return None,
                        Some(entry) => {
                            // Handed to its next command: the pane runs on, nobody is told.
                            if self.hand_off(id, entry, *status) {
                                return None;
                            }
                            if entry.hold {
                                entry.dead = true;
                                entry.exit_status = *status;
                                None
                            } else {
                                table.remove(id)
                            }
                        }
                        None if lock(&self.killed).remove(id) => None,
                        None => return None,
                    }
                };
                if removed.is_some() {
                    self.streams.close(id, "exited");
                }
                // Dropped outside the lock.
                drop(removed);
                Some(Notice::Exit {
                    pane: id.to_owned(),
                    status: *status,
                })
            }
        }
    }

    /// Start the exited child's `afterExit` in its pane, recording its status as the pane's
    /// `engineExit`; whether the pane runs it. A spawn that fails leaves the exit to end the pane as
    /// any other: held, it stays dead with the child's status; otherwise it goes.
    fn hand_off(&self, id: &str, entry: &mut PaneEntry, status: Option<i32>) -> bool {
        let Some(after) = entry.after_exit.take() else {
            return false;
        };
        // A Windows exit code is always read (GetExitCodeProcess); -1 stands for one never learned.
        let code = status.unwrap_or(-1);
        let mut env = entry.env.clone();
        env.extend(after.env);
        env.insert("HARNESS_ENGINE_EXIT".into(), code.to_string());
        let env = self.child_env(id, env);
        match entry.pane.respawn(spec(
            after.command.clone(),
            None,
            env,
            0,
            0,
            &entry.clear_inherited,
        )) {
            Ok(generation) => {
                entry.generation = generation;
                entry.start_command = after.command.join(" ");
                entry.command = after.command;
                entry.dead = false;
                entry.exit_status = None;
                entry.engine_exit = Some(code);
                true
            }
            Err(e) => {
                log::error!("pane {id}: could not start what follows its command: {e}");
                // The generation the failed spawn used up: the exit below is the pane's own.
                entry.generation = entry.pane.generation();
                false
            }
        }
    }

    /// The child's environment: the caller's, and `HARNESS_PANE=<instance>:<pane>`, so hooks
    /// name their pane as they read `TMUX_PANE` under tmux.
    fn child_env(&self, id: &str, mut env: HashMap<String, String>) -> HashMap<String, String> {
        env.insert("HARNESS_PANE".into(), format!("{}:{id}", self.instance));
        env
    }

    pub(crate) fn pane(&self, id: &str) -> Result<Arc<Pane>, OpError> {
        lock(&self.table)
            .get(id)
            .map(|e| e.pane.clone())
            .ok_or_else(|| OpError::no_pane(id))
    }

    /// A pane whose process runs (input to a dead pane goes nowhere).
    pub(crate) fn live_pane(&self, id: &str) -> Result<Arc<Pane>, OpError> {
        let table = lock(&self.table);
        let entry = table.get(id).ok_or_else(|| OpError::no_pane(id))?;
        if entry.dead {
            return Err(OpError::new("bad_request", format!("pane {id} has exited")));
        }
        Ok(entry.pane.clone())
    }

    /// Add `sub` to `id`'s streams if the pane exists, calling `added` first (under the registry
    /// lock, so nothing is delivered to `sub` before it). False if there is no such pane.
    pub(crate) fn subscribe(&self, id: &str, sub: &Arc<Subscriber>, added: impl FnOnce()) -> bool {
        let mut streams = self.streams.lock();
        if !lock(&self.table).contains_key(id) {
            return false;
        }
        added();
        streams
            .entry(id.to_owned())
            .or_default()
            .push(Arc::downgrade(sub));
        true
    }

    fn write(&self, id: &str, bytes: &[u8]) -> Result<Reply, OpError> {
        self.live_pane(id)?
            .write(bytes)
            .map_err(|_| OpError::new("bad_request", format!("pane {id} has exited")))?;
        Ok(Reply::new())
    }

    /// tmux's `respawn-pane -k`, guarded as `heldPaneFormat` guards it: the held check, the kill
    /// of a running child (SIGHUP, the grace, SIGKILL, as `kill`), then the next child in the
    /// same pane and grid. Replies once that child is spawned.
    #[allow(clippy::too_many_arguments)]
    fn respawn(
        &self,
        pane: String,
        command: Vec<String>,
        cwd: Option<String>,
        env: HashMap<String, String>,
        expected_held_token: Option<String>,
        clear_env: Vec<String>,
        clear_inherited: Vec<String>,
        after_exit: Option<AfterExit>,
    ) -> Result<Reply, OpError> {
        let held = |entry: &PaneEntry| match &expected_held_token {
            Some(expected) if !held_by(&entry.start_command, expected) => Err(OpError::new(
                "held_mismatch",
                format!("pane {pane} is not held under that token"),
            )),
            _ => Ok(()),
        };
        let (handle, current, running) = {
            let mut table = lock(&self.table);
            let entry = table
                .get_mut(&pane)
                .ok_or_else(|| OpError::no_pane(&pane))?;
            held(entry)?;
            let current = entry.pane.generation();
            // The table already looks past the pane's child: another respawn is replacing it.
            if entry.generation != current {
                return Err(OpError::new(
                    "bad_request",
                    format!("pane {pane} is already being respawned"),
                ));
            }
            let running = !entry.dead;
            // The child about to be killed is retired now, before its exit can be dispatched:
            // from here only the next generation's exit applies, so the pane is neither removed
            // nor marked dead by the kill.
            if running {
                entry.generation = current + 1;
            }
            (entry.pane.clone(), current, running)
        };
        // Outside the lock: the grace must not stop every other op.
        if running {
            if let Some(killing) = handle.start_kill() {
                killing.finish(RESPAWN_GRACE);
            }
            handle.wait_exit(EXIT_REPORT);
        }
        let mut table = lock(&self.table);
        // Killed meanwhile: `kill` took the entry, and its exit is announced.
        let entry = table
            .get_mut(&pane)
            .filter(|e| Arc::ptr_eq(&e.pane, &handle))
            .ok_or_else(|| OpError::no_pane(&pane))?;
        // A dead pane was not marked: another respawn (another connection's) may have got to it
        // while the lock was free. Its child is not the one this request saw, and the guard must
        // hold for the pane as it is now, right before the spawn. A running pane's retired
        // generation kept every other respawn out.
        if !running {
            if entry.generation != current {
                return Err(OpError::new(
                    "bad_request",
                    format!("pane {pane} was respawned meanwhile"),
                ));
            }
            held(entry)?;
        }
        // As tmux builds a respawned child's: the session's (the create env, less what this asks
        // cleared, which stays cleared), then the request's own, which wins.
        for name in clearable(clear_env) {
            entry.env.retain(|key, _| !same_name(key, &name));
        }
        let mut child = entry.env.clone();
        child.extend(env);
        let env = self.child_env(&pane, child);
        // What the host inherited, less this launch's own names: never the last launch's.
        let clear_inherited = clearable(clear_inherited);
        let generation =
            match handle.respawn(spec(command.clone(), cwd, env, 0, 0, &clear_inherited)) {
                Ok(generation) => generation,
                Err(e) => {
                    // The table follows the pane: a generation used up by the failed spawn, or the
                    // current one when the child would not die.
                    entry.generation = handle.generation();
                    // Killed, and nothing replaced it: its exit applies after all, once, under that
                    // generation (its own exit, of the retired one, is ignored whenever it comes).
                    if running && let Some(status) = handle.exit_status() {
                        let _ = self.sink.send((
                            pane.clone(),
                            PaneEvent::Exited {
                                generation: entry.generation,
                                status,
                            },
                        ));
                    }
                    return Err(OpError::new("spawn_failed", e.to_string()));
                }
            };
        entry.generation = generation;
        entry.start_command = command.join(" ");
        entry.command = command;
        entry.dead = false;
        entry.exit_status = None;
        entry.engine_exit = None;
        entry.after_exit = after_exit;
        entry.clear_inherited = clear_inherited;
        Ok(Reply::new())
    }

    pub fn handle(&self, op: Op) -> Result<Reply, OpError> {
        match op {
            Op::Create {
                command,
                cwd,
                env,
                cols,
                rows,
                owner,
                label,
                hold,
                after_exit,
                clear_inherited,
                seed,
            } => {
                let cleared = clearable(clear_inherited);
                // A child given no directory starts in the user's home (`Pane::spawn`).
                let number = lock(&self.ids)
                    .take()
                    .map_err(|e| OpError::new("spawn_failed", format!("pane ids: {e}")))?;
                let id = format!("%{number}");
                let mut table = lock(&self.table);
                if self.closing.load(Ordering::SeqCst) {
                    return Err(OpError::new("bad_request", "the host is shutting down"));
                }
                let mut pane_spec = spec(
                    command.clone(),
                    cwd,
                    self.child_env(&id, env.clone()),
                    cols,
                    rows,
                    &cleared,
                );
                pane_spec.seed = seed.map(String::into_bytes);
                let pane =
                    Pane::spawn(id.clone(), pane_spec, self.history_limit, self.sink.clone())
                        .map_err(|e| OpError::new("spawn_failed", e.to_string()))?;
                let generation = pane.generation();
                table.insert(
                    id.clone(),
                    PaneEntry {
                        pane: Arc::new(pane),
                        owner,
                        label,
                        env,
                        start_command: command.join(" "),
                        command,
                        hold,
                        generation,
                        dead: false,
                        exit_status: None,
                        engine_exit: None,
                        after_exit,
                        clear_inherited: cleared,
                    },
                );
                reply(json!({ "pane": id }))
            }
            Op::Kill { pane, grace_ms } => {
                let entry = {
                    let mut table = lock(&self.table);
                    let entry = table.remove(&pane).ok_or_else(|| OpError::no_pane(&pane))?;
                    // Under the table's lock, so the exit cannot be dispatched before it is owed.
                    if !entry.dead {
                        lock(&self.killed).insert(pane.clone());
                    }
                    entry
                };
                self.streams.close(&pane, "killed");
                // The reply follows the first signal; the grace, the escalation and the drop
                // happen off the connection. The pane is dropped (which ends its reader) only
                // once its exit is reported, so the `exit` notice is never lost.
                let killing = entry.pane.start_kill();
                let grace = kill_grace(grace_ms);
                std::thread::Builder::new()
                    .name(format!("pty-kill {pane}"))
                    .spawn(move || {
                        if let Some(killing) = killing {
                            killing.finish(grace);
                        }
                        drop(entry);
                    })
                    .map_err(|e| OpError::new("internal", e.to_string()))?;
                Ok(Reply::new())
            }
            Op::Inventory => {
                let table = lock(&self.table);
                let mut rows: Vec<(&String, &PaneEntry)> = table.iter().collect();
                rows.sort_by_key(|(id, _)| pane_number(id));
                let panes: Vec<Value> = rows
                    .into_iter()
                    .map(|(id, e)| {
                        json!({
                            "pane": id,
                            // The last child's pid once it has exited, as tmux keeps a dead
                            // pane's `#{pane_pid}`: a held pane is still listed, not missing.
                            "rootPid": e.pane.last_pid(),
                            "cwd": e.pane.cwd().unwrap_or_default(),
                            "title": e.pane.title(),
                            "dead": e.dead,
                            "owner": e.owner,
                            "label": e.label,
                        })
                    })
                    .collect();
                reply(json!({ "panes": panes }))
            }
            Op::Titles => {
                let titles: Map<String, Value> = lock(&self.table)
                    .iter()
                    .map(|(id, e)| (id.clone(), Value::String(e.pane.title())))
                    .collect();
                reply(json!({ "titles": titles }))
            }
            Op::PaneState { pane } => {
                let table = lock(&self.table);
                let state = match table.get(&pane) {
                    None => json!("gone"),
                    Some(e) => json!({
                        "dead": e.dead,
                        "exitStatus": e.exit_status,
                        "command": e.command,
                        "engineExit": e.engine_exit,
                        "startCommand": e.start_command,
                    }),
                };
                reply(json!({ "state": state }))
            }
            Op::PaneInfo { pane } => {
                let (p, command) = {
                    let table = lock(&self.table);
                    let e = table.get(&pane).ok_or_else(|| OpError::no_pane(&pane))?;
                    (e.pane.clone(), e.command.clone())
                };
                let pid = p.root_pid();
                let fallback = || {
                    command
                        .first()
                        .map(|c| c.rsplit(['/', '\\']).next().unwrap_or(c).to_owned())
                        .unwrap_or_default()
                };
                #[cfg(unix)]
                let name = pid
                    .and_then(crate::unix_proc::foreground_name)
                    .unwrap_or_else(fallback);
                #[cfg(not(unix))]
                let name = fallback();
                reply(json!({ "info": {
                    "command": name,
                    "path": p.cwd().unwrap_or_default(),
                    "pid": pid,
                    "tty": p.tty(),
                }}))
            }
            Op::Capture {
                pane,
                history_lines,
                ansi,
                visible,
            } => {
                // As tmuxCaptureArgs: the visible screen, or 100 lines of history by default.
                let history = if visible {
                    None
                } else {
                    Some(history_lines.unwrap_or(100))
                };
                let (text, _) = self.pane(&pane)?.capture(history, ansi);
                reply(json!({ "text": text }))
            }
            Op::Write { pane, data } => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data.as_bytes())
                    .map_err(|e| OpError::new("bad_request", format!("data: {e}")))?;
                self.write(&pane, &bytes)
            }
            Op::Paste {
                pane,
                text,
                bracketed,
            } => {
                let mode = self.live_pane(&pane)?.mode();
                let bytes = harness_term::paste::bytes(
                    &text,
                    bracketed,
                    mode.contains(TermMode::BRACKETED_PASTE),
                );
                self.write(&pane, &bytes)
            }
            Op::Key { pane, key } => {
                let mode = self.live_pane(&pane)?.mode();
                let bytes =
                    harness_term::keys::bytes_for(&key, mode.contains(TermMode::APP_CURSOR))
                        .ok_or_else(|| OpError::new("bad_request", format!("unknown key {key}")))?;
                self.write(&pane, &bytes)
            }
            Op::SetTitle { pane, title } => {
                self.pane(&pane)?.set_title(&title);
                Ok(Reply::new())
            }
            Op::HoldOpen { pane } => {
                let mut table = lock(&self.table);
                let entry = table
                    .get_mut(&pane)
                    .ok_or_else(|| OpError::no_pane(&pane))?;
                entry.hold = true;
                Ok(Reply::new())
            }
            Op::ReleaseHold { pane } => {
                let removed = {
                    let mut table = lock(&self.table);
                    let entry = table
                        .get_mut(&pane)
                        .ok_or_else(|| OpError::no_pane(&pane))?;
                    entry.hold = false;
                    if entry.dead {
                        table.remove(&pane)
                    } else {
                        None
                    }
                };
                if removed.is_some() {
                    self.streams.close(&pane, "exited");
                }
                drop(removed);
                Ok(Reply::new())
            }
            Op::Respawn {
                pane,
                command,
                cwd,
                env,
                expected_held_token,
                clear_env,
                clear_inherited,
                after_exit,
            } => self.respawn(
                pane,
                command,
                cwd,
                env,
                expected_held_token,
                clear_env,
                clear_inherited,
                after_exit,
            ),
            Op::SetEngineExit { pane, status } => {
                let mut table = lock(&self.table);
                let entry = table
                    .get_mut(&pane)
                    .ok_or_else(|| OpError::no_pane(&pane))?;
                entry.engine_exit = Some(status);
                Ok(Reply::new())
            }
            // The processes in the pane's current (or last) child's job (Windows): what a
            // process identity's pid is checked against.
            #[cfg(windows)]
            Op::JobPids { pane } => {
                let pids = self
                    .pane(&pane)?
                    .job_pids()
                    .map_err(|e| OpError::new("internal", format!("job pids: {e}")))?;
                reply(json!({ "pids": pids }))
            }
            #[cfg(not(windows))]
            Op::JobPids { .. } => Err(OpError::new("unsupported", "no job objects here")),
            // The machine's process table (Windows): what the daemon reads `ps` for elsewhere.
            #[cfg(windows)]
            Op::Processes => {
                let rows = crate::ps::snapshot()
                    .map_err(|e| OpError::new("internal", format!("process table: {e}")))?;
                reply(json!({ "rows": rows }))
            }
            #[cfg(not(windows))]
            Op::Processes => Err(OpError::new("unsupported", "the daemon reads ps here")),
            // The caller (server.rs) exits the host once the reply is written.
            Op::Shutdown => {
                let table = lock(&self.table);
                if !table.is_empty() {
                    return Err(OpError::new(
                        "bad_request",
                        format!("host still has panes ({})", table.len()),
                    ));
                }
                self.closing.store(true, Ordering::SeqCst);
                Ok(Reply::new())
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use std::time::Instant;

    /// A table with its dispatcher running; the notices it raised.
    fn table() -> (Arc<Panes>, Receiver<Notice>) {
        let (panes, events) = Panes::new(1000, "p9");
        let panes = Arc::new(panes);
        let (tx, notices) = mpsc::channel();
        let p = panes.clone();
        std::thread::spawn(move || {
            for (id, event) in events {
                if let Some(n) = p.event(&id, &event) {
                    let _ = tx.send(n);
                }
            }
        });
        (panes, notices)
    }

    fn op(json: Value) -> Op {
        let mut v = json;
        v["id"] = json!(1);
        serde_json::from_value::<crate::protocol::Request>(v)
            .unwrap()
            .op
    }

    fn create(panes: &Panes, script: &str, hold: bool) -> String {
        let r = panes
            .handle(op(
                json!({"op": "create", "command": ["/bin/sh", "-c", script],
                "cols": 40, "rows": 10, "owner": "o", "hold": hold}),
            ))
            .unwrap();
        r["pane"].as_str().unwrap().to_owned()
    }

    #[test]
    fn pane_ids_never_repeat_for_a_home_across_tables() {
        let dir = tempfile::tempdir().unwrap();
        let (first, _events) = Panes::persistent(1000, "p9", dir.path()).unwrap();
        let old: Vec<u64> = (0..3)
            .map(|_| pane_number(&create(&first, "sleep 30", false)))
            .collect();
        assert_eq!(old, [1, 2, 3]);
        drop(first); // the host died
        let (second, _events) = Panes::persistent(1000, "p9", dir.path()).unwrap();
        let new = pane_number(&create(&second, "sleep 30", false));
        assert!(old.iter().all(|&id| id < new), "{new} after {old:?}");
    }

    #[test]
    fn shutdown_needs_an_empty_table_and_then_makes_no_pane() {
        let (panes, _n) = table();
        let a = create(&panes, "sleep 30", true);
        let refused = panes.handle(Op::Shutdown).unwrap_err();
        assert_eq!(refused.code, "bad_request");
        assert!(
            refused.reason.contains("host still has panes"),
            "{}",
            refused.reason
        );
        // Still serving: panes are made as before.
        let b = create(&panes, "sleep 30", false);
        for pane in [a, b] {
            panes
                .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 0})))
                .unwrap();
        }
        assert!(panes.handle(Op::Shutdown).unwrap().is_empty());
        let late = panes
            .handle(op(
                json!({"op": "create", "command": ["/bin/sh", "-c", "sleep 30"],
                "cols": 40, "rows": 10, "owner": "o", "hold": false}),
            ))
            .unwrap_err();
        assert_eq!(late.code, "bad_request");
        assert!(late.reason.contains("shutting down"), "{}", late.reason);
        assert_eq!(panes.handle(Op::Inventory).unwrap()["panes"], json!([]));
    }

    fn state(panes: &Panes, pane: &str) -> Value {
        panes
            .handle(op(json!({"op": "paneState", "pane": pane})))
            .unwrap()["state"]
            .clone()
    }

    fn until(what: &str, mut f: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        while !f() {
            assert!(Instant::now() < end, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn exit_notice(notices: &Receiver<Notice>, pane: &str) -> Option<i32> {
        loop {
            match notices
                .recv_timeout(Duration::from_secs(5))
                .expect("no exit")
            {
                Notice::Exit { pane: p, status } if p == pane => return status,
                _ => {}
            }
        }
    }

    fn capture(panes: &Panes, pane: &str) -> Result<String, OpError> {
        panes
            .handle(op(
                json!({"op": "capture", "pane": pane, "ansi": false, "visible": true}),
            ))
            .map(|r| r["text"].as_str().unwrap().to_owned())
    }

    #[test]
    fn ids_count_from_one_and_inventory_lists_owner_and_label() {
        let (panes, _n) = table();
        let a = create(&panes, "sleep 5", false);
        let r = panes
            .handle(op(
                json!({"op": "create", "command": ["/bin/sh", "-c", "sleep 5"],
                "cols": 40, "rows": 10, "owner": "me", "label": "lbl", "hold": false, "cwd": "/"}),
            ))
            .unwrap();
        assert_eq!((a.as_str(), r["pane"].as_str().unwrap()), ("%1", "%2"));
        let inv = panes.handle(Op::Inventory).unwrap();
        let rows = inv["panes"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["owner"], "me");
        assert_eq!(rows[1]["label"], "lbl");
        assert_eq!(rows[1]["cwd"], "/");
        assert_eq!(rows[1]["dead"], false);
        assert!(rows[0]["rootPid"].as_u64().is_some());
        // Given no directory: the user's home, as a new tmux pane.
        assert_eq!(rows[0]["cwd"], std::env::var("HOME").unwrap().as_str());
        panes
            .handle(op(json!({"op": "setTitle", "pane": "%2", "title": "t2"})))
            .unwrap();
        let titles = panes.handle(Op::Titles).unwrap();
        assert_eq!(titles["titles"]["%2"], "t2");
    }

    #[test]
    fn a_pane_that_is_not_held_is_removed_when_it_exits() {
        let (panes, notices) = table();
        let pane = create(&panes, "exit 4", false);
        assert_eq!(exit_notice(&notices, &pane), Some(4));
        assert_eq!(state(&panes, &pane), json!("gone"));
        assert_eq!(capture(&panes, &pane).unwrap_err().code, "no_pane");
    }

    #[test]
    fn a_held_pane_stays_dead_with_its_grid() {
        let (panes, notices) = table();
        let pane = create(&panes, "echo last-words; exit 5", true);
        assert_eq!(exit_notice(&notices, &pane), Some(5));
        let st = state(&panes, &pane);
        assert_eq!(st["dead"], true);
        assert_eq!(st["exitStatus"], 5);
        assert_eq!(
            st["command"],
            json!(["/bin/sh", "-c", "echo last-words; exit 5"])
        );
        assert_eq!(st["startCommand"], "/bin/sh -c echo last-words; exit 5");
        assert!(capture(&panes, &pane).unwrap().contains("last-words"));
        // Still listed, with its last child's pid, as tmux lists a dead pane's `#{pane_pid}`.
        let inv = panes.handle(Op::Inventory).unwrap();
        assert_eq!(inv["panes"][0]["dead"], true);
        assert!(inv["panes"][0]["rootPid"].as_u64().is_some());
        let info = panes
            .handle(op(json!({"op": "paneInfo", "pane": pane})))
            .unwrap();
        assert_eq!(info["info"]["pid"], Value::Null);
        // Input to a dead pane is refused.
        let err = panes
            .handle(op(json!({"op": "write", "pane": pane, "data": "eA=="})))
            .unwrap_err();
        assert_eq!(err.code, "bad_request");
    }

    #[test]
    fn hold_open_holds_a_running_pane() {
        let (panes, notices) = table();
        let pane = create(&panes, "read x; exit 2", false);
        panes
            .handle(op(json!({"op": "holdOpen", "pane": pane})))
            .unwrap();
        panes
            .handle(op(json!({"op": "write", "pane": pane, "data": "eAo="})))
            .unwrap();
        assert_eq!(exit_notice(&notices, &pane), Some(2));
        assert_eq!(state(&panes, &pane)["dead"], true);
    }

    #[test]
    fn release_hold_removes_a_dead_pane_and_lets_a_live_one_go_on_exit() {
        let (panes, notices) = table();
        let dead = create(&panes, "exit 0", true);
        exit_notice(&notices, &dead);
        assert_eq!(state(&panes, &dead)["dead"], true);
        panes
            .handle(op(json!({"op": "releaseHold", "pane": dead})))
            .unwrap();
        assert_eq!(state(&panes, &dead), json!("gone"));

        let live = create(&panes, "read x", true);
        panes
            .handle(op(json!({"op": "releaseHold", "pane": live})))
            .unwrap();
        assert_eq!(state(&panes, &live)["dead"], false);
        panes
            .handle(op(json!({"op": "key", "pane": live, "key": "Enter"})))
            .unwrap();
        exit_notice(&notices, &live);
        assert_eq!(state(&panes, &live), json!("gone"));
    }

    #[test]
    fn kill_removes_held_panes_dead_or_alive() {
        let (panes, notices) = table();
        let live = create(&panes, "sleep 30", true);
        let start = Instant::now();
        panes
            .handle(op(json!({"op": "kill", "pane": live, "graceMs": 2000})))
            .unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(state(&panes, &live), json!("gone"));
        // Its exit is still announced.
        exit_notice(&notices, &live);

        let dead = create(&panes, "exit 1", true);
        exit_notice(&notices, &dead);
        panes
            .handle(op(json!({"op": "kill", "pane": dead})))
            .unwrap();
        assert_eq!(state(&panes, &dead), json!("gone"));
        assert_eq!(
            panes
                .handle(op(json!({"op": "kill", "pane": dead})))
                .unwrap_err()
                .code,
            "no_pane"
        );
    }

    #[test]
    fn respawn_replaces_a_dead_pane_in_its_grid() {
        let (panes, notices) = table();
        let pane = create(&panes, "echo one; exit 3", true);
        exit_notice(&notices, &pane);
        panes
            .handle(op(
                json!({"op": "setEngineExit", "pane": pane, "status": 9}),
            ))
            .unwrap();
        assert_eq!(state(&panes, &pane)["engineExit"], 9);
        panes
            .handle(op(json!({"op": "respawn", "pane": pane,
                "command": ["/bin/sh", "-c", "echo two; sleep 30"]})))
            .unwrap();
        let st = state(&panes, &pane);
        assert_eq!(st["dead"], false);
        assert_eq!(st["engineExit"], Value::Null);
        assert_eq!(st["exitStatus"], Value::Null);
        assert_eq!(
            st["command"],
            json!(["/bin/sh", "-c", "echo two; sleep 30"])
        );
        assert_eq!(st["startCommand"], "/bin/sh -c echo two; sleep 30");
        until("two", || capture(&panes, &pane).unwrap().contains("two"));
        assert!(capture(&panes, &pane).unwrap().contains("one"));
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 200})))
            .unwrap();
    }

    /// tmux's session environment: a respawned child keeps what the pane was created with, less
    /// the names a respawn cleared (for good), with the respawn's own on top for that child only.
    #[test]
    fn respawn_keeps_the_create_env_less_what_it_clears() {
        let (panes, _notices) = table();
        let script = "echo \"A=${A-unset} B=${B-unset} C=${C-unset} P=$HARNESS_PANE\"; sleep 30";
        let r = panes
            .handle(op(
                json!({"op": "create", "command": ["/bin/sh", "-c", script],
                "env": {"A": "create-a", "B": "create-b"},
                "cols": 80, "rows": 10, "owner": "o", "hold": true}),
            ))
            .unwrap();
        let pane = r["pane"].as_str().unwrap().to_owned();
        let line = |text: &str| format!("A={text} P=p9:{pane}");
        until("create env", || {
            capture(&panes, &pane)
                .unwrap()
                .contains(&line("create-a B=create-b C=unset"))
        });
        // Kept, with the request's own on top: B overridden, C added.
        panes
            .handle(op(
                json!({"op": "respawn", "pane": pane, "command": ["/bin/sh", "-c", script],
                "env": {"B": "request-b", "C": "request-c"}}),
            ))
            .unwrap();
        until("kept", || {
            capture(&panes, &pane)
                .unwrap()
                .contains(&line("create-a B=request-b C=request-c"))
        });
        // The request's env was that child's alone; A cleared, and cleared for every later child.
        panes
            .handle(op(
                json!({"op": "respawn", "pane": pane, "command": ["/bin/sh", "-c", script],
                "clearEnv": ["A"]}),
            ))
            .unwrap();
        until("cleared", || {
            capture(&panes, &pane)
                .unwrap()
                .contains(&line("unset B=create-b C=unset"))
        });
        panes
            .handle(op(json!({"op": "respawn", "pane": pane, "command": ["/bin/sh", "-c", &format!("echo again; {script}")]})))
            .unwrap();
        until("still cleared", || {
            let text = capture(&panes, &pane).unwrap();
            text.contains("again") && text.matches(&line("unset B=create-b C=unset")).count() == 2
        });
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 200})))
            .unwrap();
    }

    /// tmux's `respawn-pane -k`: the running child is killed, its exit is nobody's news, and the
    /// next child draws below the old one's output in the same pane, held or not.
    #[test]
    fn respawn_kills_a_running_child_first() {
        for hold in [true, false] {
            let (panes, notices) = table();
            let pane = create(&panes, "echo one; trap '' TERM; sleep 30", hold);
            until("one", || capture(&panes, &pane).unwrap().contains("one"));
            let old_pid = panes.handle(Op::Inventory).unwrap()["panes"][0]["rootPid"]
                .as_u64()
                .unwrap();
            panes
                .handle(op(json!({"op": "respawn", "pane": pane,
                    "command": ["/bin/sh", "-c", "echo two; read x; exit 6"]})))
                .unwrap();
            let st = state(&panes, &pane);
            assert_eq!(st["dead"], false, "hold {hold}");
            let new_pid = panes.handle(Op::Inventory).unwrap()["panes"][0]["rootPid"]
                .as_u64()
                .unwrap();
            assert_ne!(old_pid, new_pid);
            until("two", || capture(&panes, &pane).unwrap().contains("two"));
            assert!(capture(&panes, &pane).unwrap().contains("one"));
            // The old child's exit was absorbed: the first exit announced is the new child's.
            panes
                .handle(op(json!({"op": "key", "pane": pane, "key": "Enter"})))
                .unwrap();
            assert_eq!(exit_notice(&notices, &pane), Some(6), "hold {hold}");
            if hold {
                assert_eq!(state(&panes, &pane)["exitStatus"], 6);
            } else {
                assert_eq!(state(&panes, &pane), json!("gone"));
            }
        }
    }

    /// `expectedHeldToken` is tmux's `heldPaneFormat` over the start command: `harness-held`
    /// and the token in it, and no native launch marker.
    #[test]
    fn respawn_replaces_only_the_shell_held_under_the_token() {
        let (panes, _notices) = table();
        let respawn = |pane: &str, token: &str| {
            panes.handle(op(json!({"op": "respawn", "pane": pane,
                "command": ["/bin/sh", "-c", "echo replaced; sleep 30"],
                "expectedHeldToken": token})))
        };
        let tok = "0b5f9d38-3c1e-4c55-9f1a-1d2e3f4a5b6c";
        let held = create(&panes, &format!("echo harness-held {tok}; sleep 30"), true);
        let native = create(
            &panes,
            &format!("HARNESS_NATIVE_LAUNCH_TOKEN={tok} harness-held; sleep 30"),
            true,
        );
        let plain = create(&panes, &format!("echo {tok}; sleep 30"), true);
        assert_eq!(
            respawn(&held, "11111111-2222-3333-4444-555555555555")
                .unwrap_err()
                .code,
            "held_mismatch"
        );
        assert_eq!(respawn(&held, "").unwrap_err().code, "held_mismatch");
        assert_eq!(respawn(&native, tok).unwrap_err().code, "held_mismatch");
        assert_eq!(respawn(&plain, tok).unwrap_err().code, "held_mismatch");
        // A refused respawn touched nothing.
        assert_eq!(state(&panes, &held)["dead"], false);
        respawn(&held, tok).unwrap();
        until("replaced", || {
            capture(&panes, &held).unwrap().contains("replaced")
        });
        // The replacement is no longer the held shell.
        assert_eq!(respawn(&held, tok).unwrap_err().code, "held_mismatch");
        for pane in [held, native, plain] {
            panes
                .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 200})))
                .unwrap();
        }
    }

    /// A table with no dispatcher: the test feeds `event` itself, so it decides when exits land.
    fn bare_table() -> (Arc<Panes>, Receiver<(String, PaneEvent)>) {
        let (panes, events) = Panes::new(1000, "p9");
        (Arc::new(panes), events)
    }

    /// Feed the table its events by hand until `exits` exits have gone in; the exit notices.
    fn dispatch_exits(
        panes: &Panes,
        events: &Receiver<(String, PaneEvent)>,
        exits: usize,
    ) -> Vec<Notice> {
        let mut notices = Vec::new();
        let mut seen = 0;
        while seen < exits {
            let (id, event) = events
                .recv_timeout(Duration::from_secs(5))
                .expect("no event");
            if matches!(event, PaneEvent::Exited { .. }) {
                seen += 1;
            }
            notices.extend(
                panes
                    .event(&id, &event)
                    .filter(|n| matches!(n, Notice::Exit { .. })),
            );
        }
        notices
    }

    /// Exits on SIGHUP with `status`, so each child's exit is told apart; prints `up-<status+40>`
    /// once its trap is set (computed, so the command line itself never matches).
    fn hup_exits(status: i32) -> String {
        format!("trap 'exit {status}' HUP; echo up-$((40+{status})); while :; do sleep 0.1; done")
    }

    fn respawn_sh(panes: &Panes, pane: &str, script: &str) -> Result<Reply, OpError> {
        panes.handle(op(json!({"op": "respawn", "pane": pane,
            "command": ["/bin/sh", "-c", script]})))
    }

    /// Two respawns before the first killed child's exit is dispatched: the replaced children's
    /// exits are ignored however late they land, and the last child's real exit still applies.
    #[test]
    fn exits_of_replaced_children_never_count_for_the_current_one() {
        for hold in [true, false] {
            let (panes, events) = bare_table();
            let pane = create(&panes, &hup_exits(11), hold);
            until("a", || capture(&panes, &pane).unwrap().contains("up-51"));
            respawn_sh(&panes, &pane, &hup_exits(12)).unwrap();
            respawn_sh(&panes, &pane, "echo c-ready; read x; exit 7").unwrap();
            until("c", || capture(&panes, &pane).unwrap().contains("c-ready"));
            panes
                .handle(op(json!({"op": "key", "pane": pane, "key": "Enter"})))
                .unwrap();
            let notices = dispatch_exits(&panes, &events, 3);
            assert_eq!(
                notices,
                vec![Notice::Exit {
                    pane: pane.clone(),
                    status: Some(7)
                }],
                "hold {hold}"
            );
            if hold {
                let st = state(&panes, &pane);
                assert_eq!(
                    (st["dead"].clone(), st["exitStatus"].clone()),
                    (json!(true), json!(7))
                );
            } else {
                assert_eq!(state(&panes, &pane), json!("gone"));
            }
        }
    }

    /// A spawn that fails after its respawn killed the running child: that child's exit applies,
    /// once and with its own status, never a child replaced before it; the pane respawns again.
    #[test]
    fn a_failed_spawn_after_the_kill_applies_the_killed_childs_exit() {
        for hold in [true, false] {
            let (panes, events) = bare_table();
            let pane = create(&panes, &hup_exits(11), hold);
            until("a", || capture(&panes, &pane).unwrap().contains("up-51"));
            respawn_sh(&panes, &pane, &hup_exits(12)).unwrap();
            until("b", || capture(&panes, &pane).unwrap().contains("up-52"));
            let failed = panes
                .handle(op(json!({"op": "respawn", "pane": pane, "command": []})))
                .unwrap_err();
            assert_eq!(failed.code, "spawn_failed");
            let notices = dispatch_exits(&panes, &events, 3);
            assert_eq!(
                notices,
                vec![Notice::Exit {
                    pane: pane.clone(),
                    status: Some(12)
                }],
                "hold {hold}"
            );
            if !hold {
                assert_eq!(state(&panes, &pane), json!("gone"));
                continue;
            }
            assert_eq!(state(&panes, &pane)["exitStatus"], 12);
            respawn_sh(&panes, &pane, "echo d-ready; sleep 30").unwrap();
            assert_eq!(state(&panes, &pane)["dead"], false);
            until("d", || capture(&panes, &pane).unwrap().contains("d-ready"));
            panes
                .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 200})))
                .unwrap();
        }
    }

    /// The failed spawn's stand-in exit can be dispatched before the killed child's own (its reader
    /// thread set the status, then lost the CPU before sending): the pane is gone by then, and the
    /// child's late exit must not be told a second time (CI run 39783881853, 1 in 180 under load).
    #[test]
    fn a_late_exit_of_the_killed_child_after_the_stand_in_is_not_told_again() {
        let (panes, events) = bare_table();
        let pane = create(&panes, &hup_exits(11), false);
        until("a", || capture(&panes, &pane).unwrap().contains("up-51"));
        respawn_sh(&panes, &pane, &hup_exits(12)).unwrap();
        until("b", || capture(&panes, &pane).unwrap().contains("up-52"));
        let failed = panes
            .handle(op(json!({"op": "respawn", "pane": pane, "command": []})))
            .unwrap_err();
        assert_eq!(failed.code, "spawn_failed");
        let mut exits = Vec::new();
        while exits.len() < 3 {
            let (id, event) = events
                .recv_timeout(Duration::from_secs(5))
                .expect("no event");
            if let PaneEvent::Exited { generation, .. } = event {
                exits.push((generation, id, event));
            }
        }
        // The stand-in carries the newest generation: dispatch it first, the children's own after.
        exits.sort_by_key(|(generation, ..)| std::cmp::Reverse(*generation));
        let notices: Vec<Notice> = exits
            .iter()
            .filter_map(|(_, id, event)| panes.event(id, event))
            .collect();
        assert_eq!(
            notices,
            vec![Notice::Exit {
                pane: pane.clone(),
                status: Some(12)
            }]
        );
        assert_eq!(state(&panes, &pane), json!("gone"));
    }

    #[test]
    fn paste_brackets_when_the_program_asked_and_keys_are_named() {
        let (panes, _n) = table();
        let pane = create(
            &panes,
            r#"stty -echo; printf '\033[?2004h'; echo ready; exec cat -v"#,
            false,
        );
        until("ready", || {
            capture(&panes, &pane).unwrap().contains("ready")
        });
        panes
            .handle(op(
                json!({"op": "paste", "pane": pane, "text": "a\nb\u{1b}[201~c", "bracketed": true}),
            ))
            .unwrap();
        panes
            .handle(op(json!({"op": "key", "pane": pane, "key": "Enter"})))
            .unwrap();
        until("pasted", || {
            let text = capture(&panes, &pane).unwrap();
            text.contains("^[[200~a\nb^[[201~c^[[201~")
        });
        assert_eq!(
            panes
                .handle(op(json!({"op": "key", "pane": pane, "key": "NoSuchKey"})))
                .unwrap_err()
                .code,
            "bad_request"
        );
    }

    #[test]
    fn pane_info_names_the_foreground_command() {
        let (panes, _n) = table();
        let pane = create(&panes, "echo ready; exec sleep 30", false);
        let info = || {
            panes
                .handle(op(json!({"op": "paneInfo", "pane": pane})))
                .unwrap()["info"]
                .clone()
        };
        // "ready" can be on the screen before the shell has exec'd sleep.
        until("sleep in the foreground", || info()["command"] == "sleep");
        let info = info();
        assert!(info["pid"].as_u64().is_some());
        assert!(info["tty"].as_str().unwrap().starts_with("/dev/"), "{info}");
        assert_eq!(
            panes
                .handle(op(json!({"op": "paneInfo", "pane": "%99"})))
                .unwrap_err()
                .code,
            "no_pane"
        );
    }

    #[test]
    fn children_name_their_pane_in_harness_pane() {
        let (panes, notices) = table();
        let r = panes
            .handle(op(
                json!({"op": "create", "command": ["/bin/sh", "-c", "echo \"hp=$HARNESS_PANE.\""],
                "env": {"HARNESS_PANE": "caller", "OTHER": "kept"},
                "cols": 40, "rows": 10, "owner": "o", "hold": true}),
            ))
            .unwrap();
        let pane = r["pane"].as_str().unwrap().to_owned();
        exit_notice(&notices, &pane);
        assert!(
            capture(&panes, &pane)
                .unwrap()
                .contains(&format!("hp=p9:{pane}."))
        );
        panes
            .handle(op(json!({"op": "respawn", "pane": pane,
                "command": ["/bin/sh", "-c", "echo \"again=$HARNESS_PANE $OTHER.\"; sleep 5"],
                "env": {"OTHER": "o2"}})))
            .unwrap();
        until("again", || {
            capture(&panes, &pane)
                .unwrap()
                .contains(&format!("again=p9:{pane} o2."))
        });
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 200})))
            .unwrap();
    }

    #[test]
    fn kill_answers_at_once_and_an_escalated_kill_still_reports_the_exit() {
        let (panes, notices) = table();
        let pane = create(
            &panes,
            "trap '' HUP; echo ready; while :; do sleep 1; done",
            false,
        );
        until("ready", || {
            capture(&panes, &pane).unwrap().contains("ready")
        });
        let start = Instant::now();
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 500})))
            .unwrap();
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "kill waited out the grace"
        );
        assert_eq!(state(&panes, &pane), json!("gone"));
        // SIGKILL after the grace; the exit is still announced.
        assert_eq!(exit_notice(&notices, &pane), Some(128 + libc::SIGKILL));
        assert!(start.elapsed() >= Duration::from_millis(500));
    }

    /// A pane created running `script` that hands itself to `after` once it exits by itself.
    fn create_handing_off(panes: &Panes, script: &str, after: Value, hold: bool) -> String {
        let r = panes
            .handle(op(
                json!({"op": "create", "command": ["/bin/sh", "-c", script],
                "cols": 40, "rows": 10, "owner": "o", "hold": hold, "env": {"KEPT": "k"},
                "afterExit": after}),
            ))
            .unwrap();
        r["pane"].as_str().unwrap().to_owned()
    }

    #[test]
    fn an_exit_with_after_exit_hands_the_pane_on_and_records_the_engine_exit() {
        for hold in [true, false] {
            let (panes, notices) = table();
            let after = json!({"command": ["/bin/sh", "-c",
                "echo \"after=$HARNESS_ENGINE_EXIT $NAMED $KEPT.\"; sleep 30"], "env": {"NAMED": "codex"}});
            let pane = create_handing_off(&panes, "echo engine-words; exit 7", after, hold);
            until("the hand-off", || {
                capture(&panes, &pane).unwrap().contains("after=7 codex k.")
            });
            let st = state(&panes, &pane);
            assert_eq!(st["dead"], false, "hold {hold}");
            assert_eq!(st["engineExit"], 7);
            assert_eq!(st["exitStatus"], Value::Null);
            assert_eq!(
                st["startCommand"],
                "/bin/sh -c echo \"after=$HARNESS_ENGINE_EXIT $NAMED $KEPT.\"; sleep 30"
            );
            // Nobody is told of an exit: the pane runs on, its engine's words in its grid.
            assert!(notices.recv_timeout(Duration::from_millis(300)).is_err());
            assert!(capture(&panes, &pane).unwrap().contains("engine-words"));
            panes
                .handle(op(json!({"op": "kill", "pane": pane})))
                .unwrap();
        }
    }

    #[test]
    fn the_hand_off_happens_once_and_then_the_pane_ends_as_any_other() {
        let (panes, notices) = table();
        let after = json!({"command": ["/bin/sh", "-c", "exit 3"]});
        let held = create_handing_off(&panes, "exit 0", after.clone(), true);
        assert_eq!(exit_notice(&notices, &held), Some(3));
        let st = state(&panes, &held);
        assert_eq!(
            (
                st["dead"].clone(),
                st["exitStatus"].clone(),
                st["engineExit"].clone()
            ),
            (json!(true), json!(3), json!(0))
        );
        let unheld = create_handing_off(&panes, "exit 0", after, false);
        assert_eq!(exit_notice(&notices, &unheld), Some(3));
        assert_eq!(state(&panes, &unheld), json!("gone"));
    }

    #[test]
    fn a_hand_off_that_cannot_start_ends_the_pane_with_the_engine_status() {
        let (panes, notices) = table();
        let pane = create_handing_off(&panes, "exit 6", json!({"command": []}), true);
        assert_eq!(exit_notice(&notices, &pane), Some(6));
        let st = state(&panes, &pane);
        assert_eq!(
            (
                st["dead"].clone(),
                st["exitStatus"].clone(),
                st["engineExit"].clone()
            ),
            (json!(true), json!(6), Value::Null)
        );
        // The pane's generation follows the failed spawn: a respawn still works.
        panes
            .handle(op(json!({"op": "respawn", "pane": pane, "command": ["/bin/sh", "-c", "echo back; sleep 30"]})))
            .unwrap();
        until("back", || capture(&panes, &pane).unwrap().contains("back"));
    }

    #[test]
    fn a_kill_or_a_respawn_never_hands_off_and_a_respawn_sets_its_own() {
        let (panes, notices) = table();
        let after = json!({"command": ["/bin/sh", "-c", "echo handed; sleep 30"]});
        // A kill takes the pane: nothing follows.
        let killed = create_handing_off(&panes, "echo up; sleep 30", after.clone(), true);
        until("up", || capture(&panes, &killed).unwrap().contains("up"));
        panes
            .handle(op(json!({"op": "kill", "pane": killed})))
            .unwrap();
        exit_notice(&notices, &killed);
        assert_eq!(state(&panes, &killed), json!("gone"));
        // A respawn replaces the child (its exit is the retired one's) and its hand-off: none given, none kept.
        let pane = create_handing_off(&panes, "echo up; sleep 30", after.clone(), true);
        until("up", || capture(&panes, &pane).unwrap().contains("up"));
        panes
            .handle(op(
                json!({"op": "respawn", "pane": pane, "command": ["/bin/sh", "-c", "exit 2"]}),
            ))
            .unwrap();
        assert_eq!(exit_notice(&notices, &pane), Some(2));
        assert!(!capture(&panes, &pane).unwrap().contains("handed"));
        assert_eq!(state(&panes, &pane)["engineExit"], Value::Null);
        // One given with the respawn is the new child's.
        panes
            .handle(op(json!({"op": "respawn", "pane": pane, "command": ["/bin/sh", "-c", "exit 4"], "afterExit": after})))
            .unwrap();
        until("handed", || {
            capture(&panes, &pane).unwrap().contains("handed")
        });
        assert_eq!(state(&panes, &pane)["engineExit"], 4);
        panes
            .handle(op(json!({"op": "kill", "pane": pane})))
            .unwrap();
    }

    /// A grid launch's provider keys must not reach its engine from the host's own environment, which
    /// only adds what a pane is given (cli/src/lib/windows/engineStart.ts). Per launch, as a Unix
    /// launch script unsets them for its own: an agent moved off the grid gets the person's back.
    #[test]
    fn inherited_names_are_cleared_per_launch_and_for_its_hand_off_alone() {
        // SAFETY: names of this test's own; nothing else reads or writes them.
        unsafe {
            std::env::set_var("HN_PTY_CLEARED_KEY", "secret");
            std::env::set_var("HN_PTY_KEPT_KEY", "kept");
        }
        let (panes, _notices) = table();
        let show = "echo \"c=${HN_PTY_CLEARED_KEY-unset} k=${HN_PTY_KEPT_KEY-unset} s=${HN_PTY_SET-unset}.\"; sleep 30";
        let after = json!({"command": ["/bin/sh", "-c", "echo \"after=${HN_PTY_CLEARED_KEY-unset}.\"; sleep 30"]});
        let r = panes
            .handle(op(json!({"op": "create", "command": ["/bin/sh", "-c", "echo up; exit 0"],
                "cols": 60, "rows": 10, "owner": "o", "hold": true,
                "clearInherited": ["HN_PTY_CLEARED_KEY", "HN_PTY_SET", "", "A=B"], "env": {"HN_PTY_SET": "given"},
                "afterExit": after})))
            .unwrap();
        let pane = r["pane"].as_str().unwrap().to_owned();
        // The shell the engine hands the pane to keeps its launch's list.
        until("hand-off", || {
            capture(&panes, &pane).unwrap().contains("after=unset.")
        });
        let respawn = |extra: Value| {
            let mut request =
                json!({"op": "respawn", "pane": pane, "command": ["/bin/sh", "-c", show]});
            request
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            panes.handle(op(request)).unwrap();
        };
        // Cleared from what the host has; what the pane is given is still set.
        respawn(json!({"clearInherited": ["HN_PTY_CLEARED_KEY"]}));
        until("its own list", || {
            capture(&panes, &pane)
                .unwrap()
                .contains("c=unset k=kept s=given.")
        });
        // A respawn that sends none clears nothing the host inherited.
        respawn(json!({}));
        until("none", || {
            capture(&panes, &pane)
                .unwrap()
                .contains("c=secret k=kept s=given.")
        });
        // Another list, alone: the last one's names are back.
        respawn(json!({"clearInherited": ["HN_PTY_KEPT_KEY"]}));
        until("another", || {
            capture(&panes, &pane)
                .unwrap()
                .contains("c=secret k=unset s=given.")
        });
        // `clearEnv` takes names out of the create env alone, never what the host inherited.
        respawn(json!({"clearEnv": ["HN_PTY_SET", "HN_PTY_KEPT_KEY"]}));
        until("create env", || {
            capture(&panes, &pane)
                .unwrap()
                .contains("c=secret k=kept s=unset.")
        });
        panes
            .handle(op(json!({"op": "kill", "pane": pane})))
            .unwrap();
    }

    #[test]
    fn kill_holds_the_grace_to_a_minute() {
        assert_eq!(kill_grace(500), Duration::from_millis(500));
        assert_eq!(kill_grace(60_001), Duration::from_secs(60));
        assert_eq!(kill_grace(u64::MAX), Duration::from_secs(60));
        let (panes, notices) = table();
        let pane = create(&panes, "echo ready; sleep 30", false);
        until("ready", || {
            capture(&panes, &pane).unwrap().contains("ready")
        });
        // A grace past what an `Instant` can hold does not end the kill thread before it reports.
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": u64::MAX})))
            .unwrap();
        assert_eq!(exit_notice(&notices, &pane), Some(128 + libc::SIGHUP));
    }

    #[test]
    fn job_pids_and_processes_are_unsupported_here() {
        let (panes, _n) = table();
        assert_eq!(panes.handle(Op::Processes).unwrap_err().code, "unsupported");
        let pane = create(&panes, "sleep 5", false);
        assert_eq!(
            panes
                .handle(op(json!({"op": "jobPids", "pane": pane})))
                .unwrap_err()
                .code,
            "unsupported"
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use std::time::Instant;

    fn table() -> (Arc<Panes>, Receiver<Notice>) {
        let (panes, events) = Panes::new(1000, "p9");
        let panes = Arc::new(panes);
        let (tx, notices) = mpsc::channel();
        let p = panes.clone();
        std::thread::spawn(move || {
            for (id, event) in events {
                if let Some(n) = p.event(&id, &event) {
                    let _ = tx.send(n);
                }
            }
        });
        (panes, notices)
    }

    fn op(json: Value) -> Op {
        let mut v = json;
        v["id"] = json!(1);
        serde_json::from_value::<crate::protocol::Request>(v)
            .unwrap()
            .op
    }

    fn create(panes: &Panes, script: &str, hold: bool) -> String {
        let r = panes
            .handle(op(json!({"op": "create",
                "command": ["powershell.exe", "-NoProfile", "-Command", script],
                "cols": 80, "rows": 24, "owner": "o", "hold": hold})))
            .unwrap();
        r["pane"].as_str().unwrap().to_owned()
    }

    fn job_pids(panes: &Panes, pane: &str) -> Result<Vec<u64>, OpError> {
        panes
            .handle(op(json!({"op": "jobPids", "pane": pane})))
            .map(|r| {
                r["pids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p.as_u64().unwrap())
                    .collect()
            })
    }

    fn root_pid(panes: &Panes) -> u64 {
        panes.handle(Op::Inventory).unwrap()["panes"][0]["rootPid"]
            .as_u64()
            .unwrap()
    }

    fn capture(panes: &Panes, pane: &str) -> String {
        panes
            .handle(op(
                json!({"op": "capture", "pane": pane, "ansi": false, "visible": true}),
            ))
            .unwrap()["text"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn until(what: &str, mut f: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(20);
        while !f() {
            assert!(Instant::now() < end, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn exit_notice(notices: &Receiver<Notice>, pane: &str) -> Option<i32> {
        loop {
            match notices
                .recv_timeout(Duration::from_secs(20))
                .expect("no exit")
            {
                Notice::Exit { pane: p, status } if p == pane => return status,
                _ => {}
            }
        }
    }

    #[test]
    fn job_pids_lists_the_panes_child_and_what_it_started() {
        let (panes, _n) = table();
        let pane = create(
            &panes,
            "Start-Process -NoNewWindow cmd.exe -ArgumentList '/c','ping -n 60 127.0.0.1 >nul'; 'ready'; Start-Sleep 60",
            false,
        );
        let root = root_pid(&panes);
        let mut pids = Vec::new();
        until("the child and its descendants", || {
            pids = job_pids(&panes, &pane).unwrap();
            pids.len() >= 3 // powershell, cmd, ping
        });
        assert!(pids.contains(&root), "{pids:?} without {root}");
        assert_eq!(job_pids(&panes, "%99").unwrap_err().code, "no_pane");
        // The process table lists the pane's child, started by this process.
        let rows = panes.handle(Op::Processes).unwrap()["rows"].clone();
        let child = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["pid"].as_u64() == Some(root))
            .expect("the child's row")
            .clone();
        assert_eq!(
            child["parentPid"].as_u64(),
            Some(u64::from(std::process::id()))
        );
        assert!(child["startMarker"].as_str().unwrap().starts_with("w:"));
        assert!(
            child["args"].as_str().unwrap().contains("Start-Sleep 60"),
            "{child}"
        );
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 300})))
            .unwrap();
    }

    #[test]
    fn kill_answers_at_once_ends_the_job_and_the_exit_still_arrives() {
        let (panes, notices) = table();
        let pane = create(
            &panes,
            "Start-Process -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 60'; 'ready'; Start-Sleep 60",
            false,
        );
        until("ready", || capture(&panes, &pane).contains("ready"));
        until("the descendant", || {
            job_pids(&panes, &pane).unwrap().len() >= 2
        });
        let handle = panes.pane(&pane).unwrap();
        let start = Instant::now();
        panes
            .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 500})))
            .unwrap();
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "kill waited out the grace"
        );
        assert_eq!(job_pids(&panes, &pane).unwrap_err().code, "no_pane");
        exit_notice(&notices, &pane);
        until("the job ended", || handle.job_pids().unwrap().is_empty());
        assert!(start.elapsed() >= Duration::from_millis(450));
    }

    /// Whether process `pid` still runs.
    fn alive(pid: u64) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        };
        unsafe {
            let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid as u32);
            if h.is_null() {
                return false;
            }
            let running = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
            CloseHandle(h);
            running
        }
    }

    /// A held pane whose child exited, leaving a descendant with a console of its own running in
    /// its job; the pids left in the job.
    fn dead_pane_with_a_leftover(panes: &Panes, notices: &Receiver<Notice>) -> (String, Vec<u64>) {
        let pane = create(
            panes,
            "Start-Process -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 60'; 'ready'; Start-Sleep 2; exit 5",
            true,
        );
        let root = root_pid(panes);
        let mut kids = Vec::new();
        until("the descendant", || {
            kids = job_pids(panes, &pane).unwrap();
            kids.retain(|&p| p != root);
            !kids.is_empty()
        });
        assert_eq!(exit_notice(notices, &pane), Some(5));
        // The console's close did not reach it: it is still in the job.
        for &kid in &kids {
            assert!(alive(kid), "{kid} ended with the child");
        }
        (pane, kids)
    }

    /// The job is the whole tree: killing, dropping (`releaseHold`) or respawning a dead pane
    /// ends what its last child left running, with no second exit notice.
    #[test]
    fn a_dead_panes_leftovers_end_with_kill_drop_and_respawn() {
        for how in ["kill", "releaseHold", "respawn"] {
            let (panes, notices) = table();
            let (pane, kids) = dead_pane_with_a_leftover(&panes, &notices);
            let request = match how {
                "respawn" => json!({"op": "respawn", "pane": pane,
                    "command": ["cmd.exe", "/c", "echo next& ping -n 60 127.0.0.1 >nul"]}),
                op => json!({"op": op, "pane": pane}),
            };
            panes.handle(op(request)).unwrap();
            until(&format!("the leftovers ended on {how}"), || {
                kids.iter().all(|&kid| !alive(kid))
            });
            if how == "respawn" {
                let pids = job_pids(&panes, &pane).unwrap();
                assert!(kids.iter().all(|k| !pids.contains(k)), "{pids:?}");
                until("next", || capture(&panes, &pane).contains("next"));
                panes
                    .handle(op(json!({"op": "kill", "pane": pane, "graceMs": 300})))
                    .unwrap();
                exit_notice(&notices, &pane);
            } else {
                assert_eq!(job_pids(&panes, &pane).unwrap_err().code, "no_pane");
            }
            // No second exit notice for the child that had already exited.
            std::thread::sleep(Duration::from_millis(500));
            assert!(
                notices
                    .try_iter()
                    .all(|n| !matches!(n, Notice::Exit { .. })),
                "{how}: another exit notice"
            );
        }
    }

    /// `respawn-pane -k`: the running child's job is ended, and the next child has its own.
    #[test]
    fn respawn_kills_a_running_child_and_its_job_first() {
        for hold in [true, false] {
            let (panes, notices) = table();
            let pane = create(&panes, "'one'; Start-Sleep 60", hold);
            until("one", || capture(&panes, &pane).contains("one"));
            let old = job_pids(&panes, &pane).unwrap();
            assert_eq!(old, vec![root_pid(&panes)]);
            panes
                .handle(op(json!({"op": "respawn", "pane": pane,
                    "command": ["cmd.exe", "/c", "echo two& set /p x=& exit 6"]})))
                .unwrap();
            let new = job_pids(&panes, &pane).unwrap();
            assert_eq!(new, vec![root_pid(&panes)], "hold {hold}");
            assert_ne!(old, new);
            until("two", || capture(&panes, &pane).contains("two"));
            // A new pseudo console clears the screen it starts on: the old output is above it.
            let history = panes
                .handle(op(json!({"op": "capture", "pane": pane, "ansi": false,
                    "visible": false, "historyLines": 100})))
                .unwrap()["text"]
                .as_str()
                .unwrap()
                .to_owned();
            assert!(history.contains("one"), "{history:?}");
            // The old child's exit was absorbed: the first exit announced is the new child's.
            panes
                .handle(op(json!({"op": "key", "pane": pane, "key": "Enter"})))
                .unwrap();
            assert_eq!(exit_notice(&notices, &pane), Some(6), "hold {hold}");
        }
    }

    /// A Windows engine has no launch script to hand its pane to the person's shell: the host does, in a new
    /// console on the same grid, with the status recorded and given to the shell (cli/src/lib/windows/engineStart.ts).
    #[test]
    fn an_engine_that_exits_hands_its_pane_to_the_shell_given_with_its_status() {
        for hold in [true, false] {
            let (panes, notices) = table();
            let r = panes
                .handle(op(json!({"op": "create",
                    "command": ["cmd.exe", "/c", "echo engine-words& exit 7"],
                    "cols": 80, "rows": 24, "owner": "o", "hold": hold, "afterExit": {
                        "command": ["powershell.exe", "-NoLogo", "-NoProfile", "-NoExit", "-Command",
                            "Write-Host ('after ' + $env:HARNESS_ENGINE_COMMAND + ' ' + $env:HARNESS_ENGINE_EXIT)"],
                        "env": {"HARNESS_ENGINE_COMMAND": "codex"}}})))
                .unwrap();
            let pane = r["pane"].as_str().unwrap().to_owned();
            until("the hand-off", || {
                capture(&panes, &pane).contains("after codex 7")
            });
            let st = panes
                .handle(op(json!({"op": "paneState", "pane": pane})))
                .unwrap()["state"]
                .clone();
            assert_eq!(st["dead"], false, "hold {hold}");
            assert_eq!(st["engineExit"], 7);
            assert_eq!(st["command"][0], "powershell.exe");
            // The shell is the pane's child now, alone in a job of its own. (The engine is a quick cmd.exe: two
            // PowerShell starts passed the 20 s wait once under the whole suite's load.)
            assert_eq!(job_pids(&panes, &pane).unwrap(), vec![root_pid(&panes)]);
            let history = panes
                .handle(op(json!({"op": "capture", "pane": pane, "ansi": false,
                    "visible": false, "historyLines": 100})))
                .unwrap()["text"]
                .as_str()
                .unwrap()
                .to_owned();
            assert!(history.contains("engine-words"), "{history:?}");
            // Nobody was told of an exit; the shell's own ends the pane as any other.
            panes
                .handle(op(json!({"op": "write", "pane": pane, "data":
                    base64::engine::general_purpose::STANDARD.encode("exit 3\r")})))
                .unwrap();
            assert_eq!(exit_notice(&notices, &pane), Some(3), "hold {hold}");
        }
    }
}
