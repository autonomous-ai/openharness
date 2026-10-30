//! One pane: a child on a pseudo terminal, the grid its output draws, and the
//! sequence number of every output chunk.
//!
//! The pane has two halves:
//! - the *screen* (`Screen`: the `Term` grid and `seq`), which lives as long as the pane, so a
//!   respawned child draws into the same grid and continues the same sequence;
//! - the *attachment* (`Attachment`): one child, its tty and the reader thread that owns the tty.
//!   A respawn replaces it.
//!
//! The reader thread is the only one touching the tty. Other threads reach it through a channel
//! and wake it through the poller (`Msg`). It advances the parser and bumps `seq` under the screen
//! lock, then sends `PaneEvent::Output` after releasing it, so `capture` sees a grid and the `seq`
//! of the last output that grid contains.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::ExitStatus;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use alacritty_terminal::event::OnResize;
use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::tty::{self, ChildEvent, EventedPty, EventedReadWrite, Options, Shell};
use alacritty_terminal::vte::ansi::{Processor, Timeout};
use polling::{Event as PollEvent, Events, PollMode, Poller};
use serde::Serialize;

/// Bytes read from the tty per read call.
const READ_CHUNK: usize = 64 * 1024;
/// Bytes read per wakeup before going back to the poller, so input and control messages are not
/// starved by a program that floods its output.
const READ_PER_WAKEUP: usize = 1024 * 1024;
/// How long a dropped pane's child gets after SIGHUP (Windows: the pseudo console's close) before
/// it is killed outright (SIGKILL, or the job terminated).
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);
/// How long a kill that escalated waits for the reader to report the exit.
const EXIT_REPORT: Duration = Duration::from_secs(1);
/// How often a kill looks whether the pane's process group is empty.
#[cfg(unix)]
const GROUP_POLL: Duration = Duration::from_millis(20);

#[cfg(unix)]
const READ_WRITE_TOKEN: usize = 0; // alacritty's `tty::unix::PTY_READ_WRITE_TOKEN` (crate-private)
#[cfg(unix)]
const CHILD_EVENT_TOKEN: usize = 1; // alacritty's `tty::unix::PTY_CHILD_EVENT_TOKEN` (crate-private)
#[cfg(windows)]
use alacritty_terminal::tty::{
    PTY_CHILD_EVENT_TOKEN as CHILD_EVENT_TOKEN, PTY_READ_WRITE_TOKEN as READ_WRITE_TOKEN,
};

#[derive(Debug, Clone, Default)]
pub struct PaneSpec {
    pub command: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    /// Names the child does not get from the host's own environment (`clearInherited`).
    pub clear_env: Vec<String>,
    /// Text drawn into the grid before the child starts, so it sits in the scrollback (`Op::Create`'s `seed`).
    pub seed: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneEvent {
    Output {
        seq: u64,
        bytes: Arc<[u8]>,
    },
    /// `generation`: which of the pane's children exited (1 for the first, one more per respawn),
    /// so an exit of a child a respawn already replaced is told apart from the current child's.
    Exited {
        generation: u64,
        status: Option<i32>,
    },
    Title(String),
}

/// Mirrors the fields of `PaneMeta` in `cli/src/lib/tmuxStream.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PaneMeta {
    pub cols: u16,
    pub rows: u16,
    pub alternate_on: bool,
    pub cursor_x: u16,
    pub cursor_y: u16,
    pub cursor_visible: bool,
    pub mouse_standard: bool,
    pub mouse_button: bool,
    pub mouse_all: bool,
    pub mouse_utf8: bool,
    pub mouse_sgr: bool,
}

/// A pane's screen at one sequence number (`Pane::snapshot`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub seq: u64,
    /// `capture-pane -p -e -N`: one line per screen row.
    pub capture: String,
    /// `capture-pane -p -e -N -S -<n> -E -1`: one line per history row (none without history).
    pub history: String,
    /// For a conversation: the same history as `capture-pane -p -e -J` prints it (wrapped rows
    /// joined into their lines), and whether its last line runs on into the screen, read as
    /// `tmuxStream.ts` reads `capture-pane -p -J -S -1 -E 0` (one line, its newline last).
    pub conversation: Option<Conversation>,
    pub meta: PaneMeta,
}

/// A conversation's history in its joined form (`Snapshot::conversation`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub joined: String,
    pub last_continues: bool,
}

/// What `capture-pane -p` prints for `text`: ending in exactly one newline (the last line of a
/// joined range has none of its own).
fn printed(mut text: String) -> String {
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

struct Size {
    cols: u16,
    rows: u16,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows as usize
    }
    fn screen_lines(&self) -> usize {
        self.rows as usize
    }
    fn columns(&self) -> usize {
        self.cols as usize
    }
}

fn window_size(cols: u16, rows: u16) -> WindowSize {
    WindowSize {
        num_lines: rows,
        num_cols: cols,
        cell_width: 1,
        cell_height: 1,
    }
}

/// Synchronized updates (`CSI ? 2026 h`) are not buffered: every byte read reaches the grid
/// before its `seq` is published, which the snapshot cut relies on.
#[derive(Default)]
struct NoSync;

impl Timeout for NoSync {
    fn set_timeout(&mut self, _: Duration) {}
    fn clear_timeout(&mut self) {}
    fn pending_timeout(&self) -> bool {
        false
    }
}

fn meta(term: &Term<Listener>) -> PaneMeta {
    let mode = *term.mode();
    let point = term.grid().cursor.point;
    PaneMeta {
        cols: term.columns() as u16,
        rows: term.screen_lines() as u16,
        alternate_on: mode.contains(TermMode::ALT_SCREEN),
        cursor_x: point.column.0 as u16,
        cursor_y: point.line.0.max(0) as u16,
        cursor_visible: mode.contains(TermMode::SHOW_CURSOR),
        mouse_standard: mode.contains(TermMode::MOUSE_REPORT_CLICK),
        mouse_button: mode.contains(TermMode::MOUSE_DRAG),
        mouse_all: mode.contains(TermMode::MOUSE_MOTION),
        mouse_utf8: mode.contains(TermMode::UTF8_MOUSE),
        mouse_sgr: mode.contains(TermMode::SGR_MOUSE),
    }
}

/// The grid and the sequence number of the last output it contains, behind one lock.
struct Screen {
    term: Term<Listener>,
    seq: u64,
}

/// State the `Term`'s listener and the pane share; it outlives any one child.
#[derive(Default)]
struct Shared {
    /// Events the `Term` raised while the reader thread held the screen lock. The reader thread
    /// handles them after releasing it.
    pending: Mutex<Vec<Event>>,
    title: Mutex<String>,
    /// The last OSC 7 path the current child reported.
    cwd: Mutex<Option<String>>,
}

