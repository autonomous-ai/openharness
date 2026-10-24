//! Machines & devices in the panel — the desktop app's machine and device screens, drawn the TUI
//! way and reached from the Commands panel (its Machines group):
//!
//! - **Connect a machine…** — a machine on the account that is not linked yet, its remote password
//!   (hidden), then `harness link connect <id> --stdin --json` with the stages it reports, live.
//! - **Machines & devices…** — this computer's remote password and sharing, the account's machines
//!   (rename, remove), the machines other accounts share with it (add, remove from the list), the
//!   links made from here (unlink), and the steps that add another machine.
//! - **Add phone…** — the QR code the app shows (the very same link), in half blocks.
//!
//! Everything that writes asks y/n first, in a dialog over the panel (`dialog::Dialog`, the one
//! every question uses); a typed line is asked there too, never in the search line. The CLI and
//! the daemon's REST go through one [Req] → [Reply] runner, which tests replace with fake answers:
//! nothing here reaches a real daemon or CLI from a test.

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
use crate::buttons::{self, Answer, Button};
use crate::dialog::{self, Dialog, Input, INPUT_W};
use crate::fleet::{Reach, State};
use crate::modal::{Modal, PickerKind};
use crate::picker::{Picker, Row};
use crate::settings::{self, Chrome};
use crate::theme::{self, fg};

// ── what the app shows (desktop wording, kept word for word) ──────────────────

/// What sharing this computer gives (machine_sharing_form.dart's intro).
/// What a guest gets (docs/plans/2026-10-19-guest-machine-sharing-plan.md): Guest is the only level.
const SHARE_ACCESS: &str = "People you invite get their own private space here and use your Claude and ChatGPT plans. They can't see your files or harnesses.";

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
            View::Machines => "Search machines",
        }
    }
}

// ── the state ────────────────────────────────────────────────────────────────

/// A machine this computer has linked (`harness link list`).
#[derive(Clone, Debug, PartialEq)]
pub struct Linked { pub machine: String, pub fingerprint: String, pub at: String }

/// Where Esc goes back to: a view, the level it was at, and the row.
#[derive(Clone, Debug, PartialEq)]
pub struct Back { pub view: View, pub sub: Option<String>, pub row: Option<String> }

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
    /// An address to share this computer with (services/sharedMachines.ts).
    ShareEmail,
    /// A folder of this computer's for guests to open in their harnesses; [write]: they may change it.
    ShareFolder { write: bool },
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
    /// This computer shared with these addresses and, or, everyone at its owner's domain; [said] is
    /// what the footer says once it is.
    Share { emails: Vec<String>, same_domain: bool, said: String },
    /// A machine shared with this account's domain added to its machines (an older backend lists one to add).
    AddShared { machine: String, name: String },
    /// The folders guests may open here, each read only or editable (`set_folders`); [said] as for Share.
    ShareFolders { folders: Vec<(String, bool)>, said: String },
}

/// The panel is asking, in a dialog over it: a line to type (a password shown as dots; the caret
/// [caret] characters in), or a y/n before a write.
#[derive(Clone, Debug)]
pub enum Ask {
    Entry { what: Entry, label: String, value: String, caret: usize, secret: bool },
    Confirm { question: String, act: Act },
}

/// Where the dialog drew its buttons and its input, for clicks on this screen size.
#[derive(Clone, Copy)]
struct PromptActions { size: (u16, u16), accept: Rect, cancel: Rect, input: Option<Rect> }

pub struct Devices {
    /// `remote-password status --json` ({hasPassword, fingerprint, setAt}), or why it is unknown.
    pub password: Option<Result<Value, String>>,
    /// This computer's sharing (`shared_machines get`: {emails, sameDomain, domain, members}), or why
    /// it is unknown.
    pub sharing: Option<Result<Value, String>>,
    pub links: Option<Result<Vec<Linked>, String>>,
    /// `GET /api/machines`'s rows, by machine id (what the fleet does not keep: when it was seen).
    pub account: HashMap<String, Value>,
    pub link: Option<Linking>,
    pub phone: Phone,
    pub ask: Option<Ask>,
    prompt_actions: std::cell::Cell<Option<PromptActions>>,
    /// Where the title is drawn while a level is open (and the size it was drawn at): a click on
    /// it goes back, as Esc does — the mouse's way out of a level.
    back_at: std::cell::Cell<Option<((u16, u16), Rect)>>,
    /// The chosen button of the prompt's row (0 Cancel, 1 the action), and whether the keys are on
    /// the buttons: a confirmation's always are, a typed line's only after Tab.
    prompt_row: std::cell::Cell<usize>,
    prompt_focus: std::cell::Cell<bool>,
    /// Set by a draw that had no room for the question: [cancel_unfit] ends it after the frame.
    unfit: std::cell::Cell<bool>,
    /// A level inside a view: a machine's actions (`m:<id>`).
    pub sub: Option<String>,
    /// The view another one was opened from in this panel (Add a machine → Connect a computer):
    /// Esc goes back to it, its level and its row.
    pub back: Option<Back>,
    /// The footer's line: what happened, or (true) what went wrong — until the next thing does.
    pub footer: Option<(String, bool, Instant)>,
    pub loading: Vec<&'static str>,
    /// None: the real CLI and daemon. Tests put fake answers here.
    pub runner: Option<Runner>,
}

