//! harness-tui — all of Harness in a terminal. A client of the same local daemon the desktop app
//! uses: every harness on every machine (relay + P2P live in the daemon), in tabs and panes that
//! are the account's desk, driven with tmux's keys.

mod activity;
mod app;
mod capture;
mod tree;
mod borders;
mod cli;
mod clipboard;
mod cmd;
mod cmdparse;
mod commands;
mod ids;
mod history;
mod mirror;
mod server;
mod settings;
mod ipc;
mod keys;
mod preview;
mod config;
mod copy;
mod daemon;
mod devices;
mod dial;
mod draw;
mod event;
mod fleet;
mod format;
mod fzf;
mod terminal_themes;
mod input;
mod layout;
mod desk_layout;
mod local;
mod modal;
mod new_harness;
mod mouse;
mod options;
mod paste;
mod pane;
mod pane_frame;
mod picker;
mod proto;
mod theme;
mod term_out;
mod term_input;
mod tmuxconf;
mod ui;
mod verify;
mod viewer;
// ── status bar ──
mod bar;
mod bar_more;
// ── models: the Models view (step 6) ──
mod models;

use std::io::{self, BufWriter, Write};
use std::time::{Duration, Instant};

use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste, EnableFocusChange,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::{cursor, execute};
use ratatui::Terminal;
use tokio::sync::mpsc;

use crate::event::Event;

