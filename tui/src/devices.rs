//! Machines & devices in the panel — the desktop app's machine and device screens, drawn the TUI
//! way and reached from the Commands panel (its Machines group):
//!
//! - **Connect a machine…** — a machine on the account that is not linked yet, its remote password
//!   (hidden), then `harness link connect <id> --stdin --json` with the stages it reports, live.
//! - **Machines & devices…** — this computer's remote password, the account's machines (rename,
//!   remove), the links made from here (unlink), and the steps that add another machine.
//! - **Add phone…** — the QR code the app shows (the very same link), in half blocks.
//!
//! Everything that writes asks y/n in the panel's footer first. The CLI and the daemon's REST go
//! through one [Req] → [Reply] runner, which tests replace with fake answers: nothing here reaches a
//! real daemon or CLI from a test.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::{json, Value};
use unicode_width::UnicodeWidthStr;

use crate::app::App;
use crate::fleet::{Reach, State};
use crate::modal::{Modal, PickerKind};
use crate::picker::{Picker, Row};
use crate::settings::{self, Chrome};
use crate::theme::{self, fg};

// ── what the app shows (desktop wording, kept word for word) ──────────────────

/// Where Harness is downloaded (link_another_machine_dialog.dart).
pub const DOWNLOAD_URL: &str = "https://www.autonomous.ai/harness";
/// A server's three steps, run on THAT machine over SSH: copied, never run here.
pub const INSTALL: &str = "curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | bash";
pub const LOGIN: &str = "harness login";
pub const START: &str = "harness start && harness remote-password set";

/// Where the Add Phone QR points (add_phone_dialog.dart `phonePairLink`): the phone parses exactly
/// this, so the TUI's code is the app's, byte for byte.
const PAIR_HOST: &str = "harness.autonomous.ai";
const PAIR_PATH: &str = "/pair";
/// The pairing code's characters: no 0 O 1 I L, which read alike — and no U: the daemon maps U to V
/// and the phone does not, so a code with a U in it would never match.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LEN: usize = 16;
/// What `/api/pair` answers when this daemon cannot pair a phone at all.
const UNAVAILABLE: &str = "PAIRING_UNAVAILABLE";

/// `link connect --json`'s stages, in order, and what each is in words.
pub const STAGES: [(&str, &str); 4] = [
    ("connecting", "Connecting"),
    ("deriving_key", "Checking the password"),
    ("exchanging", "Exchanging keys"),
    ("verifying", "Verifying the link"),
];

/// The three views, each a Commands row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View { Connect, Phone, Machines }

impl View {
    pub const ALL: [View; 3] = [View::Connect, View::Phone, View::Machines];
    /// Its command id (the Commands row's, `run`'s).
    pub fn id(self) -> &'static str {
        match self { View::Connect => "connect-machine", View::Phone => "add-phone", View::Machines => "devices" }
    }
    pub fn of(id: &str) -> Option<View> { View::ALL.into_iter().find(|v| v.id() == id) }
    pub fn title(self) -> &'static str {
        match self { View::Connect => "Connect a computer", View::Phone => "Add your phone", View::Machines => "Machines & devices" }
    }
    fn placeholder(self) -> &'static str {
        match self {
            View::Connect => "Search machines not linked yet",
            View::Phone => "Search paired devices",
            View::Machines => "Search machines, links and steps",
        }
    }
}

// ── the state ────────────────────────────────────────────────────────────────

/// A machine this computer has linked (`harness link list`).
#[derive(Clone, Debug, PartialEq)]
pub struct Linked { pub machine: String, pub fingerprint: String, pub at: String }

/// A `link connect` under way, or just over: the stage it last reported, and how it ended.
pub struct Linking { pub machine: String, pub name: String, pub stage: String, pub result: Option<Result<String, String>> }

/// Add phone: the code the QR carries, the sign-in code with it, and the pairing's round of asking.
#[derive(Default)]
pub struct Phone {
    /// The view is open (its rounds stop when it is not), and which opening this is.
    pub open: bool,
    pub generation: u64,
    pub code: String,
    pub email: Option<String>,
    pub signed_out: bool,
    /// The one-time sign-in code (`h=`), once asked for: none after asking is a QR without one —
    /// the phone then asks for an emailed code.
    pub sign_in: Option<String>,
    pub sign_in_asked: bool,
    /// You said yes: the daemon is handed the code (`POST /api/pair`) for as long as the QR shows.
    pub armed: bool,
    pub connected: Option<String>,
    pub message: Option<String>,
    /// A message that tells you to do something ("scan the new code"): the next "no phone yet"
    /// leaves it up.
    pub sticky: bool,
    pub stopped: bool,
    pub paired: Vec<Value>,
    /// Where the QR was last drawn, and the last encoding (link, room) → modules.
    pub drawn: std::cell::Cell<Option<Rect>>,
    cache: std::cell::RefCell<Option<(String, u16, u16, Option<Vec<Vec<bool>>>)>>,
}

/// A line typed into the panel's query line, and what it is for.
#[derive(Clone, Debug)]
pub enum Entry {
    Link { machine: String, name: String },
    NewPassword,
    RepeatPassword { first: String },
    Rename { machine: String, name: String },
}

/// What a yes does.
#[derive(Clone, Debug)]
pub enum Act {
    Link { machine: String, name: String, password: String },
    SetPassword(String),
    ClearPassword,
    Unlink { machine: String, name: String },
    Rename { machine: String, name: String },
    Remove { machine: String, name: String },
    Unpair { fingerprint: String, name: String },
    ArmPhone,
}

/// The panel is asking: a line to type (a password shown as dots), or a y/n before a write.
#[derive(Clone, Debug)]
pub enum Ask {
    Entry { what: Entry, label: String, value: String, secret: bool },
    Confirm { question: String, act: Act },
}

#[derive(Clone, Copy)]
struct PromptActions { size: (u16, u16), accept: Rect, cancel: Rect }

pub struct Devices {
    /// `remote-password status --json` ({hasPassword, fingerprint, setAt}), or why it is unknown.
    pub password: Option<Result<Value, String>>,
    pub links: Option<Result<Vec<Linked>, String>>,
    /// `GET /api/machines`'s rows, by machine id (what the fleet does not keep: when it was seen).
    pub account: HashMap<String, Value>,
    pub link: Option<Linking>,
    pub phone: Phone,
    pub ask: Option<Ask>,
    prompt_actions: std::cell::Cell<Option<PromptActions>>,
    /// A level inside a view: a machine's actions (`m:<id>`).
    pub sub: Option<String>,
    /// The footer's line: what happened, or (true) what went wrong — until the next thing does.
    pub footer: Option<(String, bool, Instant)>,
    pub loading: Vec<&'static str>,
    /// None: the real CLI and daemon. Tests put fake answers here.
    pub runner: Option<Runner>,
}

impl Default for Devices {
    fn default() -> Devices {
        Devices {
            password: None, links: None, account: HashMap::new(), link: None, phone: Phone::default(), ask: None, prompt_actions: Default::default(), sub: None, footer: None, loading: Vec::new(), runner: default_runner(),
        }
    }
}

/// Under test nothing real is ever run: the CLI and the daemon answer that they are not there.
#[cfg(test)]
fn default_runner() -> Option<Runner> {
    Some(Box::new(|req: &Req| match req {
        Req::Wait(_) => None,
        Req::Cli { .. } => Some(Reply::Cli { ok: false, out: String::new(), err: "no Harness CLI in tests".into() }),
        Req::Http { .. } => Some(Reply::Http(Err(("TEST".into(), "no daemon in tests".into())))),
        _ => Some(Reply::Done),
    }))
}
#[cfg(not(test))]
fn default_runner() -> Option<Runner> { None }

// ── the runner ───────────────────────────────────────────────────────────────

/// One thing a view asks of the world.
#[derive(Clone, Debug, PartialEq)]
pub enum Req {
    /// The Harness CLI with these arguments; [stdin] is one line for it to read (a password), so a
    /// secret is never an argument another process could see.
    Cli { args: Vec<String>, stdin: Option<String> },
    /// This computer's daemon, over its REST.
    Http { method: &'static str, path: String, body: Option<Value> },
    /// Text for the clipboard of the computer you sit at.
    Copy(String),
    /// A pause, then the next round (the phone's pairing, its sign-in code).
    Wait(Duration),
}

#[derive(Clone, Debug)]
pub enum Reply {
    Cli { ok: bool, out: String, err: String },
    /// The body (its `data`, when enveloped), or (code, message).
    Http(Result<Value, (String, String)>),
    Done,
}

/// Answers a [Req] at once (Some), or never (None: a pause that is not over).
pub type Runner = Box<dyn FnMut(&Req) -> Option<Reply> + Send>;

fn cli(args: &[&str], stdin: Option<String>) -> Req { Req::Cli { args: args.iter().map(|a| a.to_string()).collect(), stdin } }
fn http(method: &'static str, path: impl Into<String>, body: Option<Value>) -> Req { Req::Http { method, path: path.into(), body } }

/// Run [req]; [then] gets its reply on the app loop, [line] each line the CLI prints as it prints it.
pub fn ask(app: &mut App, req: Req, line: Option<fn(&mut App, &str)>, then: impl FnOnce(&mut App, Reply) + Send + 'static) {
    if let Some(mut run) = app.devices.runner.take() {
        let reply = run(&req);
        app.devices.runner.get_or_insert(run);
        let Some(reply) = reply else { return };
        if let (Some(line), Reply::Cli { out, .. }) = (line, &reply) { for l in out.lines() { line(app, l) } }
        return then(app, reply);
    }
    let epoch = app.account_epoch;
    let then = move |app: &mut App, reply| { if app.account_epoch == epoch { then(app, reply); } };
    match req {
        Req::Cli { args, stdin } => { let sink = app.sink.clone(); app.spawn(run_cli(args, stdin, line, sink, epoch), then) }
        Req::Http { method, path, body } => {
            let port = app.port;
            // (A phone's handshake holds `/api/pair` open while it runs; the app waits 60 s for it.)
            let wait = Duration::from_secs(if path == "/api/pair" { 65 } else { 20 });
            app.spawn(async move { Reply::Http(crate::daemon::http_json_for(port, method, &path, body.as_ref(), wait).await.map_err(|e| (e.code, e.detail))) }, then)
        }
        Req::Copy(text) => { crate::clipboard::store(&text); then(app, Reply::Done) }
        Req::Wait(d) => app.spawn(async move { tokio::time::sleep(d).await; Reply::Done }, then),
    }
}

/// The CLI that started us (node + its script), else `harness` on PATH — as M-l always ran it: its
/// stdin one line then closed, its stdout read line by line (each to [line] as it comes), its
/// stderr drained so a full pipe never stalls it.
async fn run_cli(args: Vec<String>, stdin: Option<String>, line: Option<fn(&mut App, &str)>, sink: tokio::sync::mpsc::UnboundedSender<crate::event::Event>, epoch: u64) -> Reply {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    use std::process::Stdio;
    let exe = std::env::var("HARNESS_CLI").unwrap_or_else(|_| "harness".into());
    let script: Vec<String> = std::env::var("HARNESS_CLI_ARGS").ok().and_then(|a| serde_json::from_str(&a).ok()).unwrap_or_default();
    let spawned = tokio::process::Command::new(exe).args(script).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn();
    let mut child = match spawned { Ok(c) => c, Err(e) => return Reply::Cli { ok: false, out: String::new(), err: format!("Could not run the Harness CLI: {e}") } };
    if let Some(mut input) = child.stdin.take() {
        if let Some(text) = stdin { let _ = input.write_all(format!("{text}\n").as_bytes()).await; }
    }
    let mut errors = child.stderr.take();
    let drain = tokio::spawn(async move { let mut s = String::new(); if let Some(e) = errors.as_mut() { let _ = e.read_to_string(&mut s).await; } s });
    let mut out = String::new();
    if let Some(pipe) = child.stdout.take() {
        let mut lines = tokio::io::BufReader::new(pipe).lines();
        let read = async {
            while let Ok(Some(l)) = lines.next_line().await {
                if let Some(f) = line { let each = l.clone(); let _ = sink.send(crate::event::Event::Apply(Box::new(move |app: &mut App| { if app.account_epoch == epoch { f(app, &each); } }))); }
                out.push_str(&l);
                out.push('\n');
            }
        };
        // (A link's handshake takes seconds; past two minutes it is stuck.)
        if tokio::time::timeout(Duration::from_secs(120), read).await.is_err() {
            let _ = child.kill().await;
            return Reply::Cli { ok: false, out, err: "The command timed out. Refresh before trying it again.".into() };
        }
    }
    let ok = child.wait().await.map(|s| s.success()).unwrap_or(false);
    Reply::Cli { ok, out, err: drain.await.unwrap_or_default() }
}

// ── reading what the CLI says ────────────────────────────────────────────────

/// The last JSON object a `--json` command printed — its result; progress lines (`stage`) aside.
pub fn last_json(out: &str) -> Option<Value> {
    out.lines().filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok()).filter(|v| v.is_object() && v.get("stage").is_none()).last()
}

/// The stage a `link connect --json` line reports (`{"stage":"deriving_key"}`), if it is one.
pub fn stage_of(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line.trim()).ok()?.get("stage")?.as_str().map(str::to_string)
}

/// `harness link list`'s rows: `   1. <machineId>  <fingerprint>  (linked 2026-09-30 12:00)`.
pub fn parse_links(out: &str) -> Vec<Linked> {
    let re = regex::Regex::new(r"(?m)^\s*\d+\.\s+(\S+)\s+(\S+)\s+\(linked\s+([\d-]+\s[\d:]+)\)").expect("link list pattern");
    re.captures_iter(out).map(|c| Linked { machine: c[1].to_string(), fingerprint: c[2].to_string(), at: c[3].to_string() }).collect()
}

/// What a CLI that failed said, on one line (its ✗ taken off), else [fallback].
fn cli_error(out: &str, err: &str, fallback: &str) -> String {
    let said = |s: &str| s.lines().map(|l| l.trim().trim_start_matches('✗').trim()).filter(|l| !l.is_empty() && !l.starts_with('{')).collect::<Vec<_>>().join(" ");
    let e = said(err);
    let o = said(out);
    if !e.is_empty() { e } else if !o.is_empty() { o } else { fallback.to_string() }
}

// ── the phone's link and its QR code ────────────────────────────────────────

