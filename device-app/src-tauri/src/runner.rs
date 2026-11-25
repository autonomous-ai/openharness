//! Runs the effects the reducer asks for, on threads.

use crate::account::{self, Login, NO_RESULT};
use crate::cli::{self, Cli, HarnessCli, START_DEADLINE};
use crate::front::{FrontFeed, FrontSource};
use crate::install::{self, Shell};
use crate::loginitem::LoginItem;
use crate::logs;
use crate::open::Opener;
use crate::state::StateFile;
use crate::tabs::{Next, Out, POLL_EVERY, Select, TabApp, TabFollow, TabScripts, Typing, Written};
use crate::types::{Effect, Event, ExportFailure, Log, LoginEvent};
use crate::update::AppUpdater;
use crate::watch::{self, Watch};
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// What the runner reaches outside itself.
pub struct Doors {
    pub home: PathBuf,
    pub path_var: Option<OsString>,
    /// The fake CLI, in a debug build (`cli::cli_override`).
    pub cli_override: Option<PathBuf>,
    /// What runs the install's lines (`install::system_shell`).
    pub shell: Arc<dyn Shell>,
    pub login_item: Arc<dyn LoginItem>,
    pub state: Arc<dyn StateFile>,
    pub log: Arc<dyn Log>,
    /// What opens a page, the logs' zip and the desktop app (`open::system`).
    pub open: Arc<dyn Opener>,
    /// Which app is in front (`front::system`), started once with the runner.
    pub front: Arc<dyn FrontSource>,
    /// The terminal apps' tab scripts (`tabs::system`), which only the runner's tab thread calls.
    pub tabs: Arc<dyn TabScripts>,
    /// None where the app does not update itself.
    pub updater: Option<Arc<dyn AppUpdater>>,
}

pub struct Runner(Arc<Shared>);

/// What the runner and the threads it starts share.
struct Shared {
    doors: Doors,
    send: Arc<dyn Fn(Event) + Send + Sync>,
    /// What the last look found: every run uses it.
    cli: Mutex<Option<Arc<HarnessCli>>>,
    watch: Mutex<Option<Watch>>,
    /// The number of the watch whose events reach `send`. Apart from `watch`, as a watch's thread holds it and the
    /// watch must still go with the runner.
    watching: Arc<Mutex<u64>>,
    login: Mutex<Option<Login>>,
    /// What the watches have been told of the app in front. Taken inside `watch`, never around it.
    front: Mutex<FrontFeed>,
    /// The tab rules, apart: a watch's thread tells them too, and must not keep the runner.
    tabs: Arc<Tabs>,
}

/// The tab rules, and the word that they changed. Their lock is taken last, and never held across a script call, a
/// write or `send`.
#[derive(Default)]
struct Tabs {
    state: Mutex<TabState>,
    changed: Condvar,
}

#[derive(Default)]
struct TabState {
    follow: TabFollow,
    /// The number of the watch whose typings wait in `follow`: a new watch drops those of the one before, so they are
    /// all of one.
    typings_of: u64,
    /// The runner has gone: the tab thread ends.
    ended: bool,
}

/// The tab thread's next call, or the lines for the log that came with none.
enum Call {
    /// The oldest typing, and the number of the watch it came from: its answer goes to that watch alone.
    Typing(Next, u64),
    Select(Select),
    Poll(TabApp),
    Said(Vec<String>),
}

impl Tabs {
    /// A change to the rules, and a word to the tab thread: it may have something to do now.
    fn tell(&self, change: impl FnOnce(&mut TabFollow)) {
        change(&mut self.state.lock().unwrap().follow);
        self.changed.notify_one();
    }

    /// A typing from the watch numbered `number`, and a word to the tab thread. The line is its answer, and the log its
    /// lines, when the rules answer it at once.
    fn typed(&self, number: u64, typing: Typing) -> Out {
        let mut state = self.state.lock().unwrap();
        state.typings_of = number;
        let out = state.follow.typed(typing, Instant::now());
        drop(state);
        self.changed.notify_one();
        out
    }

    fn end(&self) {
        self.state.lock().unwrap().ended = true;
        self.changed.notify_one();
    }

    /// Waits for the next call: the oldest typing first, as its 500 ms bound is the tightest, then a waiting select,
    /// else a poll `every` after the last one began. With none to do it waits with no timer. None once the runner has
    /// gone, and what the rules said before it went is taken first.
    fn next(&self, every: Duration, polled_at: Option<Instant>) -> Option<Call> {
        let mut state = self.state.lock().unwrap();
        loop {
            let said = state.follow.said();
            if !said.is_empty() {
                return Some(Call::Said(said));
            }
            if state.ended {
                return None;
            }
            if let Some(next) = state.follow.next_typing(Instant::now()) {
                return Some(Call::Typing(next, state.typings_of));
            }
            if let Some(select) = state.follow.next_select(Instant::now()) {
                return Some(Call::Select(select));
            }
            let Some(app) = state.follow.polls() else {
                state = self.changed.wait(state).unwrap();
                continue;
            };
            // After a call that ran past a tick, one poll at once: the ticks it missed are not made up.
            let wait = polled_at.map_or(Duration::ZERO, |at| (at + every).saturating_duration_since(Instant::now()));
            if wait.is_zero() {
                return Some(Call::Poll(app));
            }
            state = self.changed.wait_timeout(state, wait).unwrap().0;
        }
    }

    /// A call's answer.
    fn answer(&self, answer: impl FnOnce(&mut TabFollow) -> Out) -> Out {
        answer(&mut self.state.lock().unwrap().follow)
    }
}

impl Runner {
    /// `send` hands the event to the app's loop and returns. It never runs an effect itself: a watch or a sign-in
    /// calls it holding a lock that stopping or cancelling it takes.
    pub fn new(doors: Doors, send: Arc<dyn Fn(Event) + Send + Sync>) -> Runner {
        Runner::polling_every(doors, send, POLL_EVERY)
    }

    fn polling_every(doors: Doors, send: Arc<dyn Fn(Event) + Send + Sync>, every: Duration) -> Runner {
        let shared = Arc::new(Shared {
            doors,
            send,
            cli: Mutex::new(None),
            watch: Mutex::new(None),
            watching: Arc::default(),
            login: Mutex::new(None),
            front: Mutex::default(),
            tabs: Arc::default(),
        });
        shared.refresh_login_item();
        // Weakly: the source keeps its callback for as long as it runs, and the runner must still go.
        let weak = Arc::downgrade(&shared);
        shared.doors.front.start(Box::new(move |value| {
            if let Some(shared) = weak.upgrade() {
                shared.front_changed(&value);
            }
        }));
        let following = shared.clone();
        thread::spawn(move || following.follow_tabs(every));
        Runner(shared)
    }

    /// Looks for the CLI now; the runs after it use what it found.
    pub fn find_cli(&self) -> bool {
        self.0.find_cli()
    }

    /// Menu, Show, ShowAbout, AboutCredits, Quit and Relaunch come back for the binary. Everything else is done here,
    /// anything slow on a thread, and answers through `send`.
    pub fn run(&self, effect: Effect) -> Option<Effect> {
        let shared = &self.0;
        match effect {
            Effect::Menu(_)
            | Effect::Show(_)
            | Effect::ShowAbout(_)
            | Effect::AboutCredits(_)
            | Effect::Quit
            | Effect::Relaunch => {
                return Some(effect);
            }
            Effect::FindCli => shared.answer(Event::Cli(shared.find_cli())),
            Effect::SpawnWatch => shared.spawn_watch(),
            // Its child then exits 0 by itself, and its WatchExit(Some(0)) is the answer.
            Effect::StopWatch => {
                let watch = shared.watch.lock().unwrap().take();
                if let Some(watch) = watch {
                    shared.tabs.tell(|follow| follow.watching(false));
                    watch.stop();
                }
            }
            Effect::RunStart => shared.with_cli(|cli| {
                let output = cli.run(&["start", "--if-down"], START_DEADLINE);
                Event::StartDone { ok: output.is_ok_and(|output| output.code == Some(0) && !output.timed_out) }
            }),
            Effect::RunInstall => {
                let shared = shared.clone();
                thread::spawn(move || {
                    let doors = &shared.doors;
                    let result = install::install(
                        std::env::consts::OS,
                        &*doors.shell,
                        &*doors.log,
                        &|| shared.find_cli(),
                        &mut |step| shared.answer(Event::InstallStep(step)),
                    );
                    shared.answer(Event::InstallDone(result));
                });
            }
            Effect::ReadAuth => shared.with_cli(|cli| Event::Auth(account::auth_status(cli))),
            Effect::ReadVersion => shared.with_cli(|cli| Event::CliVersion(cli::version(cli))),
            Effect::RunLogin => shared.run_login(),
            Effect::CancelLogin => {
                let login = shared.login.lock().unwrap().take();
                if let Some(login) = login {
                    login.cancel();
                }
            }
            // On the caller's thread: one short write, to the watch running now. With none the change has nowhere to
            // go, and the dial's next status shows it was not made.
            Effect::SetSound(on) => {
                if let Some(watch) = &*shared.watch.lock().unwrap() {
                    watch.sound(on);
                }
            }
            // As the sound: the watch's next status shows whether the change was made.
            Effect::SetNotify(mode) => {
                if let Some(watch) = &*shared.watch.lock().unwrap() {
                    watch.notify(mode);
                }
            }
            // As the sound: the check moves only when the dial's next status says so.
            Effect::SetVoice(lang) => {
                if let Some(watch) = &*shared.watch.lock().unwrap() {
                    watch.voice(lang);
                }
            }
            Effect::OpenUrl(url) => shared.open(|open| open.url(&url), "browser"),
            Effect::OpenDesktop => shared.open(|open| open.desktop(), "desktop app"),
            // On the caller's thread: one ServiceManagement call, once at start.
            Effect::RegisterLoginItem => {
                let registered = shared.doors.login_item.register();
                shared.doors.log.line(&match &registered {
                    Ok(()) => "login item: registered".to_string(),
                    Err(error) => format!("login item: {error}"),
                });
                shared.answer(Event::LoginItem(registered.is_ok()));
            }
            // On the caller's thread, in order: a later save never lands before an earlier one.
            Effect::Save(saved) => {
                if let Err(error) = shared.doors.state.save(&saved) {
                    shared.doors.log.line(&format!("state: could not save: {error}"));
                }
            }
            Effect::Log(text) => shared.doors.log.line(&text),
            Effect::CheckUpdate => shared.with_updater(|updater| match updater.check() {
                Ok(found) => Event::UpdateChecked(found),
                Err(failure) => Event::UpdateFailed(failure),
            }),
            Effect::DownloadUpdate => shared.with_updater(|updater| match updater.download() {
                Ok(()) => Event::UpdateDownloaded,
                Err(failure) => Event::UpdateFailed(failure),
            }),
            Effect::InstallUpdate => shared.with_updater(|updater| match updater.install() {
                Ok(()) => Event::UpdateInstalled,
                Err(failure) => Event::UpdateFailed(failure),
            }),
            // Not with_cli: its Cli(false) would leave the row waiting for an answer that never comes.
            Effect::ExportLogs => match shared.cli() {
                Some(cli) => {
                    let (send, home) = (shared.send.clone(), shared.doors.home.clone());
                    thread::spawn(move || send(Event::LogsExported(logs::export(&*cli, &home))));
                }
                None => shared.answer(Event::LogsExported(Err(ExportFailure::NoAnswer))),
            },
            Effect::Reveal(zip) => shared.open(|open| open.reveal(&zip), "logs"),
        }
        None
    }
}

