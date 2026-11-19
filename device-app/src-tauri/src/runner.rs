//! Runs the effects the reducer asks for, on threads.

use crate::account::{self, Login, NO_RESULT};
use crate::cli::{self, Cli, HarnessCli, START_DEADLINE};
use crate::follow::{AX_SETTINGS, CHATGPT_BUNDLE, ChatgptFollow, FollowDoor, Heard, Observer, Shown, TRUST_AGAIN};
use crate::front::{FrontFeed, FrontSource};
use crate::install::{self, Shell};
use crate::loginitem::LoginItem;
use crate::logs;
use crate::open::Opener;
use crate::state::StateFile;
use crate::tabs::{Out, POLL_EVERY, Select, TabApp, TabFollow, TabScripts};
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
    /// The ChatGPT window and the Accessibility permission (`follow::system`).
    pub follow: Arc<dyn FollowDoor>,
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
    /// The ChatGPT follow rules, apart for the same reason.
    chatgpt: Arc<Chatgpt>,
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

/// The tab thread's next call, or the lines for the log that came with none.
enum Call {
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

    fn end(&self) {
        self.state.lock().unwrap().ended = true;
        self.changed.notify_one();
    }

    /// Waits for the next call: a waiting select first, else a poll `every` after the last one began. With neither to
    /// do it waits with no timer. None once the runner has gone, and what the rules said before it went is taken first.
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

/// The ChatGPT follow rules, and the word that they changed. Their lock is taken last, and never held across a door
/// call, a write or `send`.
struct Chatgpt {
    state: Mutex<ChatgptState>,
    changed: Condvar,
    /// How long after macOS's notice the permission is read once more.
    again: Duration,
}

#[derive(Default)]
struct ChatgptState {
    follow: ChatgptFollow,
    /// The observation running is to be dropped.
    stop: bool,
    /// The number of the observation to start.
    start: Option<u64>,
    /// When the permission is to be read once more.
    trust_at: Option<Instant>,
    /// The runner has gone: the follow thread ends.
    ended: bool,
}

/// The follow thread's next step.
enum Step {
    Stop,
    Start(u64),
    /// Whether ChatGPT is installed: the dial has just attached.
    Look,
    /// The permission once more, after macOS's notice.
    Trust,
    /// The app is told what the menu's item shows.
    Shown(Shown),
    Offer,
}

impl Chatgpt {
    /// A change to the rules, and a word to the follow thread. Whether to observe is judged at each change, so a stop
    /// and the start after it are both kept even when the thread wakes once for them: a new watch, or ChatGPT back in
    /// front, always gets a new observation, which writes its first title.
    fn tell(&self, change: impl FnOnce(&mut ChatgptFollow)) {
        let mut state = self.state.lock().unwrap();
        change(&mut state.follow);
        match state.follow.observer() {
            Observer::Start(start) => state.start = Some(start),
            Observer::Stop => {
                state.stop = true;
                state.start = None;
            }
            Observer::Same => {}
        }
        drop(state);
        self.changed.notify_one();
    }

    /// macOS's notice that the Accessibility list changed, and the permission read at it. The list can change just
    /// after the notice: the follow thread reads it once more a moment later.
    fn noticed(&self, trusted: bool) {
        self.state.lock().unwrap().trust_at = Some(Instant::now() + self.again);
        self.tell(|follow| follow.trusted(trusted));
    }

    fn end(&self) {
        self.state.lock().unwrap().ended = true;
        self.changed.notify_one();
    }

    /// Waits for the next step: a stop first, then what the app is to hear, even as the runner goes; then a start, a
    /// look and a read that is due. With none to do it waits, with a timer only for a read to come. None once the
    /// runner has gone.
    fn next(&self, sent: Shown) -> Option<Step> {
        let mut state = self.state.lock().unwrap();
        loop {
            if std::mem::take(&mut state.stop) {
                return Some(Step::Stop);
            }
            let shown = state.follow.shown();
            if shown != sent {
                return Some(Step::Shown(shown));
            }
            if state.follow.take_offer() {
                return Some(Step::Offer);
            }
            if state.ended {
                return None;
            }
            if let Some(start) = state.start.take() {
                return Some(Step::Start(start));
            }
            if state.follow.take_look() {
                return Some(Step::Look);
            }
            let Some(at) = state.trust_at else {
                state = self.changed.wait(state).unwrap();
                continue;
            };
            let wait = at.saturating_duration_since(Instant::now());
            if wait.is_zero() {
                state.trust_at = None;
                return Some(Step::Trust);
            }
            state = self.changed.wait_timeout(state, wait).unwrap().0;
        }
    }

    /// What an observation heard.
    fn answer(&self, answer: impl FnOnce(&mut ChatgptFollow) -> Out) -> Out {
        answer(&mut self.state.lock().unwrap().follow)
    }
}

impl Runner {
    /// `send` hands the event to the app's loop and returns. It never runs an effect itself: a watch or a sign-in
    /// calls it holding a lock that stopping or cancelling it takes.
    pub fn new(doors: Doors, send: Arc<dyn Fn(Event) + Send + Sync>) -> Runner {
        Runner::polling_every(doors, send, POLL_EVERY, TRUST_AGAIN)
    }

