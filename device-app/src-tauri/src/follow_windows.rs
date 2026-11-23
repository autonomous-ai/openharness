//! The ChatGPT follow on Windows: a win-event hook hears each foreground change, and another, for the ChatGPT process
//! in front only, its name changes. The window's title is its native text (`GetWindowTextW`). The app is installed
//! when its package family is registered for the person (`GetPackagesByPackageFamily`).

use regex::Regex;
use std::sync::LazyLock;
#[cfg(windows)]
use {
    crate::follow::{ChatgptWindow, Heard, TITLE_MAX},
    std::cell::{Cell, OnceCell},
    std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    std::panic::{self, AssertUnwindSafe},
    std::ptr,
    std::sync::Arc,
    std::sync::mpsc,
    std::thread::{self, JoinHandle},
    windows_sys::Win32::Foundation::HWND,
    windows_sys::Win32::Storage::Packaging::Appx::GetPackagesByPackageFamily,
    windows_sys::Win32::System::Threading::{
        GetCurrentThreadId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    },
    windows_sys::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent},
    windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, EVENT_SYSTEM_FOREGROUND, GetForegroundWindow, GetMessageW, GetWindowTextW,
        GetWindowThreadProcessId, MSG, PM_NOREMOVE, PeekMessageW, PostQuitMessage, PostThreadMessageW,
        WINEVENT_OUTOFCONTEXT, WM_QUIT, WM_USER,
    },
};

// Windows' own numbers, here so the rules below run on every OS.
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
const EVENT_OBJECT_NAMECHANGE: u32 = 0x800C;
const OBJID_WINDOW: i32 = 0;
const CHILDID_SELF: i32 = 0;

/// The hook's `CHATGPT_APP` rule (`cli/hook/notify.mjs`): the ChatGPT app's program in its Store package's folder,
/// `<WindowsApps>\OpenAI.Codex_<version>_<arch>__<publisher>\app\ChatGPT.exe`. Its beta is another package
/// (`OpenAI.CodexBeta_`).
static CHATGPT_APP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\(?:[^\\]+\\)*ChatGPT\.exe$").unwrap());

/// Whether a process's image path is the ChatGPT app's program, without case: another program named `ChatGPT.exe`
/// is not followed.
pub fn is_chatgpt_image(path: &str) -> bool {
    CHATGPT_APP.is_match(path)
}

/// Whether `GetPackagesByPackageFamily`, given no room, found a package of the family: it counts them and asks for
/// room. Success means it found none.
pub fn family_found(status: u32, count: u32) -> bool {
    status == ERROR_INSUFFICIENT_BUFFER && count > 0
}

/// What the observer does when the window in front changed.
#[derive(Debug, PartialEq, Eq)]
pub enum Moved {
    /// Hear the name changes of process `pid` alone, and tell the window's title: a ChatGPT process not heard came to
    /// the front.
    Rehook(u32),
    /// Tell the window's title: a window of the process heard.
    Keep,
    /// Hear no name change, and tell the empty title: another app's window, or none.
    Unhook,
}

/// `hooked` is the process whose name changes the observer hears, `front` the process of the window in front (None
/// with no window). The window in front is checked at each change, as X11's active window is: as the observation
/// starts it may be none or another app's for a moment, and another ChatGPT process may come to the front.
pub fn foreground_moved(hooked: Option<u32>, front: Option<u32>, chatgpt: &dyn Fn(u32) -> bool) -> Moved {
    match front.filter(|&pid| chatgpt(pid)) {
        None => Moved::Unhook,
        Some(pid) if hooked == Some(pid) => Moved::Keep,
        Some(pid) => Moved::Rehook(pid),
    }
}

/// Whether an event changes the thread's title: the window in front's own name changed. A window behind, and another
/// object's name (a caret, a menu, a control of the page), are not the thread's; a foreground change is
/// `foreground_moved`'s.
pub fn reads_title(event: u32, hwnd: usize, id_object: i32, id_child: i32, foreground: usize) -> bool {
    event == EVENT_OBJECT_NAMECHANGE && hwnd == foreground && id_object == OBJID_WINDOW && id_child == CHILDID_SELF
}

/// The Windows door's window. Windows gates no read of a window's title: the person's switch stands for the
/// permission (`follow::Switched`).
pub struct WindowsFollow;

#[cfg(windows)]
impl ChatgptWindow for WindowsFollow {
    fn installed(&self) -> bool {
        registered(CHATGPT_FAMILY)
    }