/// The tab thread ends with the runner, once a call under way has answered.
impl Drop for Runner {
    fn drop(&mut self) {
        self.0.tabs.end();
    }
}

impl Shared {
    fn answer(&self, event: Event) {
        (self.send)(event);
    }

    /// The login item's refresh (`LoginItem::refresh`): a change or a failure is one log line.
    fn refresh_login_item(&self) {
        match self.doors.login_item.refresh() {
            Ok(false) => {}
            Ok(true) => self.doors.log.line("login item: updated"),
            Err(error) => self.doors.log.line(&format!("login item: {error}")),
        }
    }

    fn find_cli(&self) -> bool {
        let doors = &self.doors;
        let found = cli::find_cli(&doors.home, doors.path_var.as_deref(), doors.cli_override.as_deref())
            .map(|invocation| Arc::new(HarnessCli::new(invocation, doors.log.clone())));
        let there = found.is_some();
        *self.cli.lock().unwrap() = found;
        there
    }

    fn cli(&self) -> Option<Arc<HarnessCli>> {
        self.cli.lock().unwrap().clone()
    }

    /// `work` on a thread, with the CLI; Cli(false) at once when none is known.
    fn with_cli(&self, work: impl FnOnce(&HarnessCli) -> Event + Send + 'static) {
        let Some(cli) = self.cli() else { return self.answer(Event::Cli(false)) };
        let send = self.send.clone();
        thread::spawn(move || send(work(&cli)));
    }

    /// `work` on a thread, with the updater; UpdateChecked(None) at once where the app does not update itself.
    fn with_updater(&self, work: impl FnOnce(&dyn AppUpdater) -> Event + Send + 'static) {
        let Some(updater) = self.doors.updater.clone() else { return self.answer(Event::UpdateChecked(None)) };
        let send = self.send.clone();
        thread::spawn(move || send(work(&*updater)));
    }

    fn spawn_watch(self: &Arc<Self>) {
        let Some(cli) = self.cli() else { return self.answer(Event::Cli(false)) };
        let mut watch = self.watch.lock().unwrap();
        // Numbered before the watch it replaces stops: that one's late WatchExit(Some(0)) would read as the app
        // closing this one.
        let number = {
            let mut current = self.watching.lock().unwrap();
            *current += 1;
            // Before it can print: its first `attached` must not be undone by this.
            self.tabs.tell(|follow| follow.watching(true));
            *current
        };
        if let Some(old) = watch.take() {
            old.stop();
        }
        let (watching, send, tabs) = (self.watching.clone(), self.send.clone(), self.tabs.clone());
        let (selecting, selects) = (self.watching.clone(), self.tabs.clone());
        // Weakly: the watch's thread keeps its callbacks for as long as it runs, and the runner must still go.
        let typed = Arc::downgrade(self);
        let spawned = watch::spawn_watch(
            &*cli,
            self.doors.log.clone(),
            move |event| {
                // Held while the event is handed on, so once a newer watch has its number nothing more of this one is
                // sent.
                let current = watching.lock().unwrap();
                if *current == number {
                    match &event {
                        Event::WatchLine(status) => tabs.tell(|follow| follow.attached(status.attached)),
                        Event::WatchExit(_) => tabs.tell(|follow| follow.watching(false)),
                        _ => {}
                    }
                    send(event);
                }
            },
            move |app, tty, raise| {
                // Held through the tell, as above: a newer watch cannot take its number in between and have this
                // one's select run after it.
                let current = selecting.lock().unwrap();
                if *current == number {
                    selects.tell(|follow| follow.select(app, tty, raise, Instant::now()));
                }
            },
            move |typing| {
                if let Some(shared) = typed.upgrade() {
                    shared.typed(number, typing);
                }
            },
        );
        match spawned {
            Ok(started) => {
                // A change meanwhile waits on `watch`, held here: this watch is told the app in front once, by one of
                // the two.
                if let Some(line) = self.front.lock().unwrap().current() {
                    started.front(&line);
                }
                *watch = Some(started);
            }
            Err(error) => {
                // No lock is held across `send`.
                drop(watch);
                self.tabs.tell(|follow| follow.watching(false));
                // A CLI that went away is removed. One that is there and cannot run is a watch that ended: the
                // keep-alive tries it again in its own time, where a removed CLI is found again at every tick.
                self.answer(if error.kind() == io::ErrorKind::NotFound {
                    Event::Cli(false)
                } else {
                    Event::WatchExit(None)
                });
            }
        }
    }

    /// Each value the source tells, on its thread: the line, when it is new, to the watch running now. The value goes
    /// nowhere else.
    fn front_changed(&self, value: &str) {
        self.tabs.tell(|follow| follow.front(value));
        // `watch` first, as spawn_watch takes them.
        let watch = self.watch.lock().unwrap();
        let Some(line) = self.front.lock().unwrap().changed(value) else { return };
        if let Some(watch) = watch.as_ref() {
            watch.front(&line);
        }
    }

    /// A typing from the watch numbered `number`, on its thread. One the rules answer at once is answered to that watch,
    /// and logged, now: the devices wait on it, and the tab thread may be held for minutes.
    fn typed(&self, number: u64, typing: Typing) {
        // Held through the tell, as a select's: a newer watch cannot take its number in between and have this one's
        // typing run for it.
        let current = self.watching.lock().unwrap();
        if *current != number {
            return;
        }
        let out = self.tabs.typed(number, typing);
        drop(current);
        if let Some(line) = &out.line {
            self.wrote(number, line);
        }
        for line in out.log {
            self.doors.log.line(&line);
        }
    }

    /// A typing's answer, to the watch numbered `number` while it is the one running: a newer watch never hears of an
    /// older one's words.
    fn wrote(&self, number: u64, line: &str) {
        // `watch` first, as spawn_watch takes them, and held through the write.
        let watch = self.watch.lock().unwrap();
        if *self.watching.lock().unwrap() == number
            && let Some(watch) = watch.as_ref()
        {
            watch.wrote(line);
        }
    }

    /// The tab thread: one call at a time, until the runner goes. A tab line goes to the watch running now, a typing's
    /// answer to the watch it came from, and only each answer's outcome to the log.
    fn follow_tabs(&self, every: Duration) {
        let (scripts, started_at) = (&self.doors.tabs, Instant::now());
        let mut polled_at = None;
        while let Some(call) = self.tabs.next(every, polled_at) {
            let start = Instant::now();
            let app = match &call {
                Call::Select(select) => Some(select.app),
                Call::Poll(app) => {
                    polled_at = Some(start);
                    Some(*app)
                }
                // A typing is answered even when its app does not run.
                Call::Typing(..) | Call::Said(_) => None,
            };
            // An Apple Event to an app that is not running would launch it, and the app in front may have just quit.
            if app.is_some_and(|app| !scripts.running(app)) {
                continue;
            }
            let out = match call {
                Call::Said(log) => Out { line: None, log },
                Call::Typing(next, number) => {
                    let out = match next {
                        Next::Refused { line, log } => Out { line: Some(line), log: log.into_iter().collect() },
                        Next::Run(typing) => {
                            let app = typing.app();
                            // The terminal may have quit since the words, and an event would launch it again: one
                            // that does not run has no session.
                            let done = if !scripts.running(app) {
                                Ok(Written::NoSession)
                            } else {
                                match &typing {
                                    Typing::Write { tty, text, .. } => scripts.write_text(app, tty, text),
                                    Typing::Enter { tty, .. } => scripts.send_enter(app, tty),
                                }
                            };
                            self.tabs.answer(|follow| follow.written(&typing, done))
                        }
                    };
                    if let Some(line) = &out.line {
                        self.wrote(number, line);
                    }
                    out
                }
                Call::Select(Select { app, tty, frontmost, raise }) => {
                    let done =
                        if raise { scripts.focus_tty(app, &tty) } else { scripts.select_tty(app, &tty, frontmost) };
                    self.tabs.answer(|follow| follow.selected(app, done))
                }
                Call::Poll(app) => {
                    let answer = scripts.selected_tty(app);
                    // `watch` first, and held through the write: the line goes to the watch it was asked for.
                    let watch = self.watch.lock().unwrap();
                    let now = started_at.elapsed().as_secs();
                    let out = self.tabs.answer(|follow| follow.polled(app, answer, now));
                    if let (Some(line), Some(watch)) = (&out.line, watch.as_ref()) {
                        watch.tab(line);
                    }
                    out
                }
            };
            for line in out.log {
                self.doors.log.line(&line);
            }
        }
    }

    fn run_login(&self) {
        let Some(cli) = self.cli() else { return self.answer(Event::Cli(false)) };
        let mut login = self.login.lock().unwrap();
        // The app cannot tell one sign-in's events from another's. A sign-in sends nothing more once its cancel has
        // returned (account.rs), so the one this replaces is cancelled first.
        if let Some(old) = login.take() {
            old.cancel();
        }
        let send = self.send.clone();
        match account::login(&*cli, self.doors.log.clone(), move |event| send(event)) {
            Ok(started) => *login = Some(started),
            Err(_) => {
                // No lock is held across `send`.
                drop(login);
                self.answer(Event::Login(LoginEvent::Done(Err(NO_RESULT.into()))));
            }
        }
    }

    /// A failure is logged without what was opened: a sign-in URL carries its state in its query.
    fn open(&self, open: impl FnOnce(&dyn Opener) -> io::Result<()>, what: &str) {
        if let Err(error) = open(&*self.doors.open) {
            self.doors.log.line(&format!("{what}: could not open: {error}"));
        }
    }
}