/// A fresh one-time pairing code, from the OS's secure source (a v4 id's random bytes): the whole
/// secret the pairing rests on, so never a guessable one.
pub fn new_code() -> String {
    let mut out = String::new();
    while out.len() < CODE_LEN {
        let bytes = *uuid::Uuid::new_v4().as_bytes();
        // (Bytes 6 and 8 carry the id's version and variant; the other fourteen are random. 240 is
        // 8 × 30: a byte under it picks each symbol as often as any other.)
        for (i, b) in bytes.iter().enumerate() {
            if i == 6 || i == 8 || out.len() == CODE_LEN || *b >= 240 { continue }
            out.push(CODE_ALPHABET[(*b % 30) as usize] as char);
        }
    }
    out
}

/// Dart's `Uri.encodeQueryComponent`, which the app encodes the link's parts with: letters, digits
/// and `-._~` as they are, a space as `+`, every other byte of the UTF-8 as `%XX`.
fn query_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `https://harness.autonomous.ai/pair#e=<email>&m=<machineId>&c=<code>&h=<sign-in code>` — all of
/// it in the fragment, which a browser never sends to a server, so the code stays off every log.
pub fn pair_link(email: &str, machine: &str, code: &str, sign_in: Option<&str>) -> String {
    let h = sign_in.map(|s| format!("&h={}", query_component(s))).unwrap_or_default();
    format!("https://{PAIR_HOST}{PAIR_PATH}#e={}&m={}&c={code}{h}", query_component(email), query_component(machine))
}

/// [text] as a QR code that fits [cols] × [rows] cells (two modules a cell, one above the other):
/// its modules (true: dark) with the quiet zone around them — the app's error correction (M) and
/// four-module margin where they fit, less of either only where they do not. None: it cannot fit.
pub fn qr_modules(text: &str, cols: u16, rows: u16) -> Option<Vec<Vec<bool>>> {
    use qrcodegen::{QrCode, QrCodeEcc, QrSegment, Version};
    let segs = [QrSegment::make_bytes(text.as_bytes())];
    let mut codes: Vec<(QrCodeEcc, Option<QrCode>)> = [QrCodeEcc::Medium, QrCodeEcc::Low].into_iter().map(|e| (e, QrCode::encode_segments_advanced(&segs, e, Version::MIN, Version::MAX, None, false).ok())).collect();
    for quiet in [4, 3, 2] {
        for (_, code) in codes.iter_mut() {
            let Some(code) = code.as_ref() else { continue };
            let total = code.size() + 2 * quiet;
            if total > cols as i32 || total > rows as i32 * 2 { continue }
            return Some((0..total).map(|y| (0..total).map(|x| code.get_module(x - quiet, y - quiet)).collect()).collect());
        }
    }
    None
}

/// The least room [text]'s code takes (cells: columns, rows).
fn qr_least(text: &str) -> (u16, u16) {
    use qrcodegen::{QrCode, QrCodeEcc, QrSegment, Version};
    let size = QrCode::encode_segments_advanced(&[QrSegment::make_bytes(text.as_bytes())], QrCodeEcc::Low, Version::MIN, Version::MAX, None, false).map(|c| c.size()).unwrap_or(177);
    let total = (size + 4) as u16;
    (total, total.div_ceil(2))
}

/// Draw [modules] at (x, y), two to a cell (▀ ▄ █), dark on light whatever the theme — a light code
/// on a dark field is one many phone cameras will not read — dimmed once it is spent. Returns its
/// rectangle.
pub fn draw_qr(buf: &mut Buffer, x: u16, y: u16, modules: &[Vec<bool>], spent: bool) -> Rect {
    let dark = if spent { Color::Rgb(200, 200, 200) } else { Color::Rgb(0, 0, 0) };
    let style = Style::default().fg(theme::depth_fit(dark)).bg(theme::depth_fit(Color::Rgb(255, 255, 255)));
    let n = modules.len();
    let rows = n.div_ceil(2);
    for row in 0..rows {
        for col in 0..n {
            let top = modules[2 * row][col];
            let bottom = modules.get(2 * row + 1).is_some_and(|r| r[col]);
            let glyph = match (top, bottom) { (true, true) => "█", (true, false) => "▀", (false, true) => "▄", _ => " " };
            if let Some(cell) = buf.cell_mut((x + col as u16, y + row as u16)) { cell.reset(); cell.set_symbol(glyph); cell.set_style(style); }
        }
    }
    Rect::new(x, y, n as u16, rows as u16)
}

/// "Mac" where the app runs on one; "computer" anywhere else.
fn this_computer() -> &'static str { if cfg!(target_os = "macos") { "Mac" } else { "computer" } }

/// Who and what the QR is for: the account's email and this computer's machine id — none while
/// either is not known yet.
fn target(app: &App) -> Option<(String, String)> {
    let email = app.devices.phone.email.clone()?;
    let machine = app.fleet.local_id.clone();
    if app.daemon_down || machine.is_empty() || crate::local::is_local(&machine) { return None }
    Some((email, machine))
}

/// The link the QR shows now: once the sign-in code has been asked for (a QR that changed right
/// after it appeared would be one scanned without it).
pub fn phone_link(app: &App) -> Option<String> {
    let p = &app.devices.phone;
    if !p.sign_in_asked || p.code.is_empty() { return None }
    let (email, machine) = target(app)?;
    Some(pair_link(&email, &machine, &p.code, p.sign_in.as_deref()))
}

// ── opening, leaving ─────────────────────────────────────────────────────────

/// Open [view] as its own panel (a command, or `run`).
pub fn open(app: &mut App, view: View) {
    enter(app, view);
    crate::input::picker(app, PickerKind::Devices(view), view.title(), view.placeholder());
    if let Some(p) = picker_mut(app) { p.keep_order = true; p.vset(0, 1) }
    opened(app, view);
}

/// Chosen in the Commands panel: the view opens in the same panel, and Esc comes back to it.
pub fn from_commands(app: &mut App, mut picker: Picker, view: View) {
    enter(app, view);
    picker.from_commands = true;
    picker.placeholder = view.placeholder().into();
    picker.keep_order = true;
    picker.theme_in = None;
    picker.clear_query();
    picker.rows.clear();
    fill(app, view, &mut picker);
    picker.scroll = 0;
    picker.vset(0, 1);
    app.modal = Some(Modal::Picker { kind: PickerKind::Devices(view), picker });
    opened(app, view);
}

/// M-l on a machine (the machines list): Connect a machine, its password asked for at once.
pub fn connect_to(app: &mut App, machine: String) {
    open(app, View::Connect);
    if let Some(p) = picker_mut(app) { p.select(&format!("m:{machine}")) }
    let name = name_of(app, &machine);
    start_link(app, machine, name);
}

/// A view's fresh start: nothing asked, no level, nothing said.
fn enter(app: &mut App, view: View) {
    let d = &mut app.devices;
    d.ask = None;
    d.sub = None;
    d.footer = None;
    if view == View::Phone {
        let generation = d.phone.generation + 1;
        let email = d.phone.email.take();
        d.phone = Phone { open: true, generation, code: new_code(), email, ..Phone::default() };
    } else {
        d.phone.open = false;
    }
}

/// What a view needs read when it opens.
fn opened(app: &mut App, view: View) {
    crate::account::refresh(app, false);
    match view {
        View::Connect => { load_me(app); load_account(app) }
        View::Machines => { load_password(app); load_links(app); load_account(app); load_me(app) }
        View::Phone => {
            load_me(app);
            let generation = app.devices.phone.generation;
            sign_in(app, generation);
            load_pairs(app);
            // (The QR shows at once; handing the daemon its code is a write, so it waits for a yes —
            // asked at once, unless there is no Harness here to hand it to.)
            if !app.daemon_down { confirm(app, format!("Let the phone that scans this code pair with this {}?", this_computer()), Act::ArmPhone) }
        }
    }
}

fn picker_mut(app: &mut App) -> Option<&mut Picker> {
    match &mut app.modal { Some(Modal::Picker { kind: PickerKind::Devices(_), picker }) => Some(picker), _ => None }
}

fn view_of(app: &App) -> Option<View> {
    match &app.modal { Some(Modal::Picker { kind: PickerKind::Devices(v), .. }) => Some(*v), _ => None }
}

/// The open view's rows again, from what is known now.
fn again(app: &mut App) { crate::input::refill(app) }

fn note(app: &mut App, text: impl Into<String>) { app.devices.footer = Some((text.into(), false, Instant::now())) }
fn fail(app: &mut App, text: impl Into<String>) { app.devices.footer = Some((text.into(), true, Instant::now())) }
fn loading(app: &mut App, what: &'static str, on: bool) {
    let l = &mut app.devices.loading;
    if on { if !l.contains(&what) { l.push(what) } } else { l.retain(|w| *w != what) }
}
fn is_loading(app: &App, what: &str) -> bool { app.devices.loading.contains(&what) }

fn name_of(app: &App, machine: &str) -> String {
    let name = app.fleet.machine_name(machine);
    if name.is_empty() { machine.to_string() } else { name }
}

// ── reads ────────────────────────────────────────────────────────────────────

fn load_password(app: &mut App) {
    loading(app, "password", true);
    ask(app, cli(&["remote-password", "status", "--json"], None), None, |app, reply| {
        loading(app, "password", false);
        app.devices.password = Some(match &reply {
            Reply::Cli { out, err, .. } => last_json(out).filter(|v| v.get("hasPassword").is_some()).ok_or_else(|| cli_error(out, err, "Password status is unavailable.")),
            _ => Err("Password status is unavailable.".into()),
        });
        again(app);
    });
}

fn load_links(app: &mut App) {
    loading(app, "links", true);
    ask(app, cli(&["link", "list"], None), None, |app, reply| {
        loading(app, "links", false);
        app.devices.links = Some(match &reply {
            Reply::Cli { ok: true, out, .. } => Ok(parse_links(out)),
            Reply::Cli { out, err, .. } => Err(cli_error(out, err, "Could not load linked machines. Try again.")),
            _ => Err("Could not load linked machines. Try again.".into()),
        });
        again(app);
    });
}

fn load_account(app: &mut App) {
    // (The fleet's own read keeps names and online states; this one keeps the rest of each row.)
    if app.devices.runner.is_none() { app.refresh_machines() }
    ask(app, http("GET", "/api/machines", None), None, |app, reply| {
        if let Reply::Http(Ok(v)) = reply {
            for row in v.get("machines").and_then(Value::as_array).into_iter().flatten() {
                if let Some(id) = row.get("machineId").and_then(Value::as_str) { app.devices.account.insert(id.to_string(), row.clone()); }
            }
            again(app);
        }
    });
}

fn load_me(app: &mut App) {
    ask(app, http("GET", "/api/auth/me", None), None, |app, reply| {
        match reply {
            Reply::Http(Ok(v)) => {
                app.devices.phone.email = v.pointer("/user/email").and_then(Value::as_str).map(str::trim).filter(|e| e.contains('@')).map(str::to_string);
                app.devices.phone.signed_out = false;
            }
            Reply::Http(Err((code, _))) if matches!(code.as_str(), "HTTP_401" | "NOT_SIGNED_IN") => {
                app.devices.phone.email = None;
                app.devices.phone.signed_out = true;
            }
            _ => {}
        }
        again(app);
    });
}

fn load_pairs(app: &mut App) {
    ask(app, http("GET", "/api/pairs", None), None, |app, reply| {
        let Reply::Http(Ok(v)) = reply else { return };
        // (A `web` pairing: a phone or another computer — not a device on a cable.)
        let mut pairs: Vec<Value> = v.get("pairs").and_then(Value::as_array).into_iter().flatten()
            .filter(|p| p.get("fingerprint").and_then(Value::as_str).is_some_and(|f| !f.is_empty()) && p.get("role").and_then(Value::as_str).is_none_or(|r| r == "web"))
            .cloned().collect();
        pairs.sort_by_key(|p| std::cmp::Reverse(p.get("pairedAt").and_then(Value::as_u64).unwrap_or(0)));
        app.devices.phone.paired = pairs;
        again(app);
    });
}

/// The sign-in code for the QR, asked for again before it runs out — while the QR is on screen. A
/// failure is not retried sooner: the QR works without one.
fn sign_in(app: &mut App, generation: u64) {
    ask(app, http("POST", "/api/auth/handoff", Some(json!({}))), None, move |app, reply| {
        if !phone_live(app, generation) { return }
        let got = match reply {
            Reply::Http(Ok(v)) => v.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()).map(|c| (c.to_string(), v.get("expiresIn").and_then(Value::as_u64).filter(|t| *t > 0).unwrap_or(60))),
            _ => None,
        };
        let ttl = got.as_ref().map(|g| g.1).unwrap_or(60);
        app.devices.phone.sign_in = got.map(|g| g.0);
        app.devices.phone.sign_in_asked = true;
        again(app);
        if app.devices.phone.connected.is_some() || app.devices.phone.stopped { return }
        // (Renewed with at least half a minute left in the one on screen.)
        let wait = if ttl > 30 && ttl - 30 < 60 { ttl - 30 } else { 60 };
        ask(app, Req::Wait(Duration::from_secs(wait)), None, move |app, _| if phone_live(app, generation) { sign_in(app, generation) });
    });
}

fn phone_live(app: &App, generation: u64) -> bool {
    let p = &app.devices.phone;
    p.open && p.generation == generation && view_of(app) == Some(View::Phone)
}