impl Default for Devices {
    fn default() -> Devices {
        Devices {
            password: None, sharing: None, links: None, account: HashMap::new(), link: None, phone: Phone::default(), ask: None, prompt_actions: Default::default(), back_at: Default::default(), prompt_row: Default::default(), prompt_focus: Default::default(), unfit: Default::default(), sub: None, back: None, footer: None, loading: Vec::new(), runner: default_runner(),
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
    /// A request to this computer's daemon over its socket, answered `<ty>_result`.
    Rpc { ty: &'static str, payload: Value },
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
    /// The reply, or (code, message): an `error` in it is a refusal.
    Rpc(Result<Value, (String, String)>),
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
        Req::Rpc { ty, payload } => {
            let here = app.fleet.local_id.clone();
            let Some(link) = app.link(&here) else { return then(app, Reply::Rpc(Err(("DAEMON_DOWN".into(), "Harness is not running on this computer.".into())))) };
            // Turning guest access on waits on the person at this computer's admin prompt, which gives up after ten minutes.
            let wait = Duration::from_secs(if payload.get("action").and_then(Value::as_str) == Some("enable_guests") { 660 } else { 30 });
            app.spawn(async move { Reply::Rpc(link.rpc(ty, payload, wait).await.map_err(|e| (e.code, e.detail))) }, then)
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
    d.back = None;
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
        View::Machines => { load_password(app); load_sharing(app); load_links(app); load_account(app); load_me(app) }
        View::Phone => {
            load_me(app);
            let generation = app.devices.phone.generation;
            sign_in(app, generation);
            load_pairs(app);
            // Opening Add your phone is the ask: the code is handed to the daemon at once, as long as
            // the QR is on screen, unless there is no Harness here to hand it to.
            if !app.daemon_down { run_act(app, Act::ArmPhone) }
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

/// The answer to a `shared_machines` request: what it said, or why it said nothing.
fn shared_answer(reply: Reply) -> Result<Value, String> {
    match reply {
        Reply::Rpc(Ok(v)) => match v.get("error").and_then(Value::as_str) {
            None => Ok(v),
            Some("UNSUPPORTED") => Err("Update Harness on this computer to share it.".into()),
            Some(code) => Err(v.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("Could not share it ({code}).")))
        },
        Reply::Rpc(Err((_, message))) => Err(message),
        _ => Err("Sharing is unavailable.".into()),
    }
}

fn load_sharing(app: &mut App) {
    loading(app, "sharing", true);
    ask(app, Req::Rpc { ty: "shared_machines", payload: json!({ "action": "get" }) }, None, |app, reply| {
        loading(app, "sharing", false);
        app.devices.sharing = Some(shared_answer(reply));
        again(app);
    });
}

/// This computer's sharing as last read: (addresses, everyone at the domain, the domain), or nothing
/// while it is unknown.
fn sharing_now(app: &App) -> Option<(Vec<String>, bool, Option<String>)> {
    let v = app.devices.sharing.as_ref()?.as_ref().ok()?;
    let emails = v.get("emails").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    Some((emails, v.get("sameDomain") == Some(&Value::Bool(true)), v.get("domain").and_then(Value::as_str).map(str::to_string)))
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
        Act::Share { emails, same_domain, said } => {
            // The first share turns guest access on: each guest runs as their own account here, which takes one
            // admin prompt on this computer. A CLI from before guests says nothing of it, and is not asked.
            let access = app.devices.sharing.as_ref().and_then(|s| s.as_ref().ok()).and_then(|v| v.get("guestAccess")).and_then(Value::as_str).map(str::to_string);
            if (!emails.is_empty() || same_domain) && access.as_deref().is_some_and(|a| a != "ready") {
                note(app, "Enter your password on this computer to finish setting up.");
                ask(app, Req::Rpc { ty: "shared_machines", payload: json!({ "action": "enable_guests" }) }, None, move |app, reply| {
                    match shared_answer(reply) {
                        Ok(v) => {
                            if let Some(Ok(sharing)) = app.devices.sharing.as_mut() { sharing["guestAccess"] = v.get("guestAccess").cloned().unwrap_or(json!("ready")) }
                            run_act(app, Act::Share { emails, same_domain, said })
                        }
                        Err(message) => { fail(app, message); again(app) }
                    }
                });
                return;
            }
            note(app, "Saving…");
            let payload = json!({ "action": "set", "emails": emails, "sameDomain": same_domain });
            ask(app, Req::Rpc { ty: "shared_machines", payload }, None, move |app, reply| {
                match shared_answer(reply) {
                    Ok(v) => { app.devices.sharing = Some(Ok(v)); note(app, said) }
                    Err(message) => fail(app, message),
                }
                again(app);
            });
        }
        Act::ShareFolders { folders, said } => {
            note(app, "Saving…");
            let folders: Vec<Value> = folders.into_iter().map(|(path, write)| json!({ "path": path, "write": write })).collect();
            ask(app, Req::Rpc { ty: "shared_machines", payload: json!({ "action": "set_folders", "folders": folders }) }, None, move |app, reply| {
                match shared_answer(reply) {
                    Ok(v) => { app.devices.sharing = Some(Ok(v)); note(app, said) }
                    Err(message) => fail(app, message),
                }
                again(app);
            });
        }
        // Only an older backend lists a team's machine to add first; a machine shared with you, by email
        // or with your domain, is never taken off your list (owner, 2026-10-16).
        Act::AddShared { machine, name } => {
            note(app, "Adding…");
            let payload = json!({ "action": "add", "machineId": machine });
            ask(app, Req::Rpc { ty: "shared_machines", payload }, None, move |app, reply| {
                match shared_answer(reply) {
                    Ok(_) => {
                        app.fleet.to_add.retain(|(id, ..)| id != &machine);
                        note(app, format!("Added {name}. It connects in a moment."));
                        if app.devices.runner.is_none() { app.refresh_machines() }
                    }
                    Err(message) => fail(app, message),
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
    let measured = crate::measure::begin(app, "computer_link");
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
        measured.finish(app, if result.is_ok() { crate::measure::Outcome::Ok } else { crate::measure::Outcome::Failed });
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
    app.devices.prompt_row.set(1);
    app.devices.prompt_focus.set(false);
    app.devices.ask = Some(Ask::Entry { what, label: label.into(), value: value.to_string(), caret: value.chars().count(), secret });
}

/// The byte where the [caret]th character of [value] starts.
fn at_char(value: &str, caret: usize) -> usize { value.char_indices().nth(caret).map_or(value.len(), |(i, _)| i) }

fn confirm(app: &mut App, question: impl Into<String>, act: Act) {
    app.devices.prompt_actions.set(None);
    // A destructive yes starts on Cancel, a safe one on Yes.
    let risky = matches!(act, Act::ClearPassword | Act::Unlink { .. } | Act::Remove { .. } | Act::Unpair { .. });
    app.devices.prompt_row.set(usize::from(!risky));
    app.devices.prompt_focus.set(true);
    app.devices.ask = Some(Ask::Confirm { question: question.into(), act });
}

/// Passwords and names belong to the active prompt, never to the search beneath it.
/// A paste cannot answer a confirmation, even if it contains "y" or a newline.
pub fn paste(app: &mut App, text: &str) -> bool {
    if view_of(app).is_none() || app.devices.ask.is_none() { return false }
    if let Some(Ask::Entry { value, caret, .. }) = &mut app.devices.ask {
        let pasted: String = text.chars().filter(|c| !c.is_control()).collect();
        value.insert_str(at_char(value, *caret), &pasted);
        *caret += pasted.chars().count();
    }
    true
}

/// While a prompt is open, clicks on the underlying list cannot become Enter.
/// Only the actions drawn for this prompt can advance it; a click on its input gives the input
/// the keys; a click outside the panel cancels.
pub fn mouse(app: &mut App, mouse: MouseEvent) -> bool {
    let Some(view) = view_of(app) else { return false };
    if app.devices.ask.is_none() {
        let back = app.devices.back_at.get().filter(|(size, _)| *size == app.size && (app.devices.sub.is_some() || app.devices.back.is_some()));
        let click = mouse.kind == MouseEventKind::Down(MouseButton::Left) && mouse.modifiers.is_empty();
        if !(click && back.is_some_and(|(_, r)| r.contains(Position::new(mouse.column, mouse.row)))) { return false }
        step_back(app, view);
        return true;
    }
    if mouse.kind != MouseEventKind::Down(MouseButton::Left) || !mouse.modifiers.is_empty() { return true }
    let at = Position::new(mouse.column, mouse.row);
    let action = app.devices.prompt_actions.get().filter(|a| a.size == app.size);
    if action.and_then(|a| a.input).is_some_and(|r| r.contains(at)) {
        app.devices.prompt_focus.set(false);
        return true;
    }
    let key = if action.is_some_and(|a| a.accept.contains(at)) {
        app.devices.prompt_focus.set(false);   // a click on Continue is Enter on the line, not on a chosen Cancel
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
        Entry::ShareEmail => {
            let typed: Vec<String> = value.split(|c: char| c == ',' || c == ';' || c.is_whitespace()).map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect();
            if typed.is_empty() { return note(app, "Nothing changed") }
            if let Some(bad) = typed.iter().find(|e| !is_email(e)) { entry(app, Entry::ShareEmail, "Email address", &value, false); return fail(app, format!("Not an email address: {bad}")) }
            let Some((mut emails, same_domain, _)) = sharing_now(app) else { return fail(app, "Sharing is unavailable. Try again.") };
            let new: Vec<String> = typed.into_iter().filter(|e| !emails.contains(e)).collect();
            if new.is_empty() { return note(app, "Already shared with them") }
            emails.extend(new.iter().cloned());
            let here = app.fleet.local_machine_name();
            confirm(app, format!("Share {here} with {}? They get their own private space and use your Claude and ChatGPT plans.", new.join(", ")),
                Act::Share { emails, same_domain, said: format!("Shared with {}", new.join(", ")) });
        }
        Entry::ShareFolder { write } => {
            let typed = value.trim();
            let path = if typed.len() > 1 { typed.trim_end_matches('/') } else { typed }.to_string();
            if path.is_empty() { return note(app, "Nothing changed") }
            let label = if write { "Share a folder they can edit" } else { "Share a folder they can view" };
            if !path.starts_with('/') { entry(app, Entry::ShareFolder { write }, label, &value, false); return fail(app, "Enter the folder's full path, like /Users/you/project") }
            let mut folders = sharing_folders(app);
            if folders.iter().any(|(p, _)| *p == path) { return note(app, format!("{path} is already shared")) }
            folders.push((path.clone(), write));
            let what = if write { "view and edit" } else { "view" };
            confirm(app, format!("Share {path} so people can {what} it? They see everything inside, even passwords and keys."),
                Act::ShareFolders { folders, said: format!("Shared {path}") });
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
        Some(Ask::Confirm { question, act }) => {
            let mut row = prompt_row(app, true, "Yes");
            let answer = match key.code {
                KeyCode::Char('Y') if !ctrl => Answer::Chosen(1),
                KeyCode::Char('N') if !ctrl => Answer::Chosen(0),
                code => row.key(code, key.modifiers),
            };
            match answer {
                Answer::Chosen(1) => run_act(app, act),
                Answer::Chosen(_) | Answer::Cancel => note(app, "Nothing changed"),
                Answer::Moved => {
                    app.devices.prompt_row.set(row.chosen);
                    app.devices.ask = Some(Ask::Confirm { question, act });
                }
                Answer::Ignored => app.devices.ask = Some(Ask::Confirm { question, act }),
            }
        }
        Some(Ask::Entry { what, label, mut value, mut caret, secret }) => {
            // (↓ from the input to the buttons, ↑ back up, as Tab goes either way.)
            let on_buttons = app.devices.prompt_focus.get();
            let across = match key.code { KeyCode::Tab | KeyCode::BackTab => true, KeyCode::Down => !on_buttons, KeyCode::Up => on_buttons, _ => false };
            if across {
                app.devices.prompt_focus.set(!on_buttons);
                app.devices.ask = Some(Ask::Entry { what, label, value, caret, secret });
                return;
            }
            // A printable key is typed, wherever the keys were: the input has them again.
            if matches!(key.code, KeyCode::Char(_)) && !ctrl && !key.modifiers.contains(KeyModifiers::ALT) { app.devices.prompt_focus.set(false) }
            if app.devices.prompt_focus.get() {
                let mut row = prompt_row(app, false, "Continue");
                match row.key(key.code, key.modifiers) {
                    Answer::Chosen(1) => { app.devices.footer = None; return submit(app, what, value) }
                    Answer::Chosen(_) | Answer::Cancel => return note(app, "Nothing changed"),
                    Answer::Moved => app.devices.prompt_row.set(row.chosen),
                    Answer::Ignored => {}
                }
                app.devices.ask = Some(Ask::Entry { what, label, value, caret, secret });
                return;
            }
            // The input has the keys: they edit at the caret, which ← → Home End move.
            let len = value.chars().count();
            caret = caret.min(len);
            match key.code {
                KeyCode::Enter => { app.devices.footer = None; return submit(app, what, value) }
                KeyCode::Esc => return note(app, "Nothing changed"),
                KeyCode::Char('c' | 'g') if ctrl => return note(app, "Nothing changed"),
                KeyCode::Char('u') if ctrl => { value.clear(); caret = 0 }
                KeyCode::Char('h') if ctrl && caret > 0 => { caret -= 1; value.remove(at_char(&value, caret)); }
                KeyCode::Backspace if caret > 0 => { caret -= 1; value.remove(at_char(&value, caret)); }
                KeyCode::Delete if caret < len => { value.remove(at_char(&value, caret)); }
                KeyCode::Left => caret = caret.saturating_sub(1),
                KeyCode::Right => caret = (caret + 1).min(len),
                KeyCode::Home => caret = 0,
                KeyCode::End => caret = len,
                KeyCode::Char(c) if !ctrl && !key.modifiers.contains(KeyModifiers::ALT) => { value.insert(at_char(&value, caret), c); caret += 1 }
                _ => {}
            }
            app.devices.ask = Some(Ask::Entry { what, label, value, caret, secret });
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
    if go_back(app) { return }
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
        (_, "share") => sub(app, "share:".into()),
        (_, "shr") => share_action(app, &rest),
        (_, "addshared") => {
            let name = app.fleet.to_add.iter().find(|(id, ..)| *id == rest).map(|(_, name, _)| name.clone()).unwrap_or_else(|| name_of(app, &rest));
            run_act(app, Act::AddShared { machine: rest, name })
        }
        (_, "act") => machine_action(app, &rest),
        (_, "pw") => match rest.as_str() {
            "set" => entry(app, Entry::NewPassword, "New remote password", "", true),
            "clear" => confirm(app, "Prevent new links using this password? Existing links and sessions stay connected.", Act::ClearPassword),
            // The row itself: a first password at once; Change and Clear once there is one.
            _ => match password_set(app) {
                Some(true) => sub(app, "pw:".into()),
                Some(false) => entry(app, Entry::NewPassword, "New remote password", "", true),
                None => load_password(app),
            },
        },
        (_, "add") => switch(app, View::Connect),
        (_, "ph") => match rest.as_str() {
            "arm" => run_act(app, Act::ArmPhone),
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

/// Over to another view in the same panel: Esc comes back to this one, at the row it was on. Asked
/// for the view it came from (Connect's Set up another computer, after Add a machine), it goes back
/// there rather than opening a third.
fn switch(app: &mut App, view: View) {
    if app.devices.back.as_ref().is_some_and(|b| b.view == view) { go_back(app); return }
    let from = view_of(app).map(|v| Back { view: v, sub: app.devices.sub.clone(), row: picker_mut(app).and_then(|p| p.current_id()) });
    show(app, view);
    app.devices.back = from;
}

/// Back to the view this one was opened from, if it was: false when there is none.
fn go_back(app: &mut App) -> bool {
    let Some(back) = app.devices.back.take() else { return false };
    show(app, back.view);
    app.devices.sub = back.sub;
    again(app);
    if let (Some(p), Some(row)) = (picker_mut(app), back.row) { p.select(&row) }
    true
}

/// [view] in this panel, from its first row.
fn show(app: &mut App, view: View) {
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


fn machine_action(app: &mut App, rest: &str) {
    let Some((verb, machine)) = rest.split_once(':') else { return };
    let (machine, name) = (machine.to_string(), name_of(app, machine));
    match verb {
        "rename" => entry(app, Entry::Rename { machine, name: name.clone() }, "Machine name", &name, false),
        "remove" => confirm(app, format!("Delete {name} from your account?"), Act::Remove { machine, name }),
        "unlink" => confirm(app, format!("Remove this computer’s saved link to {name}? A new connection will need that machine’s password."), Act::Unlink { machine, name }),
        "connect" => { switch(app, View::Connect); if let Some(p) = picker_mut(app) { p.select(&format!("m:{machine}")) } start_link(app, machine, name) }
        "open" => {
            app.devices.sub = None;
            open_machine_list(app, &machine);
        }
        _ => {}
    }
}

/// Enter on a row of this computer's sharing.
fn share_action(app: &mut App, rest: &str) {
    if rest == "reload" { return load_sharing(app) }
    let Some((emails, same_domain, domain)) = sharing_now(app) else { return fail(app, "Sharing is unavailable. Try again.") };
    let here = app.fleet.local_machine_name();
    match rest.split_once(':').unwrap_or((rest, "")) {
        ("add", _) => entry(app, Entry::ShareEmail, "Email address", "", false),
        ("domain", _) => {
            let Some(domain) = domain else { return };
            if same_domain {
                run_act(app, Act::Share { emails, same_domain: false, said: format!("No longer shared with everyone at @{domain}") })
            } else {
                confirm(app, format!("Share {here} with everyone at @{domain}? They get their own private space and use your Claude and ChatGPT plans."),
                    Act::Share { emails, same_domain: true, said: format!("Shared with everyone at @{domain}") })
            }
        }
        ("rm", email) => {
            let rest: Vec<String> = emails.into_iter().filter(|e| e != email).collect();
            confirm(app, format!("Stop sharing {here} with {email}?"), Act::Share { emails: rest, same_domain, said: format!("No longer shared with {email}") })
        }
        ("guests-on", _) => {
            note(app, "Enter your password on this computer to finish setting up.");
            ask(app, Req::Rpc { ty: "shared_machines", payload: json!({ "action": "enable_guests" }) }, None, move |app, reply| {
                match shared_answer(reply) {
                    Ok(v) => {
                        if let Some(Ok(sharing)) = app.devices.sharing.as_mut() { sharing["guestAccess"] = v.get("guestAccess").cloned().unwrap_or(json!("ready")) }
                        note(app, "Sharing is on")
                    }
                    Err(message) => fail(app, message),
                }
                again(app);
            });
        }
        ("folder-read", _) => entry(app, Entry::ShareFolder { write: false }, "Share a folder they can view", "", false),
        ("folder-write", _) => entry(app, Entry::ShareFolder { write: true }, "Share a folder they can edit", "", false),
        ("folder", path) => {
            let rest: Vec<(String, bool)> = sharing_folders(app).into_iter().filter(|(p, _)| p != path).collect();
            confirm(app, format!("Stop sharing {path}?"), Act::ShareFolders { folders: rest, said: format!("Stopped sharing {path}") })
        }
        _ => {}
    }
}

/// Whether guests may start harnesses here (`ready`), or what turning it on takes; None from a CLI before guests.
fn guest_access(app: &App) -> Option<String> {
    app.devices.sharing.as_ref().and_then(|s| s.as_ref().ok()).and_then(|v| v.get("guestAccess")).and_then(Value::as_str).map(str::to_string)
}

/// The folders guests may open here, as this computer last said: (path, whether they may change it).
fn sharing_folders(app: &App) -> Vec<(String, bool)> {
    app.devices.sharing.as_ref().and_then(|s| s.as_ref().ok()).and_then(|v| v.get("folders")).and_then(Value::as_array).into_iter().flatten()
        .filter_map(|f| Some((f.get("path")?.as_str()?.to_string(), f.get("write") == Some(&Value::Bool(true))))).collect()
}

/// Whether [text] is an address the backend takes (zod's `email()`, by hand: this regex has no
/// lookahead): one it would refuse is refused as it is typed, by name, never as a failed save.
fn is_email(text: &str) -> bool {
    let Some((name, domain)) = text.split_once('@') else { return false };
    let local_ok = !name.is_empty() && !name.starts_with('.') && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "_'+-.".contains(c))
        && name.chars().last().is_some_and(|c| c.is_ascii_alphanumeric() || "_+-".contains(c));
    let labels: Vec<&str> = domain.split('.').collect();
    let (tld, rest) = labels.split_last().unwrap_or((&"", &[]));
    let domain_ok = !rest.is_empty()
        && rest.iter().all(|l| l.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        && tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic());
    local_ok && domain_ok && text.len() <= 254
}

/// Machines & devices on [machine]: its own actions (rename, connect, remove…).
pub(crate) fn open_machine(app: &mut App, machine: &str) {
    open(app, View::Machines);
    sub(app, format!("m:{machine}"));
}

/// [machine]'s harnesses: the Open list on it ("Open its harnesses").
pub(crate) fn open_machine_list(app: &mut App, machine: &str) {
    let kind = PickerKind::Open { filter: crate::modal::Filter::All, machine: Some(machine.to_string()), project: None };
    let (title, placeholder) = crate::modal::launcher_title(app, &kind);
    let mut next = Picker::new(title, placeholder);
    next.prefixed = true;
    crate::input::fill(app, &kind, &mut next);
    app.modal = Some(Modal::Picker { kind, picker: next });
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
        _ if m.local => ("✓", theme::ONLINE, "connected".into()),
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
        View::Machines => match app.devices.sub.as_deref() {
            Some("share:") => share_rows(app),
            Some("pw:") => password_rows(app),
            Some(sub) => match sub.strip_prefix("m:") { Some(id) => action_rows(app, id), None => machines_rows(app) },
            None => machines_rows(app),
        },
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
            done.push(Row::new(format!("m:{}", m.id), m.name.clone()).group("Linked just now").extra(m.id.clone()).lead(dot("✓", theme::ONLINE)).right("linked"));
        } else if linking || (m.reach == Reach::NeedsLink && m.online()) {
            // (Its group says what it is; the preview, what Enter does.)
            ready.push(Row::new(format!("m:{}", m.id), m.name.clone()).group("Not linked yet").extra(format!("{} {word}", m.id)).lead(dot(glyph, color)).right(if linking { "connecting…" } else { "" }));
        } else if !m.online() {
            let mut r = Row::new(format!("m:{}", m.id), m.name.clone()).group("Offline").extra(m.id.clone()).lead(dot(glyph, color)).right("offline");
            r.disabled = true;
            away.push(r);
        }
    }
    if ready.is_empty() { ready.push(info("none", if app.daemon_down { "Harness is not running on this computer" } else { "No computers ready to connect" }, "Not linked yet")) }
    // (An offline row is never chosen, so it has no preview: the way to bring one back is said once, under them.)
    if !away.is_empty() { away.push(info("offline-how", "Open Harness there to bring it online.", "Offline")) }
    ready.extend(done);
    ready.extend(away);
    ready.push(setup());
    ready
}

fn account_row(app: &App) -> Row {
    // Who is signed in, by name; what the account is for is in the preview.
    let label = match account_email(app) { Some(e) if app.account.status != crate::account::Status::SignedOut => e, _ => crate::account::label(app).to_string() };
    Row::new("account", label).group("Account").extra("account sign in")
}

fn machines_rows(app: &App) -> Vec<Row> {
    let mut rows = vec![account_row(app)];
    // This computer's section, under its name ("This computer" only until it has one).
    let here = app.fleet.local_machine_name();
    let here = here.as_str();
    let password = app.devices.password.as_ref();
    let set = password_set(app);
    let state = match password {
        _ if is_loading(app, "password") && password.is_none() => "reading…".to_string(),
        None => "…".into(),
        Some(Err(_)) => "unavailable".into(),
        Some(Ok(v)) => if set == Some(true) { v.get("setAt").and_then(Value::as_u64).map(|t| format!("set {}", crate::fleet::ago(t))).map(|s| if s == "set " { "set".into() } else { s }).unwrap_or_else(|| "set".into()) } else { "not set".into() },
    };
    let color = match set { Some(true) => theme::ONLINE, Some(false) => theme::MUTED, None => theme::WARN };
    // One row: Enter sets a first password, opens Change and Clear once there is one, or reads it again.
    rows.push(Row::new("pw:", "Remote password").group(here).extra("remote password set change clear").lead(dot(if set == Some(true) { "✓" } else { "·" }, color)).right(state));
    // Sharing this computer with other accounts: off until its owner shares it.
    if !app.devices.phone.signed_out && app.account.status != crate::account::Status::SignedOut {
        let state = match (&app.devices.sharing, sharing_now(app)) {
            (_, Some((emails, same_domain, domain))) => {
                let mut said = Vec::new();
                if !emails.is_empty() { said.push(if emails.len() == 1 { "1 person".to_string() } else { format!("{} people", emails.len()) }) }
                if same_domain { if let Some(d) = domain { said.push(format!("@{d}")) } }
                if said.is_empty() { "off".to_string() } else { said.join(" · ") }
            }
            (Some(Err(_)), _) => "unavailable".into(),
            _ if is_loading(app, "sharing") => "reading…".into(),
            _ => "…".into(),
        };
        rows.push(Row::new("share:", "Share this computer").group(here).extra("share sharing people team domain").lead(dot("⇆", theme::TEAL)).right(state));
    }

    // A row is its name and one word or count at the right; the rest is in the preview.
    let yours = "Your machines";
    for m in app.fleet.machines.iter().filter(|m| !m.shared && !app.fleet.shares.contains_key(&m.id)) {
        if crate::local::is_local(&m.id) { continue }
        let (_, _, word) = reach(app, m);
        rows.push(machine_row(app, m, yours).extra(format!("{} {word}", m.id)));
    }
    if app.fleet.machines.iter().all(|m| crate::local::is_local(&m.id)) { rows.push(info("m-none", if app.daemon_down { "Harness is not running on this computer" } else { "Loading machines…" }, yours)) }

    // Another computer, last of yours: its steps are in the preview; Enter lists the ones ready to link.
    rows.push(Row::new("add:", "Add a machine").group(yours).extra("connect link new computer password").lead(dot("+", theme::TEAL)));

    // Other accounts' machines shared with this one: used as its own.
    let with_you = "Shared with you";
    for m in app.fleet.machines.iter() {
        let Some(share) = app.fleet.shares.get(&m.id) else { continue };
        let (_, _, word) = reach(app, m);
        rows.push(machine_row(app, m, with_you).extra(format!("{} {} {} {word}", m.id, share.owner, share.email)));
    }
    // Shared with this account's domain: Enter adds one.
    let team = "Shared with your team";
    for (id, name, share) in &app.fleet.to_add {
        rows.push(Row::new(format!("addshared:{id}"), format!("Add {name}")).group(team).extra(format!("{id} {} {}", share.owner, share.email)).lead(dot("+", theme::TEAL)));
    }
    rows
}

/// A machine's row: its mark and name, and at the right its state — in a narrow list only why it
/// can't be used (its ✓ says the rest; its harnesses are in the preview).
fn machine_row(app: &App, m: &crate::fleet::Machine, group: &str) -> Row {
    let (glyph, color, _) = reach(app, m);
    let state = machine_state(app, m);
    let narrow = if m.usable() { String::new() } else { state.clone() };
    Row::new(format!("m:{}", m.id), m.name.clone()).group(group).lead(dot(glyph, color)).right(state).right_narrow(narrow)
}

/// A machine's right column: how many harnesses it has, or why it can't be used.
fn machine_state(app: &App, m: &crate::fleet::Machine) -> String {
    if !m.usable() {
        let (_, _, word) = reach(app, m);
        return match word.as_str() { "online · not linked" => "not linked".into(), w @ ("offline" | "online" | "connecting…") => w.into(), _ => "error".into() };
    }
    let n = app.fleet.agents.values().filter(|a| a.machine_id == m.id && a.engine != "terminal").count();
    match n { 0 => "no harnesses".into(), 1 => "1 harness".into(), n => format!("{n} harnesses") }
}

fn action_rows(app: &App, id: &str) -> Vec<Row> {
    let Some(m) = app.fleet.machine(id) else { return vec![info("gone", "That machine is gone", "")] };
    let group = m.name.clone();
    let mut rows = Vec::new();
    let act = |verb: &str, label: &str, glyph: &str| Row::new(format!("act:{verb}:{id}"), label).group(group.clone()).lead(dot(glyph, theme::TEAL));
    if m.usable() { rows.push(act("open", "Open its harnesses", "→")) }
    // (A machine shared with this account links by its key once both daemons read the sharing: no password.)
    if m.reach == Reach::NeedsLink && m.online() && !app.fleet.shares.contains_key(id) { rows.push(act("connect", "Connect…", "⇄")) }
    if link_of(app, id).is_some() { rows.push(act("unlink", "Unlink…", "⇄")) }
    match app.fleet.shares.get(id) {
        // Another account's: its owner renames, removes and shares it.
        Some(share) => {
            rows.push(info("shared-by", format!("Shared with you by {}", owner_of(share)), &group));
        }
        None => {
            rows.push(act("rename", "Rename…", "✎"));
            if !m.local { rows.push(act("remove", "Remove from account…", "✗")) }
        }
    }
    rows
}

/// This computer's saved link to [machine], if it has one.
fn link_of<'a>(app: &'a App, machine: &str) -> Option<&'a Linked> {
    app.devices.links.as_ref()?.as_ref().ok()?.iter().find(|l| l.machine == machine)
}

/// Whether this computer has a remote password, once that is known.
fn password_set(app: &App) -> Option<bool> {
    app.devices.password.as_ref()?.as_ref().ok()?.get("hasPassword").and_then(Value::as_bool)
}

/// The remote password's level: change or clear the one there is, or set a first one.
fn password_rows(app: &App) -> Vec<Row> {
    let group = "Remote password";
    if password_set(app) != Some(true) { return vec![Row::new("pw:set", "Set password…").group(group).lead(dot("✎", theme::TEAL))] }
    vec![Row::new("pw:set", "Change password…").group(group).lead(dot("✎", theme::TEAL)), Row::new("pw:clear", "Clear password…").group(group).lead(dot("✗", theme::TEAL))]
}

/// This computer's sharing: everyone at its domain, the addresses, and who uses it now.
fn share_rows(app: &App) -> Vec<Row> {
    let here = format!("Share {}", app.fleet.local_machine_name());
    let mut rows = vec![info("share-what", "People you invite get a private space here.", &here)];
    let Some((emails, same_domain, domain)) = sharing_now(app) else {
        match &app.devices.sharing {
            Some(Err(message)) => {
                rows.push(info("share-error", message.clone(), &here));
                rows.push(Row::new("shr:reload", "Retry").group(here.clone()).lead(dot("↻", theme::MUTED)));
            }
            _ => rows.push(info("share-loading", "Reading its sharing…", &here)),
        }
        return rows;
    };
    // Shared already, but guests start nothing until guest access is on (again, after an update).
    let access = guest_access(app);
    if (!emails.is_empty() || same_domain) && access.as_deref().is_some_and(|a| a != "ready") {
        rows.push(Row::new("shr:guests-on", "Turn on sharing…").group(here.clone()).extra("sharing guest access admin").lead(dot("!", theme::WARN)).right("off"));
    }
    if let Some(domain) = &domain {
        rows.push(Row::new("shr:domain", format!("Everyone at @{domain}")).group(here.clone()).extra("domain team company").lead(dot(if same_domain { "✓" } else { "·" }, if same_domain { theme::ONLINE } else { theme::MUTED }))
            .right(if same_domain { "on" } else { "off" }));
    }
    rows.push(Row::new("shr:add", "Add an email…").group(here.clone()).extra("add email person").lead(dot("+", theme::TEAL)));
    let members = sharing_members(app);
    for email in &emails {
        let joined = members.iter().any(|(e, _)| e == email);
        rows.push(Row::new(format!("shr:rm:{email}"), email.clone()).group(here.clone()).extra("remove").lead(dot("·", theme::MUTED)).right(if joined { "joined" } else { "invited" }));
    }
    let using = using_by_email(app);
    if !using.is_empty() { rows.push(info("share-using", format!("Using it now: {}", using.join(", ")), &here)) }
    // The folders guests may open in their harnesses (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
    let folders = "Shared folders";
    rows.push(Row::new("shr:folder-read", "Share a folder they can view…").group(folders).extra("folder share read").lead(dot("+", theme::TEAL)));
    rows.push(Row::new("shr:folder-write", "Share a folder they can edit…").group(folders).extra("folder share edit write").lead(dot("+", theme::TEAL)));
    for (path, write) in sharing_folders(app) {
        rows.push(Row::new(format!("shr:folder:{path}"), path.clone()).group(folders).extra("folder remove").lead(dot("·", theme::MUTED))
            .right(if write { "can edit" } else { "read only" }));
    }
    rows
}

/// Who uses this computer through its sharing now, and how it reached them (`email` or `domain`).
fn sharing_members(app: &App) -> Vec<(String, String)> {
    app.devices.sharing.as_ref().and_then(|s| s.as_ref().ok()).and_then(|v| v.get("members")).and_then(Value::as_array).into_iter().flatten()
        .filter_map(|m| Some((m.get("email")?.as_str()?.to_string(), m.get("via").and_then(Value::as_str).unwrap_or("email").to_string()))).collect()
}

/// The people this computer is shared with by address who use it now. Everyone at the domain may use it
/// too, and is never named one by one: that is the domain row, not a list of the whole company.
fn using_by_email(app: &App) -> Vec<String> {
    sharing_members(app).into_iter().filter(|(_, via)| via == "email").map(|(email, _)| email).collect()
}

/// A share's owner as people read it: the name, and the address when it says more.
fn owner_of(share: &crate::fleet::MachineShare) -> String {
    if share.email.is_empty() || share.email == share.owner { share.owner.clone() } else { format!("{} ({})", share.owner, share.email) }
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
/// How another computer uses this one's remote password, in the rows' own names.
const LINK_HERE: &str = "On the other computer: Add a machine → choose this computer → enter this password.";

/// A preview's label column: wide enough for its longest label (`fingerprint`) and a space.
const KEY_W: usize = 12;
fn kv(k: &str, v: impl Into<String>) -> Line<'static> { Line::from(vec![dim(format!("{k:<KEY_W$}")), Span::raw(v.into())]) }
fn enter_does(text: impl Into<String>) -> Vec<Line<'static>> { vec![Line::raw(""), Line::from(vec![Span::styled("enter ", fg(theme::accent())), dim(text)])] }

/// The right side for the row under the cursor: what it is, and what Enter does.
pub fn preview(app: &App, view: View, id: &str) -> Vec<Line<'static>> {
    let (what, rest) = id.split_once(':').unwrap_or((id, ""));
    match what {
        _ if app.daemon_down && matches!(id, "none" | "m-none") => vec![Line::raw("Harness is not running on this computer."), Line::raw(""), dim("Start it with `harness start`, then come back.").into()],
        "none" => { let mut out = vec![Line::raw("No computers are ready to connect."), Line::raw("")]; out.extend(add_steps(app)); out }
        "here" if rest == "login" => vec![Line::raw("Sign in to see your other computers."), Line::raw(""),
            dim("Use the same Harness account on both. Your local agents work without signing in.").into(),
            Line::raw(""), dim("After signing in, open Connect a computer again.").into(),
            Line::raw(""), dim("Enter opens the normal Harness sign-in flow in a local terminal.").into()],
        "here" => {
            let mut out = vec![bold("Set up another computer").into(), Line::raw("")];
            out.extend(add_steps(app));
            out.extend(enter_does("opens Machines & devices"));
            out
        }
        // (Signed in as the row says: by the account's status, or by the daemon's email while that loads.)
        "account" => match (&app.account.status, account_email(app)) {
            (crate::account::Status::SignedIn { .. }, email) | (crate::account::Status::Unknown, email @ Some(_)) => {
                let mut out = vec![Line::raw(email.map_or("Signed in.".into(), |e| format!("Signed in as {e}."))), Line::raw(""),
                    dim("Your computers, workspace and phone use this account.").into()];
                out.extend(enter_does("opens Account"));
                out
            }
            _ => vec![Line::raw("Use Harness locally without signing in."), Line::raw(""), Line::raw("Sign in to connect your computers, sync your workspace, and use your phone."), Line::raw("Run models on one linked computer and use them from another.")],
        },
        "m" => {
            let mut out = machine_lines(app, rest);
            if view == View::Connect {
                out.extend(stage_lines(app, rest));
                if app.devices.link.as_ref().is_none_or(|l| l.machine != rest) { out.extend(enter_does("type its remote password, then link")) }
            } else {
                out.extend(enter_does("opens its actions"));
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
                "unlink" => "asks y/n, then removes this computer's saved link — a new connection will need its password",
                _ => "",
            }));
            out
        }
        "share" => {
            let mut out = vec![bold(format!("Share {}", app.fleet.local_machine_name())).into(), Line::raw(""), Line::raw(SHARE_ACCESS), Line::raw("")];
            out.extend(sharing_lines(app));
            out.extend(enter_does("who it is shared with — add or remove people, or everyone at your domain"));
            out
        }
        "shr" => share_preview(app, rest),
        "addshared" => {
            let Some((_, name, share)) = app.fleet.to_add.iter().find(|(id, ..)| id == rest) else { return vec![] };
            let mut out = vec![bold(name.clone()).into(), Line::raw(""), kv("shared by", owner_of(share)), Line::raw(""),
                Line::raw(format!("{} shared it with everyone at your company. Added, you get your own space on it and use their Claude and ChatGPT plans.", share.owner))];
            out.extend(enter_does("adds it to your machines"));
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
                    out.push(dim(LINK_HERE).into());
                }
                Some(Ok(_)) => { out.push(bold("No remote password set.").into()); out.push(Line::raw("")); out.push(dim("Set one so another computer can link to this one.").into()); out.push(dim(LINK_HERE).into()) }
                Some(Err(e)) => { out.push(Line::from(vec![Span::styled("Password status is unavailable.", fg(theme::WARN))])); if e != "Password status is unavailable." { out.push(dim(e.clone()).into()) } }
                None => out.push(dim("Reading password status…").into()),
            }
            out.extend(enter_does(match (rest, password_set(app)) {
                ("set", _) | ("", Some(false)) => "asks for the new password twice, then y/n",
                ("clear", _) => "asks y/n, then clears it — existing links stay",
                ("", Some(true)) => "change or clear it",
                _ => "reads its status again",
            }));
            out
        }
        "add" => {
            let mut out = vec![bold("Add a machine").into(), Line::raw("")];
            out.extend(add_steps(app));
            out.extend(enter_does("lists the computers ready to link"));
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

/// The signed-in account's email: as the account read it, else as the daemon last said (`/api/auth/me`).
fn account_email(app: &App) -> Option<String> {
    match &app.account.status { crate::account::Status::SignedIn { email: Some(e), .. } => Some(e.clone()), _ => app.devices.phone.email.clone() }
}

/// How another computer joins: the same account, a remote password there, that password here.
fn add_steps(app: &App) -> Vec<Line<'static>> {
    let account = account_email(app).unwrap_or_else(|| "the same account".into());
    vec![
        Line::raw(format!("1. On the other computer, open Harness and sign in as {account}.")),
        Line::raw("2. There, set a remote password in Machines & devices."),
        Line::raw("3. Back here, choose that computer and enter the password."),
    ]
}

/// Who this computer is shared with now, under its Share row.
fn sharing_lines(app: &App) -> Vec<Line<'static>> {
    let Some((emails, same_domain, domain)) = sharing_now(app) else {
        return vec![match &app.devices.sharing { Some(Err(e)) => Line::from(Span::styled(e.clone(), fg(theme::WARN))), _ => dim("Reading its sharing…").into() }];
    };
    let mut out = Vec::new();
    if let Some(d) = domain { out.push(kv("domain", format!("everyone at @{d} · {}", if same_domain { "on" } else { "off" }))) }
    if emails.is_empty() { out.push(kv("people", "nobody yet")) }
    for (i, email) in emails.iter().enumerate() { out.push(kv(if i == 0 { "people" } else { "" }, email.clone())) }
    let using = using_by_email(app);
    if !using.is_empty() { out.push(kv("using it", using.join(", "))) }
    out
}

/// The right side for one of this computer's sharing rows: what it is, and what Enter does.
fn share_preview(app: &App, rest: &str) -> Vec<Line<'static>> {
    if rest == "reload" {
        let mut out = match &app.devices.sharing { Some(Err(e)) => vec![Line::from(Span::styled(e.clone(), fg(theme::WARN)))], _ => vec![] };
        out.extend(enter_does("reads its sharing again"));
        return out;
    }
    let Some((_, same_domain, domain)) = sharing_now(app) else { return vec![] };
    let members = sharing_members(app);
    match rest.split_once(':').unwrap_or((rest, "")) {
        ("domain", _) => {
            let Some(d) = domain else { return vec![] };
            let mut out = vec![bold(format!("Everyone at @{d}")).into(), Line::raw(""),
                Line::raw(format!("Anyone with an @{d} email can use it, no invite needed. They get their own private space and use your Claude and ChatGPT plans.")), Line::raw(""),
                kv("now", if same_domain { "on" } else { "off" })];
            out.extend(enter_does(if same_domain { format!("stops sharing with everyone at @{d}; people you added by email keep it") } else { "asks y/n, then shares it with them".into() }));
            out
        }
        ("add", _) => {
            let mut out = vec![bold("Add people").into(), Line::raw(""), Line::raw("They see it in their Machines. They get their own private space and use your Claude and ChatGPT plans."),
                Line::raw(""), dim("Several at once: separate the addresses with commas or spaces.").into()];
            out.extend(enter_does("asks for their email addresses, then y/n"));
            out
        }
        ("rm", email) => {
            let using = members.iter().any(|(e, _)| e == email);
            let mut out = vec![bold(email.to_string()).into(), Line::raw(""), kv("status", if using { "joined" } else { "invited" })];
            out.extend(enter_does("asks y/n, then stops sharing with them — they lose access at once"));
            out
        }
        ("guests-on", _) => {
            let why = if guest_access(app).as_deref() == Some("outdated") { "People you added can't use it since the update." } else { "People you added can't use it yet." };
            let mut out = vec![bold("Turn on sharing").into(), Line::raw(""), Line::styled(why, fg(theme::WARN)), Line::raw(""),
                Line::raw("Each person you share with gets their own account on this computer, so they can't see your files. You enter your password once to set this up.")];
            out.extend(enter_does("shows this computer's admin prompt"));
            out
        }
        ("folder-read" | "folder-write", _) => {
            let write = rest == "folder-write";
            let mut out = vec![bold(if write { "Share a folder they can edit" } else { "Share a folder they can view" }).into(), Line::raw(""),
                Line::raw(if write { "People you share with can open it and change, add or delete files." } else { "People you share with can open it and read the files." }),
                Line::raw(""), Line::styled("They see everything inside, even passwords and keys.", fg(theme::WARN))];
            out.extend(enter_does("asks for the folder's full path, then y/n"));
            out
        }
        ("folder", path) => {
            let write = sharing_folders(app).iter().any(|(p, w)| p == path && *w);
            let mut out = vec![bold(path.to_string()).into(), Line::raw(""), kv("access", if write { "can edit" } else { "can view" })];
            out.extend(enter_does("asks y/n, then stops sharing it"));
            out
        }
        _ => vec![],
    }
}

fn machine_lines(app: &App, id: &str) -> Vec<Line<'static>> {
    let Some(m) = app.fleet.machine(id) else { return vec![dim("(gone)").into()] };
    let (glyph, color, word) = reach(app, m);
    let mut out = vec![Line::from(vec![bold(m.name.clone()), dim(if m.local { "  this computer" } else { "" })]), Line::raw("")];
    out.push(Line::from(vec![dim(format!("{:<KEY_W$}", "status")), Span::styled(format!("{glyph} {word}"), fg(color))]));
    if let Some(share) = app.fleet.shares.get(id) { out.push(kv("shared by", owner_of(share))) }
    if let Some(rtt) = app.rtt.get(id).filter(|_| m.usable()) { out.push(kv("rtt", format!("{}ms", rtt.as_millis()))) }
    // (Saved, not live: a machine can still need linking again after it.)
    if let Some(l) = link_of(app, id) { out.push(kv("saved link", l.at.clone())) }
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
    let level = match app.devices.sub.as_deref() {
        Some("share:") => Some(format!("Share {}", app.fleet.local_machine_name())),
        Some("pw:") => Some("Remote password".to_string()),
        sub => sub.and_then(|s| s.strip_prefix("m:")).map(|id| name_of(app, id)),
    };
    // The way here, the view it came from first: `Machines & devices  ›  Connect a computer`.
    let path: Vec<String> = app.devices.back.as_ref().map(|b| b.view.title().to_string()).into_iter().chain(std::iter::once(title.to_string())).chain(level).collect();
    // (It stops a column short of `esc`, however long.)
    let end = right.saturating_sub(4);
    let mut at = x;
    for (i, part) in path.iter().enumerate() {
        if i > 0 { at += settings::put(buf, at, y, end.saturating_sub(at), "  ›  ", c.muted) }
        let style = if i == 0 { c.base.add_modifier(Modifier::BOLD) } else if i + 1 == path.len() { c.accent } else { c.base };
        let w = settings::put(buf, at, y, end.saturating_sub(at), part, style);
        // The first part is the way back, as Esc is.
        if i == 0 { app.devices.back_at.set((path.len() > 1).then(|| (app.size, Rect::new(x, y, w, 1)))) }
        at += w;
    }
    settings::put(buf, right.saturating_sub(3), y, 3, "esc", c.muted);
}

/// The query line: always the search (what the panel asks is asked in its dialog).
fn query_line(buf: &mut Buffer, app: &App, picker: &Picker, x: u16, y: u16, right: u16, c: &Chrome) -> Option<Position> {
    let w = right.saturating_sub(x);
    settings::put(buf, x, y, 2, "›", c.accent);
    let shown = if picker.query.is_empty() { (picker.placeholder.as_str(), c.muted) } else { (picker.query.as_str(), c.base) };
    settings::put(buf, x + 2, y, w.saturating_sub(2), shown.0, shown.1);
    picker.prompt_at.set((y, x + 2));
    let before: String = picker.query.chars().take(picker.qcursor).collect();
    (app.devices.ask.is_none()).then(|| Position::new((x + 2 + before.width() as u16).min(right), y))
}

/// What is being asked, as the shared dialog centred over [over] (the panel, or Add phone's words
/// beside its QR code): its title, the question — or the input under its label, with what to do
/// or what went wrong under it — and the buttons. Its buttons and input are kept for clicks;
/// returns where the terminal cursor goes. Nothing is drawn where its buttons cannot fit.
fn ask_dialog(buf: &mut Buffer, app: &App, over: Rect, c: &Chrome) -> Option<Position> {
    let ask = app.devices.ask.as_ref()?;
    let room = over.width.saturating_sub(4);
    let confirm = matches!(ask, Ask::Confirm { .. });
    let mut row = prompt_row(app, confirm, action(ask, room));
    // (A question that cannot be drawn must not stay open to answering keys: the frame ends it.)
    if row.buttons_width() > room { app.devices.unfit.set(true); return None }
    let input_focus = !app.devices.prompt_focus.get();
    if !confirm && input_focus { row.chosen = usize::MAX }   // the input has the keys: no button chosen
    let mut d = Dialog::new(&ask_title(app, ask), Vec::new(), &row, c);
    d.border = crate::ui::dialog_border(&app.style_spec("menu-border-lines", app.active, app.focused()));
    match ask {
        Ask::Confirm { question, .. } => d.body = dialog::wrap(question, room.min(INPUT_W), c.base),
        Ask::Entry { label, value, caret, secret, .. } => {
            d.input = Some(Input { label, value, caret: *caret, select: None, secret: *secret, focused: input_focus, width: INPUT_W });
            if let Some((m, error, _)) = &app.devices.footer { d.message = dialog::wrap(m, room.min(INPUT_W), if *error { c.danger } else { c.muted }) }
        }
    }
    if !d.fit(over.height) { app.devices.unfit.set(true); return None }
    let area = d.place(over);
    d.render_over(over, area, buf);
    let a = d.areas(area);
    let cells = row.areas(a.row);
    app.devices.prompt_actions.set(Some(PromptActions { size: app.size, accept: cells[1], cancel: cells[0], input: a.input }));
    d.cursor(area)
}

/// After a frame: a question that had no room to be drawn is cancelled, as Close Tab's is when
/// the terminal shrinks under it, and the person told why.
pub fn cancel_unfit(app: &mut App) {
    if !app.devices.unfit.take() || app.devices.ask.is_none() { return }
    app.devices.ask = None;
    app.devices.prompt_actions.set(None);
    note(app, "Nothing changed");
    app.say(crate::workspace_menu::TOO_SMALL_TO_ANSWER, theme::WARN);
}

/// The dialog's title: what is being done, and to what.
fn ask_title(app: &App, ask: &Ask) -> String {
    match ask {
        Ask::Entry { what: Entry::Link { name, .. }, .. } | Ask::Confirm { act: Act::Link { name, .. }, .. } => format!("Connect · {name}"),
        Ask::Entry { what: Entry::NewPassword | Entry::RepeatPassword { .. }, .. } | Ask::Confirm { act: Act::SetPassword(_), .. } => "Set Remote Password".into(),
        Ask::Confirm { act: Act::ClearPassword, .. } => "Clear Remote Password".into(),
        Ask::Entry { what: Entry::Rename { name, .. }, .. } => format!("Rename Computer · {name}"),
        Ask::Confirm { act: Act::Rename { machine, .. }, .. } => format!("Rename Computer · {}", name_of(app, machine)),
        Ask::Confirm { act: Act::Unlink { name, .. }, .. } => format!("Unlink · {name}"),
        // (The row says "Remove from account…".)
        Ask::Confirm { act: Act::Remove { name, .. }, .. } => format!("Remove from Account · {name}"),
        Ask::Confirm { act: Act::Unpair { name, .. }, .. } => format!("Remove Access · {name}"),
        Ask::Confirm { act: Act::ArmPhone, .. } => "Add Your Phone".into(),
        Ask::Entry { what: Entry::ShareEmail | Entry::ShareFolder { .. }, .. } | Ask::Confirm { act: Act::Share { .. } | Act::ShareFolders { .. }, .. } =>
            format!("Share · {}", app.fleet.local_machine_name()),
        Ask::Confirm { act: Act::AddShared { name, .. }, .. } => format!("Add to My Machines · {name}"),
    }
}

/// The action button's word: Yes to a question; for a typed line what Enter does — Connect, Save,
/// else Continue — or Next where [room] is narrower than `[ Cancel ]  [ <that> ]`.
fn action(ask: &Ask, room: u16) -> &'static str {
    let word = match ask {
        Ask::Confirm { .. } => return "Yes",
        Ask::Entry { what: Entry::Link { .. }, .. } => "Connect",
        Ask::Entry { what: Entry::Rename { .. }, .. } => "Save",
        Ask::Entry { what: Entry::ShareEmail | Entry::ShareFolder { .. }, .. } => "Add",
        Ask::Entry { .. } => "Continue",
    };
    if "[ Cancel ]  [  ]".width() + word.width() > room as usize { "Next" } else { word }
}

/// `[ Cancel ]  [ Yes ]`, or `[ Cancel ]  [ <action> ]` for a typed line, with the chosen button
/// from the panel's state. [confirm] is passed because a key takes the ask out while it answers.
fn prompt_row(app: &App, confirm: bool, action: &str) -> buttons::Row {
    let key = |ch: char| confirm.then_some(ch);
    buttons::Row {
        buttons: vec![Button { label: "Cancel".into(), key: key('n') }, Button { label: action.into(), key: key('y') }],
        chosen: app.devices.prompt_row.get().min(1),
        hint: buttons::KEYS.into(),
    }
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

/// What the footer says: what just happened or went wrong, else the keys — nothing while the
/// dialog asks (what it says is in the dialog).
fn footer(buf: &mut Buffer, app: &App, picker: &Picker, x: u16, y: u16, w: u16, c: &Chrome) {
    if app.devices.ask.is_some() { return }
    let (line, style) = match app.devices.footer.as_ref().filter(|(_, err, at)| *err || at.elapsed() < Duration::from_secs(6)) {
        Some((t, err, _)) => (t.clone(), if *err { c.danger } else { c.accent }),
        None => (format!("↑↓ move   enter choose   type to search   esc {}", if app.devices.sub.is_some() || app.devices.back.is_some() || picker.from_commands { "back" } else { "close" }), c.muted),
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
    app.devices.unfit.set(false);
    app.devices.phone.drawn.set(None);
    picker.screen_area.set(body);
    picker.list_area.set(Rect::default());
    picker.row_at.clear();
    picker.preview_area.set(None);
    picker.bar.set(None);
    settings::backdrop(buf, body, c.backdrop);
    if body.width < 24 || body.height < 8 {
        if app.devices.ask.is_some() { app.devices.unfit.set(true) }
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
    if app.devices.ask.is_some() { return ask_dialog(buf, app, r, &c) }
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
    // (The question goes over the words beside the code, so the code stays in view while it asks.)
    ask_dialog(buf, app, Rect::new(tx, r.y, r.right().saturating_sub(tx), r.height), c)
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
    /// Onto a row of the remote password's level, in through its one row when not there already
    /// (`pw:set` with no password yet is that row itself: Enter on it asks for one).
    fn to_password(app: &mut App, id: &str) {
        if ids(app).iter().any(|r| r == id) { return go_to(app, id) }
        go_to(app, "pw:");
        if id == "pw:set" && password_set(app) != Some(true) { return }
        press(app, KeyCode::Enter);
        go_to(app, id);
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

    /// The world, and this computer's daemon answering `shared_machines` as services/sharedMachines.ts does.
    fn sharing_world(app: &mut App) -> Arc<Mutex<Vec<Req>>> {
        let log = Arc::new(Mutex::new(Vec::new()));
        let seen = log.clone();
        let policy = Arc::new(Mutex::new(json!({ "emails": [], "sameDomain": false, "domain": "acme.io", "members": [] })));
        app.devices.runner = Some(Box::new(move |req: &Req| {
            seen.lock().unwrap().push(req.clone());
            let Req::Rpc { ty: "shared_machines", payload } = req else { return world(req) };
            Some(Reply::Rpc(Ok(match payload["action"].as_str() {
                Some("get") => policy.lock().unwrap().clone(),
                Some("set") => {
                    let mut p = policy.lock().unwrap();
                    p["emails"] = payload["emails"].clone();
                    p["sameDomain"] = payload["sameDomain"].clone();
                    p.clone()
                }
                Some("set_folders") => {
                    let mut p = policy.lock().unwrap();
                    p["folders"] = payload["folders"].clone();
                    p.clone()
                }
                _ => json!({ "ok": true }),
            })))
        }));
        log
    }
    /// Guest access off at first: the first share turns it on behind this computer's admin prompt, unless the
    /// person cancels it there ([cancel]).
    fn guest_world(app: &mut App, cancel: bool) -> Arc<Mutex<Vec<Req>>> {
        guest_world_from(app, cancel, json!({ "emails": [], "sameDomain": false, "domain": "acme.io", "members": [], "guestAccess": "missing" }))
    }
    fn guest_world_from(app: &mut App, cancel: bool, policy: Value) -> Arc<Mutex<Vec<Req>>> {
        let log = Arc::new(Mutex::new(Vec::new()));
        let seen = log.clone();
        let policy = Arc::new(Mutex::new(policy));
        app.devices.runner = Some(Box::new(move |req: &Req| {
            seen.lock().unwrap().push(req.clone());
            let Req::Rpc { ty: "shared_machines", payload } = req else { return world(req) };
            let mut p = policy.lock().unwrap();
            Some(Reply::Rpc(Ok(match payload["action"].as_str() {
                Some("enable_guests") if cancel => json!({ "error": "CANCELLED", "message": "Sharing was not turned on: the admin prompt was cancelled." }),
                Some("enable_guests") => { p["guestAccess"] = json!("ready"); json!({ "ok": true, "guestAccess": "ready" }) }
                Some("set") => { p["emails"] = payload["emails"].clone(); p["sameDomain"] = payload["sameDomain"].clone(); p.clone() }
                _ => p.clone(),
            })))
        }));
        log
    }
    fn rpc(action: &str, rest: Value) -> Req {
        let mut payload = json!({ "action": action });
        for (k, v) in rest.as_object().unwrap() { payload[k] = v.clone() }
        Req::Rpc { ty: "shared_machines", payload }
    }
    fn row_of<'a>(app: &'a App, id: &str) -> Option<&'a Row> {
        match &app.modal { Some(Modal::Picker { picker, .. }) => picker.rows.iter().find(|r| r.id == id), _ => None }
    }

    #[test]
    fn machines_shared_with_this_account_are_its_to_use_and_an_older_backends_team_ones_are_added_with_enter() {
        const SHARED: &str = "abababababababababababababababab";
        const TEAM: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
        let mut app = app((150, 42));
        let log = sharing_world(&mut app);
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: SHARED.into(), name: "dee-studio".into(), local: false, status: "running".into(), reach: Reach::Ready });
        let dee = crate::fleet::MachineShare { owner: "Dee".into(), email: "dee@acme.io".into(), team: true };
        app.fleet.shares.insert(SHARED.into(), dee.clone());
        app.fleet.to_add.push((TEAM.into(), "gpu-box-2".into(), dee));
        app.rtt.insert(SHARED.into(), std::time::Duration::from_millis(42));
        open(&mut app, View::Machines);
        assert_eq!(row_of(&app, &format!("m:{SHARED}")).and_then(|r| r.group.as_deref()), Some("Shared with you"));
        assert_eq!(row_of(&app, &format!("m:{SHARED}")).map(|r| r.right.as_str()), Some("no harnesses"), "one value at the right, as your own machines show");
        let said = preview(&app, View::Machines, &format!("m:{SHARED}")).iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(said.contains("42ms") && said.contains("Dee"), "its round trip and owner are in the preview: {said}");
        assert_eq!(row_of(&app, &format!("addshared:{TEAM}")).map(|r| (r.label.as_str(), r.group.as_deref())), Some(("Add gpu-box-2", Some("Shared with your team"))));
        assert_eq!(row_of(&app, &format!("m:{REMOTE}")).and_then(|r| r.group.as_deref()), Some("Your machines"));

        // Enter adds the team's machine, through this computer's daemon (an older backend lists it to add first).
        go_to(&mut app, &format!("addshared:{TEAM}"));
        press(&mut app, KeyCode::Enter);
        assert!(has(&log, &rpc("add", json!({ "machineId": TEAM }))));
        assert!(app.fleet.to_add.is_empty());
        assert!(app.devices.footer.as_ref().is_some_and(|(t, err, _)| !err && t.starts_with("Added gpu-box-2")));

        // A machine shared with you is its owner's to rename or remove, and shared with your domain it stays
        // on your list just as one shared by email does (owner, 2026-10-16): no "Remove from my machines".
        go_to(&mut app, &format!("m:{SHARED}"));
        press(&mut app, KeyCode::Enter);
        let here = ids(&app);
        assert!(here.contains(&"shared-by".to_string()), "{here:?}");
        assert!(!here.iter().any(|id| id.starts_with("act:unshare:")), "{here:?}");
        assert!(!here.contains(&format!("act:rename:{SHARED}")) && !here.contains(&format!("act:remove:{SHARED}")));
        assert!(!has(&log, &rpc("remove", json!({ "machineId": SHARED }))));
        assert!(app.fleet.shares.contains_key(SHARED));
    }

    #[test]
    fn this_computer_is_shared_with_its_domain_and_with_addresses_each_after_a_yes() {
        let mut app = app((150, 42));
        let log = sharing_world(&mut app);
        open(&mut app, View::Machines);
        assert!(has(&log, &rpc("get", json!({}))));
        assert_eq!(row_of(&app, "share:").map(|r| r.right.clone()), Some("off".into()));
        go_to(&mut app, "share:");
        press(&mut app, KeyCode::Enter);
        assert_eq!(ids(&app)[1..], ["shr:domain", "shr:add", "shr:folder-read", "shr:folder-write"]);

        go_to(&mut app, "shr:domain");
        press(&mut app, KeyCode::Enter);
        assert!(app.devices.ask.is_some(), "everyone at the domain is asked first");
        // They use it straight away, as people named by email do: nothing to add first.
        assert!(matches!(&app.devices.ask, Some(Ask::Confirm { question, .. })
            if question.ends_with("with everyone at @acme.io? They get their own private space and use your Claude and ChatGPT plans.")), "{:?}", app.devices.ask);
        press(&mut app, KeyCode::Char('Y'));
        assert!(has(&log, &rpc("set", json!({ "emails": [], "sameDomain": true }))));
        assert_eq!(row_of(&app, "shr:domain").map(|r| r.right.clone()), Some("on".into()));

        go_to(&mut app, "shr:add");
        press(&mut app, KeyCode::Enter);
        typed(&mut app, "not-an-address");
        press(&mut app, KeyCode::Enter);
        assert!(app.devices.footer.as_ref().is_some_and(|(t, err, _)| *err && t.contains("Not an email address")));
        press(&mut app, KeyCode::Esc);
        go_to(&mut app, "shr:add");
        press(&mut app, KeyCode::Enter);
        typed(&mut app, "Ann@Gmail.com");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('Y'));
        assert!(has(&log, &rpc("set", json!({ "emails": ["ann@gmail.com"], "sameDomain": true }))));
        assert!(ids(&app).contains(&"shr:rm:ann@gmail.com".to_string()));

        // Turning the domain off needs no yes; taking an address off does.
        go_to(&mut app, "shr:domain");
        press(&mut app, KeyCode::Enter);
        assert!(has(&log, &rpc("set", json!({ "emails": ["ann@gmail.com"], "sameDomain": false }))));
        go_to(&mut app, "shr:rm:ann@gmail.com");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('Y'));
        assert!(has(&log, &rpc("set", json!({ "emails": [], "sameDomain": false }))));
        // Back out of the level, onto its row.
        press(&mut app, KeyCode::Esc);
        assert_eq!(match &app.modal { Some(Modal::Picker { picker, .. }) => picker.current_id(), _ => None }.as_deref(), Some("share:"));
    }

    #[test]
    fn the_first_share_turns_guest_access_on_behind_this_computers_admin_prompt_and_a_cancel_shares_nothing() {
        let mut cancelled = app((150, 42));
        let log = guest_world(&mut cancelled, true);
        open(&mut cancelled, View::Machines);
        go_to(&mut cancelled, "share:");
        press(&mut cancelled, KeyCode::Enter);
        go_to(&mut cancelled, "shr:domain");
        press(&mut cancelled, KeyCode::Enter);
        press(&mut cancelled, KeyCode::Char('Y'));
        assert!(has(&log, &rpc("enable_guests", json!({}))));
        assert!(!log.lock().unwrap().iter().any(|r| matches!(r, Req::Rpc { payload, .. } if payload["action"] == "set")), "nothing shared without it");
        assert!(cancelled.devices.footer.as_ref().is_some_and(|(t, err, _)| *err && t.contains("admin prompt was cancelled")));

        let mut app = app((150, 42));
        let log = guest_world(&mut app, false);
        open(&mut app, View::Machines);
        go_to(&mut app, "share:");
        press(&mut app, KeyCode::Enter);
        go_to(&mut app, "shr:domain");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('Y'));
        let asked: Vec<String> = log.lock().unwrap().iter().filter_map(|r| match r { Req::Rpc { payload, .. } => payload["action"].as_str().map(str::to_string), _ => None }).collect();
        assert_eq!(asked.iter().filter(|a| *a != "get").cloned().collect::<Vec<_>>(), ["enable_guests", "set"]);
        assert_eq!(row_of(&app, "shr:domain").map(|r| r.right.clone()), Some("on".into()));
        // On now: the next share asks nothing more of the person.
        go_to(&mut app, "shr:add");
        press(&mut app, KeyCode::Enter);
        typed(&mut app, "ann@gmail.com");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('Y'));
        assert_eq!(log.lock().unwrap().iter().filter(|r| matches!(r, Req::Rpc { payload, .. } if payload["action"] == "enable_guests")).count(), 1);
        assert!(has(&log, &rpc("set", json!({ "emails": ["ann@gmail.com"], "sameDomain": true }))));
    }

