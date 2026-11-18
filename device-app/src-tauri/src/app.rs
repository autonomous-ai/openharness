//! The app's rules: a pure reducer from an event to the effects it asks for.

use crate::install::GETTING_READY;
use crate::keepalive::{Keep, KeepAlive};
use crate::logs::reason;
use crate::model::{about_credits, due, menu, menu_log};
use crate::types::{
    Action, AppState, AppUpdate, CliState, Daemon, Effect, Event, Fingerprint, LoginEvent, LogsExport, MenuAction,
    MenuItem, NotifyMode, OrcaAnswer, OrcaError, OrcaState, OrcaStatus, Phase, Saved, Screen, UpdateFailure, View,
};

/// The menu reads the account and the CLI's version again at most this often.
const READ_EVERY_SECS: u64 = 60;

/// The menu asks Orca again at most this often: three Orca CLI runs each time, while Orca runs.
const ORCA_EVERY_SECS: u64 = 300;

/// The app asks for its own update at most this often: as often as the CLI's updater.
const CHECK_EVERY_SECS: u64 = 60;

/// The longest a version whose download, signature or install failed waits to be tried again.
const RETRY_MAX_SECS: u64 = 3_600;

/// Where a person whose app cannot replace itself gets the new one. Fixed: nothing of the manifest reaches `open`.
const DEVICE_PAGE: &str = "https://harness.autonomous.ai/device";

/// A start left to the desktop app, which supervises its own daemon.
const DESKTOP_RUNS: &str = "keep-alive: the desktop app runs; not starting";

/// The Orca screen's lines Rust sends; the window has the rest of its copy.
const ASKING_ORCA: &str = "Asking Orca…";
const ORCA_NOT_RUNNING: &str = "Orca isn't running.";
const ORCA_FAILED: &str = "Couldn't connect Orca.";

pub struct App {
    state: AppState,
    keep: KeepAlive,
    /// The last menu sent.
    menu: Vec<MenuItem>,
    /// What the window shows; None while it is hidden.
    window: Option<View>,
    /// The sign-in that runs, as its screen draws it.
    login: Option<View>,
    /// The install's step, kept after it ends until the first screen is chosen.
    step: &'static str,
    /// The CLI was found and the account has not answered since: its first answer chooses the first screen.
    awaiting_account: bool,
    /// The last time an event told, for the keep-alive.
    now: u64,
    last_read: u64,
    /// The app started the daemon: its first status line reads the account again, at once, as a read made while it
    /// was down may have needed it.
    read_when_up: bool,
    /// The desktop app ran at the last tick.
    desktop_running: bool,
    /// When the last update check started.
    checked_at: Option<u64>,
    /// A check, or the install it found, has not answered, or the install waits for the relaunch: no second check
    /// starts, however long the Mac slept or the relaunch waits. Only the relaunch's new process starts without it.
    updating: bool,
    /// The version the last check found.
    found: Option<String>,
    /// The version last logged as not writable, so it is said once.
    skipped: Option<String>,
    /// The version whose download, signature or install failed, how often, and when last.
    failed: Option<Failed>,
    /// An update is installed: the app relaunches on the first tick with nothing running.
    relaunch: bool,
    /// The Orca runs: one at a time, and the ones that wait for it.
    orca: OrcaRuns,
    /// When the last `harness device orca status` started.
    orca_asked_at: Option<u64>,
    /// A silent update was wanted since the CLI was found or its version changed: it runs once for each.
    orca_updated: bool,
    /// The fingerprint of the access the window shows. Only the Connect click takes it, and a window that leaves that
    /// access drops it, so nothing is approved but what the person sees.
    approval: Option<Fingerprint>,
}

impl App {
    pub fn new(saved: Saved, cli_found: bool, desktop_installed: bool, now: u64) -> (App, Vec<Effect>) {
        let keep = KeepAlive::new();
        let state = AppState {
            cli: CliState::Removed,
            daemon: keep.daemon(),
            dial: None,
            signed_in: None,
            desktop_installed,
            saved,
            app_update: AppUpdate::None,
            cli_version: None,
            logs: LogsExport::Idle,
            orca: OrcaState::None,
        };
        let mut app = App {
            state,
            keep,
            menu: Vec::new(),
            window: None,
            login: None,
            step: GETTING_READY,
            awaiting_account: false,
            now,
            last_read: now,
            read_when_up: false,
            desktop_running: false,
            checked_at: None,
            updating: false,
            found: None,
            skipped: None,
            failed: None,
            relaunch: false,
            orca: OrcaRuns::default(),
            orca_asked_at: None,
            orca_updated: false,
            approval: None,
        };
        let mut effects = Vec::new();
        // A CLI seen once and gone now was removed on purpose: it stays Removed, never installed on its own.
        if cli_found {
            app.found(&mut effects);
            effects.push(Effect::SpawnWatch);
        } else if !saved.cli_seen {
            app.install(&mut effects);
        }
        if !saved.login_item {
            effects.push(Effect::RegisterLoginItem);
        }
        app.send_menu(&mut effects);
        (app, effects)
    }

    pub fn handle(&mut self, event: Event) -> Vec<Effect> {
        let mut effects = Vec::new();
        self.apply(event, &mut effects);
        self.send_menu(&mut effects);
        effects
    }

    /// The binary keeps the view each Show hands it; only the tests ask the rules.
    #[cfg(test)]
    pub fn view(&self) -> Option<View> {
        self.window.clone()
    }

    fn apply(&mut self, event: Event, effects: &mut Vec<Effect>) {
        match event {
            Event::Tick { now, desktop_running } => {
                self.now = now;
                if self.relaunch && !self.relaunch_waits() {
                    self.relaunch = false;
                    self.stop_watch(effects);
                    effects.push(Effect::Relaunch);
                    return;
                }
                match self.state.cli {
                    CliState::Found => match self.keep.tick(now, desktop_running) {
                        Some(Keep::SpawnWatch) => effects.push(Effect::SpawnWatch),
                        Some(Keep::RunStart) => self.run_start(effects),
                        Some(Keep::HoldBack) => effects.push(Effect::Log(DESKTOP_RUNS.into())),
                        None => {}
                    },
                    // A CLI installed by hand is found again; an install that runs is waited for.
                    CliState::Removed | CliState::InstallFailed => effects.push(Effect::FindCli),
                    CliState::Installing => {}
                }
                self.desktop_running = desktop_running;
                // abs_diff: a clock set back checks too.
                let due = self.checked_at.is_none_or(|at| now.abs_diff(at) >= CHECK_EVERY_SECS);
                if due && !self.running() && !self.updating {
                    self.checked_at = Some(now);
                    self.updating = true;
                    effects.push(Effect::CheckUpdate);
                }
            }
            Event::MenuOpened { now, desktop_installed } => {
                self.now = now;
                self.state.desktop_installed = desktop_installed;
                if self.state.cli == CliState::Found {
                    // abs_diff: a clock set back reads and asks again too.
                    if now.abs_diff(self.last_read) >= READ_EVERY_SECS {
                        self.read(effects);
                    }
                    if self.orca_asked_at.is_none_or(|at| now.abs_diff(at) >= ORCA_EVERY_SECS) {
                        self.ask_orca(effects);
                    }
                }
            }
            Event::Cli(true) if matches!(self.state.cli, CliState::Removed | CliState::InstallFailed) => {
                self.found(effects);
                effects.push(Effect::SpawnWatch);
            }
            // Gone (`harness uninstall`): what ran on it ends, and nothing it said is known any more.
            Event::Cli(false) if self.state.cli == CliState::Found => {
                self.state.cli = CliState::Removed;
                self.stop_watch(effects);
                if self.login.take().is_some() {
                    effects.push(Effect::CancelLogin);
                }
                self.state.signed_in = None;
                self.state.cli_version = None;
                self.awaiting_account = false;
                // Its runs' late answers are not heard, and the ones that waited never start.
                self.orca = OrcaRuns::default();
                self.orca_row(OrcaState::None, effects);
                if self.window.is_some() {
                    self.show(None, effects);
                }
            }
            Event::Cli(_) => {}
            Event::WatchLine(status) => {
                self.keep.watch_line();
                self.state.dial = Some(status);
                if std::mem::take(&mut self.read_when_up) {
                    self.read(effects);
                }
            }
            Event::WatchExit(code) => {
                let before = self.keep.daemon();
                self.keep.watch_exit(code, self.now);
                self.state.dial = None;
                // A start the CLI refused (a flash, an uninstall) exits 0 as a real one does: this down tells it.
                if self.keep.daemon() == Daemon::Stopped && before != Daemon::Stopped {
                    effects.push(Effect::Log("keep-alive: the start changed nothing".into()));
                }
            }
            Event::StartDone { ok } => {
                self.keep.start_done(ok);
                effects.push(Effect::SpawnWatch);
            }
            // A step that comes late, or again, draws nothing.
            Event::InstallStep(step) if self.state.cli == CliState::Installing && step != self.step => {
                self.step = step;
                self.redraw(Screen::Install, effects);
            }
            Event::InstallStep(_) => {}
            // The runner found a CLI after it. The window stays on Install until the first screen is chosen.
            Event::InstallDone(Ok(())) => {
                self.found(effects);
                if self.desktop_running {
                    effects.extend([Effect::Log(DESKTOP_RUNS.into()), Effect::SpawnWatch]);
                } else {
                    self.keep.start_begun(self.now);
                    self.run_start(effects);
                }
            }
            Event::InstallDone(Err(lines)) => {
                self.state.cli = CliState::InstallFailed;
                // Decision 1: a closed window stays closed, and the menu offers Install.
                if self.showing(Screen::Install) {
                    self.show(Some(screen_at(Screen::Install, Phase::Failed, lines)), effects);
                }
            }
            // A read that failed keeps the last answer.
            Event::Auth(answer) if self.state.cli == CliState::Found => {
                self.state.signed_in = answer.or(self.state.signed_in);
                self.first_screen(effects);
            }
            Event::CliVersion(version) if self.state.cli == CliState::Found => {
                // A new CLI carries a new plugin: Orca is asked again, and may be updated again. The first version
                // read is not a change, and a read that failed changes nothing.
                if let (Some(known), Some(read)) = (&self.state.cli_version, &version)
                    && known != read
                {
                    self.orca_updated = false;
                    self.ask_orca(effects);
                }
                self.state.cli_version = version.or(self.state.cli_version.take());
            }
            // A read of a CLI that went away answers late: nothing reads it.
            Event::Auth(_) | Event::CliVersion(_) => {}
            Event::Login(event) => self.login_event(event, effects),
            // A failure is tried again at the next start.
            Event::LoginItem(registered) => {
                if registered {
                    self.remember(|saved| saved.login_item = true, effects);
                }
            }
            Event::Menu(action) => match action {
                MenuAction::Install => self.install(effects),
                MenuAction::SignIn => self.show(Some(self.view_of(Screen::SignIn)), effects),
                // Never with a fingerprint: the window shows Orca's access first. A connect asked already is waited for.
                MenuAction::Orca if self.state.cli == CliState::Found => {
                    if self.orca.running != Some(OrcaRun::Connect) && self.orca.connect.is_none() {
                        self.orca.connect = Some(None);
                        self.next_orca(effects);
                    }
                    self.show(Some(self.view_of(Screen::Orca)), effects);
                }
                MenuAction::Orca => {}
                MenuAction::SoundOn | MenuAction::SoundOff => {
                    effects.push(Effect::SetSound(action == MenuAction::SoundOn));
                    // A native check item flips its own check when clicked: the menu drawn again puts it back
                    // where the dial is, and the dial's next status line moves it.
                    effects.push(Effect::Menu(self.menu.clone()));
                }
                MenuAction::NotifyFull | MenuAction::NotifyYou => {
                    let mode = if action == MenuAction::NotifyFull { NotifyMode::Full } else { NotifyMode::You };
                    effects.push(Effect::SetNotify(mode));
                    // As Sound's: the check moves when the watch's next line says the mode was saved.
                    effects.push(Effect::Menu(self.menu.clone()));
                }
                MenuAction::Update => effects.push(Effect::OpenUrl(DEVICE_PAGE.into())),
                MenuAction::OpenHarness => effects.push(Effect::OpenDesktop),
                MenuAction::About => effects.push(Effect::ShowAbout(about_credits(&self.state))),
                MenuAction::Quit => {
                    self.stop_watch(effects);
                    effects.push(Effect::Quit);
                }
                // The row is a disabled line while one runs, or absent with no CLI: a click that lands then does
                // nothing.
                MenuAction::ExportLogs => {
                    if self.state.cli == CliState::Found && self.state.logs != LogsExport::Running {
                        self.state.logs = LogsExport::Running;
                        effects.push(Effect::ExportLogs);
                    }
                }
            },
            Event::Act(action) => self.act(action, effects),
            // Decision 2: closing answers an offer, and never stops what runs.
            Event::WindowClosed => {
                if self.showing(Screen::SignIn) {
                    self.remember(|saved| saved.asked_sign_in = true, effects);
                }
                self.show(None, effects);
            }
            // Nothing newer: a row that offered a version goes, as this app is at least as new.
            Event::UpdateChecked(None) => {
                self.updating = false;
                self.found = None;
                self.state.app_update = AppUpdate::None;
            }
            // Installed even while a sign-in runs: only the relaunch waits for it.
            Event::UpdateChecked(Some(version)) => {
                // Checked every minute, a release that fails the same way was downloaded whole each minute: it waits
                // two checks, then four, eight, up to an hour, as the CLI's updater waits on a build it refused. A
                // newer version is tried at once.
                if let Some(failed) = self.failed.as_ref().filter(|failed| failed.version == version) {
                    let wait = (CHECK_EVERY_SECS << failed.tries.min(6)).min(RETRY_MAX_SECS);
                    if self.now.abs_diff(failed.at) < wait {
                        self.updating = false;
                        return;
                    }
                }
                // Said once per version: the check repeats every minute.
                if self.found.as_ref() != Some(&version) {
                    effects.push(Effect::Log(format!("update: found {version}")));
                }
                // A version already blocked keeps its row while it is tried again, so the menu does not flip.
                if self.state.app_update != AppUpdate::Blocked(version.clone()) {
                    self.state.app_update = AppUpdate::Installing;
                }
                self.found = Some(version);
                effects.push(Effect::InstallUpdate);
            }
            // `updating` stays set: until the relaunch this process is the old version, and a check would install
            // the same one again.
            Event::UpdateInstalled => {
                if let Some(version) = &self.found {
                    effects.push(Effect::Log(format!("update: installed {version}")));
                }
                self.state.app_update = AppUpdate::None;
                self.relaunch = true;
            }
            Event::UpdateFailed(failure) => self.update_failed(failure, effects),
            // Heard whatever became of the CLI since the click: the runner always answers, so the row never waits.
            Event::LogsExported(Ok(exported)) => {
                self.state.logs = LogsExport::Saved(exported.shown);
                effects.extend([Effect::Reveal(exported.zip), Effect::Log("logs: exported".into())]);
            }
            Event::LogsExported(Err(failure)) => {
                self.state.logs = LogsExport::Failed(failure);
                effects.push(Effect::Log(format!("logs: export failed: {}", reason(failure))));
            }
            Event::OrcaConnect(answer) if self.orca.running == Some(OrcaRun::Connect) => {
                self.orca.running = None;
                self.orca_answered(answer, effects);
                self.next_orca(effects);
            }
            Event::OrcaConnect(answer) if self.orca.running == Some(OrcaRun::Update) => {
                self.orca.running = None;
                self.orca_updated(answer, effects);
                self.next_orca(effects);
            }
            Event::OrcaStatus(status) if self.orca.running == Some(OrcaRun::Status) => {
                self.orca.running = None;
                self.orca_status(status, effects);
                self.next_orca(effects);
            }
            // A second answer to one run, or a run of a CLI that went away: nothing waits for it.
            Event::OrcaConnect(_) | Event::OrcaStatus(_) => {}
        }
    }