    fn polling_every(
        doors: Doors,
        send: Arc<dyn Fn(Event) + Send + Sync>,
        every: Duration,
        trust_again: Duration,
    ) -> Runner {
        let chatgpt = Chatgpt { state: Mutex::default(), changed: Condvar::new(), again: trust_again };
        let shared = Arc::new(Shared {
            doors,
            send,
            cli: Mutex::new(None),
            watch: Mutex::new(None),
            watching: Arc::default(),
            login: Mutex::new(None),
            front: Mutex::default(),
            tabs: Arc::default(),
            chatgpt: Arc::new(chatgpt),
        });
        shared.refresh_login_item();
        // Weakly: the source keeps its callback for as long as it runs, and the runner must still go.
        let weak = Arc::downgrade(&shared);
        shared.doors.front.start(Box::new(move |value| {
            if let Some(shared) = weak.upgrade() {
                shared.front_changed(&value);
            }
        }));
        // Weakly too.
        let weak = Arc::downgrade(&shared);
        shared.doors.follow.start(Box::new(move || {
            if let Some(shared) = weak.upgrade() {
                shared.chatgpt.noticed(shared.doors.follow.trusted());
            }
        }));
        // Once the notice is heard: a change while this reads is read again a moment later.
        let trusted = shared.doors.follow.trusted();
        shared.chatgpt.tell(|follow| follow.trusted(trusted));
        let following = shared.clone();
        thread::spawn(move || following.follow_tabs(every));
        let following = shared.clone();
        thread::spawn(move || following.follow_chatgpt());
        Runner(shared)
    }

    /// Looks for the CLI now; the runs after it use what it found.
    pub fn find_cli(&self) -> bool {
        self.0.find_cli()
    }