#[derive(Clone)]
struct Listener(Arc<Shared>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        if matches!(
            event,
            Event::Title(_) | Event::ResetTitle | Event::PtyWrite(_)
        ) {
            lock(&self.0.pending).push(event);
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the current child has exited, and with what status.
#[derive(Default)]
struct Life {
    exited: Mutex<Option<Option<i32>>>,
    changed: Condvar,
}

impl Life {
    fn set(&self, status: Option<i32>) {
        *lock(&self.exited) = Some(status);
        self.changed.notify_all();
    }

    fn has_exited(&self) -> bool {
        lock(&self.exited).is_some()
    }

    /// Wait up to `timeout` for the child to exit; whether it has.
    fn wait(&self, timeout: Duration) -> bool {
        let guard = lock(&self.exited);
        let (guard, _) = self
            .changed
            .wait_timeout_while(guard, timeout, |e| e.is_none())
            .unwrap_or_else(|e| e.into_inner());
        guard.is_some()
    }
}

/// Messages to the reader thread, which owns the tty.
enum Msg {
    Input(Vec<u8>),
    Resize(WindowSize),
    /// The pane was dropped: stop without reporting an exit (Unix: and end the child; Windows:
    /// the pane's drop ends the job).
    Shutdown,
    /// Windows `kill`: close the pseudo console, then report the child's exit. `Killing::finish`
    /// ends the job after the grace.
    #[cfg(windows)]
    Hangup,
}

/// The current child: how to reach its reader thread, and its process.
#[derive(Clone)]
struct Attachment {
    tx: Sender<Msg>,
    poller: Arc<Poller>,
    pid: Option<u32>,
    life: Arc<Life>,
    /// Which of the pane's children this is (`PaneEvent::Exited`).
    generation: u64,
    /// The child's terminal device (`/dev/pts/3`, `/dev/ttys004`); empty where there is none.
    tty: String,
    /// Windows: the child's own Job Object, which everything it starts belongs to too.
    #[cfg(windows)]
    job: Arc<crate::job::Job>,
}

impl Attachment {
    fn send(&self, msg: Msg) -> io::Result<()> {
        self.tx
            .send(msg)
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        self.poller.notify()
    }
}

/// What a fresh Windows console's first frame does to the screen it is given (`Pane::respawn`):
/// attributes reset, the screen cleared into history, the cursor home.
#[cfg(any(windows, test))]
const FRESH_CONSOLE: &[u8] = b"\x1b[m\x1b[2J\x1b[H";

pub struct Pane {
    id: String,
    screen: Arc<Mutex<Screen>>,
    shared: Arc<Shared>,
    attachment: Mutex<Attachment>,
    /// The directory the current child was spawned in.
    spawn_cwd: Mutex<Option<String>>,
    /// Where every child of this pane reports its events (a respawn attaches with it).
    sink: Sender<(String, PaneEvent)>,
}

/// The user's home directory, when the environment names one that exists.
fn user_home() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
}

/// A seed as the terminal should read it: capture/history lines end in a bare `\n`, which does not return
/// to column 0 (a staircase), so each one becomes `\r\n`. One line break at the very end is dropped: it ends
/// the last line, it does not start another (a blank history row).
fn seed_bytes(seed: &[u8]) -> Vec<u8> {
    let seed = seed
        .strip_suffix(b"\r\n")
        .or_else(|| seed.strip_suffix(b"\n"))
        .unwrap_or(seed);
    let mut out = Vec::with_capacity(seed.len() + 16);
    let mut previous = 0u8;
    for &byte in seed {
        if byte == b'\n' && previous != b'\r' {
            out.push(b'\r');
        }
        out.push(byte);
        previous = byte;
    }
    out
}

impl Pane {
    /// A new pane running `spec`. Without a `cwd` it starts in the user's home directory
    /// (`%USERPROFILE%`, `$HOME`), as a new tmux pane does, not in the host's (whose directory
    /// is only the fallback when there is no home).
    pub fn spawn(
        id: String,
        mut spec: PaneSpec,
        history_limit: usize,
        sink: Sender<(String, PaneEvent)>,
    ) -> io::Result<Pane> {
        if spec.cwd.is_none() {
            spec.cwd = user_home().or_else(|| std::env::current_dir().ok());
        }
        let (cols, rows) = (spec.cols.max(1), spec.rows.max(1));
        let shared = Arc::new(Shared::default());
        let config = Config {
            scrolling_history: history_limit,
            ..Config::default()
        };
        let term = Term::new(config, &Size { cols, rows }, Listener(shared.clone()));
        let screen = Arc::new(Mutex::new(Screen { term, seq: 0 }));
        if let Some(seed) = spec.seed.as_deref() {
            // The seed, then one line feed per row and a cursor home: it scrolls wholly into the history and the
            // child draws on a blank screen from the top, as a new pane's child does. This runs before `attach`,
            // so no stream or child output can interleave.
            let mut screen = lock(&screen);
            let Screen { term, seq } = &mut *screen;
            let mut parser = Processor::<NoSync>::new();
            parser.advance(term, &seed_bytes(seed));
            // A seed that ends with a colour on must not paint the blank screen below it: the line feeds
            // scroll rows in with the cursor's colour.
            parser.advance(term, b"\x1b[0m");
            parser.advance(term, "\r\n".repeat(rows as usize).as_bytes());
            parser.advance(term, b"\x1b[H");
            *seq += 1;
        }
        let attachment = attach(&id, 1, &spec, cols, rows, &screen, &shared, sink.clone())?;
        Ok(Pane {
            id,
            screen,
            shared,
            attachment: Mutex::new(attachment),
            spawn_cwd: Mutex::new(spec.cwd.map(|p| p.to_string_lossy().into_owned())),
            sink,
        })
    }

    /// Start `spec`'s command in this pane once its child has exited (tmux `respawn-pane`): the
    /// new child draws into the same grid, continuing its sequence. `spec.cwd` defaults to the
    /// previous child's spawn directory; the size is the pane's. The new child's generation: one
    /// more than the last, used up even when the spawn fails, so a late exit of the last child is
    /// never taken for the pane's current one.
    pub fn respawn(&self, mut spec: PaneSpec) -> io::Result<u64> {
        let mut attachment = lock(&self.attachment);
        if !attachment.life.has_exited() {
            return Err(io::Error::other("the pane's process is still running"));
        }
        let (cols, rows) = {
            let screen = lock(&self.screen);
            (
                screen.term.columns() as u16,
                screen.term.screen_lines() as u16,
            )
        };
        if spec.cwd.is_none() {
            spec.cwd = lock(&self.spawn_cwd).as_ref().map(PathBuf::from);
        }
        // Windows: what the last child left running in its job (outside the console, which its
        // close no longer reaches) goes with it; the new child gets a job of its own.
        #[cfg(windows)]
        attachment.job.end_now();
        // Windows: a new pseudoconsole is a blank screen of its own with its cursor at the top left,
        // and draws as if the terminal were too. The inbox conhost said so with its first frame (a
        // clear); OpenConsole, the bundled ConPTY, sends none, so the respawned child's output went on
        // from wherever the last child left the cursor, after its prompt (CI run 38696314864, both
        // architectures). Clear and home the grid as that first frame did, through the output path, so
        // every stream sees it too. Under the inbox conhost its own clear then finds nothing to move.
        #[cfg(windows)]
        self.draw_from_host(FRESH_CONSOLE);
        let generation = attachment.generation + 1;
        attachment.generation = generation;
        *attachment = attach(
            &self.id,
            generation,
            &spec,
            cols,
            rows,
            &self.screen,
            &self.shared,
            self.sink.clone(),
        )?;
        *lock(&self.spawn_cwd) = spec.cwd.map(|p| p.to_string_lossy().into_owned());
        Ok(generation)
    }

    /// Draw [bytes] into the grid as if the child had written them: parsed, given the next sequence
    /// number and sent to the streams as output.
    #[cfg(any(windows, test))]
    fn draw_from_host(&self, bytes: &[u8]) {
        let seq = {
            let mut screen = lock(&self.screen);
            let Screen { term, seq } = &mut *screen;
            Processor::<NoSync>::new().advance(term, bytes);
            *seq += 1;
            *seq
        };
        let _ = self.sink.send((
            self.id.clone(),
            PaneEvent::Output {
                seq,
                bytes: Arc::from(bytes),
            },
        ));
    }

    /// Which of the pane's children runs now (or ran last).
    pub fn generation(&self) -> u64 {
        lock(&self.attachment).generation
    }

    /// The current child's exit status once it has exited (`Some(None)` when it is not known).
    pub fn exit_status(&self) -> Option<Option<i32>> {
        *lock(&lock(&self.attachment).life.exited)
    }

    /// Wait up to `timeout` for the current child to exit; whether it has.
    pub fn wait_exit(&self, timeout: Duration) -> bool {
        let life = lock(&self.attachment).life.clone();
        life.wait(timeout)
    }

    fn attachment(&self) -> Attachment {
        lock(&self.attachment).clone()
    }

    /// Queue bytes for the child. Fails only once the reader thread is gone.
    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.attachment().send(Msg::Input(bytes.to_vec()))
    }

    /// Resize the grid, then tell the child, unless the grid already has this size (as tmux skips
    /// a same-size resize: no SIGWINCH, so a TUI does not print again). Returns the sequence number
    /// of the last output drawn at the old size, so every later output reaches the grid at the new
    /// one (a resize does not take a sequence number of its own), and whether the size changed.
    pub fn resize(&self, cols: u16, rows: u16) -> (u64, bool) {
        let (cols, rows) = (cols.max(1), rows.max(1));
        let seq = {
            let mut screen = lock(&self.screen);
            let same = screen.term.columns() == cols as usize
                && screen.term.screen_lines() == rows as usize;
            if same {
                return (screen.seq, false);
            }
            screen.term.resize(Size { cols, rows });
            screen.seq
        };
        let _ = self.attachment().send(Msg::Resize(window_size(cols, rows)));
        (seq, true)
    }

    /// Under one lock: the grid's capture and the sequence number of the last output it contains.
    pub fn capture(&self, history_lines: Option<u32>, ansi: bool) -> (String, u64) {
        let screen = lock(&self.screen);
        (
            harness_term::capture::capture_pane(screen.term.grid(), history_lines, ansi),
            screen.seq,
        )
    }

    pub fn meta(&self) -> PaneMeta {
        meta(&lock(&self.screen).term)
    }

    /// Under one lock, for a stream keyframe: the visible screen, the last `history_lines` lines
    /// of the history above it (none when 0), with `conversation` that history joined as well,
    /// the metadata, and the sequence number of the last output they contain.
    ///
    /// Rows are as tmux's capture-pane prints them, except that a row ends at its last cell that
    /// is not a default blank where tmux pads to the cells it has allocated: the two paint the
    /// same. A pane with no history has an empty one (tmux's `-E -1` would then print the first
    /// screen row).
    pub fn snapshot(&self, history_lines: u32, conversation: bool) -> Snapshot {
        use harness_term::capture::{Flags2, history};
        // -p -e -N: not joined, not trimmed; -p -e -J and -p -J: joined.
        let plain = Flags2 {
            join: false,
            sequences: true,
            escape: false,
            empty_cells: false,
            trim: false,
        };
        let joined = Flags2 {
            join: true,
            sequences: true,
            ..Flags2::default()
        };
        let seam = Flags2 {
            join: true,
            ..Flags2::default()
        };
        let screen = lock(&self.screen);
        let grid = screen.term.grid();
        let rows = grid.screen_lines() as i32;
        let depth = (history_lines as usize).min(grid.history_size()) as i32;
        let (text, conversation) = if depth == 0 {
            let none = conversation.then(|| Conversation {
                joined: String::new(),
                last_continues: false,
            });
            (String::new(), none)
        } else {
            let conversation = conversation.then(|| {
                let seam = printed(history(grid, -1, 0, seam));
                Conversation {
                    joined: printed(history(grid, -depth, -1, joined)),
                    last_continues: seam.find('\n') == Some(seam.len() - 1),
                }
            });
            (history(grid, -depth, -1, plain), conversation)
        };
        Snapshot {
            seq: screen.seq,
            capture: history(grid, 0, rows - 1, plain),
            history: text,
            conversation,
            meta: meta(&screen.term),
        }
    }

    /// The child's pid while it runs.
    pub fn root_pid(&self) -> Option<u32> {
        let attachment = self.attachment();
        if attachment.life.has_exited() {
            None
        } else {
            attachment.pid
        }
    }

    /// The pid of the current child, or of the last one once it has exited: what tmux's
    /// `#{pane_pid}` still says of a dead pane.
    pub fn last_pid(&self) -> Option<u32> {
        self.attachment().pid
    }

    pub fn title(&self) -> String {
        lock(&self.shared.title).clone()
    }

    /// Set the title (tmux `select-pane -T`); the child's next OSC 0/2 replaces it.
    pub fn set_title(&self, title: &str) {
        *lock(&self.shared.title) = title.to_owned();
    }

    /// The terminal modes the pane's program set (cursor keys, bracketed paste, …).
    pub fn mode(&self) -> TermMode {
        *lock(&self.screen).term.mode()
    }

    /// The current child's terminal device; empty where there is none (Windows).
    pub fn tty(&self) -> String {
        self.attachment().tty
    }

    /// The last directory the child reported with OSC 7, else the directory it was spawned in.
    pub fn cwd(&self) -> Option<String> {
        // One lock at a time: `respawn` takes them in the other order.
        let reported = lock(&self.shared.cwd).clone();
        reported.or_else(|| lock(&self.spawn_cwd).clone())
    }

    /// Send a kill's first signal; `Killing::finish` waits out the grace and escalates. `None`
    /// when the child had already exited: it is left alone, as its pid (and so the group id) may
    /// since belong to another process.
    ///
    /// Unix: SIGHUP to the child's process group, as closing a tmux pane's tty does.
    #[cfg(unix)]
    pub fn start_kill(&self) -> Option<Killing> {
        let attachment = self.attachment();
        let pid = attachment.pid?;
        if attachment.life.has_exited() {
            return None;
        }
        // `tty::new` makes the child a session (and process group) leader: pgid == pid. Until
        // the child is reaped, and then while any process is in the group, the id is not reused.
        let group = pid as libc::pid_t;
        unsafe { libc::kill(-group, libc::SIGHUP) };
        Some(Killing { attachment, group })
    }

    /// Windows: close the pseudo console (the console's processes get CTRL_CLOSE_EVENT). Once the
    /// child has exited (its console is closed), what it left running in its job is terminated
    /// at once, and `None`: its exit is already reported. A job has no pid to be reused.
    #[cfg(windows)]
    pub fn start_kill(&self) -> Option<Killing> {
        let attachment = self.attachment();
        if attachment.life.has_exited() {
            attachment.job.end_now();
            return None;
        }
        let _ = attachment.send(Msg::Hangup);
        Some(Killing { attachment })
    }

    /// `start_kill`, then `Killing::finish`.
    pub fn kill(&self, grace: Duration) {
        if let Some(killing) = self.start_kill() {
            killing.finish(grace);
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// The processes in the current (or last) child's job: the child and what it started.
    #[cfg(windows)]
    pub fn job_pids(&self) -> io::Result<Vec<u32>> {
        self.attachment().job.pids()
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        let attachment = self.attachment();
        let _ = attachment.send(Msg::Shutdown);
        // Windows: the reader's close sends the console's processes CTRL_CLOSE_EVENT; whatever is
        // left in the job after `SHUTDOWN_GRACE` (a descendant outside the console included) is
        // terminated, at once when the child had already exited. Off the caller's thread, and
        // not on the reader's, which the close blocks until the console's processes are gone.
        #[cfg(windows)]
        {
            let job = attachment.job.clone();
            if attachment.life.has_exited() {
                job.end_now();
            } else if std::thread::Builder::new()
                .name(format!("pty-end {}", self.id))
                .spawn(move || job.end(SHUTDOWN_GRACE))
                .is_err()
            {
                attachment.job.end_now();
            }
        }
    }
}

/// A kill whose first signal is sent. It holds the child's attachment, not the pane.
pub struct Killing {
    attachment: Attachment,
    #[cfg(unix)]
    group: libc::pid_t,
}

impl Killing {
    /// Unix: after `grace`, SIGKILL the group if anything in it still runs, so a descendant
    /// that ignores SIGHUP does not outlive the pane. Returns once the child has exited and the
    /// group is empty, at most after `grace` (plus `EXIT_REPORT` after a SIGKILL).
    #[cfg(unix)]
    pub fn finish(self, grace: Duration) {
        let Killing { attachment, group } = self;
        let deadline = std::time::Instant::now() + grace;
        loop {
            let exited = attachment.life.has_exited();
            if exited && !group_alive(group) {
                return;
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                unsafe { libc::kill(-group, libc::SIGKILL) };
                // Until the reader has seen the exit: a pane dropped before that ends its
                // reader without reporting one.
                attachment.life.wait(EXIT_REPORT);
                return;
            }
            if exited {
                std::thread::sleep(left.min(GROUP_POLL));
            } else {
                attachment.life.wait(left.min(GROUP_POLL));
            }
        }
    }

    /// Windows: after `grace`, terminate the child's job if anything in it still runs, so no
    /// descendant (one outside the console, which the close does not reach) outlives the pane.
    /// Returns once the job is empty and the child's exit reported, at most after `grace` (plus
    /// `EXIT_REPORT`).
    #[cfg(windows)]
    pub fn finish(self, grace: Duration) {
        self.attachment.job.end(grace);
        // Until the reader has seen the exit: a pane dropped before that ends its reader without
        // reporting one.
        self.attachment.life.wait(EXIT_REPORT);
    }
}

/// Spawn `spec`'s command on a new tty and start its reader thread.
#[allow(clippy::too_many_arguments)]
fn attach(
    id: &str,
    generation: u64,
    spec: &PaneSpec,
    cols: u16,
    rows: u16,
    screen: &Arc<Mutex<Screen>>,
    shared: &Arc<Shared>,
    sink: Sender<(String, PaneEvent)>,
) -> io::Result<Attachment> {
    let (program, args) = spec
        .command
        .split_first()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty command"))?;
    #[allow(unused_mut)]
    let mut env = spec.env.clone();
    #[cfg(unix)]
    {
        // tmux gives its panes a TERM; the host's own may be absent or wrong.
        env.entry("TERM".into())
            .or_insert_with(|| "xterm-256color".into());
        env.entry("COLORTERM".into())
            .or_insert_with(|| "truecolor".into());
    }
    // alacritty's Unix `tty::new` puts its window variables in the child's environment; panes
    // should look like tmux panes, so `env -u` takes them out (as hn's local panes do). `env`
    // execs the command: the pid stays the child's.
    // The pane's cleared names go the same way (`PaneSpec::clear_env`).
    #[cfg(unix)]
    let (program, args) = (
        &"/usr/bin/env".to_owned(),
        ["-u", "ALACRITTY_WINDOW_ID", "-u", "WINDOWID"]
            .into_iter()
            .map(str::to_owned)
            .chain(
                spec.clear_env
                    .iter()
                    .flat_map(|name| ["-u".to_owned(), name.clone()]),
            )
            .chain(["--".to_owned(), program.clone()])
            .chain(args.iter().cloned())
            .collect::<Vec<_>>(),
    );
    // The child's own job, so a respawned child never shares one with the child it replaced.
    #[cfg(windows)]
    let job = Arc::new(crate::job::Job::new()?);
    let options = Options {
        shell: Some(Shell::new(program.clone(), args.to_vec())),
        working_directory: spec.cwd.clone(),
        env,
        drain_on_exit: true,
        // `command` is an argv: quote each argument by the C runtime's rules.
        #[cfg(windows)]
        escape_args: true,
        #[cfg(windows)]
        job: Some(job.handle()),
        #[cfg(windows)]
        env_remove: spec.clear_env.clone(),
    };

    let mut pty = tty::new(&options, window_size(cols, rows), 0)?;
    #[cfg(unix)]
    let pid = Some(pty.child().id());
    #[cfg(unix)]
    let tty = {
        use std::os::fd::AsRawFd;
        crate::unix_proc::tty_name(pty.file().as_raw_fd()).unwrap_or_default()
    };
    #[cfg(windows)]
    let tty = String::new();
    #[cfg(windows)]
    let pid = pty.child_watcher().pid().map(|p| p.get());
    #[cfg(windows)]
    let process = duplicate_process_handle(pty.child_watcher().raw_handle() as _)?;

    let poller = Arc::new(Poller::new()?);
    let interest = PollEvent::readable(READ_WRITE_TOKEN);
    // SAFETY: the reader thread deregisters before it drops the pty.
    unsafe { pty.register(&poller, interest, PollMode::Level)? };

    let (tx, rx) = mpsc::channel();
    let life = Arc::new(Life::default());
    *lock(&shared.cwd) = None;
    let reader = Reader {
        id: id.to_owned(),
        generation,
        pty,
        poller: poller.clone(),
        rx,
        screen: screen.clone(),
        shared: shared.clone(),
        sink,
        life: life.clone(),
        parser: Processor::new(),
        osc7: Osc7Scanner::default(),
        writes: VecDeque::new(),
        written: 0,
        interest,
        eof: false,
        #[cfg(windows)]
        process,
    };
    std::thread::Builder::new()
        .name(format!("pty-reader {id}"))
        .spawn(move || reader.run())?;
    Ok(Attachment {
        tx,
        poller,
        pid,
        life,
        generation,
        tty,
        #[cfg(windows)]
        job,
    })
}

#[cfg(windows)]
fn duplicate_process_handle(
    raw: windows_sys::Win32::Foundation::HANDLE,
) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut out: HANDLE = std::ptr::null_mut();
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            raw,
            GetCurrentProcess(),
            &mut out,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(out as _) })
}