    /// Always an observation: its thread checks the window in front at each change, and one not the ChatGPT app's is
    /// no title.
    fn observe(&self, heard: Box<dyn Fn(Heard) + Send + Sync>) -> Option<Box<dyn Send>> {
        Some(observe_with(|pid| image(pid).is_some_and(|path| is_chatgpt_image(&path)), heard))
    }
}

/// The ChatGPT app's Store package family.
#[cfg(windows)]
const CHATGPT_FAMILY: &str = "OpenAI.Codex_2p2nqsd0c76g0";

/// Whether a package of `family` is registered for the person: no PowerShell.
#[cfg(windows)]
fn registered(family: &str) -> bool {
    let family: Vec<u16> = family.encode_utf16().chain([0]).collect();
    let (mut count, mut length) = (0u32, 0u32);
    // SAFETY: a NUL-terminated name; given no room, Windows writes only the two counts.
    let status = unsafe {
        GetPackagesByPackageFamily(family.as_ptr(), &mut count, ptr::null_mut(), &mut length, ptr::null_mut())
    };
    family_found(status, count)
}

/// An observation: dropped, it tells its thread to quit and returns at once.
#[cfg(windows)]
struct Observation {
    thread: u32,
    /// Held open, so Windows gives the id to no other thread once this one has ended: the stop would quit that one.
    _handle: JoinHandle<()>,
}

#[cfg(windows)]
impl Drop for Observation {
    fn drop(&mut self) {
        // SAFETY: takes no pointer. A thread that has ended refuses it.
        unsafe { PostThreadMessageW(self.thread, WM_QUIT, 0, 0) };
    }
}

/// Observes on a thread of its own the window in front while its process passes `check`, until the handle is
/// dropped.
#[cfg(windows)]
fn observe_with(
    check: impl Fn(u32) -> bool + Send + 'static,
    heard: Box<dyn Fn(Heard) + Send + Sync>,
) -> Box<dyn Send> {
    let heard: Arc<dyn Fn(Heard) + Send + Sync> = Arc::from(heard);
    let told = Arc::clone(&heard);
    let (give, given) = mpsc::sync_channel(1);
    let spawned = thread::Builder::new().name("chatgpt-observer".into()).spawn(move || {
        // A thread has a message queue only once it asks for one (PostThreadMessageW's own advice): made before the
        // id is given, so a stop posted at once is not lost.
        // SAFETY: MSG is plain data; all zeros is a valid value for PeekMessageW to fill.
        let mut message: MSG = unsafe { std::mem::zeroed() };
        // SAFETY: `message` is writable; nothing is removed.
        unsafe { PeekMessageW(&mut message, ptr::null_mut(), WM_USER, WM_USER, PM_NOREMOVE) };
        // SAFETY: takes no argument.
        let _ = give.send(unsafe { GetCurrentThreadId() });
        observe_here(Box::new(check), told);
    });
    match spawned.map(|handle| (handle, given.recv())) {
        Ok((handle, Ok(thread))) => Box::new(Observation { thread, _handle: handle }),
        // No thread to observe on: told as an observer not made, where a panic would end the runner's follow thread
        // without a word.
        _ => {
            heard(Heard::NoObserver);
            Box::new(())
        }
    }
}

#[cfg(windows)]
thread_local! {
    /// The observation on this thread: a hook takes no context, and an out-of-context hook is called on the thread
    /// that set it.
    static HERE: OnceCell<Here> = const { OnceCell::new() };
}

/// An observation, on its thread.
#[cfg(windows)]
struct Here {
    /// Whether a process is the ChatGPT app's.
    check: Box<dyn Fn(u32) -> bool>,
    heard: Arc<dyn Fn(Heard) + Send + Sync>,
    /// The process whose name changes are heard, and that hook.
    names: Cell<Option<(u32, HWINEVENTHOOK)>>,
    /// Whether this observation has ended: an event queued before its loop quits tells nothing.
    ended: Cell<bool>,
}

#[cfg(windows)]
impl Here {
    fn new(check: Box<dyn Fn(u32) -> bool>, heard: Arc<dyn Fn(Heard) + Send + Sync>) -> Here {
        Here { check, heard, names: Cell::new(None), ended: Cell::new(false) }
    }

