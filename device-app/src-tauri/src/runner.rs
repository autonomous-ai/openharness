//! Runs the effects the reducer asks for, on threads.

use crate::account::{self, Login, NO_RESULT};
use crate::claude;
use crate::cli::{self, Cli, HarnessCli, START_DEADLINE};
use crate::desktop;
use crate::front::{FrontFeed, FrontSource};
use crate::install::{self, NOT_SUPPORTED, Shell};
use crate::loginitem::LoginItem;
use crate::state::StateFile;
use crate::tabs::{Out, POLL_EVERY, Select, TabApp, TabFollow, TabScripts};
use crate::types::{Effect, Event, Log, LoginEvent};
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
    /// None where the install is not offered (`install::system_shell`).
    pub shell: Option<Arc<dyn Shell>>,
    pub login_item: Arc<dyn LoginItem>,
    pub state: Arc<dyn StateFile>,
    pub log: Arc<dyn Log>,
    /// `open` with these arguments (`desktop::run_open`).
    pub open: Arc<dyn Fn(&[&str]) -> io::Result<()> + Send + Sync>,
    /// Which app is in front (`front::system`), started once with the runner.
    pub front: Arc<dyn FrontSource>,
    /// The terminal apps' tab scripts (`tabs::system`), which only the runner's tab thread calls.
    pub tabs: Arc<dyn TabScripts>,
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
    /// The runner has gone: the tab thread ends.
    ended: bool,
}

/// The tab thread's next call.
enum Call {
    Select(Select),
    Poll(TabApp),
}

impl Tabs {
    /// A change to the rules, and a word to the tab thread: it may have something to do now.
    fn tell(&self, change: impl FnOnce(&mut TabFollow)) {
        change(&mut self.state.lock().unwrap().follow);
        self.changed.notify_one();
    }

    fn end(&self) {
        self.state.lock().unwrap().ended = true;
        self.changed.notify_one();
    }

