//! The menu is the same on every OS: the model and the app read no OS. main.rs hands them the two answers that differ,
//! whether installing an update ends the app (Windows) and whether Follow ChatGPT is Harness's own switch (off macOS).
//! The one refresh that differs, Linux's tick telling what a click tells elsewhere, is tick.rs's test; main.rs hands
//! `tick::menu_opened` to the tray's click and `tick::tick` to the timer (`ticked`). Whether Follow ChatGPT shows comes
//! from the door main.rs hands the runner (`follow::system`): the rules read only its answers.

use crate::app::App;
use crate::follow::{AxTrust, ChatgptWindow, NoFollow};
use crate::install::DOWNLOADING_HARNESS;
use crate::tick::menu_opened;
use crate::types::{
    Action, DialStatus, Effect, Event, Exported, LoginEvent, MenuAction, MenuItem, NotifyMode, Saved, Screen,
    UpdateFailure,
};

/// Second 0 of a minute.
const B: u64 = 1794556800;

/// The code of a module, without its tests, and without the one attribute that keeps a test helper out of the binary.
fn rules(source: &str) -> String {
    let code = source.split("\n#[cfg(test)]\nmod tests").next().unwrap_or(source);
    code.replace("#[cfg(test)]", "")
}

#[test]
fn the_menu_and_the_rules_read_no_os() {
    // The app's keep-alive decisions are keepalive.rs's, and its events and effects types.rs's.
    let modules = [
        ("model.rs", include_str!("model.rs")),
        ("app.rs", include_str!("app.rs")),
        ("keepalive.rs", include_str!("keepalive.rs")),
        ("types.rs", include_str!("types.rs")),
    ];
    for (name, source) in modules {
        let code = rules(source);
        assert!(code.len() < source.len(), "{name} has its tests cut off");
        // `cfg(` holds `cfg(target_os`, `cfg(windows)`, `cfg(unix)` and their `not(…)`; `consts::` holds
        // `consts::OS` and `consts::{OS}`; an environment read may name the OS too.
        for word in ["cfg(", "cfg!(", "cfg_attr(", "target_os", "consts::", "std::env", "env::"] {
            assert!(!code.contains(word), "{name} reads the OS: {word}");
        }
    }
}

fn status(muted: bool) -> Event {
    Event::WatchLine(DialStatus {
        attached: true,
        fw: Some("0.0.95".into()),
        hw: None,
        board: None,
        updating: None,
        problem: None,
        muted: Some(muted),
        notify: Some(NotifyMode::Full),
    })
}

fn ticked(now: u64, desktop_running: bool) -> Event {
    Event::Tick { now, desktop_running }
}

/// The app where installing its update ends it (`true`, Windows) and where it does not.
fn both(saved: Saved, cli_found: bool) -> (App, App) {
    let (apart, first_apart) = App::new(saved, cli_found, false, B, true, false);
    let (app, first) = App::new(saved, cli_found, false, B, false, false);
    assert_eq!(first_apart, first);
    (apart, app)
}

