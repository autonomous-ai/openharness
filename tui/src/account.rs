//! Optional account entry. Authentication remains owned by the installed CLI,
//! including cancellation, browser callbacks and phone approval; hn never reads tokens.
use std::time::{Duration, Instant};

use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::Modifier;
use ratatui::text::Line;
use ratatui::widgets::{Paragraph, Widget, Wrap};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::app::App;
use crate::devices::{Reply, Req};
use crate::modal::{Modal, PickerKind};
use crate::picker::{Picker, Row};

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Status {
    #[default] Unknown,
    SignedOut,
    SignedIn { offline: bool, email: Option<String> },
}

#[derive(Clone, Debug, Default, PartialEq)]
enum Phase {
    #[default] Ready,
    Starting,
    Browser(String),
    Phone { url: String, expires: Instant },
    Confirm(String),
    Completing,
    Committed,
    Failed(String),
}

#[derive(Clone, Debug, PartialEq)]
enum Driver { Answer(bool), Cancel }

#[derive(Default)]
pub struct State {
    pub status: Status,
    phase: Phase,
    checked: Option<Instant>,
    checking: bool,
    generation: u64,
    driver: Option<mpsc::UnboundedSender<Driver>>,
    waiting: Option<String>,
    pub qr_drawn: std::cell::Cell<Option<Rect>>,
    #[cfg(test)]
    started: Vec<Vec<String>>,
}

pub fn label(app: &App) -> &'static str {
    if app.account.status == Status::SignedOut { "Sign in" } else { "Account" }
}

pub fn open(app: &mut App) {
    crate::input::picker(app, PickerKind::Account, "Your Harness account", "");
    refresh(app, true);
}

fn visible(app: &App) -> bool { matches!(app.modal, Some(Modal::Picker { kind: PickerKind::Account, .. })) }

pub(crate) fn identity_changed(app: &mut App) {
    app.account.checked = None; app.account.checking = false;
    if app.account.driver.is_none() { app.account.status = Status::Unknown; app.account.phase = Phase::Ready; }
}

pub fn refresh(app: &mut App, force: bool) {
    if app.account.checking || (!force && app.account.checked.is_some_and(|t| t.elapsed() < Duration::from_secs(60))) { return }
    app.account.checking = true;
    app.account.checked = Some(Instant::now());
    let generation = app.account.generation;
    crate::devices::ask(app, Req::Cli { args: vec!["auth".into(), "status".into(), "--json".into()], stdin: None }, None, move |app, reply| {
        app.account.checking = false;
        if app.account.generation != generation { return }
        if let Reply::Cli { ok: true, out, .. } = reply {
            let status = out.lines().rev().find_map(|s| serde_json::from_str::<Value>(s).ok());
            if let Some(status) = status {
                let expected = if status["loggedIn"] == true { status["machineId"].as_str() } else { status["computerId"].as_str() };
                if expected.is_some_and(|id| !id.is_empty() && id != app.fleet.local_id) { reconnect(app); }
                match status["loggedIn"].as_bool() {
                    Some(false) => app.account.status = Status::SignedOut,
                    Some(true) => {
                        let email = match &app.account.status { Status::SignedIn { email, .. } => email.clone(), _ => None };
                        app.account.status = Status::SignedIn { offline: status["offline"] == true, email };
                        load_email(app, generation);
                    }
                    None => {}
                }
            }
        }
        refill(app);
    });
}

fn load_email(app: &mut App, generation: u64) {
    crate::devices::ask(app, Req::Http { method: "GET", path: "/api/auth/me".into(), body: None }, None, move |app, reply| {
        if app.account.generation != generation { return }
        if let (Status::SignedIn { email, .. }, Reply::Http(Ok(value))) = (&mut app.account.status, reply) {
            *email = value.pointer("/user/email").and_then(Value::as_str).filter(|s| s.contains('@') && !s.chars().any(char::is_control)).map(str::to_string);
        }
        refill(app);
    });
}

pub fn tick(app: &mut App) {
    let open = visible(app);
    if !open && !matches!(app.account.phase, Phase::Committed | Phase::Completing) { cancel(app); }
    if !app.headless && (app.account.checked.is_none() || open) { refresh(app, false); }
    if matches!(app.account.phase, Phase::Phone { expires, .. } if Instant::now() >= expires) {
        cancel(app);
        app.account.phase = Phase::Failed("This code expired. Choose Sign in with phone to get a new one.".into());
        refill(app);
    }
}