fn exit_code(status: ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        // A signal death reads as a shell does: 128 + signal.
        status.code().or_else(|| status.signal().map(|s| 128 + s))
    }
    #[cfg(not(unix))]
    {
        status.code()
    }
}

/// How the reader loop ended.
enum End {
    /// The child exited and `Exited` was sent.
    Exited,
    /// The pane was dropped.
    Shutdown,
    #[cfg(windows)]
    Hangup,
    /// The poller or tty failed; the child's fate is unknown.
    Failed,
}

/// The reader thread: owns the tty, follows `alacritty_terminal::event_loop`.
struct Reader {
    id: String,
    generation: u64,
    pty: tty::Pty,
    poller: Arc<Poller>,
    rx: Receiver<Msg>,
    screen: Arc<Mutex<Screen>>,
    shared: Arc<Shared>,
    sink: Sender<(String, PaneEvent)>,
    life: Arc<Life>,
    parser: Processor<NoSync>,
    osc7: Osc7Scanner,
    /// Bytes waiting for the tty: input and terminal replies, in order.
    writes: VecDeque<Vec<u8>>,
    /// How much of `writes.front()` is written.
    written: usize,
    interest: PollEvent,
    /// Unix: the tty hung up (all of the child's side closed); it is no longer polled.
    eof: bool,
    /// Windows: the child's process, to wait for its exit once the pty (and its watcher) is gone.
    #[cfg(windows)]
    process: std::os::windows::io::OwnedHandle,
}