#[test]
fn the_one_os_property_of_the_rules_is_install_exits_app() {
    // Everything but an update: the same effects at every step.
    let script = [
        Event::InstallStep(DOWNLOADING_HARNESS),
        Event::InstallDone(Ok(())),
        Event::StartDone { ok: true },
        status(false),
        Event::Auth(Some(false)),
        Event::CliVersion(Some("0.6.58".into())),
        ticked(B + 5, false),
        Event::UpdateChecked(None),
        Event::Act(Action::SignIn),
        Event::Login(LoginEvent::AuthorizeUrl("https://harness.autonomous.ai/login".into())),
        Event::Login(LoginEvent::Waiting("Waiting".into())),
        Event::Login(LoginEvent::Done(Ok(()))),
        Event::Auth(Some(true)),
        Event::Follow { trusted: false, installed: true },
        Event::FollowOffer,
        Event::Act(Action::Allow),
        Event::Follow { trusted: true, installed: true },
        Event::Menu(MenuAction::FollowSettings),
        menu_opened(B + 70, true),
        Event::Menu(MenuAction::SoundOff),
        status(true),
        Event::Menu(MenuAction::NotifyYou),
        Event::Menu(MenuAction::ExportLogs),
        Event::LogsExported(Ok(Exported { zip: "/h/harness-logs.zip".into(), shown: "~/harness-logs.zip".into() })),
        ticked(B + 75, true),
        Event::UpdateFailed(UpdateFailure::Check),
        Event::WatchExit(Some(1)),
        ticked(B + 80, false),
        Event::Menu(MenuAction::About),
        Event::Cli(false),
        ticked(B + 85, false),
        Event::Cli(true),
        Event::Menu(MenuAction::OpenHarness),
        Event::WindowClosed,
        Event::Menu(MenuAction::Quit),
    ];
    let (mut apart, mut app) = both(Saved::default(), false);
    for (step, event) in script.into_iter().enumerate() {
        assert_eq!(apart.handle(event.clone()), app.handle(event.clone()), "step {step}: {event:?}");
    }

    // An update: the row shows from the install on, `update: installing` is said instead of `update: installed`, and
    // the install itself ends the app, so the watch is not stopped and nothing relaunches.
    let found = Saved { version: 1, cli_seen: true, asked_sign_in: true, login_item: true, ..Saved::default() };
    let (mut apart, mut app) = both(found, true);
    let update = [
        ticked(B + 5, false),
        Event::UpdateChecked(Some("0.1.3".into())),
        Event::UpdateDownloaded,
        Event::UpdateInstalled,
        ticked(B + 10, false),
    ];
    let mut apart_effects = Vec::new();
    let mut effects = Vec::new();
    for event in update {
        // Windows never hears it: the install ended the process.
        if event != Event::UpdateInstalled {
            apart_effects.extend(apart.handle(event.clone()));
        }
        effects.extend(app.handle(event));
    }
    assert!(shows_the_row(&apart_effects) && shows_the_row(&effects));
    assert!(effects.ends_with(&[Effect::StopWatch, Effect::Relaunch]), "{effects:?}");
    effects.truncate(effects.len() - 2);
    let rest = |effects: Vec<Effect>, said: &str| -> Vec<Effect> {
        let named = |effect: &Effect| match effect {
            Effect::Menu(_) => true,
            Effect::Log(line) => line.starts_with("menu: ") || line == said,
            _ => false,
        };
        effects.into_iter().filter(|effect| !named(effect)).collect()
    };
    let same =
        [Effect::CheckUpdate, Effect::Log("update: found 0.1.3".into()), Effect::DownloadUpdate, Effect::InstallUpdate];
    assert_eq!(rest(apart_effects, "update: installing 0.1.3"), same);
    assert_eq!(rest(effects, "update: installed 0.1.3"), same);
}

fn shows_the_row(effects: &[Effect]) -> bool {
    let row = MenuItem::Text("Updating Harness…".into());
    effects.iter().any(|effect| matches!(effect, Effect::Menu(items) if items.contains(&row)))
}

/// Whether the menu's last Follow ChatGPT item and its screen show, signed in with a dial attached, once the runner has
/// told what the door answers and ChatGPT came to the front. `switch`: the rules off macOS.
fn follow_shown(switch: bool, trusted: bool, installed: bool) -> (bool, bool) {
    let seen = Saved { cli_seen: true, asked_sign_in: true, login_item: true, ..Saved::default() };
    let (mut app, mut effects) = App::new(seen, true, false, B, false, switch);
    for event in
        [Event::StartDone { ok: true }, status(false), Event::Auth(Some(true)), Event::Follow { trusted, installed }]
    {
        effects.extend(app.handle(event));
    }
    effects.extend(app.handle(Event::FollowOffer));
    let menu = effects.iter().rev().find_map(|effect| match effect {
        Effect::Menu(items) => Some(items),
        _ => None,
    });
    let item = menu.is_some_and(|items| {
        items.iter().any(|item| {
            matches!(
                item,
                MenuItem::Check(MenuAction::FollowChatgpt | MenuAction::FollowSettings | MenuAction::FollowSwitch, ..)
            )
        })
    });
    (item, app.view().is_some_and(|view| view.screen == Screen::Follow))
}

#[test]
fn follow_chatgpt_shows_only_with_a_door_that_has_the_chatgpt_app() {
    // macOS's door, the ChatGPT app installed and no permission yet: the item, and the offer's screen.
    assert_eq!(follow_shown(false, false, true), (true, true));
    // A door off macOS with the ChatGPT app installed, its switch on: the item, and no screen, since nothing is asked.
    assert_eq!(follow_shown(true, true, true), (true, false));
    // A desktop with no door (GNOME or KDE on Wayland), off macOS's rules: no item and no screen.
    assert_eq!(follow_shown(true, NoFollow.trusted(), NoFollow.installed()), (false, false));
}

#[cfg(not(target_os = "macos"))]
#[test]
fn off_macos_the_saved_switch_is_what_the_door_trusts() {
    let door = |switch_on| crate::follow::system(std::env::temp_dir(), switch_on).trusted();
    // Windows always has its door. On Linux the door is the session's (NoFollow on CI, with no window system), so
    // only the switch off is held here: follow's door_kind test and its
    // off_macos_the_switch_is_the_permission_and_nothing_is_asked_or_told hold the rest.
    #[cfg(windows)]
    assert!(door(true));
    assert!(!door(false));
}
