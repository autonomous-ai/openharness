//! The words every module shares. No rule lives here.

use serde::{Deserialize, Serialize};

/// One line of `harness hardware watch --json`. A line without a boolean `attached` is not a status.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct DialStatus {
    pub attached: bool,
    pub fw: Option<String>,
    pub hw: Option<String>,
    pub board: Option<String>,
    pub updating: Option<String>,
    pub problem: Option<String>,
}

/// harnessd, as the keep-alive last saw it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Daemon {
    Starting,
    Up,
    Stopped,
    Updating,
}

/// The `harness` CLI on this computer. Removed: seen once and gone now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliState {
    Found,
    Installing,
    InstallFailed,
    Removed,
}

/// `harness device claude status --json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeStatus {
    pub supported: bool,
    pub installed: bool,
    pub enabled: bool,
    pub claude_version: Option<String>,
}

/// state.json: `{ "version": 1, "cliSeen", "askedSignIn", "askedClaude", "loginItem" }`. Default: version 1, all false.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub version: u32,
    pub cli_seen: bool,
    pub asked_sign_in: bool,
    pub asked_claude: bool,
    pub login_item: bool,
}

impl Default for Saved {
    fn default() -> Self {
        Saved { version: 1, cli_seen: false, asked_sign_in: false, asked_claude: false, login_item: false }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Screen {
    Install,
    SignIn,
    Claude,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Offer,
    Working,
    Browser,
    Failed,
}

/// What the window draws: `{"screen":"sign_in","phase":"browser","lines":["…"]}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct View {
    pub screen: Screen,
    pub phase: Phase,
    pub lines: Vec<String>,
}

/// What the window may ask: `"retry" | "sign_in" | "later" | "cancel" | "turn_on" | "not_now"`. Anything else is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Retry,
    SignIn,
    Later,
    Cancel,
    TurnOn,
    NotNow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    Install,
    SignIn,
    ClaudeOn,
    ClaudeOff,
    OpenHarness,
    Quit,
}

/// Text is a disabled line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuItem {
    Text(String),
    Action(MenuAction, String),
    Separator,
}

/// What the menu is drawn from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppState {
    pub cli: CliState,
    pub daemon: Daemon,
    pub dial: Option<DialStatus>,
    pub signed_in: Option<bool>,
    pub claude: Option<ClaudeStatus>,
    pub desktop_installed: bool,
    pub saved: Saved,
}

/// AuthorizeUrl holds an `https:` URL only (account.rs lets no other through).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoginEvent {
    AuthorizeUrl(String),
    Waiting(String),
    Done(Result<(), String>),
}

/// What happened. WatchExit(None): ended by a signal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Tick { now: u64, desktop_running: bool },
    MenuOpened { now: u64, desktop_installed: bool },
    Cli(bool),
    WatchLine(DialStatus),
    WatchExit(Option<i32>),
    StartDone { ok: bool },
    InstallDone(Result<(), Vec<String>>),
    Auth(Option<bool>),
    Claude(Option<ClaudeStatus>),
    Login(LoginEvent),
    ClaudeSet(Result<(), String>),
    LoginItem(bool),
    Menu(MenuAction),
    Act(Action),
    WindowClosed,
}

/// What to do about it. Show(None) hides the window. Menu, Show and Quit are the binary's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    FindCli,
    SpawnWatch,
    StopWatch,
    RunStart,
    RunInstall,
    ReadAuth,
    ReadClaude,
    RunLogin,
    CancelLogin,
    SetClaude(bool),
    OpenUrl(String),
    OpenDesktop,
    RegisterLoginItem,
    Save(Saved),
    Log(String),
    Menu(Vec<MenuItem>),
    Show(Option<View>),
    Quit,
}

/// A finished run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Output {
    pub code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

pub trait Clock: Send + Sync {
    /// Unix seconds.
    fn now(&self) -> u64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_secs())
    }
}

pub trait Log: Send + Sync {
    fn line(&self, text: &str);
}

/// A log that keeps its lines, for every task's tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryLog(std::sync::Mutex<Vec<String>>);