pub fn fill(app: &App, picker: &mut Picker) {
    picker.keep_order = true;
    picker.preview = true;
    picker.hints = vec![("↑↓", "choose"), ("enter", "open"), ("esc", "back")];
    let mut rows = Vec::new();
    match &app.account.phase {
        Phase::Starting => rows.push(Row::new("account:wait", app.account.waiting.as_deref().unwrap_or("Starting sign-in…"))),
        Phase::Browser(_) => {
            rows.push(Row::new("account:browser", "Open sign-in page"));
            rows.push(Row::new("account:copy", "Copy sign-in link"));
            rows.push(Row::new("account:cancel", "Cancel sign-in"));
        }
        Phase::Phone { .. } => {
            rows.push(Row::new("account:copy", "Copy phone sign-in link"));
            rows.push(Row::new("account:cancel", "Cancel sign-in"));
        }
        Phase::Confirm(email) => {
            // No account gets accepted merely because Enter was used on the preceding page.
            rows.push(Row::new("account:deny", "Cancel sign-in"));
            rows.push(Row::new("account:confirm", format!("Sign in as {email}")));
        }
        Phase::Completing => rows.push(Row::new("account:wait", "Finishing sign-in…")),
        Phase::Committed => {
            rows.push(Row::new("account:wait", "Signed in · connecting this computer…"));
        }
        Phase::Ready | Phase::Failed(_) => match &app.account.status {
            Status::SignedIn { .. } => {
                rows.push(Row::new("account:machines", "Connect a machine"));
                rows.push(Row::new("account:phone", "Add your phone"));
                rows.push(Row::new("account:models", "Models on your machines"));
            }
            _ => {
                rows.push(Row::new("account:google", "Continue with Google"));
                rows.push(Row::new("account:apple", "Continue with Apple"));
                rows.push(Row::new("account:qr", "Sign in with your phone"));
            }
        },
    }
    rows.push(Row::new("account:back", if matches!(app.account.status, Status::SignedIn { .. }) { "Back to workspace" } else { "Keep using locally" }));
    picker.set_rows(rows);
    picker.busy = matches!(app.account.phase, Phase::Starting | Phase::Completing | Phase::Committed).then(|| "waiting".into());
}

fn refill(app: &mut App) {
    let Some(Modal::Picker { kind: PickerKind::Account, mut picker }) = app.modal.take_if(|m| matches!(m, Modal::Picker { kind: PickerKind::Account, .. })) else { return };
    fill(app, &mut picker);
    app.modal = Some(Modal::Picker { kind: PickerKind::Account, picker });
}

pub fn preview(app: &App, _: &str) -> Vec<Line<'static>> {
    let mut lines = vec![Line::raw("Your workspace, across your devices"), Line::raw(""),
        Line::raw("Connect your computers and sync your workspace."),
        Line::raw("Use models running on another linked machine."),
        Line::raw("Follow your harnesses from your phone."), Line::raw("")];
    match &app.account.status {
        Status::SignedIn { email, offline } => {
            lines.push(Line::raw(email.as_ref().map(|e| format!("Signed in as {e}")).unwrap_or_else(|| "Signed in".into())));
            if *offline { lines.push(Line::raw("Account is offline. Local work is still available.")); }
        }
        _ => lines.push(Line::raw("Sign-in is optional. Work on this computer anytime.")),
    }
    lines.push(Line::raw(""));
    match &app.account.phase {
        Phase::Browser(_) => {
            lines.push(Line::raw("Finish signing in in your browser."));
            lines.push(Line::raw("Using SSH? Cancel and choose Sign in with your phone."));
        }
        Phase::Phone { expires, .. } => {
            lines.clear();
            lines.push(Line::raw("On your phone, open Harness → Settings → Sign in a computer."));
            lines.push(Line::raw(""));
            lines.push(Line::raw(format!("Expires in {}s", expires.saturating_duration_since(Instant::now()).as_secs())));
        }
        Phase::Confirm(email) => {
            lines.push(Line::raw(format!("Your phone approved {email}.")));
            lines.push(Line::raw("Choose that account here to finish."));
        }
        Phase::Failed(message) => lines.push(Line::raw(message.clone())),
        Phase::Starting => lines.push(Line::raw(app.account.waiting.clone().unwrap_or_else(|| "Opening sign-in…".into()))),
        _ => {}
    }
    lines
}