    fn orca_status(&mut self, status: Option<OrcaStatus>, effects: &mut Vec<Effect>) {
        let row = match status {
            Some(OrcaStatus::Offer) => OrcaState::Offer,
            Some(OrcaStatus::Approve) => OrcaState::Update,
            // Orca keeps the approval of an update that asks for no new access, so it runs with no click.
            Some(OrcaStatus::Behind) => {
                if !std::mem::replace(&mut self.orca_updated, true) {
                    self.orca.update = true;
                }
                OrcaState::None
            }
            Some(OrcaStatus::Absent | OrcaStatus::Off | OrcaStatus::Current) | None => OrcaState::None,
        };
        self.orca_row(row, effects);
    }

    /// The silent update shows no window and keeps no fingerprint: access Orca asks for is approved from the row only.
    fn orca_updated(&mut self, answer: OrcaAnswer, effects: &mut Vec<Effect>) {
        effects.push(Effect::Log(format!("orca connect: {}", orca_said(&answer))));
        let row = if matches!(answer, OrcaAnswer::Approve { .. }) { OrcaState::Update } else { OrcaState::None };
        self.orca_row(row, effects);
    }

    /// Logged in any case; drawn only in a window that shows the Orca screen, so a closed window stays closed. Only
    /// Done changes the row: an approval or a failure leaves it as the last status set it.
    fn orca_answered(&mut self, answer: OrcaAnswer, effects: &mut Vec<Effect>) {
        effects.push(Effect::Log(format!("orca connect: {}", orca_said(&answer))));
        if answer == OrcaAnswer::Done {
            self.orca_row(OrcaState::None, effects);
        }
        let Some(shown) = self.window.as_ref().filter(|shown| shown.screen == Screen::Orca) else { return };
        // An update keeps its words to the end; the access Orca lists says itself whether it is an update.
        let update = shown.update;
        let view = match answer {
            OrcaAnswer::Done => orca_at(Phase::Done, Vec::new(), update),
            OrcaAnswer::Approve { fingerprint, grants, update: listed } => {
                self.approval = Some(fingerprint);
                orca_at(Phase::Approve, grants, listed)
            }
            OrcaAnswer::Failed(error) => {
                let line = if error == OrcaError::NotRunning { ORCA_NOT_RUNNING } else { ORCA_FAILED };
                orca_at(Phase::Failed, vec![line.into()], update)
            }
        };
        self.show(Some(view), effects);
    }

    fn ask_orca(&mut self, effects: &mut Vec<Effect>) {
        self.orca.status = true;
        self.next_orca(effects);
    }

    /// One Orca run at a time: with none under way, the first that waits starts, the screen's connect before the silent
    /// update before a status.
    fn next_orca(&mut self, effects: &mut Vec<Effect>) {
        if self.orca.running.is_some() {
            return;
        }
        let (run, effect) = if let Some(approve) = self.orca.connect.take() {
            (OrcaRun::Connect, Effect::RunOrcaConnect(approve))
        } else if std::mem::take(&mut self.orca.update) {
            // Never with a fingerprint: a run nobody clicked approves nothing.
            (OrcaRun::Update, Effect::RunOrcaConnect(None))
        } else if std::mem::take(&mut self.orca.status) {
            self.orca_asked_at = Some(self.now);
            (OrcaRun::Status, Effect::RunOrcaStatus)
        } else {
            return;
        };
        self.orca.running = Some(run);
        effects.push(effect);
    }

    /// Logged at each change.
    fn orca_row(&mut self, row: OrcaState, effects: &mut Vec<Effect>) {
        if row == self.state.orca {
            return;
        }
        self.state.orca = row;
        let word = match row {
            OrcaState::None => "none",
            OrcaState::Offer => "offer",
            OrcaState::Update => "update",
        };
        effects.push(Effect::Log(format!("orca: {word}")));
    }

    /// A failure changes nothing on disk: the next check tries again.
    fn update_failed(&mut self, failure: UpdateFailure, effects: &mut Vec<Effect>) {
        self.updating = false;
        let word = match failure {
            UpdateFailure::Check => "check",
            UpdateFailure::Download => "download",
            UpdateFailure::Signature => "signature",
            UpdateFailure::Install => "install",
            // Nothing was downloaded. The menu offers the page instead, and the log says so once per version.
            UpdateFailure::NotWritable => {
                let Some(version) = self.found.clone() else { return };
                if self.skipped.as_ref() != Some(&version) {
                    effects.push(Effect::Log("update: skipped not-writable".into()));
                }
                self.skipped = Some(version.clone());
                self.state.app_update = AppUpdate::Blocked(version);
                return;
            }
        };
        effects.push(Effect::Log(format!("update: failed {word}")));
        if failure != UpdateFailure::Check
            && let Some(version) = self.found.clone()
        {
            let tries =
                self.failed.as_ref().filter(|failed| failed.version == version).map_or(1, |failed| failed.tries + 1);
            self.failed = Some(Failed { version, tries, at: self.now });
        }
        if self.state.app_update == AppUpdate::Installing {
            self.state.app_update = AppUpdate::None;
        }
    }

    /// The CLI install or a sign-in: no update check starts, and no relaunch, while one runs.
    fn running(&self) -> bool {
        self.state.cli == CliState::Installing || self.login.is_some()
    }

    /// The relaunch would also cut short a daemon start or what the window shows, so it waits for them too; a check
    /// does not, as the first launch's window is open right after the CLI install.
    fn relaunch_waits(&self) -> bool {
        self.running() || self.keep.starting() || self.window.is_some()
    }

    /// Only a button the window shows does something, so a second click on one that started a run does nothing.
    fn act(&mut self, action: Action, effects: &mut Vec<Effect>) {
        let Some(shown) = &self.window else { return };
        match (shown.screen, shown.phase, action) {
            (Screen::Install, Phase::Failed, Action::Retry) => self.install(effects),
            (Screen::SignIn, Phase::Offer, Action::SignIn) | (Screen::SignIn, Phase::Failed, Action::Retry) => {
                let working = screen_at(Screen::SignIn, Phase::Working, Vec::new());
                self.login = Some(working.clone());
                effects.push(Effect::RunLogin);
                self.show(Some(working), effects);
            }
            (Screen::SignIn, Phase::Offer, Action::Later) => {
                self.remember(|saved| saved.asked_sign_in = true, effects);
                self.next(effects);
            }
            (Screen::SignIn, Phase::Working | Phase::Browser, Action::Cancel) => {
                self.login = None;
                effects.push(Effect::CancelLogin);
                self.show(Some(screen_at(Screen::SignIn, Phase::Offer, Vec::new())), effects);
            }
            // The window asks Orca again from here, with no button: a second click runs nothing. The run waits for one
            // under way, with the fingerprint of the access the person clicked on.
            (Screen::Orca, Phase::Approve, Action::ConnectOrca) => {
                let update = shown.update;
                if let Some(fingerprint) = self.approval.take() {
                    self.orca.connect = Some(Some(fingerprint));
                    self.next_orca(effects);
                    self.show(Some(orca_at(Phase::Asking, vec![ASKING_ORCA.into()], update)), effects);
                }
            }
            // Cancel, Done and Close: the window closes, and Orca is asked nothing.
            (Screen::Orca, Phase::Approve | Phase::Done | Phase::Failed, Action::Cancel) => self.show(None, effects),
            _ => {}
        }
    }

    fn login_event(&mut self, event: LoginEvent, effects: &mut Vec<Effect>) {
        // A sign-in that was cancelled or went with its CLI answers late: nothing reads it, but for a success while its
        // CLI is here, as one that finished just after its cancel signed this computer in all the same.
        let Some(login) = &mut self.login else {
            if event == LoginEvent::Done(Ok(())) && self.state.cli == CliState::Found {
                self.signed_in(effects);
            }
            return;
        };
        match event {
            LoginEvent::AuthorizeUrl(url) => {
                effects.push(Effect::OpenUrl(url));
                login.phase = Phase::Browser;
                login.lines.clear();
                self.redraw(Screen::SignIn, effects);
            }
            LoginEvent::Waiting(text) => {
                login.lines = vec![text];
                self.redraw(Screen::SignIn, effects);
            }
            LoginEvent::Done(Ok(())) => self.signed_in(effects),
            LoginEvent::Done(Err(text)) => {
                self.login = None;
                if self.showing(Screen::SignIn) {
                    self.show(Some(screen_at(Screen::SignIn, Phase::Failed, vec![text])), effects);
                }
            }
        }
    }

    fn signed_in(&mut self, effects: &mut Vec<Effect>) {
        self.login = None;
        self.state.signed_in = Some(true);
        self.remember(|saved| saved.asked_sign_in = true, effects);
        effects.push(Effect::ReadAuth);
        if self.showing(Screen::SignIn) {
            self.next(effects);
        }
    }

    /// A CLI is here, as at start: the caller watches the daemon or starts it.
    fn found(&mut self, effects: &mut Vec<Effect>) {
        self.state.cli = CliState::Found;
        self.remember(|saved| saved.cli_seen = true, effects);
        self.keep = KeepAlive::new();
        self.awaiting_account = true;
        self.read(effects);
        self.orca_updated = false;
        self.ask_orca(effects);
    }

    fn run_start(&mut self, effects: &mut Vec<Effect>) {
        self.read_when_up = true;
        effects.push(Effect::RunStart);
    }

    fn stop_watch(&mut self, effects: &mut Vec<Effect>) {
        self.keep.stop_watch();
        effects.push(Effect::StopWatch);
    }

    /// Only where no CLI is: a CLI found after a failed install is never installed over.
    fn install(&mut self, effects: &mut Vec<Effect>) {
        if !matches!(self.state.cli, CliState::Removed | CliState::InstallFailed) {
            return;
        }
        self.state.cli = CliState::Installing;
        self.step = GETTING_READY;
        effects.push(Effect::RunInstall);
        self.show(Some(self.view_of(Screen::Install)), effects);
    }

    fn read(&mut self, effects: &mut Vec<Effect>) {
        effects.extend([Effect::ReadAuth, Effect::ReadVersion]);
        self.last_read = self.now;
    }