/// One round of handing the daemon the code (`POST /api/pair`, what `harness pair <code>` sends): it
/// answers at once with no phone waiting, and holds on while a phone's handshake runs — then again,
/// for as long as the QR is on screen and armed.
fn phone_round(app: &mut App, generation: u64) {
    if !phone_live(app, generation) { return }
    let p = &app.devices.phone;
    if !p.armed || p.connected.is_some() || p.stopped { return }
    if target(app).is_none() { return ask(app, Req::Wait(Duration::from_millis(1500)), None, move |app, _| phone_round(app, generation)) }
    let code = p.code.clone();
    ask(app, http("POST", "/api/pair", Some(json!({ "code": code }))), None, move |app, reply| {
        if !phone_live(app, generation) { return }
        let error = match reply {
            Reply::Http(Ok(v)) => {
                let label = v.get("label").and_then(Value::as_str).map(str::trim).filter(|l| !l.is_empty()).unwrap_or("phone").to_string();
                app.devices.phone.connected = Some(label.clone());
                app.devices.phone.message = None;
                app.devices.ask = None;
                note(app, format!("✓ Connected {label}"));
                load_pairs(app);
                again(app);
                return;
            }
            Reply::Http(Err((code, message))) => pair_error(&code, &message),
            _ => "UNREACHABLE".to_string(),
        };
        let computer = this_computer();
        let p = &mut app.devices.phone;
        let mut say = |text: String, sticky: bool| { p.message = Some(text); p.sticky = sticky };
        let wait = match error.as_str() {
            // No phone yet, one whose minute ran out, one mid-handshake with somebody else.
            "NO_INTENT" | "EXPIRED" | "BUSY" => { if !p.sticky { p.message = None } 1500 }
            // The phone holds the old code and the daemon has spent it: a new one, a new QR.
            "CODE_MISMATCH" => { say("That didn't match. Scan the new code.".into(), true); p.code = new_code(); 1500 }
            "RATE_LIMITED" => { say("Too many tries. Wait a minute.".into(), false); 60_000 }
            "BACKEND_DOWN" => { say(format!("This {computer} can't reach Harness right now."), false); 1500 }
            "TIMEOUT" => { say("Your phone stopped answering. Scan again.".into(), true); 1500 }
            "CANCELLED" => { say("Cancelled on your phone. Scan again.".into(), true); 1500 }
            UNAVAILABLE => { say(format!("Update Harness on this {computer} to add a phone."), false); p.stopped = true; again(app); return }
            other => { say(format!("Could not pair ({other}). Trying again."), false); 5000 }
        };
        again(app);
        ask(app, Req::Wait(Duration::from_millis(wait)), None, move |app, _| phone_round(app, generation));
    });
}

/// `/api/pair`'s answer as the app reads it: the daemon's own code (`{error: NO_INTENT}` on a 409),
/// no pairing to be had (a daemon from before it answers 404; nobody on the port), or a timeout.
fn pair_error(code: &str, message: &str) -> String {
    match code {
        "HTTP_404" | "DAEMON_UNREACHABLE" => UNAVAILABLE.into(),
        "TIMEOUT" => "TIMEOUT".into(),
        c if c.starts_with("HTTP_") && !message.is_empty() && message != "request failed" => message.to_string(),
        _ => "UNREACHABLE".into(),
    }
}

// ── writes (each after its yes) ──────────────────────────────────────────────

fn run_act(app: &mut App, act: Act) {
    match act {
        Act::Link { machine, name, password } => link_connect(app, machine, name, password),
        Act::SetPassword(password) => {
            note(app, "Setting password…");
            ask(app, cli(&["remote-password", "set", "--stdin", "--json"], Some(password)), None, |app, reply| {
                let Reply::Cli { out, err, .. } = &reply else { return fail(app, "harness remote-password set failed") };
                match last_json(out) {
                    Some(v) if v.get("ok").and_then(Value::as_bool) == Some(true) => {
                        app.devices.password = Some(Ok(json!({ "hasPassword": true, "fingerprint": v.get("fingerprint").cloned().unwrap_or(Value::Null), "setAt": crate::fleet::now_ms() })));
                        note(app, "Password set.");
                    }
                    Some(v) => { let code = v.get("error").and_then(Value::as_str).unwrap_or("harness remote-password set failed").to_string(); fail(app, password_error(&code)) }
                    None => fail(app, cli_error(out, err, "harness remote-password set failed")),
                }
                again(app);
            });
        }
        Act::ClearPassword => {
            note(app, "Clearing password…");
            ask(app, cli(&["remote-password", "clear", "--json"], None), None, |app, reply| {
                let Reply::Cli { out, err, .. } = &reply else { return fail(app, "harness remote-password clear failed") };
                match last_json(out) {
                    Some(v) if v.get("ok").and_then(Value::as_bool) == Some(true) => { app.devices.password = Some(Ok(json!({ "hasPassword": false }))); note(app, "Password cleared.") }
                    Some(v) => fail(app, v.get("error").and_then(Value::as_str).unwrap_or("harness remote-password clear failed").to_string()),
                    None => fail(app, cli_error(out, err, "harness remote-password clear failed")),
                }
                again(app);
            });
        }
        Act::Unlink { machine, name } => {
            note(app, "Unlinking machine…");
            ask(app, cli(&["link", "unlink", &machine], None), None, move |app, reply| {
                match &reply {
                    Reply::Cli { ok: true, .. } => { note(app, format!("Unlinked {name}")); load_links(app) }
                    Reply::Cli { out, err, .. } => fail(app, cli_error(out, err, "harness link unlink failed")),
                    _ => fail(app, "harness link unlink failed"),
                }
                again(app);
            });
        }
        Act::Rename { machine, name } => {
            note(app, "Saving…");
            let path = format!("/api/machines/{machine}");
            ask(app, http("PATCH", path, Some(json!({ "name": name }))), None, move |app, reply| {
                match reply {
                    Reply::Http(Ok(v)) => {
                        let saved = v.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&name).to_string();
                        if let Some(m) = app.fleet.machine_mut(&machine) { m.name = saved.clone() }
                        if let Some(row) = app.devices.account.get_mut(&machine) { row["name"] = json!(saved) }
                        note(app, format!("Renamed to {saved}"));
                    }
                    Reply::Http(Err((_, message))) => fail(app, message),
                    _ => fail(app, "Could not rename it"),
                }
                again(app);
            });
        }
        Act::Remove { machine, name } => {
            note(app, "Deleting machine…");
            let path = format!("/api/machines/{machine}");
            ask(app, http("DELETE", path, None), None, move |app, reply| {
                match reply {
                    Reply::Http(Ok(_)) => {
                        app.account_machine_removed(&machine);
                        app.devices.account.remove(&machine);
                        if app.devices.sub.as_deref() == Some(&format!("m:{machine}")) { app.devices.sub = None }
                        note(app, format!("Deleted {name} from your account"));
                    }
                    Reply::Http(Err((_, message))) => fail(app, message),
                    _ => fail(app, "Could not delete it"),
                }
                again(app);
            });
        }
        Act::Unpair { fingerprint, name } => {
            ask(app, http("POST", "/api/revoke", Some(json!({ "id": fingerprint }))), None, move |app, reply| {
                match reply {
                    Reply::Http(Ok(v)) if v.get("error").is_none() => { app.devices.phone.paired.retain(|p| p.get("fingerprint").and_then(Value::as_str) != Some(&fingerprint)); note(app, format!("Removed {name}")) }
                    _ => fail(app, format!("Couldn't remove {name}. Try again.")),
                }
                again(app);
            });
        }
        Act::ArmPhone => {
            app.devices.phone.armed = true;
            again(app);
            let generation = app.devices.phone.generation;
            phone_round(app, generation);
        }
    }
}

fn password_error(code: &str) -> String {
    match code {
        "NOT_SIGNED_IN" => "This computer is not signed in. Run: harness login".into(),
        "EMPTY_PASSWORD" => "Enter a password".into(),
        "MISMATCH" => "Passwords do not match".into(),
        c => c.to_string(),
    }
}

/// `harness link connect <id> --stdin --json [--name=…]`, the password on its stdin: each stage it
/// prints shown as it comes; its last line says how it went.
pub fn link_connect(app: &mut App, machine: String, name: String, password: String) {
    app.devices.link = Some(Linking { machine: machine.clone(), name: name.clone(), stage: "connecting".into(), result: None });
    let mut args: Vec<String> = ["link", "connect", &machine, "--stdin", "--json"].iter().map(|s| s.to_string()).collect();
    if !name.is_empty() && name != machine { args.push(format!("--name={name}")) }
    note(app, format!("Linking {name}… it continues if you close this"));
    again(app);
    ask(app, Req::Cli { args, stdin: Some(password) }, Some(link_line), move |app, reply| {
        let result = match &reply {
            Reply::Cli { out, err, .. } => match last_json(out) {
                Some(v) if v.get("ok").and_then(Value::as_bool) == Some(true) => Ok(v.get("fingerprint").and_then(Value::as_str).unwrap_or("").to_string()),
                // (`message` is the CLI's sentence for the code; `error` the bare code, from a CLI too old to send one.)
                Some(v) => Err(v.get("message").or_else(|| v.get("error")).and_then(Value::as_str).unwrap_or("harness link connect failed").to_string()),
                None => Err(cli_error(out, err, "harness link connect produced no result")),
            },
            _ => Err("harness link connect failed".into()),
        };
        match &result {
            Ok(_) => {
                note(app, format!("Linked {name}"));
                app.say(format!("Linked {name}"), theme::ONLINE);
                if let Some(m) = app.fleet.machine_mut(&machine) { m.reach = Reach::Unknown }
                if app.devices.runner.is_none() { app.connect(&machine) }
            }
            Err(e) => { fail(app, format!("Could not link: {e}")); app.say(format!("Could not link {name}: {e}"), theme::DANGER) }
        }
        if let Some(l) = app.devices.link.as_mut().filter(|l| l.machine == machine) { l.result = Some(result) }
        again(app);
    });
}

fn link_line(app: &mut App, line: &str) {
    let Some(stage) = stage_of(line) else { return };
    if let Some(l) = app.devices.link.as_mut().filter(|l| l.result.is_none()) { l.stage = stage }
    again(app);
}

// ── asking ───────────────────────────────────────────────────────────────────

fn entry(app: &mut App, what: Entry, label: impl Into<String>, value: &str, secret: bool) {
    app.devices.prompt_actions.set(None);
    app.devices.ask = Some(Ask::Entry { what, label: label.into(), value: value.to_string(), secret });
}

fn confirm(app: &mut App, question: impl Into<String>, act: Act) {
    app.devices.prompt_actions.set(None);
    app.devices.ask = Some(Ask::Confirm { question: question.into(), act });
}

/// Passwords and names belong to the active prompt, never to the search beneath it.
/// A paste cannot answer a confirmation, even if it contains "y" or a newline.
pub fn paste(app: &mut App, text: &str) -> bool {
    if view_of(app).is_none() || app.devices.ask.is_none() { return false }
    if let Some(Ask::Entry { value, .. }) = &mut app.devices.ask {
        value.extend(text.chars().filter(|c| !c.is_control()));
    }
    true
}

/// While a prompt is open, clicks on the underlying list cannot become Enter.
/// Only the actions drawn for this prompt can advance it; an outside click cancels.
pub fn mouse(app: &mut App, mouse: MouseEvent) -> bool {
    if view_of(app).is_none() || app.devices.ask.is_none() { return false }
    if mouse.kind != MouseEventKind::Down(MouseButton::Left) || !mouse.modifiers.is_empty() { return true }
    let at = Position::new(mouse.column, mouse.row);
    let action = app.devices.prompt_actions.get().filter(|a| a.size == app.size);
    let key = if action.is_some_and(|a| a.accept.contains(at)) {
        Some(if matches!(app.devices.ask, Some(Ask::Confirm { .. })) { KeyCode::Char('y') } else { KeyCode::Enter })
    } else if action.is_some_and(|a| a.cancel.contains(at)) {
        Some(KeyCode::Esc)
    } else if matches!(&app.modal, Some(Modal::Picker { picker, .. }) if !picker.screen_area.get().contains(at)) {
        Some(KeyCode::Esc)
    } else { None };
    if let Some(key) = key {
        crate::workspace_controls::begin_press(app, MouseButton::Left);
        answer_key(app, KeyEvent::new(key, KeyModifiers::NONE));
        again(app);
    }
    true
}

fn start_link(app: &mut App, machine: String, name: String) {
    let label = format!("Remote password for {name}");
    entry(app, Entry::Link { machine, name }, label, "", true);
    note(app, "Enter the remote password set on this machine.");
}

/// Enter on a typed line: the next line, or the y/n before the write.
fn submit(app: &mut App, what: Entry, value: String) {
    match what {
        Entry::Link { machine, name } => {
            if value.is_empty() { start_link(app, machine, name); return fail(app, "Enter the remote password first") }
            confirm(app, format!("Link {name} with this password?"), Act::Link { machine, name, password: value });
        }
        Entry::NewPassword => {
            if value.is_empty() { entry(app, Entry::NewPassword, "New remote password", "", true); return fail(app, "Enter a password") }
            entry(app, Entry::RepeatPassword { first: value }, "Repeat password", "", true);
        }
        Entry::RepeatPassword { first } => {
            if value != first { entry(app, Entry::NewPassword, "New remote password", "", true); return fail(app, "Passwords do not match") }
            confirm(app, "Set this computer's remote password? Anyone with it can link a machine here.", Act::SetPassword(value));
        }
        Entry::Rename { machine, name } => {
            let new = value.trim().to_string();
            if new.is_empty() { entry(app, Entry::Rename { machine, name: name.clone() }, "Machine name", &name, false); return fail(app, "Name cannot be empty") }
            if new == name { return note(app, "Nothing changed") }
            confirm(app, format!("Rename {name} to {new}?"), Act::Rename { machine, name: new });
        }
    }
}

/// A key while the panel asks: a y/n answered, or a line typed (Enter goes on, Esc lets it go).
fn answer_key(app: &mut App, key: KeyEvent) {
    app.devices.prompt_actions.set(None);
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match app.devices.ask.take() {
        Some(Ask::Confirm { question, act }) => match key.code {
            KeyCode::Char('y' | 'Y') if !ctrl => run_act(app, act),
            KeyCode::Char('n' | 'N') | KeyCode::Esc => note(app, "Nothing changed"),
            KeyCode::Char('c' | 'g') if ctrl => note(app, "Nothing changed"),
            _ => app.devices.ask = Some(Ask::Confirm { question, act }),
        },
        Some(Ask::Entry { what, label, mut value, secret }) => {
            match key.code {
                KeyCode::Enter => { app.devices.footer = None; return submit(app, what, value) }
                KeyCode::Esc => return note(app, "Nothing changed"),
                KeyCode::Char('c' | 'g') if ctrl => return note(app, "Nothing changed"),
                KeyCode::Char('u') if ctrl => value.clear(),
                KeyCode::Char('h') if ctrl => { value.pop(); }
                KeyCode::Backspace => { value.pop(); }
                KeyCode::Char(c) if !ctrl && !key.modifiers.contains(KeyModifiers::ALT) => value.push(c),
                _ => {}
            }
            app.devices.ask = Some(Ask::Entry { what, label, value, secret });
        }
        None => {}
    }
}

