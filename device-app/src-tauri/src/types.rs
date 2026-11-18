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
    /// The dial's sound setting; None from an older CLI or a firmware with no settings.
    pub muted: Option<bool>,
    /// This computer's Notifications setting, kept by the daemon; None from an older CLI, or a value this app does not
    /// know.
    #[serde(default, deserialize_with = "notify_mode")]
    pub notify: Option<NotifyMode>,
}

/// This computer's Notifications setting, kept by the daemon. Needs you (`You`): an ordinary finished turn neither
/// beeps nor wakes the dial.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifyMode {
    Full,
    You,
}

/// Lenient: a newer CLI's mode must not make its line no status, which the keep-alive would read as a silent watch.
fn notify_mode<'de, D: serde::Deserializer<'de>>(value: D) -> Result<Option<NotifyMode>, D::Error> {
    Ok(match serde_json::Value::deserialize(value)?.as_str() {
        Some("full") => Some(NotifyMode::Full),
        Some("you") => Some(NotifyMode::You),
        _ => None,
    })
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

/// state.json: `{ "version": 1, "cliSeen", "askedSignIn", "loginItem" }`. Default: version 1, all false. The keys of
/// the Claude Code and Codex offers an older app wrote are ignored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub version: u32,
    pub cli_seen: bool,
    pub asked_sign_in: bool,
    pub login_item: bool,
}

impl Default for Saved {
    fn default() -> Self {
        Saved { version: 1, cli_seen: false, asked_sign_in: false, login_item: false }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Screen {
    Install,
    SignIn,
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

/// What the window may ask: `"retry" | "sign_in" | "later" | "cancel"`. Anything else is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Retry,
    SignIn,
    Later,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    Install,
    SignIn,
    SoundOn,
    SoundOff,
    NotifyFull,
    NotifyYou,
    Update,
    OpenHarness,
    About,
    Quit,
}

/// Text is a disabled line. Check: the action a click does, the label, whether it is checked. Submenu: its label and
/// its items.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuItem {
    Text(String),
    Action(MenuAction, String),
    Check(MenuAction, String, bool),
    Submenu(String, Vec<MenuItem>),
    Separator,
}

/// Why an update did not happen. NotWritable: the person cannot replace the bundle; nothing was downloaded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateFailure {
    Check,
    Download,
    Signature,
    Install,
    NotWritable,
}

/// The app's own update, as the menu shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum AppUpdate {
    #[default]
    None,
    Installing,
    Blocked(String),
}

/// What the menu is drawn from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppState {
    pub cli: CliState,
    pub daemon: Daemon,
    pub dial: Option<DialStatus>,
    pub signed_in: Option<bool>,
    pub desktop_installed: bool,
    pub saved: Saved,
    pub app_update: AppUpdate,
    /// What `harness --version` printed, for the About panel.
    pub cli_version: Option<String>,
}

/// AuthorizeUrl holds an `https:` URL only (account.rs lets no other through).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoginEvent {
    AuthorizeUrl(String),
    Waiting(String),
    Done(Result<(), String>),
}

/// What happened. WatchExit(None): ended by a signal. UpdateChecked(Some): a strictly newer release. InstallStep:
/// `'static`, so only the step table's fixed copy can be one, never a line of the script's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Tick { now: u64, desktop_running: bool },
    MenuOpened { now: u64, desktop_installed: bool },
    Cli(bool),
    WatchLine(DialStatus),
    WatchExit(Option<i32>),
    StartDone { ok: bool },
    InstallStep(&'static str),
    InstallDone(Result<(), Vec<String>>),
    Auth(Option<bool>),
    CliVersion(Option<String>),
    Login(LoginEvent),
    LoginItem(bool),
    Menu(MenuAction),
    Act(Action),
    WindowClosed,
    UpdateChecked(Option<String>),
    UpdateInstalled,
    UpdateFailed(UpdateFailure),
}

