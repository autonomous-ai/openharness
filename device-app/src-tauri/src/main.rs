//! The binary: the tray, the window and the timer. Every rule they follow is in the library, under `cargo test`.

use harness_device::app::App;
use harness_device::cli::cli_override;
use harness_device::desktop::{DesktopApp, SystemDesktopApp, run_open};
use harness_device::front;
use harness_device::install::{Shell, system_shell};
use harness_device::log::FileLog;
use harness_device::loginitem::SystemLoginItem;
use harness_device::runner::{Doors, Runner};
use harness_device::state::{JsonStateFile, StateFile};
use harness_device::tabs;
use harness_device::types::{Action, Clock, Effect, Event, Log, MenuAction, MenuItem, SystemClock, View};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem as NativeItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

const TICK: Duration = Duration::from_secs(5);
const TRAY: &str = "main";
const WINDOW: &str = "main";

/// What the window's commands and close button reach.
struct Shared {
    /// The view last shown, for a webview that asks after it loads.
    view: Mutex<Option<View>>,
    /// The app's one queue: every event goes through it, so the loop handles them in the order they came.
    events: Sender<Event>,
}

#[tauri::command]
fn view(shared: tauri::State<Shared>) -> Option<View> {
    shared.view.lock().unwrap().clone()
}

/// An action that is not one of the five never gets here: its JSON does not parse.
#[tauri::command]
fn act(action: Action, shared: tauri::State<Shared>) {
    let _ = shared.events.send(Event::Act(action));
}

fn main() {
    let (events, queue) = mpsc::channel();
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut app = tauri::Builder::default()
        // Managed before the window is made, so its first `view` finds it.
        .manage(Shared { view: Mutex::default(), events: events.clone() })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![view, act])
        .setup(move |app| start(app.handle(), events, queue).map_err(Into::into))
        // Closing never quits: the window hides, and the app decides what closing answers.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                let _ = window.state::<Shared>().events.send(Event::WindowClosed);
            }
        })
        .build(tauri::generate_context!())
        .expect("Harness could not start");
    // Decision 3: no Dock icon. Set before the event loop runs: in `setup`, macOS has already made the app Regular and
    // the window is made, so the Dock icon shows for a moment at each launch.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    app.run(|_, _| {});
}

/// On the main thread.
fn start(handle: &AppHandle, events: Sender<Event>, queue: Receiver<Event>) -> tauri::Result<()> {
    let paths = handle.path();
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let log: Arc<dyn Log> = Arc::new(FileLog::new(paths.app_log_dir()?, clock.clone()));
    let state = Arc::new(JsonStateFile::new(paths.app_data_dir()?, log.clone()));
    let saved = state.load();
    let doors = Doors {
        home: paths.home_dir()?,
        path_var: std::env::var_os("PATH"),
        cli_override: cli_override(cfg!(debug_assertions), std::env::var_os("HARNESS_DEVICE_CLI")),
        shell: system_shell().map(|shell| Arc::new(shell) as Arc<dyn Shell>),
        login_item: Arc::new(SystemLoginItem),
        state,
        log: log.clone(),
        open: {
            let log = log.clone();
            Arc::new(move |args: &[&str]| run_open(args, log.clone()))
        },
        front: front::system(log.clone()),
        tabs: tabs::system(),
        updater: harness_device::update::system(handle),
    };

    // A watch or a sign-in hands its events over holding a lock that stopping or cancelling it takes: `send` only
    // queues, never runs anything.
    let answers = events.clone();
    let runner = Runner::new(
        doors,
        Arc::new(move |event| {
            let _ = answers.send(event);
        }),
    );

    let (clicks, chosen) = (events.clone(), events.clone());
    TrayIconBuilder::with_id(TRAY)
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true)
        .tooltip("Harness")
        .on_menu_event(move |_, event| {
            if let Some(action) = menu_action(event.id().as_ref()) {
                let _ = chosen.send(Event::Menu(action));
            }
        })
        // Down only: one click is one MenuOpened. Tray events arrive on the main thread, where AppKit is read.
        .on_tray_icon_event(move |_, event| {
            if let TrayIconEvent::Click { button_state: MouseButtonState::Down, .. } = event {
                let desktop_installed = SystemDesktopApp.installed();
                let _ = clicks.send(Event::MenuOpened { now: SystemClock.now(), desktop_installed });
            }
        })
        .build(handle)?;

    let (app, first) = App::new(saved, runner.find_cli(), SystemDesktopApp.installed(), clock.now());
    let looping = handle.clone();
    thread::spawn(move || run_loop(&looping, &log, app, &runner, first, queue));

    #[cfg(target_os = "macos")]
    let ticking = handle.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(TICK);
            let events = events.clone();
            // AppKit's running applications are read on the main thread.
            #[cfg(target_os = "macos")]
            let sent = ticking.run_on_main_thread(move || {
                let desktop_running = SystemDesktopApp.running();
                let _ = events.send(Event::Tick { now: SystemClock.now(), desktop_running });
            });
            // Elsewhere it is a scan of every process: here, never on the main thread, where it would hold the tray.
            #[cfg(not(target_os = "macos"))]
            let sent = {
                let desktop_running = SystemDesktopApp.running();
                events.send(Event::Tick { now: SystemClock.now(), desktop_running })
            };
            if sent.is_err() {
                return;
            }
        }
    });
    Ok(())
}

