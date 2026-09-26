//! harness-tui — all of Harness in a terminal. A client of the same local daemon the desktop app
//! uses: every harness on every machine (relay + P2P live in the daemon), in tabs and panes that
//! are the account's desk, driven with tmux's keys.

mod app;
mod clipboard;
mod commands;
mod keys;
mod preview;
mod config;
mod daemon;
mod event;
mod fleet;
mod input;
mod layout;
mod modal;
mod pane;
mod picker;
mod proto;
mod theme;
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

fn usage() {
    println!("hn — Harness in your terminal\n");
    println!("  hn [--port N] [--keys]      (also: harness tui)\n");
    println!("  tmux's keys: C-b s harnesses · C-b c window · C-b % \" split · C-b o next pane · C-b z zoom");
    println!("  C-b [ copy · C-b w windows · C-b C new harness · C-b ? keys · C-b d detach");
    println!("  ~/.tmux.conf is read: your prefix and binds work here too.");
    println!("\n  HARNESS_TUI_DESK=read   show the desk's tabs but never change them");
    println!("  HARNESS_TUI_DESK=off    keep tabs to this window");
}

struct Restore { enhanced: bool }

impl Drop for Restore {
    fn drop(&mut self) {
        let mut out = io::stdout();
        if self.enhanced { let _ = execute!(out, PopKeyboardEnhancementFlags); }
        let _ = execute!(out, DisableMouseCapture, DisableBracketedPaste, DisableFocusChange, LeaveAlternateScreen, cursor::Show, cursor::SetCursorStyle::DefaultUserShape);
        let _ = terminal::disable_raw_mode();
    }
}

fn main() -> io::Result<()> {
    // Before any thread exists: the file may set environment switches.
    let config = config::load();
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
    if args.iter().any(|a| a == "-h" || a == "--help") { usage(); return Ok(()) }
    if args.iter().any(|a| a == "--version" || a == "-V") { println!("hn {}", env!("CARGO_PKG_VERSION")); return Ok(()) }
    if args.iter().any(|a| a == "--keys") {
        let mut km = keys::Keymap::tmux_defaults();
        let settings = tmuxconf::load(&mut km);
        if config.prefix_set { km.prefix = config.prefix }
        if let Some(p) = &settings.path { println!("read {}", p.display()) }
        println!("prefix {}\n", keys::name(&km.prefix));
        for b in &km.prefix_table { println!("bind-key {}{:<8} {}", if b.repeat { "-r " } else { "   " }, keys::name(&b.chord), b.command) }
        for b in &km.root_table { println!("bind-key -n {:<8} {}", keys::name(&b.chord), b.command) }
        for p in config.problems.iter().chain(settings.problems.iter()) { println!("\n  ! {p}") }
        return Ok(())
    }
    let port = args.iter().position(|a| a == "--port").and_then(|i| args.get(i + 1)).and_then(|p| p.parse().ok())
        .or_else(|| std::env::var("PORT").ok().and_then(|p| p.parse().ok()))
        .unwrap_or(18473u16);

    if !io::IsTerminal::is_terminal(&io::stdout()) { eprintln!("harness tui needs a terminal."); std::process::exit(1) }

    // NO_COLOR is about a program's own output; the panes mirror OTHER programs' screens, whose
    // colours are content. crossterm would otherwise drop every colour, theirs included.
    crossterm::style::force_color_output(true);
    terminal::enable_raw_mode()?;
    let mut out = io::stdout();
    execute!(out, EnterAlternateScreen, EnableMouseCapture, EnableBracketedPaste, EnableFocusChange, cursor::SetCursorStyle::SteadyBar)?;
    // The kitty keyboard protocol, where the terminal has it: ⌘ arrives as SUPER, and ^I is not Tab.
    // Pushed without asking first: the capability query waits for an answer that terminals without
    // the protocol never send (half a second of blank screen), and those terminals ignore the push.
    let enhanced = std::env::var("HARNESS_TUI_KITTY_KEYS").as_deref() != Ok("off")
        && execute!(out, PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)).is_ok();
    let restore = Restore { enhanced };
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let mut out = io::stdout();
        let _ = execute!(out, DisableMouseCapture, DisableBracketedPaste, LeaveAlternateScreen, cursor::Show);
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
    // tmux's defaults, then ~/.tmux.conf, then tui.toml: each one can change what the last set.
    let settings = tmuxconf::load(&mut app.keymap);
    if let Some(n) = settings.base_index { app.base_index = n }
    if let Some(n) = settings.pane_base_index { app.pane_base_index = n }
    if let Some(m) = settings.mouse { app.mouse = m }
    if let Some(t) = settings.status_top { app.status_top = t }
    if let Some(ms) = settings.display_ms { app.display_ms = ms.max(300) }
    if let Some(ms) = settings.display_panes_ms { app.display_panes_ms = ms }
    app.look = settings.look.clone();
    if config.prefix_set { app.keymap.prefix = config.prefix }
    for (chord, command) in &config.keys {
        match command { Some(c) => app.keymap.bind(keys::Table::Root, *chord, c.clone(), false), None => app.keymap.unbind(keys::Table::Root, chord) }
    }
    if let Some(problem) = config.problems.first().or(settings.problems.first()) { app.say(problem.clone(), theme::DANGER) }
    else if let Some(path) = &settings.path { app.say(format!("{} read — your prefix is {}", path.display().to_string().replace(&std::env::var("HOME").unwrap_or_default(), "~"), keys::name(&app.keymap.prefix)), theme::WARN) }
    app.boot();

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
        if app.quit { break }
        app.flush_acks();
        if refill && matches!(app.modal, Some(modal::Modal::Picker { .. })) { input::refill(&mut app) }
        if need_draw && last_draw.elapsed() >= frame_budget {
            let backend = term.backend_mut();
            queue!(backend, BeginSynchronizedUpdate)?;
            term.draw(|frame| ui::draw(frame, &mut app))?;
            execute!(term.backend_mut(), EndSynchronizedUpdate)?;
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
    let host = app.fleet.machine(&app.fleet.local_id).map(|m| m.name.clone()).unwrap_or_else(app::hostname);
    drop(term);
    drop(restore);
    // As tmux says it: the harnesses are still running, and `hn` comes back to them.
    println!("[detached (from session {host})]");
    Ok(())
}