/// Account is a small explanation and a few actions, not a catalog to search. It keeps the
/// benefits visible at 80 columns; a phone code is drawn only when the complete code fits.
pub fn draw(buf: &mut Buffer, app: &App, body: Rect, picker: &mut Picker) -> Option<Position> {
    use crate::settings::{self, put};
    let c = settings::chrome();
    settings::backdrop(buf, body, c.backdrop);
    app.account.qr_drawn.set(None);
    picker.preview_area.set(None);
    picker.list_area.set(Rect::default());
    picker.screen_area.set(body);
    if body.width < 24 || body.height < 8 {
        put(buf, body.x, body.y, body.width, "Account · resize or Esc", c.base);
        return None;
    }
    let available = settings::area(body, settings::PanelSize::Large, 0);
    let phone = matches!(app.account.phase, Phase::Phone { .. });
    let (w, h) = (available.width.min(if phone { 108 } else { 76 }), available.height.min(if phone { 30 } else { 16 }));
    let r = Rect::new(body.x + (body.width - w) / 2, body.y + (body.height - h) / 2, w, h);
    settings::fill(buf, r, c.base);
    picker.screen_area.set(r);
    let (x, mut right) = (r.x + 2, r.right().saturating_sub(2));
    let mut needs_room = false;
    if let Phase::Phone { url, .. } = &app.account.phase {
        let cols = r.width.saturating_sub(39);
        let rows = r.height.saturating_sub(2);
        if let Some(modules) = crate::devices::qr_modules(url, cols, rows) {
            let qw = modules.len() as u16;
            let qh = qw.div_ceil(2);
            let at = crate::devices::draw_qr(buf, r.right() - qw - 1, r.y + (r.height - qh) / 2, &modules, false);
            right = at.x.saturating_sub(2);
            app.account.qr_drawn.set(Some(at));
        } else { needs_room = true; }
    }
    let width = right.saturating_sub(x);
    put(buf, x, r.y + 1, width, "Your Harness account", c.base.add_modifier(Modifier::BOLD));
    let mut lines = match &app.account.phase {
        Phase::Ready => match &app.account.status {
            Status::SignedIn { email, offline } => vec![Line::raw(email.clone().unwrap_or_else(|| "Signed in".into())),
                Line::raw(if *offline { "Account is offline. Local work is still available." } else { "Manage your connected computers, phone and models." })],
            _ => vec![Line::raw("Connect computers and sync your workspace."), Line::raw("Use models on a linked machine. Follow work from your phone."),
                Line::raw(""), Line::raw("Sign-in is optional. Keep working locally anytime.")],
        },
        Phase::Browser(_) => vec![Line::raw("Finish signing in in your browser."), Line::raw("Using SSH? Cancel and choose Sign in with your phone.")],
        Phase::Confirm(email) => vec![Line::raw(format!("Your phone approved {email}.")), Line::raw("Choose that account below to finish.")],
        Phase::Failed(message) => vec![Line::raw(message.clone())],
        Phase::Phone { .. } => preview(app, ""),
        Phase::Starting => vec![Line::raw(app.account.waiting.clone().unwrap_or_else(|| "Opening sign-in…".into()))],
        Phase::Completing => vec![Line::raw("Finishing sign-in. You can return to your workspace.")],
        Phase::Committed => vec![Line::raw("Signed in. Connecting this computer…")],
    };
    if needs_room { lines.extend([Line::raw(""), Line::raw("Enlarge the terminal to scan, or copy the phone sign-in link.")]); }
    // Actions always remain reachable, including in a short terminal. The explanation uses
    // the remaining rows and wraps; wheel/arrow navigation still works in a one-row list.
    let compact = r.height < 14;
    let bottom = r.bottom().saturating_sub(if compact { 2 } else { 3 });
    let count = picker.rows.len().min(bottom.saturating_sub(r.y + if compact { 3 } else { 4 }) as usize).max(1) as u16;
    let list_top = bottom.saturating_sub(count);
    let description_top = r.y + if compact { 2 } else { 3 };
    Paragraph::new(lines).style(c.muted).wrap(Wrap { trim: false })
        .render(Rect::new(x, description_top, width, list_top.saturating_sub(description_top + if compact { 0 } else { 1 })), buf);
    settings::list(buf, picker, Rect::new(x, list_top, width, count), &c, false);
    let hint = if picker.query.is_empty() { if compact { "↑↓ choose · Enter · Esc back".into() } else { "↑↓ choose   enter open   esc back".into() } } else { format!("Filter: {}", picker.query) };
    put(buf, x, r.bottom() - 2, width, &hint, c.muted);
    None
}

