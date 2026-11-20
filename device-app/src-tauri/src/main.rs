#![cfg_attr(windows, windows_subsystem = "windows")]
//! The binary: the tray, the window and the timer. Every rule they follow is in the library, under `cargo test`.

use harness_device::app::App;
use harness_device::cli::cli_override;
use harness_device::desktop::{DesktopApp, SystemDesktopApp};
use harness_device::follow;
use harness_device::front;
use harness_device::install::system_shell;
use harness_device::instance::Instance;
use harness_device::log::FileLog;
use harness_device::loginitem::SystemLoginItem;
use harness_device::open;
use harness_device::runner::{Doors, Runner};
use harness_device::state::{JsonStateFile, StateFile};
use harness_device::tabs;
use harness_device::tick;
use harness_device::tray::{TrayIcon, tray_icon};
use harness_device::types::{Action, Clock, Effect, Event, Log, MenuAction, MenuItem, SystemClock, View};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::image::Image;
#[cfg(not(target_os = "macos"))]
use tauri::menu::AboutMetadata;
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
    /// Off macOS, this copy's lock: let go before a relaunch, so the new copy never finds it held.
    instance: Mutex<Option<Instance>>,
    /// The menu last drawn, with the About credits it has: off macOS, new credits draw it again.
    menu: Mutex<Drawn>,
}

#[derive(Default)]
struct Drawn {
    items: Vec<MenuItem>,
    credits: Option<String>,
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
        .manage(Shared {
            view: Mutex::default(),
            events: events.clone(),
            instance: Mutex::default(),
            menu: Mutex::default(),
        })
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
    // macOS runs one copy of a bundle by itself. Elsewhere a second launch leaves before its tray or watch, and a lock
    // that cannot be made costs one log line, never the app.
    #[cfg(not(target_os = "macos"))]
    match harness_device::instance::acquire(&paths.app_data_dir()?) {
        Ok(Some(instance)) => *handle.state::<Shared>().instance.lock().unwrap() = Some(instance),
        Ok(None) => {
            log.line("instance: already running");
            std::process::exit(0);
        }
        Err(error) => log.line(&format!("instance: no lock ({})", error.kind())),
    }
    let state = Arc::new(JsonStateFile::new(paths.app_data_dir()?, log.clone()));
    let saved = state.load();
    let doors = Doors {
        home: paths.home_dir()?,
        path_var: std::env::var_os("PATH"),
        cli_override: cli_override(cfg!(debug_assertions), std::env::var_os("HARNESS_DEVICE_CLI")),
        shell: Arc::new(system_shell(paths.app_data_dir()?)),
        login_item: Arc::new(SystemLoginItem),
        state,
        log: log.clone(),
        open: open::system(log.clone()),
        front: front::system(log.clone()),
        tabs: tabs::system(),
        updater: harness_device::update::system(handle),
        follow: follow::system(paths.home_dir()?),
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

    // Followed before it is read, so a change in between is told, not lost. Its first notice reaches the main thread
    // after this setup, once the tray is built. A taskbar that cannot be followed is taken as dark, as one with no
    // value is.
    #[cfg(windows)]
    let light_panel = {
        use harness_device::theme_windows::{PERSONALIZE, follow};
        let (setting, told) = (handle.clone(), log.clone());
        let light = follow(PERSONALIZE, move |light| {
            let (handle, log) = (setting.clone(), told.clone());
            let _ = setting.run_on_main_thread(move || {
                if let Some(tray) = handle.tray_by_id(TRAY)
                    && let Err(error) = tray.set_icon(Some(tray_image(tray_icon("windows", light))))
                {
                    log.line(&format!("tray: {error}"));
                }
            });
        });
        light.unwrap_or_else(|| {
            log.line("tray: theme not followed");
            false
        })
    };
    #[cfg(not(windows))]
    let light_panel = false;
    let icon = tray_icon(std::env::consts::OS, light_panel);
    let (clicks, chosen) = (events.clone(), events.clone());
    TrayIconBuilder::with_id(TRAY)
        .icon(tray_image(icon))
        .icon_as_template(icon == TrayIcon::Template)
        .tooltip("Harness")
        .on_menu_event(move |_, event| {
            if let Some(action) = menu_action(event.id().as_ref()) {
                let _ = chosen.send(Event::Menu(action));
            }
        })
        // Down only: one click is one MenuOpened. Tray events arrive on the main thread, where AppKit is read.
        .on_tray_icon_event(move |_, event| {
            if let TrayIconEvent::Click { button_state: MouseButtonState::Down, .. } = event {
                let _ = clicks.send(tick::menu_opened(SystemClock.now(), SystemDesktopApp.installed()));
            }
        })
        .build(handle)?;
    // A desktop with no tray host shows no icon and gives no error: the log says so, once, when none has come within
    // the wait. Off the main thread, where a bus that is slow to answer would hold the tray.
    #[cfg(target_os = "linux")]
    {
        let log = log.clone();
        thread::spawn(move || {
            use harness_device::tray_host::{host_there, log_line};
            if let Some(line) = log_line(host_there()) {
                log.line(line);
            }
        });
    }
    // The app-list entry, off the main thread too: a slow or failing disk neither holds nor fails the launch.
    #[cfg(target_os = "linux")]
    {
        let log = log.clone();
        thread::spawn(move || {
            if let Some(line) = harness_device::app_list::system() {
                log.line(&line);
            }
        });
    }

    let (app, first) = App::new(
        saved,
        runner.find_cli(),
        SystemDesktopApp.installed(),
        clock.now(),
        harness_device::update::install_exits_app(),
    );
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
                for event in ticked() {
                    let _ = events.send(event);
                }
            });
            // Elsewhere it is a scan of every process: here, never on the main thread, where it would hold the tray.
            #[cfg(not(target_os = "macos"))]
            let sent = ticked().into_iter().try_for_each(|event| events.send(event));
            if sent.is_err() {
                return;
            }
        }
    });
    Ok(())
}