#[cfg(test)]
impl MemoryLog {
    pub fn lines(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

#[cfg(test)]
impl Log for MemoryLog {
    fn line(&self, text: &str) {
        self.0.lock().unwrap().push(text.to_string());
    }
}

/// A clock a test moves by hand.
#[cfg(test)]
#[derive(Default)]
pub struct FixedClock(std::sync::atomic::AtomicU64);

#[cfg(test)]
impl FixedClock {
    pub fn set(&self, now: u64) {
        self.0.store(now, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
impl Clock for FixedClock {
    fn now(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn a_status_line_needs_attached() {
        let status: DialStatus =
            serde_json::from_str(r#"{"attached":true,"fw":"0.0.95","settings":{}}"#).unwrap();
        assert_eq!(
            status,
            DialStatus {
                attached: true,
                fw: Some("0.0.95".into()),
                hw: None,
                board: None,
                updating: None,
                problem: None,
            }
        );
        for line in [r#"{}"#, r#"{"error":"x"}"#, r#"{"attached":"yes"}"#] {
            assert!(serde_json::from_str::<DialStatus>(line).is_err(), "{line}");
        }
    }

    #[test]
    fn a_view_is_the_json_the_window_reads() {
        let view = View { screen: Screen::SignIn, phase: Phase::Browser, lines: vec!["Waiting".into()] };
        assert_eq!(
            serde_json::to_value(view).unwrap(),
            json!({"screen":"sign_in","phase":"browser","lines":["Waiting"]})
        );
    }

    #[test]
    fn the_window_may_ask_six_things() {
        let asks = [
            ("retry", Action::Retry),
            ("sign_in", Action::SignIn),
            ("later", Action::Later),
            ("cancel", Action::Cancel),
            ("turn_on", Action::TurnOn),
            ("not_now", Action::NotNow),
        ];
        for (name, action) in asks {
            assert_eq!(serde_json::from_value::<Action>(json!(name)).unwrap(), action);
        }
        for other in [json!("quit"), json!("sh -c x"), json!(1), Value::Null] {
            assert!(serde_json::from_value::<Action>(other.clone()).is_err(), "{other}");
        }
    }

    #[test]
    fn state_json_keys() {
        let keys = json!({"version":1,"cliSeen":false,"askedSignIn":false,"askedClaude":false,"loginItem":false});
        assert_eq!(serde_json::to_value(Saved::default()).unwrap(), keys);
        assert_eq!(serde_json::from_value::<Saved>(keys).unwrap(), Saved::default());
    }

    #[test]
    fn claude_status_reads_camel_case() {
        let status: ClaudeStatus = serde_json::from_str(
            r#"{"supported":true,"installed":true,"enabled":false,"claudeVersion":"2.1.0"}"#,
        )
        .unwrap();
        assert_eq!(
            status,
            ClaudeStatus { supported: true, installed: true, enabled: false, claude_version: Some("2.1.0".into()) }
        );
        assert_eq!(serde_json::from_str::<ClaudeStatus>("{}").unwrap(), ClaudeStatus::default());
    }

    #[test]
    fn the_window_is_small_fixed_and_hidden() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], "ai.autonomous.harness.device");
        assert_eq!(config["productName"], "Harness Device");
        assert_eq!(config["build"]["frontendDist"], "../ui/dist");
        assert_eq!(config["app"]["security"]["csp"], "default-src 'self'; connect-src ipc: http://ipc.localhost");
        let windows = config["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        let window = &windows[0];
        assert_eq!(window["label"], "main");
        assert_eq!(window["title"], "Harness Device");
        assert_eq!((window["width"].as_f64(), window["height"].as_f64()), (Some(420.0), Some(320.0)));
        assert_eq!(window["resizable"], false);
        assert_eq!(window["center"], true);
        assert_eq!(window["visible"], false);
    }

    #[test]
    fn the_webview_may_call_two_commands() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(
            capability["permissions"],
            json!(["core:event:allow-listen", "core:event:allow-unlisten", "allow-view", "allow-act"])
        );
        assert!(!include_str!("../Cargo.toml").contains("tauri-plugin"));
    }

    #[test]
    fn the_bundle_asks_for_the_local_network() {
        // One line per tag, so the plist's indentation does not matter.
        let plist: String = include_str!("../Info.plist").lines().map(str::trim).collect();
        for entry in [
            "<key>NSLocalNetworkUsageDescription</key>\
             <string>Harness finds and connects to Autonomous robots on your local network.</string>",
            "<key>NSBonjourServices</key><array><string>_autonomous._tcp</string></array>",
            "<key>LSUIElement</key><true/>",
        ] {
            assert!(plist.contains(entry), "{entry}");
        }
    }
}