    /// At the account's first answer, the window shows the screen that is due. A window that shows another screen keeps
    /// it; the Install screen gives way, as its install has finished.
    fn first_screen(&mut self, effects: &mut Vec<Effect>) {
        if !std::mem::take(&mut self.awaiting_account) {
            return;
        }
        if self.window.as_ref().is_some_and(|shown| shown.screen != Screen::Install) {
            return;
        }
        let view = due(&self.state).map(|screen| self.view_of(screen));
        if view != self.window {
            self.show(view, effects);
        }
    }

    /// A screen ended: the next one due, or no window.
    fn next(&mut self, effects: &mut Vec<Effect>) {
        let view = due(&self.state).map(|screen| self.view_of(screen));
        self.show(view, effects);
    }

    /// The screen as it stands: what runs shows its progress, else the offer.
    fn view_of(&self, screen: Screen) -> View {
        match screen {
            Screen::Install => screen_at(screen, Phase::Working, vec![self.step.to_string()]),
            Screen::SignIn => self.login.clone().unwrap_or_else(|| screen_at(screen, Phase::Offer, Vec::new())),
            // Opened from the menu, it asks Orca, in the words of the row clicked.
            Screen::Orca => orca_at(Phase::Asking, vec![ASKING_ORCA.into()], self.state.orca == OrcaState::Update),
        }
    }

    /// A run that moved on is drawn only in a window that shows it: a closed window stays closed.
    fn redraw(&mut self, screen: Screen, effects: &mut Vec<Effect>) {
        if self.showing(screen) {
            self.show(Some(self.view_of(screen)), effects);
        }
    }

    fn showing(&self, screen: Screen) -> bool {
        self.window.as_ref().is_some_and(|shown| shown.screen == screen)
    }

    fn show(&mut self, view: Option<View>, effects: &mut Vec<Effect>) {
        // Cancel, a close, another screen or the CLI gone: the access shown is no longer, and its fingerprint goes.
        if !view.as_ref().is_some_and(|view| view.screen == Screen::Orca && view.phase == Phase::Approve) {
            self.approval = None;
        }
        self.window = view.clone();
        effects.push(Effect::Show(view));
    }

    /// Saves only what changed.
    fn remember(&mut self, change: impl FnOnce(&mut Saved), effects: &mut Vec<Effect>) {
        let before = self.state.saved;
        change(&mut self.state.saved);
        if self.state.saved != before {
            effects.push(Effect::Save(self.state.saved));
        }
    }

    /// Every event ends here: a menu that changed is sent, and logged.
    fn send_menu(&mut self, effects: &mut Vec<Effect>) {
        self.state.daemon = self.keep.daemon();
        let items = menu(&self.state);
        if items != self.menu {
            effects.push(Effect::Menu(items.clone()));
            effects.push(Effect::Log(format!("menu: {}", menu_log(&items))));
            self.menu = items;
        }
    }
}

/// A version whose download, signature or install failed `tries` times, the last at `at`.
struct Failed {
    version: String,
    tries: u32,
    at: u64,
}

/// An Orca run. Update: the silent update, a connect nobody clicked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OrcaRun {
    Status,
    Update,
    Connect,
}

/// One Orca run at a time, as two commands on the plugin's folder at once would fail one another, and the ones that
/// wait for it.
#[derive(Default)]
struct OrcaRuns {
    /// Only its answer is heard.
    running: Option<OrcaRun>,
    /// The screen's connect, with the fingerprint the Connect click took.
    connect: Option<Option<Fingerprint>>,
    update: bool,
    status: bool,
}

fn screen_at(screen: Screen, phase: Phase, lines: Vec<String>) -> View {
    View { screen, phase, lines, update: false }
}

fn orca_at(phase: Phase, lines: Vec<String>, update: bool) -> View {
    View { screen: Screen::Orca, phase, lines, update }
}