fn tray_image(icon: TrayIcon) -> Image<'static> {
    match icon {
        TrayIcon::Template => tauri::include_image!("icons/tray.png"),
        TrayIcon::Dark => tauri::include_image!("icons/tray-dark.png"),
        TrayIcon::Light => tauri::include_image!("icons/tray-light.png"),
    }
}

/// What the timer tells now: the desktop app running, and on Linux what a click on the icon would tell.
fn ticked() -> Vec<Event> {
    tick::tick(std::env::consts::OS, SystemClock.now(), SystemDesktopApp.running(), &|| SystemDesktopApp.installed())
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
            // Menu, Show, ShowAbout, AboutCredits, Quit and Relaunch are the OS's UI (AppKit, Win32, GTK), on the main
            // thread, which runs them in the order they are handed over.
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
        Effect::Menu(items) => draw_menu(handle, |drawn| drawn.items = items)?,
        // macOS's panel takes its credits when it opens.
        #[cfg(not(target_os = "macos"))]
        Effect::AboutCredits(credits) => draw_menu(handle, |drawn| drawn.credits = credits)?,
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
        // Elsewhere About is the menu's own item, which opens its dialog without a menu event.
        #[cfg(target_os = "macos")]
        Effect::ShowAbout(credits) => show_about(credits.as_deref()),
        // The daemon is left running: the app only ever watched it.
        Effect::Quit => handle.exit(0),
        // Tauri starts the new copy before this one exits.
        Effect::Relaunch => {
            drop(handle.state::<Shared>().instance.lock().unwrap().take());
            handle.restart()
        }
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

/// Whether showing `next` after `last` raises the window and takes the keyboard: a new screen, or one the menu asked
/// for, which may be behind another app's windows. A phase or its lines only redraw, so a sign-in's `Waiting` never
/// takes the keyboard from the browser.
fn raises(last: Option<&View>, next: &View, asked: bool) -> bool {
    asked || last.map(|view| view.screen) != Some(next.screen)
}

/// Draws the tray menu again once `change` is made to what it is drawn from.
fn draw_menu(handle: &AppHandle, change: impl FnOnce(&mut Drawn)) -> tauri::Result<()> {
    let shared = handle.state::<Shared>();
    let mut drawn = shared.menu.lock().unwrap();
    change(&mut drawn);
    if let Some(tray) = handle.tray_by_id(TRAY) {
        let menu = Menu::new(handle)?;
        for item in &drawn.items {
            menu.append(native_item(handle, item, drawn.credits.as_deref())?.as_ref())?;
        }
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

/// A submenu's items are drawn by the rules the top level uses.
fn native_item(
    handle: &AppHandle,
    item: &MenuItem,
    credits: Option<&str>,
) -> tauri::Result<Box<dyn IsMenuItem<tauri::Wry>>> {
    Ok(match item {
        MenuItem::Text(text) => Box::new(NativeItem::new(handle, text, false, None::<&str>)?),
        MenuItem::Action(MenuAction::About, text) => about_item(handle, text, credits)?,
        MenuItem::Action(action, text) => {
            Box::new(NativeItem::with_id(handle, menu_id(*action), text, true, None::<&str>)?)
        }
        MenuItem::Check(action, text, checked) => {
            Box::new(CheckMenuItem::with_id(handle, menu_id(*action), text, true, *checked, None::<&str>)?)
        }
        MenuItem::Submenu(text, items) => {
            let submenu = Submenu::new(handle, text, true)?;
            for item in items {
                submenu.append(native_item(handle, item, credits)?.as_ref())?;
            }
            Box::new(submenu)
        }
        MenuItem::Separator => Box::new(PredefinedMenuItem::separator(handle)?),
    })
}

/// macOS's About is a plain item: its click reaches the app, which opens the panel in front with the credits then.
#[cfg(target_os = "macos")]
fn about_item(
    handle: &AppHandle,
    text: &str,
    _credits: Option<&str>,
) -> tauri::Result<Box<dyn IsMenuItem<tauri::Wry>>> {
    Ok(Box::new(NativeItem::with_id(handle, menu_id(MenuAction::About), text, true, None::<&str>)?))
}

/// Elsewhere it is muda's own About, the one way to its dialog: the name, the version, and the credits line under
/// them as its comments, the one field it shows on both Windows and Linux.
#[cfg(not(target_os = "macos"))]
fn about_item(handle: &AppHandle, text: &str, credits: Option<&str>) -> tauri::Result<Box<dyn IsMenuItem<tauri::Wry>>> {
    let metadata = AboutMetadata {
        name: Some("Harness".into()),
        version: Some(handle.package_info().version.to_string()),
        comments: credits.map(Into::into),
        // GTK shows it as the dialog's logo, at its own size, as large as its stock one. Windows' dialog is a message
        // box with the system's information icon and takes none.
        #[cfg(target_os = "linux")]
        icon: Some(tauri::include_image!("icons/128x128.png")),
        ..Default::default()
    };
    Ok(Box::new(PredefinedMenuItem::about(handle, Some(text), Some(metadata))?))
}

/// A menu item's id is its action's name.
fn menu_id(action: MenuAction) -> &'static str {
    match action {
        MenuAction::Install => "install",
        MenuAction::SignIn => "sign_in",
        MenuAction::SoundOn => "sound_on",
        MenuAction::SoundOff => "sound_off",
        MenuAction::NotifyFull => "notify_full",
        MenuAction::NotifyYou => "notify_you",
        MenuAction::Update => "update",
        MenuAction::OpenHarness => "open_harness",
        MenuAction::About => "about",
        MenuAction::Quit => "quit",
        MenuAction::ExportLogs => "export_logs",
        MenuAction::FollowChatgpt => "follow_chatgpt",
        MenuAction::FollowSettings => "follow_settings",
    }
}

fn menu_action(id: &str) -> Option<MenuAction> {
    use MenuAction::*;
    [
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
        ExportLogs,
        FollowChatgpt,
        FollowSettings,
    ]
    .into_iter()
    .find(|action| menu_id(*action) == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_device::types::{Phase, Screen};

    fn view(screen: Screen, phase: Phase, lines: &[&str]) -> View {
        View { screen, phase, lines: lines.iter().map(|line| line.to_string()).collect() }
    }

    #[test]
    fn every_menu_action_has_its_own_id() {
        use MenuAction::*;
        let actions = [
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
            ExportLogs,
            FollowChatgpt,
            FollowSettings,
        ];
        for action in actions {
            assert_eq!(menu_action(menu_id(action)), Some(action));
        }
        let ids: std::collections::HashSet<_> = actions.into_iter().map(menu_id).collect();
        assert_eq!(ids.len(), 13);
        assert_eq!(menu_id(About), "about");
        assert_eq!(menu_id(ExportLogs), "export_logs");
        assert_eq!(menu_id(NotifyFull), "notify_full");
        assert_eq!(menu_id(NotifyYou), "notify_you");
        assert_eq!(menu_id(FollowChatgpt), "follow_chatgpt");
        assert_eq!(menu_id(FollowSettings), "follow_settings");
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