/// The one loop that owns the app: each event in the order it was queued, and each of its effects in order, before
/// the next event. So a sign-in's answer queued before a cancel is handled before any later click.
fn run_loop(
    handle: &AppHandle,
    log: &Arc<dyn Log>,
    mut app: App,
    runner: &Runner,
    first: Vec<Effect>,
    queue: Receiver<Event>,
) {
    // `asked`: the effects answer a menu click.
    let run = |effects: Vec<Effect>, asked: bool| {
        for effect in effects {
            // Menu, Show, ShowAbout, Quit and Relaunch are AppKit's, on the main thread, which runs them in the order
            // they are handed over.
            if let Some(effect) = runner.run(effect) {
                let (drawing, log) = (handle.clone(), log.clone());
                let _ = handle.run_on_main_thread(move || {
                    if let Err(error) = draw(&drawing, effect, asked) {
                        log.line(&format!("menu or window: {error}"));
                    }
                });
            }
        }
    };
    run(first, false);
    for event in queue {
        let asked = matches!(event, Event::Menu(_));
        run(app.handle(event), asked);
    }
}

/// On the main thread.
fn draw(handle: &AppHandle, effect: Effect, asked: bool) -> tauri::Result<()> {
    match effect {
        Effect::Menu(items) => {
            if let Some(tray) = handle.tray_by_id(TRAY) {
                tray.set_menu(Some(native_menu(handle, &items)?))?;
            }
        }
        Effect::Show(view) => {
            let last = std::mem::replace(&mut *handle.state::<Shared>().view.lock().unwrap(), view.clone());
            let Some(window) = handle.get_webview_window(WINDOW) else { return Ok(()) };
            window.emit("view", &view)?;
            match &view {
                Some(next) if raises(last.as_ref(), next, asked) => {
                    window.show()?;
                    window.set_focus()?;
                }
                Some(_) => {}
                None => window.hide()?,
            }
        }
        Effect::ShowAbout(credits) => show_about(credits.as_deref()),
        // The daemon is left running: the app only ever watched it.
        Effect::Quit => handle.exit(0),
        Effect::Relaunch => handle.restart(),
        _ => {}
    }
    Ok(())
}

/// macOS's standard About panel, its name and version from the bundle's Info.plist, and the credits line under them.
/// Tauri's predefined About opens it without bringing the app forward: an Accessory app is never active by itself, so
/// the panel would open behind the app in front.
#[cfg(target_os = "macos")]
fn show_about(credits: Option<&str>) {
    use objc2::MainThreadMarker;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSAboutPanelOptionCredits, NSApplication};
    use objc2_foundation::{NSAttributedString, NSDictionary, NSString};

    let Some(main) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(main);
    // `activate`, its replacement, is macOS 14 and later; the app runs from 13.
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    let options = match credits {
        Some(credits) => {
            let text = NSAttributedString::from_nsstring(&NSString::from_str(credits));
            let value: &AnyObject = &text;
            // SAFETY: a static AppKit defines, read on the main thread.
            NSDictionary::from_slices(&[unsafe { NSAboutPanelOptionCredits }], &[value])
        }
        None => NSDictionary::new(),
    };
    // SAFETY: the one key is NSAboutPanelOptionCredits, with the NSAttributedString the panel takes for it.
    unsafe { app.orderFrontStandardAboutPanelWithOptions(&options) };
}

/// Only macOS is released.
#[cfg(not(target_os = "macos"))]
fn show_about(_credits: Option<&str>) {}