/// A key in one of the views, before the list's own keys: an answer while the panel asks, Esc (or ←
/// on an empty query) one level back. Anything else goes back to the list.
pub fn key(app: &mut App, kind: PickerKind, picker: Picker, key: KeyEvent) -> Result<(), (PickerKind, Picker)> {
    let PickerKind::Devices(view) = kind else { return Err((kind, picker)) };
    if app.devices.ask.is_some() {
        app.modal = Some(Modal::Picker { kind, picker });
        answer_key(app, key);
        again(app);
        return Ok(());
    }
    let plain = key.modifiers.is_empty();
    let back = key.code == KeyCode::Esc || (key.code == KeyCode::Left && plain && picker.query.is_empty());
    if !back { return Err((kind, picker)) }
    app.modal = Some(Modal::Picker { kind, picker });
    step_back(app, view);
    Ok(())
}

/// Out of a machine's actions; out of the view to the command list it
/// was chosen from; else the panel closes.
fn step_back(app: &mut App, view: View) {
    app.devices.footer = None;
    if let Some(sub) = app.devices.sub.take() {
        again(app);
        if let Some(p) = picker_mut(app) { p.clear_query(); p.select(&sub) }
        return;
    }
    app.devices.phone.open = false;
    let Some(Modal::Picker { mut picker, .. }) = app.modal.take() else { return };
    if !picker.from_commands { return }
    settings::back_to_commands(app, &mut picker);
    settings::cursor_to(&mut picker, &format!("cmd:{}", view.id()));
    app.modal = Some(Modal::Picker { kind: PickerKind::Commands, picker });
}

/// Enter on a row.
pub fn choose(app: &mut App, view: View, picker: Picker, enter: bool) {
    let id = picker.current_id();
    app.modal = Some(Modal::Picker { kind: PickerKind::Devices(view), picker });
    if !enter { return }
    let Some(id) = id else { return };
    app.devices.footer = None;
    let (what, rest) = id.split_once(':').unwrap_or((id.as_str(), ""));
    let rest = rest.to_string();
    match (view, what) {
        (View::Connect, "here") if rest == "login" => {
            if app.read_only() { return app.error("This client is read-only.") }
            if app.link(&crate::input::shell_machine(app, None)).is_none() {
                return app.error("This computer is still starting. Try again in a moment.")
            }
            // Use the existing sign-in flow on THIS computer, never whichever
            // remote agent happens to have focus. Leave its outcome readable.
            let executable = std::env::var("HARNESS_CLI").unwrap_or_else(|_| "harness".into());
            let args: Vec<String> = std::env::var("HARNESS_CLI_ARGS").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
            let command = std::iter::once(executable).chain(args).chain(std::iter::once("login".into())).map(|s| quote(&s)).collect::<Vec<_>>().join(" ");
            let command = format!("{command}; printf '\\nOpen Connect a computer again after signing in.\\nPress Enter to return to Harness. '; read -r harness_login_done");
            app.new_tab();
            app.rename_tab("Sign in");
            let tab = app.tab().id.clone();
            crate::input::new_shell_from(app, None, crate::app::Placement::Fill(tab), None, Some(command));
            return;
        }
        (View::Connect, "here") if rest == "setup" => switch(app, View::Machines),
        (_, "account") => { crate::account::open(app); return }
        (View::Connect, "m") => { let name = name_of(app, &rest); start_link(app, rest, name) }
        (_, "m") => sub(app, format!("m:{rest}")),
        (_, "act") => machine_action(app, &rest),
        (_, "pw") => match rest.as_str() {
            "set" => entry(app, Entry::NewPassword, "New remote password", "", true),
            "clear" => confirm(app, "Prevent new links using this password? Existing links and sessions stay connected.", Act::ClearPassword),
            _ => load_password(app),
        },
        (_, "ln") if rest.is_empty() => { note(app, "Loading linked machines…"); load_links(app) }
        (_, "ln") => { let name = name_of(app, &rest); confirm(app, format!("Remove this computer’s saved link to {name}? A new connection will need that machine’s password."), Act::Unlink { machine: rest, name }) }
        (_, "add") => match rest.as_str() {
            "download" => copy(app, DOWNLOAD_URL),
            "connect" => switch(app, View::Connect),
            "install" => copy(app, INSTALL),
            "login" => copy(app, LOGIN),
            "start" => copy(app, START),
            _ => copy(app, &format!("{INSTALL}\n{LOGIN}\n{START}")),
        },
        (_, "ph") => match rest.as_str() {
            "arm" => confirm(app, format!("Let the phone that scans this code pair with this {}?", this_computer()), Act::ArmPhone),
            "new" => { app.devices.phone.code = new_code(); app.devices.phone.message = None; note(app, "A new code — the old one no longer pairs") }
            fp => {
                let name = app.devices.phone.paired.iter().find(|p| p.get("fingerprint").and_then(Value::as_str) == Some(fp)).map(device_name).unwrap_or_else(|| "this device".into());
                confirm(app, format!("Remove {name}'s access to this {}? Scanning the code again adds it back.", this_computer()), Act::Unpair { fingerprint: fp.to_string(), name })
            }
        },
        _ => {}
    }
    again(app);
}

/// Into a level of the view (a machine's actions), the cursor on its first row.
fn sub(app: &mut App, level: String) {
    app.devices.sub = Some(level);
    again(app);
    if let Some(p) = picker_mut(app) { p.clear_query(); p.scroll = 0; p.vset(0, 1) }
}

/// Over to another view in the same panel (Esc still goes back where the first one came from).
fn switch(app: &mut App, view: View) {
    enter(app, view);
    if let Some(Modal::Picker { kind, picker }) = &mut app.modal {
        *kind = PickerKind::Devices(view);
        picker.placeholder = view.placeholder().into();
        picker.clear_query();
        picker.set_rows(Vec::new());
    }
    again(app);
    if let Some(p) = picker_mut(app) { p.scroll = 0; p.vset(0, 1) }
    opened(app, view);
}

fn copy(app: &mut App, text: &str) {
    let shown = text.lines().next().unwrap_or("").to_string();
    ask(app, Req::Copy(text.to_string()), None, move |app, _| note(app, format!("Copied: {shown}")));
}

fn machine_action(app: &mut App, rest: &str) {
    let Some((verb, machine)) = rest.split_once(':') else { return };
    let (machine, name) = (machine.to_string(), name_of(app, machine));
    match verb {
        "rename" => entry(app, Entry::Rename { machine, name: name.clone() }, "Machine name", &name, false),
        "remove" => confirm(app, format!("Delete {name} from your account?"), Act::Remove { machine, name }),
        "connect" => { switch(app, View::Connect); if let Some(p) = picker_mut(app) { p.select(&format!("m:{machine}")) } start_link(app, machine, name) }
        "open" => {
            app.devices.sub = None;
            let kind = PickerKind::Open { filter: crate::modal::Filter::All, machine: Some(machine), project: None };
            let (title, placeholder) = crate::modal::launcher_title(app, &kind);
            let mut next = Picker::new(title, placeholder);
            next.prefixed = true;
            crate::input::fill(app, &kind, &mut next);
            app.modal = Some(Modal::Picker { kind, picker: next });
        }
        _ => {}
    }
}

// ── rows ─────────────────────────────────────────────────────────────────────

fn span(text: impl Into<String>, style: Style) -> Span<'static> { Span::styled(text.into(), style) }
fn dot(glyph: &str, color: Color) -> Vec<Span<'static>> { vec![span(format!("{glyph} "), fg(color))] }
fn info(id: &str, text: impl Into<String>, group: &str) -> Row { let mut r = Row::new(id, text).group(group).lead(dot(" ", theme::MUTED)); r.disabled = true; r }

/// A machine's dot, colour and word, as the machines list says them.
fn reach(app: &App, m: &crate::fleet::Machine) -> (&'static str, Color, String) {
    let linking = app.devices.link.as_ref().is_some_and(|l| l.machine == m.id && l.result.is_none());
    // (The harnesses' marks, no round ones: `✓`, a spinner connecting, `?` to link, `✗`, `·`.)
    let spin = theme::spinner(app.tick);
    match &m.reach {
        _ if linking => (spin, theme::WARN, "connecting…".into()),
        _ if m.local => ("✓", theme::ONLINE, "this computer".into()),
        _ if !m.online() => ("·", theme::MUTED, "offline".into()),
        Reach::Ready => ("✓", theme::ONLINE, "connected".into()),
        Reach::Connecting => (spin, theme::WARN, "connecting…".into()),
        Reach::NeedsLink => ("?", theme::ATTENTION, "online · not linked".into()),
        Reach::Error(e) => ("✗", theme::DANGER, e.chars().take(40).collect()),
        _ => ("·", theme::SOFT, "online".into()),
    }
}

/// Its harnesses in counts (`2 waiting · 1 working`).
fn counts(app: &App, machine: &str) -> String {
    let here: Vec<State> = app.fleet.agents.values().filter(|a| a.machine_id == machine && a.engine != "terminal").map(|a| app.fleet.state_of(a)).collect();
    let n = |s: State| here.iter().filter(|x| **x == s).count();
    let said = [(State::NeedsInput, "waiting"), (State::Failed, "failed"), (State::Done, "done"), (State::Working, "working"), (State::Ready, "idle")]
        .iter().filter(|(s, _)| n(*s) > 0).map(|(s, w)| format!("{} {w}", n(*s))).collect::<Vec<_>>().join(" · ");
    if said.is_empty() { "no harnesses".into() } else { said }
}

/// (Re)build the open view's rows.
pub fn fill(app: &App, view: View, picker: &mut Picker) {
    picker.keep_order = true;
    let rows = match view {
        View::Connect => connect_rows(app),
        View::Machines => match app.devices.sub.as_deref().and_then(|s| s.strip_prefix("m:")) { Some(id) => action_rows(app, id), None => machines_rows(app) },
        View::Phone => phone_rows(app),
    };
    // (Rebuilt in their own order, not the last one's: a row that arrives lands in its group.)
    picker.rows.clear();
    picker.set_rows(rows);
    picker.hints = vec![("enter", "choose"), ("esc", "back")];
}

fn connect_rows(app: &App) -> Vec<Row> {
    let setup = || Row::new("here:setup", "Set up another computer").group("Get connected").lead(dot("→", theme::TEAL));
    if app.account.status == crate::account::Status::SignedOut || app.devices.phone.signed_out {
        return vec![account_row(app), info("local-use", "Local harnesses work without an account.", "This computer"), setup()];
    }
    let (mut ready, mut done, mut away) = (Vec::new(), Vec::new(), Vec::new());
    for m in app.fleet.machines.iter().filter(|m| !m.local && !m.shared) {
        let (glyph, color, word) = reach(app, m);
        let linking = app.devices.link.as_ref().is_some_and(|l| l.machine == m.id && l.result.is_none());
        // (One just linked stays in view, how it went beside it.)
        if app.devices.link.as_ref().is_some_and(|l| l.machine == m.id && matches!(l.result, Some(Ok(_)))) {
            done.push(Row::new(format!("m:{}", m.id), m.name.clone()).group("Linked just now").extra(m.id.clone()).lead(dot("✓", theme::ONLINE)).detail(vec![span("linked", fg(theme::ONLINE))]).right("linked"));
        } else if linking || (m.reach == Reach::NeedsLink && m.online()) {
            ready.push(Row::new(format!("m:{}", m.id), m.name.clone()).group("Not linked yet").extra(m.id.clone()).lead(dot(glyph, color)).detail(vec![span(word, fg(color))]).right("enter links it"));
        } else if !m.online() {
            let mut r = Row::new(format!("m:{}", m.id), m.name.clone()).group("Offline").extra(m.id.clone()).lead(dot(glyph, color)).detail(vec![span(format!("Open Harness on {} to bring it online.", m.name), fg(theme::MUTED))]).right("offline");
            r.disabled = true;
            away.push(r);
        }
    }
    if ready.is_empty() { ready.push(info("none", if app.daemon_down { "Harness is not running on this computer" } else { "No computers ready to connect" }, "Not linked yet")) }
    ready.extend(done);
    ready.extend(away);
    ready.push(setup());
    ready
}

fn account_row(app: &App) -> Row {
    let detail = if app.account.status == crate::account::Status::SignedOut { "Connect computers, sync your workspace and use your phone" } else { "Your Harness account and connected computers" };
    Row::new("account", crate::account::label(app)).group("Account").detail(vec![span(detail, fg(theme::MUTED))])
}