    /// The observation began, or the window in front changed: the ChatGPT process in front is heard, and its
    /// window's title told; another app's window, or none, is the empty title.
    fn front_moved(&self) {
        // SAFETY: takes no argument.
        let front = unsafe { GetForegroundWindow() };
        match foreground_moved(self.names.get().map(|(pid, _)| pid), owner(front), &*self.check) {
            Moved::Keep => (self.heard)(Heard::Title(title(front))),
            Moved::Unhook => {
                self.unhook();
                (self.heard)(Heard::Title(None));
            }
            Moved::Rehook(pid) => {
                self.unhook();
                let names = hook(EVENT_OBJECT_NAMECHANGE, pid);
                if names.is_null() {
                    self.end();
                    return;
                }
                self.names.set(Some((pid, names)));
                // Read after the hook is set: a change before it waits in the queue and is not missed.
                (self.heard)(Heard::Title(title(front)));
            }
        }
    }

    /// Hears no process's name changes.
    fn unhook(&self) {
        if let Some((_, hook)) = self.names.take() {
            // SAFETY: set by this thread; taken out of `names`, so unhooked once.
            unsafe { UnhookWinEvent(hook) };
        }
    }

    /// Does a hook's work. A panic cannot unwind into Windows, which would end the app: it ends this observation
    /// instead.
    fn guarded(&self, work: impl FnOnce()) {
        if !self.ended.get() && panic::catch_unwind(AssertUnwindSafe(work)).is_err() {
            self.end();
        }
    }

    /// Ends this observation, once, with its word: nothing follows until the next start.
    fn end(&self) {
        if self.ended.replace(true) {
            return;
        }
        // The word goes where the panic may have come from (a poisoned lock): it cannot unwind into Windows either.
        let _ = panic::catch_unwind(AssertUnwindSafe(|| (self.heard)(Heard::NoObserver)));
        // SAFETY: takes no pointer; ends this thread's message loop.
        unsafe { PostQuitMessage(0) };
    }
}

/// Hooks `event` for process `pid` (0: every process), out of context: `changed` is called on this thread, inside its
/// message loop. Null when Windows refuses.
#[cfg(windows)]
fn hook(event: u32, pid: u32) -> HWINEVENTHOOK {
    // SAFETY: no module (the procedure is in this process), and `changed` lives as long as the process.
    unsafe { SetWinEventHook(event, event, ptr::null_mut(), Some(changed), pid, 0, WINEVENT_OUTOFCONTEXT) }
}

/// On the observer's thread: the title of the window in front now, then at each change, until the thread is told to
/// quit.
#[cfg(windows)]
fn observe_here(check: Box<dyn Fn(u32) -> bool>, heard: Arc<dyn Fn(Heard) + Send + Sync>) {
    // Every process's: the window in front is checked again at each change.
    let foreground = hook(EVENT_SYSTEM_FOREGROUND, 0);
    if foreground.is_null() {
        heard(Heard::NoObserver);
        return;
    }
    HERE.with(|cell| {
        let here = cell.get_or_init(|| Here::new(check, heard));
        // Read after the hook is set: a change before it waits in the queue and is not missed.
        here.guarded(|| here.front_moved());
    });
    run_messages();
    HERE.with(|cell| {
        if let Some(here) = cell.get() {
            here.unhook();
        }
    });
    // SAFETY: set by this thread, and unhooked once.
    unsafe { UnhookWinEvent(foreground) };
}

/// This thread's message loop, inside which the hooks are called, until it is told to quit.
#[cfg(windows)]
fn run_messages() {
    // SAFETY: MSG is plain data; all zeros is a valid value for GetMessageW to fill.
    let mut message: MSG = unsafe { std::mem::zeroed() };
    // SAFETY: `message` is writable for the call; the null window takes every message of this thread.
    while unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } > 0 {
        // SAFETY: `message` was filled by GetMessageW.
        unsafe { DispatchMessageW(&message) };
    }
}

/// A hooked event, on the observer's thread.
#[cfg(windows)]
unsafe extern "system" fn changed(
    _: HWINEVENTHOOK,
    event: u32,
    window: HWND,
    id_object: i32,
    id_child: i32,
    _: u32,
    _: u32,
) {
    HERE.with(|cell| {
        let Some(here) = cell.get() else { return };
        here.guarded(|| match event {
            EVENT_SYSTEM_FOREGROUND => here.front_moved(),
            _ => {
                // SAFETY: takes no argument.
                let foreground = unsafe { GetForegroundWindow() };
                if reads_title(event, window as usize, id_object, id_child, foreground as usize) {
                    (here.heard)(Heard::Title(title(window)));
                }
            }
        });
    });
}

/// The process that owns `window`; None with no window, or one that has gone.
#[cfg(windows)]
fn owner(window: HWND) -> Option<u32> {
    if window.is_null() {
        return None;
    }
    let mut pid = 0u32;
    // SAFETY: `pid` is writable; a window that has gone answers 0.
    unsafe { GetWindowThreadProcessId(window, &mut pid) };
    (pid != 0).then_some(pid)
}