pub fn choose(app: &mut App, mut picker: Picker, id: &str) {
    // Reattach before callbacks update the view; every completion checks its own attempt.
    let action = id.strip_prefix("account:").unwrap_or("");
    if action == "back" { cancel(app); return }
    if matches!(action, "machines" | "phone" | "models") {
        crate::input::run(app, match action { "machines" => "connect-machine", "phone" => "add-phone", _ => "models" });
        return;
    }
    picker.set_query("");
    app.modal = Some(Modal::Picker { kind: PickerKind::Account, picker });
    match action {
        "google" | "apple" | "qr" => start(app, action),
        "cancel" | "deny" => { cancel(app); refill(app); }
        "confirm" => {
            if matches!(app.account.phase, Phase::Confirm(_)) {
                if let Some(tx) = &app.account.driver { let _ = tx.send(Driver::Answer(true)); }
                app.account.phase = Phase::Completing;
                app.account.waiting = Some("Finishing sign-in…".into());
                refill(app);
            }
        }
        "browser" => { if let Phase::Browser(url) = &app.account.phase { open_browser(app, url.clone()); } }
        "copy" => {
            let url = match &app.account.phase { Phase::Browser(url) | Phase::Phone { url, .. } => Some(url.clone()), _ => None };
            if let Some(url) = url { crate::devices::ask(app, Req::Copy(url), None, |_, _| {}); }
        }
        _ => {}
    }
}

fn cancel(app: &mut App) {
    if matches!(app.account.phase, Phase::Committed | Phase::Completing) { return }
    if let Some(driver) = app.account.driver.take() {
        let _ = driver.send(Driver::Cancel);
        app.account.generation += 1;
        app.account.phase = Phase::Ready;
        app.account.waiting = None;
    }
}

fn start(app: &mut App, method: &str) {
    if app.account.driver.is_some() || matches!(app.account.status, Status::SignedIn { .. }) { return }
    app.account.generation += 1;
    let generation = app.account.generation;
    let mut args = vec!["login".into(), "--json".into(), "--entry-point=tui".into(), format!("--{method}")];
    if app.account.status == Status::SignedOut { args.push("--force".into()); }
    let (driver, receive) = mpsc::unbounded_channel();
    app.account.driver = Some(driver);
    app.account.phase = Phase::Starting;
    app.account.waiting = None;
    refill(app);
    #[cfg(test)]
    { let _ = receive; app.account.started.push(args); }
    #[cfg(not(test))]
    {
        let sink = app.sink.clone();
        let exe = std::env::var("HARNESS_CLI").unwrap_or_else(|_| "harness".into());
        let script: Vec<String> = std::env::var("HARNESS_CLI_ARGS").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let mut command = tokio::process::Command::new(exe);
        command.args(script).args(args);
        tokio::spawn(drive(command, generation, sink, receive));
    }
    let _ = generation;
}