    /// Waits for the next call: a waiting select first, else a poll `every` after the last one began. With neither to
    /// do it waits with no timer. None once the runner has gone.
    fn next(&self, every: Duration, polled_at: Option<Instant>) -> Option<Call> {
        let mut state = self.state.lock().unwrap();
        loop {
            if state.ended {
                return None;
            }
            if let Some(select) = state.follow.next_select() {
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

    /// A call's answer, with how long the call took.
    fn answer(&self, call: Duration, answer: impl FnOnce(&mut TabFollow) -> Out) -> Out {
        let follow = &mut self.state.lock().unwrap().follow;
        follow.waited(call);
        answer(follow)
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

    /// Menu, Show and Quit come back for the binary. Everything else is done here, anything slow on a thread, and
    /// answers through `send`.
    pub fn run(&self, effect: Effect) -> Option<Effect> {
        let shared = &self.0;
        match effect {
            Effect::Menu(_) | Effect::Show(_) | Effect::Quit => return Some(effect),
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
                    let result = match &shared.doors.shell {
                        Some(shell) => install::install(&**shell, &*shared.doors.log, &|| shared.find_cli()),
                        None => Err(vec![NOT_SUPPORTED.into()]),
                    };
                    shared.answer(Event::InstallDone(result));
                });
            }
            Effect::ReadAuth => shared.with_cli(|cli| Event::Auth(account::auth_status(cli))),
            Effect::ReadClaude => shared.with_cli(|cli| Event::Claude(claude::status(cli))),
            Effect::RunLogin => shared.run_login(),
            Effect::CancelLogin => {
                let login = shared.login.lock().unwrap().take();
                if let Some(login) = login {
                    login.cancel();
                }
            }
            Effect::SetClaude(on) => {
                let log = shared.doors.log.clone();
                shared.with_cli(move |cli| {
                    let result = claude::set(cli, on);
                    if let Err(message) = &result {
                        log.line(&format!("claude: {message}"));
                    }
                    Event::ClaudeSet(result)
                });
            }
            Effect::OpenUrl(url) => shared.open(&[&url], "browser"),
            Effect::OpenDesktop => shared.open(&desktop::open_desktop_args(), "desktop app"),
            // On the caller's thread: one ServiceManagement call, once at start.
            Effect::RegisterLoginItem => {
                let registered = shared.doors.login_item.register();
                shared.doors.log.line(&match &registered {
                    Ok(()) => "login item: registered".to_string(),
                    Err(error) => format!("login item: not registered: {error}"),
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

    fn spawn_watch(&self) {
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
                if *selecting.lock().unwrap() == number {
                    selects.tell(|follow| follow.select(app, tty, raise));
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

    /// The tab thread: one call at a time, until the runner goes. A tab line goes to the watch running now, and only
    /// each answer's outcome to the log.
    fn follow_tabs(&self, every: Duration) {
        let (scripts, started_at) = (&self.doors.tabs, Instant::now());
        let mut polled_at = None;
        while let Some(call) = self.tabs.next(every, polled_at) {
            let start = Instant::now();
            let app = match &call {
                Call::Select(select) => select.app,
                Call::Poll(app) => {
                    polled_at = Some(start);
                    *app
                }
            };
            // An Apple Event to an app that is not running would launch it, and the app in front may have just quit.
            if !scripts.running(app) {
                continue;
            }
            let out = match call {
                Call::Select(Select { app, tty, frontmost, raise }) => {
                    let done =
                        if raise { scripts.focus_tty(app, &tty) } else { scripts.select_tty(app, &tty, frontmost) };
                    self.tabs.answer(start.elapsed(), |follow| follow.selected(app, done))
                }
                Call::Poll(app) => {
                    let answer = scripts.selected_tty(app);
                    // `watch` first, and held through the write: the line goes to the watch it was asked for.
                    let watch = self.watch.lock().unwrap();
                    let now = started_at.elapsed().as_secs();
                    let out = self.tabs.answer(start.elapsed(), |follow| follow.polled(app, answer, now));
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

    /// A failure is logged without the arguments: a sign-in URL carries its state in its query.
    fn open(&self, args: &[&str], what: &str) {
        if let Err(error) = (self.doors.open)(args) {
            self.doors.log.line(&format!("{what}: could not open: {error}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::NO_RESULT;
    use crate::app::App;
    use crate::front::{FrontSource, NoFront};
    use crate::install::{DESKTOP, HOST, NOT_INSTALLED, NOT_SUPPORTED, Shell};
    use crate::loginitem::LoginItem;
    use crate::state::StateFile;
    use crate::tabs::{NoTabs, Selected, TabApp, TabError, TabScripts};
    use crate::testing::{Fake, alive, fake_harness, wait_gone};
    use crate::types::{ClaudeStatus, DialStatus, Effect, Event, LoginEvent, MenuItem, Output, Saved};
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
    /// Every test runner's poll interval: short, so a test waits on calls, never on the clock.
    const EVERY: Duration = Duration::from_millis(20);

    /// The doors besides the CLI. Each keeps what it was asked, and fails while `failing` is set.
    #[derive(Default)]
    struct Doubles {
        failing: AtomicBool,
        /// The home the host script puts a `harness` launcher in; None: the shell installs nothing.
        installs_into: Mutex<Option<PathBuf>>,
        ran: Mutex<Vec<String>>,
        opened: Mutex<Vec<Vec<String>>>,
        saved: Mutex<Vec<Saved>>,
    }

    impl Doubles {
        fn failing(&self) -> bool {
            self.failing.load(Ordering::SeqCst)
        }

        fn open(&self, args: &[&str]) -> io::Result<()> {
            self.opened.lock().unwrap().push(args.iter().map(|arg| arg.to_string()).collect());
            if self.failing() { Err(io::Error::other("no browser")) } else { Ok(()) }
        }
    }

    impl Shell for Doubles {
        fn run(&self, line: &str, _deadline: Duration) -> io::Result<Output> {
            self.ran.lock().unwrap().push(line.to_string());
            if let Some(home) = self.installs_into.lock().unwrap().as_deref().filter(|_| line == HOST) {
                put_launcher(home);
            }
            Ok(Output { code: Some(0), ..Output::default() })
        }
    }

    impl LoginItem for Doubles {
        fn register(&self) -> Result<(), String> {
            if self.failing() { Err("Login item not added (error 1).".into()) } else { Ok(()) }
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

        /// No call starts for ten ticks: there are still `n`.
        fn still(&self, n: usize) {
            let calls = self.calls.lock().unwrap();
            let (calls, _) = self.called.wait_timeout_while(calls, EVERY * 10, |calls| calls.len() == n).unwrap();
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
        let opener = doubles.clone();
        Doors {
            home: home.to_path_buf(),
            // The system's folders, which the fake's tools are in; never the developer's PATH, where a `harness` would
            // be found.
            path_var: Some("/usr/bin:/bin".into()),
            cli_override: Some(fake.program()),
            shell: Some(doubles.clone()),
            login_item: doubles.clone(),
            state: doubles.clone(),
            log: fake.log(),
            open: Arc::new(move |args: &[&str]| opener.open(args)),
            front: Arc::new(NoFront),
            tabs: Arc::new(NoTabs),
        }
    }

    fn sign_in(event: LoginEvent) -> Event {
        Event::Login(event)
    }

    fn browser() -> Event {
        sign_in(LoginEvent::AuthorizeUrl("https://id.example/a?state=S".into()))
    }

    fn no_dial() -> Event {
        Event::WatchLine(DialStatus { attached: false, fw: None, hw: None, board: None, updating: None, problem: None })
    }

    fn a_dial() -> Event {
        Event::WatchLine(DialStatus { attached: true, fw: None, hw: None, board: None, updating: None, problem: None })
    }

    fn tab(tty: &str) -> String {
        format!(r#"{{"tab":{{"app":"terminal-app","tty":"{tty}"}}}}"#)
    }

    #[cfg(unix)]
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
        w.fake.script("device claude status --json", &[r#"{"supported":true,"installed":true,"enabled":true}"#]);
        let on = ClaudeStatus { supported: true, installed: true, enabled: true, claude_version: None };
        assert_eq!(w.answer(Effect::ReadClaude), Event::Claude(Some(on)));
        w.fake.script("device claude enable", &[]);
        assert_eq!(w.answer(Effect::SetClaude(true)), Event::ClaudeSet(Ok(())));
        w.fake.script("device claude disable", &["@err Claude Code is busy.", "@exit 1"]);
        assert_eq!(w.answer(Effect::SetClaude(false)), Event::ClaudeSet(Err("Claude Code is busy.".into())));
        assert!(w.logged("claude: Claude Code is busy."));
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
            [
                "start --if-down",
                "start --if-down",
                "auth status --json",
                "device claude status --json",
                "device claude enable",
                "device claude disable",
                "login --json",
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_door_that_fails_is_one_log_line() {
        let w = world();
        w.doubles.failing.store(true, Ordering::SeqCst);
        assert_eq!(w.answer(Effect::RegisterLoginItem), Event::LoginItem(false));
        let url = Effect::OpenUrl("https://id.example/a".into());
        for effect in [Effect::Save(Saved::default()), url, Effect::OpenDesktop] {
            assert_eq!(w.runner.run(effect), None);
        }
        assert_eq!(
            w.fake.log().lines(),
            [
                "login item: not registered: Login item not added (error 1).",
                "state: could not save: disk full",
                "browser: could not open: no browser",
                "desktop app: could not open: no browser",
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_that_vanished_says_so() {
        let w = world();
        assert!(w.runner.find_cli());
        fs::remove_file(w.fake.program()).unwrap();
        assert_eq!(w.answer(Effect::SpawnWatch), Event::Cli(false));
        // A sign-in that cannot start is one that did not finish: its screen offers Retry.
        assert_eq!(w.answer(Effect::RunLogin), sign_in(LoginEvent::Done(Err(NO_RESULT.into()))));
    }

    #[cfg(unix)]
    #[test]
    fn without_a_cli_what_needs_one_says_so() {
        let w = world_where(|doors| doors.cli_override = None);
        assert!(!w.runner.find_cli());
        let needs_one = [
            Effect::SpawnWatch,
            Effect::RunStart,
            Effect::ReadAuth,
            Effect::ReadClaude,
            Effect::RunLogin,
            Effect::SetClaude(true),
        ];
        for effect in needs_one {
            assert_eq!(w.answer(effect.clone()), Event::Cli(false), "{effect:?}");
        }
        assert!(w.fake.calls().is_empty());
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn an_install_counts_only_when_a_cli_is_there() {
        let w = world_where(|doors| doors.cli_override = None);
        assert_eq!(w.answer(Effect::RunInstall), Event::InstallDone(Err(vec![NOT_INSTALLED.into()])));
        *w.doubles.installs_into.lock().unwrap() = Some(w.home.path().to_path_buf());
        assert_eq!(w.answer(Effect::RunInstall), Event::InstallDone(Ok(())));
        assert_eq!(*w.doubles.ran.lock().unwrap(), [HOST, DESKTOP, HOST, DESKTOP]);
        // The CLI the install found is the one the runs after it use.
        assert_eq!(w.answer(Effect::ReadAuth), Event::Auth(Some(true)));
    }

    #[cfg(unix)]
    #[test]
    fn install_off_a_mac_is_not_supported() {
        let w = world_where(|doors| doors.shell = None);
        assert_eq!(w.answer(Effect::RunInstall), Event::InstallDone(Err(vec![NOT_SUPPORTED.into()])));
    }

    #[cfg(unix)]
    #[test]
    fn what_opens_is_fixed() {
        let w = world();
        for effect in [Effect::OpenDesktop, Effect::OpenUrl("https://id.example/a?state=S".into())] {
            assert_eq!(w.runner.run(effect), None);
        }
        assert_eq!(
            *w.doubles.opened.lock().unwrap(),
            [vec!["-b", "ai.autonomous.harness"], vec!["https://id.example/a?state=S"]]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_binary_gets_its_three_effects_back() {
        let w = world();
        assert!(w.runner.find_cli());
        for effect in [Effect::Menu(vec![MenuItem::Separator]), Effect::Show(None), Effect::Quit] {
            assert_eq!(w.runner.run(effect.clone()), Some(effect));
        }
        let others = [
            Effect::FindCli,
            Effect::SpawnWatch,
            Effect::StopWatch,
            Effect::RunStart,
            Effect::RunInstall,
            Effect::ReadAuth,
            Effect::ReadClaude,
            Effect::RunLogin,
            Effect::CancelLogin,
            Effect::SetClaude(true),
            Effect::OpenUrl("https://id.example/a".into()),
            Effect::OpenDesktop,
            Effect::RegisterLoginItem,
            Effect::Save(Saved::default()),
            Effect::Log("menu: Quit".into()),
        ];
        for effect in others {
            assert_eq!(w.runner.run(effect.clone()), None, "{effect:?}");
        }
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn the_app_in_front_is_written_to_the_watch() {
        let (w, fronts) = world_in_front_of(GHOSTTY);
        w.fake.script("hardware watch --json", &RECORDING);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        fronts.tell(VSCODE);
        // An app with no name: the watch takes it as no listed app in front.
        fronts.tell("");
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [GHOSTTY_LINE, VSCODE_LINE, r#"{"front":""}"#]);
    }

    #[cfg(unix)]
    #[test]
    fn a_new_watch_is_told_the_app_in_front_once() {
        let (w, fronts) = world_in_front_of(GHOSTTY);
        w.fake.script("hardware watch --json", &RECORDING);
        // In front before any watch ran: the first is told it as it starts.
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [GHOSTTY_LINE]);
        // Changed while no watch ran: the next is told the new one.
        fronts.tell(VSCODE);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [GHOSTTY_LINE, VSCODE_LINE]);
        // A watch that replaces a running one is told it too, once.
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert!(wait_gone(w.fake.pids()[2]));
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [GHOSTTY_LINE, VSCODE_LINE, VSCODE_LINE, VSCODE_LINE]);
    }

    #[cfg(unix)]
    #[test]
    fn a_repeat_writes_nothing() {
        let (w, fronts) = world_in_front_of(GHOSTTY);
        w.fake.script("hardware watch --json", &RECORDING);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        for value in [GHOSTTY, VSCODE, VSCODE, GHOSTTY, GHOSTTY] {
            fronts.tell(value);
        }
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [GHOSTTY_LINE, VSCODE_LINE, GHOSTTY_LINE]);
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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
        assert_eq!(w.fake.stdin(), [TERMINAL_LINE.to_string(), tab(TTY)]);
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn a_change_of_tab_is_one_line_and_a_repeat_none() {
        let scripts = Scripts::answering(&[TTY, TTY, OTHER, OTHER]);
        let (w, _fronts) = world_with_tabs(TERMINAL, &scripts);
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        // The fifth starts once the first four answers are handled.
        scripts.polls(5);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [TERMINAL_LINE.to_string(), tab(TTY), tab(OTHER)]);
    }

    #[cfg(unix)]
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
        assert_eq!(w.fake.stdin(), [TERMINAL_LINE, VSCODE_LINE]);
    }

    #[cfg(unix)]
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

        let detaching = [r#"{"attached":true}"#, "@wait detach", r#"{"attached":false}"#, "@stdin"];
        w.fake.script("hardware watch --json", &detaching);
        scripts.gate(true);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        scripts.polls(2);
        w.fake.touch("detach");
        assert_eq!(w.next(), no_dial());
        scripts.gate(false);
        scripts.still(4);
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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
        assert_eq!(w.fake.stdin(), [TERMINAL_LINE]);
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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
        assert_eq!(stdin, [TERMINAL_LINE.to_string(), tab(TTY), tab(OTHER)]);
        let lines = log.lines();
        assert_eq!(lines.iter().filter(|line| *line == "tabs: Terminal select ok").count(), 2, "{lines:?}");
        assert!(lines.iter().all(|line| !line.contains("ttys")), "{lines:?}");
        assert!(doubles.saved.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn from_start_to_dial_connected() {
        let w = world();
        w.fake.script("hardware watch --json", &[r#"{"attached":true,"fw":"0.0.95"}"#, "@stdin"]);
        w.fake.script("auth status --json", &[r#"{"loggedIn":true}"#]);
        // No Claude Code script: this CLI has no such command.
        let (mut app, mut effects) = App::new(Saved::default(), w.runner.find_cli(), false, B);
        let connected = MenuItem::Text("Dial connected · 0.0.95".into());
        let (mut dial, mut auth, mut claude) = (false, false, false);
        loop {
            for effect in effects {
                if let Some(Effect::Menu(items)) = w.runner.run(effect) {
                    dial |= items.first() == Some(&connected);
                }
            }
            if dial && auth && claude {
                break;
            }
            let event = w.next();
            auth |= event == Event::Auth(Some(true));
            claude |= event == Event::Claude(None);
            effects = app.handle(event);
        }
        let mut calls = w.fake.calls();
        calls.sort();
        assert_eq!(calls, ["auth status --json", "device claude status --json", "hardware watch --json"]);
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn a_sign_in_it_replaced_says_nothing_more() {
        // The app cannot tell one sign-in's events from another's: once replaced, a sign-in must say nothing more.
        let w = world();
        assert!(w.runner.find_cli());
        w.fake.script("login --json", &[URL, "@wait go", FAILED, "@exit 1"]);
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

    #[cfg(unix)]
    #[test]
    fn a_sign_in_is_cancelled_while_it_hands_an_event_over() {
        // account.rs hands each event over while it holds the lock `cancel` takes. So `send` only hands the event on to
        // the app's loop: a cancel then waits for the hand-over, never the hand-over for the cancel.
        let (fake, home, doubles) = (Fake::new(), tempfile::tempdir().unwrap(), Arc::new(Doubles::default()));
        fake.script("login --json", &[URL, "@hang"]);
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
