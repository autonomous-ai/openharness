//! The binary: the tray, the window and the timer. Every rule they follow is in the library, under `cargo test`.

use harness_device::app::App;
use harness_device::cli::cli_override;
use harness_device::desktop::{DesktopApp, SystemDesktopApp, run_open};
use harness_device::install::{Shell, system_shell};
use harness_device::log::FileLog;
use harness_device::loginitem::SystemLoginItem;
use harness_device::runner::{Doors, Runner};
use harness_device::state::{JsonStateFile, StateFile};
use harness_device::types::{Action, Clock, Effect, Event, Log, MenuAction, MenuItem, SystemClock, View};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem as NativeItem, PredefinedMenuItem};
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

/// An action that is not one of the six never gets here: its JSON does not parse.
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
        .expect("Harness Device could not start");
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
        open: Arc::new(run_open),
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
        .tooltip("Harness Device")
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

    let ticking = handle.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(TICK);
            let events = events.clone();
            // AppKit's running applications are read on the main thread.
            let sent = ticking.run_on_main_thread(move || {
                let desktop_running = SystemDesktopApp.running();
                let _ = events.send(Event::Tick { now: SystemClock.now(), desktop_running });
            });
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
    let run = |effects: Vec<Effect>| {
        for effect in effects {
            // Menu, Show and Quit are AppKit's, on the main thread, which runs them in the order they are handed over.
            if let Some(effect) = runner.run(effect) {
                let (drawing, log) = (handle.clone(), log.clone());
                let _ = handle.run_on_main_thread(move || {
                    if let Err(error) = draw(&drawing, effect) {
                        log.line(&format!("menu or window: {error}"));
                    }
                });
            }
        }
    };
    run(first);
    for event in queue {
        run(app.handle(event));
    }
}

/// On the main thread.
fn draw(handle: &AppHandle, effect: Effect) -> tauri::Result<()> {
    match effect {
        Effect::Menu(items) => {
            if let Some(tray) = handle.tray_by_id(TRAY) {
                tray.set_menu(Some(native_menu(handle, &items)?))?;
            }
        }
        Effect::Show(view) => {
            *handle.state::<Shared>().view.lock().unwrap() = view.clone();
            let Some(window) = handle.get_webview_window(WINDOW) else { return Ok(()) };
            window.emit("view", &view)?;
            if view.is_some() {
                window.show()?;
                window.set_focus()?;
            } else {
                window.hide()?;
            }
        }
        // The daemon is left running: the app only ever watched it.
        Effect::Quit => handle.exit(0),
        _ => {}
    }
    Ok(())
}

fn native_menu(handle: &AppHandle, items: &[MenuItem]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(handle)?;
    for item in items {
        match item {
            MenuItem::Text(text) => menu.append(&NativeItem::new(handle, text, false, None::<&str>)?)?,
            MenuItem::Action(action, text) => {
                menu.append(&NativeItem::with_id(handle, menu_id(*action), text, true, None::<&str>)?)?
            }
            MenuItem::Separator => menu.append(&PredefinedMenuItem::separator(handle)?)?,
        }
    }
    Ok(menu)
}

/// A menu item's id is its action's name.
fn menu_id(action: MenuAction) -> &'static str {
    match action {
        MenuAction::Install => "install",
        MenuAction::SignIn => "sign_in",
        MenuAction::ClaudeOn => "claude_on",
        MenuAction::ClaudeOff => "claude_off",
        MenuAction::OpenHarness => "open_harness",
        MenuAction::Quit => "quit",
    }
}

fn menu_action(id: &str) -> Option<MenuAction> {
    use MenuAction::*;
    [Install, SignIn, ClaudeOn, ClaudeOff, OpenHarness, Quit].into_iter().find(|action| menu_id(*action) == id)
}