impl Reader {
    fn run(mut self) {
        let end = self.event_loop();
        #[cfg(unix)]
        if let End::Shutdown = end {
            self.end_child();
        }
        if !(cfg!(unix) && self.eof) {
            let _ = self.pty.deregister(&self.poller);
        }
        let Reader {
            pty,
            life,
            sink,
            id,
            generation,
            #[cfg(windows)]
            process,
            ..
        } = self;
        // Unix: SIGHUP to the child, then reap it (alacritty's `Pty::drop`; after `end_child` on
        // a shutdown, so the reap cannot block).
        // Windows: ClosePseudoConsole; the console's processes get CTRL_CLOSE_EVENT. The close
        // waits for them to go (the job's end, `Killing::finish` or the pane's drop, makes sure
        // they do), and never for a drain of the
        // console's output: the vendored `Pty` drops its output pipe first (tui/vendor/README.md).
        drop(pty);
        let status = match end {
            End::Exited | End::Shutdown => return,
            End::Failed => {
                log::error!("pane {id}: reader stopped");
                None
            }
            #[cfg(windows)]
            End::Hangup => wait_process(&process),
        };
        life.set(status);
        let _ = sink.send((id, PaneEvent::Exited { generation, status }));
    }

    fn event_loop(&mut self) -> End {
        let mut events = Events::new();
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            events.clear();
            if let Err(err) = self.poller.wait(&mut events, None) {
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                log::error!("pane {}: poll failed: {err}", self.id);
                return End::Failed;
            }

            while let Ok(msg) = self.rx.try_recv() {
                match msg {
                    Msg::Input(bytes) => self.writes.push_back(bytes),
                    Msg::Resize(size) => self.pty.on_resize(size),
                    Msg::Shutdown => return End::Shutdown,
                    #[cfg(windows)]
                    Msg::Hangup => return End::Hangup,
                }
            }

            for event in events.iter() {
                match event.key {
                    CHILD_EVENT_TOKEN => {
                        if let Some(ChildEvent::Exited(status)) = self.pty.next_child_event() {
                            // Drain what the child wrote before it exited.
                            self.read(&mut buf);
                            let status = status.and_then(exit_code);
                            self.life.set(status);
                            let _ = self.sink.send((
                                self.id.clone(),
                                PaneEvent::Exited {
                                    generation: self.generation,
                                    status,
                                },
                            ));
                            return End::Exited;
                        }
                    }
                    READ_WRITE_TOKEN => {
                        if event.is_interrupt() {
                            // epoll/poll hang-up: no process has the tty open any more. It stays
                            // reported (level-triggered) until the tty is closed, so drain it and
                            // stop polling it; the child's exit still ends the loop.
                            #[cfg(unix)]
                            {
                                self.read(&mut buf);
                                self.hang_up();
                            }
                            continue;
                        }
                        if event.readable {
                            self.read(&mut buf);
                        }
                    }
                    _ => {}
                }
            }

            // Write eagerly: input and replies usually fit without waiting for writability.
            self.write();
            if let Err(err) = self.update_interest() {
                log::error!("pane {}: poll registration failed: {err}", self.id);
                return End::Failed;
            }
        }
    }

    /// Read what the tty has (bounded per wakeup) into the grid.
    fn read(&mut self, buf: &mut [u8]) {
        if self.eof {
            return;
        }
        let mut total = 0;
        while total < READ_PER_WAKEUP {
            match self.pty.reader().read(buf) {
                // Unix: end of file, the child's side closed. Windows: nothing buffered right now.
                Ok(0) => {
                    #[cfg(unix)]
                    self.hang_up();
                    break;
                }
                Ok(n) => {
                    total += n;
                    self.ingest(&buf[..n]);
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                Err(err) => {
                    // Linux reports a hung-up tty as EIO.
                    #[cfg(unix)]
                    {
                        if err.raw_os_error() != Some(libc::EIO) {
                            log::error!("pane {}: tty read failed: {err}", self.id);
                        }
                        self.hang_up();
                    }
                    #[cfg(windows)]
                    log::error!("pane {}: tty read failed: {err}", self.id);
                    break;
                }
            }
        }
    }

    /// Stop polling a tty whose other side closed: it would report readable (or hang-up) forever.
    /// The loop keeps waiting for the child's exit.
    #[cfg(unix)]
    fn hang_up(&mut self) {
        if !self.eof {
            self.eof = true;
            self.writes.clear();
            self.written = 0;
            let _ = self.poller.delete(self.pty.file());
        }
    }

    /// The pane was dropped while its child runs: SIGHUP the child's process group, and SIGKILL
    /// the group if the child, or anything else in the group, still runs after `SHUTDOWN_GRACE`,
    /// so the reap in `Pty::drop` cannot block this thread forever and no descendant that ignores
    /// SIGHUP outlives the pane. Runs here, not in the dropping caller.
    #[cfg(unix)]
    fn end_child(&mut self) {
        // The tty is not read any more; left in the poller, its data would wake every wait.
        self.hang_up();
        let group = self.pty.child().id() as libc::pid_t;
        unsafe { libc::kill(-group, libc::SIGHUP) };
        let deadline = std::time::Instant::now() + SHUTDOWN_GRACE;
        let exited = self.wait_child(SHUTDOWN_GRACE);
        // Reaped: the group id stays reserved only while the group has a member.
        while exited && group_alive(group) && std::time::Instant::now() < deadline {
            std::thread::sleep(GROUP_POLL);
        }
        if !exited || group_alive(group) {
            unsafe { libc::kill(-group, libc::SIGKILL) };
            if !exited {
                self.wait_child(SHUTDOWN_GRACE);
            }
        }
    }

    /// Wait up to `timeout` for the child to exit, on the poller (SIGCHLD); whether it has.
    #[cfg(unix)]
    fn wait_child(&mut self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        let mut events = Events::new();
        loop {
            if let Some(ChildEvent::Exited(_)) = self.pty.next_child_event() {
                return true;
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return false;
            }
            events.clear();
            let _ = self.poller.wait(&mut events, Some(left));
        }
    }

    fn ingest(&mut self, bytes: &[u8]) {
        let seq = {
            let mut screen = lock(&self.screen);
            let Screen { term, seq } = &mut *screen;
            self.parser.advance(term, bytes);
            *seq += 1;
            *seq
        };
        if let Some(path) = self.osc7.feed(bytes) {
            *lock(&self.shared.cwd) = Some(path);
        }
        let _ = self.sink.send((
            self.id.clone(),
            PaneEvent::Output {
                seq,
                bytes: Arc::from(bytes),
            },
        ));

        let pending = std::mem::take(&mut *lock(&self.shared.pending));
        for event in pending {
            match event {
                Event::PtyWrite(reply) => self.writes.push_back(reply.into_bytes()),
                Event::Title(title) => self.set_title(title),
                Event::ResetTitle => self.set_title(String::new()),
                _ => {}
            }
        }
    }

    fn set_title(&self, title: String) {
        *lock(&self.shared.title) = title.clone();
        let _ = self.sink.send((self.id.clone(), PaneEvent::Title(title)));
    }

    fn write(&mut self) {
        if self.eof {
            return;
        }
        while let Some(front) = self.writes.front() {
            match self.pty.writer().write(&front[self.written..]) {
                Ok(0) => break,
                Ok(n) => {
                    self.written += n;
                    if self.written >= front.len() {
                        self.writes.pop_front();
                        self.written = 0;
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                Err(err) => {
                    log::error!("pane {}: tty write failed: {err}", self.id);
                    self.writes.clear();
                    self.written = 0;
                    break;
                }
            }
        }
    }

    fn update_interest(&mut self) -> io::Result<()> {
        if self.eof {
            return Ok(());
        }
        let writable = !self.writes.is_empty();
        if writable != self.interest.writable {
            self.interest.writable = writable;
            self.pty
                .reregister(&self.poller, self.interest, PollMode::Level)?;
        }
        Ok(())
    }
}

/// Whether any process is in process group `group`.
#[cfg(unix)]
fn group_alive(group: libc::pid_t) -> bool {
    // EPERM: a member exists that this process may not signal.
    let probe = unsafe { libc::kill(-group, 0) };
    probe == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn wait_process(process: &std::os::windows::io::OwnedHandle) -> Option<i32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, INFINITE, WaitForSingleObject,
    };
    let handle = process.as_raw_handle() as _;
    let mut code = 0u32;
    unsafe {
        WaitForSingleObject(handle, INFINITE);
        if GetExitCodeProcess(handle, &mut code) == 0 {
            return None;
        }
    }
    Some(code as i32)
}

/// Finds `OSC 7 ; file://host/path` (ended by BEL, ST or a bare ESC as in vte) in a byte
/// stream that may be split anywhere, and returns its percent-decoded path.
#[derive(Debug, Default)]
pub struct Osc7Scanner {
    state: Osc7State,
    body: Vec<u8>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Osc7State {
    #[default]
    Ground,
    Esc,
    /// `ESC ]` seen.
    Osc,
    /// `ESC ] 7` seen.
    Seven,
    /// In the body, after `ESC ] 7 ;`.
    Body,
    /// In a body too long to be a path: skip to its end.
    Skip,
}

/// Longer OSC 7 bodies are ignored.
const OSC7_MAX: usize = 4096;

impl Osc7Scanner {
    /// Feed the next chunk; the last path completed in it, if any.
    pub fn feed(&mut self, bytes: &[u8]) -> Option<String> {
        use Osc7State::*;
        let mut found = None;
        for &b in bytes {
            match (self.state, b) {
                (Body | Skip, 0x07) => {
                    if self.state == Body {
                        found = parse_file_url(&self.body).or(found);
                    }
                    self.state = Ground;
                }
                (Body | Skip, 0x1b) => {
                    // ST is `ESC \`; vte ends the string at the ESC either way.
                    if self.state == Body {
                        found = parse_file_url(&self.body).or(found);
                    }
                    self.state = Esc;
                }
                (Body | Skip, 0x18 | 0x1a) => self.state = Ground, // CAN, SUB: abort
                (Body | Skip, 0x00..=0x1f) => {}                   // other C0: ignored, as vte does
                (Body, _) => {
                    if self.body.len() < OSC7_MAX {
                        self.body.push(b);
                    } else {
                        self.state = Skip;
                    }
                }
                (Skip, _) => {}
                (_, 0x1b) => self.state = Esc,
                (Esc, b']') => self.state = Osc,
                (Osc, b'7') => self.state = Seven,
                (Seven, b';') => {
                    self.body.clear();
                    self.state = Body;
                }
                _ => self.state = Ground,
            }
        }
        found
    }
}

fn parse_file_url(body: &[u8]) -> Option<String> {
    let rest = body.strip_prefix(b"file://")?;
    let path = &rest[rest.iter().position(|&b| b == b'/')?..];
    let mut out = Vec::with_capacity(path.len());
    let mut i = 0;
    while i < path.len() {
        let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
        if path[i] == b'%'
            && let (Some(&h), Some(&l)) = (path.get(i + 1), path.get(i + 2))
            && let (Some(h), Some(l)) = (hex(h), hex(l))
        {
            out.push(h << 4 | l);
            i += 3;
            continue;
        }
        out.push(path[i]);
        i += 1;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod osc7_tests {
    use super::Osc7Scanner;

    fn scan_split(stream: &[u8]) -> Vec<Option<String>> {
        // Every split point gives the same result as one chunk.
        let whole = Osc7Scanner::default().feed(stream);
        for at in 0..=stream.len() {
            let mut s = Osc7Scanner::default();
            let a = s.feed(&stream[..at]);
            let b = s.feed(&stream[at..]);
            assert_eq!(b.or(a), whole, "split at {at}");
        }
        let mut s = Osc7Scanner::default();
        stream
            .iter()
            .map(|b| s.feed(std::slice::from_ref(b)))
            .collect()
    }

    fn scan(stream: &[u8]) -> Option<String> {
        scan_split(stream);
        Osc7Scanner::default().feed(stream)
    }

    #[test]
    fn bel_and_st_terminated() {
        assert_eq!(
            scan(b"x\x1b]7;file://host/tmp/a\x07y").as_deref(),
            Some("/tmp/a")
        );
        assert_eq!(
            scan(b"\x1b]7;file://host/tmp/b\x1b\\").as_deref(),
            Some("/tmp/b")
        );
        assert_eq!(
            scan(b"\x1b]7;file:///no/host\x07").as_deref(),
            Some("/no/host")
        );
    }

    #[test]
    fn byte_at_a_time_reports_on_the_terminator() {
        let got = scan_split(b"ab\x1b]7;file://h/p\x07cd");
        let at = got.iter().position(Option::is_some).unwrap();
        assert_eq!(at, 2 + 4 + "file://h/p".len()); // the BEL
        assert_eq!(got[at].as_deref(), Some("/p"));
    }

    #[test]
    fn percent_decoding_and_the_last_path_wins() {
        assert_eq!(
            scan(b"\x1b]7;file://h/one\x07\x1b]7;file://h/a%20b/%E2%9C%93\x07").as_deref(),
            Some("/a b/\u{2713}")
        );
        assert_eq!(
            scan(b"\x1b]7;file://h/bad%zz\x07").as_deref(),
            Some("/bad%zz")
        );
    }

    #[test]
    fn state_carries_across_chunks() {
        let mut s = Osc7Scanner::default();
        assert_eq!(s.feed(b"\x1b]"), None);
        assert_eq!(s.feed(b"7;file://h/sp"), None);
        // ST's ESC ends the string (as in vte); its `\` then comes in the next chunk.
        assert_eq!(s.feed(b"lit\x1b").as_deref(), Some("/split"));
        assert_eq!(s.feed(b"\\"), None);
        assert_eq!(
            s.feed(b"\x1b]7;file://h/next\x07").as_deref(),
            Some("/next")
        );
    }

    #[test]
    fn other_sequences_are_ignored() {
        assert_eq!(
            scan(b"\x1b]0;title\x07\x1b]8;;file://h/x\x07\x1b[7;1H"),
            None
        );
        assert_eq!(scan(b"\x1b]7;https://h/x\x07"), None);
        assert_eq!(scan(b"\x1b]7;file://h/x\x18\x07"), None); // CAN aborts
        assert_eq!(
            scan(b"\x1b\x1b]7;file://h/esc\x07").as_deref(),
            Some("/esc")
        );
        assert_eq!(scan(b"\x1b]77;file://h/x\x07"), None);
    }

    #[test]
    fn overlong_bodies_are_skipped() {
        let mut stream = b"\x1b]7;file://h/".to_vec();
        stream.extend(std::iter::repeat_n(b'a', 5000));
        stream.extend(b"\x07\x1b]7;file://h/ok\x07");
        let mut s = Osc7Scanner::default();
        assert_eq!(s.feed(&stream).as_deref(), Some("/ok"));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::{Duration, Instant};

    fn wait_for(
        rx: &std::sync::mpsc::Receiver<(String, PaneEvent)>,
        pred: impl Fn(&PaneEvent) -> bool,
    ) -> bool {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if let Ok((_, ev)) = rx.recv_timeout(Duration::from_millis(100))
                && pred(&ev)
            {
                return true;
            }
        }
        false
    }

    fn sh(script: &str) -> PaneSpec {
        PaneSpec {
            command: vec!["/bin/sh".into(), "-c".into(), script.into()],
            cwd: None,
            env: HashMap::new(),
            cols: 40,
            rows: 10,
            clear_env: Vec::new(),
            seed: None,
        }
    }

    /// Wait until the visible screen contains `needle`; the screen then.
    fn wait_text(pane: &Pane, rx: &Receiver<(String, PaneEvent)>, needle: &str) -> String {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            let (text, _) = pane.capture(None, false);
            if text.contains(needle) {
                return text;
            }
            assert!(Instant::now() < end, "no {needle:?} in {text:?}");
            let _ = rx.recv_timeout(Duration::from_millis(100));
        }
    }

    #[test]
    fn output_reaches_grid_and_sink_with_increasing_seq() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%1".into(),
            PaneSpec {
                command: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf hello; sleep 1".into(),
                ],
                cwd: None,
                env: HashMap::new(),
                cols: 40,
                rows: 10,
                clear_env: Vec::new(),
                seed: None,
            },
            1000,
            tx,
        )
        .unwrap();
        assert!(wait_for(&rx, |e| matches!(e, PaneEvent::Output { .. })));
        let (text, seq) = pane.capture(None, false);
        assert!(text.starts_with("hello"), "{text:?}");
        assert!(seq >= 1);
    }

    #[test]
    fn exit_is_reported_with_status() {
        let (tx, rx) = channel();
        let _pane = Pane::spawn(
            "%2".into(),
            PaneSpec {
                command: vec!["/bin/sh".into(), "-c".into(), "exit 3".into()],
                cwd: None,
                env: HashMap::new(),
                cols: 40,
                rows: 10,
                clear_env: Vec::new(),
                seed: None,
            },
            1000,
            tx,
        )
        .unwrap();
        assert!(wait_for(&rx, |e| matches!(
            e,
            PaneEvent::Exited {
                status: Some(3),
                ..
            }
        )));
    }

    #[test]
    fn output_seqs_increase_by_one_and_end_before_exit() {
        let (tx, rx) = channel();
        let _pane = Pane::spawn(
            "%3".into(),
            sh("for i in 1 2 3 4 5; do echo line$i; sleep 0.05; done"),
            1000,
            tx,
        )
        .unwrap();
        let mut seqs = Vec::new();
        let mut bytes = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(5)).expect("no exit").1 {
                PaneEvent::Output { seq, bytes: b } => {
                    seqs.push(seq);
                    bytes.extend_from_slice(&b);
                }
                PaneEvent::Exited { status, .. } => {
                    assert_eq!(status, Some(0));
                    break;
                }
                PaneEvent::Title(_) => {}
            }
        }
        assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());
        assert!(String::from_utf8_lossy(&bytes).contains("line5"));
    }

    #[test]
    fn terminal_queries_are_answered_to_the_child() {
        let (tx, rx) = channel();
        // DA1: the reply reaches the child's stdin; it prints the bytes it read in hex.
        let pane = Pane::spawn("%4".into(),
            sh(r#"stty -echo -icanon min 1 time 0; printf '\033[c'; r=$(dd bs=1 count=5 2>/dev/null | od -An -tx1); echo "reply:$r"; sleep 2"#),
            1000, tx).unwrap();
        let text = wait_text(&pane, &rx, "reply:");
        let reply: Vec<&str> = text
            .split("reply:")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .collect();
        assert_eq!(&reply[..5], ["1b", "5b", "3f", "36", "63"], "{text:?}"); // ESC [ ? 6 c
    }

    #[test]
    fn write_and_resize_reach_the_child() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%5".into(),
            sh("read x; echo got:$x; stty size; sleep 2"),
            1000,
            tx,
        )
        .unwrap();
        pane.resize(50, 12);
        assert_eq!((pane.meta().cols, pane.meta().rows), (50, 12));
        pane.write(b"abc\n").unwrap();
        let text = wait_text(&pane, &rx, "12 50");
        assert!(text.contains("got:abc"), "{text:?}");
    }

    #[test]
    fn title_cwd_and_meta() {
        let (tx, rx) = channel();
        let mut spec = sh(
            r#"printf '\033]2;my title\007\033]7;file://host/x%%20y\007\033[?1049h\033[?1000h\033[?1006h\033[?25l\033[3;5H'; sleep 2"#,
        );
        spec.cwd = Some("/".into());
        let pane = Pane::spawn("%6".into(), spec, 1000, tx).unwrap();
        assert_eq!(pane.cwd().as_deref(), Some("/"));
        assert!(pane.root_pid().is_some());
        assert!(wait_for(&rx, |e| *e == PaneEvent::Title("my title".into())));
        let end = Instant::now() + Duration::from_secs(5);
        while !pane.meta().alternate_on || pane.meta().cursor_y != 2 {
            assert!(Instant::now() < end, "{:?}", pane.meta());
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(pane.title(), "my title");
        assert_eq!(pane.cwd().as_deref(), Some("/x y"));
        let meta = pane.meta();
        assert_eq!(
            (meta.cursor_x, meta.cursor_y, meta.cursor_visible),
            (4, 2, false)
        );
        assert!(
            meta.mouse_standard
                && meta.mouse_sgr
                && !meta.mouse_all
                && !meta.mouse_button
                && !meta.mouse_utf8
        );
    }

    #[test]
    fn kill_hangs_up_then_returns_once_the_child_exits() {
        let (tx, rx) = channel();
        let pane = Pane::spawn("%7".into(), sh("echo ready; exec sleep 30"), 1000, tx).unwrap();
        wait_text(&pane, &rx, "ready");
        let start = Instant::now();
        pane.kill(Duration::from_secs(10));
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(wait_for(&rx, |e| *e
            == PaneEvent::Exited {
                generation: 1,
                status: Some(128 + libc::SIGHUP)
            }));
        assert_eq!(pane.root_pid(), None);
    }

    #[test]
    fn kill_escalates_to_sigkill_after_grace() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%8".into(),
            sh("trap '' HUP; echo ready; while :; do sleep 1; done"),
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "ready");
        let start = Instant::now();
        pane.kill(Duration::from_millis(300));
        assert!(start.elapsed() >= Duration::from_millis(300));
        assert!(wait_for(&rx, |e| *e
            == PaneEvent::Exited {
                generation: 1,
                status: Some(128 + libc::SIGKILL)
            }));
    }

    #[test]
    fn scrollback_keeps_history_lines() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%9".into(),
            sh("i=1; while [ $i -le 30 ]; do echo row$i; i=$((i+1)); done; sleep 2"),
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "row30");
        let (text, _) = pane.capture(Some(100), false);
        assert!(text.contains("row1\n"), "{text:?}");
    }

    #[test]
    fn exit_is_reported_after_the_child_closes_its_tty() {
        // The tty hangs up (no process has it open) a while before the child exits: the reader
        // stops polling it (else epoll reports the hang-up forever) and still sees the exit.
        let (tx, rx) = channel();
        let _pane = Pane::spawn(
            "%10".into(),
            sh("echo hi; exec sleep 1 </dev/null >/dev/null 2>&1"),
            1000,
            tx,
        )
        .unwrap();
        assert!(wait_for(&rx, |e| *e
            == PaneEvent::Exited {
                generation: 1,
                status: Some(0)
            }));
    }

    #[test]
    fn dropping_a_pane_ends_a_child_that_ignores_sighup_and_its_reader() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%11".into(),
            sh("trap '' HUP; echo ready; sleep 30"),
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "ready");
        let pid = pane.root_pid().unwrap() as libc::pid_t;
        let start = Instant::now();
        drop(pane);
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "drop blocked the caller"
        );
        // The reader thread holds the sink's only other sender: it is gone once the thread ends.
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                _ => assert!(Instant::now() < end, "reader thread still running"),
            }
        }
        // Reaped: the pid no longer exists.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }

    fn gone(pid: libc::pid_t) -> bool {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if unsafe { libc::kill(pid, 0) } == -1
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn kill_ends_a_descendant_that_ignores_sighup() {
        // The root exits on SIGHUP at once; the sleep in its group ignores it.
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%13".into(),
            sh(r#"sh -c 'trap "" HUP; echo "kid:$$:"; exec sleep 30' & wait"#),
            1000,
            tx,
        )
        .unwrap();
        let text = wait_text(&pane, &rx, "kid:");
        let kid: libc::pid_t = text
            .split("kid:")
            .nth(1)
            .unwrap()
            .split(':')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let start = Instant::now();
        pane.kill(Duration::from_millis(300));
        assert!(
            start.elapsed() >= Duration::from_millis(250),
            "returned before the group was empty"
        );
        assert!(gone(kid), "a descendant outlived kill");
    }

    #[test]
    fn a_fresh_console_frame_from_the_host_clears_into_history_homes_and_reaches_the_streams() {
        let (tx, rx) = channel();
        let pane = Pane::spawn("%15".into(), sh("printf 'one\\ntwo> '"), 1000, tx).unwrap();
        assert!(wait_for(&rx, |e| matches!(e, PaneEvent::Exited { .. })));
        let (_, seq) = pane.capture(None, false);
        pane.draw_from_host(FRESH_CONSOLE);
        let (visible, after) = pane.capture(None, false);
        assert_eq!(after, seq + 1);
        assert!(visible.trim().is_empty(), "{visible:?}");
        let (all, _) = pane.capture(Some(100), false);
        assert!(all.contains("one\ntwo>"), "{all:?}");
        assert!(wait_for(
            &rx,
            |e| matches!(e, PaneEvent::Output { seq: s, bytes } if *s == seq + 1 && &bytes[..] == FRESH_CONSOLE)
        ));
        // What is drawn next starts at the top left, as a new console's first line does.
        pane.draw_from_host(b"second");
        assert!(pane.capture(None, false).0.starts_with("second"));
    }

    #[test]
    fn respawn_draws_into_the_same_grid_and_continues_the_sequence() {
        let (tx, rx) = channel();
        let mut spec = sh("echo first");
        spec.cwd = Some("/".into());
        let pane = Pane::spawn("%14".into(), spec, 1000, tx).unwrap();
        assert!(wait_for(&rx, |e| matches!(e, PaneEvent::Exited { .. })));
        let (_, seq) = pane.capture(None, false);
        assert!(pane.root_pid().is_none());
        assert_eq!(pane.generation(), 1);
        assert_eq!(pane.respawn(sh("pwd; echo second; sleep 2")).unwrap(), 2);
        assert_eq!(pane.generation(), 2);
        assert!(pane.root_pid().is_some());
        // Not while the new child runs.
        assert!(pane.respawn(sh("true")).is_err());
        let text = wait_text(&pane, &rx, "second");
        assert!(text.contains("first"), "{text:?}");
        assert!(
            text.contains("\n/\n"),
            "the previous spawn directory: {text:?}"
        );
        assert!(pane.capture(None, false).1 > seq);
        assert_eq!(pane.cwd().as_deref(), Some("/"));
    }

    #[test]
    fn title_can_be_set_and_modes_and_tty_are_read() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%15".into(),
            sh(r#"printf '\033[?2004h\033[?1hready'; sleep 2"#),
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "ready");
        let mode = pane.mode();
        assert!(mode.contains(TermMode::BRACKETED_PASTE) && mode.contains(TermMode::APP_CURSOR));
        pane.set_title("set");
        assert_eq!(pane.title(), "set");
        assert!(pane.tty().starts_with("/dev/"), "{:?}", pane.tty());
    }

    #[test]
    fn children_do_not_see_the_pty_library_window_variables() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%12".into(),
            sh(r#"echo "w=${WINDOWID-unset} a=${ALACRITTY_WINDOW_ID-unset}"; sleep 2"#),
            1000,
            tx,
        )
        .unwrap();
        let text = wait_text(&pane, &rx, "w=");
        assert!(text.contains("w=unset a=unset"), "{text:?}");
    }

    /// What tmux 3.8 printed for the same output on a 20×6 pane (`capture-pane -p -e -N`,
    /// `-p -e -N -S -500 -E -1`, `-p -e -J -S -500 -E -1`, `-p -J -S -1 -E 0`), less the default
    /// blanks tmux pads a row with up to the cells it has allocated.
    #[test]
    fn snapshot_rows_are_capture_pane_rows_and_a_conversation_is_joined() {
        let (tx, rx) = channel();
        let script = r"stty -echo; printf 'line-1\n\033[44mblue\033[0m\033[44m      \033[0m\nCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n\033[42mgr\033[0m\033[45m   \033[0m\nDDDDDDDDDDDDDDDDDDDDDDDDD\nx4\nx5'; read x; printf '\nz1\nz2\nz3\nz4\nz5\nz6'; sleep 5";
        let pane = Pane::spawn(
            "%1".into(),
            PaneSpec {
                cols: 20,
                rows: 6,
                ..sh(script)
            },
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "x5");
        let snap = pane.snapshot(500, true);
        // One line per screen row: the wrapped D line is two, as tmux prints it.
        assert_eq!(
            snap.capture,
            "CCCCCCCCCC\n\x1b[42mgr\x1b[45m   \n\x1b[49mDDDDDDDDDDDDDDDDDDDD\nDDDDD\nx4\nx5\n"
        );
        assert_eq!(snap.capture.lines().count(), snap.meta.rows as usize);
        // The plain history is rows too: the C line's first row is the history's last line.
        assert_eq!(
            snap.history,
            "line-1\n\x1b[44mblue      \n\x1b[49mCCCCCCCCCCCCCCCCCCCC\n"
        );
        // Joined, that row is a line of its own that runs on into the screen.
        let conversation = snap.conversation.unwrap();
        assert_eq!(
            conversation.joined,
            "line-1\n\x1b[44mblue      \n\x1b[49mCCCCCCCCCCCCCCCCCCCC\n"
        );
        assert!(conversation.last_continues);
        assert_eq!(pane.snapshot(500, false).conversation, None);
        assert_eq!(pane.snapshot(0, true).history, "");

        pane.write(b"\n").unwrap();
        wait_text(&pane, &rx, "z6");
        let snap = pane.snapshot(500, true);
        assert_eq!(snap.capture, "z1\nz2\nz3\nz4\nz5\nz6\n");
        assert!(
            snap.history.ends_with("DDDDD\nx4\nx5\n"),
            "{:?}",
            snap.history
        );
        let conversation = snap.conversation.unwrap();
        assert!(
            conversation
                .joined
                .ends_with("\x1b[49mDDDDDDDDDDDDDDDDDDDDDDDDD\nx4\nx5\n"),
            "{:?}",
            conversation.joined
        );
        assert!(!conversation.last_continues);
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::{Duration, Instant};

    fn spec(command: &[&str]) -> PaneSpec {
        PaneSpec {
            command: command.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: HashMap::new(),
            cols: 80,
            rows: 24,
            clear_env: Vec::new(),
            seed: None,
        }
    }

    fn powershell(script: &str) -> PaneSpec {
        spec(&["powershell.exe", "-NoProfile", "-Command", script])
    }

    /// Wait until the visible screen contains `needle`; the screen then.
    fn wait_text(pane: &Pane, rx: &Receiver<(String, PaneEvent)>, needle: &str) -> String {
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            let (text, _) = pane.capture(None, false);
            if text.contains(needle) {
                return text;
            }
            assert!(Instant::now() < end, "no {needle:?} in {text:?}");
            let _ = rx.recv_timeout(Duration::from_millis(100));
        }
    }

    fn exit_of(rx: &Receiver<(String, PaneEvent)>) -> (u64, Option<i32>) {
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < end, "no exit");
            if let Ok((_, PaneEvent::Exited { generation, status })) =
                rx.recv_timeout(Duration::from_millis(100))
            {
                return (generation, status);
            }
        }
    }

    fn until(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
        let end = Instant::now() + timeout;
        while !f() {
            assert!(Instant::now() < end, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Whether process `pid` still runs.
    fn alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        };
        unsafe {
            let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if h.is_null() {
                return false;
            }
            let running = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
            CloseHandle(h);
            running
        }
    }

    /// A child that starts a process with a console of its own (CTRL_CLOSE_EVENT of the pane's
    /// console does not reach it, but it is in the pane's job), then prints `ready`.
    const DETACHED: &str = "Start-Process -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 60'; 'ready'; Start-Sleep 60";

    /// The job's pids other than the child's, once there is one.
    fn descendants(pane: &Pane) -> Vec<u32> {
        let root = pane.root_pid().unwrap();
        let mut found = Vec::new();
        until("a descendant in the job", Duration::from_secs(20), || {
            found = pane
                .job_pids()
                .unwrap()
                .into_iter()
                .filter(|&p| p != root)
                .collect();
            !found.is_empty()
        });
        found
    }

    #[test]
    fn output_reaches_the_grid_and_the_exit_status_is_reported() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%1".into(),
            spec(&["cmd.exe", "/c", "echo hello& exit 3"]),
            1000,
            tx,
        )
        .unwrap();
        assert_eq!(exit_of(&rx), (1, Some(3)));
        wait_text(&pane, &rx, "hello");
        assert_eq!(pane.root_pid(), None);
        assert!(pane.last_pid().is_some());
        assert_eq!(pane.tty(), "");
    }

    #[test]
    fn write_reaches_the_child() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%2".into(),
            powershell("$x = Read-Host 'prompt'; \"got:$x\"; Start-Sleep 30"),
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "prompt");
        pane.write(b"abc\r").unwrap();
        wait_text(&pane, &rx, "got:abc");
        pane.kill(Duration::from_secs(2));
    }

    #[test]
    fn kill_closes_the_console_and_returns_once_the_job_is_empty() {
        let (tx, rx) = channel();
        let pane =
            Pane::spawn("%3".into(), powershell("'ready'; Start-Sleep 60"), 1000, tx).unwrap();
        wait_text(&pane, &rx, "ready");
        let root = pane.root_pid().unwrap();
        assert_eq!(pane.job_pids().unwrap(), vec![root]);
        let start = Instant::now();
        // CTRL_CLOSE_EVENT ends it well inside the grace.
        pane.kill(Duration::from_secs(10));
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{:?}",
            start.elapsed()
        );
        assert_eq!(pane.job_pids().unwrap(), Vec::<u32>::new());
        assert_eq!(pane.root_pid(), None);
        until("the child exited", Duration::from_secs(5), || !alive(root));
        assert_eq!(exit_of(&rx).0, 1);
    }

    #[test]
    fn kill_terminates_a_descendant_outside_the_console_after_the_grace() {
        let (tx, rx) = channel();
        let pane = Pane::spawn("%4".into(), powershell(DETACHED), 1000, tx).unwrap();
        wait_text(&pane, &rx, "ready");
        let kids = descendants(&pane);
        let start = Instant::now();
        pane.kill(Duration::from_millis(500));
        assert!(
            start.elapsed() >= Duration::from_millis(450),
            "returned before the job was empty: {:?}",
            start.elapsed()
        );
        assert_eq!(pane.job_pids().unwrap(), Vec::<u32>::new());
        // A process leaves the job as it exits, a moment before its handle is signalled.
        until("the descendants exited", Duration::from_secs(5), || {
            kids.iter().all(|&kid| !alive(kid))
        });
        assert_eq!(exit_of(&rx).0, 1);
    }

    #[test]
    fn dropping_a_pane_ends_its_job_and_its_reader() {
        let (tx, rx) = channel();
        let pane = Pane::spawn("%5".into(), powershell(DETACHED), 1000, tx).unwrap();
        wait_text(&pane, &rx, "ready");
        let mut pids = descendants(&pane);
        pids.push(pane.root_pid().unwrap());
        let start = Instant::now();
        drop(pane);
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "drop blocked the caller"
        );
        // The reader thread holds the sink's only other sender: it is gone once the thread ends.
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Ok((_, PaneEvent::Exited { .. })) => panic!("a dropped pane reported an exit"),
                _ => assert!(Instant::now() < end, "reader thread still running"),
            }
        }
        until(
            "the job ended",
            SHUTDOWN_GRACE + Duration::from_secs(5),
            || pids.iter().all(|&p| !alive(p)),
        );
    }

    /// A respawned child's first line starts at the top left of a cleared screen, whatever ConPTY draws
    /// it: the inbox conhost clears on its own, OpenConsole (beside the test exe, as `fetch-conpty.ps1`
    /// and CI put it) does not (CI run 38696314864).
    #[test]
    fn a_respawned_child_starts_on_a_cleared_screen_at_the_top_left() {
        let (tx, rx) = channel();
        let pane = Pane::spawn(
            "%42".into(),
            powershell("Write-Host -NoNewline 'first-run PS> '"),
            1000,
            tx,
        )
        .unwrap();
        wait_text(&pane, &rx, "first-run");
        exit_of(&rx);
        pane.respawn(powershell("'second-run'; Start-Sleep 30"))
            .unwrap();
        let text = wait_text(&pane, &rx, "second-run");
        assert!(text.lines().any(|line| line == "second-run"), "{text:?}");
        assert!(!text.contains("first-run"), "{text:?}");
        assert!(pane.capture(Some(100), false).0.contains("first-run PS>"));
        pane.kill(Duration::from_secs(5));
    }

    #[test]
    fn a_respawned_child_gets_a_job_of_its_own() {
        let (tx, rx) = channel();
        let pane = Pane::spawn("%6".into(), powershell(DETACHED), 1000, tx).unwrap();
        wait_text(&pane, &rx, "ready");
        let first = descendants(&pane);
        pane.kill(Duration::from_millis(300));
        assert_eq!(exit_of(&rx).0, 1);
        assert_eq!(
            pane.respawn(spec(&[
                "cmd.exe",
                "/c",
                "echo second& ping -n 60 127.0.0.1 >nul"
            ]))
            .unwrap(),
            2
        );
        wait_text(&pane, &rx, "second");
        let root = pane.root_pid().unwrap();
        let mut pids = Vec::new();
        until("ping in the new job", Duration::from_secs(10), || {
            pids = pane.job_pids().unwrap();
            pids.len() >= 2
        });
        assert!(pids.contains(&root), "{pids:?} without {root}");
        assert!(
            first.iter().all(|p| !pids.contains(p)),
            "{pids:?} has {first:?}"
        );
        pane.kill(Duration::from_millis(300));
        assert_eq!(pane.job_pids().unwrap(), Vec::<u32>::new());
    }

    /// The pseudo console's close cannot wait on a drain of its output: a child flooding it is
    /// killed, or dropped, in bounded time.
    #[test]
    fn kill_and_drop_do_not_wait_on_a_flooding_child() {
        let flood = "while ($true) { [Console]::Out.Write('x' * 4096) }";
        let (tx, rx) = channel();
        let pane = Pane::spawn("%7".into(), powershell(flood), 1000, tx).unwrap();
        wait_text(&pane, &rx, "xxxx");
        let start = Instant::now();
        pane.kill(Duration::from_millis(500));
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "{:?}",
            start.elapsed()
        );
        assert_eq!(pane.job_pids().unwrap(), Vec::<u32>::new());
        exit_of(&rx);

        let (tx, rx) = channel();
        let pane = Pane::spawn("%8".into(), powershell(flood), 1000, tx).unwrap();
        wait_text(&pane, &rx, "xxxx");
        let root = pane.root_pid().unwrap();
        drop(pane);
        let end = Instant::now() + Duration::from_secs(15);
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                _ => assert!(Instant::now() < end, "reader thread still running"),
            }
        }
        until("the flooding child ended", Duration::from_secs(5), || {
            !alive(root)
        });
    }

    /// The child exits while a descendant on its console floods it: nothing reads the console's
    /// output any more, yet closing the console (after the exit is reported) does not wait for a
    /// drain, and the descendant gets CTRL_CLOSE_EVENT.
    #[test]
    fn the_close_after_an_exit_does_not_wait_on_a_flooding_descendant() {
        let script = "Start-Process -NoNewWindow powershell.exe -ArgumentList '-NoProfile','-Command','while ($true) { [Console]::Out.Write(''z'' * 4096) }'; Start-Sleep 2; exit 4";
        let (tx, rx) = channel();
        let pane = Pane::spawn("%10".into(), powershell(script), 1000, tx).unwrap();
        let kids = descendants(&pane);
        assert_eq!(exit_of(&rx), (1, Some(4)));
        drop(pane);
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                _ => assert!(Instant::now() < end, "the console's close is stuck"),
            }
        }
        until("the descendant ended", Duration::from_secs(10), || {
            kids.iter().all(|&kid| !alive(kid))
        });
    }

    /// The reader stalls (here: the screen lock held) while a child floods the console, so the
    /// output pipes fill up; the kill that follows still ends in bounded time.
    #[test]
    fn a_kill_after_the_output_backed_up_does_not_deadlock() {
        let flood = "while ($true) { [Console]::Out.Write('y' * 4096) }";
        let (tx, rx) = channel();
        let pane = Arc::new(Pane::spawn("%9".into(), powershell(flood), 1000, tx).unwrap());
        wait_text(&pane, &rx, "yyyy");
        let killer = {
            let screen = lock(&pane.screen);
            let pane = pane.clone();
            let killer = std::thread::spawn(move || {
                let start = Instant::now();
                pane.kill(Duration::from_millis(500));
                start.elapsed()
            });
            std::thread::sleep(Duration::from_secs(3));
            drop(screen);
            killer
        };
        let end = Instant::now() + Duration::from_secs(20);
        while !killer.is_finished() {
            assert!(Instant::now() < end, "kill deadlocked");
            std::thread::sleep(Duration::from_millis(100));
        }
        killer.join().unwrap();
        // The reader ends too (it holds the sink's only other sender).
        drop(pane);
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                _ => assert!(Instant::now() < end, "reader thread deadlocked"),
            }
        }
    }
}

#[cfg(test)]
mod seed_tests {
    use super::seed_bytes;

    #[test]
    fn a_seed_reads_with_crlf_and_no_row_for_its_last_break() {
        assert_eq!(seed_bytes(b"a\nb\n"), b"a\r\nb");
        assert_eq!(seed_bytes(b"a\r\nb\r\n"), b"a\r\nb");
        assert_eq!(seed_bytes(b"a\r\nb\nc"), b"a\r\nb\r\nc");
        assert_eq!(seed_bytes(b"a\n\n"), b"a\r\n");
    }
}