/// What to do about it. Show(None) hides the window. ShowAbout: the About panel, with its credits line. Menu, Show,
/// ShowAbout, Quit and Relaunch are the binary's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    FindCli,
    SpawnWatch,
    StopWatch,
    RunStart,
    RunInstall,
    ReadAuth,
    ReadVersion,
    RunLogin,
    CancelLogin,
    /// `true` turns the dial's sound on.
    SetSound(bool),
    SetNotify(NotifyMode),
    OpenUrl(String),
    OpenDesktop,
    RegisterLoginItem,
    Save(Saved),
    Log(String),
    CheckUpdate,
    InstallUpdate,
    Menu(Vec<MenuItem>),
    Show(Option<View>),
    ShowAbout(Option<String>),
    Quit,
    Relaunch,
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
        let status: DialStatus = serde_json::from_str(r#"{"attached":true,"fw":"0.0.95","settings":{}}"#).unwrap();
        assert_eq!(
            status,
            DialStatus {
                attached: true,
                fw: Some("0.0.95".into()),
                hw: None,
                board: None,
                updating: None,
                problem: None,
                muted: None,
                notify: None,
            }
        );
        for line in [r#"{}"#, r#"{"error":"x"}"#, r#"{"attached":"yes"}"#] {
            assert!(serde_json::from_str::<DialStatus>(line).is_err(), "{line}");
        }
    }

    #[test]
    fn a_status_line_carries_muted() {
        let muted = |line: &str| serde_json::from_str::<DialStatus>(line).map(|status| status.muted);
        assert_eq!(muted(r#"{"attached":true,"muted":true}"#).unwrap(), Some(true));
        assert_eq!(muted(r#"{"attached":true}"#).unwrap(), None);
        assert!(muted(r#"{"attached":true,"muted":"yes"}"#).is_err());
    }

    #[test]
    fn a_status_line_carries_notify() {
        let notify = |line: &str| serde_json::from_str::<DialStatus>(line).map(|status| status.notify);
        assert_eq!(notify(r#"{"attached":true,"notify":"you"}"#).unwrap(), Some(NotifyMode::You));
        assert_eq!(notify(r#"{"attached":true,"notify":"full"}"#).unwrap(), Some(NotifyMode::Full));
        assert_eq!(notify(r#"{"attached":true}"#).unwrap(), None);
        // A newer CLI's mode, or a value of another type, is no mode: the line is still a status.
        for line in [
            r#"{"attached":true,"notify":"later"}"#,
            r#"{"attached":true,"notify":7}"#,
            r#"{"attached":true,"notify":null}"#,
        ] {
            assert_eq!(notify(line).unwrap(), None, "{line}");
        }
    }

    #[test]
    fn a_view_is_the_json_the_window_reads() {
        let view = View { screen: Screen::SignIn, phase: Phase::Browser, lines: vec!["Waiting".into()] };
        assert_eq!(
            serde_json::to_value(view).unwrap(),
            json!({"screen":"sign_in","phase":"browser","lines":["Waiting"]})
        );
        assert_eq!(serde_json::to_value(Screen::Install).unwrap(), json!("install"));
    }

    #[test]
    fn the_window_may_ask_four_things() {
        let asks = [
            ("retry", Action::Retry),
            ("sign_in", Action::SignIn),
            ("later", Action::Later),
            ("cancel", Action::Cancel),
        ];
        for (name, action) in asks {
            assert_eq!(serde_json::from_value::<Action>(json!(name)).unwrap(), action);
        }
        // The offers of Claude Code and Codex are gone, and their buttons with them.
        for other in [json!("turn_on"), json!("not_now"), json!("quit"), json!("sh -c x"), json!(1), Value::Null] {
            assert!(serde_json::from_value::<Action>(other.clone()).is_err(), "{other}");
        }
    }

    #[test]
    fn state_json_keys() {
        let keys = json!({ "version": 1, "cliSeen": false, "askedSignIn": false, "loginItem": false });
        assert_eq!(serde_json::to_value(Saved::default()).unwrap(), keys);
        assert_eq!(serde_json::from_value::<Saved>(keys).unwrap(), Saved::default());
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
        assert_eq!(window["title"], "Harness");
        assert_eq!((window["width"].as_f64(), window["height"].as_f64()), (Some(420.0), Some(320.0)));
        assert_eq!(window["resizable"], false);
        assert_eq!(window["center"], true);
        assert_eq!(window["visible"], false);
    }

    /// The file stays Harness Device.app beside the desktop app's Harness.app, and updates find it by that name;
    /// Finder, Login Items, the About panel and permission prompts show the bundle's name, Harness.
    #[test]
    fn the_app_is_named_harness() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["productName"], "Harness Device");
        let macos = &config["bundle"]["macOS"];
        assert_eq!(macos["bundleName"], "Harness");
        // One line per tag, so the plist's indentation does not matter. Tauri writes the region "English": "en" names
        // the folder the strings below ship in.
        let plist: String = include_str!("../Info.plist").lines().map(str::trim).collect();
        for entry in
            ["<key>CFBundleDevelopmentRegion</key><string>en</string>", "<key>LSHasLocalizedDisplayName</key><true/>"]
        {
            assert!(plist.contains(entry), "{plist}");
        }
        // macOS shows the localized name only while the plist's display name, which Tauri sets to productName, is the
        // file's name.
        assert!(!plist.contains("CFBundleDisplayName"), "{plist}");
        let source = macos["files"]["Resources/en.lproj/InfoPlist.strings"].as_str().expect("InfoPlist.strings mapped");
        let strings = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(source)).unwrap();
        assert_eq!(strings, "CFBundleName = \"Harness\";\nCFBundleDisplayName = \"Harness\";\n");
    }

    /// A template image 18 points square at two pixels a point: macOS keeps only its alpha, so it tints it for a light
    /// bar and a dark one.
    #[test]
    fn the_tray_is_a_36_pixel_template() {
        let png = include_bytes!("../icons/tray.png");
        // A PNG's width and height are the big-endian u32s at bytes 16..24, in its IHDR chunk.
        assert_eq!(png[16..24], [0, 0, 0, 36, 0, 0, 0, 36]);
        let image = tauri::image::Image::from_bytes(png).unwrap();
        assert!(image.rgba().chunks(4).all(|pixel| pixel[..3] == [0, 0, 0]), "a pixel is not black");
        assert!(image.rgba().chunks(4).any(|pixel| pixel[3] == 255), "no pixel is opaque");
    }

    #[test]
    fn the_webview_may_close_itself_and_call_two_commands() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(
            capability["permissions"],
            json!([
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "core:window:allow-close",
                "allow-view",
                "allow-act"
            ])
        );
        // The updater is registered in Rust only: the capability above grants the webview none of it.
        let plugins: Vec<&str> =
            include_str!("../Cargo.toml").lines().filter(|line| line.contains("tauri-plugin")).collect();
        assert_eq!(plugins.len(), 1, "{plugins:?}");
        assert!(plugins[0].starts_with("tauri-plugin-updater = "), "{}", plugins[0]);
    }

    #[test]
    fn the_app_reads_one_https_manifest() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = config["plugins"]["updater"].as_object().expect("plugins.updater");
        assert_eq!(
            updater["endpoints"],
            json!(["https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json"])
        );
        // So no `dangerous…` key lets plain http or a bad certificate through.
        for key in updater.keys() {
            assert!(["endpoints", "pubkey", "requireSignedVersion"].contains(&key.as_str()), "{key}");
        }
        // The manifest is not signed: without it, a manifest that pairs a new version with an older release's
        // signed archive installs that older release.
        assert_eq!(updater.get("requireSignedVersion"), Some(&json!(true)));
        // On, every local build would need the private key: the release turns it on through --config.
        assert_eq!(config["bundle"].get("createUpdaterArtifacts"), None);
    }

    #[test]
    fn the_updater_checks_with_the_committed_key() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let key = config["plugins"]["updater"]["pubkey"].as_str().expect("plugins.updater.pubkey");
        assert!((100..=300).contains(&key.len()), "{}", key.len());
        assert!(key.chars().all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c)), "{key}");
        // Base64 of "untrusted comment: minisign public key:", the first line of every key Tauri writes.
        assert!(key.starts_with("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6"), "{key}");
    }

    #[test]
    fn the_version_is_the_releases() {
        // The release writes its version through --config: a placeholder no release reads, so a local build never
        // outranks one.
        assert!(include_str!("../Cargo.toml").lines().any(|line| line == r#"version = "0.0.0""#));
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config.get("version"), None);
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