fn valid_url(url: &str) -> bool {
    // The CLI gets these links from SSO. They are never shell commands or local file URLs.
    url.starts_with("https://") && url.len() <= 8192 && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn open_browser(app: &mut App, url: String) {
    if !valid_url(&url) { return }
    #[cfg(test)]
    { let _ = (app, url); }
    #[cfg(not(test))]
    app.spawn(async move {
        let mut command = tokio::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" });
        command
            .arg(url).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        tokio::time::timeout(Duration::from_secs(10), command.status()).await.is_ok_and(|s| s.is_ok_and(|s| s.success()))
    }, |app, opened| {
        if !opened { if let Some(Modal::Picker { kind: PickerKind::Account, picker }) = &mut app.modal {
            picker.say("Could not open a browser. Copy the link, or use Sign in with your phone.");
        } }
    });
}

fn event(app: &mut App, generation: u64, value: Value) {
    if generation != app.account.generation || app.account.driver.is_none() { return }
    let success = value["type"] == "result" && value["status"] == "success";
    if !visible(app) && !success && !matches!(app.account.phase, Phase::Committed | Phase::Completing) { cancel(app); return }
    let clean = |k: &str| value[k].as_str().map(|s| s.chars().filter(|c| !c.is_control()).take(1024).collect::<String>()).unwrap_or_default();
    match value["type"].as_str() {
        Some("authorize_url") => if let Some(url) = value["url"].as_str().filter(|u| valid_url(u)) {
            app.account.phase = Phase::Browser(url.into());
            // Over SSH, a loopback browser callback cannot reach the server. Phone sign-in is
            // offered explicitly; never report a browser on the remote host as the user's.
            if std::env::var_os("SSH_CONNECTION").is_none() && std::env::var_os("SSH_TTY").is_none() { open_browser(app, url.into()); }
        },
        Some("qr") => if let Some(url) = value["url"].as_str().filter(|u| valid_url(u)) {
            let seconds = value["expiresIn"].as_u64().unwrap_or(120).clamp(1, 600);
            app.account.phase = Phase::Phone { url: url.into(), expires: Instant::now() + Duration::from_secs(seconds) };
        },
        Some("confirm") => {
            let email = clean("email");
            if !email.contains('@') { cancel(app); app.account.phase = Phase::Failed("The phone returned no valid account. Try signing in again.".into()); }
            else { app.account.phase = Phase::Confirm(email); }
        }
        Some("waiting") => app.account.waiting = Some(clean("message")),
        Some("result") if value["status"] == "success" => {
            let email = clean("email");
            app.account.status = Status::SignedIn { offline: false, email: (!email.is_empty()).then_some(email) };
            app.account.phase = Phase::Committed;
        }
        Some("result") => app.account.phase = Phase::Failed({ let text = clean("message"); if text.is_empty() { "Sign-in did not complete. Try again.".into() } else { text } }),
        _ => {}
    }
    refill(app);
    if matches!(app.account.phase, Phase::Confirm(_)) { if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.select("account:deny"); } }
}

fn finished(app: &mut App, generation: u64, committed: bool, error: Option<String>) {
    // Cancelling the view can race the browser's final approval. The CLI is allowed to finish
    // a committed identity write; read the actual result once it exits, without reopening UI.
    if generation != app.account.generation {
        if app.account.driver.is_none() {
            if committed { reconnect(app); }
            refresh(app, true);
        }
        return;
    }
    app.account.driver = None;
    if committed {
        app.account.phase = error.map(Phase::Failed).unwrap_or(Phase::Ready);
        // The CLI commits credentials and restarts its daemon before it exits.
        reconnect(app);
        refresh(app, true);
    } else if !matches!(app.account.phase, Phase::Failed(_)) {
        app.account.phase = Phase::Failed(error.unwrap_or_else(|| "Sign-in did not complete. Try again.".into()));
    }
    refill(app);
}

fn reconnect(app: &mut App) {
    #[cfg(not(test))]
    app.boot();
    #[cfg(test)]
    let _ = app;
}

