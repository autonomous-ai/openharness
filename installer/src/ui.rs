//! The window (spec §1.5): a status line, a progress bar, a detail box and up to two buttons, over a worker thread
//! that runs [flow::run] and posts each step. Plain Win32 with Common Controls v6 (from the manifest), so the
//! program stays one small file with nothing to install.

use std::cell::RefCell;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    COLOR_WINDOW, CreateFontIndirectW, DeleteObject, FW_SEMIBOLD, GetSysColor, GetSysColorBrush, HDC, HFONT,
    SetBkColor,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{
    ICC_PROGRESS_CLASS, INITCOMMONCONTROLSEX, InitCommonControlsEx, PBM_SETPOS, PBM_SETRANGE32,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, SetFocus};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, BS_DEFPUSHBUTTON, BS_PUSHBUTTON, CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW,
    DestroyWindow, DispatchMessageW, ES_AUTOVSCROLL, ES_MULTILINE, ES_READONLY, FindWindowW, GetMessageW, IDCANCEL,
    IsDialogMessageW, LoadCursorW, LoadIconW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MSG, MessageBoxW,
    NONCLIENTMETRICSW, PostMessageW, PostQuitMessage, RegisterClassExW, SPI_GETNONCLIENTMETRICS, SPI_GETWORKAREA,
    SW_HIDE, SW_RESTORE, SW_SHOW, SWP_NOACTIVATE, SWP_NOZORDER, SendMessageW, SetForegroundWindow,
    SetWindowPos, SetWindowTextW, ShowWindow, SystemParametersInfoW, TranslateMessage, WM_APP, WM_CLOSE,
    WM_COMMAND, WM_CTLCOLORSTATIC, WM_DESTROY, WM_DPICHANGED, WM_SETFONT, WNDCLASSEXW, WS_CAPTION, WS_CHILD,
    WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE, WS_VSCROLL, IDC_ARROW,
};

use crate::flow::{self, Finished, Outcome, Report};
use crate::model::{self, Source, Step};
use crate::windows::{Later, Log, Real, later_call, wide};

const CLASS: &str = "HarnessInstallWindow";
/// A static control's `&` is text, not an accelerator (WinUser.h; windows-sys keeps it in SystemServices).
const SS_NOPREFIX: u32 = 0x80;
const TITLE: &str = "Install Harness";
const WM_STEP: u32 = WM_APP + 1;
const WM_PROGRESS: u32 = WM_APP + 2;
const WM_DONE: u32 = WM_APP + 3;
/// Not 1 or 2: IsDialogMessageW sends IDOK and IDCANCEL for Enter and Esc.
const ID_PRIMARY: usize = 101;
const ID_SECONDARY: usize = 102;
/// The failure's read-only box. Its text can run past what fits (a URL, two hashes, the temp folder's three lines).
const DETAIL_STYLE: u32 = ES_MULTILINE as u32 | ES_READONLY as u32 | ES_AUTOVSCROLL as u32 | WS_VSCROLL;
const STEPS: [Step; 5] = [Step::Check, Step::Manifest, Step::Download, Step::Unpack, Step::Install];
/// The client area, in 96-DPI pixels.
const WIDTH: i32 = 460;
const HEIGHT: i32 = 200;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Working,
    /// Cancel was pressed: the window is hidden until the worker has removed its temp folder.
    Cancelling,
    Ended,
}

struct State {
    window: HWND,
    status: HWND,
    bar: HWND,
    detail: HWND,
    primary: HWND,
    secondary: HWND,
    fonts: [HFONT; 2],
    dpi: u32,
    phase: Phase,
    step: Step,
    cancel: Arc<AtomicBool>,
    finished: Arc<Mutex<Option<Finished>>>,
    log: Arc<Mutex<Log>>,
    manifest: Source,
    staging: bool,
    worker: Option<JoinHandle<()>>,
}