    #[test]
    fn shared_already_it_says_guests_wait_on_guest_access_and_turns_it_on() {
        // Not shared yet: nothing to say.
        let mut app = app((150, 42));
        guest_world(&mut app, false);
        open(&mut app, View::Machines);
        go_to(&mut app, "share:");
        press(&mut app, KeyCode::Enter);
        assert!(row_of(&app, "shr:guests-on").is_none());

        let mut app = self::app((150, 42));
        let log = guest_world_from(&mut app, false, json!({ "emails": ["kim@acme.io"], "sameDomain": false, "domain": "acme.io", "members": [], "guestAccess": "outdated" }));
        open(&mut app, View::Machines);
        go_to(&mut app, "share:");
        press(&mut app, KeyCode::Enter);
        assert!(row_of(&app, "shr:guests-on").is_some_and(|r| r.detail.is_empty() && r.right == "off"));
        assert!(preview(&app, View::Machines, "shr:guests-on").iter().any(|l| l.to_string().contains("since the update")), "why is in the preview");
        go_to(&mut app, "shr:guests-on");
        press(&mut app, KeyCode::Enter);
        assert!(has(&log, &rpc("enable_guests", json!({}))));
        assert!(app.devices.footer.as_ref().is_some_and(|(t, err, _)| !err && t == "Sharing is on"));
        assert!(row_of(&app, "shr:guests-on").is_none());
    }