/// Whether showing `next` after `last` raises the window and takes the keyboard: a new screen, or one the menu asked
/// for, which may be behind another app's windows. A phase or its lines only redraw, so a sign-in's `Waiting` never
/// takes the keyboard from the browser.
fn raises(last: Option<&View>, next: &View, asked: bool) -> bool {
    asked || last.map(|view| view.screen) != Some(next.screen)
}

fn native_menu(handle: &AppHandle, items: &[MenuItem]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(handle)?;
    for item in items {
        menu.append(native_item(handle, item)?.as_ref())?;
    }
    Ok(menu)
}

/// A submenu's items are drawn by the rules the top level uses.
fn native_item(handle: &AppHandle, item: &MenuItem) -> tauri::Result<Box<dyn IsMenuItem<tauri::Wry>>> {
    Ok(match item {
        MenuItem::Text(text) => Box::new(NativeItem::new(handle, text, false, None::<&str>)?),
        MenuItem::Action(action, text) => {
            Box::new(NativeItem::with_id(handle, menu_id(*action), text, true, None::<&str>)?)
        }
        MenuItem::Check(action, text, checked) => {
            Box::new(CheckMenuItem::with_id(handle, menu_id(*action), text, true, *checked, None::<&str>)?)
        }
        MenuItem::Submenu(text, items) => {
            let submenu = Submenu::new(handle, text, true)?;
            for item in items {
                submenu.append(native_item(handle, item)?.as_ref())?;
            }
            Box::new(submenu)
        }
        MenuItem::Separator => Box::new(PredefinedMenuItem::separator(handle)?),
    })
}

/// A menu item's id is its action's name.
fn menu_id(action: MenuAction) -> &'static str {
    match action {
        MenuAction::Install => "install",
        MenuAction::SignIn => "sign_in",
        MenuAction::Orca => "orca",
        MenuAction::SoundOn => "sound_on",
        MenuAction::SoundOff => "sound_off",
        MenuAction::NotifyFull => "notify_full",
        MenuAction::NotifyYou => "notify_you",
        MenuAction::Update => "update",
        MenuAction::OpenHarness => "open_harness",
        MenuAction::About => "about",
        MenuAction::Quit => "quit",
        MenuAction::ExportLogs => "export_logs",
    }
}

fn menu_action(id: &str) -> Option<MenuAction> {
    use MenuAction::*;
    [Install, SignIn, Orca, SoundOn, SoundOff, NotifyFull, NotifyYou, Update, OpenHarness, About, Quit, ExportLogs]
        .into_iter()
        .find(|action| menu_id(*action) == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_device::types::{Phase, Screen};

    fn view(screen: Screen, phase: Phase, lines: &[&str]) -> View {
        View { screen, phase, lines: lines.iter().map(|line| line.to_string()).collect(), update: false }
    }

    #[test]
    fn every_menu_action_has_its_own_id() {
        use MenuAction::*;
        let actions = [
            Install,
            SignIn,
            Orca,
            SoundOn,
            SoundOff,
            NotifyFull,
            NotifyYou,
            Update,
            OpenHarness,
            About,
            Quit,
            ExportLogs,
        ];
        for action in actions {
            assert_eq!(menu_action(menu_id(action)), Some(action));
        }
        let ids: std::collections::HashSet<_> = actions.into_iter().map(menu_id).collect();
        assert_eq!(ids.len(), 12);
        assert_eq!(menu_id(About), "about");
        assert_eq!(menu_id(ExportLogs), "export_logs");
        assert_eq!(menu_id(Orca), "orca");
        assert_eq!(menu_id(NotifyFull), "notify_full");
        assert_eq!(menu_id(NotifyYou), "notify_you");
        assert_eq!(menu_action("sound"), None);
        assert_eq!(menu_action("notify"), None);
    }

    #[test]
    fn only_a_new_screen_or_a_menu_click_takes_the_keyboard() {
        let offer = view(Screen::SignIn, Phase::Offer, &[]);
        let waiting = view(Screen::SignIn, Phase::Browser, &["Waiting"]);
        assert!(raises(None, &offer, false));
        assert!(raises(Some(&view(Screen::Install, Phase::Working, &[])), &offer, false));
        // A sign-in's lines while the browser is open: the person is typing there.
        assert!(!raises(Some(&offer), &waiting, false));
        assert!(!raises(Some(&waiting), &view(Screen::SignIn, Phase::Browser, &["Waiting", "Still waiting"]), false));
        // The menu's Sign in while the window shows it behind another app's: the person asked for it.
        assert!(raises(Some(&offer), &offer, true));
    }
}