    /// Menu, Show, ShowAbout, Quit and Relaunch come back for the binary. Everything else is done here, anything slow on
    /// a thread, and answers through `send`.
    pub fn run(&self, effect: Effect) -> Option<Effect> {
        let shared = &self.0;
        match effect {
            Effect::Menu(_) | Effect::Show(_) | Effect::ShowAbout(_) | Effect::Quit | Effect::Relaunch => {
                return Some(effect);
            }
            Effect::FindCli => shared.answer(Event::Cli(shared.find_cli())),
            Effect::SpawnWatch => shared.spawn_watch(),
            // Its child then exits 0 by itself, and its WatchExit(Some(0)) is the answer.
            Effect::StopWatch => {
                let watch = shared.watch.lock().unwrap().take();
                if let Some(watch) = watch {
                    shared.tabs.tell(|follow| follow.watching(false));
                    shared.chatgpt.tell(|follow| follow.watching(false));
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
                    // An install can write the CLI's own login entry again.
                    if result.is_ok() {
                        shared.refresh_login_item();
                    }
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
            Effect::OpenUrl(url) => shared.open(|open| open.url(&url), "browser"),
            Effect::OpenDesktop => shared.open(|open| open.desktop(), "desktop app"),
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
            // On the caller's thread: macOS shows its own dialog and does not wait for it.
            Effect::AskAx => shared.doors.follow.prompt(),
            Effect::OpenAxSettings => shared.open(|open| open.url(AX_SETTINGS), "accessibility settings"),
        }
        None
    }
}

/// The tab thread and the follow thread end with the runner, once a call under way has answered.
impl Drop for Runner {
    fn drop(&mut self) {
        self.0.tabs.end();
        self.0.chatgpt.end();
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
            Err(error) => self.doors.log.line(&format!("login item: not updated: {error}")),
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
            self.chatgpt.tell(|follow| follow.watching(true));
            *current
        };
        if let Some(old) = watch.take() {
            old.stop();
        }
        let (watching, send, tabs, chatgpt) =
            (self.watching.clone(), self.send.clone(), self.tabs.clone(), self.chatgpt.clone());
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
                        Event::WatchLine(status) => {
                            tabs.tell(|follow| follow.attached(status.attached));
                            chatgpt.tell(|follow| follow.attached(status.attached));
                        }
                        Event::WatchExit(_) => {
                            tabs.tell(|follow| follow.watching(false));
                            chatgpt.tell(|follow| follow.watching(false));
                        }
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
                self.chatgpt.tell(|follow| follow.watching(false));
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
        // Read before the offer is judged: a permission given since macOS's last notice is no reason to offer.
        let trusted = (value == CHATGPT_BUNDLE).then(|| self.doors.follow.trusted());
        self.chatgpt.tell(|follow| {
            if let Some(trusted) = trusted {
                follow.trusted(trusted);
            }
            follow.front(value);
        });
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
                Call::Select(select) => Some(select.app),
                Call::Poll(app) => {
                    polled_at = Some(start);
                    Some(*app)
                }
                Call::Said(_) => None,
            };
            // An Apple Event to an app that is not running would launch it, and the app in front may have just quit.
            if app.is_some_and(|app| !scripts.running(app)) {
                continue;
            }
            let out = match call {
                Call::Said(log) => Out { line: None, log },
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

    /// The follow thread: each door call that can wait on ChatGPT, one at a time and with no lock held, until the
    /// runner goes. The app hears only the permission, whether ChatGPT is installed, and the offer.
    fn follow_chatgpt(self: Arc<Self>) {
        let door = &self.doors.follow;
        let mut observation: Option<Box<dyn Send>> = None;
        let mut sent = Shown::default();
        while let Some(step) = self.chatgpt.next(sent) {
            match step {
                // Returns at once: an observer that waits on a hung ChatGPT ends on its own thread.
                Step::Stop => drop(observation.take()),
                Step::Start(start) => {
                    // Weakly: the observation keeps its callback for as long as it runs, and the runner must still go.
                    let weak = Arc::downgrade(&self);
                    observation = door.observe(Box::new(move |heard| {
                        if let Some(shared) = weak.upgrade() {
                            shared.heard(start, heard);
                        }
                    }));
                    // None while the rules observe is seen in the log; the rules say it once per start.
                    if observation.is_none() {
                        self.heard(start, Heard::NoObserver);
                    }
                }
                Step::Look => {
                    let installed = door.installed();
                    self.chatgpt.tell(|follow| follow.installed(installed));
                }
                Step::Trust => {
                    let trusted = door.trusted();
                    self.chatgpt.tell(|follow| follow.trusted(trusted));
                }
                Step::Shown(shown) => {
                    sent = shown;
                    self.answer(Event::Follow { trusted: shown.trusted, installed: shown.installed });
                }
                Step::Offer => self.answer(Event::FollowOffer),
            }
        }
    }

    /// What the observation numbered `start` heard, on its thread: the line, when it is new, to the watch running now.
    /// The title goes nowhere else, and only the rules' fixed words to the log.
    fn heard(&self, start: u64, heard: Heard) {
        // `watch` first, as spawn_watch takes them: a title heard for an earlier watch is never written to a new one.
        let watch = self.watch.lock().unwrap();
        let out = self.chatgpt.answer(|follow| follow.heard(start, heard));
        if let (Some(line), Some(watch)) = (&out.line, watch.as_ref()) {
            watch.thread(line);
        }
        drop(watch);
        for line in out.log {
            self.doors.log.line(&line);
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
    use crate::follow::{AX_SETTINGS, AxTrust, CHATGPT_BUNDLE, ChatgptWindow, Heard, NoFollow};
    use crate::front::{FrontSource, NoFront};
    use crate::install::{FINISH_IN_TERMINAL, GETTING_READY, INSTALLING_TMUX, NOT_INSTALLED, Place, Run, Shell, runs};
    use crate::loginitem::LoginItem;
    use crate::open::Opener;
    use crate::state::StateFile;
    use crate::tabs::{NoTabs, Selected, TabApp, TabError, TabScripts};
    use crate::testing::{Fake, alive, fake_harness, wait_gone};
    use crate::types::{
        DialStatus, Effect, Event, ExportFailure, Exported, LoginEvent, MenuItem, NotifyMode, Output, Saved,
        UpdateFailure,
    };
    use crate::update::AppUpdater;
    use std::collections::VecDeque;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

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
    /// Every test runner's second read of the permission after macOS's notice: short, as EVERY.
    const AGAIN: Duration = Duration::from_millis(50);
    const CHATGPT_LINE: &str = r#"{"front":"com.openai.codex"}"#;
    const FIX_LOGIN: &str = r#"{"thread":"Fix login"}"#;

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
            if self.failing() { Err("Login item not added (error 1).".into()) } else { Ok(()) }
        }

        fn refresh(&self) -> Result<bool, String> {
            self.refreshed.fetch_add(1, Ordering::SeqCst);
            if self.failing() {
                return Err("Login item not added (error 1).".into());
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

        /// The next events are these, in any order: a watch's thread and the follow thread send apart.
        fn next_in_any_order(&self, expected: &[Event]) {
            let mut seen: Vec<Event> = expected.iter().map(|_| self.next()).collect();
            for event in expected {
                let at = seen.iter().position(|one| one == event).unwrap_or_else(|| panic!("{event:?}: {seen:?}"));
                seen.remove(at);
            }
        }

        /// Every event up to `last`, `last` included.
        fn until(&self, last: Event) -> Vec<Event> {
            let mut seen = vec![self.next()];
            while seen.last() != Some(&last) {
                seen.push(self.next());
            }
            seen
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

    /// The same, with the ChatGPT door a test tells.
    fn world_following(now: &str, door: &Arc<ChatgptDoor>) -> (World, Arc<Fronts>) {
        let fronts = Arc::new(Fronts { now: now.into(), changed: Mutex::default() });
        let (source, follow) = (fronts.clone(), door.clone());
        let w = world_where(move |doors| {
            doors.front = source;
            doors.follow = follow;
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
        let runner = Runner::polling_every(doors, send, EVERY, AGAIN);
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
            follow: Arc::new(NoFollow),
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
        })
    }

    fn tab(tty: &str) -> String {
        format!(r#"{{"tab":{{"app":"terminal-app","tty":"{tty}"}}}}"#)
    }

    fn follow(trusted: bool, installed: bool) -> Event {
        Event::Follow { trusted, installed }
    }

    fn title(value: &str) -> Heard {
        Heard::Title(Some(value.into()))
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

    #[cfg(unix)]
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
                "login item: not registered: Login item not added (error 1).",
                "state: could not save: disk full",
                "browser: could not open: no browser",
                "desktop app: could not open: no browser",
                "logs: could not open: no browser",
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
        let needs_one = [Effect::SpawnWatch, Effect::RunStart, Effect::ReadAuth, Effect::ReadVersion, Effect::RunLogin];
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
        assert_eq!(w.install().1, Err(vec![NOT_INSTALLED.into()]));
        *w.doubles.installs_into.lock().unwrap() = Some(w.home.path().to_path_buf());
        assert_eq!(w.install().1, Ok(()));
        // This OS's runs, in order, each time.
        let lines: Vec<&str> = runs(std::env::consts::OS).iter().map(|run| run.line).collect();
        assert_eq!(*w.doubles.ran.lock().unwrap(), [lines.as_slice(), lines.as_slice()].concat());
        // The CLI the install found is the one the runs after it use.
        assert_eq!(w.answer(Effect::ReadAuth), Event::Auth(Some(true)));
    }

    #[cfg(unix)]
    #[test]
    fn the_login_item_is_refreshed_at_start_and_after_an_install() {
        let w = world();
        assert_eq!(w.doubles.refreshed.load(Ordering::SeqCst), 1);
        // A refresh that changed nothing says nothing.
        assert!(!w.fake.log().lines().iter().any(|line| line.starts_with("login item: ")));
        w.doubles.refresh_changes.store(true, Ordering::SeqCst);
        assert_eq!(w.install().1, Ok(()));
        assert_eq!(w.doubles.refreshed.load(Ordering::SeqCst), 2);
        assert!(w.logged("login item: updated"));
        w.doubles.failing.store(true, Ordering::SeqCst);
        assert_eq!(w.install().1, Ok(()));
        assert!(w.logged("login item: not updated: Login item not added (error 1)."));

        // An install that failed put nothing new in place.
        let w = world_where(|doors| doors.cli_override = None);
        assert_eq!(w.install().1, Err(vec![NOT_INSTALLED.into()]));
        assert_eq!(w.doubles.refreshed.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn what_opens_is_fixed() {
        let w = world();
        for effect in [Effect::OpenDesktop, Effect::OpenUrl("https://id.example/a?state=S".into())] {
            assert_eq!(w.runner.run(effect), None);
        }
        assert_eq!(*w.doubles.opened.lock().unwrap(), ["desktop", "url https://id.example/a?state=S"]);
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn the_reveal_is_one_fixed_open() {
        let w = world();
        let zip = "/Users/p/Desktop/harness-logs-20261118-1030.zip";
        assert_eq!(w.runner.run(Effect::Reveal(PathBuf::from(zip))), None);
        assert_eq!(*w.doubles.opened.lock().unwrap(), [format!("reveal {zip}")]);
    }

    #[cfg(unix)]
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
            Effect::OpenUrl("https://id.example/a".into()),
            Effect::OpenDesktop,
            Effect::RegisterLoginItem,
            Effect::Save(Saved::default()),
            Effect::Log("menu: Quit".into()),
            Effect::ExportLogs,
            Effect::Reveal(PathBuf::from("/tmp/harness-logs-20261118-1030.zip")),
            Effect::AskAx,
            Effect::OpenAxSettings,
        ];
        for effect in others {
            assert_eq!(w.runner.run(effect.clone()), None, "{effect:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_about_credits_are_the_binarys() {
        let w = world();
        for effect in [Effect::AboutCredits(None), Effect::AboutCredits(Some("Harness 0.6.58".into()))] {
            assert_eq!(w.runner.run(effect.clone()), Some(effect));
        }
    }

    #[cfg(unix)]
    #[test]
    fn relaunch_is_the_binarys() {
        let w = world();
        assert_eq!(w.runner.run(Effect::Relaunch), Some(Effect::Relaunch));
    }

    /// The ChatGPT window and the permission, as a test tells them. Each call is kept as it is made, and `observe`
    /// waits while the gate is shut, then gives no observation when it refuses.
    #[derive(Default)]
    struct ChatgptDoor(Arc<DoorCalls>);

    /// Apart from the door: an observation's handle marks itself dropped here.
    #[derive(Default)]
    struct DoorCalls {
        state: Mutex<DoorState>,
        moved: Condvar,
    }

    #[derive(Default)]
    struct DoorState {
        installed: bool,
        /// What `trusted()` answers, in turn; the last one again once the others are used.
        trusts: VecDeque<bool>,
        /// When each `trusted()` read was made.
        reads: Vec<Instant>,
        looks: usize,
        prompts: usize,
        changed: Option<Arc<dyn Fn() + Send + Sync>>,
        observations: Vec<Observed>,
        shut: bool,
        refuses: bool,
    }

    /// An observation's `heard`, and whether its handle has been dropped.
    struct Observed {
        heard: Arc<dyn Fn(Heard) + Send + Sync>,
        dropped: bool,
    }

    impl DoorCalls {
        fn with<T>(&self, change: impl FnOnce(&mut DoorState) -> T) -> T {
            let out = change(&mut self.state.lock().unwrap());
            self.moved.notify_all();
            out
        }
    }

    /// An observation's handle.
    struct Observation(Arc<DoorCalls>, usize);

    impl Drop for Observation {
        fn drop(&mut self) {
            self.0.with(|state| state.observations[self.1].dropped = true);
        }
    }

    impl ChatgptDoor {
        fn answering(installed: bool, trusted: bool) -> Arc<ChatgptDoor> {
            let door = ChatgptDoor::default();
            door.with(|state| {
                state.installed = installed;
                state.trusts = VecDeque::from([trusted]);
            });
            Arc::new(door)
        }

        fn with<T>(&self, change: impl FnOnce(&mut DoorState) -> T) -> T {
            self.0.with(change)
        }

        /// Waits until the calls so far pass `done`.
        fn until(&self, done: impl Fn(&DoorState) -> bool) {
            let state = self.0.state.lock().unwrap();
            let (state, _) = self.0.moved.wait_timeout_while(state, WAIT, |state| !done(state)).unwrap();
            assert!(done(&state), "{} observations, {} reads", state.observations.len(), state.reads.len());
        }

        /// Waits until `n` observations have started.
        fn observed(&self, n: usize) {
            self.until(|state| state.observations.len() >= n);
        }

        /// No observation starts for ten ticks: there are still `n`.
        fn still(&self, n: usize) {
            let state = self.0.state.lock().unwrap();
            let (state, _) =
                self.0.moved.wait_timeout_while(state, EVERY * 10, |state| state.observations.len() == n).unwrap();
            assert_eq!(state.observations.len(), n);
        }

        /// Waits until the handle of observation `index` has been dropped.
        fn dropped(&self, index: usize) {
            self.until(|state| state.observations.get(index).is_some_and(|observed| observed.dropped));
        }

        /// What observation `index` hears, told with no lock held, as an observer's thread tells it.
        fn hear(&self, index: usize, heard: Heard) {
            let tell = self.with(|state| state.observations[index].heard.clone());
            tell(heard);
        }

        /// What `trusted()` answers from now on, in turn.
        fn trust(&self, answers: &[bool]) {
            self.with(|state| state.trusts = answers.iter().copied().collect());
        }

        /// macOS's notice that the Accessibility list changed.
        fn notice(&self) {
            let changed = self.with(|state| state.changed.clone().expect("started"));
            changed();
        }

        fn gate(&self, shut: bool) {
            self.with(|state| state.shut = shut);
        }
    }

    impl ChatgptWindow for ChatgptDoor {
        fn installed(&self) -> bool {
            self.with(|state| {
                state.looks += 1;
                state.installed
            })
        }

        fn observe(&self, heard: Box<dyn Fn(Heard) + Send + Sync>) -> Option<Box<dyn Send>> {
            let index = self.with(|state| {
                state.observations.push(Observed { heard: Arc::from(heard), dropped: false });
                state.observations.len() - 1
            });
            let state = self.0.moved.wait_while(self.0.state.lock().unwrap(), |state| state.shut).unwrap();
            if state.refuses {
                return None;
            }
            drop(state);
            Some(Box::new(Observation(self.0.clone(), index)))
        }
    }

    impl AxTrust for ChatgptDoor {
        fn trusted(&self) -> bool {
            self.with(|state| {
                state.reads.push(Instant::now());
                if state.trusts.len() > 1 { state.trusts.pop_front() } else { state.trusts.front().copied() }
                    .unwrap_or(false)
            })
        }

        fn prompt(&self) {
            self.with(|state| state.prompts += 1);
        }

        fn start(&self, changed: Box<dyn Fn() + Send + Sync>) {
            self.with(|state| state.changed = Some(Arc::from(changed)));
        }
    }

    #[cfg(unix)]
    #[test]
    fn allow_asks_macos_and_the_settings_open_with_one_fixed_argument() {
        let door = ChatgptDoor::answering(false, false);
        let follow = door.clone();
        let w = world_where(move |doors| doors.follow = follow);
        assert_eq!(w.runner.run(Effect::AskAx), None);
        assert_eq!(door.with(|state| state.prompts), 1);
        assert!(w.doubles.opened.lock().unwrap().is_empty());
        assert_eq!(w.runner.run(Effect::OpenAxSettings), None);
        assert_eq!(*w.doubles.opened.lock().unwrap(), [format!("url {AX_SETTINGS}")]);
        assert_eq!(door.with(|state| state.prompts), 1);
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn a_download_then_an_install_reach_the_door_in_order() {
        let updates = Updates::answering(Ok(Some("0.1.3".into())), Ok(()));
        let door = updates.clone();
        let w = world_where(move |doors| doors.updater = Some(door));
        assert_eq!(w.answer(Effect::DownloadUpdate), Event::UpdateDownloaded);
        assert_eq!(w.answer(Effect::InstallUpdate), Event::UpdateInstalled);
        assert_eq!(*updates.calls.lock().unwrap(), ["download", "install"]);
    }

    #[cfg(unix)]
    #[test]
    fn with_no_updater_a_check_finds_nothing() {
        let w = world();
        assert_eq!(w.answer(Effect::CheckUpdate), Event::UpdateChecked(None));
        assert_eq!(w.answer(Effect::DownloadUpdate), Event::UpdateChecked(None));
        assert_eq!(w.answer(Effect::InstallUpdate), Event::UpdateChecked(None));
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
    fn a_sound_change_is_written_to_the_watch() {
        let (off, on) = (r#"{"muted":true}"#, r#"{"muted":false}"#);
        let w = world();
        assert!(w.runner.find_cli());
        w.fake.script("hardware watch --json", &RECORDING);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        assert_eq!(w.runner.run(Effect::SetSound(false)), None);
        assert_eq!(w.runner.run(Effect::SetSound(true)), None);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [off, on]);
        // With no watch running there is nothing to write to.
        assert_eq!(w.runner.run(Effect::SetSound(false)), None);
        assert_eq!(w.fake.stdin(), [off, on]);
        let lines = w.fake.log().lines();
        assert!(lines.iter().all(|line| !line.contains("muted")), "{lines:?}");
        assert_eq!(w.rest(), []);
    }

    #[cfg(unix)]
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
        assert_eq!(w.fake.stdin(), [you, full]);
        // With no watch running there is nothing to write to.
        assert_eq!(w.runner.run(Effect::SetNotify(NotifyMode::You)), None);
        assert_eq!(w.fake.stdin(), [you, full]);
        let lines = w.fake.log().lines();
        assert!(lines.iter().all(|line| !line.contains("notify")), "{lines:?}");
        assert_eq!(w.rest(), []);
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
    fn the_chatgpt_title_is_written_to_the_watch_with_chatgpt_in_front_the_dial_attached_and_the_permission() {
        let door = ChatgptDoor::answering(false, true);
        let (w, _fronts) = world_following(CHATGPT_BUNDLE, &door);
        // Trusted from the start: the menu's item is checked.
        assert_eq!(w.next(), follow(true, false));
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        door.observed(1);
        door.hear(0, title("Fix login"));
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [CHATGPT_LINE, FIX_LOGIN]);
        assert_eq!(door.with(|state| state.observations.len()), 1);
    }

    #[cfg(unix)]
    #[test]
    fn nothing_is_observed_without_the_permission_the_dial_or_chatgpt_in_front() {
        let door = ChatgptDoor::answering(false, true);
        let (w, fronts) = world_following(VSCODE, &door);
        assert_eq!(w.next(), follow(true, false));
        // Another app in front.
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        door.still(0);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        // ChatGPT in front, and no watch.
        fronts.tell(CHATGPT_BUNDLE);
        door.still(0);
        // A watch, and no dial.
        w.fake.script("hardware watch --json", &RECORDING);
        assert_eq!(w.answer(Effect::SpawnWatch), no_dial());
        door.still(0);
        // The dial, and no permission.
        door.trust(&[false]);
        door.notice();
        assert_eq!(w.next(), follow(false, false));
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        door.still(0);
        // All four: it observes.
        door.trust(&[true]);
        door.notice();
        assert_eq!(w.next(), follow(true, false));
        door.observed(1);
    }

    #[cfg(unix)]
    #[test]
    fn the_observer_is_dropped_when_chatgpt_leaves_the_dial_detaches_the_watch_ends_or_the_permission_goes() {
        let door = ChatgptDoor::answering(false, true);
        let (w, fronts) = world_following(CHATGPT_BUNDLE, &door);
        assert_eq!(w.next(), follow(true, false));
        let detaching = [
            r#"{"attached":true}"#,
            "@wait detach",
            r#"{"attached":false}"#,
            "@wait attach",
            r#"{"attached":true}"#,
            "@record",
        ];
        w.fake.script("hardware watch --json", &detaching);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        door.observed(1);
        door.hear(0, title("Fix login"));
        // ChatGPT leaves the front and comes back on the same thread: the dial may have moved since, so its title is
        // written again.
        fronts.tell(VSCODE);
        door.dropped(0);
        fronts.tell(CHATGPT_BUNDLE);
        door.observed(2);
        door.hear(1, title("Fix login"));
        // The dial detaches, and attaches again.
        w.fake.touch("detach");
        assert_eq!(w.next(), no_dial());
        door.dropped(1);
        w.fake.touch("attach");
        assert_eq!(w.next(), a_dial());
        door.observed(3);
        door.hear(2, title("Fix login"));
        // The permission goes, and comes back.
        door.trust(&[false]);
        door.notice();
        assert_eq!(w.next(), follow(false, false));
        door.dropped(2);
        door.trust(&[true]);
        door.notice();
        assert_eq!(w.next(), follow(true, false));
        door.observed(4);
        door.hear(3, title("Fix login"));
        // The watch ends, and the next one is told the title too.
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        door.dropped(3);
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        door.observed(5);
        door.hear(4, title("Fix login"));
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        door.dropped(4);
        let first = [CHATGPT_LINE, FIX_LOGIN, VSCODE_LINE, CHATGPT_LINE, FIX_LOGIN, FIX_LOGIN, FIX_LOGIN];
        assert_eq!(w.fake.stdin(), [&first[..], &[CHATGPT_LINE, FIX_LOGIN]].concat());
    }

    #[cfg(unix)]
    #[test]
    fn a_title_heard_after_its_observer_was_dropped_is_written_nowhere() {
        let door = ChatgptDoor::answering(false, true);
        let (w, fronts) = world_following(CHATGPT_BUNDLE, &door);
        assert_eq!(w.next(), follow(true, false));
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        door.observed(1);
        door.hear(0, title("Fix login"));
        fronts.tell(VSCODE);
        door.dropped(0);
        door.hear(0, title("Plan the trip"));
        // Back to ChatGPT fast: the first observer is still heard after the second started.
        fronts.tell(CHATGPT_BUNDLE);
        door.observed(2);
        door.hear(0, title("Plan the trip"));
        door.hear(1, title("Fix login"));
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [CHATGPT_LINE, FIX_LOGIN, VSCODE_LINE, CHATGPT_LINE, FIX_LOGIN]);
    }

    #[cfg(unix)]
    #[test]
    fn the_permission_is_read_at_the_notification_and_once_more_a_moment_later() {
        let door = ChatgptDoor::answering(false, true);
        let (w, _fronts) = world_following(CHATGPT_BUNDLE, &door);
        assert_eq!(w.next(), follow(true, false));
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        door.observed(1);
        let before = door.with(|state| state.reads.len());
        // The list changes just after macOS's notice: the read at it still finds Harness there, the one after does not.
        door.trust(&[true, false]);
        let noticed = Instant::now();
        door.notice();
        let returned = Instant::now();
        door.dropped(0);
        assert_eq!(w.next(), follow(false, false));
        let reads = door.with(|state| state.reads[before..].to_vec());
        assert_eq!(reads.len(), 2);
        // One read on the notice's own thread, and one no sooner than a moment later.
        assert!(noticed <= reads[0] && reads[0] <= returned);
        assert!(reads[1] >= noticed + AGAIN);
        assert_eq!(w.rest(), [Event::WatchExit(Some(0))]);
        assert_eq!(door.with(|state| state.reads.len()), before + 2);
    }

    #[cfg(unix)]
    #[test]
    fn a_change_of_the_permission_or_of_the_app_installed_is_one_follow_event() {
        let door = ChatgptDoor::answering(true, false);
        let (w, _fronts) = world_following(VSCODE, &door);
        let attaching = [
            r#"{"attached":true}"#,
            "@wait again",
            r#"{"attached":true}"#,
            "@wait detach",
            r#"{"attached":false}"#,
            "@wait attach",
            r#"{"attached":true}"#,
            "@stdin",
        ];
        w.fake.script("hardware watch --json", &attaching);
        // Nothing is said before the dial attaches: untrusted, and nothing is known installed.
        assert_eq!(w.runner.run(Effect::SpawnWatch), None);
        w.next_in_any_order(&[a_dial(), follow(false, true)]);
        assert_eq!(door.with(|state| state.looks), 1);
        door.trust(&[true]);
        door.notice();
        assert_eq!(w.next(), follow(true, true));
        // The read a moment later finds the same: nothing more. The reads: at start, at the notice, and that one.
        door.until(|state| state.reads.len() == 3);
        // Another status that says attached is no new attach: nothing is read.
        w.fake.touch("again");
        assert_eq!(w.next(), a_dial());
        // The app removed, and the dial attached again: it is read once more.
        door.with(|state| state.installed = false);
        w.fake.touch("detach");
        assert_eq!(w.next(), no_dial());
        w.fake.touch("attach");
        w.next_in_any_order(&[a_dial(), follow(true, false)]);
        assert_eq!(door.with(|state| state.looks), 2);
        assert_eq!(w.rest(), [Event::WatchExit(Some(0))]);
    }

    #[cfg(unix)]
    #[test]
    fn the_offer_is_one_event_when_chatgpt_comes_to_the_front_and_none_for_the_app_in_front_at_start() {
        let door = ChatgptDoor::answering(true, false);
        let (w, fronts) = world_following(CHATGPT_BUNDLE, &door);
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.runner.run(Effect::SpawnWatch), None);
        w.next_in_any_order(&[a_dial(), follow(false, true)]);
        // In front from the start, then told again: ChatGPT has not come to the front.
        fronts.tell(CHATGPT_BUNDLE);
        fronts.tell(VSCODE);
        fronts.tell(CHATGPT_BUNDLE);
        assert_eq!(w.next(), Event::FollowOffer);
        // Allowed since macOS's last notice: the read as ChatGPT comes to the front finds it, and nothing is offered.
        fronts.tell(VSCODE);
        door.trust(&[true]);
        fronts.tell(CHATGPT_BUNDLE);
        assert_eq!(w.next(), follow(true, true));
        assert_eq!(w.rest(), [Event::WatchExit(Some(0))]);
    }

    #[cfg(unix)]
    #[test]
    fn no_observer_is_one_log_line_each_time_observing_starts() {
        let door = ChatgptDoor::answering(false, true);
        let (w, fronts) = world_following(CHATGPT_BUNDLE, &door);
        assert_eq!(w.next(), follow(true, false));
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        door.observed(1);
        door.hear(0, Heard::NoObserver);
        door.hear(0, Heard::NoObserver);
        let said = |w: &World| w.fake.log().lines().iter().filter(|line| *line == "chatgpt: no observer").count();
        assert_eq!(said(&w), 1);
        // ChatGPT comes to the front again: it is tried again.
        fronts.tell(VSCODE);
        door.dropped(0);
        fronts.tell(CHATGPT_BUNDLE);
        door.observed(2);
        door.hear(1, Heard::NoObserver);
        assert_eq!(said(&w), 2);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [CHATGPT_LINE, VSCODE_LINE, CHATGPT_LINE]);
    }

    #[cfg(unix)]
    #[test]
    fn an_observation_that_does_not_start_is_one_log_line_each_time_observing_starts() {
        let door = ChatgptDoor::answering(false, true);
        door.with(|state| state.refuses = true);
        let (w, fronts) = world_following(CHATGPT_BUNDLE, &door);
        assert_eq!(w.next(), follow(true, false));
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        door.observed(1);
        let said = |w: &World| w.fake.log().lines().iter().filter(|line| *line == "chatgpt: no observer").count();
        // The next start waits at the gate: the follow thread is done with the first.
        door.gate(true);
        fronts.tell(VSCODE);
        fronts.tell(CHATGPT_BUNDLE);
        door.observed(2);
        assert_eq!(said(&w), 1);
        door.gate(false);
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
    }

    #[cfg(unix)]
    #[test]
    fn a_chatgpt_that_hangs_holds_back_no_front_line() {
        let door = ChatgptDoor::answering(false, true);
        door.gate(true);
        let (w, fronts) = world_following(CHATGPT_BUNDLE, &door);
        assert_eq!(w.next(), follow(true, false));
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        // ChatGPT does not answer: the observation is under way, and has not started.
        door.observed(1);
        let (told, done) = mpsc::channel();
        let telling = fronts.clone();
        thread::spawn(move || {
            telling.tell(VSCODE);
            let _ = told.send(());
        });
        done.recv_timeout(WAIT).expect("the app in front is told at once");
        assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
        assert_eq!(w.fake.stdin(), [CHATGPT_LINE, VSCODE_LINE]);
        // Once ChatGPT answers, the observation it gives is dropped: ChatGPT left the front meanwhile.
        door.gate(false);
        door.dropped(0);
    }

    #[cfg(unix)]
    #[test]
    fn nothing_of_a_title_reaches_the_log_an_event_or_the_state_file() {
        let door = ChatgptDoor::answering(true, true);
        let (w, fronts) = world_following(CHATGPT_BUNDLE, &door);
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.runner.run(Effect::SpawnWatch), None);
        let mut events = w.until(a_dial());
        door.observed(1);
        for heard in [title("Secret thread"), title("Another secret"), Heard::Title(None), Heard::NoObserver] {
            door.hear(0, heard);
        }
        fronts.tell(VSCODE);
        fronts.tell(CHATGPT_BUNDLE);
        door.observed(2);
        door.hear(1, title("Secret thread"));
        door.hear(0, title("Late secret"));
        assert_eq!(w.runner.run(Effect::StopWatch), None);
        events.extend(w.until(Event::WatchExit(Some(0))));
        let (log, doubles, stdin) = (w.fake.log(), w.doubles.clone(), w.fake.stdin());
        events.extend(w.rest());
        // The titles went to the watch, and nowhere else.
        let (secret, another) = (r#"{"thread":"Secret thread"}"#, r#"{"thread":"Another secret"}"#);
        let empty = r#"{"thread":""}"#;
        assert_eq!(stdin, [CHATGPT_LINE, secret, another, empty, VSCODE_LINE, CHATGPT_LINE, secret]);
        assert!(events.contains(&follow(true, true)), "{events:?}");
        assert!(events.iter().all(|event| !format!("{event:?}").contains("ecret")), "{events:?}");
        let lines = log.lines();
        assert!(lines.iter().any(|line| line == "chatgpt: no observer"), "{lines:?}");
        assert!(lines.iter().all(|line| !line.contains("ecret")), "{lines:?}");
        assert!(doubles.saved.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_follow_thread_ends_with_the_runner() {
        let door = ChatgptDoor::answering(false, true);
        let (w, _fronts) = world_following(CHATGPT_BUNDLE, &door);
        assert_eq!(w.next(), follow(true, false));
        w.fake.script("hardware watch --json", &ATTACHED);
        assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
        door.observed(1);
        // Every thread that could send has let it go: the follow thread too, which was observing.
        assert_eq!(w.rest(), [Event::WatchExit(Some(0))]);
        door.dropped(0);
        // Nothing holds the doors any more.
        assert_eq!(Arc::strong_count(&door), 1);
    }

    #[cfg(unix)]
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