    #[test]
    fn folders_are_shared_with_guests_read_only_or_editable_each_after_a_yes_and_taken_back_the_same_way() {
        let mut app = app((150, 42));
        let log = sharing_world(&mut app);
        open(&mut app, View::Machines);
        go_to(&mut app, "share:");
        press(&mut app, KeyCode::Enter);

        // A path that is not a full one is refused, by name, and nothing is sent.
        go_to(&mut app, "shr:folder-read");
        press(&mut app, KeyCode::Enter);
        typed(&mut app, "code/app");
        press(&mut app, KeyCode::Enter);
        assert!(app.devices.footer.as_ref().is_some_and(|(t, err, _)| *err && t.contains("full path")));
        press(&mut app, KeyCode::Esc);

        go_to(&mut app, "shr:folder-read");
        press(&mut app, KeyCode::Enter);
        typed(&mut app, "/Users/dee/docs/");
        press(&mut app, KeyCode::Enter);
        assert!(matches!(&app.devices.ask, Some(Ask::Confirm { question, .. }) if question.contains("even passwords and keys")), "{:?}", app.devices.ask);
        press(&mut app, KeyCode::Char('Y'));
        assert!(has(&log, &rpc("set_folders", json!({ "folders": [{ "path": "/Users/dee/docs", "write": false }] }))));
        assert_eq!(row_of(&app, "shr:folder:/Users/dee/docs").map(|r| r.right.clone()), Some("read only".into()));

        go_to(&mut app, "shr:folder-write");
        press(&mut app, KeyCode::Enter);
        typed(&mut app, "/Users/dee/code/app");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('Y'));
        assert!(has(&log, &rpc("set_folders", json!({ "folders": [{ "path": "/Users/dee/docs", "write": false }, { "path": "/Users/dee/code/app", "write": true }] }))));
        assert_eq!(row_of(&app, "shr:folder:/Users/dee/code/app").map(|r| r.right.clone()), Some("can edit".into()));

