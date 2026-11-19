//! The menu is the same on every OS: the model and the app take no OS.

use crate::app::App;
use crate::install::DOWNLOADING_HARNESS;
use crate::tick::{menu_opened, tick};
use crate::types::{
    Action, DialStatus, Effect, Event, Exported, LoginEvent, MenuAction, MenuItem, NotifyMode, Saved, UpdateFailure,
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
    for (name, source) in [("model.rs", include_str!("model.rs")), ("app.rs", include_str!("app.rs"))] {
        let code = rules(source);
        assert!(code.len() < source.len(), "{name} has its tests cut off");
        // `cfg(` holds `cfg(target_os`, `cfg(windows)`, `cfg(unix)` and their `not(…)`.
        for word in ["cfg(", "cfg!(", "cfg_attr(", "target_os", "consts::OS"] {
            assert!(!code.contains(word), "{name} reads the OS: {word}");
        }
    }
}

#[test]
fn linuxs_tick_feeds_the_menu_opened_a_click_does() {
    let ticked = tick("linux", 7, true, &|| true);
    assert_eq!(ticked[1], menu_opened(7, true));
    assert_eq!(menu_opened(7, true), Event::MenuOpened { now: 7, desktop_installed: true });
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
    let (apart, first_apart) = App::new(saved, cli_found, false, B, true);
    let (app, first) = App::new(saved, cli_found, false, B, false);
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
    let found = Saved { version: 1, cli_seen: true, asked_sign_in: true, login_item: true };
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