/// The longest path Windows has, in UTF-16 units.
#[cfg(windows)]
const IMAGE_MAX: usize = 32_768;

/// The image path of process `pid`; None for a process this user may not open (a protected one, or another
/// account's).
#[cfg(windows)]
fn image(pid: u32) -> Option<String> {
    // SAFETY: no handle is inherited; a null answer is checked before it is owned.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    // SAFETY: an open handle this function alone holds; it closes on drop.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let mut image = vec![0u16; IMAGE_MAX];
    let mut size = IMAGE_MAX as u32;
    // SAFETY: `image` holds `size` units; `size` is set to the units written.
    let read = unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), PROCESS_NAME_WIN32, image.as_mut_ptr(), &mut size)
    };
    (read != 0).then(|| String::from_utf16_lossy(&image[..size as usize]))
}

/// Room for one unit past TITLE_MAX and the NUL. A longer title, cut there, is still past TITLE_MAX, which the rules
/// send as the empty title: no title is read whole for nothing, and no length is asked first.
#[cfg(windows)]
const TITLE_ROOM: usize = TITLE_MAX + 2;

/// A window's title. For another process's window it is the text Windows keeps: no message is sent, so a busy app
/// never holds the observer.
#[cfg(windows)]
fn title(window: HWND) -> Option<String> {
    if window.is_null() {
        return None;
    }
    let mut text = [0u16; TITLE_ROOM];
    // SAFETY: `text` holds TITLE_ROOM units, which bounds what Windows writes, the NUL included.
    let length = unsafe { GetWindowTextW(window, text.as_mut_ptr(), TITLE_ROOM as i32) };
    Some(String::from_utf16_lossy(&text[..usize::try_from(length).unwrap_or(0)]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::{sync::mpsc::RecvTimeoutError, time::Duration};

    /// The ChatGPT app's Store package folder, as the VM has it (docs/plans/2026-11-19-dial-windows-vm-notes.md).
    const PACKAGE: &str = r"C:\Program Files\WindowsApps\OpenAI.Codex_26.1117.3838.0_arm64__2p2nqsd0c76g0";

    #[test]
    fn the_chatgpt_image_is_the_store_packages_program_in_any_case() {
        let program = format!(r"{PACKAGE}\app\ChatGPT.exe");
        for image in [program.clone(), program.to_lowercase(), program.to_uppercase()] {
            assert!(is_chatgpt_image(&image), "{image}");
        }
        for image in [
            // The beta is another package.
            r"C:\Program Files\WindowsApps\OpenAI.CodexBeta_26.1117.3838.0_arm64__2p2nqsd0c76g0\app\ChatGPT.exe",
            // Another program of the package: Codex's own.
            &format!(r"{PACKAGE}\app\Codex.exe"),
            &format!(r"{PACKAGE}\app\resources\codex.exe"),
            &format!(r"{PACKAGE}\app\NotChatGPT.exe"),
            &format!(r"{PACKAGE}\app\ChatGPT.exe.old"),
            // A ChatGPT.exe outside the Store's folder.
            r"C:\Users\someone\Downloads\OpenAI.Codex_1\ChatGPT.exe",
            r"C:\Program Files\ChatGPT\ChatGPT.exe",
            "ChatGPT.exe",
            "",
        ] {
            assert!(!is_chatgpt_image(image), "{image}");
        }
    }

    #[test]
    fn a_family_is_found_only_when_windows_asks_room_for_its_packages() {
        // ERROR_INSUFFICIENT_BUFFER, with the packages counted.
        assert!(family_found(122, 1));
        assert!(family_found(122, 2));
        // Success with none counted: no package of that family.
        assert!(!family_found(0, 0));
        assert!(!family_found(122, 0));
        // ERROR_INVALID_PARAMETER, APPMODEL_ERROR_NO_PACKAGE.
        assert!(!family_found(87, 1));
        assert!(!family_found(15700, 1));
    }

    #[test]
    fn each_foreground_change_checks_the_window_in_front_and_hears_that_chatgpt_process_alone() {
        let chatgpt = |pid| pid == 7 || pid == 8;
        // A ChatGPT window came to the front, after another app's window or none.
        assert_eq!(foreground_moved(None, Some(7), &chatgpt), Moved::Rehook(7));
        // Another window of the process heard.
        assert_eq!(foreground_moved(Some(7), Some(7), &chatgpt), Moved::Keep);
        // Another ChatGPT process: heard instead.
        assert_eq!(foreground_moved(Some(7), Some(8), &chatgpt), Moved::Rehook(8));
        // Another app's window, or none (between two windows): the empty title, and no process heard.
        assert_eq!(foreground_moved(Some(8), Some(9), &chatgpt), Moved::Unhook);
        assert_eq!(foreground_moved(Some(8), None, &chatgpt), Moved::Unhook);
        assert_eq!(foreground_moved(None, None, &chatgpt), Moved::Unhook);
        // The process heard is checked again too: its pid may now be another program's.
        assert_eq!(foreground_moved(Some(7), Some(7), &|_| false), Moved::Unhook);
    }

    #[test]
    fn the_title_is_read_at_the_front_windows_own_name_change() {
        const FOREGROUND: u32 = 0x0003;
        const NAME_CHANGE: u32 = 0x800C;
        let (front, other) = (0x70, 0x90);
        // The window in front's own name.
        assert!(reads_title(NAME_CHANGE, front, 0, 0, front));
        // A ChatGPT window behind.
        assert!(!reads_title(NAME_CHANGE, other, 0, 0, front));
        // Another object of the window in front: its caret, its menu, its client area.
        for object in [-8, -3, -4] {
            assert!(!reads_title(NAME_CHANGE, front, object, 0, front), "{object}");
        }
        // One of its children.
        assert!(!reads_title(NAME_CHANGE, front, 0, 3, front));
        // A foreground change is foreground_moved's, and another event is none: EVENT_OBJECT_CREATE.
        for event in [FOREGROUND, 0x8000] {
            assert!(!reads_title(event, front, 0, 0, front), "{event}");
        }
    }

    /// What an observation hears, sent to the receiver. The sender goes with the observation's thread: the receiver
    /// is told when the thread has ended.
    #[cfg(windows)]
    fn heard_into() -> (Box<dyn Fn(Heard) + Send + Sync>, mpsc::Receiver<Heard>) {
        let (send, told) = mpsc::channel();
        (
            Box::new(move |heard| {
                let _ = send.send(heard);
            }),
            told,
        )
    }

    /// A runner has no ChatGPT window, and may have no window in front at all.
    #[cfg(windows)]
    #[test]
    fn with_no_chatgpt_in_front_an_observation_hears_no_title_once_and_its_drop_ends_its_thread() {
        let (heard, told) = heard_into();
        let observation = WindowsFollow.observe(heard).expect("an observation");
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Ok(Heard::Title(None)));
        drop(observation);
        // Nothing more was heard before the thread ended.
        assert_eq!(told.recv_timeout(Duration::from_secs(1)), Err(RecvTimeoutError::Disconnected));
    }

    /// A panic where the hook tells (a poisoned lock in the app) would unwind into Windows, which ends the process.
    #[cfg(windows)]
    #[test]
    fn a_panic_where_the_hook_tells_ends_following_not_the_app() {
        use windows_sys::Win32::UI::WindowsAndMessaging::PM_REMOVE;

        let (send, told) = mpsc::channel();
        let heard = move |heard| match heard {
            Heard::Title(_) => panic!("a poisoned lock"),
            Heard::NoObserver => {
                let _ = send.send(heard);
            }
        };
        HERE.with(|cell| {
            // No process is ChatGPT's: each event tells the empty title, and hooks nothing more.
            let _ = cell.set(Here::new(Box::new(|_| false), Arc::new(heard)));
        });
        // Twice: an event queued before the loop quits.
        for _ in 0..2 {
            // SAFETY: called as Windows calls it, on the thread whose HERE it reads.
            unsafe { changed(ptr::null_mut(), EVENT_SYSTEM_FOREGROUND, ptr::null_mut(), 0, 0, 0, 0) };
        }
        // The message loop the hook runs in is told to quit.
        // SAFETY: MSG is plain data; all zeros is a valid value for PeekMessageW to fill.
        let mut message: MSG = unsafe { std::mem::zeroed() };
        let mut quit = false;
        // SAFETY: `message` is writable; the null window takes every message of this thread.
        while !quit && unsafe { PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_REMOVE) } != 0 {
            quit = message.message == WM_QUIT;
        }
        assert!(quit, "the hook's message loop was not told to quit");
        // Following ends with its word, once.
        assert_eq!(told.try_iter().collect::<Vec<_>>(), [Heard::NoObserver]);
    }

    #[cfg(windows)]
    #[test]
    fn installed_answers_and_a_family_never_registered_is_not() {
        // A runner has no ChatGPT package, and the VM may: either answer, as long as it answers.
        let _either = WindowsFollow.installed();
        assert!(!registered("OpenAI.NoSuchApp_2p2nqsd0c76g0"));
    }

    /// The VM's test user has the ChatGPT app's Store package (the spec's Windows checks); a runner has none. Named
    /// as the live test, so the VM's `--ignored follow_windows_live` runs both.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs the ChatGPT app installed for this Windows user"]
    fn follow_windows_live_installed() {
        assert!(WindowsFollow.installed());
    }

    /// What the live test calls that `windows-sys` builds only with features the app is not built with.
    #[cfg(windows)]
    mod user {
        use std::ffi::c_void;
        use windows_sys::Win32::UI::WindowsAndMessaging::WNDPROC;

        /// `WNDCLASSW`.
        #[repr(C)]
        pub struct WindowClass {
            pub style: u32,
            pub procedure: WNDPROC,
            pub class_extra: i32,
            pub window_extra: i32,
            pub instance: *mut c_void,
            pub icon: *mut c_void,
            pub cursor: *mut c_void,
            pub background: *mut c_void,
            pub menu: *const u16,
            pub name: *const u16,
        }

        pub const MOUSEEVENTF_MOVE: u32 = 0x0001;
        pub const KEYEVENTF_KEYUP: u32 = 0x0002;
        pub const VK_MENU: u8 = 0x12;

        // As windows-sys links: no import library needed.
        #[link(name = "user32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
        unsafe extern "system" {
            pub fn RegisterClassW(class: *const WindowClass) -> u16;
            pub fn mouse_event(flags: u32, dx: i32, dy: i32, data: u32, extra: usize);
            pub fn keybd_event(key: u8, scan: u8, flags: u32, extra: usize);
        }

        #[link(name = "kernel32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
        unsafe extern "system" {
            pub fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        }
    }

    /// The last WinEvents a hook of the live test's own heard beside the door's, oldest first: printed when the test
    /// fails, to tell an event Windows never raised from one the door's rule or thread missed. No title is read.
    #[cfg(windows)]
    static SEEN: std::sync::Mutex<std::collections::VecDeque<String>> =
        std::sync::Mutex::new(std::collections::VecDeque::new());

    /// The last lines kept: those before a failure tell it.
    #[cfg(windows)]
    const SEEN_MAX: usize = 200;

    #[cfg(windows)]
    fn note(line: String) {
        let mut seen = SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if seen.len() == SEEN_MAX {
            seen.pop_front();
        }
        seen.push_back(line);
    }

    /// Prints what the witness heard as the live test fails, at any assertion.
    #[cfg(windows)]
    struct Dump;

    #[cfg(windows)]
    impl Drop for Dump {
        fn drop(&mut self) {
            if thread::panicking() {
                let mut seen = SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                eprintln!("what the witness heard, oldest first:\n{}", seen.make_contiguous().join("\n"));
            }
        }
    }

    /// The witness's hook: each event as the door's `changed` gets it, and whether the door's rule reads a title at it.
    #[cfg(windows)]
    unsafe extern "system" fn witnessed(
        _: HWINEVENTHOOK,
        event: u32,
        window: HWND,
        id_object: i32,
        id_child: i32,
        thread: u32,
        _: u32,
    ) {
        // SAFETY: takes no argument.
        let front = unsafe { GetForegroundWindow() };
        let (window, front) = (window as usize, front as usize);
        let reads = reads_title(event, window, id_object, id_child, front);
        note(format!(
            "event {event:#06x} window {window:#x} object {id_object} child {id_child} thread {thread} front {front:#x} \
             reads the title: {reads}"
        ));
    }

    /// Hears, out of context on a thread of its own as the door's observer does, every event of this process and each
    /// other process's foreground change, until its thread is told to quit.
    #[cfg(windows)]
    fn witness() -> (u32, thread::JoinHandle<()>) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{EVENT_MAX, EVENT_MIN, WINEVENT_SKIPOWNPROCESS};

        let (give, given) = mpsc::channel();
        let witness = thread::spawn(move || {
            // SAFETY: MSG is plain data; all zeros is a valid value for PeekMessageW to fill.
            let mut message: MSG = unsafe { std::mem::zeroed() };
            // SAFETY: `message` is writable; nothing is removed. Made before the id is given, as observe_with does.
            unsafe { PeekMessageW(&mut message, ptr::null_mut(), WM_USER, WM_USER, PM_NOREMOVE) };
            let set = |first, last, pid, flags| {
                // SAFETY: no module (the procedure is in this process), and `witnessed` lives as long as the process.
                unsafe {
                    SetWinEventHook(
                        first,
                        last,
                        ptr::null_mut(),
                        Some(witnessed),
                        pid,
                        0,
                        WINEVENT_OUTOFCONTEXT | flags,
                    )
                }
            };
            let hooks = [
                set(EVENT_MIN, EVENT_MAX, std::process::id(), 0),
                set(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, WINEVENT_SKIPOWNPROCESS),
            ];
            note(format!("witness: hooks set {:?}", hooks.map(|hook| !hook.is_null())));
            // SAFETY: takes no argument.
            let _ = give.send(unsafe { GetCurrentThreadId() });
            run_messages();
            for hook in hooks.into_iter().filter(|hook| !hook.is_null()) {
                // SAFETY: set by this thread, and unhooked once.
                unsafe { UnhookWinEvent(hook) };
            }
        });
        (given.recv().expect("the witness's thread"), witness)
    }

    /// The window in front, as a failure tells it: its process and program, no title.
    #[cfg(windows)]
    fn front_described() -> String {
        // SAFETY: takes no argument.
        let front = unsafe { GetForegroundWindow() };
        match owner(front) {
            None => format!("window {:#x}, of no process", front as usize),
            Some(pid) => {
                let program = image(pid).and_then(|path| path.rsplit('\\').next().map(str::to_owned));
                format!("window {:#x} of process {pid} ({})", front as usize, program.as_deref().unwrap_or("unknown"))
            }
        }
    }

    /// Brings `window`, this thread's own, to the front by each way a test may take it on a desktop no person uses,
    /// until one does: Windows lets a process set the front only on its conditions, such as being in front or having
    /// had the last input. The ways and their order are `Raise`'s in device-app/scripts/e2e/windows.ps1. The way that
    /// did, or what each way left in front.
    #[cfg(windows)]
    fn take_front(window: HWND) -> Result<&'static str, String> {
        use windows_sys::Win32::System::Threading::AttachThreadInput;
        use windows_sys::Win32::UI::WindowsAndMessaging::{BringWindowToTop, SetForegroundWindow};

        // SAFETY (each way): this thread's own window, and input of nothing or Alt alone.
        let ways: [(&'static str, &dyn Fn()); 4] = [
            ("SetForegroundWindow", &|| unsafe {
                SetForegroundWindow(window);
            }),
            // An input of this process's own first: a mouse move of nothing.
            ("a mouse move, then SetForegroundWindow", &|| unsafe {
                user::mouse_event(user::MOUSEEVENTF_MOVE, 0, 0, 0, 0);
                SetForegroundWindow(window);
            }),
            // Joined to the input of the thread in front, this thread shares its right to set the front.
            ("AttachThreadInput", &|| unsafe {
                let me = GetCurrentThreadId();
                let front = GetWindowThreadProcessId(GetForegroundWindow(), ptr::null_mut());
                let joined = front != 0 && front != me && AttachThreadInput(me, front, 1) != 0;
                BringWindowToTop(window);
                SetForegroundWindow(window);
                if joined {
                    AttachThreadInput(me, front, 0);
                }
            }),
            // Last: a released Alt may put the window in its menu mode, which the witness would show.
            ("Alt held", &|| unsafe {
                user::keybd_event(user::VK_MENU, 0, 0, 0);
                SetForegroundWindow(window);
                user::keybd_event(user::VK_MENU, 0, user::KEYEVENTF_KEYUP, 0);
            }),
        ];
        let mut refused = Vec::new();
        for (way, take) in ways {
            take();
            // SAFETY: takes no argument.
            if unsafe { GetForegroundWindow() } == window {
                return Ok(way);
            }
            refused.push(format!("{way}: the front is {}", front_described()));
        }
        Err(refused.join("; "))
    }

    /// Under a desktop a person sees (the VM's console session): two windows of this test's own, retitled and brought
    /// to the front in turn, with the ChatGPT check pointed at this process.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a desktop where this process may take the foreground"]
    fn follow_windows_live() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DestroyWindow, SW_SHOWNORMAL, SetForegroundWindow,
            SetWindowTextW, ShowWindow, WS_OVERLAPPEDWINDOW,
        };

        let _dump = Dump;
        // Before the windows: their creation and the foreground's taking are heard too.
        let (witness_thread, witness) = witness();
        let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
        let (give, given) = mpsc::channel();
        // On a thread that pumps its messages, as an app's UI thread does: the observer's reads of their text and the
        // test's retitles arrive there as messages.
        let pump = thread::spawn(move || {
            // A class of the test's own over DefWindowProcW, as an app's top-level window is (Chromium's, which the
            // ChatGPT app's is). The docs list the window object among the elements whose name change Windows tells,
            // and not the static control: a STATIC window's retitle was never heard on a runner.
            // SAFETY: null names this program's own module.
            let module = unsafe { user::GetModuleHandleW(ptr::null()) };
            let class = wide("HarnessFollowLive");
            let registered = user::WindowClass {
                style: 0,
                procedure: Some(DefWindowProcW),
                class_extra: 0,
                window_extra: 0,
                instance: module,
                icon: ptr::null_mut(),
                cursor: ptr::null_mut(),
                background: ptr::null_mut(),
                menu: ptr::null(),
                name: class.as_ptr(),
            };
            // SAFETY: a class whose name lives until this thread ends, and whose procedure is Windows' own.
            let atom = unsafe { user::RegisterClassW(&registered) };
            assert_ne!(atom, 0, "{}", std::io::Error::last_os_error());
            let windows = ["Fix login", "Second thread"].map(|title| {
                let name = wide(title);
                // SAFETY: the class registered above and a title, NUL-terminated; no parent, menu or parameter.
                let window = unsafe {
                    CreateWindowExW(
                        0,
                        class.as_ptr(),
                        name.as_ptr(),
                        WS_OVERLAPPEDWINDOW,
                        CW_USEDEFAULT,
                        CW_USEDEFAULT,
                        300,
                        200,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        module,
                        ptr::null(),
                    )
                };
                assert!(!window.is_null(), "{}", std::io::Error::last_os_error());
                // SAFETY: this thread's own window. Shown twice: a process's first ShowWindow may take its start-up
                // flags instead of the one asked.
                unsafe {
                    ShowWindow(window, SW_SHOWNORMAL);
                    ShowWindow(window, SW_SHOWNORMAL);
                }
                window
            });
            let front = take_front(windows[0]);
            // SAFETY: takes no argument; this thread has a queue, made with its windows.
            let _ = give.send((windows.map(|window| window as usize), unsafe { GetCurrentThreadId() }, front));
            run_messages();
            for window in windows {
                // SAFETY: made by this thread, and destroyed once.
                unsafe { DestroyWindow(window) };
            }
        });
        let ([first, second], pump_thread, front) = given.recv().expect("the test's windows");
        let own = std::process::id();
        note(format!("test: windows {first:#x} and {second:#x} on thread {pump_thread} of process {own}"));
        // Run on purpose, on a desktop that allows it: a refusal is this test's failure, not a skip.
        let way = front.unwrap_or_else(|refused| panic!("Windows did not give this test the foreground. {refused}"));
        println!("follow_windows_live: the foreground taken by {way}");
        let (heard, told) = heard_into();
        let observation = observe_with(move |pid| pid == own, heard);
        let next = || told.recv_timeout(Duration::from_secs(5));
        let titled = |text: &str| -> Result<Heard, RecvTimeoutError> { Ok(Heard::Title(Some(text.into()))) };
        let retitle = |window: usize, text: &str| {
            let name = wide(text);
            // SAFETY: the test's window, alive until its thread quits below; a NUL-terminated title.
            let set = unsafe { SetWindowTextW(window as HWND, name.as_ptr()) } != 0;
            note(format!("test: window {window:#x} retitled: {set}"));
        };
        assert_eq!(next(), titled("Fix login"));
        for text in ["Plan the trip", "Ship the dial"] {
            retitle(first, text);
            assert_eq!(next(), titled(text));
        }
        // The other window, brought to the front: the foreground hook tells its title.
        // SAFETY: the test's window; this process has the foreground.
        let raised = unsafe { SetForegroundWindow(second as HWND) } != 0;
        assert!(raised, "Windows did not give the second window the foreground: the front is {}", front_described());
        assert_eq!(next(), titled("Second thread"));
        // The window now behind, retitled, is not heard: the next title is the one in front's.
        retitle(first, "Behind");
        retitle(second, "Renamed in front");
        assert_eq!(next(), titled("Renamed in front"));
        drop(observation);
        // Each title once: nothing more was heard before the thread ended.
        assert_eq!(told.recv_timeout(Duration::from_secs(1)), Err(RecvTimeoutError::Disconnected));
        for (id, handle) in [(pump_thread, pump), (witness_thread, witness)] {
            // SAFETY: takes no pointer.
            unsafe { PostThreadMessageW(id, WM_QUIT, 0, 0) };
            handle.join().unwrap();
        }
    }
}