        // Once is enough.
        go_to(&mut app, "shr:folder-read");
        press(&mut app, KeyCode::Enter);
        typed(&mut app, "/Users/dee/docs");
        press(&mut app, KeyCode::Enter);
        assert!(app.devices.footer.as_ref().is_some_and(|(t, err, _)| !err && t.contains("already")));

        // Taken back after a yes.
        go_to(&mut app, "shr:folder:/Users/dee/docs");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('Y'));
        assert!(has(&log, &rpc("set_folders", json!({ "folders": [{ "path": "/Users/dee/code/app", "write": true }] }))));
        assert!(row_of(&app, "shr:folder:/Users/dee/docs").is_none());
        let text = |id: &str| preview(&app, View::Machines, id).iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>()).collect::<Vec<_>>().join("\n");
        assert!(text("shr:folder-write").contains("even passwords and keys"));
        assert!(text("shr:folder:/Users/dee/code/app").contains("can edit"));
    }

    // Seen 2026-10-16: the list is about fifty columns, so the sharing rows were cut short, and
    // the side beside them, where a row says the rest, was empty.
    #[test]
    fn every_sharing_row_says_in_full_beside_it_what_it_is_and_what_enter_does() {
        const SHARED: &str = "abababababababababababababababab";
        const TEAM: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
        let mut app = app((150, 42));
        let _log = sharing_world(&mut app);
        app.account.status = crate::account::Status::SignedIn { offline: false, email: Some("ann@acme.io".into()) };
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: SHARED.into(), name: "dee-studio".into(), local: false, status: "running".into(), reach: Reach::Ready });
        let dee = crate::fleet::MachineShare { owner: "Dee".into(), email: "dee@acme.io".into(), team: true };
        app.fleet.shares.insert(SHARED.into(), dee.clone());
        app.fleet.to_add.push((TEAM.into(), "gpu-box-2".into(), dee));
        open(&mut app, View::Machines);
        app.devices.sharing = Some(Ok(json!({ "emails": ["kim@x.io", "lee@y.io"], "sameDomain": true, "domain": "acme.io",
            "members": [{ "email": "kim@x.io", "via": "email" }, { "email": "bo@acme.io", "via": "domain" }] })));
        let text = |id: &str| preview(&app, View::Machines, id).iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>()).collect::<Vec<_>>().join("\n");

        assert!(text("account").starts_with("Signed in as ann@acme.io."), "{}", text("account"));
        let share = text("share:");
        for said in ["People you invite get their own private space", "everyone at @acme.io · on", "kim@x.io", "lee@y.io", "using it    kim@x.io"] { assert!(share.contains(said), "{said}: {share}") }
        // Everyone at the domain may use it, and is the domain row: nobody at it is named one by one.
        assert!(!share.contains("bo@acme.io"), "{share}");
        let domain = text("shr:domain");
        assert!(domain.contains("Anyone with an @acme.io email can use it, no invite needed. They get their own private space and use your Claude and ChatGPT plans."), "{domain}");
        assert!(!domain.contains("bo@acme.io") && !domain.contains("add it from"), "{domain}");
        assert!(domain.contains("people you added by email keep it"));
        assert!(text("shr:rm:kim@x.io").contains("joined") && text("shr:rm:lee@y.io").contains("invited"));
        assert!(text(&format!("m:{SHARED}")).contains("Dee (dee@acme.io)") && !text(&format!("m:{SHARED}")).contains("remove from your machines"));
        assert!(text(&format!("addshared:{TEAM}")).contains("Dee (dee@acme.io)"));
        for id in ["share:", "shr:domain", "shr:add", "shr:rm:kim@x.io", "shr:reload", &format!("addshared:{TEAM}"), &format!("act:open:{SHARED}")] {
            let said = text(id);
            assert!(said.lines().any(|l| l.starts_with("enter ") && l.len() > "enter ".len()), "{id}: {said}");
        }
        // And the line in the list itself fits it; the domain row promises no add step.
        go_to(&mut app, "share:");
        press(&mut app, KeyCode::Enter);
        assert!(row_of(&app, "share-what").is_some_and(|r| r.label.chars().count() <= 44));
        assert!(row_of(&app, "shr:domain").is_some_and(|r| r.detail.is_empty()));
        assert!(preview(&app, View::Machines, "shr:domain").iter().any(|l| l.to_string().contains("no invite needed")), "what it means is in the preview");
        assert_eq!(row_of(&app, "shr:rm:kim@x.io").map(|r| r.right.as_str()), Some("joined"), "the right column is its state, not a verb");
        assert_eq!(row_of(&app, "share-using").map(|r| r.label.as_str()), Some("Using it now: kim@x.io"));
    }

    // Seen 2026-10-16 with a mouse: Share's level had no way out but Esc.
    #[test]
    fn a_click_on_the_title_leaves_a_level_as_esc_does() {
        let mut app = app((150, 42));
        app.mouse = true;
        let _log = sharing_world(&mut app);
        open(&mut app, View::Machines);
        go_to(&mut app, "share:");
        press(&mut app, KeyCode::Enter);
        let (s, _) = screen(&mut app, 150, 42);
        let (y, line) = s.lines().enumerate().find(|(_, l)| l.contains("Machines & devices  ›  Share")).expect("the level's title");
        let x = line[..line.find("Machines & devices").unwrap()].chars().count() as u16;
        // The level's own name is not the way back.
        click_at(&mut app, x + "Machines & devices  ›  ".len() as u16 + 2, y as u16);
        assert_eq!(app.devices.sub.as_deref(), Some("share:"));
        click_at(&mut app, x + 3, y as u16);
        assert_eq!(app.devices.sub, None);
        assert_eq!(match &app.modal { Some(Modal::Picker { picker, .. }) => picker.current_id(), _ => None }.as_deref(), Some("share:"));
        // At the top there is nothing to go back to: the title is only a title.
        screen(&mut app, 150, 42);
        click_at(&mut app, x + 3, y as u16);
        assert!(matches!(app.modal, Some(Modal::Picker { kind: PickerKind::Devices(View::Machines), .. })));
    }

    #[test]
    fn sharing_that_cannot_be_read_says_why_and_offers_a_retry() {
        let mut app = app((150, 42));
        let _log = fake(&mut app);
        open(&mut app, View::Machines);
        assert_eq!(row_of(&app, "share:").map(|r| r.right.clone()), Some("unavailable".into()));
        go_to(&mut app, "share:");
        press(&mut app, KeyCode::Enter);
        assert!(ids(&app).contains(&"shr:reload".to_string()));
        assert_eq!(shared_answer(Reply::Rpc(Ok(json!({ "error": "UNSUPPORTED" })))), Err("Update Harness on this computer to share it.".into()));
        assert_eq!(shared_answer(Reply::Rpc(Ok(json!({ "error": "PUBLIC_DOMAIN", "message": "It is a public email domain." })))), Err("It is a public email domain.".into()));
        assert_eq!(shared_answer(Reply::Rpc(Ok(json!({ "error": "X" })))), Err("Could not share it (X).".into()));
        assert_eq!(shared_answer(Reply::Rpc(Err(("DOWN".into(), "Harness is not running on this computer.".into())))), Err("Harness is not running on this computer.".into()));
        assert!(is_email("a@b.io") && !is_email("a@b") && !is_email("@b.io") && !is_email("a b@c.io"));
        // As the backend reads them: one typed `name@!gmail.com` once failed a whole save there.
        for good in ["minhduccm90@gmail.com", "a.b+c@x.co", "o'neil@mail.acme.io", "x_y-z@sub-domain.example.com"] { assert!(is_email(good), "{good}") }
        for bad in ["bitcoinbuilder.ai@!gmail.com", "a..b@x.io", ".a@x.io", "a.@x.io", "a@-x.io", "a@x.c0", "a@x.c", "a@@x.io"] { assert!(!is_email(bad), "{bad}") }
    }

    #[test]
    fn the_commands_panel_lists_connect_machines_and_add_phone_under_machines() {
        let app = app((150, 42));
        let rows = crate::modal::command_rows(&app);
        // (Connect a computer… only went to Connect machines…: one way in. Its command still runs.)
        for (id, label) in [("devices", "Connect machines"), ("add-phone", "Add phone"), ("machines", "List machines")] {
            let row = rows.iter().find(|r| r.id == format!("cmd:{id}")).unwrap_or_else(|| panic!("{id} missing"));
            assert_eq!((row.label.as_str(), row.group.as_deref()), (label, Some("Machines")));
        }
        assert!(!rows.iter().any(|r| r.id == "cmd:connect-machine"), "no second way to the same view");
        for view in View::ALL { assert!(crate::input::is_command(view.id())) }
    }

    #[test]
    fn machines_and_devices_has_its_sections_and_rows() {
        let mut app = app((150, 42));
        let _log = fake(&mut app);
        crate::input::run(&mut app, "devices");
        let rows = ids(&app);
        assert_eq!(rows, vec!["account".to_string(), "pw:".into(), "share:".into(), format!("m:{LOCAL}"), format!("m:{REMOTE}"), format!("m:{OFF}"), "add:".into()]);
        let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!() };
        let groups: Vec<&str> = picker.rows.iter().filter_map(|r| r.group.as_deref()).collect::<Vec<_>>();
        let mut seen: Vec<&str> = Vec::new();
        for g in groups { if seen.last() != Some(&g) { seen.push(g) } }
        // This computer's section is under its name once it has one ("studio" here), not "This computer".
        assert_eq!(seen, vec!["Account", app.fleet.local_machine_name().as_str(), "Your machines"], "each group once, in order; Add a machine is the last of yours");
        let account = preview(&app, View::Machines, "account").iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(account.contains("Signed in as dev+hn@example.com"), "the preview says what the row does: {account}");
        // A row is its name and one value at the right: what it means is in the preview.
        for r in &picker.rows {
            assert!(r.detail.is_empty(), "{} has text after its name", r.id);
            assert!(!r.right.contains("  ") && !r.right.contains('·'), "{} has two values at the right: {:?}", r.id, r.right);
        }
        assert_eq!(row_of(&app, "account").map(|r| r.label.clone()), Some("dev+hn@example.com".into()), "the account row names who is signed in");
        assert_eq!(row_of(&app, &format!("m:{OFF}")).map(|r| r.right.clone()), Some("offline".into()));
        // Narrow, only why one can't be used: a connected one's ✓ says the rest.
        let narrow = |id: &str| row_of(&app, id).map(|r| r.right_at(30).to_string());
        assert_eq!((narrow(&format!("m:{LOCAL}")), narrow(&format!("m:{OFF}"))), (Some(String::new()), Some("offline".into())));
        let add = preview(&app, View::Machines, "add:").iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        assert!(add.contains("sign in as dev+hn@example.com") && !add.contains("curl") && !add.contains("http"), "the steps, no download or install: {add}");
        // A machine opens its actions: no Remove for this computer, Connect for one not linked, Unlink for one linked.
        go_to(&mut app, &format!("m:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        let acts = ids(&app);
        assert!(acts.contains(&format!("act:connect:{REMOTE}")) && acts.contains(&format!("act:remove:{REMOTE}")) && acts.contains(&format!("act:rename:{REMOTE}")), "{acts:?}");
        assert!(acts.contains(&format!("act:unlink:{REMOTE}")), "its saved link is removed from its actions: {acts:?}");
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
        assert!(picker.rows.iter().all(|r| r.detail.is_empty()), "a row is its name and state, as in Machines & devices");
        assert!(picker.rows.iter().any(|r| r.id == "offline-how"), "how to bring one back is said once, under them");
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
        assert!(s.contains("│ Remote password for gpu-box") && s.contains("│•••••••  ") && !s.contains("hunter2"), "shown as dots:\n{s}");
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
        // (27 wide at the least: `[ Cancel ]  [ Yes ]` is 19 columns and the panel is 4 narrower
        // than the screen, with 2 columns of inset each side; the old buttons fit in 24.)
        for (w, h) in [(150, 42), (80, 24), (40, 12), (27, 10)] {
            to_password(&mut app, "pw:clear");
            press(&mut app, KeyCode::Enter);
            crate::input::handle(&mut app, crossterm::event::Event::Resize(w, h));
            let (visible, _) = screen(&mut app, w, h);
            assert!(visible.contains("[ Yes ]") && visible.contains("[ Cancel ]"), "{w}x{h}:\n{visible}");
            click_prompt(&mut app, false);
            assert!(app.devices.ask.is_none());
            assert!(!has(&log, &clear));
        }
        to_password(&mut app, "pw:clear"); press(&mut app, KeyCode::Enter);
        crate::input::handle(&mut app, crossterm::event::Event::Resize(80, 24));
        screen(&mut app, 80, 24);
        // Too small to draw: the question is cancelled, never kept invisible to answer keys.
        crate::input::handle(&mut app, crossterm::event::Event::Resize(12, 5));
        screen(&mut app, 12, 5);
        assert!(app.devices.prompt_actions.get().is_none());
        assert!(app.devices.ask.is_none(), "cancelled");
        assert_eq!(app.toast.as_ref().map(|t| t.0.as_str()), Some("Make the terminal larger to answer this"));
        press(&mut app, KeyCode::Char('y'));
        assert!(!has(&log, &clear), "nothing answered it");
        assert_eq!(app.devices.footer.as_ref().map(|f| f.0.as_str()), Some("Nothing changed"), "the cancel path ran");
    }

    #[test]
    fn a_typed_line_that_cannot_fit_is_cancelled_too() {
        let mut app = app((150, 42));
        let log = fake(&mut app);
        connect_to(&mut app, REMOTE.into());
        typed(&mut app, "pw");
        crate::input::handle(&mut app, crossterm::event::Event::Resize(20, 6));
        screen(&mut app, 20, 6);
        assert!(app.devices.ask.is_none());
        assert_eq!(app.toast.as_ref().map(|t| t.0.as_str()), Some("Make the terminal larger to answer this"));
        press(&mut app, KeyCode::Enter);
        assert!(clis(&log, "link").iter().all(|r| !matches!(r, Req::Cli { args, .. } if args[1] == "connect")), "the typed password went nowhere");
    }

    #[test]
    fn dialog_titles_follow_the_naming_system() {
        let mut app = app((150, 42));
        let _log = fake(&mut app);
        let title = |app: &mut App| { let (s, _) = screen(app, 150, 42); s.lines().find_map(|l| l.find("┌─").map(|i| l[i..].chars().skip(2).take_while(|c| *c != '─').collect::<String>().trim_end().to_string())).unwrap_or_default() };
        connect_to(&mut app, REMOTE.into());
        assert_eq!(title(&mut app), "Connect · gpu-box");
        press(&mut app, KeyCode::Esc);
        crate::input::run(&mut app, "devices");
        to_password(&mut app, "pw:set");
        press(&mut app, KeyCode::Enter);
        assert_eq!(title(&mut app), "Set Remote Password");
        typed(&mut app, "a"); press(&mut app, KeyCode::Enter);
        assert_eq!(title(&mut app), "Set Remote Password", "the repeat step too");
        typed(&mut app, "a"); press(&mut app, KeyCode::Enter);
        assert_eq!(title(&mut app), "Set Remote Password", "and its question");
        press(&mut app, KeyCode::Esc);
        to_password(&mut app, "pw:clear");
        press(&mut app, KeyCode::Enter);
        assert_eq!(title(&mut app), "Clear Remote Password");
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Esc);
        assert_eq!(picker_mut(&mut app).and_then(|p| p.current_id()).as_deref(), Some("pw:"), "out of its level, back on its row");
        go_to(&mut app, &format!("m:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        go_to(&mut app, &format!("act:rename:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        assert_eq!(title(&mut app), "Rename Computer · gpu-box");
        typed(&mut app, "2"); press(&mut app, KeyCode::Enter);
        assert_eq!(title(&mut app), "Rename Computer · gpu-box", "and its question");
        press(&mut app, KeyCode::Esc);
        go_to(&mut app, &format!("act:remove:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        assert_eq!(title(&mut app), "Remove from Account · gpu-box", "echoing the row \"Remove from account…\"");
    }

    #[test]
    fn typing_while_the_buttons_have_the_keys_goes_back_to_the_input() {
        let mut app = app((150, 42));
        let _log = fake(&mut app);
        connect_to(&mut app, REMOTE.into());
        typed(&mut app, "ab");
        press(&mut app, KeyCode::Tab);
        assert!(app.devices.prompt_focus.get(), "on the buttons");
        // (h and l move between buttons there, but they are letters too.)
        typed(&mut app, "hl");
        assert!(!app.devices.prompt_focus.get(), "the input has the keys again");
        assert!(matches!(&app.devices.ask, Some(Ask::Entry { value, caret: 4, .. }) if value == "abhl"), "{:?}", app.devices.ask);
        press(&mut app, KeyCode::Tab);
        press(&mut app, KeyCode::Right);
        assert!(app.devices.prompt_focus.get(), "arrows still move between the buttons");
    }

    #[test]
    fn prevent_new_links_starts_on_cancel_and_arrows_move_between_the_buttons() {
        let mut app = app((150, 42));
        let log = fake(&mut app);
        crate::input::run(&mut app, "devices");
        let clear = cli(&["remote-password", "clear", "--json"], None);
        // The background under the first letter of [text]'s label.
        let bg_of = |s: &str, buf: &Buffer, text: &str| {
            let (y, line) = s.lines().enumerate().find(|(_, l)| l.contains(text)).expect("button row");
            let x = line[..line.find(text).unwrap()].chars().count() as u16 + 2;
            buf[(x, y as u16)].bg
        };
        let selected = settings::chrome().selected.bg;
        to_password(&mut app, "pw:clear");
        press(&mut app, KeyCode::Enter);
        let (s, buf) = screen(&mut app, 150, 42);
        assert!(s.contains("[ Cancel ]  [ Yes ]") && s.contains(buttons::KEYS), "the one keys hint every question shows: {s}");
        if !crate::theme::no_color() {
            assert_eq!(Some(bg_of(&s, &buf, "[ Cancel ]")), selected, "starts on Cancel");
            assert_ne!(Some(bg_of(&s, &buf, "[ Yes ]")), selected);
        }
        press(&mut app, KeyCode::Enter);
        assert!(app.devices.ask.is_none(), "Enter on Cancel closes");
        assert!(!has(&log, &clear));
        to_password(&mut app, "pw:clear");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Right);
        assert!(matches!(app.devices.ask, Some(Ask::Confirm { .. })), "an arrow keeps the prompt");
        let (s, buf) = screen(&mut app, 150, 42);
        if !crate::theme::no_color() { assert_eq!(Some(bg_of(&s, &buf, "[ Yes ]")), selected, "Right chose Yes"); }
        press(&mut app, KeyCode::Left);
        press(&mut app, KeyCode::Right);
        press(&mut app, KeyCode::Enter);
        assert_eq!(clis(&log, "remote-password").iter().filter(|r| **r == clear).count(), 1);
    }

    #[test]
    fn the_password_input_keeps_the_arrows_until_tab_moves_the_keys_to_the_buttons() {
        let mut app = app((150, 42));
        let log = fake(&mut app);
        connect_to(&mut app, REMOTE.into());
        typed(&mut app, "abc");
        press(&mut app, KeyCode::Right);
        press(&mut app, KeyCode::Left);
        assert!(matches!(&app.devices.ask, Some(Ask::Entry { value, .. }) if value == "abc"), "arrows leave the typed value");
        press(&mut app, KeyCode::Tab);
        typed(&mut app, "y");
        assert!(matches!(&app.devices.ask, Some(Ask::Entry { value, .. }) if value == "abyc"), "a letter is typed at the caret, not a button's");
        press(&mut app, KeyCode::Tab);
        press(&mut app, KeyCode::Left);
        press(&mut app, KeyCode::Enter);
        assert!(app.devices.ask.is_none(), "Enter on [ Cancel ] cancels, it does not submit");
        assert!(clis(&log, "link").iter().all(|r| !matches!(r, Req::Cli { args, .. } if args[1] == "connect")));
        connect_to(&mut app, REMOTE.into());
        typed(&mut app, "abc");
        press(&mut app, KeyCode::Tab);
        press(&mut app, KeyCode::Tab);
        press(&mut app, KeyCode::Enter);
        assert!(matches!(app.devices.ask, Some(Ask::Confirm { .. })), "Tab back to the input: Enter continues");
    }

    /// The screen and where the terminal cursor is left.
    fn screen_cursor(app: &mut App, w: u16, h: u16) -> (String, Buffer, Option<Position>) {
        let (s, buf) = screen(app, w, h);
        // (The panel's own answer, drawn again: a test terminal does not say where its cursor is.)
        let Some(Modal::Picker { kind, mut picker }) = app.modal.take() else { panic!("no panel") };
        let PickerKind::Devices(view) = kind else { panic!("not a devices view") };
        let cursor = draw(&mut Buffer::empty(Rect::new(0, 0, w, h)), app, app.body(), view, &mut picker);
        app.modal = Some(Modal::Picker { kind, picker });
        (s, buf, cursor)
    }

    /// The screen's line with [text] on it.
    fn line_with<'a>(s: &'a str, text: &str) -> &'a str { s.lines().find(|l| l.contains(text)).unwrap_or_else(|| panic!("no {text:?} on screen:\n{s}")) }

    #[test]
    fn the_password_is_asked_in_a_dialog_and_the_search_line_stays_the_search() {
        let mut app = app((150, 42));
        let log = fake(&mut app);
        connect_to(&mut app, REMOTE.into());
        let (s, _, _) = screen_cursor(&mut app, 150, 42);
        assert!(s.contains("Search machines not linked yet"), "the search line is the panel's own:\n{s}");
        assert!(!s.contains("› Remote password"), "no prompt in the search line:\n{s}");
        assert!(s.contains("Connect · gpu-box") && s.contains("[ Cancel ]  [ Connect ]"), "the dialog:\n{s}");
        assert!(s.contains("│ Remote password for gpu-box"), "the label inside the box:\n{s}");
        assert!(s.contains("│ Enter the remote password set on this machine."), "the message inside the box:\n{s}");
        typed(&mut app, "pass");
        let (s, buf, cursor) = screen_cursor(&mut app, 150, 42);
        assert!(line_with(&s, "••••").contains("│••••"), "typed into the input box, masked:\n{s}");
        let at = cursor.expect("the terminal cursor is at the caret");
        assert_eq!((buf[(at.x - 1, at.y)].symbol(), buf[(at.x, at.y)].symbol()), ("•", " "), "after the last dot");
        // ← → move the caret; a paste goes in at it, never into the search.
        press(&mut app, KeyCode::Left);
        press(&mut app, KeyCode::Left);
        crate::input::handle(&mut app, crossterm::event::Event::Paste("XY".into()));
        assert!(matches!(&app.devices.ask, Some(Ask::Entry { value, .. }) if value == "paXYss"), "{:?}", app.devices.ask);
        assert!(picker_mut(&mut app).unwrap().query.is_empty());
        let (_, _, moved) = screen_cursor(&mut app, 150, 42);
        assert_eq!(moved, Some(Position::new(at.x, at.y)), "the caret after the paste: 4 dots in, as before");
        // Tab: the keys to the buttons, Connect chosen; Enter on it goes on to the yes.
        press(&mut app, KeyCode::Tab);
        let (s, buf, cursor) = screen_cursor(&mut app, 150, 42);
        assert_eq!(cursor, None, "no text cursor while the buttons have the keys");
        if !crate::theme::no_color() {
            let (y, line) = s.lines().enumerate().find(|(_, l)| l.contains("[ Connect ]")).unwrap();
            let x = line[..line.find("[ Connect ]").unwrap()].chars().count() as u16 + 2;
            assert_eq!(Some(buf[(x, y as u16)].bg), settings::chrome().selected.bg, "Connect is chosen");
        }
        press(&mut app, KeyCode::Enter);
        assert!(matches!(&app.devices.ask, Some(Ask::Confirm { act: Act::Link { password, .. }, .. }) if password == "paXYss"));
        let (s, _, _) = screen_cursor(&mut app, 150, 42);
        assert!(s.contains("Connect · gpu-box") && s.contains("Link gpu-box with this password?") && s.contains("[ Cancel ]  [ Yes ]"), "{s}");
        assert!(s.contains("Search machines not linked yet"), "{s}");
        press(&mut app, KeyCode::Esc);
        assert!(app.devices.ask.is_none());
        assert!(clis(&log, "link").iter().all(|r| !matches!(r, Req::Cli { args, .. } if args[1] == "connect")), "Esc sent nothing");
    }

    #[test]
    fn a_click_on_the_input_gives_it_the_keys_and_a_click_beside_the_dialog_keeps_it() {
        let mut app = app((150, 42));
        app.mouse = true;
        let log = fake(&mut app);
        connect_to(&mut app, REMOTE.into());
        typed(&mut app, "ab");
        press(&mut app, KeyCode::Tab);
        screen(&mut app, 150, 42);
        let input = app.devices.prompt_actions.get().and_then(|a| a.input).expect("the input box is kept for clicks");
        click_at(&mut app, input.x + 3, input.y + 1);
        typed(&mut app, "c");
        assert!(matches!(&app.devices.ask, Some(Ask::Entry { value, .. }) if value == "abc"), "typing goes to the input again: {:?}", app.devices.ask);
        // Beside the dialog, still on the panel: nothing happens; the typed line stays.
        let panel = picker_mut(&mut app).unwrap().screen_area.get();
        click_at(&mut app, panel.x + 3, panel.bottom() - 3);
        assert!(matches!(&app.devices.ask, Some(Ask::Entry { value, .. }) if value == "abc"));
        assert!(clis(&log, "link").iter().all(|r| !matches!(r, Req::Cli { args, .. } if args[1] == "connect")));
    }

    #[test]
    fn an_error_shows_in_the_dialog_and_rename_starts_from_the_current_name() {
        let mut app = app((150, 42));
        let _log = fake(&mut app);
        connect_to(&mut app, REMOTE.into());
        press(&mut app, KeyCode::Enter);
        let (s, buf, _) = screen_cursor(&mut app, 150, 42);
        let (y, line) = s.lines().enumerate().find(|(_, l)| l.contains("Enter the remote password first")).expect("the error");
        assert!(line.contains("│ Enter the remote password first"), "inside the dialog:\n{s}");
        if !crate::theme::no_color() {
            let x = line[..line.find("Enter the remote").unwrap()].chars().count() as u16;
            assert_eq!(buf[(x, y as u16)].fg, settings::chrome().danger.fg.unwrap(), "in the danger colour");
        }
        press(&mut app, KeyCode::Esc);
        crate::input::run(&mut app, "devices");
        go_to(&mut app, &format!("m:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        go_to(&mut app, &format!("act:rename:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        let (s, _, cursor) = screen_cursor(&mut app, 150, 42);
        assert!(s.contains("Rename Computer · gpu-box") && s.contains("[ Cancel ]  [ Save ]"), "{s}");
        assert!(line_with(&s, "│gpu-box").contains("│gpu-box"), "the current name in the input:\n{s}");
        assert!(cursor.is_some());
        press(&mut app, KeyCode::Backspace);
        typed(&mut app, "X");
        assert!(matches!(&app.devices.ask, Some(Ask::Entry { value, .. }) if value == "gpu-boX"));
    }

    #[test]
    fn typed_line_prompts_say_next_when_narrow_and_continue_when_there_is_room() {
        let mut app = app((150, 42));
        app.mouse = true;
        let log = fake(&mut app);
        // (Screen width -> room in the dialog: 28 -> 20 for `[ Cancel ]  [ Next ]`, 31 -> 23 for
        // Connect, 32 -> 24 for Continue.)
        for (w, h, label) in [(28, 12, "[ Next ]"), (31, 12, "[ Connect ]"), (80, 24, "[ Connect ]")] {
            connect_to(&mut app, REMOTE.into());
            typed(&mut app, "pw");
            crate::input::handle(&mut app, crossterm::event::Event::Resize(w, h));
            let (visible, _) = screen(&mut app, w, h);
            assert!(visible.contains(label) && visible.contains("[ Cancel ]"), "{w}x{h}:\n{visible}");
            click_prompt(&mut app, true);
            assert!(matches!(app.devices.ask, Some(Ask::Confirm { .. })), "{w}x{h}: the click continues");
            press(&mut app, KeyCode::Esc);
        }
        assert!(clis(&log, "link").iter().all(|r| !matches!(r, Req::Cli { args, .. } if args[1] == "connect")));
        crate::input::run(&mut app, "devices");
        for (w, h, label) in [(28, 12, "[ Next ]"), (31, 12, "[ Next ]"), (32, 12, "[ Continue ]"), (80, 24, "[ Continue ]")] {
            crate::input::handle(&mut app, crossterm::event::Event::Resize(150, 42));
            to_password(&mut app, "pw:set");
            press(&mut app, KeyCode::Enter);
            typed(&mut app, "pw");
            crate::input::handle(&mut app, crossterm::event::Event::Resize(w, h));
            let (visible, _) = screen(&mut app, w, h);
            assert!(visible.contains(label) && visible.contains("[ Cancel ]"), "{w}x{h}:\n{visible}");
            click_prompt(&mut app, true);
            assert!(matches!(app.devices.ask, Some(Ask::Entry { what: Entry::RepeatPassword { .. }, .. })), "{w}x{h}: the click continues");
            press(&mut app, KeyCode::Esc);
        }
        assert!(clis(&log, "remote-password").iter().all(|r| !matches!(r, Req::Cli { args, .. } if args[1] == "set")));
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
        go_to(&mut app, &format!("m:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        go_to(&mut app, &format!("act:unlink:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        assert!(matches!(&app.devices.ask, Some(Ask::Confirm { question, .. }) if question.contains("gpu-box")));
        press(&mut app, KeyCode::Char('n'));
        let unlink = cli(&["link", "unlink", REMOTE], None);
        assert!(!has(&log, &unlink), "n: nothing ran");
        go_to(&mut app, &format!("act:unlink:{REMOTE}"));
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('y'));
        assert!(has(&log, &unlink), "y: unlinked");
        press(&mut app, KeyCode::Esc);
        // Set password: twice, a mismatch caught, then y/n.
        to_password(&mut app, "pw:set");
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
        to_password(&mut app, "pw:clear");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Esc);
        assert!(!has(&log, &cli(&["remote-password", "clear", "--json"], None)));
        press(&mut app, KeyCode::Esc);
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
    fn add_phone_shows_the_qr_for_the_link_and_arms_without_asking() {
        let mut app = app((150, 42));
        let log = fake(&mut app);
        crate::input::run(&mut app, "add-phone");
        let pair = |log: &Arc<Mutex<Vec<Req>>>| log.lock().unwrap().iter().filter(|r| matches!(r, Req::Http { path, .. } if path == "/api/pair")).count();
        assert!(app.devices.ask.is_none(), "no dialog: opening Add your phone is the ask");
        assert_eq!(pair(&log), 1, "armed at once: the code handed over");
        let link = phone_link(&app).expect("a link");
        assert!(link.starts_with("https://harness.autonomous.ai/pair#e=dev%2Bhn%40example.com&m=") && link.contains("&h=hs_"), "{link}");
        let (s, buf) = screen(&mut app, 150, 42);
        let at = app.devices.phone.drawn.get().expect("the QR is drawn");
        assert_eq!(decode(&buf, at), link, "the screen's code is the link");
        let grouped: Vec<String> = app.devices.phone.code.as_bytes().chunks(4).map(|g| String::from_utf8_lossy(g).to_string()).collect();
        assert!(s.contains(&grouped.join(" ")), "the code in text:\n{s}");
        assert!(s.contains("Dee's iPhone") && !s.contains("Cabled gadget"), "the phones and computers paired, nothing else:\n{s}");
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
                    View::Machines => assert!(s.contains(&app.fleet.local_machine_name()) && !s.contains("This computer") && s.contains("Your machines") && s.contains("enter choose"), "{s}"),
                    View::Connect => assert!(s.contains("gpu-box") && s.contains("Not linked yet") && s.contains("enter choose"), "{s}"),
                    View::Phone if w == 80 => assert!(s.contains("to show the QR code") && app.devices.phone.drawn.get().is_none(), "too small says so:\n{s}"),
                    View::Phone => assert!(app.devices.phone.drawn.get().is_some(), "{s}"),
                }
                if view == View::Phone { assert!(!s.contains("[ Yes ]"), "no dialog before handing over the code:\n{s}") }
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

    // Seen 2026-10-21: Add a machine opened Connect a computer, and Esc there closed the whole panel;
    // its Set up another computer opened Machines again on top.
    #[test]
    fn add_a_machine_opens_connect_and_esc_comes_back_to_it() {
        let mut app = app((150, 42));
        app.mouse = true;
        let _log = fake(&mut app);
        let view = |app: &App| match &app.modal { Some(Modal::Picker { kind: PickerKind::Devices(v), picker }) => Some((*v, picker.current_id())), _ => None };
        crate::input::run(&mut app, "devices");
        go_to(&mut app, "add:");
        press(&mut app, KeyCode::Enter);
        assert_eq!(view(&app).map(|v| v.0), Some(View::Connect));
        let (s, _) = screen(&mut app, 150, 42);
        assert!(s.contains("Machines & devices  ›  Connect a computer") && s.contains("esc back"), "the way here, and back:\n{s}");
        // Esc: back on Add a machine, not closed.
        press(&mut app, KeyCode::Esc);
        assert_eq!(view(&app), Some((View::Machines, Some("add:".into()))));
        assert!(app.devices.back.is_none());
        // Set up another computer goes back too, rather than a third view on top.
        go_to(&mut app, "add:");
        press(&mut app, KeyCode::Enter);
        go_to(&mut app, "here:setup");
        press(&mut app, KeyCode::Enter);
        assert_eq!(view(&app), Some((View::Machines, Some("add:".into()))));
        // And a click on where it came from, as Esc.
        go_to(&mut app, "add:");
        press(&mut app, KeyCode::Enter);
        let (s, _) = screen(&mut app, 150, 42);
        let (y, line) = s.lines().enumerate().find(|(_, l)| l.contains("Machines & devices  ›")).unwrap();
        let x = line[..line.find("Machines & devices").unwrap()].chars().count() as u16;
        assert!(mouse(&mut app, MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: x + 2, row: y as u16, modifiers: KeyModifiers::NONE }));
        assert_eq!(view(&app), Some((View::Machines, Some("add:".into()))));
        // Esc again closes it, as it did.
        press(&mut app, KeyCode::Esc);
        assert!(view(&app).is_none());
    }

    #[test]
    fn nothing_real_runs_under_test() {
        let mut app = app((150, 42));
        crate::input::run(&mut app, "devices");
        assert!(matches!(app.devices.password, Some(Err(_))), "the CLI is not there in tests");
    }

    // Seen 2026-10-21: `mach` in Commands listed Open harness and New pane above the machine ones.
    #[test]
    fn searching_commands_for_machines_lists_the_machine_ones_first() {
        let app = app((150, 42));
        let mut c = crate::picker::Picker::new("Commands", "");
        (c.live, c.search_extra) = (true, true); // as the panel opens it
        c.set_rows(crate::modal::command_rows_for(&app, true, false));
        c.set_query("mach");
        let labels: Vec<String> = c.visible.iter().map(|(i, _)| c.rows[*i].label.to_lowercase()).collect();
        let named = labels.iter().take_while(|l| l.contains("mach")).count();
        assert!(named >= 2 && labels[named..].iter().all(|l| !l.contains("mach")), "{labels:?}");
    }
}