// Every test runs the fake CLI, a shell script.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::account::NO_RESULT;
    use crate::app::App;
    use crate::front::{FrontSource, NoFront};
    use crate::install::{FINISH_IN_TERMINAL, GETTING_READY, INSTALLING_TMUX, NOT_INSTALLED, Place, Run, Shell, runs};
    use crate::loginitem::LoginItem;
    use crate::open::Opener;
    use crate::state::StateFile;
    use crate::tabs::{LATE_WRITE, NoTabs, Selected, TYPING_QUEUED, TabApp, TabError, TabScripts, Written};
    use crate::testing::{Fake, alive, fake_harness, wait_gone};
    use crate::types::{
        DialStatus, Effect, Event, ExportFailure, Exported, LoginEvent, MemoryLog, MenuItem, NotifyMode, Output, Saved,
        UpdateFailure, VoiceLang,
    };
    use crate::update::AppUpdater;
    use std::collections::VecDeque;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex, mpsc};
    use std::thread;
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(5);
    /// Second 0 of a minute.
    const B: u64 = 1794556800;
    const URL: &str = r#"{"type":"authorize_url","url":"https://id.example/a?state=S"}"#;
    const SUCCESS: &str = r#"{"type":"result","status":"success","email":"person@example.com"}"#;
    const FAILED: &str = r#"{"type":"result","status":"error","code":"BACKEND_ERROR","message":"fetch failed"}"#;
    const GHOSTTY: &str = "com.mitchellh.ghostty";
    const VSCODE: &str = "com.microsoft.VSCode";
    const GHOSTTY_LINE: &str = r#"{"front":"com.mitchellh.ghostty"}"#;
    const VSCODE_LINE: &str = r#"{"front":"com.microsoft.VSCode"}"#;
    /// What the app first tells every watch on its stdin: it answers each write and Enter line.
    const WRITES: &str = r#"{"writes":true}"#;
    /// A watch that keeps what it reads on its stdin until it is stopped.
    const RECORDING: [&str; 2] = [r#"{"attached":false}"#, "@record"];
    /// The same, with the dial attached.
    const ATTACHED: [&str; 2] = [r#"{"attached":true}"#, "@record"];
    const TERMINAL: &str = "com.apple.Terminal";
    const TERMINAL_LINE: &str = r#"{"front":"com.apple.Terminal"}"#;
    const TTY: &str = "/dev/ttys023";
    const OTHER: &str = "/dev/ttys024";
    const SELECT: &str = r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023"}}"#;
    const RAISE: &str = r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023","raise":true}}"#;
    /// Taps on agents in Ghostty, the one app that takes a typing: a tap's select runs with Ghostty in the back, where a
    /// swipe's does not.
    const TAP: &str = r#"{"select":{"app":"ghostty","tty":"/dev/ttys023","raise":true}}"#;
    const TAP_OTHER: &str = r#"{"select":{"app":"ghostty","tty":"/dev/ttys024","raise":true}}"#;
    const ID: &str = "0123456789abcdef";
    const NEXT_ID: &str = "00000000000000ff";
    const ENTER_ID: &str = "fedcba9876543210";
    const ENTER: &str = r#"{"enter":{"id":"fedcba9876543210","app":"ghostty","tty":"/dev/ttys023"}}"#;
    /// Every test runner's poll interval: short, so a test waits on calls, never on the clock.
    const EVERY: Duration = Duration::from_millis(20);
    const CHATGPT_LINE: &str = r#"{"front":"com.openai.codex"}"#;

    /// The doors besides the CLI. Each keeps what it was asked, and fails while `failing` is set.
    #[derive(Default)]
    struct Doubles {
        failing: AtomicBool,
        /// The home the next shell run puts a `harness` launcher in; None: the shell installs nothing.
        installs_into: Mutex<Option<PathBuf>>,
        /// The lines each shell run behind the Install screen hands its sink.
        prints: Mutex<Vec<String>>,
        ran: Mutex<Vec<String>>,
        /// `url <u>`, `reveal <zip>` or `desktop`.
        opened: Mutex<Vec<String>>,
        saved: Mutex<Vec<Saved>>,
        /// How many times the login item was refreshed, and whether a refresh changes it.
        refreshed: AtomicUsize,
        refresh_changes: AtomicBool,
    }

    impl Doubles {
        fn failing(&self) -> bool {
            self.failing.load(Ordering::SeqCst)
        }

        fn open(&self, what: String) -> io::Result<()> {
            self.opened.lock().unwrap().push(what);
            if self.failing() { Err(io::Error::other("no browser")) } else { Ok(()) }
        }
    }

    impl Opener for Doubles {
        fn url(&self, url: &str) -> io::Result<()> {
            self.open(format!("url {url}"))
        }

        fn reveal(&self, zip: &Path) -> io::Result<()> {
            self.open(format!("reveal {}", zip.display()))
        }

        fn desktop(&self) -> io::Result<()> {
            self.open("desktop".into())
        }
    }

    impl Shell for Doubles {
        fn run(&self, run: &Run, _deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output> {
            self.ran.lock().unwrap().push(run.line.to_string());
            if let Some(home) = self.installs_into.lock().unwrap().take() {
                put_launcher(&home);
            }
            // A terminal's lines are the person's: a run there hands the app none.
            if run.place == Place::Background {
                self.prints.lock().unwrap().iter().for_each(|printed| sink(printed));
            }
            Ok(Output { code: Some(0), ..Output::default() })
        }
    }

    impl LoginItem for Doubles {
        fn register(&self) -> Result<(), String> {
            if self.failing() { Err("Login item not set (error 1).".into()) } else { Ok(()) }
        }

        fn refresh(&self) -> Result<bool, String> {
            self.refreshed.fetch_add(1, Ordering::SeqCst);
            if self.failing() {
                return Err("Login item not set (error 1).".into());
            }
            Ok(self.refresh_changes.load(Ordering::SeqCst))
        }
    }

    impl StateFile for Doubles {
        fn load(&self) -> Saved {
            Saved::default()
        }

        fn save(&self, saved: &Saved) -> io::Result<()> {
            if self.failing() {
                return Err(io::Error::other("disk full"));
            }
            self.saved.lock().unwrap().push(*saved);
            Ok(())
        }
    }

    /// The app in front, as a test tells it: `now` at start, then each `tell`.
    struct Fronts {
        now: String,
        changed: Mutex<Option<Box<dyn Fn(String) + Send + Sync>>>,
    }

    impl Fronts {
        fn tell(&self, value: &str) {
            (self.changed.lock().unwrap().as_ref().expect("started"))(value.into());
        }
    }

    impl FrontSource for Fronts {
        fn start(&self, changed: Box<dyn Fn(String) + Send + Sync>) {
            changed(self.now.clone());
            *self.changed.lock().unwrap() = Some(changed);
        }
    }

    /// The tab scripts, as a test answers them: each call is kept as it starts, and an Apple Event's waits while the
    /// gate is shut. `running` sends none, so it never waits.
    #[derive(Default)]
    struct Scripts {
        not_running: AtomicBool,
        /// What selected_tty answers, in turn; the last one again once the others are used.
        ttys: Mutex<VecDeque<Result<Option<String>, TabError>>>,
        /// What write_text and send_enter answer, in turn; Done once the others are used.
        writes: Mutex<VecDeque<Result<Written, TabError>>>,
        calls: Mutex<Vec<String>>,
        called: Condvar,
        shut: Mutex<bool>,
        opened: Condvar,
        /// The calls under way now, and the most there ever were at once.
        inside: AtomicUsize,
        most: AtomicUsize,
    }

    impl Scripts {
        fn answering(ttys: &[&str]) -> Arc<Scripts> {
            let scripts = Scripts::default();
            *scripts.ttys.lock().unwrap() = ttys.iter().map(|tty| Ok(Some(tty.to_string()))).collect();
            Arc::new(scripts)
        }

        /// Waits until the calls so far pass `done`, and gives them.
        fn until(&self, done: impl Fn(&[String]) -> bool) -> Vec<String> {
            let calls = self.calls.lock().unwrap();
            let (calls, _) = self.called.wait_timeout_while(calls, WAIT, |calls| !done(calls)).unwrap();
            assert!(done(&calls), "{calls:?}");
            calls.clone()
        }

        /// Waits until `n` calls have started.
        fn calls(&self, n: usize) -> Vec<String> {
            self.until(|calls| calls.len() >= n)
        }

        /// Waits until `n` polls have started.
        fn polls(&self, n: usize) -> Vec<String> {
            self.until(|calls| calls.iter().filter(|call| call.starts_with("selected_tty")).count() >= n)
        }

        /// Waits until a call has started after the first one that starts with `prefix`: the tab thread has handled
        /// that one's answer.
        fn after(&self, prefix: &str) -> Vec<String> {
            self.until(|calls| {
                calls.iter().position(|call| call.starts_with(prefix)).is_some_and(|at| at + 1 < calls.len())
            })
        }

        /// The write_text and send_enter calls so far.
        fn typed(&self) -> Vec<String> {
            let calls = self.calls.lock().unwrap();
            calls
                .iter()
                .filter(|call| call.starts_with("write_text") || call.starts_with("send_enter"))
                .cloned()
                .collect()
        }

        fn written(&self) -> Result<Written, TabError> {
            self.writes.lock().unwrap().pop_front().unwrap_or(Ok(Written::Done))
        }

        /// No call starts for ten ticks: there are still `n`.
        fn still(&self, n: usize) {
            self.still_for(n, EVERY * 10);
        }

        /// No call starts for `wait`: there are still `n`.
        fn still_for(&self, n: usize, wait: Duration) {
            let calls = self.calls.lock().unwrap();
            let (calls, _) = self.called.wait_timeout_while(calls, wait, |calls| calls.len() == n).unwrap();
            assert_eq!(calls.len(), n, "{calls:?}");
        }

        fn gate(&self, shut: bool) {
            *self.shut.lock().unwrap() = shut;
            self.opened.notify_all();
        }

        fn record(&self, call: String) {
            self.calls.lock().unwrap().push(call);
            self.called.notify_all();
        }

        fn call(&self, call: String) {
            self.record(call);
            let inside = self.inside.fetch_add(1, Ordering::SeqCst) + 1;
            self.most.fetch_max(inside, Ordering::SeqCst);
            drop(self.opened.wait_while(self.shut.lock().unwrap(), |shut| *shut).unwrap());
            self.inside.fetch_sub(1, Ordering::SeqCst);
        }
    }

    impl TabScripts for Scripts {
        fn running(&self, app: TabApp) -> bool {
            self.record(format!("running {}", app.name()));
            !self.not_running.load(Ordering::SeqCst)
        }

        fn selected_tty(&self, app: TabApp) -> Result<Option<String>, TabError> {
            self.call(format!("selected_tty {}", app.name()));
            let mut ttys = self.ttys.lock().unwrap();
            if ttys.len() > 1 { ttys.pop_front().unwrap() } else { ttys.front().cloned().unwrap_or(Ok(None)) }
        }

        fn select_tty(&self, app: TabApp, tty: &str, frontmost: bool) -> Result<Selected, TabError> {
            self.call(format!("select_tty {} {tty} {}", app.name(), if frontmost { "front" } else { "back" }));
            Ok(Selected::Done)
        }

        fn focus_tty(&self, app: TabApp, tty: &str) -> Result<Selected, TabError> {
            self.call(format!("focus_tty {} {tty}", app.name()));
            Ok(Selected::Done)
        }

        fn write_text(&self, app: TabApp, tty: &str, text: &str) -> Result<Written, TabError> {
            self.call(format!("write_text {} {tty} {text}", app.name()));
            self.written()
        }

        fn send_enter(&self, app: TabApp, tty: &str) -> Result<Written, TabError> {
            self.call(format!("send_enter {} {tty}", app.name()));
            self.written()
        }
    }

    /// The app's own update, as a test answers it: each call is kept as it starts, and `check` waits while the gate is
    /// shut.
    struct Updates {
        check: Result<Option<String>, UpdateFailure>,
        download: Mutex<Result<(), UpdateFailure>>,
        install: Mutex<Result<(), UpdateFailure>>,
        calls: Mutex<Vec<&'static str>>,
        shut: Mutex<bool>,
        opened: Condvar,
    }

    impl Updates {
        fn answering(check: Result<Option<String>, UpdateFailure>, install: Result<(), UpdateFailure>) -> Arc<Updates> {
            Arc::new(Updates {
                check,
                download: Mutex::new(Ok(())),
                install: Mutex::new(install),
                calls: Mutex::default(),
                shut: Mutex::default(),
                opened: Condvar::new(),
            })
        }

        fn gate(&self, shut: bool) {
            *self.shut.lock().unwrap() = shut;
            self.opened.notify_all();
        }
    }

    impl AppUpdater for Updates {
        fn check(&self) -> Result<Option<String>, UpdateFailure> {
            self.calls.lock().unwrap().push("check");
            drop(self.opened.wait_while(self.shut.lock().unwrap(), |shut| *shut).unwrap());
            self.check.clone()
        }

        fn download(&self) -> Result<(), UpdateFailure> {
            self.calls.lock().unwrap().push("download");
            *self.download.lock().unwrap()
        }

        fn install(&self) -> Result<(), UpdateFailure> {
            self.calls.lock().unwrap().push("install");
            *self.install.lock().unwrap()
        }
    }

    /// A `harness` launcher in `home`'s `.local/bin` that says it is signed in: a link to the fake, with the folder it
    /// reads beside it. Linked, not written as a script: see testing::Fake on ETXTBSY.
    fn put_launcher(home: &Path) {
        let bin = home.join(".local").join("bin");
        fs::create_dir_all(bin.join("fake")).unwrap();
        fs::write(bin.join("fake").join("auth_status_--json"), "{\"loggedIn\":true}\n").unwrap();
        std::os::unix::fs::symlink(fake_harness(), bin.join("harness")).unwrap();
    }

    struct World {
        fake: Fake,
        home: tempfile::TempDir,
        doubles: Arc<Doubles>,
        events: mpsc::Receiver<Event>,
        runner: Runner,
    }

    impl World {
        /// The next event `send` was handed.
        fn next(&self) -> Event {
            self.events.recv_timeout(WAIT).expect("an event")
        }

        /// Runs an effect the binary does not get back, and gives its answer.
        fn answer(&self, effect: Effect) -> Event {
            assert_eq!(self.runner.run(effect), None);
            self.next()
        }

        /// Runs an install, and gives each step it told, then how it ended.
        fn install(&self) -> (Vec<&'static str>, Result<(), Vec<String>>) {
            assert_eq!(self.runner.run(Effect::RunInstall), None);
            let mut steps = Vec::new();
            loop {
                match self.next() {
                    Event::InstallStep(step) => steps.push(step),
                    Event::InstallDone(result) => return (steps, result),
                    other => panic!("not the install's: {other:?}"),
                }
            }
        }

        fn logged(&self, line: &str) -> bool {
            self.fake.log().lines().iter().any(|logged| logged == line)
        }

        /// Drops the runner, then gives every event still to come: all of them once each thread that could send has
        /// ended and let go of `send`.
        fn rest(self) -> Vec<Event> {
            let World { fake: _fake, home: _home, events, runner, .. } = self;
            drop(runner);
            let mut rest = Vec::new();
            loop {
                match events.recv_timeout(WAIT) {
                    Ok(event) => rest.push(event),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return rest,
                    Err(timeout) => panic!("{timeout}; so far {rest:?}"),
                }
            }
        }
    }

    fn world() -> World {
        world_where(|_| {})
    }

    /// A world with the CLI found, whose app in front is `now` when the runner starts.
    fn world_in_front_of(now: &str) -> (World, Arc<Fronts>) {
        let fronts = Arc::new(Fronts { now: now.into(), changed: Mutex::default() });
        let source = fronts.clone();
        let w = world_where(move |doors| doors.front = source);
        assert!(w.runner.find_cli());
        (w, fronts)
    }

    /// The same, with the tab scripts a test answers.
    fn world_with_tabs(now: &str, scripts: &Arc<Scripts>) -> (World, Arc<Fronts>) {
        let fronts = Arc::new(Fronts { now: now.into(), changed: Mutex::default() });
        let (source, tabs) = (fronts.clone(), scripts.clone());
        let w = world_where(move |doors| {
            doors.front = source;
            doors.tabs = tabs;
        });
        assert!(w.runner.find_cli());
        (w, fronts)
    }

    /// A fake CLI as the override, an empty home, the doubles, and a channel for what `send` is handed.
    fn world_where(change: impl FnOnce(&mut Doors)) -> World {
        let (fake, home, doubles) = (Fake::new(), tempfile::tempdir().unwrap(), Arc::new(Doubles::default()));
        let mut doors = doors(&fake, home.path(), &doubles);
        change(&mut doors);
        let (sender, events) = mpsc::channel();
        let send = Arc::new(move |event| {
            let _ = sender.send(event);
        });
        let runner = Runner::polling_every(doors, send, EVERY);
        World { fake, home, doubles, events, runner }
    }

    fn doors(fake: &Fake, home: &Path, doubles: &Arc<Doubles>) -> Doors {
        Doors {
            home: home.to_path_buf(),
            // The system's folders, which the fake's tools are in; never the developer's PATH, where a `harness` would
            // be found.
            path_var: Some("/usr/bin:/bin".into()),
            cli_override: Some(fake.program()),
            shell: doubles.clone(),
            login_item: doubles.clone(),
            state: doubles.clone(),
            log: fake.log(),
            open: doubles.clone(),
            front: Arc::new(NoFront),
            tabs: Arc::new(NoTabs),
            updater: None,
        }
    }

    fn sign_in(event: LoginEvent) -> Event {
        Event::Login(event)
    }

    fn browser() -> Event {
        sign_in(LoginEvent::AuthorizeUrl("https://id.example/a?state=S".into()))
    }

    fn no_dial() -> Event {
        Event::WatchLine(DialStatus {
            attached: false,
            fw: None,
            hw: None,
            board: None,
            updating: None,
            problem: None,
            muted: None,
            notify: None,
            voice_lang: None,
        })
    }

    fn a_dial() -> Event {
        Event::WatchLine(DialStatus {
            attached: true,
            fw: None,
            hw: None,
            board: None,
            updating: None,
            problem: None,
            muted: None,
            notify: None,
            voice_lang: None,
        })
    }

    fn tab(tty: &str) -> String {
        format!(r#"{{"tab":{{"app":"terminal-app","tty":"{tty}"}}}}"#)
    }

    /// A watch's write line of `text` for Ghostty's tty TTY.
    fn write(id: &str, text: &str) -> String {
        format!(r#"{{"write":{{"id":"{id}","app":"ghostty","tty":"{TTY}","text":"{text}"}}}}"#)
    }

    fn wrote(id: &str, ok: bool) -> String {
        format!(r#"{{"wrote":{{"id":"{id}","ok":{ok}}}}}"#)
    }

    /// The `tabs:` lines of the log.
    fn tabs_said(log: &MemoryLog) -> Vec<String> {
        log.lines().into_iter().filter(|line| line.starts_with("tabs:")).collect()
    }

    #[test]
    fn each_effect_gives_its_answer() {
        let w = world();
        assert!(w.runner.find_cli());
        assert_eq!(w.answer(Effect::FindCli), Event::Cli(true));
        w.fake.script("start --if-down", &[]);
        assert_eq!(w.answer(Effect::RunStart), Event::StartDone { ok: true });
        w.fake.script("start --if-down", &["@exit 1"]);
        assert_eq!(w.answer(Effect::RunStart), Event::StartDone { ok: false });
        w.fake.script("auth status --json", &[r#"{"loggedIn":false}"#]);
        assert_eq!(w.answer(Effect::ReadAuth), Event::Auth(Some(false)));
        w.fake.script("--version", &["0.6.58"]);
        assert_eq!(w.answer(Effect::ReadVersion), Event::CliVersion(Some("0.6.58".into())));
        w.fake.script("login --json", &[URL, SUCCESS]);
        assert_eq!(w.answer(Effect::RunLogin), browser());
        assert_eq!(w.next(), sign_in(LoginEvent::Done(Ok(()))));
        assert_eq!(w.answer(Effect::RegisterLoginItem), Event::LoginItem(true));
        assert!(w.logged("login item: registered"));
        let saved = Saved { cli_seen: true, ..Saved::default() };
        assert_eq!(w.runner.run(Effect::Save(saved)), None);
        assert_eq!(*w.doubles.saved.lock().unwrap(), [saved]);
        assert_eq!(w.runner.run(Effect::Log("menu: No dial | Quit".into())), None);
        assert!(w.logged("menu: No dial | Quit"));
        assert_eq!(
            w.fake.calls(),
            ["start --if-down", "start --if-down", "auth status --json", "--version", "login --json"]
        );
    }

    #[test]
    fn a_door_that_fails_is_one_log_line() {
        let w = world();
        w.doubles.failing.store(true, Ordering::SeqCst);
        assert_eq!(w.answer(Effect::RegisterLoginItem), Event::LoginItem(false));
        let url = Effect::OpenUrl("https://id.example/a".into());
        let reveal = Effect::Reveal(PathBuf::from("/tmp/harness-logs-20261118-1030.zip"));
        for effect in [Effect::Save(Saved::default()), url, Effect::OpenDesktop, reveal] {
            assert_eq!(w.runner.run(effect), None);
        }
        assert_eq!(
            w.fake.log().lines(),
            [
                "login item: Login item not set (error 1).",
                "state: could not save: disk full",
                "browser: could not open: no browser",
                "desktop app: could not open: no browser",
                "logs: could not open: no browser",
            ]
        );
    }

    #[test]
    fn a_cli_that_vanished_says_so() {
        let w = world();
        assert!(w.runner.find_cli());
        fs::remove_file(w.fake.program()).unwrap();
        assert_eq!(w.answer(Effect::SpawnWatch), Event::Cli(false));
        // A sign-in that cannot start is one that did not finish: its screen offers Retry.
        assert_eq!(w.answer(Effect::RunLogin), sign_in(LoginEvent::Done(Err(NO_RESULT.into()))));
    }

    #[test]
    fn without_a_cli_what_needs_one_says_so() {
        let w = world_where(|doors| doors.cli_override = None);
        assert!(!w.runner.find_cli());
        let needs_one = [Effect::SpawnWatch, Effect::RunStart, Effect::ReadAuth, Effect::ReadVersion, Effect::RunLogin];
        for effect in needs_one {
            assert_eq!(w.answer(effect.clone()), Event::Cli(false), "{effect:?}");
        }
        assert!(w.fake.calls().is_empty());
    }

    #[test]
    fn a_watch_that_cannot_start_has_ended() {
        // A CLI that is there and cannot run is not one that went away (the menu would call it removed and the next
        // tick find it again, over and over): it is a watch that ended, which the keep-alive tries again in its time.
        let w = world_where(|doors| {
            let not_a_program = doors.home.join("harness");
            fs::write(&not_a_program, "").unwrap();
            doors.cli_override = Some(not_a_program);
        });
        assert!(w.runner.find_cli());
        assert_eq!(w.answer(Effect::SpawnWatch), Event::WatchExit(None));
        let lines = w.fake.log().lines();
        let said = |line: &String| line.starts_with("harness hardware watch --json: could not start: ");
        assert!(lines.iter().any(said), "{lines:?}");
    }

    #[test]
    fn an_install_counts_only_when_a_cli_is_there() {
        let w = world_where(|doors| doors.cli_override = None);
        assert_eq!(w.install().1, Err(vec![NOT_INSTALLED.into()]));
        *w.doubles.installs_into.lock().unwrap() = Some(w.home.path().to_path_buf());
        assert_eq!(w.install().1, Ok(()));
        // This OS's runs, in order, each time.
        let lines: Vec<&str> = runs(std::env::consts::OS).iter().map(|run| run.line).collect();
        assert_eq!(*w.doubles.ran.lock().unwrap(), [lines.as_slice(), lines.as_slice()].concat());
        // The CLI the install found is the one the runs after it use.
        assert_eq!(w.answer(Effect::ReadAuth), Event::Auth(Some(true)));
    }

    #[test]
    fn the_login_item_is_refreshed_at_start_and_not_by_an_install() {
        let w = world();
        assert_eq!(w.doubles.refreshed.load(Ordering::SeqCst), 1);
        // A refresh that changed nothing says nothing.
        assert!(!w.fake.log().lines().iter().any(|line| line.starts_with("login item: ")));
        assert_eq!(w.install().1, Ok(()));
        assert_eq!(w.doubles.refreshed.load(Ordering::SeqCst), 1);

        // A start's refresh that changed the item, or could not, is one line.
        let changes = Arc::new(Doubles::default());
        changes.refresh_changes.store(true, Ordering::SeqCst);
        let w = world_where(|doors| doors.login_item = changes.clone());
        assert!(w.logged("login item: updated"));
        let failing = Arc::new(Doubles::default());
        failing.failing.store(true, Ordering::SeqCst);
        let w = world_where(|doors| doors.login_item = failing.clone());
        assert!(w.logged("login item: Login item not set (error 1)."));
    }

    #[test]
    fn an_install_tells_its_steps() {
        let w = world();
        *w.doubles.prints.lock().unwrap() = vec!["▸ Installing the managed tmux into /x".into()];
        // Linux's host half runs first, in a terminal.
        let steps: &[&str] = if cfg!(target_os = "linux") {
            &[FINISH_IN_TERMINAL, GETTING_READY, INSTALLING_TMUX]
        } else {
            &[INSTALLING_TMUX]
        };
        assert_eq!(w.install(), (steps.to_vec(), Ok(())));
    }

    #[test]
    fn what_opens_is_fixed() {
        let w = world();
        for effect in [Effect::OpenDesktop, Effect::OpenUrl("https://id.example/a?state=S".into())] {
            assert_eq!(w.runner.run(effect), None);
        }
        assert_eq!(*w.doubles.opened.lock().unwrap(), ["desktop", "url https://id.example/a?state=S"]);
    }

    #[test]
    fn an_export_gives_the_zip() {
        let w = world();
        assert!(w.runner.find_cli());
        let zip = w.home.path().join("Desktop").join("harness-logs-20261118-1030.zip");
        let answer = serde_json::json!({ "path": zip, "included": ["harness.log"], "bytes": 9 }).to_string();
        w.fake.script("logs export --json", &[&answer]);
        let shown = "~/Desktop/harness-logs-20261118-1030.zip".to_string();
        assert_eq!(w.answer(Effect::ExportLogs), Event::LogsExported(Ok(Exported { zip, shown })));
        assert_eq!(w.fake.calls(), ["logs export --json"]);
    }

    #[test]
    fn an_export_with_no_cli_still_answers() {
        let no_answer = Event::LogsExported(Err(ExportFailure::NoAnswer));
        let w = world_where(|doors| doors.cli_override = None);
        assert!(!w.runner.find_cli());
        assert_eq!(w.answer(Effect::ExportLogs), no_answer);

        // Gone between the look and the click: the row must not wait on an export that never ran.
        let w = world();
        assert!(w.runner.find_cli());
        fs::remove_file(w.fake.program()).unwrap();
        assert_eq!(w.answer(Effect::ExportLogs), no_answer);
    }

    #[test]
    fn the_reveal_is_one_fixed_open() {
        let w = world();
        let zip = "/Users/p/Desktop/harness-logs-20261118-1030.zip";
        assert_eq!(w.runner.run(Effect::Reveal(PathBuf::from(zip))), None);
        assert_eq!(*w.doubles.opened.lock().unwrap(), [format!("reveal {zip}")]);
    }

    #[test]
    fn the_binary_gets_its_four_effects_back() {
        let w = world();
        assert!(w.runner.find_cli());
        let about = Effect::ShowAbout(Some("Harness 0.6.58".into()));
        for effect in [Effect::Menu(vec![MenuItem::Separator]), Effect::Show(None), about, Effect::Quit] {
            assert_eq!(w.runner.run(effect.clone()), Some(effect));
        }
        let others = [
            Effect::FindCli,
            Effect::SpawnWatch,
            Effect::StopWatch,
            Effect::RunStart,
            Effect::RunInstall,
            Effect::ReadAuth,
            Effect::ReadVersion,
            Effect::RunLogin,
            Effect::CancelLogin,
            Effect::SetSound(true),
            Effect::SetNotify(NotifyMode::You),
            Effect::SetVoice(VoiceLang::Vi),
            Effect::OpenUrl("https://id.example/a".into()),
            Effect::OpenDesktop,
            Effect::RegisterLoginItem,
            Effect::Save(Saved::default()),
            Effect::Log("menu: Quit".into()),
            Effect::ExportLogs,
            Effect::Reveal(PathBuf::from("/tmp/harness-logs-20261118-1030.zip")),
        ];
        for effect in others {
            assert_eq!(w.runner.run(effect.clone()), None, "{effect:?}");
        }
    }

    #[test]
    fn the_about_credits_are_the_binarys() {
        let w = world();
        for effect in [Effect::AboutCredits(None), Effect::AboutCredits(Some("Harness 0.6.58".into()))] {
            assert_eq!(w.runner.run(effect.clone()), Some(effect));
        }
    }

    #[test]
    fn relaunch_is_the_binarys() {
        let w = world();
        assert_eq!(w.runner.run(Effect::Relaunch), Some(Effect::Relaunch));
    }

    #[test]
    fn an_update_check_runs_on_its_own_thread() {
        let updates = Updates::answering(Ok(Some("0.1.3".into())), Ok(()));
        let door = updates.clone();
        let w = world_where(move |doors| doors.updater = Some(door));
        updates.gate(true);
        assert_eq!(w.runner.run(Effect::CheckUpdate), None);
        // Run here, the check would still hold the caller; on its thread it has not answered yet.
        assert!(w.events.try_recv().is_err());
        updates.gate(false);
        assert_eq!(w.next(), Event::UpdateChecked(Some("0.1.3".into())));
        assert_eq!(*updates.calls.lock().unwrap(), ["check"]);
    }

    #[test]
    fn a_check_a_download_or_an_install_answers_its_failure() {
        let updates = Updates::answering(Err(UpdateFailure::Check), Ok(()));
        let door = updates.clone();
        let w = world_where(move |doors| doors.updater = Some(door));
        assert_eq!(w.answer(Effect::CheckUpdate), Event::UpdateFailed(UpdateFailure::Check));
        *updates.download.lock().unwrap() = Err(UpdateFailure::NotWritable);
        assert_eq!(w.answer(Effect::DownloadUpdate), Event::UpdateFailed(UpdateFailure::NotWritable));
        *updates.install.lock().unwrap() = Err(UpdateFailure::Install);
        assert_eq!(w.answer(Effect::InstallUpdate), Event::UpdateFailed(UpdateFailure::Install));
        assert_eq!(*updates.calls.lock().unwrap(), ["check", "download", "install"]);
    }

    #[test]
    fn a_download_then_an_install_reach_the_door_in_order() {
        let updates = Updates::answering(Ok(Some("0.1.3".into())), Ok(()));
        let door = updates.clone();
        let w = world_where(move |doors| doors.updater = Some(door));
        assert_eq!(w.answer(Effect::DownloadUpdate), Event::UpdateDownloaded);
        assert_eq!(w.answer(Effect::InstallUpdate), Event::UpdateInstalled);
        assert_eq!(*updates.calls.lock().unwrap(), ["download", "install"]);
    }

    #[test]
    fn with_no_updater_a_check_finds_nothing() {
        let w = world();
        assert_eq!(w.answer(Effect::CheckUpdate), Event::UpdateChecked(None));
        assert_eq!(w.answer(Effect::DownloadUpdate), Event::UpdateChecked(None));
        assert_eq!(w.answer(Effect::InstallUpdate), Event::UpdateChecked(None));
    }

    #[test]
    fn a_second_watch_replaces_the_first() {
        let w = world();
        assert!(w.runner.find_cli());
        w.fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@stdin"]);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        let pids = w.fake.pids();
        assert!(wait_gone(pids[0]));
        assert!(alive(pids[1]));
        // Stopped, never killed: a killed run leaves no line in ends.log.
        assert_eq!(w.fake.ends(), ["hardware watch --json"]);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert!(wait_gone(pids[1]));
        assert_eq!(w.fake.ends(), ["hardware watch --json", "hardware watch --json"]);
        // The first's own WatchExit(Some(0)) never came: it would read as the app closing the second.
        assert_eq!(w.rest(), []);
    }

    #[test]
    fn the_app_in_front_is_written_to_the_watch() {
        let (w, fronts) = world_in_front_of(GHOSTTY);
        w.fake.script("hardware watch --json", &RECORDING);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        fronts.tell(VSCODE);
        // An app with no name: the watch takes it as no listed app in front.
        fronts.tell("");
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES, GHOSTTY_LINE, VSCODE_LINE, r#"{"front":""}"#]);
    }

    #[test]
    fn a_sound_change_is_written_to_the_watch() {
        let (off, on) = (r#"{"muted":true}"#, r#"{"muted":false}"#);
        let w = world();
        assert!(w.runner.find_cli());
        w.fake.script("hardware watch --json", &RECORDING);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.runner.run(Effect::SetSound(false)), None);
        assert_eq!(w.runner.run(Effect::SetSound(true)), None);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES, off, on]);
        // With no watch running there is nothing to write to.
        assert_eq!(w.runner.run(Effect::SetSound(false)), None);
        assert_eq!(w.fake.stdin(), [WRITES, off, on]);
        let lines = w.fake.log().lines();
        assert!(lines.iter().all(|line| !line.contains("muted")), "{lines:?}");
        assert_eq!(w.rest(), []);
    }

    #[test]
    fn a_notifications_change_is_written_to_the_watch() {
        let (you, full) = (r#"{"notify":"you"}"#, r#"{"notify":"full"}"#);
        let w = world();
        assert!(w.runner.find_cli());
        w.fake.script("hardware watch --json", &RECORDING);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.runner.run(Effect::SetNotify(NotifyMode::You)), None);
        assert_eq!(w.runner.run(Effect::SetNotify(NotifyMode::Full)), None);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES, you, full]);
        // With no watch running there is nothing to write to.
        assert_eq!(w.runner.run(Effect::SetNotify(NotifyMode::You)), None);
        assert_eq!(w.fake.stdin(), [WRITES, you, full]);
        let lines = w.fake.log().lines();
        assert!(lines.iter().all(|line| !line.contains("notify")), "{lines:?}");
        assert_eq!(w.rest(), []);
    }

    #[test]
    fn a_voice_change_is_written_to_the_watch() {
        let (vi, ja) = (r#"{"voiceLang":"vi"}"#, r#"{"voiceLang":"ja"}"#);
        let w = world();
        assert!(w.runner.find_cli());
        w.fake.script("hardware watch --json", &RECORDING);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.runner.run(Effect::SetVoice(VoiceLang::Vi)), None);
        assert_eq!(w.runner.run(Effect::SetVoice(VoiceLang::Ja)), None);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [vi, ja]);
        // With no watch running there is nothing to write to.
        assert_eq!(w.runner.run(Effect::SetVoice(VoiceLang::Vi)), None);
        assert_eq!(w.fake.stdin(), [vi, ja]);
        let lines = w.fake.log().lines();
        assert!(lines.iter().all(|line| !line.contains("voiceLang")), "{lines:?}");
        assert_eq!(w.rest(), []);
    }

    #[test]
    fn a_new_watch_is_told_the_app_in_front_once() {
        let (w, fronts) = world_in_front_of(GHOSTTY);
        w.fake.script("hardware watch --json", &RECORDING);
        // In front before any watch ran: the first is told it as it starts.
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES, GHOSTTY_LINE]);
        // Changed while no watch ran: the next is told the new one.
        fronts.tell(VSCODE);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES, GHOSTTY_LINE, WRITES, VSCODE_LINE]);
        // A watch that replaces a running one is told it too, once.
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert!(wait_gone(w.fake.pids()[2]));
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        let watches = [WRITES, GHOSTTY_LINE, WRITES, VSCODE_LINE, WRITES, VSCODE_LINE, WRITES, VSCODE_LINE];
        assert_eq!(w.fake.stdin(), watches);
    }

    #[test]
    fn a_repeat_writes_nothing() {
        let (w, fronts) = world_in_front_of(GHOSTTY);
        w.fake.script("hardware watch --json", &RECORDING);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        for value in [GHOSTTY, VSCODE, VSCODE, GHOSTTY, GHOSTTY] {
            fronts.tell(value);
        }
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES, GHOSTTY_LINE, VSCODE_LINE, GHOSTTY_LINE]);
    }

    #[test]
    fn nothing_of_the_front_is_logged() {
        let (w, fronts) = world_in_front_of(GHOSTTY);
        // A watch that ends by itself: the runner still holds it, and the next value is written to its closed pipe.
        w.fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@wait end"]);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        fronts.tell(VSCODE);
        fronts.tell(VSCODE);
        w.fake.touch("end");
        assert_eq!(w.next(), Event::WatchExit(Some(0)));
        fronts.tell(GHOSTTY);
        let (log, doubles) = (w.fake.log(), w.doubles.clone());
        assert_eq!(w.rest(), []);
        let lines = log.lines();
        assert!(lines.iter().any(|line| line == "harness hardware watch --json: exit 0"), "{lines:?}");
        assert!(lines.iter().all(|line| !line.contains("ghostty") && !line.contains("VSCode")), "{lines:?}");
        assert!(doubles.saved.lock().unwrap().is_empty());
    }

    #[test]
    fn the_selected_tab_is_written_to_the_watch_with_terminal_in_front_and_the_dial_attached() {
        let scripts = Scripts::answering(&[TTY]);
        let (w, _fronts) = world_with_tabs(TERMINAL, &scripts);
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        // Each poll asks first whether Terminal runs, and the second starts once the first one's line is written.
        assert_eq!(
            scripts.polls(2)[..4],
            ["running Terminal", "selected_tty Terminal", "running Terminal", "selected_tty Terminal"]
        );
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES.to_string(), TERMINAL_LINE.to_string(), tab(TTY)]);
    }

    #[test]
    fn nothing_is_asked_with_another_app_in_front_no_watch_or_no_dial() {
        let scripts = Scripts::answering(&[TTY]);
        let (w, fronts) = world_with_tabs(VSCODE, &scripts);
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        scripts.still(0);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        // Terminal in front, and no watch.
        fronts.tell(TERMINAL);
        scripts.still(0);
        // A watch, and no dial.
        w.fake.script("hardware watch --json", &RECORDING);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        scripts.still(0);
        // All three: it asks.
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        assert_eq!(scripts.polls(1)[..2], ["running Terminal", "selected_tty Terminal"]);
    }

    #[test]
    fn a_change_of_tab_is_one_line_and_a_repeat_none() {
        let scripts = Scripts::answering(&[TTY, TTY, OTHER, OTHER]);
        let (w, _fronts) = world_with_tabs(TERMINAL, &scripts);
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        // The fifth starts once the first four answers are handled.
        scripts.polls(5);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES.to_string(), TERMINAL_LINE.to_string(), tab(TTY), tab(OTHER)]);
    }

    #[test]
    fn asking_stops_when_another_app_comes_to_the_front() {
        let scripts = Scripts::answering(&[TTY]);
        let (w, fronts) = world_with_tabs(TERMINAL, &scripts);
        w.fake.script("hardware watch --json", &ATTACHED);
        scripts.gate(true);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        scripts.polls(1);
        // The call under way as VS Code comes to the front is the last, and its answer is written nowhere.
        fronts.tell(VSCODE);
        scripts.gate(false);
        scripts.still(2);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES, TERMINAL_LINE, VSCODE_LINE]);
    }

    #[test]
    fn asking_stops_when_the_watch_ends_or_the_dial_detaches() {
        let scripts = Scripts::answering(&[TTY]);
        let (w, _fronts) = world_with_tabs(TERMINAL, &scripts);
        w.fake.script("hardware watch --json", &[r#"{"attached":true}"#, "@wait end"]);
        scripts.gate(true);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        scripts.polls(1);
        w.fake.touch("end");
        assert_eq!(w.next(), Event::WatchExit(Some(0)));
        scripts.gate(false);
        scripts.still(2);

        // A world of its own: the call let go above may still be at the gate, and the gate shut again would hold it.
        let scripts = Scripts::answering(&[TTY]);
        let (w, _fronts) = world_with_tabs(TERMINAL, &scripts);
        let detaching = [r#"{"attached":true}"#, "@wait detach", r#"{"attached":false}"#, "@stdin"];
        w.fake.script("hardware watch --json", &detaching);
        scripts.gate(true);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        scripts.polls(1);
        w.fake.touch("detach");
        assert_eq!(w.next(), no_dial());
        scripts.gate(false);
        scripts.still(2);
    }

    #[test]
    fn a_select_from_the_watch_runs_once_and_says_whether_its_app_is_in_front() {
        let scripts = Arc::new(Scripts::default());
        let (w, fronts) = world_with_tabs(TERMINAL, &scripts);
        let selecting = [r#"{"attached":false}"#, "@wait one", SELECT, "@wait two", SELECT, "@stdin"];
        w.fake.script("hardware watch --json", &selecting);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        w.fake.touch("one");
        assert_eq!(scripts.calls(2), ["running Terminal", "select_tty Terminal /dev/ttys023 front"]);
        fronts.tell(VSCODE);
        w.fake.touch("two");
        assert_eq!(scripts.calls(4)[2..], ["running Terminal", "select_tty Terminal /dev/ttys023 back"]);
        scripts.still(4);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        let log = w.fake.log();
        assert_eq!(w.rest(), []);
        let said: Vec<String> = log.lines().into_iter().filter(|line| line.starts_with("tabs:")).collect();
        assert_eq!(said, ["tabs: Terminal select ok", "tabs: Terminal select ok"]);
    }

    #[test]
    fn a_select_that_raises_runs_focus_tty_and_one_that_does_not_runs_select_tty() {
        let scripts = Arc::new(Scripts::default());
        // Another app in front: a tap's `open -b` is bringing Terminal forward.
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        w.fake.script("hardware watch --json", &[r#"{"attached":false}"#, RAISE, "@wait two", SELECT, "@stdin"]);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(scripts.calls(2), ["running Terminal", "focus_tty Terminal /dev/ttys023"]);
        w.fake.touch("two");
        assert_eq!(scripts.calls(4)[2..], ["running Terminal", "select_tty Terminal /dev/ttys023 back"]);
        scripts.still(4);
    }

    #[test]
    fn a_swipe_for_a_ghostty_in_the_back_makes_no_call_and_no_log_line() {
        let scripts = Arc::new(Scripts::default());
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        let swipe = r#"{"select":{"app":"ghostty","tty":"/dev/ttys023"}}"#;
        let tap = r#"{"select":{"app":"ghostty","tty":"/dev/ttys023","raise":true}}"#;
        w.fake.script("hardware watch --json", &[r#"{"attached":false}"#, swipe, "@wait two", tap, "@stdin"]);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        scripts.still(0);
        // A tap's runs: its `open -b` is bringing Ghostty forward.
        w.fake.touch("two");
        assert_eq!(scripts.calls(2), ["running Ghostty", "focus_tty Ghostty /dev/ttys023"]);
        let log = w.fake.log();
        assert_eq!(w.rest(), [Event::WatchExit(Some(0))]);
        let said: Vec<String> = log.lines().into_iter().filter(|line| line.starts_with("tabs:")).collect();
        assert_eq!(said, ["tabs: Ghostty select ok"]);
    }

    #[test]
    fn an_app_that_is_not_running_is_never_sent_an_event() {
        // A swipe's select_tty and a tap's focus_tty alike.
        let scripts = Arc::new(Scripts::default());
        scripts.not_running.store(true, Ordering::SeqCst);
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        w.fake.script("hardware watch --json", &[r#"{"attached":false}"#, SELECT, "@wait two", RAISE, "@stdin"]);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(scripts.calls(1), ["running Terminal"]);
        w.fake.touch("two");
        assert_eq!(scripts.calls(2), ["running Terminal", "running Terminal"]);
        scripts.still(2);
        // No call was made, so no outcome is logged.
        let log = w.fake.log();
        assert_eq!(w.rest(), [Event::WatchExit(Some(0))]);
        assert!(log.lines().iter().all(|line| !line.starts_with("tabs:")), "{:?}", log.lines());
    }

    #[test]
    fn an_app_that_is_not_running_is_never_polled() {
        // It quit just now, still in front: asking it for its tab would launch it again.
        let scripts = Scripts::answering(&[TTY]);
        scripts.not_running.store(true, Ordering::SeqCst);
        let (w, _fronts) = world_with_tabs(TERMINAL, &scripts);
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        // Each tick asks whether it runs, and goes no further.
        assert_eq!(scripts.calls(3)[..3], ["running Terminal"; 3]);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert!(scripts.calls(0).iter().all(|call| call == "running Terminal"), "{:?}", scripts.calls(0));
        assert_eq!(w.fake.stdin(), [WRITES, TERMINAL_LINE]);
    }

    #[test]
    fn no_two_calls_overlap() {
        let scripts = Scripts::answering(&[TTY]);
        let (w, _fronts) = world_with_tabs(TERMINAL, &scripts);
        w.fake.script("hardware watch --json", &[r#"{"attached":true}"#, "@wait go", SELECT, "@stdin"]);
        scripts.gate(true);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        scripts.polls(1);
        // Ticks pass and a select comes while the first call is held: neither starts a second.
        w.fake.touch("go");
        scripts.still(2);
        scripts.gate(false);
        let polls = |calls: &[String]| calls.iter().filter(|call| *call == "selected_tty Terminal").count();
        let select = "select_tty Terminal /dev/ttys023 front";
        scripts.until(|calls| calls.iter().any(|call| call == select) && polls(calls) >= 3);
        assert_eq!(scripts.most.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_failed_polls_are_counted_in_the_log_when_another_app_comes_to_the_front() {
        let scripts = Arc::new(Scripts::default());
        scripts.ttys.lock().unwrap().push_back(Err(TabError::Failed));
        let (w, fronts) = world_with_tabs(TERMINAL, &scripts);
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        scripts.polls(2);
        fronts.tell(VSCODE);
        let log = w.fake.log();
        assert_eq!(w.rest(), [Event::WatchExit(Some(0))]);
        // Every poll made is counted, well before a minute: one line as it stopped, and one for a call then under way.
        let polls = scripts.calls(0).iter().filter(|call| call.starts_with("selected_tty")).count();
        let said: Vec<String> = log.lines().into_iter().filter(|line| line.starts_with("tabs:")).collect();
        let count = |line: &String| line.strip_prefix("tabs: ")?.strip_suffix(" polls failed")?.parse::<usize>().ok();
        let counted: Option<Vec<usize>> = said.iter().map(count).collect();
        assert_eq!(counted.map(|counts| counts.iter().sum()), Some(polls), "{said:?}");
    }

    #[test]
    fn nothing_of_a_tab_is_logged_but_its_outcome() {
        let scripts = Scripts::answering(&[TTY, OTHER]);
        let (w, _fronts) = world_with_tabs(TERMINAL, &scripts);
        let selecting = [r#"{"attached":true}"#, "@wait go", SELECT, "@wait raise", RAISE, "@record"];
        w.fake.script("hardware watch --json", &selecting);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        scripts.polls(3);
        w.fake.touch("go");
        scripts.until(|calls| calls.iter().any(|call| call.starts_with("select_tty")));
        w.fake.touch("raise");
        scripts.until(|calls| calls.iter().any(|call| call.starts_with("focus_tty")));
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        let (log, doubles, stdin) = (w.fake.log(), w.doubles.clone(), w.fake.stdin());
        assert_eq!(w.rest(), []);
        // The ttys went to the watch, and nowhere else.
        assert_eq!(stdin, [WRITES.to_string(), TERMINAL_LINE.to_string(), tab(TTY), tab(OTHER)]);
        let lines = log.lines();
        assert_eq!(lines.iter().filter(|line| *line == "tabs: Terminal select ok").count(), 2, "{lines:?}");
        assert!(lines.iter().all(|line| !line.contains("ttys")), "{lines:?}");
        assert!(doubles.saved.lock().unwrap().is_empty());
    }

    #[test]
    fn the_tab_thread_ends_with_the_runner() {
        let scripts = Scripts::answering(&[TTY]);
        let (w, _fronts) = world_with_tabs(TERMINAL, &scripts);
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        scripts.calls(1);
        // Every thread that could send has let it go: the tab thread too, which was polling.
        assert_eq!(w.rest(), [Event::WatchExit(Some(0))]);
        scripts.still(scripts.calls(0).len());
        // Nothing holds the doors any more.
        assert_eq!(Arc::strong_count(&scripts), 1);
    }

    #[test]
    fn a_write_and_its_enter_after_an_ok_poll_each_run_once_and_are_answered_ok() {
        let scripts = Arc::new(Scripts::default());
        let (w, _fronts) = world_with_tabs(GHOSTTY, &scripts);
        let words = write(ID, "hi");
        w.fake.script("hardware watch --json", &[r#"{"attached":true}"#, "@wait go", &words, ENTER, "@record"]);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        // A poll answered: macOS lets Harness Device script Ghostty.
        scripts.polls(1);
        w.fake.touch("go");
        let calls = scripts.after("send_enter");
        assert_eq!(scripts.typed(), ["write_text Ghostty /dev/ttys023 hi", "send_enter Ghostty /dev/ttys023"]);
        // Each asked first whether Ghostty runs.
        for typed in ["write_text", "send_enter"] {
            let at = calls.iter().position(|call| call.starts_with(typed)).unwrap();
            assert_eq!(calls[at - 1], "running Ghostty", "{calls:?}");
        }
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(
            w.fake.stdin(),
            [WRITES.to_string(), GHOSTTY_LINE.to_string(), wrote(ID, true), wrote(ENTER_ID, true)]
        );
    }

    #[test]
    fn a_write_no_session_of_its_tty_takes_is_answered_no() {
        let scripts = Arc::new(Scripts::default());
        scripts.writes.lock().unwrap().push_back(Ok(Written::NoSession));
        let (w, _fronts) = world_with_tabs(GHOSTTY, &scripts);
        let words = write(ID, "hi");
        w.fake.script("hardware watch --json", &[r#"{"attached":true}"#, "@wait go", &words, "@record"]);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        scripts.polls(1);
        w.fake.touch("go");
        scripts.after("write_text");
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES.to_string(), GHOSTTY_LINE.to_string(), wrote(ID, false)]);
        // It leaves Ghostty on.
        assert!(tabs_said(&w.fake.log()).is_empty());
    }

    #[test]
    fn an_enter_for_a_terminal_that_quit_since_the_words_makes_no_call_and_is_answered_no() {
        let scripts = Arc::new(Scripts::default());
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        let words = write(ID, "hi");
        w.fake.script(
            "hardware watch --json",
            &[r#"{"attached":true}"#, TAP, "@wait words", &words, "@wait enter", ENTER, TAP_OTHER, "@record"],
        );
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        assert_eq!(scripts.calls(2), ["running Ghostty", "focus_tty Ghostty /dev/ttys023"]);
        w.fake.touch("words");
        assert_eq!(scripts.calls(4)[2..], ["running Ghostty", "write_text Ghostty /dev/ttys023 hi"]);
        // Ghostty quits between the words and the Enter: an event to it would launch it again.
        scripts.not_running.store(true, Ordering::SeqCst);
        w.fake.touch("enter");
        // The Enter asks whether it runs and goes no further, as the select after it does once the Enter is answered.
        assert_eq!(scripts.calls(6)[4..], ["running Ghostty", "running Ghostty"]);
        scripts.still(6);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(
            w.fake.stdin(),
            [WRITES.to_string(), VSCODE_LINE.to_string(), wrote(ID, true), wrote(ENTER_ID, false)]
        );
    }

    #[test]
    fn a_typing_for_an_app_no_poll_or_select_answered_yet_makes_no_call_and_is_answered_no() {
        let scripts = Arc::new(Scripts::default());
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        let words = write(ID, "hi");
        // The select after the write is taken once the write is answered.
        w.fake.script("hardware watch --json", &[r#"{"attached":true}"#, &words, TAP, "@record"]);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        assert_eq!(scripts.calls(2), ["running Ghostty", "focus_tty Ghostty /dev/ttys023"]);
        let log = w.fake.log();
        log.until(|lines| lines.iter().any(|line| line == "tabs: Ghostty select ok"));
        scripts.still(2);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES.to_string(), VSCODE_LINE.to_string(), wrote(ID, false)]);
        // A typing answered unrun says why in one fixed line, which names the app alone.
        assert_eq!(tabs_said(&log), ["tabs: Ghostty write refused · no answer yet", "tabs: Ghostty select ok"]);
    }

    #[test]
    fn a_typing_past_a_full_queue_is_answered_no_at_once_in_one_fixed_line() {
        let scripts = Arc::new(Scripts::default());
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        let ids: Vec<String> = (0..=TYPING_QUEUED).map(|n| format!("{n:016x}")).collect();
        let words: Vec<String> = ids.iter().map(|id| write(id, "the words spoken")).collect();
        // The status after the writes says they have all come.
        let mut lines = vec![r#"{"attached":true}"#, TAP, "@wait go"];
        lines.extend(words.iter().map(String::as_str));
        lines.extend([r#"{"attached":true}"#, "@record"]);
        w.fake.script("hardware watch --json", &lines);
        scripts.gate(true);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        // The select is held, as macOS's consent prompt would hold it, and the writes queue behind it.
        assert_eq!(scripts.calls(2), ["running Ghostty", "focus_tty Ghostty /dev/ttys023"]);
        w.fake.touch("go");
        assert_eq!(w.next(), a_dial());
        // The one past the queue is answered and said while the call is still held.
        let log = w.fake.log();
        assert_eq!(tabs_said(&log), ["tabs: Ghostty write refused · queue full"]);
        // The queued ones wait past the bound, and are dropped late once the call answers.
        scripts.still_for(2, LATE_WRITE + EVERY);
        scripts.gate(false);
        let late = |lines: &[String]| lines.iter().filter(|line| *line == "tabs: Ghostty write dropped late").count();
        log.until(|lines| late(lines) == TYPING_QUEUED);
        scripts.still(2);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        // The one past the queue was answered first.
        let mut answers = vec![WRITES.to_string(), VSCODE_LINE.to_string(), wrote(&ids[TYPING_QUEUED], false)];
        answers.extend(ids[..TYPING_QUEUED].iter().map(|id| wrote(id, false)));
        assert_eq!(w.fake.stdin(), answers);
        assert!(log.lines().iter().all(|line| !line.contains("ttys") && !line.contains("words")), "{:?}", log.lines());
    }

    #[test]
    fn a_write_that_waited_past_500_ms_behind_a_held_call_makes_no_call_and_is_one_fixed_line() {
        let scripts = Arc::new(Scripts::default());
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        let words = write(ID, "the words spoken");
        // The status after the write says it has come.
        w.fake.script(
            "hardware watch --json",
            &[r#"{"attached":true}"#, TAP, "@wait go", &words, r#"{"attached":true}"#, "@record"],
        );
        scripts.gate(true);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        // The select is held, as macOS's consent prompt would hold it.
        assert_eq!(scripts.calls(2), ["running Ghostty", "focus_tty Ghostty /dev/ttys023"]);
        w.fake.touch("go");
        assert_eq!(w.next(), a_dial());
        // Nothing runs around the held call while the write waits past the bound.
        scripts.still_for(2, LATE_WRITE + EVERY);
        scripts.gate(false);
        let log = w.fake.log();
        log.until(|lines| lines.iter().any(|line| line == "tabs: Ghostty write dropped late"));
        scripts.still(2);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES.to_string(), VSCODE_LINE.to_string(), wrote(ID, false)]);
        // The late line names the app alone: no line holds the tty or the words.
        assert_eq!(tabs_said(&log), ["tabs: Ghostty select ok", "tabs: Ghostty write dropped late"]);
        assert!(log.lines().iter().all(|line| !line.contains("ttys") && !line.contains("words")), "{:?}", log.lines());
    }

    #[test]
    fn typings_run_in_the_order_they_came_and_before_a_select_waiting_with_them() {
        let scripts = Arc::new(Scripts::default());
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        let (one, two) = (write(ID, "one"), write(NEXT_ID, "two"));
        // The select comes before the writes, and the status after them says they have all come.
        w.fake.script(
            "hardware watch --json",
            &[r#"{"attached":true}"#, TAP, "@wait go", TAP_OTHER, &one, &two, r#"{"attached":true}"#, "@record"],
        );
        scripts.gate(true);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        assert_eq!(scripts.calls(2), ["running Ghostty", "focus_tty Ghostty /dev/ttys023"]);
        w.fake.touch("go");
        assert_eq!(w.next(), a_dial());
        scripts.gate(false);
        assert_eq!(
            scripts.calls(8)[2..],
            [
                "running Ghostty",
                "write_text Ghostty /dev/ttys023 one",
                "running Ghostty",
                "write_text Ghostty /dev/ttys023 two",
                "running Ghostty",
                "focus_tty Ghostty /dev/ttys024",
            ]
        );
        scripts.still(8);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(
            w.fake.stdin(),
            [WRITES.to_string(), VSCODE_LINE.to_string(), wrote(ID, true), wrote(NEXT_ID, true)]
        );
    }

    #[test]
    fn an_older_watchs_typing_is_answered_to_no_watch() {
        let scripts = Arc::new(Scripts::default());
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        let (one, two) = (write(ID, "one"), write(NEXT_ID, "two"));
        w.fake.script(
            "hardware watch --json",
            &[r#"{"attached":true}"#, TAP, "@wait go", &one, &two, r#"{"attached":true}"#, "@record"],
        );
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        let log = w.fake.log();
        // Answered, so Ghostty may be scripted, and the select's call has passed the gate.
        log.until(|lines| lines.iter().any(|line| line == "tabs: Ghostty select ok"));
        // The first write's call is held, and the second waits behind it.
        scripts.gate(true);
        w.fake.touch("go");
        assert_eq!(w.next(), a_dial());
        assert_eq!(scripts.calls(4)[2..], ["running Ghostty", "write_text Ghostty /dev/ttys023 one"]);
        // Harness Device starts a new watch meanwhile.
        w.fake.script("hardware watch --json", &[r#"{"attached":true}"#, TAP_OTHER, "@record"]);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        assert!(wait_gone(w.fake.pids()[0]));
        scripts.gate(false);
        // The new watch's select runs once the old watch's write is answered; the old watch's second write never runs.
        assert_eq!(scripts.calls(6)[4..], ["running Ghostty", "focus_tty Ghostty /dev/ttys024"]);
        scripts.still(6);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        // Neither watch heard of the words: the one that sent them had gone, and the one after never sent them.
        assert_eq!(w.fake.stdin(), [WRITES, VSCODE_LINE, WRITES, VSCODE_LINE]);
    }

    #[test]
    fn a_stopped_watchs_typing_makes_no_call() {
        let scripts = Arc::new(Scripts::default());
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        let words = write(ID, "hi");
        // Its child prints the words once its stdin has closed, then a status that says they have come.
        w.fake.script(
            "hardware watch --json",
            &[r#"{"attached":true}"#, TAP, "@record", &words, r#"{"attached":true}"#, "@wait end"],
        );
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        // Answered, so Ghostty may be scripted.
        w.fake.log().until(|lines| lines.iter().any(|line| line == "tabs: Ghostty select ok"));
        assert_eq!(w.runner.run(Effect::StopWatch), None);
        assert_eq!(w.next(), a_dial());
        scripts.still(2);
        w.fake.touch("end");
        assert_eq!(w.next(), Event::WatchExit(Some(0)));
        // The words' answer had no watch to go to.
        assert_eq!(w.fake.stdin(), [WRITES, VSCODE_LINE]);
    }

    #[test]
    fn a_watch_that_ends_drops_its_typings_waiting() {
        let scripts = Arc::new(Scripts::default());
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        let (one, two) = (write(ID, "one"), write(NEXT_ID, "two"));
        // It ends by itself after the words.
        w.fake.script("hardware watch --json", &[r#"{"attached":true}"#, TAP, "@wait go", &one, &two]);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        w.fake.log().until(|lines| lines.iter().any(|line| line == "tabs: Ghostty select ok"));
        // The first write's call is held, and the second waits behind it as the watch ends.
        scripts.gate(true);
        w.fake.touch("go");
        assert_eq!(scripts.calls(4)[2..], ["running Ghostty", "write_text Ghostty /dev/ttys023 one"]);
        assert_eq!(w.next(), Event::WatchExit(Some(0)));
        scripts.gate(false);
        // The devices took the stream's end for the second write's answer: run now, it could meet another send's words.
        scripts.still(4);
    }

    #[test]
    fn a_typing_for_an_app_turned_off_is_answered_no_at_once() {
        let scripts = Arc::new(Scripts::default());
        scripts.writes.lock().unwrap().push_back(Err(TabError::Denied));
        let (w, _fronts) = world_with_tabs(VSCODE, &scripts);
        let (one, two) = (write(ID, "the words spoken"), write(NEXT_ID, "the words spoken"));
        // The watch's own thread answers the second: the status after it comes once that answer is written.
        w.fake.script(
            "hardware watch --json",
            &[r#"{"attached":true}"#, TAP, "@wait one", &one, "@wait two", &two, r#"{"attached":true}"#, "@record"],
        );
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        let log = w.fake.log();
        log.until(|lines| lines.iter().any(|line| line == "tabs: Ghostty select ok"));
        // The person said no to Automation for Ghostty as the first words came.
        w.fake.touch("one");
        log.until(|lines| lines.iter().any(|line| line == "tabs: Ghostty not allowed"));
        w.fake.touch("two");
        assert_eq!(w.next(), a_dial());
        scripts.still(4);
        assert_eq!(scripts.calls(4)[2..], ["running Ghostty", "write_text Ghostty /dev/ttys023 the words spoken"]);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(
            w.fake.stdin(),
            [WRITES.to_string(), VSCODE_LINE.to_string(), wrote(ID, false), wrote(NEXT_ID, false)]
        );
        // No line holds the tty or the words.
        assert_eq!(tabs_said(&log), ["tabs: Ghostty select ok", "tabs: Ghostty not allowed"]);
        assert!(log.lines().iter().all(|line| !line.contains("ttys") && !line.contains("words")), "{:?}", log.lines());
    }

    #[test]
    fn chatgpt_in_front_is_its_front_line_and_nothing_more() {
        let (w, _fronts) = world_in_front_of("com.openai.codex");
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [WRITES, CHATGPT_LINE]);
        assert!(w.fake.log().lines().iter().all(|line| !line.starts_with("chatgpt:")));
    }

    #[test]
    fn from_start_to_dial_connected() {
        let w = world();
        w.fake.script("hardware watch --json", &[r#"{"attached":true,"fw":"0.0.95"}"#, "@stdin"]);
        w.fake.script("auth status --json", &[r#"{"loggedIn":true}"#]);
        w.fake.script("--version", &["0.6.58"]);
        let (mut app, mut effects) = App::new(Saved::default(), w.runner.find_cli(), false, B, false);
        let connected = MenuItem::Text("Device ready".into());
        let (mut dial, mut auth, mut version) = (false, false, false);
        loop {
            for effect in effects {
                if let Some(Effect::Menu(items)) = w.runner.run(effect) {
                    dial |= items.first() == Some(&connected);
                }
            }
            if dial && auth && version {
                break;
            }
            let event = w.next();
            auth |= event == Event::Auth(Some(true));
            version |= event == Event::CliVersion(Some("0.6.58".into()));
            effects = app.handle(event);
        }
        let mut calls = w.fake.calls();
        calls.sort();
        assert_eq!(calls, ["--version", "auth status --json", "hardware watch --json"]);
    }

    #[test]
    fn nothing_personal_reaches_the_log() {
        let w = world();
        assert!(w.runner.find_cli());
        w.fake.script("login --json", &[URL, SUCCESS]);
        // A browser that does not open: its failure is a log line too.
        w.doubles.failing.store(true, Ordering::SeqCst);
        let Event::Login(LoginEvent::AuthorizeUrl(url)) = w.answer(Effect::RunLogin) else { panic!("no URL") };
        assert_eq!(w.runner.run(Effect::OpenUrl(url)), None);
        assert_eq!(w.next(), sign_in(LoginEvent::Done(Ok(()))));
        let log = w.fake.log();
        // Once every thread has ended, the run's own line is there too.
        assert_eq!(w.rest(), []);
        let lines = log.lines();
        for line in ["browser: could not open: no browser", "harness login --json: exit 0"] {
            assert!(lines.iter().any(|logged| logged == line), "{line}: {lines:?}");
        }
        assert!(lines.iter().all(|line| !line.contains("state=S") && !line.contains('@')), "{lines:?}");
    }

    #[test]
    fn a_sign_in_it_replaced_says_nothing_more() {
        // The app cannot tell one sign-in's events from another's: once replaced, a sign-in must say nothing more.
        let w = world();
        assert!(w.runner.find_cli());
        // `@driver`: as `harness login --json`, a sign-in cancelled or replaced ends once its stdin closes, well before
        // its kill.
        w.fake.script("login --json", &["@driver", URL, "@wait go", FAILED, "@exit 1"]);
        // Cancelled, and replaced at once.
        assert_eq!(w.answer(Effect::RunLogin), browser());
        assert_eq!(w.runner.run(Effect::CancelLogin), None);
        assert_eq!(w.answer(Effect::RunLogin), browser());
        // Replaced while it runs.
        assert_eq!(w.answer(Effect::RunLogin), browser());
        let pids = w.fake.pids();
        assert!(wait_gone(pids[0]) && wait_gone(pids[1]));
        assert!(alive(pids[2]));
        w.fake.touch("go");
        assert_eq!(w.rest(), [sign_in(LoginEvent::Done(Err("fetch failed".into())))]);
    }

    #[test]
    fn a_sign_in_is_cancelled_while_it_hands_an_event_over() {
        // account.rs hands each event over while it holds the lock `cancel` takes. So `send` only hands the event on to
        // the app's loop: a cancel then waits for the hand-over, never the hand-over for the cancel.
        let (fake, home, doubles) = (Fake::new(), tempfile::tempdir().unwrap(), Arc::new(Doubles::default()));
        // `@driver`: as `harness login --json`, it ends once a cancel closes its stdin, well before its kill.
        fake.script("login --json", &["@driver", URL, "@wait never"]);
        let (inside, entered) = mpsc::channel();
        let (release, gate) = mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let send = Arc::new(move |_event: Event| {
            let _ = inside.send(());
            let _ = gate.lock().unwrap().recv();
        });
        let runner = Arc::new(Runner::new(doors(&fake, home.path(), &doubles), send));
        assert!(runner.find_cli());
        assert_eq!(runner.run(Effect::RunLogin), None);
        entered.recv_timeout(WAIT).expect("the sign-in hands its URL over");
        let (done, cancelled) = mpsc::channel();
        let cancelling = runner.clone();
        thread::spawn(move || {
            cancelling.run(Effect::CancelLogin);
            let _ = done.send(());
        });
        release.send(()).unwrap();
        cancelled.recv_timeout(WAIT).expect("the cancel returns");
        assert!(wait_gone(fake.pids()[0]));
    }
}