fn machines_rows(app: &App) -> Vec<Row> {
    let mut rows = vec![account_row(app)];
    let here = "This computer";
    let password = app.devices.password.as_ref();
    let set = password.and_then(|p| p.as_ref().ok()).and_then(|v| v.get("hasPassword")).and_then(Value::as_bool);
    let state = match password {
        _ if is_loading(app, "password") && password.is_none() => "reading…".to_string(),
        None => "…".into(),
        Some(Err(_)) => "unavailable".into(),
        Some(Ok(v)) => if set == Some(true) { v.get("setAt").and_then(Value::as_u64).map(|t| format!("set {}", crate::fleet::ago(t))).map(|s| if s == "set " { "set".into() } else { s }).unwrap_or_else(|| "set".into()) } else { "not set".into() },
    };
    let color = match set { Some(true) => theme::ONLINE, Some(false) => theme::MUTED, None => theme::WARN };
    rows.push(Row::new("pw:set", if set == Some(true) { "Change password…" } else { "Set password…" }).group(here).extra("remote password")
        .lead(dot(if set == Some(true) { "✓" } else { "·" }, color)).detail(vec![span("the remote password another machine links here with", fg(theme::MUTED))]).right(state));
    if set == Some(true) { rows.push(Row::new("pw:clear", "Clear password…").group(here).extra("remote password").lead(dot(" ", theme::MUTED)).detail(vec![span("no new links by password", fg(theme::MUTED))])) }
    if matches!(password, Some(Err(_))) { rows.push(Row::new("pw:status", "Retry").group(here).extra("password status").lead(dot("↻", theme::MUTED)).detail(vec![span("Password status is unavailable.", fg(theme::WARN))])) }

    let yours = "Your machines";
    for m in app.fleet.machines.iter().filter(|m| !m.shared) {
        if crate::local::is_local(&m.id) { continue }
        let (glyph, color, word) = reach(app, m);
        let rtt = app.rtt.get(&m.id).filter(|_| m.usable()).map(|d| format!("{}ms  ", d.as_millis())).unwrap_or_default();
        rows.push(Row::new(format!("m:{}", m.id), m.name.clone()).group(yours).extra(format!("{} {word}", m.id)).lead(dot(glyph, color)).detail(vec![span(word, fg(color))]).right(format!("{rtt}{}", counts(app, &m.id))));
    }
    if app.fleet.machines.iter().all(|m| crate::local::is_local(&m.id)) { rows.push(info("m-none", if app.daemon_down { "Harness is not running on this computer" } else { "Loading machines…" }, yours)) }

    let linked = "Linked from here";
    match &app.devices.links {
        None => rows.push(info("ln-loading", "Loading linked machines…", linked)),
        Some(Err(e)) => rows.push(info("ln-error", e.clone(), linked)),
        Some(Ok(list)) if list.is_empty() => rows.push(info("ln-none", "No machines linked yet.", linked)),
        Some(Ok(list)) => for l in list {
            let name = name_of(app, &l.machine);
            rows.push(Row::new(format!("ln:{}", l.machine), name).group(linked).extra(format!("{} {}", l.machine, l.fingerprint)).lead(dot("⇄", theme::TEAL)).detail(vec![span(l.fingerprint.clone(), fg(theme::MUTED))]).right(format!("linked {}", l.at)));
        },
    }
    rows.push(Row::new("ln:", "Refresh links").group(linked).lead(dot("↻", theme::MUTED)).detail(vec![span("Machines this computer can connect to.", fg(theme::MUTED))]));

    // The app's two steps, then a server's three — each Enter copies what it names.
    let add = "Add a machine";
    let email = app.devices.phone.email.clone();
    let sign = email.as_ref().map(|e| format!("Sign in as {e}.")).unwrap_or_else(|| "Sign in with the same account.".into());
    rows.push(Row::new("add:download", "1. Open Harness on your other computer.").group(add).extra("download").lead(dot("⧉", theme::TEAL)).detail(vec![span(sign, fg(theme::MUTED))]).right("copy"));
    rows.push(Row::new("add:connect", "2. Open Machines and choose Set password.").group(add).extra("password connect").lead(dot("→", theme::TEAL)).detail(vec![span("Back here, click Connect and enter that password.", fg(theme::MUTED))]));
    let server = "Set up a server";
    rows.push(Row::new("add:install", "1. Install the CLI (skip if installed)").group(server).extra(INSTALL).lead(dot("⧉", theme::TEAL)).detail(vec![span(INSTALL, fg(theme::MUTED))]).right("copy"));
    rows.push(Row::new("add:login", format!("2. Sign in as {}", email.as_deref().unwrap_or("your account"))).group(server).extra(LOGIN).lead(dot("⧉", theme::TEAL)).detail(vec![span(LOGIN, fg(theme::MUTED))]).right("copy"));
    rows.push(Row::new("add:start", "3. Start Harness and set a remote password").group(server).extra(START).lead(dot("⧉", theme::TEAL)).detail(vec![span(START, fg(theme::MUTED))]).right("copy"));
    rows.push(Row::new("add:all", "Copy commands").group(server).extra("all three").lead(dot("⧉", theme::TEAL)).detail(vec![span("Run these on your server over SSH:", fg(theme::MUTED))]).right("copy all"));
    rows
}

fn action_rows(app: &App, id: &str) -> Vec<Row> {
    let Some(m) = app.fleet.machine(id) else { return vec![info("gone", "That machine is gone", "")] };
    let group = m.name.clone();
    let mut rows = Vec::new();
    let act = |verb: &str, label: &str, hint: &str, glyph: &str| Row::new(format!("act:{verb}:{id}"), label).group(group.clone()).lead(dot(glyph, theme::TEAL)).detail(vec![span(hint.to_string(), fg(theme::MUTED))]);
    if m.usable() { rows.push(act("open", "Open its harnesses", "the harnesses list, on this machine", "→")) }
    if m.reach == Reach::NeedsLink && m.online() { rows.push(act("connect", "Connect…", "its remote password, then link", "⇄")) }
    rows.push(act("rename", "Rename…", "the name every device on the account shows", "✎"));
    if !m.local { rows.push(act("remove", "Remove from account…", "delete it from your account", "✗")) }
    rows
}

fn device_name(p: &Value) -> String {
    let label = p.get("label").and_then(Value::as_str).unwrap_or("").trim();
    if label.is_empty() || label == "harness link" || label == "browser" { "Linked device".into() } else { label.to_string() }
}

/// How long ago, in one short word: now, 5m, 3h, 2d, 6w.
fn short_ago(ms: u64) -> String {
    let mins = crate::fleet::now_ms().saturating_sub(ms) / 60_000;
    match mins { 0 => "now".into(), 1..=59 => format!("{mins}m"), 60..=1439 => format!("{}h", mins / 60), _ if mins / 1440 < 14 => format!("{}d", mins / 1440), _ => format!("{}w", mins / 1440 / 7) }
}

fn phone_rows(app: &App) -> Vec<Row> {
    let p = &app.devices.phone;
    let mut rows = Vec::new();
    let group = format!("Paired with this {}", this_computer());
    for d in &p.paired {
        let Some(fp) = d.get("fingerprint").and_then(Value::as_str) else { continue };
        let online = d.get("online").and_then(Value::as_bool) == Some(true);
        let when = if online { "online".to_string() } else { short_ago(d.get("pairedAt").and_then(Value::as_u64).unwrap_or(0)) };
        rows.push(Row::new(format!("ph:{fp}"), device_name(d)).group(group.clone()).extra(fp.to_string()).lead(dot(if online { "✓" } else { "·" }, if online { theme::ONLINE } else { theme::MUTED })).right(format!("{when}  enter removes")));
    }
    if !p.armed && !p.stopped && p.connected.is_none() { rows.push(Row::new("ph:arm", "Let a phone pair…").group("This code").lead(dot("▸", theme::TEAL)).detail(vec![span("hands this computer the code", fg(theme::MUTED))])) }
    rows.push(Row::new("ph:new", "New code").group("This code").lead(dot("↻", theme::MUTED)).detail(vec![span("the old one stops pairing", fg(theme::MUTED))]));
    rows
}

// ── previews ─────────────────────────────────────────────────────────────────

fn dim(text: impl Into<String>) -> Span<'static> { Span::styled(text.into(), Style::default().add_modifier(Modifier::DIM)) }
fn bold(text: impl Into<String>) -> Span<'static> { Span::styled(text.into(), Style::default().add_modifier(Modifier::BOLD)) }
fn kv(k: &str, v: impl Into<String>) -> Line<'static> { Line::from(vec![dim(format!("{k:<10}")), Span::raw(v.into())]) }
fn enter_does(text: impl Into<String>) -> Vec<Line<'static>> { vec![Line::raw(""), Line::from(vec![Span::styled("enter ", fg(theme::accent())), dim(text)])] }

/// The right side for the row under the cursor: what it is, and what Enter does.
pub fn preview(app: &App, view: View, id: &str) -> Vec<Line<'static>> {
    let (what, rest) = id.split_once(':').unwrap_or((id, ""));
    match what {
        _ if app.daemon_down && matches!(id, "none" | "m-none") => vec![Line::raw("Harness is not running on this computer."), Line::raw(""), dim("Start it with `harness start`, then come back.").into()],
        "none" => vec![Line::raw("No computers are ready to connect."), Line::raw(""), dim("Open Harness on the other computer and sign in to the same account.").into()],
        "here" if rest == "login" => vec![Line::raw("Sign in to see your other computers."), Line::raw(""),
            dim("Use the same Harness account on both. Your local agents work without signing in.").into(),
            Line::raw(""), dim("After signing in, open Connect a computer again.").into(),
            Line::raw(""), dim("Enter opens the normal Harness sign-in flow in a local terminal.").into()],
        "here" => vec![Line::raw("Set up Harness on your other computer."), Line::raw(""),
            dim("The setup guide covers sign-in, the remote password and servers.").into(),
            Line::raw(""), dim("Enter opens Machines & devices.").into()],
        "account" => vec![Line::raw("Use Harness locally without signing in."), Line::raw(""), Line::raw("Sign in to connect your computers, sync your workspace, and use your phone."), Line::raw("Run models on one linked computer and use them from another.")],
        "m" => {
            let mut out = machine_lines(app, rest);
            if view == View::Connect {
                out.push(Line::raw(""));
                out.push(dim("Enter the remote password set on this machine.").into());
                out.extend(stage_lines(app, rest));
                if app.devices.link.as_ref().is_none_or(|l| l.machine != rest) { out.extend(enter_does("type its remote password, then link")) }
            } else {
                out.extend(enter_does("its actions — open, connect, rename, remove from account"));
            }
            out
        }
        "act" => {
            let (verb, machine) = rest.split_once(':').unwrap_or((rest, ""));
            let mut out = machine_lines(app, machine);
            out.extend(enter_does(match verb {
                "open" => "opens its harnesses",
                "connect" => "asks for its remote password, then links it",
                "rename" => "asks for its new name, then y/n",
                "remove" => "asks y/n, then deletes it from your account",
                _ => "",
            }));
            out
        }
        "pw" => {
            let mut out = Vec::new();
            match &app.devices.password {
                Some(Ok(v)) if v.get("hasPassword").and_then(Value::as_bool) == Some(true) => {
                    out.push(Line::from(vec![Span::styled("Remote password is set", fg(theme::ONLINE).add_modifier(Modifier::BOLD))]));
                    if let Some(f) = v.get("fingerprint").and_then(Value::as_str) { out.push(kv("fingerprint", f)) }
                    if let Some(t) = v.get("setAt").and_then(Value::as_u64) { out.push(kv("set", format!("{} ago", crate::fleet::ago(t)))) }
                    out.push(Line::raw(""));
                    out.push(dim("On the other machine: Link machine → select this computer → enter its password.").into());
                }
                Some(Ok(_)) => { out.push(bold("No remote password set.").into()); out.push(Line::raw("")); out.push(dim("Use this password on the other machine to link to this computer.").into()) }
                Some(Err(e)) => { out.push(Line::from(vec![Span::styled("Password status is unavailable.", fg(theme::WARN))])); if e != "Password status is unavailable." { out.push(dim(e.clone()).into()) } }
                None => out.push(dim("Reading password status…").into()),
            }
            out.extend(enter_does(match rest { "set" => "asks for the new password twice, then y/n", "clear" => "asks y/n, then clears it — existing links stay", _ => "reads its status again" }));
            out
        }
        "ln" if rest.is_empty() => { let mut out = vec![Line::from(dim("Machines this computer can connect to."))]; out.extend(enter_does("reads `harness link list` again")); out }
        "ln" => {
            let Some(Ok(list)) = &app.devices.links else { return vec![] };
            let Some(l) = list.iter().find(|l| l.machine == rest) else { return vec![] };
            let mut out = vec![bold(name_of(app, rest)).into(), Line::raw(""), kv("machine", l.machine.clone()), kv("fingerprint", l.fingerprint.clone()), kv("linked", l.at.clone())];
            out.extend(enter_does("asks y/n, then unlinks it — a new connection will need its password"));
            out
        }
        "add" => {
            let (text, copies): (&str, String) = match rest {
                "download" => ("Download Harness on your other computer and sign in with the same account.", DOWNLOAD_URL.into()),
                "connect" => ("On the other computer: Machines → Set password. Back here, Connect a computer and enter that password.", String::new()),
                "install" => ("Run these on your server over SSH:", INSTALL.into()),
                "login" => ("Open the printed sign-in link in a browser on any device.", LOGIN.into()),
                "start" => ("Start Harness and set a remote password.", START.into()),
                _ => ("Run these on your server over SSH:", format!("{INSTALL}\n{LOGIN}\n{START}")),
            };
            let mut out = vec![Line::raw(text.to_string()), Line::raw("")];
            for l in copies.lines() { out.push(Line::from(vec![Span::styled(l.to_string(), fg(theme::TEAL))])) }
            out.extend(enter_does(if copies.is_empty() { "opens Connect a computer".to_string() } else { "copies it — to the clipboard of the computer you sit at".to_string() }));
            out
        }
        "ph" => {
            let Some(d) = app.devices.phone.paired.iter().find(|p| p.get("fingerprint").and_then(Value::as_str) == Some(rest)) else {
                return enter_does(if rest == "new" { "draws a new code; the old one no longer pairs" } else { "asks y/n, then hands this computer the code while the QR shows" });
            };
            let mut out = vec![bold(device_name(d)).into(), Line::raw(""), kv("fingerprint", rest.to_string())];
            if let Some(t) = d.get("pairedAt").and_then(Value::as_u64) { out.push(kv("paired", format!("{} ago", crate::fleet::ago(t)))) }
            out.extend(enter_does("asks y/n, then takes its access away"));
            out
        }
        _ => vec![],
    }
}

fn machine_lines(app: &App, id: &str) -> Vec<Line<'static>> {
    let Some(m) = app.fleet.machine(id) else { return vec![dim("(gone)").into()] };
    let (glyph, color, word) = reach(app, m);
    let mut out = vec![Line::from(vec![bold(m.name.clone()), dim(if m.local { "  this computer" } else { "" })]), Line::raw("")];
    out.push(Line::from(vec![dim(format!("{:<10}", "status")), Span::styled(format!("{glyph} {word}"), fg(color))]));
    if let Some(rtt) = app.rtt.get(id).filter(|_| m.usable()) { out.push(kv("rtt", format!("{}ms", rtt.as_millis()))) }
    let row = app.devices.account.get(id);
    let seen = row.and_then(|r| ["lastSeenAt", "lastSeen", "lastActiveAt", "updatedAt"].iter().find_map(|k| r.get(*k)));
    match seen {
        Some(Value::Number(n)) => { let ms = n.as_u64().unwrap_or(0); let ms = if ms < 10_000_000_000 { ms * 1000 } else { ms }; out.push(kv("last seen", format!("{} ago", crate::fleet::ago(ms)))) }
        Some(Value::String(s)) => out.push(kv("last seen", s.clone())),
        _ if m.online() => out.push(kv("last seen", "now")),
        _ => {}
    }
    out.push(kv("harnesses", counts(app, id)));
    let mut agents: Vec<_> = app.fleet.agents.values().filter(|a| a.machine_id == id && a.status != "stopped").collect();
    agents.sort_by_key(|a| std::cmp::Reverse(a.recency()));
    for a in agents.iter().take(6) { out.push(Line::from(vec![Span::raw(format!("  {}", a.name)), dim(format!("  {}", a.project))])) }
    if !m.online() && !m.local { out.push(Line::raw("")); out.push(dim(format!("Open Harness on {} to bring it online.", m.name)).into()) }
    out
}