/// The exit code WM_DESTROY hands to the message loop. Outside [State]: DestroyWindow sends WM_DESTROY while the
/// procedure that called it still holds the state.
static EXIT: AtomicI32 = AtomicI32::new(model::EXIT_OK);

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// A message box for what goes wrong before the window exists.
pub fn say(text: &str) {
    let (text, title) = (wide(text), wide(TITLE));
    unsafe { MessageBoxW(null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR | MB_SETFOREGROUND) };
}

/// A second copy shows the first one's window instead of starting a second install.
pub fn bring_forward() {
    let class = wide(CLASS);
    let window = unsafe { FindWindowW(class.as_ptr(), null()) };
    if !window.is_null() {
        unsafe {
            ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
        }
    }
}

fn set_text(window: HWND, text: &str) {
    let text = wide(text);
    unsafe { SetWindowTextW(window, text.as_ptr()) };
}

fn scale(value: i32, dpi: u32) -> i32 {
    value * dpi as i32 / 96
}

// The per-monitor DPI calls arrived in Windows 10 1607 (later_call); before that the system DPI is the only one.
type ForDpiMetrics = unsafe extern "system" fn(u32, u32, *mut std::ffi::c_void, u32, u32) -> i32;
type ForDpiFrame = unsafe extern "system" fn(*mut RECT, u32, i32, u32, u32) -> i32;

/// The window's own DPI, else the system's, else 96.
fn dpi_of(window: HWND) -> u32 {
    let for_window = later_call("user32.dll", b"GetDpiForWindow\0").filter(|_| !window.is_null());
    let for_system = later_call("user32.dll", b"GetDpiForSystem\0");
    let dpi = unsafe {
        match (for_window, for_system) {
            (Some(call), _) => std::mem::transmute::<Later, unsafe extern "system" fn(HWND) -> u32>(call)(window),
            (None, Some(call)) => std::mem::transmute::<Later, unsafe extern "system" fn() -> u32>(call)(),
            (None, None) => 96,
        }
    };
    if dpi == 0 { 96 } else { dpi }
}

/// The outer size of a client area [WIDTH] by [HEIGHT] at [dpi].
fn frame(style: u32, dpi: u32) -> (i32, i32) {
    let mut rect = RECT { left: 0, top: 0, right: scale(WIDTH, dpi), bottom: scale(HEIGHT, dpi) };
    match later_call("user32.dll", b"AdjustWindowRectExForDpi\0") {
        Some(call) => unsafe { std::mem::transmute::<Later, ForDpiFrame>(call)(&mut rect, style, 0, 0, dpi) },
        None => unsafe { AdjustWindowRectEx(&mut rect, style, 0, 0) },
    };
    (rect.right - rect.left, rect.bottom - rect.top)
}

fn fonts(dpi: u32) -> [HFONT; 2] {
    let mut metrics: NONCLIENTMETRICSW = unsafe { std::mem::zeroed() };
    metrics.cbSize = std::mem::size_of::<NONCLIENTMETRICSW>() as u32;
    let out = &mut metrics as *mut NONCLIENTMETRICSW as *mut std::ffi::c_void;
    match later_call("user32.dll", b"SystemParametersInfoForDpi\0") {
        Some(call) => unsafe {
            std::mem::transmute::<Later, ForDpiMetrics>(call)(SPI_GETNONCLIENTMETRICS, metrics.cbSize, out, 0, dpi)
        },
        None => unsafe { SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, metrics.cbSize, out, 0) },
    };
    let body = metrics.lfMessageFont;
    let mut heading = body;
    heading.lfWeight = FW_SEMIBOLD as i32;
    unsafe { [CreateFontIndirectW(&body), CreateFontIndirectW(&heading)] }
}

