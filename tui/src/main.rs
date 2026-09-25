//! harness-tui — all of Harness in a terminal. A client of the same local daemon the desktop app
//! uses: every harness on every machine (relay + P2P live in the daemon), in tabs and panes that
//! are the account's desk, with the desktop's keys (⌘ read as ⌥).

mod app;
mod clipboard;
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

/// The terminal's own bell — a tab in the person's terminal app lights up when this one is behind.
pub fn bell() {
    let mut out = io::stdout();
    let _ = out.write_all(b"\x07");
    let _ = out.flush();
}

fn usage() {
    println!("harness-tui — Harness in your terminal\n");
    println!("  harness tui [--port N]\n");
    println!("  ⌥O open · ⌥P commands · ⌥N new · ⌥T tab · ⌥\\ ⌥- split · ⌥1-9 tabs · ⌥/ keys · ⌥Q quit");
    println!("  ⌥ is Option/Alt (⌘ works in kitty/Ghostty/WezTerm); ^Space then the key works everywhere.");
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

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") { usage(); return Ok(()) }
    if args.iter().any(|a| a == "--version" || a == "-V") { println!("harness-tui {}", env!("CARGO_PKG_VERSION")); return Ok(()) }
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
    let enhanced = terminal::supports_keyboard_enhancement().unwrap_or(false)
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

    let mut app = app::App::new(port, tx.clone(), size);
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
        let mut apply = |app: &mut app::App, event: Event, refill: &mut bool| {
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
            last_draw = Instant::now();
            need_draw = false;
        }
    }
    drop(term);
    drop(restore);
    Ok(())
}