/// The link's stages as far as they got: ✓ done, the spinner on the one it is at, ✗ where it
/// failed, · still to come — then how it ended.
fn stage_lines(app: &App, machine: &str) -> Vec<Line<'static>> {
    let Some(l) = app.devices.link.as_ref().filter(|l| l.machine == machine) else { return vec![] };
    let at = STAGES.iter().position(|(s, _)| *s == l.stage).unwrap_or(0);
    let mut out = vec![Line::raw("")];
    for (i, (_, words)) in STAGES.iter().enumerate() {
        let (mark, color) = match &l.result {
            Some(Ok(_)) => ("✓", theme::ONLINE),
            Some(Err(_)) if i == at => ("✗", theme::DANGER),
            _ if i < at => ("✓", theme::ONLINE),
            None if i == at => (theme::spinner(app.tick), theme::WARN),
            _ => ("·", theme::MUTED),
        };
        out.push(Line::from(vec![Span::styled(format!("{mark} "), fg(color)), Span::raw(words.to_string())]));
    }
    out.push(Line::raw(""));
    match &l.result {
        Some(Ok(f)) => { out.push(Line::from(vec![Span::styled(format!("✓ Linked {}", l.name), fg(theme::ONLINE).add_modifier(Modifier::BOLD))])); if !f.is_empty() { out.push(kv("fingerprint", f.clone())) } }
        Some(Err(e)) => out.push(Line::from(vec![Span::styled(format!("✗ {e}"), fg(theme::DANGER))])),
        None => out.push(dim("Connecting continues if you close this prompt.").into()),
    }
    out
}

// ── drawing ──────────────────────────────────────────────────────────────────

/// A title, where you are inside it, and the way out.
fn head(buf: &mut Buffer, app: &App, title: &str, x: u16, y: u16, right: u16, c: &Chrome) {
    let mut at = x + settings::put(buf, x, y, right.saturating_sub(x), title, c.base.add_modifier(Modifier::BOLD));
    let level = app.devices.sub.as_deref().and_then(|s| s.strip_prefix("m:")).map(|id| name_of(app, id));
    if let Some(level) = level {
        at += settings::put(buf, at, y, right.saturating_sub(at), "  ›  ", c.muted);
        settings::put(buf, at, y, right.saturating_sub(at), &level, c.accent);
    }
    settings::put(buf, right.saturating_sub(3), y, 3, "esc", c.muted);
}

/// The query line — or, while the panel asks for a line, that line (a password as dots).
fn query_line(buf: &mut Buffer, app: &App, picker: &Picker, x: u16, y: u16, right: u16, c: &Chrome) -> Option<Position> {
    let w = right.saturating_sub(x);
    if let Some(Ask::Entry { label, value, secret, .. }) = &app.devices.ask {
        let at = x + settings::put(buf, x, y, w, &format!("{label} › "), c.accent);
        let shown = if *secret { "•".repeat(value.chars().count()) } else { value.clone() };
        settings::put(buf, at, y, right.saturating_sub(at), &shown, c.base);
        return Some(Position::new((at + shown.width() as u16).min(right), y));
    }
    settings::put(buf, x, y, 2, "›", c.accent);
    let shown = if picker.query.is_empty() { (picker.placeholder.as_str(), c.muted) } else { (picker.query.as_str(), c.base) };
    settings::put(buf, x + 2, y, w.saturating_sub(2), shown.0, shown.1);
    picker.prompt_at.set((y, x + 2));
    let before: String = picker.query.chars().take(picker.qcursor).collect();
    (app.devices.ask.is_none()).then(|| Position::new((x + 2 + before.width() as u16).min(right), y))
}

/// Mouse actions occupy the existing footer only while a prompt needs an answer.
fn prompt_actions(buf: &mut Buffer, app: &App, x: u16, y: u16, w: u16, c: &Chrome) {
    let confirm = matches!(app.devices.ask, Some(Ask::Confirm { .. }));
    let accept = if confirm { " Yes " } else if w < 19 { " Next " } else { " Continue " };
    let cancel = " Cancel ";
    let needed = accept.width() as u16 + cancel.width() as u16 + 1;
    if w < needed { return }
    let yes = Rect::new(x, y, accept.width() as u16, 1);
    let no = Rect::new(yes.right() + 1, y, cancel.width() as u16, 1);
    settings::put(buf, yes.x, y, yes.width, accept, c.selected);
    settings::put(buf, no.x, y, no.width, cancel, c.selected);
    if confirm && w >= needed + 5 { settings::put(buf, no.right() + 2, y, 3, "y/n", c.muted); }
    app.devices.prompt_actions.set(Some(PromptActions { size:app.size, accept:yes, cancel:no }));
}

fn confirmation(buf: &mut Buffer, app: &App, r: Rect, c: &Chrome) {
    let Some(Ask::Confirm { question, .. }) = &app.devices.ask else { return };
    text(buf, r, &[Line::from(Span::styled(question.clone(), c.accent))], c);
}