fn layout(state: &State) {
    let at = |control: HWND, x: i32, y: i32, w: i32, h: i32| unsafe {
        SetWindowPos(
            control,
            null_mut(),
            scale(x, state.dpi),
            scale(y, state.dpi),
            scale(w, state.dpi),
            scale(h, state.dpi),
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    };
    at(state.status, 20, 18, WIDTH - 40, 24);
    at(state.bar, 20, 50, WIDTH - 40, 16);
    at(state.detail, 20, 50, WIDTH - 40, HEIGHT - 50 - 56);
    at(state.primary, WIDTH - 20 - 100, HEIGHT - 20 - 28, 100, 28);
    at(state.secondary, WIDTH - 20 - 100 - 10 - 100, HEIGHT - 20 - 28, 100, 28);
    for (control, font) in [
        (state.status, state.fonts[1]),
        (state.detail, state.fonts[0]),
        (state.primary, state.fonts[0]),
        (state.secondary, state.fonts[0]),
    ] {
        unsafe { SendMessageW(control, WM_SETFONT, font as WPARAM, 1) };
    }
}

fn show(control: HWND, visible: bool) {
    unsafe { ShowWindow(control, if visible { SW_SHOW } else { SW_HIDE }) };
}

/// The working face: the step, the bar, and Cancel (greyed while Harness.exe --install runs).
fn working(state: &State) {
    set_text(state.status, state.step.status());
    show(state.bar, true);
    show(state.detail, false);
    set_text(state.primary, "Cancel");
    show(state.primary, true);
    unsafe { EnableWindow(state.primary, (state.step != Step::Install) as i32) };
    show(state.secondary, false);
}

/// The end face, when there is something to read: a failure, or files left behind.
fn ended(state: &State, finished: &Finished) {
    let mut detail = Vec::new();
    let heading = match &finished.outcome {
        Outcome::Installed { version } => format!("Harness {version} is installed, and it is opening now."),
        Outcome::Failed { step, message } => {
            detail.push(format!("The step that failed: {}.", step.name()));
            detail.push(message.clone());
            "Harness could not be installed.".to_owned()
        }
        Outcome::Cancelled => "The install was cancelled.".to_owned(),
    };
    detail.extend(finished.lines().into_iter().skip(if matches!(finished.outcome, Outcome::Failed { .. }) { 2 } else { 1 }));
    set_text(state.status, &heading);
    show(state.bar, false);
    set_text(state.detail, &detail.join("\r\n"));
    show(state.detail, true);
    set_text(state.primary, "Close");
    unsafe { EnableWindow(state.primary, 1) };
    let failed = matches!(finished.outcome, Outcome::Failed { .. });
    set_text(state.secondary, "Try again");
    show(state.secondary, failed);
    unsafe { SetFocus(if failed { state.secondary } else { state.primary }) };
}

struct Posting {
    window: usize,
    cancel: Arc<AtomicBool>,
    log: Arc<Mutex<Log>>,
    shown: u32,
}

impl Report for Posting {
    fn step(&mut self, step: Step) {
        let index = STEPS.iter().position(|s| *s == step).unwrap_or(0);
        unsafe { PostMessageW(self.window as HWND, WM_STEP, index, 0) };
    }

    fn progress(&mut self, received: u64, total: u64) {
        let permille = (received.min(total) * 1000).checked_div(total).unwrap_or(0) as u32;
        if permille != self.shown {
            self.shown = permille;
            unsafe { PostMessageW(self.window as HWND, WM_PROGRESS, permille as WPARAM, 0) };
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn log(&mut self, line: &str) {
        if let Ok(mut log) = self.log.lock() {
            log.line(line);
        }
    }
}

fn start(state: &mut State) {
    state.cancel.store(false, Ordering::SeqCst);
    state.phase = Phase::Working;
    state.step = Step::Check;
    unsafe { SendMessageW(state.bar, PBM_SETPOS, 0, 0) };
    working(state);
    let mut report = Posting {
        window: state.window as usize,
        cancel: state.cancel.clone(),
        log: state.log.clone(),
        shown: 0,
    };
    let (finished, manifest, staging, window) =
        (state.finished.clone(), state.manifest.clone(), state.staging, state.window as usize);
    state.worker = Some(std::thread::spawn(move || {
        let done = flow::run(&mut Real, &mut report, &manifest, staging);
        *finished.lock().unwrap() = Some(done);
        unsafe { PostMessageW(window as HWND, WM_DONE, 0, 0) };
    }));
}

fn finish(state: &State, exit: i32) {
    EXIT.store(exit, Ordering::SeqCst);
    unsafe { DestroyWindow(state.window) };
}

/// Cancel, Esc and the close box. During Harness.exe --install they do nothing: it is not stopped halfway.
fn close(state: &mut State) {
    match state.phase {
        Phase::Working if state.step == Step::Install => {}
        Phase::Working => {
            state.phase = Phase::Cancelling;
            state.cancel.store(true, Ordering::SeqCst);
            show(state.window, false);
        }
        Phase::Cancelling => {}
        Phase::Ended => finish(state, EXIT.load(Ordering::SeqCst)),
    }
}

fn done(state: &mut State) {
    if let Some(worker) = state.worker.take() {
        let _ = worker.join();
    }
    let Some(finished) = state.finished.lock().unwrap().take() else { return };
    let exit = finished.exit_code();
    if state.phase == Phase::Cancelling {
        match flow::after_cancel(&finished.outcome) {
            Some(code) => return finish(state, code),
            // The Cancel came too late, and the install it could not stop failed: show why.
            None => show(state.window, true),
        }
    } else if finished.left.is_none() && !matches!(finished.outcome, Outcome::Failed { .. }) {
        // Installed (the app is opening) or cancelled: nothing more to read.
        return finish(state, exit);
    }
    state.phase = Phase::Ended;
    EXIT.store(exit, Ordering::SeqCst);
    ended(state, &finished);
}

unsafe extern "system" fn procedure(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_DESTROY {
        unsafe { PostQuitMessage(EXIT.load(Ordering::SeqCst)) };
        return 0;
    }
    // A message sent while the procedure already holds the state (a ShowWindow or SetWindowPos it called) gets
    // Windows' default handling.
    let handled = STATE.with(|cell| {
        let mut slot = cell.try_borrow_mut().ok()?;
        let state = slot.as_mut()?;
        match message {
            WM_STEP => {
                state.step = STEPS.get(wparam).copied().unwrap_or(Step::Check);
                if state.phase == Phase::Working {
                    working(state);
                }
                if matches!(state.step, Step::Unpack | Step::Install) {
                    unsafe { SendMessageW(state.bar, PBM_SETPOS, 1000, 0) };
                }
                Some(0)
            }
            WM_PROGRESS => {
                unsafe { SendMessageW(state.bar, PBM_SETPOS, wparam, 0) };
                Some(0)
            }
            WM_DONE => {
                done(state);
                Some(0)
            }
            WM_COMMAND => {
                match wparam & 0xffff {
                    ID_PRIMARY => close(state),
                    id if id == IDCANCEL as usize => close(state),
                    ID_SECONDARY if state.phase == Phase::Ended => start(state),
                    _ => {}
                }
                Some(0)
            }
            WM_CLOSE => {
                close(state);
                Some(0)
            }
            WM_CTLCOLORSTATIC => {
                // The read-only detail box and the labels on the window's own background.
                unsafe { SetBkColor(wparam as HDC, GetSysColor(COLOR_WINDOW) as COLORREF) };
                Some(unsafe { GetSysColorBrush(COLOR_WINDOW) } as LRESULT)
            }
            WM_DPICHANGED => {
                state.dpi = ((wparam >> 16) & 0xffff) as u32;
                let suggested = unsafe { &*(lparam as *const RECT) };
                unsafe {
                    SetWindowPos(
                        window,
                        null_mut(),
                        suggested.left,
                        suggested.top,
                        suggested.right - suggested.left,
                        suggested.bottom - suggested.top,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    )
                };
                let old = std::mem::replace(&mut state.fonts, fonts(state.dpi));
                layout(state);
                for font in old {
                    unsafe { DeleteObject(font) };
                }
                Some(0)
            }
            _ => None,
        }
    });
    match handled {
        Some(result) => result,
        None => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

fn child(parent: HWND, class: &str, text: &str, style: u32, id: usize) -> HWND {
    let (class, text) = (wide(class), wide(text));
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            text.as_ptr(),
            WS_CHILD | style,
            0,
            0,
            0,
            0,
            parent,
            id as _,
            GetModuleHandleW(null()),
            null(),
        )
    }
}

pub fn run(log: Log, manifest: Source, staging: bool) -> i32 {
    let controls = INITCOMMONCONTROLSEX {
        dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
        dwICC: ICC_PROGRESS_CLASS,
    };
    unsafe { InitCommonControlsEx(&controls) };
    let instance = unsafe { GetModuleHandleW(null()) };
    let class = wide(CLASS);
    let icon = unsafe { LoadIconW(instance, 1 as _) };
    let registered = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(procedure),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: icon,
        hCursor: unsafe { LoadCursorW(null_mut(), IDC_ARROW) },
        hbrBackground: unsafe { GetSysColorBrush(COLOR_WINDOW) },
        lpszMenuName: null(),
        lpszClassName: class.as_ptr(),
        hIconSm: icon,
    };
    unsafe { RegisterClassExW(&registered) };

    let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    let mut area = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let centred = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut area as *mut RECT as *mut _, 0) } != 0;
    let place = |dpi: u32| {
        let (width, height) = frame(style, dpi);
        let (x, y) = if centred {
            (area.left + (area.right - area.left - width) / 2, area.top + (area.bottom - area.top - height) / 2)
        } else {
            (CW_USEDEFAULT, CW_USEDEFAULT)
        };
        (x, y, width, height)
    };
    let (x, y, width, height) = place(dpi_of(null_mut()));
    let title = wide(TITLE);
    let window = unsafe {
        CreateWindowExW(0, class.as_ptr(), title.as_ptr(), style, x, y, width, height, null_mut(), null_mut(), instance, null())
    };
    if window.is_null() {
        say("Harness could not open its installer window.");
        return model::EXIT_FAILED;
    }
    // The monitor's DPI now, which is not the system's when its scale changed since sign-in.
    let dpi = dpi_of(window);
    let (x, y, width, height) = place(dpi);
    unsafe { SetWindowPos(window, null_mut(), x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE) };
    // SS_NOPREFIX: a path with '&' (a profile folder) is text, not an accelerator.
    let state = State {
        window,
        status: child(window, "STATIC", "", WS_VISIBLE | SS_NOPREFIX, 0),
        bar: child(window, "msctls_progress32", "", WS_VISIBLE, 0),
        detail: child(window, "EDIT", "", DETAIL_STYLE, 0),
        primary: child(window, "BUTTON", "Cancel", WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON as u32, ID_PRIMARY),
        secondary: child(window, "BUTTON", "Try again", WS_TABSTOP | BS_PUSHBUTTON as u32, ID_SECONDARY),
        fonts: fonts(dpi),
        dpi,
        phase: Phase::Working,
        step: Step::Check,
        cancel: Arc::new(AtomicBool::new(false)),
        finished: Arc::new(Mutex::new(None)),
        log: Arc::new(Mutex::new(log)),
        manifest,
        staging,
        worker: None,
    };
    unsafe { SendMessageW(state.bar, PBM_SETRANGE32, 0, 1000) };
    layout(&state);
    STATE.with(|cell| *cell.borrow_mut() = Some(state));
    STATE.with(|cell| start(cell.borrow_mut().as_mut().unwrap()));
    unsafe {
        ShowWindow(window, SW_SHOW);
        SetForegroundWindow(window);
    }

    let mut message: MSG = unsafe { std::mem::zeroed() };
    while unsafe { GetMessageW(&mut message, null_mut(), 0, 0) } > 0 {
        if unsafe { IsDialogMessageW(window, &message) } == 0 {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
    STATE.with(|cell| {
        if let Some(mut state) = cell.borrow_mut().take() {
            if let Some(worker) = state.worker.take() {
                let _ = worker.join();
            }
            for font in state.fonts {
                unsafe { DeleteObject(font) };
            }
        }
    });
    message.wParam as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_failure_can_be_scrolled_and_copied() {
        assert_eq!(DETAIL_STYLE & WS_VSCROLL, WS_VSCROLL);
        assert_eq!(DETAIL_STYLE & ES_READONLY as u32, ES_READONLY as u32);
    }
}
