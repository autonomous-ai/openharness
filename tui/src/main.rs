//! harness-tui — all of Harness in a terminal. A client of the same local daemon the desktop app
//! uses: every harness on every machine (relay + P2P live in the daemon), in tabs and panes that
//! are the account's desk, driven with tmux's keys.

mod app;
mod capture;
mod borders;
mod cli;
mod clipboard;
mod cmd;
mod cmdparse;
mod commands;
mod ipc;
mod keys;
mod preview;
mod config;
mod copy;
mod daemon;
mod dial;
mod draw;
mod event;
mod fleet;
mod format;
mod fzf;
mod input;
mod layout;
mod modal;
mod mouse;
mod options;
mod paste;
mod pane;
mod picker;
mod proto;
mod theme;
mod tim;
mod tmuxconf;
mod ui;

use std::io::{self, BufWriter, Write};
use std::time::{Duration, Instant};

use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste, EnableFocusChange, EnableMouseCapture,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::terminal::{self, BeginSynchronizedUpdate, EndSynchronizedUpdate, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::{cursor, execute, queue};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;

use crate::event::Event;

/// A notification on the computer the person is at, through their terminal — OSC 9 (iTerm2,
/// WezTerm, Ghostty, kitty) and OSC 777 (foot, Ghostty, rxvt). Over SSH it still lands locally.
/// `HARNESS_TUI_NOTIFY=off` silences it.
pub fn notify(title: &str, body: &str) {
    if std::env::var("HARNESS_TUI_NOTIFY").as_deref() == Ok("off") { return }
    let clean = |t: &str| t.chars().filter(|c| !c.is_control() && *c != ';').collect::<String>();
    let (title, body) = (clean(title), clean(body));
    let mut out = io::stdout();
    let _ = write!(out, "\x1b]9;{title}: {body}\x07\x1b]777;notify;{title};{body}\x07");
    let _ = out.flush();
}

/// The terminal's own bell — a tab in the person's terminal app lights up when this one is behind.
pub fn bell() {
    let mut out = io::stdout();
    let _ = out.write_all(b"\x07");
    let _ = out.flush();
}

unsafe extern "C" { fn raise(sig: i32) -> i32; }
/// SIGTSTP, as a shell's job control expects of a program that suspends itself.
unsafe fn libc_raise_tstp() { unsafe { raise(if cfg!(target_os = "linux") { 20 } else { 18 }); } }

struct Restore { enhanced: bool }

impl Drop for Restore {
    fn drop(&mut self) {
        let mut out = io::stdout();
        if self.enhanced { let _ = execute!(out, PopKeyboardEnhancementFlags); }
        let _ = execute!(out, DisableMouseCapture, DisableBracketedPaste, DisableFocusChange, LeaveAlternateScreen, cursor::Show, cursor::SetCursorStyle::DefaultUserShape);
        let _ = terminal::disable_raw_mode();
    }
}

/// THIRD_PARTY_NOTICES.md (scripts/notices.py writes it from Cargo.lock), printed by `hn --licenses`.
const NOTICES: &str = include_str!("../THIRD_PARTY_NOTICES.md");

#[cfg(test)]
mod notices {
    /// A crate added to Cargo.lock without regenerating the notices (python3 scripts/notices.py).
    #[test]
    fn every_locked_crate_has_its_notice() {
        let lock = include_str!("../Cargo.lock");
        let mut missing = Vec::new();
        for block in lock.split("[[package]]").skip(1) {
            let field = |k: &str| block.lines().find_map(|l| l.strip_prefix(&format!("{k} = \"")).and_then(|v| v.strip_suffix('"')).map(str::to_string));
            let (Some(name), Some(version)) = (field("name"), field("version")) else { continue };
            if name == "harness-tui" { continue }
            if !super::NOTICES.contains(&format!("| {name} | {version} |")) { missing.push(format!("{name} {version}")) }
        }
        assert!(missing.is_empty(), "not in THIRD_PARTY_NOTICES.md (run python3 scripts/notices.py): {missing:?}");
        assert!(super::NOTICES.contains("Nicholas Marriott") && super::NOTICES.contains("Junegunn Choi"));
    }
}

fn main() -> io::Result<()> {
    // Before any thread exists: the file may set environment switches; and dates are written in
    // your locale's words, as tmux's are (it sets LC_TIME from the environment too).
    let config = config::load();
    // SAFETY: once, before any other thread, with a valid C string.
    unsafe { libc::setlocale(libc::LC_TIME, c"".as_ptr()); }
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?.block_on(run(config))
}

async fn run(config: config::Config) -> io::Result<()> {
    let started = Instant::now();
    let mark = |what: &str| {
        if let Ok(path) = std::env::var("HARNESS_TUI_DEBUG") {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) { let _ = writeln!(f, "{:>6.1}ms {what}", started.elapsed().as_secs_f64() * 1000.0); }
        }
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    // hn's command line, read as tmux reads its own.
    let f = match cli::flags(&args) {
        Ok(f) => f,
        Err(e) => { eprintln!("hn: {e}"); eprintln!("{}", cli::USAGE); std::process::exit(1) }
    };
    if f.long_help { println!("{}", cli::USAGE); return Ok(()) }
    // The notices of the code and crates hn is built from (THIRD_PARTY_NOTICES.md), which travel with it.
    if f.licenses { cli::out(NOTICES); return Ok(()) }
    if f.help { eprintln!("{}", cli::USAGE); std::process::exit(1) }
    // Run as `tmux` (hn's jobs' PATH): tmux's version, and no client started without a terminal.
    let as_tmux = std::env::var("HN_AS_TMUX").map(|v| v == "1").unwrap_or(false);
    if f.version && f.rest.is_empty() {
        if as_tmux { println!("tmux {}", tmuxconf::TMUX_VERSION) } else { println!("hn {} (tmux {})", env!("CARGO_PKG_VERSION"), tmuxconf::TMUX_VERSION) }
        return Ok(());
    }
    if as_tmux && f.rest.is_empty() { eprintln!("open terminal failed: not a terminal"); std::process::exit(1) }
    // -f file: that tmux.conf instead of ~/.tmux.conf (-f /dev/null: none).
    if let Some(c) = &f.config { unsafe { std::env::set_var("HARNESS_TUI_TMUX_CONF", if c == "/dev/null" { "off" } else { c.as_str() }) } }
    if f.keys {
        let mut km = keys::Keymap::tmux_defaults();
        let settings = tmuxconf::load(&mut km);
        if config.prefix_set { km.prefix = config.prefix }
        let mut text = String::new();
        if let Some(p) = &settings.path { text += &format!("read {}\n", p.display()) }
        text += &format!("prefix {}\n\n", keys::name(&km.prefix));
        for b in &km.prefix_table { text += &format!("bind-key {}{:<8} {}\n", if b.repeat { "-r " } else { "   " }, keys::name(&b.chord), b.command) }
        for b in &km.root_table { text += &format!("bind-key -n {:<8} {}\n", keys::name(&b.chord), b.command) }
        for p in config.problems.iter().chain(settings.problems.iter()) { text += &format!("\n  ! {p}\n") }
        for n in &settings.notes { text += &format!("  - {n}\n") }
        cli::out(&text);
        return Ok(())
    }
    let explicit = f.port.or_else(|| std::env::var("PORT").ok().and_then(|p| p.parse().ok()));
    let port = explicit.unwrap_or(18473u16);
    // hn <command>: answered from here (hn ls) or by the running client (a tmux command).
    if let Some(code) = cli::run(&f.rest, explicit, f.socket.as_deref(), f.name.as_deref()).await { std::process::exit(code) }
    // -L name, starting a client: its socket's name.
    if let Some(n) = &f.name { unsafe { std::env::set_var("HN_SOCKET_NAME", n) } }

    if !io::IsTerminal::is_terminal(&io::stdout()) { eprintln!("open terminal failed: not a terminal"); std::process::exit(1) }

    // NO_COLOR is about a program's own output; the panes mirror OTHER programs' screens, whose
    // colours are content. crossterm would otherwise drop every colour, theirs included.
    crossterm::style::force_color_output(true);
    terminal::enable_raw_mode()?;
    let mut out = io::stdout();
    execute!(out, EnterAlternateScreen, EnableMouseCapture, EnableBracketedPaste, EnableFocusChange)?;
    // The kitty keyboard protocol, where the terminal has it: ⌘ arrives as SUPER, and ^I is not Tab.
    // Pushed without asking first: the capability query waits for an answer that terminals without
    // the protocol never send (half a second of blank screen), and those terminals ignore the push.
    let enhanced = std::env::var("HARNESS_TUI_KITTY_KEYS").as_deref() != Ok("off")
        && execute!(out, PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)).is_ok();
    let restore = Restore { enhanced };
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let mut out = io::stdout();
        if enhanced { let _ = execute!(out, PopKeyboardEnhancementFlags); }
        let _ = execute!(out, DisableMouseCapture, DisableBracketedPaste, DisableFocusChange, LeaveAlternateScreen, cursor::Show, cursor::SetCursorStyle::DefaultUserShape);
        let _ = terminal::disable_raw_mode();
        default_hook(info);
    }));

    let backend = CrosstermBackend::new(BufWriter::with_capacity(256 * 1024, io::stdout()));
    let mut term = Terminal::new(backend)?;
    term.clear()?;
    let size = terminal::size()?;

    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    // Keys on their own thread: crossterm's reader blocks, and a keystroke must never wait on the loop.
    let keys = tx.clone();
    std::thread::spawn(move || loop {
        match crossterm::event::read() {
            Ok(event) => { if keys.send(Event::Input(event)).is_err() { break } }
            Err(_) => break,
        }
    });
    let ticks = tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        loop { interval.tick().await; if ticks.send(Event::Tick).is_err() { break } }
    });

    mark("terminal ready");
    let mut app = app::App::new(port, tx.clone(), size);
    // `hn <command>` from a shell comes in here.
    let socket = ipc::serve(tx.clone(), port);
    // tmux's defaults, then ~/.tmux.conf, then tui.toml: each one can change what the last set.
    // Mouse on (Shift-drag is still the terminal's own selection) unless tmux.conf says off.
    app.mouse = true;
    app.mouse_changed = true;
    // ~/.tmux.conf, read and run as tmux reads and runs it.
    app.update_environment();
    let read = commands::load_config(&mut app);
    app.config_files = read.clone();
    if config.prefix_set { app.keymap.prefix = config.prefix }
    for (chord, command) in &config.keys {
        match command { Some(c) => app.keymap.bind(keys::Table::Root, *chord, c.clone(), false), None => app.keymap.unbind(keys::Table::Root, chord) }
    }
    if let Some(problem) = config.problems.first() { app.say(problem.clone(), theme::DANGER) }
    else if let Some(path) = read.last() { if app.messages.is_empty() { app.say(format!("{} read — your prefix is {}", path.replace(&std::env::var("HOME").unwrap_or_default(), "~"), keys::name(&app.keymap.prefix)), theme::WARN) } }
    app.boot();
    // The client is attached: the hooks' first look, then client-attached.
    app.notify_changes();
    commands::notify(&mut app, "client-attached", None, None);

    let frame_budget = Duration::from_millis(6);
    let mut last_draw = Instant::now() - frame_budget;
    let mut need_draw = true;
    loop {
        // Wait for something — or for the frame we owe to come due.
        let wait = if need_draw { frame_budget.saturating_sub(last_draw.elapsed()) } else { Duration::from_secs(3600) };
        let first = tokio::select! {
            event = rx.recv() => event,
            _ = tokio::time::sleep(wait) => None,
        };
        let mut refill = false;
        let apply = |app: &mut app::App, event: Event, refill: &mut bool| {
            match event {
                Event::Input(input) => { input::handle(app, input); *refill = true }
                Event::Machine { machine_id, generation, event } => {
                    if !matches!(event, crate::event::MachineEvent::Terminal(_)) { *refill = true }
                    app.on_machine(machine_id, generation, event)
                }
                Event::Apply(f) => { f(app); *refill = true }
                Event::Tick => app.on_tick(),
            }
        };
        if let Some(event) = first { apply(&mut app, event, &mut refill); need_draw = true }
        // Everything else already waiting goes into the same frame.
        while let Ok(event) = rx.try_recv() { apply(&mut app, event, &mut refill); need_draw = true }
        // The event hooks for what that changed, then any waiting; a config's errors, once there
        // is a pane to show them in.
        app.notify_changes();
        commands::run_pending_hooks(&mut app);
        app.show_causes();
        if app.quit { break }
        if std::mem::take(&mut app.mouse_changed) {
            if app.mouse { execute!(term.backend_mut(), EnableMouseCapture)?; } else { execute!(term.backend_mut(), DisableMouseCapture)?; }
        }
        if std::mem::take(&mut app.suspend) {
            // C-z: give the shell its terminal back, stop, and pick up where we were on `fg`.
            if enhanced { execute!(term.backend_mut(), PopKeyboardEnhancementFlags)?; }
            execute!(term.backend_mut(), DisableMouseCapture, DisableBracketedPaste, DisableFocusChange, LeaveAlternateScreen, cursor::Show, cursor::SetCursorStyle::DefaultUserShape)?;
            terminal::disable_raw_mode()?;
            unsafe { libc_raise_tstp() };
            terminal::enable_raw_mode()?;
            execute!(term.backend_mut(), EnterAlternateScreen, EnableBracketedPaste, EnableFocusChange, terminal::Clear(terminal::ClearType::All))?;
            if enhanced { execute!(term.backend_mut(), PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES))?; }
            if app.mouse { execute!(term.backend_mut(), EnableMouseCapture)?; }
            app.cursor_shape.clear();
            // A fresh Terminal repaints everything (ratatui's clear() asks the terminal where its
            // cursor is, and the input reader would eat the answer).
            term = Terminal::new(CrosstermBackend::new(BufWriter::with_capacity(256 * 1024, io::stdout())))?;
            need_draw = true;
        }
        app.flush_acks();
        if refill && matches!(app.modal, Some(modal::Modal::Picker { .. })) { input::refill(&mut app) }
        if need_draw && last_draw.elapsed() >= frame_budget {
            let backend = term.backend_mut();
            queue!(backend, BeginSynchronizedUpdate)?;
            term.draw(|frame| ui::draw(frame, &mut app))?;
            execute!(term.backend_mut(), EndSynchronizedUpdate)?;
            // The focused program's cursor shape (vim's block and bar), passed through as tmux does.
            let shape = app.focused().filter(|_| app.modal.is_none()).and_then(|f| app.panes.get(&f)).map(|p| p.cursor_style()).unwrap_or(cursor::SetCursorStyle::DefaultUserShape);
            let code = format!("{shape:?}");
            if code != app.cursor_shape { execute!(term.backend_mut(), shape)?; app.cursor_shape = code }
            if !app.fleet.agents.is_empty() && !app.fleet_marked { app.fleet_marked = true; mark("first frame with harnesses") }
            if !app.first_frame { app.first_frame = true; mark("first frame") }
            last_draw = Instant::now();
            need_draw = false;
            let title = app.window_title();
            if title != app.title {
                execute!(term.backend_mut(), terminal::SetTitle(&title))?;
                app.title = title;
            }
        }
    }
    app.fleet.save_cache();
    if let Some(path) = &socket { let _ = std::fs::remove_file(path); }
    let host = app.fleet.machine(&app.fleet.local_id).map(|m| m.name.clone()).unwrap_or_else(app::hostname);
    drop(term);
    drop(restore);
    // As tmux says it: the harnesses are still running, and `hn` comes back to them — or the
    // last window went, and the session with it.
    if app.exited { println!("[exited]") } else { println!("[detached (from session {host})]") }
    Ok(())
}