/// [lines] in [r], each wrapped at its words; a dim span in the panel's muted colour. Returns the
/// rows used.
fn text(buf: &mut Buffer, r: Rect, lines: &[Line<'static>], c: &Chrome) -> u16 {
    let mut y = r.y;
    for line in lines {
        if y >= r.bottom() { break }
        let (mut x, mut wrapped) = (r.x, false);
        for s in &line.spans {
            let style = if s.style.add_modifier.contains(Modifier::DIM) { c.muted.patch(s.style.remove_modifier(Modifier::DIM)) } else { c.base.patch(s.style) };
            for word in s.content.split_inclusive(' ') {
                let bare = word.trim_end();
                let w = bare.width() as u16;
                if x + w > r.right() && x > r.x && w > 0 { y += 1; x = r.x; wrapped = true; if y >= r.bottom() { return y - r.y } }
                // (A wrapped line starts at its word, not at the space before it; the space after
                // the last word that fits is left off rather than cut.)
                if wrapped && x == r.x && bare.is_empty() { continue }
                let piece = if x + word.width() as u16 > r.right() { bare } else { word };
                x += settings::put(buf, x, y, r.right().saturating_sub(x), piece, style);
            }
        }
        y += 1;
    }
    y.saturating_sub(r.y)
}

/// What the footer says: the question being asked, the typed line's keys, what just happened or
/// went wrong, else the keys.
fn footer(buf: &mut Buffer, app: &App, picker: &Picker, x: u16, y: u16, w: u16, c: &Chrome) {
    let danger = c.base.patch(fg(theme::DANGER));
    if app.devices.ask.is_some() {
        if matches!(app.devices.ask, Some(Ask::Entry { .. })) {
            if let Some((message, error, _)) = &app.devices.footer {
                settings::put(buf, x, y.saturating_sub(1), w, message, if *error { danger } else { c.muted });
            }
        }
        prompt_actions(buf, app, x, y, w, c);
        return;
    }
    let (line, style) = match app.devices.footer.as_ref().filter(|(_, err, at)| *err || at.elapsed() < Duration::from_secs(6)) {
        Some((t, err, _)) => (t.clone(), if *err { danger } else { c.accent }),
        None => (format!("↑↓ move   enter choose   type to search   esc {}", if app.devices.sub.is_some() || picker.from_commands { "back" } else { "close" }), c.muted),
    };
    // (Too long for one line — a question beside the QR code — it takes the line above too.)
    if line.width() as u16 <= w || y == 0 { settings::put(buf, x, y, w, &line, style); return }
    let line = Line::from(Span::styled(line, Style::default().fg(style.fg.unwrap_or(Color::Reset)).add_modifier(style.add_modifier)));
    text(buf, Rect::new(x, y - 1, w, 2), &[line], c);
}

/// Draw [view] as the panel: the settings panel's surface, title, query line, list and footer, the
/// row's preview on the right — and for Add phone the QR code, as tall as the panel.
pub fn draw(buf: &mut Buffer, app: &App, body: Rect, view: View, picker: &mut Picker) -> Option<Position> {
    let c = settings::chrome();
    app.devices.prompt_actions.set(None);
    app.devices.phone.drawn.set(None);
    picker.screen_area.set(body);
    picker.list_area.set(Rect::default());
    picker.row_at.clear();
    picker.preview_area.set(None);
    picker.bar.set(None);
    settings::backdrop(buf, body, c.backdrop);
    if body.width < 24 || body.height < 8 {
        settings::put(buf, body.x, body.y, body.width, &format!("{} · resize or Esc", view.title()), c.base);
        return None;
    }
    let r = settings::area(body, PickerKind::Devices(view).size(), 0);
    settings::fill(buf, r, c.base);
    picker.screen_area.set(r);
    picker.preview_area.set(None);
    picker.bar.set(None);
    if view == View::Phone { return phone_draw(buf, app, r, picker, &c) }
    let (x, right) = (r.x + 2, r.right().saturating_sub(2));
    let inner_w = right.saturating_sub(x);
    head(buf, app, view.title(), x, r.y + 1, right, &c);
    if matches!(app.devices.ask, Some(Ask::Confirm { .. })) {
        confirmation(buf, app, Rect::new(x, r.y + 3, inner_w, r.height.saturating_sub(5)), &c);
        footer(buf, app, picker, x, r.bottom().saturating_sub(2), inner_w, &c);
        return None;
    }
    let cursor = query_line(buf, app, picker, x, r.y + 3, right, &c);
    let (top, bottom) = (r.y + 5, r.bottom().saturating_sub(3));
    let side = inner_w >= 64;
    let list_w = if side { (inner_w / 2).clamp(30, 48) } else { inner_w };
    settings::list(buf, picker, Rect::new(x, top, list_w, bottom.saturating_sub(top)), &c, !side);
    if side {
        let px = x + list_w + 3;
        let lines = picker.current_id().map(|id| preview(app, view, &id)).unwrap_or_default();
        text(buf, Rect::new(px, r.y + 3, right.saturating_sub(px), bottom.saturating_sub(r.y + 3)), &lines, &c);
    }
    footer(buf, app, picker, x, r.bottom().saturating_sub(2), inner_w, &c);
    cursor
}

/// Add phone: the QR on the left, from the panel's top to its bottom (two modules a row), and
/// beside it what to do, the code in text, the paired devices, and the footer.
fn phone_draw(buf: &mut Buffer, app: &App, r: Rect, picker: &mut Picker, c: &Chrome) -> Option<Position> {
    let p = &app.devices.phone;
    let right = r.right().saturating_sub(2);
    let mut tx = r.x + 2;
    let mut needs = None;
    p.drawn.set(None);
    let link = phone_link(app);
    if let Some(link) = &link {
        let (cols, rows) = (r.width.saturating_sub(2 + 34), r.height);
        let cached = p.cache.borrow().as_ref().filter(|(l, w, h, _)| l == link && *w == cols && *h == rows).map(|(_, _, _, m)| m.clone());
        let modules = cached.unwrap_or_else(|| { let m = qr_modules(link, cols, rows); *p.cache.borrow_mut() = Some((link.clone(), cols, rows, m.clone())); m });
        match modules {
            Some(m) => {
                let n = m.len().div_ceil(2) as u16;
                let at = draw_qr(buf, r.x + 1, r.y + (r.height - n) / 2, &m, p.connected.is_some() || p.stopped);
                p.drawn.set(Some(at));
                tx = at.right() + 3;
            }
            None => needs = Some(qr_least(link)),
        }
    }
    let tw = right.saturating_sub(tx);
    head(buf, app, View::Phone.title(), tx, r.y + 1, right, c);
    let computer = this_computer();
    let mut lines: Vec<Line<'static>> = Vec::new();
    if let Some(Ask::Confirm { question, .. }) = &app.devices.ask {
        lines.extend([Line::from(Span::styled(question.clone(), c.accent)), Line::raw("")]);
    }
    let status = |text: String, color: Color| Line::from(Span::styled(text, fg(color)));
    if p.signed_out {
        lines.push(Line::raw("Sign in to add your phone."));
    } else if target(app).is_none() {
        lines.push(dim(if p.email.is_some() || app.daemon_down { format!("Waiting for Harness on this {computer}…") } else { "Waiting for your account…".into() }).into());
    } else if !p.sign_in_asked {
        lines.push(dim("Getting a sign-in code…").into());
    } else {
        if let Some((w, h)) = needs {
            // (The panel is at most 104 × 28; the words beside the code take 34 columns.)
            lines.push(status(if h <= 28 && w + 36 <= 104 { format!("Make the window at least {}×{} to show the QR code.", w + 40, h + 3) } else { "The QR code is too big for the panel.".into() }, theme::WARN));
        }
        lines.push(match (&p.connected, &p.message) {
            (Some(label), _) => status(format!("✓ Connected {label}"), theme::ONLINE),
            (None, Some(m)) => status(m.clone(), theme::DANGER),
            _ if !p.armed => dim("Not pairing yet").into(),
            _ => dim("Scan with Harness on your iPhone").into(),
        });
        lines.push(Line::raw(""));
        let grouped: Vec<String> = p.code.as_bytes().chunks(4).map(|g| String::from_utf8_lossy(g).to_string()).collect();
        lines.push(Line::from(vec![dim("Code  "), bold(grouped.join(" "))]));
        let machine = app.fleet.machine_name(&app.fleet.local_id);
        lines.push(dim(format!("Pairs with {} · signs in as {}", if machine.is_empty() { format!("this {computer}") } else { machine }, p.email.clone().unwrap_or_default())).into());
        if p.sign_in.is_none() { lines.push(dim("Your phone will ask for an emailed sign-in code.").into()) }
    }
    let used = text(buf, Rect::new(tx, r.y + 3, tw, r.height.saturating_sub(6)), &lines, c);
    let top = r.y + 3 + used + 1;
    let bottom = r.bottom().saturating_sub(3);
    if top < bottom { settings::list(buf, picker, Rect::new(tx, top, tw, bottom - top), c, false) } else { picker.row_at.clear() }
    footer(buf, app, picker, tx, r.bottom().saturating_sub(2), tw, c);
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    const LOCAL: &str = "4f3c2b1a-9e8d-4c7b-a6f5-0e1d2c3b4a59";
    const REMOTE: &str = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
    const OFF: &str = "11111111-2222-4333-8444-555555555555";

    fn app(size: (u16, u16)) -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, size);
        app.fleet.local_id = LOCAL.into();
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: LOCAL.into(), name: "studio".into(), local: true, status: "online".into(), reach: Reach::Ready });
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: REMOTE.into(), name: "gpu-box".into(), local: false, status: "online".into(), reach: Reach::NeedsLink });
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: OFF.into(), name: "laptop".into(), local: false, status: "offline".into(), reach: Reach::Offline });
        app
    }

    /// The world as the tests' fake CLI and daemon tell it.
    fn world(req: &Req) -> Option<Reply> {
        let ok = |out: &str| Some(Reply::Cli { ok: true, out: format!("{out}\n"), err: String::new() });
        match req {
            Req::Wait(_) => None,
            Req::Cli { args, .. } => match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
                ["remote-password", "status", "--json"] => ok(r#"{"hasPassword":true,"fingerprint":"K7QF-2M9D","setAt":1759200000000}"#),
                ["link", "list"] => ok(&format!("\n  Linked machines:\n\n    1. {REMOTE}  K7QF-2M9D-X4PL  (linked 2026-09-30 09:15)\n")),
                ["link", "connect", ..] => ok("{\"stage\":\"connecting\"}\n{\"stage\":\"deriving_key\"}\n{\"stage\":\"exchanging\"}\n{\"stage\":\"verifying\"}\n{\"ok\":true,\"fingerprint\":\"ZZ99-AA11\",\"machineId\":\"x\",\"mutual\":true}"),
                _ => ok(r#"{"ok":true}"#),
            },
            Req::Http { method, path, .. } => Some(Reply::Http(match (*method, path.as_str()) {
                ("GET", "/api/machines") => Ok(json!({ "machines": [{ "machineId": REMOTE, "name": "gpu-box", "status": "online", "lastSeenAt": 1759200000000u64 }] })),
                ("GET", "/api/auth/me") => Ok(json!({ "user": { "email": "dev+hn@example.com" } })),
                ("POST", "/api/auth/handoff") => Ok(json!({ "code": "hs_4d1f0c6e2b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e", "expiresIn": 90 })),
                ("GET", "/api/pairs") => Ok(json!({ "pairs": [{ "fingerprint": "PH-1", "label": "Dee's iPhone", "pairedAt": 1759200000000u64, "online": true, "role": "web" }, { "fingerprint": "DEV-1", "label": "Cabled gadget", "role": "device" }] })),
                ("POST", "/api/pair") => Err(("HTTP_409".into(), "NO_INTENT".into())),
                _ => Ok(json!({})),
            })),
            _ => Some(Reply::Done),
        }
    }

    /// The fake world, every request it was asked written down.
    fn fake(app: &mut App) -> Arc<Mutex<Vec<Req>>> {
        let log = Arc::new(Mutex::new(Vec::new()));
        let seen = log.clone();
        app.devices.runner = Some(Box::new(move |req: &Req| { seen.lock().unwrap().push(req.clone()); world(req) }));
        log
    }

    fn press(app: &mut App, code: KeyCode) { crate::input::modal_key(app, KeyEvent::new(code, KeyModifiers::NONE)) }
    fn typed(app: &mut App, text: &str) { for c in text.chars() { press(app, KeyCode::Char(c)) } }
    fn go_to(app: &mut App, id: &str) {
        let Some(Modal::Picker { picker: p, .. }) = &mut app.modal else { panic!("no list open") };
        p.select(id);
        assert_eq!(p.current_id().as_deref(), Some(id), "no row {id}");
    }
    fn ids(app: &App) -> Vec<String> { match &app.modal { Some(Modal::Picker { picker, .. }) => picker.rows.iter().map(|r| r.id.clone()).collect(), _ => vec![] } }
    fn clis(log: &Arc<Mutex<Vec<Req>>>, first: &str) -> Vec<Req> { log.lock().unwrap().iter().filter(|r| matches!(r, Req::Cli { args, .. } if args.first().map(String::as_str) == Some(first))).cloned().collect() }
    fn has(log: &Arc<Mutex<Vec<Req>>>, want: &Req) -> bool { log.lock().unwrap().contains(want) }

    fn screen(app: &mut App, w: u16, h: u16) -> (String, Buffer) {
        let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(w, h)).unwrap();
        term.draw(|f| crate::ui::draw(f, app)).unwrap();
        let buf = term.backend().buffer().clone();
        ((0..h).map(|y| (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n"), buf)
    }

    #[test]
    fn the_commands_panel_lists_the_three_views_under_machines() {
        let app = app((150, 42));
        let rows = crate::modal::command_rows(&app);
        for view in View::ALL {
            let row = rows.iter().find(|r| r.id == format!("cmd:{}", view.id())).unwrap_or_else(|| panic!("{} missing", view.id()));
            assert_eq!(row.group.as_deref(), Some("Machines"));
            assert!(crate::input::is_command(view.id()));
        }
    }

    #[test]
    fn machines_and_devices_has_its_sections_and_rows() {
        let mut app = app((150, 42));
        let _log = fake(&mut app);
        crate::input::run(&mut app, "devices");
        let rows = ids(&app);
        for id in ["pw:set", "pw:clear", &format!("m:{LOCAL}"), &format!("m:{REMOTE}"), &format!("m:{OFF}"), &format!("ln:{REMOTE}"), "ln:", "add:download", "add:connect", "add:install", "add:login", "add:start", "add:all"] {
            assert!(rows.iter().any(|r| r == id), "{id} missing from {rows:?}");
        }
        let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!() };
        let groups: Vec<&str> = picker.rows.iter().filter_map(|r| r.group.as_deref()).collect::<Vec<_>>();
        let mut seen: Vec<&str> = Vec::new();
        for g in groups { if seen.last() != Some(&g) { seen.push(g) } }
        assert_eq!(seen, vec!["Account", "This computer", "Your machines", "Linked from here", "Add a machine", "Set up a server"], "each group once, in order");
        assert!(picker.rows.iter().any(|r| r.id == "add:login" && r.label == "2. Sign in as dev+hn@example.com"), "the server steps name the account");
        // A machine opens its actions: no Remove for this computer, Connect for one not linked.
        go_to(&mut app, &format!("m:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        let acts = ids(&app);
        assert!(acts.contains(&format!("act:connect:{REMOTE}")) && acts.contains(&format!("act:remove:{REMOTE}")) && acts.contains(&format!("act:rename:{REMOTE}")), "{acts:?}");
        press(&mut app, KeyCode::Esc);
        assert_eq!(picker_mut(&mut app).and_then(|p| p.current_id()), Some(format!("m:{REMOTE}")), "back on the machine");
        go_to(&mut app, &format!("m:{LOCAL}"));
        press(&mut app, KeyCode::Enter);
        assert!(!ids(&app).iter().any(|r| r.starts_with("act:remove")), "this computer cannot be removed here");
    }

    #[test]
    fn connect_lists_only_the_machines_not_linked() {
        let mut app = app((150, 42));
        let _log = fake(&mut app);
        crate::input::run(&mut app, "connect-machine");
        let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!() };
        let usable: Vec<&str> = picker.rows.iter().filter(|r| !r.disabled).map(|r| r.id.as_str()).collect();
        assert_eq!(usable, vec![format!("m:{REMOTE}").as_str(), "here:setup"]);
        assert!(picker.rows.iter().any(|r| r.id == format!("m:{OFF}") && r.disabled), "an offline one is shown, not chosen");
    }

    #[test]
    fn signed_out_connect_explains_the_next_step_and_setup_stays_reachable() {
        for code in ["HTTP_401", "NOT_SIGNED_IN"] {
            let mut app = app((150, 42));
            app.fleet.machines.retain(|m| m.local);
            app.devices.runner = Some(Box::new(move |req| match req {
                Req::Http { path, .. } if path == "/api/auth/me" => Some(Reply::Http(Err((code.into(), "Sign in".into())))),
                _ => world(req),
            }));
            open(&mut app, View::Connect);
            assert_eq!(ids(&app), vec!["account", "local-use", "here:setup"]);
            if let Some(Modal::Picker { picker, .. }) = &app.modal {
                assert!(picker.rows.iter().any(|r| r.id == "local-use" && r.disabled));
            }
            let (text, _) = screen(&mut app, 150, 42);
            assert!(text.contains("Local harnesses work without an account"), "{text}");
            assert!(!text.contains("Every machine on your account"));
            go_to(&mut app, "here:setup");
            press(&mut app, KeyCode::Enter);
            assert!(matches!(app.modal, Some(Modal::Picker { kind: PickerKind::Devices(View::Machines), .. })));
        }
    }

    #[test]
    fn connecting_asks_the_password_hidden_then_yes_then_shows_each_stage() {
        let mut app = app((150, 42));
        let log = fake(&mut app);
        crate::input::run(&mut app, "connect-machine");
        press(&mut app, KeyCode::Enter);
        assert!(matches!(app.devices.ask, Some(Ask::Entry { secret: true, .. })), "the password is asked for, hidden");
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.devices.footer.as_ref().map(|f| f.0.as_str()), Some("Enter the remote password first"));
        typed(&mut app, "hunter2");
        let (s, _) = screen(&mut app, 150, 42);
        assert!(s.contains("Remote password for gpu-box › •••••••") && !s.contains("hunter2"), "shown as dots:\n{s}");
        press(&mut app, KeyCode::Enter);
        assert!(clis(&log, "link").iter().all(|r| !matches!(r, Req::Cli { args, .. } if args[1] == "connect")), "nothing runs before the yes");
        assert!(matches!(app.devices.ask, Some(Ask::Confirm { .. })));
        press(&mut app, KeyCode::Char('y'));
        let run = clis(&log, "link").into_iter().find(|r| matches!(r, Req::Cli { args, .. } if args[1] == "connect")).expect("link connect ran");
        assert_eq!(run, Req::Cli { args: ["link", "connect", REMOTE, "--stdin", "--json", "--name=gpu-box"].iter().map(|s| s.to_string()).collect(), stdin: Some("hunter2".into()) }, "the password on stdin, never an argument");
        let l = app.devices.link.as_ref().unwrap();
        assert_eq!(l.stage, "verifying");
        assert_eq!(l.result, Some(Ok("ZZ99-AA11".into())));
        let (s, _) = screen(&mut app, 150, 42);
        for stage in STAGES.iter().map(|s| s.1) { assert!(s.contains(&format!("✓ {stage}")), "{stage} done:\n{s}") }
        assert!(s.contains("Linked gpu-box"));
    }

    #[test]
    fn clicking_a_machine_row_does_not_submit_the_password_prompt() {
        let mut app = app((150, 42));
        app.mouse = true;
        let log = fake(&mut app);
        connect_to(&mut app, REMOTE.into());
        typed(&mut app, "unfinished-password");
        screen(&mut app, 150, 42);
        let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!("no machines panel") };
        let row = picker.row_at.iter().find(|(_, index)| picker.rows[picker.visible[*index].0].id == format!("m:{REMOTE}")).map(|(row, _)| *row).expect("visible machine row");
        let column = picker.list_area.get().x + 2;
        for kind in [crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left), crossterm::event::MouseEventKind::Up(crossterm::event::MouseButton::Left)] {
            crate::input::handle(&mut app, crossterm::event::Event::Mouse(crossterm::event::MouseEvent { kind, column, row, modifiers: KeyModifiers::NONE }));
        }
        assert!(matches!(&app.devices.ask, Some(Ask::Entry { value, .. }) if value == "unfinished-password"), "clicking another control must not accept a password");
        assert!(clis(&log, "link").iter().all(|r| !matches!(r, Req::Cli { args, .. } if args[1] == "connect")));
    }

    fn click_at(app: &mut App, column: u16, row: u16) {
        for kind in [MouseEventKind::Down(MouseButton::Left), MouseEventKind::Up(MouseButton::Left)] {
            crate::input::handle(app, crossterm::event::Event::Mouse(MouseEvent { kind, column, row, modifiers: KeyModifiers::NONE }));
        }
    }

    fn click_prompt(app: &mut App, accept: bool) {
        let size = app.size;
        screen(app, size.0, size.1);
        let actions = app.devices.prompt_actions.get().expect("visible prompt actions");
        let rect = if accept { actions.accept } else { actions.cancel };
        click_at(app, rect.x + 1, rect.y);
    }

    #[test]
    fn pasted_passwords_stay_masked_and_never_become_search_or_confirmation() {
        for buffer in [false, true] {
            let mut app = app((150, 42));
            let log = fake(&mut app);
            connect_to(&mut app, REMOTE.into());
            if buffer {
                crate::commands::execute(&mut app, "set-buffer -b private-test '秘密 pasted password'");
                crate::commands::execute(&mut app, "paste-buffer -b private-test");
            } else { crate::input::handle(&mut app, crossterm::event::Event::Paste("秘密 pasted password\r\n".into())); }
            assert!(matches!(&app.devices.ask, Some(Ask::Entry { value, secret:true, .. }) if value == "秘密 pasted password"));
            let (visible, _) = screen(&mut app, 150, 42);
            assert!(!visible.contains("pasted password"), "password is masked");
            assert!(picker_mut(&mut app).unwrap().query.is_empty(), "password never enters the search");
            press(&mut app, KeyCode::Enter);
            crate::input::handle(&mut app, crossterm::event::Event::Paste("y\n".into()));
            assert!(matches!(app.devices.ask, Some(Ask::Confirm { .. })), "paste is never a yes");
            assert!(clis(&log, "link").iter().all(|r| !matches!(r, Req::Cli { args, .. } if args[1] == "connect")));
            press(&mut app, KeyCode::Esc);
            let (visible, _) = screen(&mut app, 150, 42);
            assert!(!visible.contains("pasted password"));
            assert!(picker_mut(&mut app).unwrap().query.is_empty());
        }
    }

    #[test]
    fn mouse_link_requires_continue_then_explicit_yes_and_cancel_writes_nothing() {
        let mut app = app((150, 42));
        app.mouse = true;
        let log = fake(&mut app);
        connect_to(&mut app, REMOTE.into());
        typed(&mut app, "fixture password");
        click_prompt(&mut app, true);
        assert!(matches!(app.devices.ask, Some(Ask::Confirm { .. })));
        click_prompt(&mut app, false);
        assert!(app.devices.ask.is_none());
        assert!(clis(&log, "link").iter().all(|r| !matches!(r, Req::Cli { args, .. } if args[1] == "connect")));
        connect_to(&mut app, REMOTE.into());
        typed(&mut app, "fixture password");
        click_prompt(&mut app, true);
        assert!(matches!(app.devices.ask, Some(Ask::Confirm { .. })));
        click_prompt(&mut app, true);
        assert_eq!(clis(&log, "link").iter().filter(|r| matches!(r, Req::Cli { args, stdin:Some(secret) } if args[1] == "connect" && secret == "fixture password")).count(), 1);
        assert!(app.devices.ask.is_none(), "the release must not open the next row");
    }

    #[test]
    fn device_confirmation_buttons_survive_resize_and_hidden_targets_do_not_run() {
        let mut app = app((150, 42));
        app.mouse = true;
        let log = fake(&mut app);
        crate::input::run(&mut app, "devices");
        let clear = cli(&["remote-password", "clear", "--json"], None);
        for (w, h) in [(150, 42), (80, 24), (40, 12), (24, 10)] {
            go_to(&mut app, "pw:clear");
            press(&mut app, KeyCode::Enter);
            crate::input::handle(&mut app, crossterm::event::Event::Resize(w, h));
            let (visible, _) = screen(&mut app, w, h);
            assert!(visible.contains(" Yes ") && visible.contains(" Cancel "), "{w}x{h}:\n{visible}");
            click_prompt(&mut app, false);
            assert!(app.devices.ask.is_none());
            assert!(!has(&log, &clear));
        }
        go_to(&mut app, "pw:clear"); press(&mut app, KeyCode::Enter);
        crate::input::handle(&mut app, crossterm::event::Event::Resize(80, 24));
        screen(&mut app, 80, 24);
        crate::input::handle(&mut app, crossterm::event::Event::Resize(12, 5));
        screen(&mut app, 12, 5);
        assert!(app.devices.prompt_actions.get().is_none());
        click_at(&mut app, 4, 3);
        assert!(!has(&log, &clear));
        assert!(matches!(app.devices.ask, Some(Ask::Confirm { .. })));
        crate::input::handle(&mut app, crossterm::event::Event::Resize(80, 24));
        click_prompt(&mut app, true);
        assert_eq!(clis(&log, "remote-password").iter().filter(|r| **r == clear).count(), 1);
    }

    /// M-l on a machine (the machines list) is this same flow: the panel, its password asked for.
    #[test]
    fn m_l_opens_connect_with_the_password_asked() {
        let mut app = app((150, 42));
        let _log = fake(&mut app);
        connect_to(&mut app, REMOTE.into());
        assert!(matches!(&app.modal, Some(Modal::Picker { kind: PickerKind::Devices(View::Connect), picker }) if picker.current_id() == Some(format!("m:{REMOTE}"))));
        assert!(matches!(&app.devices.ask, Some(Ask::Entry { what: Entry::Link { machine, .. }, secret: true, .. }) if machine == REMOTE));
    }

    #[test]
    fn stages_come_in_as_the_cli_prints_them_and_a_refusal_says_why() {
        assert_eq!(stage_of(r#"{"stage":"deriving_key"}"#).as_deref(), Some("deriving_key"));
        assert_eq!(stage_of(r#"{"ok":true}"#), None);
        assert_eq!(stage_of("not json"), None);
        let out = "{\"stage\":\"connecting\"}\n{\"stage\":\"deriving_key\"}\n{\"ok\":false,\"error\":\"WRONG_PASSWORD\",\"message\":\"That password is wrong. Check it against the other machine and try again.\"}\n";
        assert_eq!(last_json(out).and_then(|v| v.get("error").cloned()), Some(json!("WRONG_PASSWORD")), "a stage line is never the result");
        let mut app = app((150, 42));
        let reply = out.to_string();
        app.devices.runner = Some(Box::new(move |req: &Req| match req { Req::Cli { .. } => Some(Reply::Cli { ok: false, out: reply.clone(), err: String::new() }), _ => world(req) }));
        link_connect(&mut app, REMOTE.into(), "gpu-box".into(), "wrong".into());
        let l = app.devices.link.as_ref().unwrap();
        assert_eq!(l.stage, "deriving_key", "it failed where it was");
        assert_eq!(l.result, Some(Err("That password is wrong. Check it against the other machine and try again.".into())));
        let lines: Vec<String> = stage_lines(&app, REMOTE).iter().map(|l| l.spans.iter().map(|s| s.content.to_string()).collect()).collect();
        assert!(lines.iter().any(|l| l == "✓ Connecting") && lines.iter().any(|l| l == "✗ Checking the password") && lines.iter().any(|l| l == "· Exchanging keys"), "{lines:?}");
    }

    #[test]
    fn link_list_is_read_from_the_cli_text() {
        let out = "\n  Linked machines:\n\n    1. 7a6b5c4d-3e2f  K7QF-2M9D  (linked 2026-09-30 09:15)\n   12. box-2  AB12  (linked 2026-01-02 03:04)\n";
        assert_eq!(parse_links(out), vec![
            Linked { machine: "7a6b5c4d-3e2f".into(), fingerprint: "K7QF-2M9D".into(), at: "2026-09-30 09:15".into() },
            Linked { machine: "box-2".into(), fingerprint: "AB12".into(), at: "2026-01-02 03:04".into() },
        ]);
        assert!(parse_links("\n  No machines linked yet.\n").is_empty());
    }

    #[test]
    fn every_write_asks_first() {
        let mut app = app((150, 42));
        let log = fake(&mut app);
        crate::input::run(&mut app, "devices");
        // Unlink: y/n first; n changes nothing, y runs it.
        go_to(&mut app, &format!("ln:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        assert!(matches!(&app.devices.ask, Some(Ask::Confirm { question, .. }) if question.contains("gpu-box")));
        press(&mut app, KeyCode::Char('n'));
        let unlink = cli(&["link", "unlink", REMOTE], None);
        assert!(!has(&log, &unlink), "n: nothing ran");
        go_to(&mut app, &format!("ln:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('y'));
        assert!(has(&log, &unlink), "y: unlinked");
        // Set password: twice, a mismatch caught, then y/n.
        go_to(&mut app, "pw:set");
        press(&mut app, KeyCode::Enter);
        typed(&mut app, "abc");
        press(&mut app, KeyCode::Enter);
        typed(&mut app, "abd");
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.devices.footer.as_ref().map(|f| f.0.as_str()), Some("Passwords do not match"));
        typed(&mut app, "abc");
        press(&mut app, KeyCode::Enter);
        typed(&mut app, "abc");
        press(&mut app, KeyCode::Enter);
        let set = cli(&["remote-password", "set", "--stdin", "--json"], Some("abc".into()));
        assert!(!has(&log, &set));
        press(&mut app, KeyCode::Char('y'));
        assert!(has(&log, &set), "the password went on stdin");
        // Clear.
        go_to(&mut app, "pw:clear");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Esc);
        assert!(!has(&log, &cli(&["remote-password", "clear", "--json"], None)));
        // Rename, then remove from the account.
        go_to(&mut app, &format!("m:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        go_to(&mut app, &format!("act:rename:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('u'));
        crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
        typed(&mut app, "render-box");
        press(&mut app, KeyCode::Enter);
        let rename = http("PATCH", format!("/api/machines/{REMOTE}"), Some(json!({ "name": "render-box" })));
        assert!(!has(&log, &rename));
        press(&mut app, KeyCode::Char('y'));
        assert!(has(&log, &rename));
        assert_eq!(app.fleet.machine_name(REMOTE), "render-box");
        go_to(&mut app, &format!("act:remove:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        let remove = http("DELETE", format!("/api/machines/{REMOTE}"), None);
        assert!(!has(&log, &remove));
        press(&mut app, KeyCode::Char('y'));
        assert!(has(&log, &remove));
        assert!(app.fleet.machine(REMOTE).is_none(), "gone from the list");
    }

    #[test]
    fn the_phone_link_is_the_apps() {
        assert_eq!(pair_link("dev+hn@example.com", "m-1", "ABCDEFGHJKMNPQRS", Some("a b/c")), "https://harness.autonomous.ai/pair#e=dev%2Bhn%40example.com&m=m-1&c=ABCDEFGHJKMNPQRS&h=a+b%2Fc");
        assert_eq!(pair_link("a@b.co", "m", "C", None), "https://harness.autonomous.ai/pair#e=a%40b.co&m=m&c=C");
        for _ in 0..50 {
            let code = new_code();
            assert_eq!(code.len(), CODE_LEN);
            assert!(code.bytes().all(|b| CODE_ALPHABET.contains(&b)), "{code}");
        }
        assert_ne!(new_code(), new_code());
    }

    /// Read the QR drawn in [buf] at [at] back to its modules, as a camera would see them, and decode it.
    fn decode(buf: &Buffer, at: Rect) -> String {
        let n = at.width as usize;
        let mut grid = vec![vec![false; n]; at.height as usize * 2];
        for row in 0..at.height as usize {
            for col in 0..n {
                let s = buf[(at.x + col as u16, at.y + row as u16)].symbol().to_string();
                grid[2 * row][col] = s == "█" || s == "▀";
                grid[2 * row + 1][col] = s == "█" || s == "▄";
                assert_eq!(buf[(at.x + col as u16, at.y + row as u16)].bg, theme::depth_fit(Color::Rgb(255, 255, 255)), "light behind every module");
            }
        }
        let scale = 6;
        let (w, h) = ((n + 8) * scale, (grid.len() + 8) * scale);
        let mut img = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| {
            let (mx, my) = ((x / scale) as isize - 4, (y / scale) as isize - 4);
            let dark = mx >= 0 && my >= 0 && (my as usize) < grid.len() && (mx as usize) < n && grid[my as usize][mx as usize];
            if dark { 0 } else { 255 }
        });
        let grids = img.detect_grids();
        assert_eq!(grids.len(), 1, "one code found");
        grids[0].decode().expect("it decodes").1
    }

    #[test]
    fn the_qr_drawn_in_half_blocks_reads_back_as_the_exact_link() {
        for link in [
            pair_link("dev+hn@example.com", LOCAL, "ABCDEFGHJKMNPQRS", None),
            pair_link("dev+hn@example.com", LOCAL, "ABCDEFGHJKMNPQRS", Some("hs_4d1f0c6e2b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e")),
        ] {
            let modules = qr_modules(&link, 70, 28).expect("fits the panel at 150×42");
            assert!(modules.len() <= 56, "two modules a row, 28 rows");
            let mut buf = Buffer::empty(Rect::new(0, 0, 80, 30));
            let at = draw_qr(&mut buf, 1, 1, &modules, false);
            assert_eq!(decode(&buf, at), link);
        }
        assert!(qr_modules(&pair_link("dev@example.com", LOCAL, "ABCDEFGHJKMNPQRS", None), 40, 18).is_none(), "too small: none, not an unreadable one");
    }

    #[test]
    fn add_phone_shows_the_qr_for_the_link_and_arms_only_after_a_yes() {
        let mut app = app((150, 42));
        let log = fake(&mut app);
        crate::input::run(&mut app, "add-phone");
        let pair = |log: &Arc<Mutex<Vec<Req>>>| log.lock().unwrap().iter().filter(|r| matches!(r, Req::Http { path, .. } if path == "/api/pair")).count();
        assert_eq!(pair(&log), 0, "not armed before the yes");
        let link = phone_link(&app).expect("a link");
        assert!(link.starts_with("https://harness.autonomous.ai/pair#e=dev%2Bhn%40example.com&m=") && link.contains("&h=hs_"), "{link}");
        let (s, buf) = screen(&mut app, 150, 42);
        let at = app.devices.phone.drawn.get().expect("the QR is drawn");
        assert_eq!(decode(&buf, at), link, "the screen's code is the link");
        let grouped: Vec<String> = app.devices.phone.code.as_bytes().chunks(4).map(|g| String::from_utf8_lossy(g).to_string()).collect();
        assert!(s.contains(&grouped.join(" ")), "the code in text:\n{s}");
        assert!(s.contains("Dee's iPhone") && !s.contains("Cabled gadget"), "the phones and computers paired, nothing else:\n{s}");
        press(&mut app, KeyCode::Char('y'));
        assert_eq!(pair(&log), 1, "armed: the code handed over");
        assert!(has(&log, &http("POST", "/api/pair", Some(json!({ "code": app.devices.phone.code })))));
        assert!(app.devices.phone.message.is_none(), "no phone yet is not an error");
    }

    #[test]
    fn each_view_draws_at_80x24_and_150x42() {
        for (w, h) in [(80u16, 24u16), (150, 42)] {
            for view in View::ALL {
                let mut app = app((w, h));
                let _log = fake(&mut app);
                crate::input::run(&mut app, view.id());
                let (s, _) = screen(&mut app, w, h);
                assert!(s.contains(view.title()), "{} at {w}x{h}:\n{s}", view.id());
                match view {
                    View::Machines => assert!(s.contains("This computer") && s.contains("Your machines") && s.contains("enter choose"), "{s}"),
                    View::Connect => assert!(s.contains("gpu-box") && s.contains("Not linked yet") && s.contains("enter choose"), "{s}"),
                    View::Phone if w == 80 => assert!(s.contains("to show the QR code") && app.devices.phone.drawn.get().is_none(), "too small says so:\n{s}"),
                    View::Phone => assert!(app.devices.phone.drawn.get().is_some(), "{s}"),
                }
                if view == View::Phone { assert!(s.contains("y/n"), "asks before handing over the code:\n{s}") }
            }
        }
    }

    #[test]
    fn opened_from_commands_esc_goes_back_there() {
        let mut app = app((150, 42));
        let _log = fake(&mut app);
        crate::input::run(&mut app, "commands");
        go_to(&mut app, "cmd:devices");
        press(&mut app, KeyCode::Enter);
        assert!(matches!(&app.modal, Some(Modal::Picker { kind: PickerKind::Devices(View::Machines), .. })));
        press(&mut app, KeyCode::Esc);
        let Some(Modal::Picker { kind, picker }) = &app.modal else { panic!("closed") };
        assert!(matches!(kind, PickerKind::Commands));
        assert_eq!(picker.current_id().as_deref(), Some("cmd:devices"));
    }

    #[test]
    fn nothing_real_runs_under_test() {
        let mut app = app((150, 42));
        crate::input::run(&mut app, "devices");
        assert!(matches!(app.devices.password, Some(Err(_))), "the CLI is not there in tests");
    }
}