/// A notification on the computer the person is at, through their terminal: OSC 777 where it is
/// the terminal's (foot, rxvt, VTE's), else OSC 9 (iTerm2, WezTerm, Ghostty, kitty) — one, as a
/// terminal that reads both would show two. Over SSH it still lands locally.
/// `HARNESS_TUI_NOTIFY=off` silences it.
pub fn notify(title: &str, body: &str) {
    if std::env::var("HARNESS_TUI_NOTIFY").as_deref() == Ok("off") { return }
    let clean = |t: &str| t.chars().filter(|c| !c.is_control() && *c != ';').collect::<String>();
    let (title, body) = (clean(title), clean(body));
    let term = std::env::var("TERM").unwrap_or_default();
    let seven = std::env::var_os("VTE_VERSION").is_some() || term.starts_with("foot") || term.starts_with("rxvt");
    let mut out = io::stdout();
    let _ = if seven { write!(out, "\x1b]777;notify;{title};{body}\x07") } else { write!(out, "\x1b]9;{title}: {body}\x07") };
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

/// The terminal's title saved on its stack as tmux saves it at attach (XTWINOPS 22), and given
/// back when hn leaves (23): the shell's own title returns.
const TITLE_PUSH: &str = "\x1b[22;0;0t";
const TITLE_POP: &str = "\x1b[23;0;0t";

struct Restore { enhanced: bool }

impl Drop for Restore {
    fn drop(&mut self) {
        let mut out = io::stdout();
        if self.enhanced { let _ = execute!(out, PopKeyboardEnhancementFlags); }
        let _ = execute!(out, DisableMouseCapture, DisableBracketedPaste, DisableFocusChange, LeaveAlternateScreen, cursor::Show, cursor::SetCursorStyle::DefaultUserShape, crossterm::style::Print(TITLE_POP));
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
    // A terminal hn cannot use: tmux's words for it, not a program's error dump.
    if let Err(e) = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?.block_on(run(config)) {
        let _ = crossterm::terminal::disable_raw_mode();
        eprintln!("open terminal failed: {e}");
        std::process::exit(1);
    }
    Ok(())
}

/// hn with no terminal (--headless): tmux's server when no client is attached. It keeps the
/// sessions a script makes (`hn new -d -s proj; hn new-window -t proj:1; hn send-keys …`) and
/// answers every command, until a client attaches to them (each one taken as it is) — or there
/// are none left, and it goes, as tmux's server exits with its last session.
async fn run_headless(config: config::Config, port: u16) -> io::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    let ticks = tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        loop { interval.tick().await; if ticks.send(Event::Tick).is_err() { break } }
    });
    // tmux's default-size. Ids from this server name's counters (every client's unique).
    ids::use_file(&app::sessions_path(None));
    let mut app = app::App::new(port, tx.clone(), (80, 24));
    app.first_session();
    app.headless = true;
    app.terminal_focused = false;
    let Some(socket) = ipc::serve(tx.clone(), port) else { return Ok(()) };
    if let Some(here) = ipc::here() { ipc::mark_headless(&here) }
    let read = commands::load_config(&mut app);
    app.cfg_finished = true;
    app.config_files = read;
    if config.prefix_set { app.keymap.prefix = config.prefix }
    if config.prefix2.is_some() { app.keymap.prefix2 = config.prefix2 }
    app.apply_look(config.look.as_ref());
    // The server's options, keys, buffers and environment: this client's if it is the first.
    server::join(&mut app);
    // When each harness was last looked at (seen.json): what finished while no one looked is
    // done, as a terminal says it.
    app.load_seen();
    app.boot();
    app.load_sessions();
    app.update_environment();
    app.notify_changes();
    let busy = Instant::now();
    loop {
        let first = tokio::select! {
            event = rx.recv() => event,
            _ = tokio::time::sleep(Duration::from_millis(500)) => None,
        };
        let apply = |app: &mut app::App, event: Event| match event {
            Event::Input(_) => {}
            Event::Machine { machine_id, generation, event } => app.on_machine(machine_id, generation, event),
            Event::Apply(f) => f(app),
            Event::Tick => app.on_tick(),
        };
        if let Some(event) = first { apply(&mut app, event) }
        while let Ok(event) = rx.try_recv() { apply(&mut app, event) }
        app.notify_changes();
        app.sync_links();
        app.save_if_changed();
        server::publish(&mut app);
        commands::run_pending_hooks(&mut app);
        app.flush_acks();
        if app.quit { break }
        // No session of its own left (or none came): gone, as tmux's server goes.
        // (What its own work brings back — a harness's lines — is not a reason to stay.)
        // (Harness hooks set: it stays to run them, as tmux's server runs hooks with no client.)
        // (exit-empty off: it stays with none, as tmux's server does.)
        if !app.holds_sessions() && !app.harness_hooks() && app.options.get("exit-empty", "", None).as_deref() != Some("off") && app.cli_held.is_empty() && busy.elapsed() > Duration::from_secs(2) && app.last_cli.elapsed() > Duration::from_secs(2) { break }
    }
    if app.forget_sessions { local::stop().await; }
    format::kill_jobs(&app);
    // (What its last hooks changed — a session-closed hook's option — reaches the others.)
    app.server_dirty = true;
    server::publish(&mut app);
    history::save(&app);
    app.fleet.save_cache();
    app.write_sessions(app::Save::Leave);
    mirror::tell_mirrors_now(&app);
    if let Some(here) = ipc::here() { let _ = std::fs::remove_file(here.with_extension("headless")); }
    ipc::gone(&socket);
    // (hn with no terminal going leaves the server's say as it was.)
    ids::leave(None);
    Ok(())
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
    let mut f = match cli::flags(&args) {
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
        if config.prefix2.is_some() { km.prefix2 = config.prefix2 }
        let mut text = String::new();
        for p in &settings.paths { text += &format!("read {}\n", p.display()) }
        text += &format!("prefix {}\n\n", keys::name(&km.prefix));
        for b in &km.prefix_table { text += &format!("bind-key {}{:<8} {}\n", if b.repeat { "-r " } else { "   " }, keys::name(&b.chord), b.command) }
        for b in &km.root_table { text += &format!("bind-key -n {:<8} {}\n", keys::name(&b.chord), b.command) }
        for p in config.problems.iter().chain(settings.problems.iter()) { text += &format!("\n  ! {p}\n") }
        for n in &settings.notes { text += &format!("  - {n}\n") }
        cli::out(&text);
        return Ok(())
    }
    // -C: tmux's control mode (iTerm2's -CC), which hn does not have.
    if f.control { eprintln!("hn: control mode (-C) is not supported"); std::process::exit(1) }
    // -c: the command run by the default shell, as tmux does when it is a login shell.
    if let Some(c) = &f.shell_command {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        let status = std::process::Command::new(shell).arg("-c").arg(c).status();
        std::process::exit(status.ok().and_then(|s| s.code()).unwrap_or(1))
    }
    // $PORT (as the daemon reads it): set but not a port is an error — never the default
    // daemon's port in its place, which is someone's real one.
    let from_env = match std::env::var("PORT") {
        Ok(p) => match p.trim().parse::<u16>() { Ok(n) if n > 0 => Some(n), _ => { eprintln!("hn: PORT is not a port number: '{p}'"); std::process::exit(1) } },
        Err(_) => None,
    };
    let explicit = f.port.or(from_env);
    let port = explicit.unwrap_or(18473u16);
    if f.local_server {
        if let Some(n) = &f.name { unsafe { std::env::set_var("HN_SOCKET_NAME", n) } }
        return local::run(port).await;
    }
    // tmux's server with no client attached: sessions held for a script's commands.
    if f.headless {
        if let Some(n) = &f.name { unsafe { std::env::set_var("HN_SOCKET_NAME", n) } }
        return run_headless(config, port).await;
    }
    // `hn new -d -s w … \; split-window -t w \; attach -t w`: the commands before the one that
    // attaches run as a shell's (the first to fail ends the line, as tmux's queue does), then
    // this client starts with that one and the rest.
    let attaches = |ws: &[String]| ws.first().and_then(|c| crate::cmd::find(c).ok()).map(|e| e.name == "attach-session" || (e.name == "new-session" && !crate::cmd::parse(e, ws).map(|a| a.has('d') > 0).unwrap_or(false))).unwrap_or(false);
    let starts: Vec<usize> = std::iter::once(0).chain(f.rest.iter().enumerate().filter(|(_, w)| w.as_str() == ";").map(|(i, _)| i + 1)).collect();
    if starts.len() > 1 && !attaches(&f.rest) {
        let end = |k: usize| starts.get(k + 1).map(|s| s - 1).unwrap_or(f.rest.len());
        if let Some(k) = (1..starts.len()).find(|&k| attaches(&f.rest[starts[k]..end(k)])) {
            let before = f.rest[..starts[k] - 1].to_vec();
            match cli::run(&before, explicit, f.socket.as_deref(), f.name.as_deref()).await { Some(0) | None => {}, Some(code) => std::process::exit(code) }
            f.rest = f.rest[starts[k]..].to_vec();
        }
    }
    // `hn <command>` where the command is an in-TUI one (theme, palette, layout…): tmux's CLI
    // would answer "unknown command", because these are not tmux commands. The client starts and
    // runs it itself, once the launcher is up — as `;`'s chain is (`start_then`). A word the
    // server answers too (take, new, send…) stays the server's.
    let gui = !f.rest.is_empty() && f.rest.iter().all(|w| crate::input::is_command(w) && !crate::commands::is_command_name(w));
    // hn <command>: answered from here (hn ls) or by the running client (a tmux command).
    if !gui { if let Some(code) = cli::run(&f.rest, explicit, f.socket.as_deref(), f.name.as_deref()).await { std::process::exit(code) } }
    // -L name, starting a client: its socket's name.
    if let Some(n) = &f.name { unsafe { std::env::set_var("HN_SOCKET_NAME", n) } }
    // hn new -s work / hn attach -t work: the session this client starts in.
    // `hn new … \; split-window …`: the command that starts this client, then the chain after it
    // (run in the client once its session is there, as tmux runs the rest of the command line).
    let cut = if gui { 0 } else { f.rest.iter().position(|w| w == ";").unwrap_or(f.rest.len()) };
    let then: Vec<String> = if gui { f.rest.clone() } else { f.rest.get(cut + 1..).map(|r| r.to_vec()).unwrap_or_default() };
    let start = if gui { None } else { cli::start_session(&f.rest[..cut]) };

    // attach with nothing to attach to (no client, no session kept; the desk's is always there):
    // tmux's words, before it would look for a terminal — `hn attach || hn new` makes one.
    let deskless = std::env::var("HARNESS_TUI_DESK").as_deref() == Ok("off");
    let attaching = f.rest.first().and_then(|c| cmd::find(c).ok()).map(|e| e.name == "attach-session").unwrap_or(false);
    if attaching && deskless && !ipc::alive(f.socket.as_deref(), f.name.as_deref()) && !cli::has_sessions(f.name.as_deref()) { eprintln!("no sessions"); std::process::exit(1) }
    // attach -t for a session there is none of: tmux finds the target before it wants a terminal.
    if attaching && !io::IsTerminal::is_terminal(&io::stdout()) {
        if let Some(t) = start.as_ref().and_then(|s| s.name.clone()) {
            let found = if ipc::alive(f.socket.as_deref(), f.name.as_deref()) {
                ipc::call(&["has-session".into(), "-t".into(), t.clone()], f.socket.as_deref(), f.name.as_deref()).await == 0
            } else { cli::has_session_named(f.name.as_deref(), &t) };
            if !found { if !ipc::alive(f.socket.as_deref(), f.name.as_deref()) { eprintln!("can't find session: {t}") } std::process::exit(1) }
        }
    }
    // Refuse to start a client from inside an existing multiplexer session —
    // as tmux itself does. Without this, `hn` (and `harness tui`, which wraps
    // `hn`) opened inside a pane stacks a whole TUI on top of the parent's
    // screen; when the parent multiplexer is hn, the recursion keeps going
    // until the process tree gives up, and when it's a real tmux (for
    // instance, the tmux backend that Harness Desktop uses to host its
    // terminals), the pane borders and status bars overlap into a cascade
    // that reads as an infinite loop to the user.
    //
    // Follow tmux's own rule: any $TMUX at all is a nested-client signal.
    // The message and the escape hatch stay tmux's exact wording so muscle
    // memory carries over: `TMUX= hn` (or `unset TMUX; hn`) bypasses when the
    // caller truly wants a nested client, matching tmux's `unset $TMUX to
    // force`.
    if std::env::var("TMUX").ok().filter(|t| !t.is_empty()).is_some() {
        eprintln!("sessions should be nested with care, unset $TMUX to force");
        std::process::exit(1);
    }
    if !io::IsTerminal::is_terminal(&io::stdout()) { eprintln!("open terminal failed: not a terminal"); std::process::exit(1) }
    // A terminal that cannot clear its screen (dumb, or none named) is refused as tmux refuses it.
    // (A name hn does not know is used anyway: it writes what every terminal since xterm reads.)
    if matches!(std::env::var("TERM").as_deref(), Err(_) | Ok("") | Ok("dumb")) { eprintln!("open terminal failed: terminal does not support clear"); std::process::exit(1) }

    // NO_COLOR is about a program's own output; the panes mirror OTHER programs' screens, whose
    // colours are content. crossterm would otherwise drop every colour, theirs included.
    crossterm::style::force_color_output(true);
    terminal::enable_raw_mode()?;
    // What the terminal is (XDA), as tmux asks it: its colours and features by its own word.
    if std::env::var("HARNESS_TUI_ASK_TERMINAL").as_deref() != Ok("off") { term_out::ask_terminal() }
    let mut out = io::stdout();
    execute!(out, crossterm::style::Print(TITLE_PUSH), EnterAlternateScreen, term_out::Mouse(1), EnableBracketedPaste, EnableFocusChange)?;
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
        let _ = execute!(out, DisableMouseCapture, DisableBracketedPaste, DisableFocusChange, LeaveAlternateScreen, cursor::Show, cursor::SetCursorStyle::DefaultUserShape, crossterm::style::Print(TITLE_POP));
        let _ = terminal::disable_raw_mode();
        default_hook(info);
    }));

    let backend = term_out::TmuxBackend::new(BufWriter::with_capacity(256 * 1024, term_out::Counted(io::stdout())));
    let mut term = Terminal::new(backend)?;
    // HARNESS_TUI_VERIFY: each frame's bytes replayed and compared with the frame (verify.rs).
    let mut verifier = verify::Verifier::from_env();
    if verifier.is_some() { verify::listen_for_dump() }
    // Whether some pane was selecting last frame (a selection starting is when a ghost is seen).
    let mut was_selecting = false;
    term.clear()?;
    let size = terminal::size()?;

    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    // Keys on their own thread: crossterm's reader blocks, and a keystroke must never wait on the loop.
    let keys = tx.clone();
    std::thread::spawn(move || term_input::read(keys));
    let resize = tx.clone();
    tokio::spawn(async move {
        let Ok(mut changes) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change()) else { return };
        while changes.recv().await.is_some() {
            if let Ok((cols, rows)) = terminal::size() { if resize.send(Event::Input(crossterm::event::Event::Resize(cols, rows))).is_err() { break } }
        }
    });
    let ticks = tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        loop { interval.tick().await; if ticks.send(Event::Tick).is_err() { break } }
    });

    mark("terminal ready");
    // Its ids ($N @N %N) from this server name's counters: unique among its clients.
    ids::use_file(&app::sessions_path(None));
    let mut app = app::App::new(port, tx.clone(), size);
    app.first_session();
    // `hn <command>` from a shell comes in here.
    let socket = ipc::serve(tx.clone(), port);
    // (A client with a terminal: never marked as one without, whatever a crash left; attached
    // now is used now.)
    if let Some(here) = ipc::here() { let _ = std::fs::remove_file(here.with_extension("headless")); }
    ipc::mark_active();
    // tmux's defaults, then ~/.tmux.conf, then tui.toml: each one can change what the last set.
    // Mouse on (Shift-drag is still the terminal's own selection) unless tmux.conf says off.
    app.mouse = true;
    app.mouse_changed = true;
    // ~/.tmux.conf, read and run as tmux reads and runs it.
    let read = commands::load_config(&mut app);
    app.cfg_finished = true;
    app.config_files = read.clone();
    if config.prefix_set { app.keymap.prefix = config.prefix }
    if config.prefix2.is_some() { app.keymap.prefix2 = config.prefix2 }
    app.apply_look(config.look.as_ref());
    for (chord, command) in &config.keys {
        match command { Some(c) => app.keymap.bind(keys::Table::Root, *chord, c.clone(), false), None => app.keymap.unbind(keys::Table::Root, chord) }
    }
    for (chord, command) in &config.prefix_keys {
        match command { Some(c) => app.keymap.bind(keys::Table::Prefix, *chord, c.clone(), false), None => app.keymap.unbind(keys::Table::Prefix, chord) }
    }
    // The server's options, keys, buffers and environment: this client's if it is the first
    // (tmux reads its configuration once, when its server starts).
    server::join(&mut app);
    if let Some(problem) = config.problems.first() { app.say(problem.clone(), theme::DANGER) }
    else if let Some(path) = read.last() { if app.messages.is_empty() { app.say(format!("{} read — your prefix is {}", path.replace(&std::env::var("HOME").unwrap_or_default(), "~"), keys::name(&app.keymap.prefix)), theme::WARN) } }
    // Inside a tmux client whose prefix is hn's too: tmux takes it first, and its send-prefix
    // passes the second on.
    if let Some(socket) = std::env::var("TMUX").ok().filter(|v| !v.is_empty() && std::env::var("HN_SOCKET").is_err()).and_then(|v| v.split(',').next().map(str::to_string)) {
        let p = keys::name(&app.keymap.prefix);
        let outer = std::process::Command::new("tmux").args(["-S", &socket, "show", "-gv", "prefix"]).stderr(std::process::Stdio::null()).output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        if outer == p {
            app.say(format!("Inside tmux: {p} is tmux's — {p} {p} reaches hn (or give hn another prefix)"), theme::WARN);
            app.toast_hold = Some(6000);
        }
    }
    // When you last looked at each harness (what finished while hn was closed shows as done).
    app.load_seen();
    app.boot();
    // The sessions a client left (C-b d), and the one asked for; attach's client flags.
    app.client_flags = start.as_ref().map(|s| s.flags.clone()).unwrap_or_default();
    app.start_session = start;
    app.start_then = then;
    app.load_sessions();
    // The client is attached to it now (server_client_set_session).
    app.session_last_attached = app::epoch_secs();
    // update-environment (as tmux.conf set it): this client's variables into its session's.
    app.update_environment();
    // The client is attached: the hooks' first look, then as tmux's attach says it —
    // client-session-changed, client-attached, client-resized.
    app.notify_changes();
    commands::notify(&mut app, "client-session-changed", None, None);
    commands::notify(&mut app, "client-attached", None, None);
    commands::notify(&mut app, "client-resized", None, None);

    let frame_budget = Duration::from_millis(6);
    let mut last_draw = Instant::now() - frame_budget;
    let mut need_draw = true;
    // Rendered animation and timed UI messages schedule their next frame.
    // Maintenance and incoming input/output keep their own cadence.
    let mut next_repaint: Option<Instant> = None;
    let mut mouse_all = false;
    let mut cursor_colour: Option<String> = None;
    let mut startup_input = std::collections::VecDeque::new();
    let mut input_ready = app.focused().is_some();
    loop {
        // Wait for something — or for the frame we owe to come due.
        let wait = if need_draw { frame_budget.saturating_sub(last_draw.elapsed()) } else { Duration::from_secs(3600) };
        let wait = next_repaint.map(|at| wait.min(at.saturating_duration_since(Instant::now()))).unwrap_or(wait);
        // The wheel at rest: wake for the whole-screen repaint it owes.
        let wait = app::scroll_settle_in(app.scrolled_at, Instant::now()).map(|d| wait.min(d)).unwrap_or(wait);
        let first = tokio::select! {
            event = rx.recv() => event,
            _ = tokio::time::sleep(wait) => None,
        };
        if next_repaint.is_some_and(|at| Instant::now() >= at) {
            next_repaint = None;
            need_draw = true;
        }
        let mut refill = false;
        let apply = |app: &mut app::App, event: Event, refill: &mut bool, startup: &mut std::collections::VecDeque<crossterm::event::Event>| {
            match event {
                Event::Input(input) => {
                    // Input can arrive before the first shell has even been requested. Keep
                    // its decoded events until that pane exists, including bracketed paste.
                    if !input_ready && matches!(input, crossterm::event::Event::Key(_) | crossterm::event::Event::Paste(_)) { startup.push_back(input); }
                    else { input::handle(app, input); *refill = true }
                }
                Event::Machine { machine_id, generation, event } => {
                    if !matches!(event, crate::event::MachineEvent::Terminal(_)) { *refill = true }
                    app.on_machine(machine_id, generation, event)
                }
                Event::Apply(f) => { f(app); *refill = true }
                Event::Tick => app.on_tick(),
            }
        };
        if let Some(event) = first { apply(&mut app, event, &mut refill, &mut startup_input); need_draw = true }
        // Everything else already waiting goes into the same frame.
        while let Ok(event) = rx.try_recv() { apply(&mut app, event, &mut refill, &mut startup_input); need_draw = true }
        if !input_ready && (app.focused().is_some() || app.tab().home || app.shell_asked && app.starting_shell.is_none()) {
            input_ready = true;
            while let Some(event) = startup_input.pop_front() { input::handle(&mut app, event); refill = true; }
        }
        // The event hooks for what that changed, then any waiting; a config's errors, once there
        // is a pane to show them in.
        app.notify_changes();
        // What another terminal's client sees of this one's sessions, kept up to date.
        app.sync_links();
        app.save_if_changed();
        server::publish(&mut app);
        commands::run_pending_hooks(&mut app);
        app.show_causes();
        app.mark_seen();
        if app.quit { break }
        if std::mem::take(&mut app.mouse_changed) {
            execute!(term.backend_mut(), term_out::Mouse(app.mouse as u8))?;
            mouse_all = false;
        }
        if std::mem::take(&mut app.suspend) {
            // C-z: give the shell its terminal back, stop, and pick up where we were on `fg`.
            if enhanced { execute!(term.backend_mut(), PopKeyboardEnhancementFlags)?; }
            if cursor_colour.take().is_some() { execute!(term.backend_mut(), crossterm::style::Print("\x1b]112\x07"))?; }
            execute!(term.backend_mut(), DisableMouseCapture, DisableBracketedPaste, DisableFocusChange, LeaveAlternateScreen, cursor::Show, cursor::SetCursorStyle::DefaultUserShape, crossterm::style::Print(TITLE_POP))?;
            terminal::disable_raw_mode()?;
            unsafe { libc_raise_tstp() };
            terminal::enable_raw_mode()?;
            app.title.clear();
            execute!(term.backend_mut(), crossterm::style::Print(TITLE_PUSH), EnterAlternateScreen, EnableBracketedPaste, EnableFocusChange, terminal::Clear(terminal::ClearType::All))?;
            if enhanced { execute!(term.backend_mut(), PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES))?; }
            if app.mouse { execute!(term.backend_mut(), term_out::Mouse(1))?; }
            mouse_all = false;
            app.cursor_shape.clear();
            // A fresh Terminal repaints everything (ratatui's clear() asks the terminal where its
            // cursor is, and the input reader would eat the answer).
            term = Terminal::new(term_out::TmuxBackend::new(BufWriter::with_capacity(256 * 1024, term_out::Counted(io::stdout()))))?;
            if let Some(v) = verifier.as_mut() { v.reset() }
            need_draw = true;
        }
        // Every motion asked for only while something wants it.
        let all = app.mouse && app.wants_motion();
        if all != mouse_all { execute!(term.backend_mut(), term_out::Mouse(if all { 2 } else { 1 }))?; mouse_all = all }
        app.flush_acks();
        // Welcome forms also need connection and catalog updates, including drafts in
        // background windows. Refill leaves unrelated overlays alone.
        if refill { input::refill(&mut app) }
        // A scroll that has rested: every row of the screen written again, once — row by row over
        // what is there, not after erasing it, so it never flashes.
        let settle = app::scroll_settle_in(app.scrolled_at, Instant::now()) == Some(Duration::ZERO);
        if settle { app.scrolled_at = None }
        if std::mem::take(&mut app.redraw_all) { term.clear()?; need_draw = true; }
        else if settle { term.backend_mut().soft_clear_next(); term.clear()?; need_draw = true; }
        if need_draw && last_draw.elapsed() >= frame_budget {
            // (The backend makes each frame's changes one synchronized update, and writes nothing
            // for a frame that changed nothing.)
            let frame_started = Instant::now();
            if let Some(v) = verifier.as_mut() {
                let selecting = app.panes.values().any(|p| p.copy_top());
                if selecting && !was_selecting { v.dump_now("a selection started") }
                if verify::dump_asked() { v.dump_now("SIGUSR2") }
                was_selecting = selecting;
            }
            let done = term.draw(|frame| ui::draw(frame, &mut app))?;
            if let Some(v) = verifier.as_mut() { v.check(done.buffer) }
            // The focused program's cursor shape (vim's block and bar), passed through as tmux does.
            let shape = app.focused().filter(|_| app.modal.is_none()).and_then(|f| app.panes.get(&f)).map(|p| p.cursor_style()).unwrap_or(cursor::SetCursorStyle::DefaultUserShape);
            let code = format!("{shape:?}");
            if code != app.cursor_shape { execute!(term.backend_mut(), shape)?; app.cursor_shape = code }
            // Its cursor colour (OSC 12) too, and the terminal's own back (OSC 112) when it has none.
            let colour = app.focused().filter(|_| app.modal.is_none()).and_then(|f| app.panes.get(&f)).and_then(|p| p.cursor_colour());
            if colour != cursor_colour {
                match &colour { Some(c) => execute!(term.backend_mut(), crossterm::style::Print(format!("\x1b]12;{c}\x07")))?, None => execute!(term.backend_mut(), crossterm::style::Print("\x1b]112\x07"))? }
                cursor_colour = colour;
            }
            if !app.fleet.agents.is_empty() && !app.fleet_marked { app.fleet_marked = true; mark("first frame with harnesses") }
            if !app.first_frame { app.first_frame = true; mark("first frame") }
            last_draw = Instant::now();
            need_draw = false;
            if let Some(title) = app.window_title().filter(|t| *t != app.title) {
                execute!(term.backend_mut(), terminal::SetTitle(&title))?;
                app.title = title;
            }
            // Include custom terminal-title formats: they can animate too.
            next_repaint = ui::next_repaint(&app, frame_started);
        }
    }
    // Its #() jobs ended, as tmux's server ends its jobs.
    if app.forget_sessions { local::stop().await; }
    format::kill_jobs(&app);
    // (What its last hooks changed reaches the others.)
    app.server_dirty = true;
    server::publish(&mut app);
    // The terminal's own cursor colour back.
    if cursor_colour.is_some() { let _ = execute!(term.backend_mut(), crossterm::style::Print("\x1b]112\x07")); }
    let session = app.session_name();
    // A detach: the sessions no client shows now, with destroy-unattached, go; and with
    // exit-unattached, the server when no other client is attached (server_loop).
    let detaching = !app.exited && !app.forget_sessions && app.start_failed.is_none();
    if detaching {
        commands::destroy_unattached(&mut app, true);
        let exit = app.options.get("exit-unattached", "", None).as_deref() == Some("on");
        let name = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "default".into());
        if exit && ipc::others_of(&name).is_empty() { app.sessions.clear(); app.session_alias = None; app.forget_sessions = true; app.exited = false }
    }
    // client-detached (a detach, not an exit or kill-server), what it changes kept for the server.
    if detaching {
        commands::notify(&mut app, "client-detached", None, None);
        commands::run_pending_hooks(&mut app);
        app.server_dirty = true;
        server::publish(&mut app);
    }
    history::save(&app);
    app.fleet.save_cache();
    app.mark_seen();
    app.save_seen();
    // Its sessions left for the next client (another terminal's, or `hn` again).
    if app.start_failed.is_none() { app.write_sessions(app::Save::Leave) }
    // The clients showing its sessions take them; the owner of the one it showed is told.
    mirror::tell_mirrors_now(&app);
    mirror::leave(&app);
    if let Some(path) = &socket { ipc::gone(path) }
    // The last terminal leaves a running server while sessions remain, as tmux does. Scripts
    // such as tmux-sessionizer can test for a process before deciding to create a session.
    if app.start_failed.is_none() && !app.forget_sessions && !app.handed_over {
        let name = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty());
        let keep = cli::has_any_session(name.as_deref()) || app.harness_hooks()
            || app.options.get("exit-empty", "", None).as_deref() == Some("off");
        if keep && ipc::others_of(name.as_deref().unwrap_or("default")).is_empty() {
            cli::spawn_headless(name.as_deref(), Some(app.port)).await;
        }
    }
    // (A server with the desk lives on past its last terminal, until kill-server.)
    ids::leave(Some(app.desk_mode != app::DeskMode::Off && !app.forget_sessions));
    drop(term);
    drop(restore);
    // `hn attach -t nosuch`: tmux's error, and no client.
    if let Some(e) = &app.start_failed { eprintln!("{e}"); std::process::exit(1) }
    // As tmux says it: the harnesses are still running, and `hn` comes back to them — or the
    // last window went, and the session with it.
    // detach-client -E: the client becomes the command, run by default-shell (client_exec).
    if let Some(cmd) = app.exec_after.take() {
        use std::os::unix::process::CommandExt;
        let shell = app.options.get("default-shell", "", None).filter(|s| !s.is_empty()).or_else(|| std::env::var("SHELL").ok().filter(|s| !s.is_empty())).unwrap_or_else(|| "/bin/sh".into());
        let e = std::process::Command::new(&shell).arg("-c").arg(&cmd).env("SHELL", &shell).exec();
        eprintln!("execl failed: {e}");
        std::process::exit(1);
    }
    if app.exited { println!("[exited]") } else if app.forget_sessions && !detaching { println!("[server exited]") }
    else if app.hup_parent { println!("[detached and SIGHUP (from session {session})]") }
    else { println!("[detached (from session {session})]") }
    // detach-client -P: the shell that started the client is sent SIGHUP.
    if app.hup_parent { let ppid = unsafe { libc::getppid() }; if ppid > 1 { unsafe { libc::kill(ppid, libc::SIGHUP); } } }
    Ok(())
}