async fn drive(mut command: tokio::process::Command, generation: u64, sink: mpsc::UnboundedSender<crate::event::Event>, mut commands: mpsc::UnboundedReceiver<Driver>) {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let emit = |value: Value| { let _ = sink.send(crate::event::Event::Apply(Box::new(move |app| event(app, generation, value)))); };
    let done = |committed: bool, error: Option<String>| { let _ = sink.send(crate::event::Event::Apply(Box::new(move |app| finished(app, generation, committed, error)))); };
    let child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn();
    let mut child = match child { Ok(child) => child, Err(_) => { done(false, Some("Could not run the Harness CLI. Check that harness is installed.".into())); return } };
    let mut input = child.stdin.take();
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let mut stderr = child.stderr.take().unwrap();
    let drain = tokio::spawn(async move { let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await; });
    let deadline = tokio::time::sleep(Duration::from_secs(6 * 60));
    tokio::pin!(deadline);
    let mut committed = false;
    let mut accepting = true;
    let mut cancelled = false;
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) if line.len() <= 65536 => {
                    if let Ok(value) = serde_json::from_str::<Value>(&line) {
                        if value["type"] == "result" && value["status"] == "success" { committed = true; }
                        emit(value);
                    }
                }
                Ok(Some(_)) => {},
                _ => break,
            },
            command = commands.recv(), if accepting => match command {
                Some(Driver::Answer(yes)) if !committed => if let Some(stdin) = &mut input { let _ = stdin.write_all(if yes { b"yes\n" } else { b"no\n" }).await; },
                Some(Driver::Cancel) | None => {
                    if committed { accepting = false; }
                    else {
                        // Closing the driver's stdin lets the CLI revoke a pending QR, yet
                        // finish if browser/phone approval has already committed. SIGTERM in
                        // that small interval would interrupt the session write or restart.
                        input.take();
                        cancelled = true;
                        accepting = false;
                        deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(120));
                    }
                }
                _ => {},
            },
            _ = &mut deadline => { cancelled = true; break; },
        }
    }
    input.take();
    let exited = match tokio::time::timeout(Duration::from_secs(if committed { 60 } else { 3 }), child.wait()).await {
        Ok(Ok(status)) => status.success(),
        Ok(Err(_)) => false,
        Err(_) => { let _ = child.kill().await; false },
    };
    drain.abort();
    let error = if committed && !exited {
        Some("Signed in, but this computer could not reconnect. Run harness start, then reopen Account.".into())
    } else if cancelled && !committed { Some("Sign-in was cancelled or timed out. You can keep working locally.".into()) }
    else { None };
    done(committed, error);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn app() -> App {
        let (sink, _) = mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (100, 30));
        app.account.status = Status::SignedOut;
        app
    }

    fn key(app: &mut App, code: KeyCode) {
        crate::input::handle(app, Event::Key(KeyEvent::new(code, KeyModifiers::NONE)));
    }

    fn select(app: &mut App, id: &str) {
        let Some(Modal::Picker { picker, .. }) = &mut app.modal else { panic!("account is not open") };
        picker.select(id);
        assert_eq!(picker.current_id().as_deref(), Some(id));
        key(app, KeyCode::Enter);
    }

    fn render(app: &mut App, width: u16, height: u16) -> (String, Buffer) {
        let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
        term.draw(|f| crate::ui::draw(f, app)).unwrap();
        let buf = term.backend().buffer().clone();
        let text = (0..height).map(|y| (0..width).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n");
        (text, buf)
    }

    #[test]
    fn local_use_and_opening_account_never_start_sign_in() {
        let mut app = app();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        app.devices.runner = Some(Box::new(move |req| {
            log.lock().unwrap().push(req.clone());
            Some(Reply::Cli { ok: true, out: "{\"loggedIn\":false}".into(), err: String::new() })
        }));
        tick(&mut app);
        assert_eq!(label(&app), "Sign in");
        assert!(app.account.started.is_empty());
        open(&mut app);
        let (text, _) = render(&mut app, 80, 24);
        for expected in ["Connect computers", "Sign-in is optional", "Keep using locally", "Continue with Google"] { assert!(text.contains(expected), "missing {expected}:\n{text}"); }
        select(&mut app, "account:back");
        tick(&mut app);
        assert!(app.modal.is_none());
        assert!(app.account.started.is_empty());
        assert!(seen.lock().unwrap().iter().all(|r| matches!(r, Req::Cli { args, .. } if args == &["auth", "status", "--json"])));
    }

    #[test]
    fn short_account_panels_keep_all_actions_and_a_clear_exit_visible() {
        let mut app = app();
        for signed_in in [false, true] {
            app.account.status = if signed_in { Status::SignedIn { email:Some("dev@example.test".into()), offline:false } } else { Status::SignedOut };
            crate::input::picker(&mut app, PickerKind::Account, "Your Harness account", "");
            let (text, _) = render(&mut app, 40, 12);
            for label in if signed_in { vec!["Connect a machine", "Add your phone", "Models on your machines", "Back to workspace"] }
                else { vec!["Continue with Google", "Continue with Apple", "Sign in with your phone", "Keep using locally"] } {
                assert!(text.contains(label), "{label}\n{text}");
            }
            assert!(text.contains("Esc back"));
            let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!() };
            assert!(picker.list_area.get().height >= 4);
        }
    }

    #[test]
    fn offline_and_failed_status_reads_do_not_offer_an_account_switch() {
        let mut app = app();
        app.devices.runner = Some(Box::new(|req| Some(match req {
            Req::Cli { .. } => Reply::Cli { ok: true, out: "{\"loggedIn\":true,\"offline\":true}".into(), err: String::new() },
            _ => Reply::Http(Err(("OFFLINE".into(), "no network".into()))),
        })));
        open(&mut app);
        assert_eq!(app.account.status, Status::SignedIn { offline: true, email: None });
        assert_eq!(label(&app), "Account");
        app.devices.runner = Some(Box::new(|_| Some(Reply::Cli { ok: false, out: String::new(), err: "timeout".into() })));
        refresh(&mut app, true);
        assert!(matches!(app.account.status, Status::SignedIn { offline: true, .. }));
        start(&mut app, "google");
        assert!(app.account.started.is_empty());
    }

    #[test]
    fn explicit_provider_choice_runs_once_and_cancellation_rejects_late_callbacks() {
        let mut app = app();
        open(&mut app);
        select(&mut app, "account:apple");
        start(&mut app, "google");
        assert_eq!(app.account.started, vec![vec!["login", "--json", "--entry-point=tui", "--apple", "--force"]]);
        let generation = app.account.generation;
        event(&mut app, generation, json!({ "type": "authorize_url", "url": "file:///do-not-open" }));
        assert_eq!(app.account.phase, Phase::Starting);
        event(&mut app, generation, json!({ "type": "authorize_url", "url": "https://sso.example.test/authorize" }));
        assert!(matches!(app.account.phase, Phase::Browser(_)));
        key(&mut app, KeyCode::Esc);
        tick(&mut app);
        assert!(app.account.driver.is_none());
        event(&mut app, generation, json!({ "type": "result", "status": "success", "email": "old@example.test" }));
        assert_eq!(app.account.status, Status::SignedOut);
        assert!(app.modal.is_none());
    }

    #[test]
    fn phone_approval_requires_an_explicit_account_choice_and_is_not_repeated() {
        let mut app = app();
        open(&mut app);
        select(&mut app, "account:qr");
        let generation = app.account.generation;
        event(&mut app, generation, json!({ "type": "confirm", "email": "dev@example.test" }));
        let (sender, mut receive) = mpsc::unbounded_channel();
        app.account.driver = Some(sender);
        key(&mut app, KeyCode::Enter);
        assert_eq!(receive.try_recv().unwrap(), Driver::Cancel, "Enter must not accept an account just arriving from a phone");
        select(&mut app, "account:qr");
        let generation = app.account.generation;
        event(&mut app, generation, json!({ "type": "confirm", "email": "dev@example.test" }));
        let (sender, mut receive) = mpsc::unbounded_channel();
        app.account.driver = Some(sender);
        select(&mut app, "account:confirm");
        assert_eq!(receive.try_recv().unwrap(), Driver::Answer(true));
        key(&mut app, KeyCode::Enter);
        key(&mut app, KeyCode::Esc);
        tick(&mut app);
        assert_eq!(app.account.phase, Phase::Completing);
        assert!(receive.try_recv().is_err(), "no duplicate approval or cancellation while committing");
        event(&mut app, generation, json!({ "type": "result", "status": "success", "email": "dev@example.test" }));
        assert!(matches!(app.account.status, Status::SignedIn { .. }));
        finished(&mut app, generation, true, None);
        assert!(app.account.driver.is_none());
        assert!(app.modal.is_none(), "completion must not reopen a dismissed panel");
    }

    #[test]
    fn phone_code_is_complete_or_omitted_and_expiry_keeps_local_work_available() {
        let mut app = app();
        open(&mut app);
        select(&mut app, "account:qr");
        let generation = app.account.generation;
        let url = "https://harness.autonomous.ai/sign-in?code=hnq_1234567890abcdefghijklmnopqrstuvwxyz";
        event(&mut app, generation, json!({ "type": "qr", "url": url, "expiresIn": 120 }));
        let (_, buf) = render(&mut app, 160, 44);
        let at = app.account.qr_drawn.get().expect("wide panel fits a complete QR");
        let scale = 6;
        let mut image = rqrr::PreparedImage::prepare_from_greyscale(at.width as usize * scale, at.height as usize * 2 * scale, |x, y| {
            let cell = buf[(at.x + (x / scale) as u16, at.y + (y / scale / 2) as u16)].symbol();
            let dark = cell == "█" || if (y / scale) % 2 == 0 { cell == "▀" } else { cell == "▄" };
            if dark { 0 } else { 255 }
        });
        let grids = image.detect_grids();
        assert_eq!(grids.len(), 1);
        assert_eq!(grids[0].decode().unwrap().1, url);
        let (text, _) = render(&mut app, 80, 24);
        assert!(app.account.qr_drawn.get().is_none());
        assert!(text.contains("copy the phone sign-in link"), "{text}");
        for (w, h) in [(45, 14), (24, 8), (1, 1)] { render(&mut app, w, h); }
        app.account.phase = Phase::Phone { url: url.into(), expires: Instant::now() - Duration::from_secs(1) };
        tick(&mut app);
        assert!(matches!(app.account.phase, Phase::Failed(_)));
        assert!(app.account.driver.is_none());
        assert_eq!(app.account.status, Status::SignedOut);
    }

    async fn apply_next(app: &mut App, receive: &mut mpsc::UnboundedReceiver<crate::event::Event>) {
        let event = tokio::time::timeout(Duration::from_secs(5), receive.recv()).await.unwrap().unwrap();
        if let crate::event::Event::Apply(f) = event { f(app); } else { panic!("unexpected event") }
    }

    #[tokio::test]
    async fn cli_driver_keeps_stdin_open_then_delivers_exact_phone_approval() {
        let mut app = app();
        open(&mut app);
        let (sink, mut events) = mpsc::unbounded_channel();
        let (sender, receive) = mpsc::unbounded_channel();
        app.account.driver = Some(sender.clone());
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", r#"printf '%s\n' '{"type":"confirm","email":"dev@example.test"}'; IFS= read -r answer; [ "$answer" = yes ] || exit 1; printf '%s\n' '{"type":"result","status":"success","email":"dev@example.test"}'"#]);
        let task = tokio::spawn(drive(command, app.account.generation, sink, receive));
        apply_next(&mut app, &mut events).await;
        assert!(matches!(app.account.phase, Phase::Confirm(_)));
        assert!(!task.is_finished(), "CLI must still be waiting for the user");
        sender.send(Driver::Answer(true)).unwrap();
        apply_next(&mut app, &mut events).await;
        assert_eq!(app.account.phase, Phase::Committed);
        apply_next(&mut app, &mut events).await;
        task.await.unwrap();
        assert_eq!(app.account.phase, Phase::Ready);
        assert!(matches!(app.account.status, Status::SignedIn { .. }));
    }

    #[tokio::test]
    async fn cancelling_the_driver_closes_stdin_so_cli_can_finish_its_own_cleanup() {
        let mut app = app();
        open(&mut app);
        let (sink, mut events) = mpsc::unbounded_channel();
        let (sender, receive) = mpsc::unbounded_channel();
        app.account.driver = Some(sender);
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", r#"printf '%s\n' '{"type":"waiting","message":"waiting for driver"}'; IFS= read -r answer; printf '%s\n' '{"type":"result","status":"error","message":"cleanup finished"}'"#]);
        let task = tokio::spawn(drive(command, app.account.generation, sink, receive));
        apply_next(&mut app, &mut events).await;
        app.account.driver.as_ref().unwrap().send(Driver::Cancel).unwrap();
        apply_next(&mut app, &mut events).await;
        assert_eq!(app.account.phase, Phase::Failed("cleanup finished".into()));
        apply_next(&mut app, &mut events).await;
        tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
        assert!(app.account.driver.is_none());
    }

    #[tokio::test]
    async fn a_failed_daemon_restart_keeps_the_account_and_explains_recovery() {
        let mut app = app();
        open(&mut app);
        let (sink, mut events) = mpsc::unbounded_channel();
        let (sender, receive) = mpsc::unbounded_channel();
        app.account.driver = Some(sender);
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", r#"printf '%s\n' '{"type":"result","status":"success","email":"dev@example.test"}'; exit 1"#]);
        let task = tokio::spawn(drive(command, app.account.generation, sink, receive));
        apply_next(&mut app, &mut events).await;
        apply_next(&mut app, &mut events).await;
        task.await.unwrap();
        assert!(matches!(app.account.status, Status::SignedIn { .. }));
        let (text, _) = render(&mut app, 80, 24);
        assert!(text.contains("could not reconnect") && text.contains("harness start"), "{text}");
        assert!(!text.contains("Continue with Google"));
        assert!(app.account.driver.is_none());
    }
}