/// What the log says of an answer: its kind and code, never what Orca listed.
fn orca_said(answer: &OrcaAnswer) -> &'static str {
    match answer {
        OrcaAnswer::Done => "done",
        OrcaAnswer::Approve { .. } => "approve",
        OrcaAnswer::Failed(OrcaError::NotRunning) => "failed not-running",
        OrcaAnswer::Failed(OrcaError::NoPlugin) => "failed no-plugin",
        OrcaAnswer::Failed(OrcaError::Off) => "failed off",
        OrcaAnswer::Failed(OrcaError::Timeout) => "failed timeout",
        OrcaAnswer::Failed(OrcaError::Failed) => "failed failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::{DOWNLOADING_HARNESS, GETTING_READY, INSTALLING_TMUX};
    use crate::types::{
        Action, DialStatus, Effect, Event, ExportFailure, Exported, Fingerprint, LoginEvent, MenuAction, MenuItem,
        NotifyMode, OrcaAnswer, OrcaError, OrcaStatus, Phase, Saved, Screen, UpdateFailure, View,
    };
    use std::path::PathBuf;

    /// Second 0 of a minute.
    const B: u64 = 1794556800;

    /// How often the app asks for its own update: as often as the CLI.
    const M1: u64 = 60;

    /// A CLI seen before and a login item registered: only what each test does is saved.
    const SEEN: Saved = Saved { version: 1, cli_seen: true, asked_sign_in: false, login_item: true };

    fn found() -> App {
        App::new(SEEN, true, false, B).0
    }

    /// No CLI, never seen.
    fn fresh() -> App {
        App::new(Saved { login_item: true, ..Saved::default() }, false, false, B).0
    }

    fn removed() -> App {
        App::new(SEEN, false, false, B).0
    }

    fn has(effects: &[Effect], effect: &Effect) -> bool {
        effects.contains(effect)
    }

    fn count(effects: &[Effect], effect: &Effect) -> usize {
        effects.iter().filter(|each| *each == effect).count()
    }

    /// The labels of the last menu sent.
    fn rows(effects: &[Effect]) -> Vec<String> {
        let items = effects
            .iter()
            .rev()
            .find_map(|effect| match effect {
                Effect::Menu(items) => Some(items),
                _ => None,
            })
            .expect("a menu");
        items
            .iter()
            .filter_map(|item| match item {
                MenuItem::Text(label)
                | MenuItem::Action(_, label)
                | MenuItem::Check(_, label, _)
                | MenuItem::Submenu(label, _) => Some(label.clone()),
                MenuItem::Separator => None,
            })
            .collect()
    }

    /// The items of the last menu sent.
    fn menu_of(effects: &[Effect]) -> Vec<MenuItem> {
        effects
            .iter()
            .rev()
            .find_map(|effect| match effect {
                Effect::Menu(items) => Some(items.clone()),
                _ => None,
            })
            .expect("a menu")
    }

    /// What the window was told to show, in order.
    fn shows(effects: &[Effect]) -> Vec<Option<View>> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Show(view) => Some(view.clone()),
                _ => None,
            })
            .collect()
    }

    /// The log lines that are not the menu.
    fn logs(effects: &[Effect]) -> Vec<String> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Log(line) if !line.starts_with("menu: ") => Some(line.clone()),
                _ => None,
            })
            .collect()
    }

    fn shown(screen: Screen, phase: Phase, lines: &[&str]) -> Option<View> {
        Some(View { screen, phase, lines: lines.iter().map(|line| line.to_string()).collect(), update: false })
    }

    fn tick(now: u64) -> Event {
        Event::Tick { now, desktop_running: false }
    }

    fn login(event: LoginEvent) -> Event {
        Event::Login(event)
    }

    /// The account's first answer.
    fn answer(app: &mut App, signed_in: bool) -> Vec<Effect> {
        app.handle(Event::Auth(Some(signed_in)))
    }

    /// Found, signed out: the window offers sign-in.
    fn on_sign_in() -> App {
        let mut app = found();
        answer(&mut app, false);
        assert_eq!(app.view(), shown(Screen::SignIn, Phase::Offer, &[]));
        app
    }

    #[test]
    fn a_found_cli_is_watched_and_read() {
        let (app, effects) = App::new(Saved::default(), true, false, B);
        let seen = Saved { cli_seen: true, ..Saved::default() };
        let asked =
            [Effect::SpawnWatch, Effect::ReadAuth, Effect::ReadVersion, Effect::Save(seen), Effect::RegisterLoginItem];
        for effect in asked {
            assert!(has(&effects, &effect), "{effect:?}");
        }
        assert_eq!(rows(&effects)[0], "Starting Harness");
        assert!(shows(&effects).is_empty());
        assert_eq!(app.view(), None);

        let (_, effects) = App::new(SEEN, true, false, B);
        assert!(!effects.iter().any(|effect| matches!(effect, Effect::Save(_))));
    }

    #[test]
    fn no_cli_ever_seen_installs_on_its_own() {
        let (app, effects) = App::new(Saved::default(), false, false, B);
        assert!(has(&effects, &Effect::RunInstall));
        assert!(!has(&effects, &Effect::SpawnWatch));
        assert_eq!(shows(&effects), [shown(Screen::Install, Phase::Working, &[GETTING_READY])]);
        assert_eq!(rows(&effects)[0], "Setting up Harness");
        assert_eq!(app.view(), shown(Screen::Install, Phase::Working, &[GETTING_READY]));
    }

    #[test]
    fn a_cli_that_was_seen_and_is_gone_is_never_reinstalled() {
        let (app, effects) = App::new(SEEN, false, false, B);
        assert!(effects.iter().all(|effect| matches!(effect, Effect::Menu(_) | Effect::Log(_))), "{effects:?}");
        assert_eq!(rows(&effects), ["Harness removed", "Install", "About", "Quit"]);
        assert_eq!(app.view(), None);

        let mut app = found();
        let effects = app.handle(Event::Cli(false));
        assert!(has(&effects, &Effect::StopWatch));
        assert!(!has(&effects, &Effect::RunInstall));
        assert_eq!(rows(&effects), ["Harness removed", "Install", "About", "Quit"]);
    }

    #[test]
    fn a_cli_that_goes_away_ends_what_needed_it() {
        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        let effects = app.handle(Event::Cli(false));
        assert!(has(&effects, &Effect::StopWatch));
        assert_eq!(shows(&effects), [None]);
        assert_eq!(rows(&effects), ["Harness removed", "Install", "About", "Quit"]);

        // The sign-in it was running is gone with it: a CLI that comes back can sign in again.
        app.handle(Event::Cli(true));
        assert_eq!(shows(&answer(&mut app, false)), [shown(Screen::SignIn, Phase::Offer, &[])]);
        assert!(has(&app.handle(Event::Act(Action::SignIn)), &Effect::RunLogin));
    }

    #[test]
    fn reads_that_answer_after_the_cli_went_away_are_not_heard() {
        let mut app = found();
        let mut effects = app.handle(Event::Cli(false));
        effects.extend(app.handle(Event::Auth(Some(true))));
        assert_eq!(rows(&effects), ["Harness removed", "Install", "About", "Quit"]);
    }

    #[test]
    fn the_login_item_is_registered_once() {
        let saved = Saved { cli_seen: true, ..Saved::default() };
        let (mut app, effects) = App::new(saved, true, false, B);
        assert!(has(&effects, &Effect::RegisterLoginItem));
        let registered = Saved { login_item: true, ..saved };
        assert_eq!(app.handle(Event::LoginItem(true)), [Effect::Save(registered)]);

        let (_, effects) = App::new(registered, true, false, B);
        assert!(!has(&effects, &Effect::RegisterLoginItem));

        let (mut app, _) = App::new(saved, true, false, B);
        assert!(app.handle(Event::LoginItem(false)).is_empty());
    }

    #[test]
    fn an_install_that_works_starts_the_daemon_and_moves_on() {
        let mut app = fresh();
        let effects = app.handle(Event::InstallDone(Ok(())));
        let seen = Saved { cli_seen: true, login_item: true, ..Saved::default() };
        for effect in [Effect::Save(seen), Effect::RunStart, Effect::ReadAuth] {
            assert!(has(&effects, &effect), "{effect:?}");
        }
        assert!(!has(&effects, &Effect::SpawnWatch));
        assert!(shows(&effects).is_empty());
        assert_eq!(app.view(), shown(Screen::Install, Phase::Working, &[GETTING_READY]));
        assert_eq!(rows(&effects)[0], "Starting Harness");

        // Started at once, outside the slot, and once: a tick in the next slot asks nothing while it runs.
        assert!(!has(&app.handle(tick(B + 70)), &Effect::RunStart));
        assert!(has(&app.handle(Event::StartDone { ok: true }), &Effect::SpawnWatch));
        assert_eq!(shows(&answer(&mut app, false)), [shown(Screen::SignIn, Phase::Offer, &[])]);
    }

    #[test]
    fn an_install_while_the_desktop_app_runs_leaves_the_start_to_it() {
        let mut app = fresh();
        app.handle(Event::Tick { now: B + 5, desktop_running: true });
        let effects = app.handle(Event::InstallDone(Ok(())));
        assert!(!has(&effects, &Effect::RunStart));
        assert!(has(&effects, &Effect::SpawnWatch));
        assert_eq!(logs(&effects), ["keep-alive: the desktop app runs; not starting"]);
    }

    #[test]
    fn an_install_that_fails_shows_its_lines_and_retry() {
        let mut app = fresh();
        let effects = app.handle(Event::InstallDone(Err(vec!["a".into(), "b".into()])));
        assert_eq!(shows(&effects), [shown(Screen::Install, Phase::Failed, &["a", "b"])]);
        assert_eq!(rows(&effects)[..2], ["Setting up Harness", "Install"]);

        let effects = app.handle(Event::Act(Action::Retry));
        assert!(has(&effects, &Effect::RunInstall));
        assert_eq!(shows(&effects), [shown(Screen::Install, Phase::Working, &[GETTING_READY])]);
    }

    #[test]
    fn the_install_screen_shows_its_step() {
        let at = |step: &str| shown(Screen::Install, Phase::Working, &[step]);
        let (mut app, effects) = App::new(Saved::default(), false, false, B);
        assert_eq!(shows(&effects), [at(GETTING_READY)]);
        assert_eq!(shows(&app.handle(Event::InstallStep(INSTALLING_TMUX))), [at(INSTALLING_TMUX)]);
        assert!(shows(&app.handle(Event::InstallStep(INSTALLING_TMUX))).is_empty());

        // A closed window stays closed.
        app.handle(Event::WindowClosed);
        assert!(shows(&app.handle(Event::InstallStep(DOWNLOADING_HARNESS))).is_empty());
        assert_eq!(app.view(), None);

        // Retry starts again at the beginning.
        let mut app = fresh();
        app.handle(Event::InstallStep(DOWNLOADING_HARNESS));
        app.handle(Event::InstallDone(Err(vec!["a".into()])));
        assert_eq!(shows(&app.handle(Event::Act(Action::Retry))), [at(GETTING_READY)]);

        // The last step stays until the first screen is chosen; a step that comes after the install is not drawn.
        let mut app = fresh();
        app.handle(Event::InstallStep(INSTALLING_TMUX));
        app.handle(Event::InstallDone(Ok(())));
        assert_eq!(app.view(), at(INSTALLING_TMUX));
        assert!(shows(&app.handle(Event::InstallStep(DOWNLOADING_HARNESS))).is_empty());
        assert_eq!(app.view(), at(INSTALLING_TMUX));
    }

    #[test]
    fn retry_never_installs_over_a_cli_that_was_found() {
        let mut app = fresh();
        app.handle(Event::InstallDone(Err(vec!["a".into()])));
        app.handle(Event::Cli(true));
        assert!(!has(&app.handle(Event::Act(Action::Retry)), &Effect::RunInstall));
    }

    #[test]
    fn the_first_screen_waits_for_the_account() {
        // The account's answer chooses it, once.
        let mut app = found();
        assert_eq!(shows(&app.handle(Event::Auth(Some(false)))), [shown(Screen::SignIn, Phase::Offer, &[])]);
        assert!(shows(&app.handle(Event::Auth(Some(false)))).is_empty());

        // The Install screen gives way at it.
        let mut app = fresh();
        app.handle(Event::InstallDone(Ok(())));
        assert_eq!(shows(&app.handle(Event::Auth(Some(true)))), [None]);

        let asked = Saved { asked_sign_in: true, ..SEEN };
        let mut app = App::new(asked, true, false, B).0;
        assert!(shows(&answer(&mut app, false)).is_empty());
        assert_eq!(app.view(), None);
    }

    #[test]
    fn no_offer_screen_at_first_run() {
        let mut app = found();
        let effects = answer(&mut app, true);
        assert!(shows(&effects).is_empty());
        assert_eq!(app.view(), None);

        // After the CLI's install too: the Install screen closes.
        let mut app = fresh();
        app.handle(Event::InstallDone(Ok(())));
        assert_eq!(shows(&answer(&mut app, true)), [None]);
        assert_eq!(app.view(), None);
    }

    #[test]
    fn sign_in_from_offer_to_browser_to_done() {
        let mut app = on_sign_in();
        let effects = app.handle(Event::Act(Action::SignIn));
        assert!(has(&effects, &Effect::RunLogin));
        assert_eq!(shows(&effects), [shown(Screen::SignIn, Phase::Working, &[])]);

        let url = "https://id.example/a?state=S".to_string();
        let effects = app.handle(login(LoginEvent::AuthorizeUrl(url.clone())));
        assert!(has(&effects, &Effect::OpenUrl(url)));
        assert_eq!(shows(&effects), [shown(Screen::SignIn, Phase::Browser, &[])]);

        let effects = app.handle(login(LoginEvent::Waiting("w".into())));
        assert_eq!(shows(&effects), [shown(Screen::SignIn, Phase::Browser, &["w"])]);

        let effects = app.handle(login(LoginEvent::Done(Ok(()))));
        assert!(has(&effects, &Effect::Save(Saved { asked_sign_in: true, ..SEEN })));
        assert!(has(&effects, &Effect::ReadAuth));
        assert!(rows(&effects).contains(&"Signed in".to_string()));
        // Nothing is due after it: the window closes.
        assert_eq!(shows(&effects), [None]);
    }

    #[test]
    fn a_sign_in_that_fails_offers_retry() {
        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        let effects = app.handle(login(LoginEvent::Done(Err("fetch failed".into()))));
        assert_eq!(shows(&effects), [shown(Screen::SignIn, Phase::Failed, &["fetch failed"])]);
        assert!(has(&app.handle(Event::Act(Action::Retry)), &Effect::RunLogin));
    }

    #[test]
    fn cancel_takes_the_sign_in_back() {
        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        app.handle(login(LoginEvent::AuthorizeUrl("https://id.example/a".into())));
        let effects = app.handle(Event::Act(Action::Cancel));
        assert!(has(&effects, &Effect::CancelLogin));
        assert_eq!(shows(&effects), [shown(Screen::SignIn, Phase::Offer, &[])]);
        assert!(app.handle(login(LoginEvent::Done(Err("cancelled".into())))).is_empty());
    }

    #[test]
    fn a_sign_in_that_finishes_just_after_cancel_signed_in() {
        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        app.handle(login(LoginEvent::AuthorizeUrl("https://id.example/a".into())));
        app.handle(Event::Act(Action::Cancel));
        let effects = app.handle(login(LoginEvent::Done(Ok(()))));
        assert!(has(&effects, &Effect::ReadAuth));
        assert!(has(&effects, &Effect::Save(Saved { asked_sign_in: true, ..SEEN })));
        assert!(rows(&effects).contains(&"Signed in".to_string()));
        assert_eq!(shows(&effects), [None]);

        // One that went with its CLI signed in no CLI that is here.
        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        app.handle(Event::Cli(false));
        assert!(app.handle(login(LoginEvent::Done(Ok(())))).is_empty());
    }

    #[test]
    fn later_is_remembered() {
        let mut app = found();
        answer(&mut app, false);
        let later = Saved { asked_sign_in: true, ..SEEN };
        let effects = app.handle(Event::Act(Action::Later));
        assert!(has(&effects, &Effect::Save(later)));
        assert_eq!(shows(&effects), [None]);

        let mut app = App::new(later, true, false, B).0;
        assert!(shows(&answer(&mut app, false)).is_empty());
    }

    #[test]
    fn the_menu_reads_again_at_most_once_a_minute() {
        let reads = |effects: &[Effect]| [Effect::ReadAuth, Effect::ReadVersion].map(|read| has(effects, &read));
        let opened = |now: u64, desktop_installed: bool| Event::MenuOpened { now, desktop_installed };
        let mut app = found();
        assert_eq!(reads(&app.handle(opened(B + 10, false))), [false; 2]);
        assert_eq!(reads(&app.handle(opened(B + 60, false))), [true; 2]);
        assert_eq!(reads(&app.handle(opened(B + 70, false))), [false; 2]);

        let effects = app.handle(opened(B + 80, true));
        assert_eq!(rows(&effects), ["Starting Harness", "Open Harness", "Export logs", "About", "Quit"]);
        assert_eq!(rows(&app.handle(opened(B + 90, false))), ["Starting Harness", "Export logs", "About", "Quit"]);

        assert_eq!(reads(&removed().handle(opened(B + 120, false))), [false; 2]);
    }

    #[test]
    fn the_first_status_line_after_a_start_reads_again() {
        let reads = |effects: &[Effect]| has(effects, &Effect::ReadAuth);
        let line = || {
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
        };

        // The reads after an install ran beside the start, while the daemon may have been down.
        let mut app = fresh();
        app.handle(Event::InstallDone(Ok(())));
        answer(&mut app, false);
        app.handle(Event::StartDone { ok: true });
        assert!(reads(&app.handle(line())));
        assert!(!reads(&app.handle(line())));

        let mut app = found();
        app.handle(Event::WatchExit(Some(3)));
        app.handle(tick(B + 5));
        app.handle(Event::WatchExit(Some(3)));
        assert!(has(&app.handle(tick(B + 10)), &Effect::RunStart));
        app.handle(Event::StartDone { ok: true });
        assert!(reads(&app.handle(line())));

        // A watch that connects with no start before it reads nothing.
        assert!(!reads(&found().handle(line())));
    }

    #[test]
    fn a_sound_click_asks_the_dial_and_draws_the_menu_again() {
        let mut app = found();
        let line = DialStatus {
            attached: true,
            fw: Some("0.0.95".into()),
            hw: None,
            board: None,
            updating: None,
            problem: None,
            muted: None,
            notify: None,
        };
        let menu = menu_of(&app.handle(Event::WatchLine(line)));
        // Twice over: a click remembers nothing, so the same click gives the same effects.
        for _ in 0..2 {
            for (action, on) in [(MenuAction::SoundOff, false), (MenuAction::SoundOn, true)] {
                assert_eq!(app.handle(Event::Menu(action)), [Effect::SetSound(on), Effect::Menu(menu.clone())]);
            }
        }
    }

    #[test]
    fn the_check_follows_the_dial_not_the_click() {
        let mut app = found();
        let line = |muted| {
            Event::WatchLine(DialStatus {
                attached: true,
                fw: Some("0.0.95".into()),
                hw: None,
                board: None,
                updating: None,
                problem: None,
                muted: Some(muted),
                notify: None,
            })
        };
        let checks = |effects: &[Effect]| -> Vec<MenuItem> {
            menu_of(effects).into_iter().filter(|item| matches!(item, MenuItem::Check(..))).collect()
        };
        let on = MenuItem::Check(MenuAction::SoundOff, "Sound".into(), true);
        let off = MenuItem::Check(MenuAction::SoundOn, "Sound".into(), false);

        let effects = app.handle(line(false));
        assert_eq!(checks(&effects), vec![on.clone()]);
        assert!(has(&effects, &Effect::Log("menu: Device ready | Sound ✓ | Export logs | About | Quit".into())));

        // The click's own check flipped natively: the menu drawn again puts it back where the dial is.
        let effects = app.handle(Event::Menu(MenuAction::SoundOff));
        assert_eq!(checks(&effects), [on]);
        assert!(!effects.iter().any(|effect| matches!(effect, Effect::Log(text) if text.starts_with("menu:"))));

        let effects = app.handle(line(true));
        assert_eq!(checks(&effects), [off]);
        assert!(has(&effects, &Effect::Log("menu: Device ready | Sound | Export logs | About | Quit".into())));

        assert!(checks(&app.handle(Event::WatchExit(Some(3)))).is_empty());
    }

    fn notifying(mode: NotifyMode) -> Event {
        Event::WatchLine(DialStatus {
            attached: true,
            fw: Some("0.0.95".into()),
            hw: None,
            board: None,
            updating: None,
            problem: None,
            muted: None,
            notify: Some(mode),
        })
    }

    #[test]
    fn a_notifications_click_tells_the_watch_and_draws_the_menu_again() {
        let mut app = found();
        let menu = menu_of(&app.handle(notifying(NotifyMode::Full)));
        // Twice over: a click remembers nothing, so the same click gives the same effects.
        for _ in 0..2 {
            for (action, mode) in [(MenuAction::NotifyYou, NotifyMode::You), (MenuAction::NotifyFull, NotifyMode::Full)]
            {
                assert_eq!(app.handle(Event::Menu(action)), [Effect::SetNotify(mode), Effect::Menu(menu.clone())]);
            }
        }
    }

    #[test]
    fn the_check_follows_the_watch_not_the_click() {
        let mut app = found();
        let submenus = |effects: &[Effect]| -> Vec<MenuItem> {
            menu_of(effects).into_iter().filter(|item| matches!(item, MenuItem::Submenu(..))).collect()
        };
        let checked = |full, you| {
            MenuItem::Submenu(
                "Notifications".into(),
                vec![
                    MenuItem::Check(MenuAction::NotifyFull, "All".into(), full),
                    MenuItem::Check(MenuAction::NotifyYou, "Needs you".into(), you),
                ],
            )
        };

        let effects = app.handle(notifying(NotifyMode::Full));
        assert_eq!(submenus(&effects), [checked(true, false)]);
        assert!(has(
            &effects,
            &Effect::Log("menu: Device ready | Notifications: All | Export logs | About | Quit".into())
        ));

        // The click's own check flipped natively: the menu drawn again puts it back where the watch says.
        let effects = app.handle(Event::Menu(MenuAction::NotifyYou));
        assert_eq!(submenus(&effects), [checked(true, false)]);
        assert!(!effects.iter().any(|effect| matches!(effect, Effect::Log(text) if text.starts_with("menu:"))));

        let effects = app.handle(notifying(NotifyMode::You));
        assert_eq!(submenus(&effects), [checked(false, true)]);
        assert!(has(
            &effects,
            &Effect::Log("menu: Device ready | Notifications: Needs you | Export logs | About | Quit".into())
        ));

        assert!(submenus(&app.handle(Event::WatchExit(Some(3)))).is_empty());
    }

    #[test]
    fn a_dial_line_changes_the_menu_and_the_log() {
        let mut app = found();
        let line = DialStatus {
            attached: true,
            fw: Some("0.0.95".into()),
            hw: None,
            board: None,
            updating: None,
            problem: None,
            muted: None,
            notify: None,
        };
        let effects = app.handle(Event::WatchLine(line.clone()));
        assert_eq!(rows(&effects)[0], "Device ready");
        assert!(has(&effects, &Effect::Log("menu: Device ready | Export logs | About | Quit".into())));
        assert!(app.handle(Event::WatchLine(line)).is_empty());

        assert_eq!(rows(&app.handle(Event::WatchExit(Some(3))))[0], "Starting Harness");
    }

    #[test]
    fn the_keep_alive_drives_the_daemon() {
        let two_downs = || {
            let mut app = found();
            app.handle(Event::WatchExit(Some(3)));
            assert_eq!(app.handle(tick(B + 5)), [Effect::SpawnWatch, Effect::CheckUpdate]);
            app.handle(Event::WatchExit(Some(3)));
            app
        };

        let mut app = two_downs();
        assert!(has(&app.handle(tick(B + 10)), &Effect::RunStart));
        assert!(has(&app.handle(Event::StartDone { ok: true }), &Effect::SpawnWatch));
        let effects = app.handle(Event::WatchExit(Some(3)));
        assert_eq!(rows(&effects)[0], "Harness stopped");
        assert_eq!(logs(&effects), ["keep-alive: the start changed nothing"]);
        app.handle(tick(B + 15));
        assert!(logs(&app.handle(Event::WatchExit(Some(3)))).is_empty());

        let mut app = two_downs();
        // Told only when a start is held back, not when the desktop app starts running.
        assert!(logs(&app.handle(Event::Tick { now: B + 9, desktop_running: true })).is_empty());
        let effects = app.handle(Event::Tick { now: B + 10, desktop_running: true });
        assert!(!has(&effects, &Effect::RunStart));
        assert!(!has(&effects, &Effect::SpawnWatch));
        assert_eq!(logs(&effects), ["keep-alive: the desktop app runs; not starting"]);
        assert!(logs(&app.handle(Event::Tick { now: B + 15, desktop_running: true })).is_empty());
        // It still watches the dial: it looks again 15 s after the last down.
        assert_eq!(app.handle(Event::Tick { now: B + 20, desktop_running: true }), [Effect::SpawnWatch]);
    }

    #[test]
    fn only_a_watch_the_app_stopped_ends_for_good() {
        let mut app = found();
        app.handle(Event::WatchExit(Some(0)));
        assert_eq!(app.handle(tick(B + 5)), [Effect::SpawnWatch, Effect::CheckUpdate]);

        let mut app = found();
        app.handle(Event::Menu(MenuAction::Quit));
        app.handle(Event::WatchExit(Some(0)));
        assert!(!has(&app.handle(tick(B + 5)), &Effect::SpawnWatch));
    }

    #[test]
    fn a_cli_that_comes_back_is_found_on_a_tick() {
        let mut app = removed();
        assert_eq!(app.handle(tick(B + 5)), [Effect::FindCli, Effect::CheckUpdate]);
        let effects = app.handle(Event::Cli(true));
        for effect in [Effect::SpawnWatch, Effect::ReadAuth, Effect::ReadVersion] {
            assert!(has(&effects, &effect), "{effect:?}");
        }
        assert_eq!(rows(&effects), ["Starting Harness", "Export logs", "About", "Quit"]);

        // An install under way is not looked past.
        assert!(!has(&fresh().handle(tick(B + 5)), &Effect::FindCli));
    }

    #[test]
    fn a_second_click_runs_nothing_twice() {
        let mut app = on_sign_in();
        let mut effects = app.handle(Event::Act(Action::SignIn));
        effects.extend(app.handle(Event::Act(Action::SignIn)));
        effects.extend(app.handle(Event::Menu(MenuAction::SignIn)));
        effects.extend(app.handle(Event::Menu(MenuAction::SignIn)));
        assert_eq!(count(&effects, &Effect::RunLogin), 1);
        assert_eq!(app.view(), shown(Screen::SignIn, Phase::Working, &[]));

        let mut app = removed();
        let mut effects = app.handle(Event::Menu(MenuAction::Install));
        effects.extend(app.handle(Event::Menu(MenuAction::Install)));
        assert_eq!(count(&effects, &Effect::RunInstall), 1);

        // A button the window does not show does nothing.
        assert!(found().handle(Event::Act(Action::SignIn)).is_empty());
    }

    #[test]
    fn closing_the_window_on_an_offer_is_later() {
        let mut app = on_sign_in();
        let effects = app.handle(Event::WindowClosed);
        assert!(has(&effects, &Effect::Save(Saved { asked_sign_in: true, ..SEEN })));
        assert_eq!(shows(&effects), [None]);
    }

    #[test]
    fn closing_the_window_never_stops_what_runs() {
        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        app.handle(login(LoginEvent::AuthorizeUrl("https://id.example/a".into())));
        let effects = app.handle(Event::WindowClosed);
        assert!(!has(&effects, &Effect::CancelLogin));
        assert!(has(&effects, &Effect::Save(Saved { asked_sign_in: true, ..SEEN })));
        assert_eq!(shows(&effects), [None]);
        let effects = app.handle(login(LoginEvent::Done(Ok(()))));
        assert!(rows(&effects).contains(&"Signed in".to_string()));
        assert!(shows(&effects).is_empty());

        // Decision 1: a failed install whose window was closed is offered from the menu.
        let mut app = fresh();
        assert_eq!(app.handle(Event::WindowClosed), [Effect::Show(None)]);
        let effects = app.handle(Event::InstallDone(Err(vec!["x".into()])));
        assert_eq!(rows(&effects), ["Setting up Harness", "Install", "About", "Quit"]);
        assert!(shows(&effects).is_empty());
    }

    #[test]
    fn about_shows_the_versions_it_knows() {
        let about = |app: &mut App| app.handle(Event::Menu(MenuAction::About));
        let mut app = found();
        assert_eq!(about(&mut app), [Effect::ShowAbout(None)]);
        assert!(app.handle(Event::CliVersion(Some("0.6.58".into()))).is_empty());
        assert_eq!(about(&mut app), [Effect::ShowAbout(Some("Harness 0.6.58".into()))]);
        app.handle(notifying(NotifyMode::Full));
        assert_eq!(about(&mut app), [Effect::ShowAbout(Some("Device 0.0.95 · Harness 0.6.58".into()))]);
        // A read that failed keeps the last answer.
        app.handle(Event::CliVersion(None));
        assert_eq!(about(&mut app), [Effect::ShowAbout(Some("Device 0.0.95 · Harness 0.6.58".into()))]);

        // A CLI that went away takes its version with it, and its read that answers late is not heard.
        let mut app = found();
        app.handle(Event::CliVersion(Some("0.6.58".into())));
        app.handle(Event::Cli(false));
        app.handle(Event::CliVersion(Some("0.6.58".into())));
        assert_eq!(about(&mut app), [Effect::ShowAbout(None)]);
    }

    #[test]
    fn open_and_quit() {
        let mut app = found();
        assert_eq!(app.handle(Event::Menu(MenuAction::OpenHarness)), [Effect::OpenDesktop]);
        assert_eq!(app.handle(Event::Menu(MenuAction::Quit)), [Effect::StopWatch, Effect::Quit]);
    }

    #[test]
    fn the_first_tick_checks_and_then_every_minute() {
        let mut app = found();
        assert!(has(&app.handle(tick(B + 5)), &Effect::CheckUpdate));
        app.handle(Event::UpdateChecked(None));
        for now in [B + 10, B + M1] {
            assert!(!has(&app.handle(tick(now)), &Effect::CheckUpdate), "{now}");
        }
        assert!(has(&app.handle(tick(B + 5 + M1)), &Effect::CheckUpdate));
        app.handle(Event::UpdateChecked(None));
        // A clock set back checks too: abs_diff.
        assert!(has(&app.handle(tick(B + 5)), &Effect::CheckUpdate));
    }

    #[test]
    fn no_second_check_starts_while_one_runs() {
        let mut app = found();
        assert!(has(&app.handle(tick(B + 5)), &Effect::CheckUpdate));
        // A Mac asleep through the check, or a clock that jumps: a minute on, it has not answered.
        assert!(!has(&app.handle(tick(B + 5 + M1)), &Effect::CheckUpdate));
        app.handle(Event::UpdateChecked(None));
        assert!(has(&app.handle(tick(B + 10 + M1)), &Effect::CheckUpdate));
    }

    #[test]
    fn no_check_starts_while_the_cli_installs_or_a_sign_in_runs() {
        let mut app = fresh();
        assert!(!has(&app.handle(tick(B + 5)), &Effect::CheckUpdate));
        app.handle(Event::InstallDone(Ok(())));
        assert!(has(&app.handle(tick(B + 10)), &Effect::CheckUpdate));

        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        assert!(!has(&app.handle(tick(B + 5)), &Effect::CheckUpdate));
        app.handle(login(LoginEvent::Done(Ok(()))));
        assert!(has(&app.handle(tick(B + 10)), &Effect::CheckUpdate));
    }

    #[test]
    fn a_newer_version_is_installed_and_the_app_relaunches() {
        let mut app = found();
        app.handle(tick(B + 5));
        let effects = app.handle(Event::UpdateChecked(Some("0.1.3".into())));
        assert!(has(&effects, &Effect::InstallUpdate));
        assert_eq!(logs(&effects), ["update: found 0.1.3"]);
        let menu = menu_of(&effects);
        let row = MenuItem::Text("Updating Harness…".into());
        let at = menu.iter().position(|item| *item == row).expect("the row");
        assert_eq!(menu[at + 1], MenuItem::Separator);
        assert!(!has(&app.handle(tick(B + 5 + M1)), &Effect::CheckUpdate));

        let effects = app.handle(Event::UpdateInstalled);
        assert_eq!(logs(&effects), ["update: installed 0.1.3"]);
        assert!(!rows(&effects).contains(&"Updating Harness…".to_string()));
        assert!(!has(&effects, &Effect::Relaunch));
        assert_eq!(app.handle(tick(B + 10 + M1)), [Effect::StopWatch, Effect::Relaunch]);
    }

    #[test]
    fn a_sign_in_delays_the_relaunch_not_the_download() {
        let mut app = on_sign_in();
        app.handle(tick(B + 5));
        app.handle(Event::Act(Action::SignIn));
        assert!(has(&app.handle(Event::UpdateChecked(Some("0.1.3".into()))), &Effect::InstallUpdate));
        app.handle(Event::UpdateInstalled);
        assert!(!has(&app.handle(tick(B + 10)), &Effect::Relaunch));
        // Signed in, the window closes: nothing holds the relaunch any more.
        app.handle(login(LoginEvent::Done(Ok(()))));
        assert!(app.handle(tick(B + 15)).ends_with(&[Effect::StopWatch, Effect::Relaunch]));
    }

    /// The first check finds 0.1.3 and installs it.
    fn installed(app: &mut App) {
        assert!(has(&app.handle(tick(B + 5)), &Effect::CheckUpdate));
        assert!(has(&app.handle(Event::UpdateChecked(Some("0.1.3".into()))), &Effect::InstallUpdate));
        app.handle(Event::UpdateInstalled);
    }

    #[test]
    fn a_start_of_the_daemon_delays_the_relaunch() {
        let mut app = found();
        app.handle(Event::WatchExit(Some(3)));
        assert!(has(&app.handle(tick(B + 5)), &Effect::CheckUpdate));
        app.handle(Event::WatchExit(Some(3)));
        assert!(has(&app.handle(tick(B + 10)), &Effect::RunStart));
        app.handle(Event::UpdateChecked(Some("0.1.3".into())));
        app.handle(Event::UpdateInstalled);
        assert!(!has(&app.handle(tick(B + 15)), &Effect::Relaunch));
        app.handle(Event::StartDone { ok: true });
        assert!(app.handle(tick(B + 20)).ends_with(&[Effect::StopWatch, Effect::Relaunch]));
    }

    #[test]
    fn an_open_window_delays_the_relaunch() {
        let mut app = on_sign_in();
        installed(&mut app);
        assert!(!has(&app.handle(tick(B + 10)), &Effect::Relaunch));
        app.handle(Event::WindowClosed);
        assert!(app.handle(tick(B + 15)).ends_with(&[Effect::StopWatch, Effect::Relaunch]));
    }

    #[test]
    fn an_install_waiting_to_relaunch_checks_no_more() {
        let mut app = on_sign_in();
        installed(&mut app);
        // The window stays open past a minute: this process is still the old version, and a check would find the
        // installed one again and install it a second time.
        assert!(!has(&app.handle(tick(B + 10 + M1)), &Effect::CheckUpdate));
        app.handle(Event::WindowClosed);
        assert!(app.handle(tick(B + 15 + M1)).ends_with(&[Effect::StopWatch, Effect::Relaunch]));
    }

    #[test]
    fn a_failure_is_one_line_and_the_next_check_tries_again() {
        let kinds = [
            (UpdateFailure::Check, "check"),
            (UpdateFailure::Download, "download"),
            (UpdateFailure::Signature, "signature"),
            (UpdateFailure::Install, "install"),
        ];
        for (kind, word) in kinds {
            // Kept from the start, so the last menu in it is the one shown.
            let (mut app, mut sent) = App::new(SEEN, true, false, B);
            sent.extend(app.handle(tick(B + 5)));
            // A check fails on its own; the others fail installing what it found.
            if kind != UpdateFailure::Check {
                sent.extend(app.handle(Event::UpdateChecked(Some("0.1.3".into()))));
            }
            let effects = app.handle(Event::UpdateFailed(kind));
            assert_eq!(logs(&effects), [format!("update: failed {word}")]);
            assert!(!has(&effects, &Effect::InstallUpdate) && !has(&effects, &Effect::Relaunch), "{kind:?}");
            sent.extend(effects);
            assert!(!rows(&sent).contains(&"Updating Harness…".to_string()), "{kind:?}");
            let effects = app.handle(tick(B + 10));
            assert!(!has(&effects, &Effect::CheckUpdate) && !has(&effects, &Effect::Relaunch), "{kind:?}");
            assert!(has(&app.handle(tick(B + 5 + M1)), &Effect::CheckUpdate), "{kind:?}");
        }
    }

    #[test]
    fn a_version_whose_install_failed_waits_longer_each_time() {
        const H1: u64 = 3_600;
        // Checked every minute, a release whose signature fails was downloaded whole every minute, forever.
        for kind in [UpdateFailure::Download, UpdateFailure::Signature, UpdateFailure::Install] {
            let mut app = found();
            let mut at = B + 5;
            for wait in [2 * M1, 4 * M1, 8 * M1, 16 * M1, 32 * M1, H1, H1] {
                assert!(has(&app.handle(tick(at)), &Effect::CheckUpdate), "{kind:?} {wait}");
                assert!(has(&app.handle(Event::UpdateChecked(Some("0.1.3".into()))), &Effect::InstallUpdate));
                app.handle(Event::UpdateFailed(kind));
                // Still checked every minute; the same version is neither fetched nor said, and the menu stays.
                assert!(has(&app.handle(tick(at + wait - M1)), &Effect::CheckUpdate), "{kind:?} {wait}");
                assert!(app.handle(Event::UpdateChecked(Some("0.1.3".into()))).is_empty(), "{kind:?} {wait}");
                at += wait;
            }
            // A newer version is tried at once.
            app.handle(tick(at));
            app.handle(Event::UpdateChecked(Some("0.1.3".into())));
            app.handle(Event::UpdateFailed(kind));
            app.handle(tick(at + M1));
            let effects = app.handle(Event::UpdateChecked(Some("0.1.4".into())));
            assert!(has(&effects, &Effect::InstallUpdate), "{kind:?}");
            assert_eq!(logs(&effects), ["update: found 0.1.4"]);
        }
    }

    #[test]
    fn a_check_that_fails_never_makes_a_version_wait_longer() {
        // The check downloaded nothing: only a failed download, signature or install counts against a version.
        let mut app = found();
        app.handle(tick(B + 5));
        app.handle(Event::UpdateChecked(Some("0.1.3".into())));
        app.handle(Event::UpdateFailed(UpdateFailure::Download));
        assert!(has(&app.handle(tick(B + 5 + M1)), &Effect::CheckUpdate));
        app.handle(Event::UpdateFailed(UpdateFailure::Check));
        // Two minutes after its one failed download, it is tried again.
        assert!(has(&app.handle(tick(B + 5 + 2 * M1)), &Effect::CheckUpdate));
        assert!(has(&app.handle(Event::UpdateChecked(Some("0.1.3".into()))), &Effect::InstallUpdate));
    }

    #[test]
    fn a_bundle_that_cannot_be_replaced_offers_the_page_and_says_so_once() {
        let mut app = found();
        app.handle(tick(B + 5));
        app.handle(Event::UpdateChecked(Some("0.1.3".into())));
        let effects = app.handle(Event::UpdateFailed(UpdateFailure::NotWritable));
        assert_eq!(logs(&effects), ["update: skipped not-writable"]);
        let menu = menu_of(&effects);
        let row = MenuItem::Action(MenuAction::Update, "Update 0.1.3…".into());
        let at = menu.iter().position(|item| *item == row).expect("the row");
        assert_eq!(menu[at + 1], MenuItem::Separator);
        // The fixed page, with nothing of the manifest in it.
        assert_eq!(
            app.handle(Event::Menu(MenuAction::Update)),
            [Effect::OpenUrl("https://harness.autonomous.ai/device".into())]
        );

        // A minute on, the same version: tried again, the row stays, and no line is said twice, found or skipped.
        assert!(has(&app.handle(tick(B + 5 + M1)), &Effect::CheckUpdate));
        let effects = app.handle(Event::UpdateChecked(Some("0.1.3".into())));
        assert!(has(&effects, &Effect::InstallUpdate));
        assert!(logs(&effects).is_empty());
        assert!(!effects.iter().any(|effect| matches!(effect, Effect::Menu(_))));
        assert!(logs(&app.handle(Event::UpdateFailed(UpdateFailure::NotWritable))).is_empty());

        // A newer version changes the row, and is said once more.
        app.handle(tick(B + 5 + 2 * M1));
        app.handle(Event::UpdateChecked(Some("0.1.4".into())));
        let effects = app.handle(Event::UpdateFailed(UpdateFailure::NotWritable));
        assert_eq!(logs(&effects), ["update: skipped not-writable"]);
        assert!(rows(&effects).contains(&"Update 0.1.4…".to_string()));
    }

    #[test]
    fn nothing_newer_changes_nothing() {
        let mut app = found();
        app.handle(tick(B + 5));
        assert!(app.handle(Event::UpdateChecked(None)).is_empty());

        // Nothing newer than the version a row offers: the row goes.
        app.handle(tick(B + 5 + M1));
        app.handle(Event::UpdateChecked(Some("0.1.3".into())));
        app.handle(Event::UpdateFailed(UpdateFailure::NotWritable));
        app.handle(tick(B + 5 + 2 * M1));
        assert!(!rows(&app.handle(Event::UpdateChecked(None))).contains(&"Update 0.1.3…".to_string()));
    }

    const SAVED_LINE: &str = "Saved to ~/Desktop/harness-logs-20261118-1030.zip";

    fn exported() -> Exported {
        Exported {
            zip: PathBuf::from("/Users/p/Desktop/harness-logs-20261118-1030.zip"),
            shown: "~/Desktop/harness-logs-20261118-1030.zip".into(),
        }
    }

    /// The labels of the menu the app last sent, whether or not this event sent one.
    fn rows_now(app: &App) -> Vec<String> {
        rows(&[Effect::Menu(app.menu.clone())])
    }

    #[test]
    fn a_click_exports_and_the_row_waits() {
        let mut app = found();
        let effects = app.handle(Event::Menu(MenuAction::ExportLogs));
        assert_eq!(count(&effects, &Effect::ExportLogs), 1);
        assert!(menu_of(&effects).contains(&MenuItem::Text("Exporting logs…".into())));
        assert!(app.handle(Event::Menu(MenuAction::ExportLogs)).is_empty());
    }

    #[test]
    fn a_saved_export_is_revealed_and_named() {
        let mut app = found();
        app.handle(Event::Menu(MenuAction::ExportLogs));
        let effects = app.handle(Event::LogsExported(Ok(exported())));
        assert!(has(&effects, &Effect::Reveal(exported().zip)));
        assert_eq!(logs(&effects), ["logs: exported"]);
        assert_eq!(rows(&effects), ["Starting Harness", "Export logs", SAVED_LINE, "About", "Quit"]);
        // The menu's own log line says Saved: the zip may be outside the home, and named whole.
        for effect in &effects {
            if let Effect::Log(line) = effect {
                assert!(!line.contains("harness-logs-"), "{line}");
            }
        }
    }

    #[test]
    fn a_failed_export_says_why() {
        let failures = [
            (ExportFailure::TimedOut, "timed out"),
            (ExportFailure::NoAnswer, "Harness did not answer"),
            (ExportFailure::NoFile, "no file"),
        ];
        for (failure, reason) in failures {
            let mut app = found();
            app.handle(Event::Menu(MenuAction::ExportLogs));
            let effects = app.handle(Event::LogsExported(Err(failure)));
            assert_eq!(
                rows(&effects),
                ["Starting Harness", "Export logs", &format!("Export failed: {reason}"), "About", "Quit"],
                "{failure:?}"
            );
            assert_eq!(logs(&effects), [format!("logs: export failed: {reason}")]);
            assert!(!effects.iter().any(|effect| matches!(effect, Effect::Reveal(_))), "{failure:?}");
        }
    }

    #[test]
    fn the_line_stays_until_the_next_export() {
        let mut app = found();
        app.handle(Event::Menu(MenuAction::ExportLogs));
        app.handle(Event::LogsExported(Ok(exported())));
        app.handle(tick(B + 5));
        app.handle(Event::MenuOpened { now: B + 10, desktop_installed: false });
        assert_eq!(rows_now(&app), ["Starting Harness", "Export logs", SAVED_LINE, "About", "Quit"]);

        // A CLI that goes away takes the row, not the line.
        app.handle(Event::Cli(false));
        assert_eq!(rows_now(&app), ["Harness removed", "Install", SAVED_LINE, "About", "Quit"]);

        app.handle(Event::Cli(true));
        assert_eq!(rows_now(&app), ["Starting Harness", "Export logs", SAVED_LINE, "About", "Quit"]);
        app.handle(Event::Menu(MenuAction::ExportLogs));
        assert_eq!(rows_now(&app), ["Starting Harness", "Exporting logs…", "About", "Quit"]);
    }

    #[test]
    fn without_a_cli_a_click_exports_nothing() {
        let mut app = removed();
        assert!(!has(&app.handle(Event::Menu(MenuAction::ExportLogs)), &Effect::ExportLogs));
        // An export the CLI started before it went still answers.
        let effects = app.handle(Event::LogsExported(Err(ExportFailure::NoAnswer)));
        assert_eq!(
            rows(&effects),
            ["Harness removed", "Install", "Export failed: Harness did not answer", "About", "Quit"]
        );
        assert_eq!(logs(&effects), ["logs: export failed: Harness did not answer"]);
    }

    const FP1: &str = "ap1-0123456789abcdef0123456789abcdef";
    /// The fingerprint of an `approval_stale`: the plugin's files changed after the first was shown.
    const FP2: &str = "ap1-fedcba9876543210fedcba9876543210";
    const ASKING: &str = "Asking Orca…";
    const NOT_RUNNING: &str = "Orca isn't running.";
    const COULD_NOT: &str = "Couldn't connect Orca.";
    /// The access, as Orca words it.
    const GRANTS: [&str; 2] = [
        "Runs its own code in a separate Node.js process on the Orca host.",
        "Read your projects and workspaces, and get notified when they change",
    ];

    fn fingerprint(text: &str) -> Fingerprint {
        Fingerprint::parse(text).unwrap()
    }

    /// Orca lists the access, with this fingerprint.
    fn approve(text: &str, update: bool) -> Event {
        let grants = GRANTS.iter().map(|grant| grant.to_string()).collect();
        Event::OrcaConnect(OrcaAnswer::Approve { fingerprint: fingerprint(text), grants, update })
    }

    fn connected() -> Event {
        Event::OrcaConnect(OrcaAnswer::Done)
    }

    fn failed(error: OrcaError) -> Event {
        Event::OrcaConnect(OrcaAnswer::Failed(error))
    }

    fn orca(phase: Phase, lines: &[&str], update: bool) -> Option<View> {
        Some(View { screen: Screen::Orca, phase, lines: lines.iter().map(|line| line.to_string()).collect(), update })
    }

    /// The connects the effects run, by the fingerprint each passes.
    fn connects(effects: &[Effect]) -> Vec<Option<Fingerprint>> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::RunOrcaConnect(approve) => Some(approve.clone()),
                _ => None,
            })
            .collect()
    }

    fn status(said: Option<OrcaStatus>) -> Event {
        Event::OrcaStatus(said)
    }

    fn statuses(effects: &[Effect]) -> usize {
        count(effects, &Effect::RunOrcaStatus)
    }

    fn opened(now: u64) -> Event {
        Event::MenuOpened { now, desktop_installed: false }
    }

    fn version(text: &str) -> Event {
        Event::CliVersion(Some(text.into()))
    }

    /// Found at B and signed in, so no screen is due, and the start's status answered `said`: no Orca run is under way.
    fn settled(said: Option<OrcaStatus>) -> App {
        let mut app = found();
        answer(&mut app, true);
        app.handle(status(said));
        app
    }

    /// The Connect row clicked: the window asks Orca.
    fn asking() -> App {
        let mut app = settled(Some(OrcaStatus::Offer));
        app.handle(Event::Menu(MenuAction::Orca));
        assert_eq!(app.view(), orca(Phase::Asking, &[ASKING], false));
        app
    }

    /// Orca listed the access, and the window shows it.
    fn on_approve() -> App {
        let mut app = asking();
        app.handle(approve(FP1, false));
        assert_eq!(app.view(), orca(Phase::Approve, &GRANTS, false));
        app
    }

    #[test]
    fn a_click_on_the_row_asks_orca() {
        let mut app = settled(Some(OrcaStatus::Offer));
        let effects = app.handle(Event::Menu(MenuAction::Orca));
        assert_eq!(connects(&effects), [None]);
        assert_eq!(shows(&effects), [orca(Phase::Asking, &[ASKING], false)]);

        // With no CLI there is nothing to ask.
        let effects = removed().handle(Event::Menu(MenuAction::Orca));
        assert!(connects(&effects).is_empty());
        assert!(shows(&effects).is_empty());
    }

    #[test]
    fn the_grants_are_shown_as_orca_words_them() {
        for update in [false, true] {
            let mut app = asking();
            assert_eq!(shows(&app.handle(approve(FP1, update))), [orca(Phase::Approve, &GRANTS, update)]);
            // An update keeps its words in every phase after it: the click, and each answer to it.
            assert_eq!(shows(&app.handle(Event::Act(Action::ConnectOrca))), [orca(Phase::Asking, &[ASKING], update)]);
            assert_eq!(shows(&app.handle(connected())), [orca(Phase::Done, &[], update)]);

            let mut app = asking();
            app.handle(approve(FP1, update));
            app.handle(Event::Act(Action::ConnectOrca));
            assert_eq!(shows(&app.handle(failed(OrcaError::Timeout))), [orca(Phase::Failed, &[COULD_NOT], update)]);
        }
    }

    #[test]
    fn nothing_is_approved_without_the_click() {
        let answers = [
            approve(FP1, false),
            approve(FP2, true),
            connected(),
            failed(OrcaError::NotRunning),
            failed(OrcaError::Failed),
        ];
        for each in answers {
            let (mut app, mut effects) = App::new(SEEN, true, false, B);
            effects.extend(answer(&mut app, true));
            effects.extend(app.handle(status(Some(OrcaStatus::Offer))));
            effects.extend(app.handle(Event::Menu(MenuAction::Orca)));
            effects.extend(app.handle(each.clone()));
            assert_eq!(connects(&effects), [None], "{each:?}");
        }

        // Connect while the window asks, says done or failed.
        let mut app = asking();
        assert!(app.handle(Event::Act(Action::ConnectOrca)).is_empty());
        for end in [connected(), failed(OrcaError::Off)] {
            let mut app = asking();
            app.handle(end);
            assert!(app.handle(Event::Act(Action::ConnectOrca)).is_empty());
        }
        // On another screen, before the Orca screen or after it left the access.
        assert!(on_sign_in().handle(Event::Act(Action::ConnectOrca)).is_empty());
        let mut app = on_approve();
        app.handle(Event::Menu(MenuAction::SignIn));
        assert!(app.handle(Event::Act(Action::ConnectOrca)).is_empty());
        // With the window closed.
        let mut app = on_approve();
        app.handle(Event::WindowClosed);
        assert!(app.handle(Event::Act(Action::ConnectOrca)).is_empty());
        // Asked again from the row, the window asks Orca afresh: the access it showed is gone.
        let mut app = on_approve();
        assert_eq!(connects(&app.handle(Event::Menu(MenuAction::Orca))), [None]);
        assert!(app.handle(Event::Act(Action::ConnectOrca)).is_empty());
    }

    #[test]
    fn connect_runs_approve_with_the_fingerprint_of_the_last_answer_only() {
        let mut app = on_approve();
        let effects = app.handle(Event::Act(Action::ConnectOrca));
        assert_eq!(connects(&effects), [Some(fingerprint(FP1))]);
        assert_eq!(shows(&effects), [orca(Phase::Asking, &[ASKING], false)]);
        // The window asks Orca, with no button: a second click runs nothing.
        assert!(app.handle(Event::Act(Action::ConnectOrca)).is_empty());

        // The files changed meanwhile: Orca lists the access again, under another fingerprint.
        assert_eq!(shows(&app.handle(approve(FP2, false))), [orca(Phase::Approve, &GRANTS, false)]);
        assert_eq!(connects(&app.handle(Event::Act(Action::ConnectOrca))), [Some(fingerprint(FP2))]);
    }

    #[test]
    fn done_and_each_failure() {
        let mut app = asking();
        assert_eq!(shows(&app.handle(connected())), [orca(Phase::Done, &[], false)]);
        let failures = [
            (OrcaError::NotRunning, NOT_RUNNING),
            (OrcaError::Off, COULD_NOT),
            (OrcaError::NoPlugin, COULD_NOT),
            (OrcaError::Timeout, COULD_NOT),
            (OrcaError::Failed, COULD_NOT),
        ];
        for (error, line) in failures {
            let mut app = asking();
            assert_eq!(shows(&app.handle(failed(error))), [orca(Phase::Failed, &[line], false)], "{error:?}");
        }
    }

    #[test]
    fn cancel_done_and_close_close_the_window_and_install_nothing() {
        // Cancel on the access, Done, and Close on a failure: each sends `cancel`.
        for end in [approve(FP1, false), connected(), failed(OrcaError::NotRunning)] {
            let mut app = asking();
            app.handle(end.clone());
            assert_eq!(app.handle(Event::Act(Action::Cancel)), [Effect::Show(None)], "{end:?}");
            assert_eq!(app.view(), None);
            assert!(app.handle(Event::Act(Action::ConnectOrca)).is_empty(), "{end:?}");
        }
        // While it asks, the window has no button.
        assert!(asking().handle(Event::Act(Action::Cancel)).is_empty());
    }

    #[test]
    fn a_second_click_on_the_row_starts_no_second_run() {
        let mut app = settled(Some(OrcaStatus::Offer));
        let mut effects = app.handle(Event::Menu(MenuAction::Orca));
        effects.extend(app.handle(Event::Menu(MenuAction::Orca)));
        assert_eq!(connects(&effects), [None]);
        // The window comes up again: the person asked for it.
        assert_eq!(shows(&effects), [orca(Phase::Asking, &[ASKING], false), orca(Phase::Asking, &[ASKING], false)]);

        // Nor once the window was closed while it runs; its answer is drawn in the window opened again.
        app.handle(Event::WindowClosed);
        assert!(connects(&app.handle(Event::Menu(MenuAction::Orca))).is_empty());
        assert_eq!(shows(&app.handle(connected())), [orca(Phase::Done, &[], false)]);
        // Once it answered, the row asks afresh.
        assert_eq!(connects(&app.handle(Event::Menu(MenuAction::Orca))), [None]);
    }

    #[test]
    fn a_closed_window_stays_closed() {
        let answers = [
            (approve(FP1, false), &["orca connect: approve"][..]),
            // Done takes the row away.
            (connected(), &["orca connect: done", "orca: none"]),
            (failed(OrcaError::NotRunning), &["orca connect: failed not-running"]),
        ];
        for (each, lines) in answers {
            let mut app = asking();
            app.handle(Event::WindowClosed);
            let effects = app.handle(each);
            assert!(shows(&effects).is_empty(), "{lines:?}");
            assert_eq!(logs(&effects), lines);
            assert_eq!(app.view(), None);
        }
    }

    #[test]
    fn the_log_names_the_answer_and_nothing_orca_listed() {
        let answers = [
            // Done takes the row away.
            (connected(), &["orca connect: done", "orca: none"][..]),
            (approve(FP1, false), &["orca connect: approve"]),
            (failed(OrcaError::NotRunning), &["orca connect: failed not-running"]),
            (failed(OrcaError::NoPlugin), &["orca connect: failed no-plugin"]),
            (failed(OrcaError::Off), &["orca connect: failed off"]),
            (failed(OrcaError::Timeout), &["orca connect: failed timeout"]),
            (failed(OrcaError::Failed), &["orca connect: failed failed"]),
        ];
        for (each, lines) in answers {
            assert_eq!(logs(&asking().handle(each)), lines);
        }

        // From the start through two approvals: no line, the menu's included, holds a grant or a fingerprint.
        let (mut app, mut effects) = App::new(SEEN, true, false, B);
        effects.extend(answer(&mut app, true));
        effects.extend(app.handle(status(Some(OrcaStatus::Offer))));
        effects.extend(app.handle(Event::Menu(MenuAction::Orca)));
        effects.extend(app.handle(approve(FP1, false)));
        effects.extend(app.handle(Event::Act(Action::ConnectOrca)));
        effects.extend(app.handle(approve(FP2, true)));
        effects.extend(app.handle(Event::Act(Action::ConnectOrca)));
        effects.extend(app.handle(connected()));
        let lines: Vec<&String> = effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Log(line) => Some(line),
                _ => None,
            })
            .collect();
        for listed in [FP1, &FP1[4..], FP2, &FP2[4..], GRANTS[0], GRANTS[1], "Orca host", "workspaces"] {
            assert!(lines.iter().all(|line| !line.contains(listed)), "{listed}: {lines:?}");
        }
    }

    #[test]
    fn an_answer_nobody_waits_for_changes_nothing() {
        let mut app = settled(Some(OrcaStatus::Offer));
        for each in [approve(FP1, false), connected(), failed(OrcaError::NotRunning), status(None)] {
            assert!(app.handle(each.clone()).is_empty(), "{each:?}");
        }
        assert_eq!(app.view(), None);
        // Nor a connect's answer while a status runs, nor a status's while a connect runs.
        app.handle(opened(B + 300));
        assert!(app.handle(connected()).is_empty());
        let mut app = asking();
        assert!(app.handle(status(None)).is_empty());

        // Nor a second answer to the one run.
        let mut app = asking();
        app.handle(connected());
        assert!(app.handle(approve(FP1, false)).is_empty());
        assert_eq!(app.view(), orca(Phase::Done, &[], false));
    }

    #[test]
    fn a_cli_that_goes_away_ends_the_orca_screen() {
        let mut app = asking();
        assert_eq!(shows(&app.handle(Event::Cli(false))), [None]);
        // Its late answer is not heard.
        assert!(app.handle(approve(FP1, false)).is_empty());
        assert_eq!(app.view(), None);

        // The access it showed goes with it: a CLI that comes back asks Orca afresh.
        let mut app = on_approve();
        app.handle(Event::Cli(false));
        app.handle(Event::Cli(true));
        assert!(connects(&app.handle(Event::Act(Action::ConnectOrca))).is_empty());
        app.handle(status(Some(OrcaStatus::Offer)));
        assert_eq!(connects(&app.handle(Event::Menu(MenuAction::Orca))), [None]);
    }

    #[test]
    fn status_runs_once_the_cli_is_found() {
        // At start.
        let (mut app, effects) = App::new(SEEN, true, false, B);
        assert_eq!(statuses(&effects), 1);
        assert_eq!(statuses(&answer(&mut app, true)), 0);

        // Never with no CLI: not at start, on a tick, or on the menu.
        let (mut app, effects) = App::new(SEEN, false, false, B);
        assert_eq!(statuses(&effects), 0);
        assert_eq!(statuses(&app.handle(tick(B + 5))), 0);
        assert_eq!(statuses(&app.handle(opened(B + 600))), 0);
        // When it comes back.
        assert_eq!(statuses(&app.handle(Event::Cli(true))), 1);

        // After an install, and not while it runs or after one that failed.
        let (mut app, effects) = App::new(Saved::default(), false, false, B);
        assert_eq!(statuses(&effects), 0);
        assert_eq!(statuses(&app.handle(opened(B + 600))), 0);
        assert_eq!(statuses(&app.handle(Event::InstallDone(Err(vec!["a".into()])))), 0);
        app.handle(Event::Act(Action::Retry));
        assert_eq!(statuses(&app.handle(Event::InstallDone(Ok(())))), 1);
    }

    #[test]
    fn a_new_cli_version_asks_again() {
        let mut app = settled(None);
        // The first version read is not a change.
        assert_eq!(statuses(&app.handle(version("0.6.66"))), 0);
        assert_eq!(statuses(&app.handle(version("0.6.66"))), 0);
        // A read that failed keeps the version known.
        assert_eq!(statuses(&app.handle(Event::CliVersion(None))), 0);
        assert_eq!(statuses(&app.handle(version("0.6.67"))), 1);
        app.handle(status(None));
        assert_eq!(statuses(&app.handle(version("0.6.67"))), 0);
    }

    #[test]
    fn the_menu_asks_at_most_once_in_five_minutes() {
        let mut app = settled(None);
        assert_eq!(statuses(&app.handle(opened(B + 299))), 0);
        assert_eq!(statuses(&app.handle(opened(B + 300))), 1);
        app.handle(status(None));
        // A clock set back asks too: abs_diff.
        assert_eq!(statuses(&app.handle(opened(B))), 1);
    }

    #[test]
    fn a_tick_never_asks_orca() {
        let mut app = settled(Some(OrcaStatus::Behind));
        app.handle(connected());
        for now in [B + 5, B + 300, B + 3_600, B + 86_400] {
            let effects = app.handle(tick(now));
            assert_eq!(statuses(&effects), 0, "{now}");
            assert!(connects(&effects).is_empty(), "{now}");
        }
    }

    #[test]
    fn never_two_runs_at_a_time() {
        // A status wanted while one runs starts at its answer.
        let mut app = found();
        answer(&mut app, true);
        app.handle(version("0.6.66"));
        assert_eq!(statuses(&app.handle(version("0.6.67"))), 0);
        assert_eq!(statuses(&app.handle(status(None))), 1);
        // Nothing more waits.
        assert_eq!(statuses(&app.handle(status(None))), 0);

        // While the screen's connect runs.
        let mut app = asking();
        app.handle(version("0.6.66"));
        assert_eq!(statuses(&app.handle(version("0.6.67"))), 0);
        assert_eq!(statuses(&app.handle(approve(FP1, false))), 1);

        // While the silent update runs.
        let mut app = settled(Some(OrcaStatus::Behind));
        assert_eq!(statuses(&app.handle(opened(B + 300))), 0);
        assert_eq!(statuses(&app.handle(connected())), 1);

        // The Connect click waits for a status, and then runs with the fingerprint shown.
        let mut app = on_approve();
        assert_eq!(statuses(&app.handle(opened(B + 300))), 1);
        let effects = app.handle(Event::Act(Action::ConnectOrca));
        assert!(connects(&effects).is_empty());
        assert_eq!(shows(&effects), [orca(Phase::Asking, &[ASKING], false)]);
        assert!(app.handle(Event::Act(Action::ConnectOrca)).is_empty());
        assert_eq!(connects(&app.handle(status(Some(OrcaStatus::Offer)))), [Some(fingerprint(FP1))]);
        assert_eq!(shows(&app.handle(connected())), [orca(Phase::Done, &[], false)]);
    }

    #[test]
    fn the_screens_connect_goes_before_a_waiting_status() {
        let mut app = found();
        answer(&mut app, true);
        app.handle(version("0.6.66"));
        // The start's status runs, and a second waits.
        app.handle(version("0.6.67"));
        let effects = app.handle(Event::Menu(MenuAction::Orca));
        assert!(connects(&effects).is_empty());
        assert_eq!(shows(&effects), [orca(Phase::Asking, &[ASKING], false)]);

        let effects = app.handle(status(Some(OrcaStatus::Offer)));
        assert_eq!(connects(&effects), [None]);
        assert_eq!(statuses(&effects), 0);
        let effects = app.handle(approve(FP1, false));
        assert_eq!(shows(&effects), [orca(Phase::Approve, &GRANTS, false)]);
        assert_eq!(statuses(&effects), 1);
    }

    #[test]
    fn each_status_sets_the_row() {
        let after = |said: Option<OrcaStatus>| {
            let (mut app, mut effects) = App::new(SEEN, true, false, B);
            effects.extend(answer(&mut app, true));
            effects.extend(app.handle(status(said)));
            rows(&effects)
        };
        // Under the account's row.
        assert_eq!(
            after(Some(OrcaStatus::Offer)),
            ["Starting Harness", "Signed in", "Connect Orca…", "Export logs", "About", "Quit"]
        );
        assert_eq!(
            after(Some(OrcaStatus::Approve)),
            ["Starting Harness", "Signed in", "Update Orca connection…", "Export logs", "About", "Quit"]
        );
        let none = [OrcaStatus::Absent, OrcaStatus::Off, OrcaStatus::Behind, OrcaStatus::Current].map(Some);
        for said in none.into_iter().chain([None]) {
            assert_eq!(after(said), ["Starting Harness", "Signed in", "Export logs", "About", "Quit"], "{said:?}");
        }

        // Logged at each change of the row, and only then.
        let mut app = found();
        answer(&mut app, true);
        assert_eq!(logs(&app.handle(status(Some(OrcaStatus::Offer)))), ["orca: offer"]);
        app.handle(opened(B + 300));
        assert!(app.handle(status(Some(OrcaStatus::Offer))).is_empty());
        app.handle(opened(B + 600));
        assert_eq!(logs(&app.handle(status(Some(OrcaStatus::Approve)))), ["orca: update"]);
        app.handle(opened(B + 900));
        assert_eq!(logs(&app.handle(status(Some(OrcaStatus::Current)))), ["orca: none"]);
    }

    #[test]
    fn a_status_nobody_could_read() {
        // A CLI from before `device orca` prints its usage: no row.
        let (mut app, mut effects) = App::new(SEEN, true, false, B);
        effects.extend(answer(&mut app, true));
        effects.extend(app.handle(status(None)));
        assert_eq!(rows(&effects), ["Starting Harness", "Signed in", "Export logs", "About", "Quit"]);
        assert!(logs(&effects).iter().all(|line| !line.starts_with("orca")), "{effects:?}");
        // The next menu open five minutes on asks again.
        assert_eq!(statuses(&app.handle(opened(B + 299))), 0);
        assert_eq!(statuses(&app.handle(opened(B + 300))), 1);
        // One that could not be read takes a row away.
        let effects = app.handle(status(Some(OrcaStatus::Offer)));
        assert_eq!(logs(&effects), ["orca: offer"]);
        app.handle(opened(B + 600));
        let effects = app.handle(status(None));
        assert_eq!(logs(&effects), ["orca: none"]);
        assert_eq!(rows(&effects), ["Starting Harness", "Signed in", "Export logs", "About", "Quit"]);
    }

    #[test]
    fn behind_updates_with_no_click_once_per_cli_version() {
        let mut app = found();
        answer(&mut app, true);
        app.handle(version("0.6.66"));
        let effects = app.handle(status(Some(OrcaStatus::Behind)));
        assert_eq!(connects(&effects), [None]);
        assert!(shows(&effects).is_empty());
        let effects = app.handle(connected());
        assert!(shows(&effects).is_empty());
        assert_eq!(logs(&effects), ["orca connect: done"]);
        assert_eq!(app.view(), None);

        // A second Behind runs nothing.
        app.handle(opened(B + 300));
        assert!(connects(&app.handle(status(Some(OrcaStatus::Behind)))).is_empty());
        // After a new version it runs again.
        assert_eq!(statuses(&app.handle(version("0.6.67"))), 1);
        assert_eq!(connects(&app.handle(status(Some(OrcaStatus::Behind)))), [None]);
        app.handle(connected());
        // And after the CLI was found again.
        app.handle(Event::Cli(false));
        assert_eq!(statuses(&app.handle(Event::Cli(true))), 1);
        assert_eq!(connects(&app.handle(status(Some(OrcaStatus::Behind)))), [None]);
    }

    #[test]
    fn a_silent_update_that_needs_approval_brings_the_update_row() {
        let mut app = settled(Some(OrcaStatus::Behind));
        let effects = app.handle(approve(FP1, true));
        assert_eq!(logs(&effects), ["orca connect: approve", "orca: update"]);
        assert!(shows(&effects).is_empty());
        assert!(rows(&effects).contains(&"Update Orca connection…".to_string()));
        // It kept no fingerprint: Connect asks nothing.
        assert!(app.handle(Event::Act(Action::ConnectOrca)).is_empty());

        // The row's click asks Orca afresh, with no fingerprint, in an update's words.
        let effects = app.handle(Event::Menu(MenuAction::Orca));
        assert_eq!(connects(&effects), [None]);
        assert_eq!(shows(&effects), [orca(Phase::Asking, &[ASKING], true)]);
        // Connect before that answer asks nothing.
        assert!(app.handle(Event::Act(Action::ConnectOrca)).is_empty());
        assert_eq!(shows(&app.handle(approve(FP2, true))), [orca(Phase::Approve, &GRANTS, true)]);
        assert_eq!(connects(&app.handle(Event::Act(Action::ConnectOrca))), [Some(fingerprint(FP2))]);
    }

    #[test]
    fn a_silent_update_that_fails_is_one_log_line_and_no_row() {
        let mut app = settled(Some(OrcaStatus::Behind));
        let effects = app.handle(failed(OrcaError::Timeout));
        assert_eq!(logs(&effects), ["orca connect: failed timeout"]);
        assert!(shows(&effects).is_empty());
        // No row: the menu stays as it was.
        assert!(!effects.iter().any(|effect| matches!(effect, Effect::Menu(_))), "{effects:?}");
        assert_eq!(app.view(), None);
    }

    #[test]
    fn done_takes_the_row_away_cancel_and_a_failure_keep_it() {
        let mut app = asking();
        let effects = app.handle(connected());
        assert_eq!(logs(&effects), ["orca connect: done", "orca: none"]);
        assert_eq!(rows(&effects), ["Starting Harness", "Signed in", "Export logs", "About", "Quit"]);

        // The screen's own approval and Cancel leave the row: an update's access does not make it the Update row.
        let mut app = asking();
        let mut effects = app.handle(approve(FP1, true));
        effects.extend(app.handle(Event::Act(Action::Cancel)));
        assert!(!effects.iter().any(|effect| matches!(effect, Effect::Menu(_))), "{effects:?}");
        assert_eq!(connects(&app.handle(Event::Menu(MenuAction::Orca))), [None]);
        assert_eq!(app.view(), orca(Phase::Asking, &[ASKING], false));

        // So do a failure, and Close.
        let mut app = asking();
        let mut effects = app.handle(failed(OrcaError::NotRunning));
        effects.extend(app.handle(Event::Act(Action::Cancel)));
        assert!(!effects.iter().any(|effect| matches!(effect, Effect::Menu(_))), "{effects:?}");
    }

    #[test]
    fn a_closed_window_still_sets_the_menu() {
        let mut app = asking();
        app.handle(Event::WindowClosed);
        let effects = app.handle(connected());
        assert!(shows(&effects).is_empty());
        assert_eq!(rows(&effects), ["Starting Harness", "Signed in", "Export logs", "About", "Quit"]);
    }

    #[test]
    fn an_update_draws_its_own_words() {
        let mut app = settled(Some(OrcaStatus::Approve));
        let effects = app.handle(Event::Menu(MenuAction::Orca));
        assert_eq!(connects(&effects), [None]);
        assert_eq!(shows(&effects), [orca(Phase::Asking, &[ASKING], true)]);
        assert_eq!(shows(&app.handle(connected())), [orca(Phase::Done, &[], true)]);

        // The Connect row's are Connect's.
        let mut app = settled(Some(OrcaStatus::Offer));
        assert_eq!(shows(&app.handle(Event::Menu(MenuAction::Orca))), [orca(Phase::Asking, &[ASKING], false)]);
    }

    #[test]
    fn a_cli_that_goes_away_takes_the_row_and_what_waited() {
        // The row.
        let mut app = settled(Some(OrcaStatus::Offer));
        let effects = app.handle(Event::Cli(false));
        assert_eq!(rows(&effects), ["Harness removed", "Install", "About", "Quit"]);
        assert_eq!(logs(&effects), ["orca: none"]);

        // The run noted: its late answer is not heard.
        let mut app = found();
        answer(&mut app, true);
        app.handle(Event::Cli(false));
        assert!(app.handle(status(Some(OrcaStatus::Offer))).is_empty());

        // The runs that waited, a status and the Connect click with its fingerprint: a CLI that comes back asks only its
        // own status.
        let mut app = on_approve();
        app.handle(opened(B + 300));
        app.handle(version("0.6.66"));
        app.handle(version("0.6.67"));
        app.handle(Event::Act(Action::ConnectOrca));
        app.handle(Event::Cli(false));
        let effects = app.handle(Event::Cli(true));
        assert_eq!(statuses(&effects), 1);
        assert!(connects(&effects).is_empty());
        let effects = app.handle(status(Some(OrcaStatus::Offer)));
        assert_eq!(statuses(&effects), 0);
        assert!(connects(&effects).is_empty());
    }
}
