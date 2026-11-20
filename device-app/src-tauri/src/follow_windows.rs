//! The ChatGPT follow on Windows: a win-event hook hears each foreground change, and another, for the ChatGPT process
//! in front only, its name changes. The window's title is its native text (`GetWindowTextW`). The app is installed
//! when its package family is registered for the person (`GetPackagesByPackageFamily`).

use crate::follow::{AxTrust, FollowSwitch};
use regex::Regex;
use std::sync::{Arc, LazyLock};
#[cfg(windows)]
use {
    crate::follow::{ChatgptWindow, Heard, TITLE_MAX},
    std::cell::{Cell, OnceCell},
    std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    std::panic::{self, AssertUnwindSafe},
    std::ptr,
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

/// The Windows door. Windows gates no read of a window's title: the person's switch stands for the permission.
pub struct WindowsFollow {
    switch: Arc<FollowSwitch>,
}

impl WindowsFollow {
    pub fn new(switch: Arc<FollowSwitch>) -> WindowsFollow {
        WindowsFollow { switch }
    }
}

impl AxTrust for WindowsFollow {
    fn trusted(&self) -> bool {
        self.switch.on()
    }

    /// Nothing to ask.
    fn prompt(&self) {}

    fn start(&self, changed: Box<dyn Fn() + Send + Sync>) {
        self.switch.start(changed);
    }

    fn switch(&self, on: bool) {
        self.switch.set(on);
    }
}

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
    use std::sync::Mutex;
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

    #[test]
    fn the_door_answers_the_permission_with_the_persons_switch() {
        assert!(!WindowsFollow::new(FollowSwitch::new(false)).trusted());
        let switch = FollowSwitch::new(true);
        let door = WindowsFollow::new(switch.clone());
        assert!(door.trusted());
        let told = Arc::new(Mutex::new(0));
        let count = told.clone();
        door.start(Box::new(move || *count.lock().unwrap() += 1));
        // The menu's click.
        door.switch(false);
        assert!(!switch.on());
        assert!(!door.trusted());
        assert_eq!(*told.lock().unwrap(), 1);
        // Nothing to ask on Windows.
        door.prompt();
        assert!(!switch.on());
        assert_eq!(*told.lock().unwrap(), 1);
        door.switch(true);
        assert!(door.trusted());
        assert_eq!(*told.lock().unwrap(), 2);
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
        let observation = WindowsFollow::new(FollowSwitch::new(true)).observe(heard).expect("an observation");
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
        let _either = WindowsFollow::new(FollowSwitch::new(true)).installed();
        assert!(!registered("OpenAI.NoSuchApp_2p2nqsd0c76g0"));
    }

    /// Under a desktop a person sees (the VM's console session): a window of this test's own, in front, retitled
    /// twice, with the ChatGPT check pointed at this process.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a desktop where this process may take the foreground"]
    fn follow_windows_live() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CW_USEDEFAULT, CreateWindowExW, DestroyWindow, SW_SHOWNORMAL, SetForegroundWindow, SetWindowTextW,
            ShowWindow, WS_OVERLAPPEDWINDOW,
        };

        let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
        let (give, given) = mpsc::channel();
        // On a thread that pumps its messages, as an app's UI thread does: the observer's reads of its text and the
        // test's retitles arrive there as messages.
        let pump = thread::spawn(move || {
            let (class, name) = (wide("STATIC"), wide("Fix login"));
            // SAFETY: a system class and a title, NUL-terminated; no parent, menu, instance or parameter.
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
                    ptr::null_mut(),
                    ptr::null(),
                )
            };
            assert!(!window.is_null(), "{}", std::io::Error::last_os_error());
            // SAFETY: this thread's own window. Shown twice: a process's first ShowWindow may take its start-up flags
            // instead of the one asked.
            let front = unsafe {
                ShowWindow(window, SW_SHOWNORMAL);
                ShowWindow(window, SW_SHOWNORMAL);
                SetForegroundWindow(window) != 0 && GetForegroundWindow() == window
            };
            // SAFETY: takes no argument; this thread has a queue, made with its window.
            let _ = give.send((window as usize, unsafe { GetCurrentThreadId() }, front));
            run_messages();
            // SAFETY: made by this thread, and destroyed once.
            unsafe { DestroyWindow(window) };
        });
        let (window, pump_thread, front) = given.recv().expect("the test's window");
        let stop_pump = || {
            // SAFETY: takes no pointer.
            unsafe { PostThreadMessageW(pump_thread, WM_QUIT, 0, 0) };
        };
        if !front {
            eprintln!("skipped: Windows did not give this test the foreground");
            stop_pump();
            pump.join().unwrap();
            return;
        }
        let own = std::process::id();
        let (heard, told) = heard_into();
        let observation = observe_with(move |pid| pid == own, heard);
        let titled = |text: &str| -> Result<Heard, RecvTimeoutError> { Ok(Heard::Title(Some(text.into()))) };
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), titled("Fix login"));
        for text in ["Plan the trip", "Ship the dial"] {
            let name = wide(text);
            // SAFETY: the test's window, alive until its thread quits below; a NUL-terminated title.
            unsafe { SetWindowTextW(window as HWND, name.as_ptr()) };
            assert_eq!(told.recv_timeout(Duration::from_secs(5)), titled(text));
        }
        drop(observation);
        // Each title once: nothing more was heard before the thread ended.
        assert_eq!(told.recv_timeout(Duration::from_secs(1)), Err(RecvTimeoutError::Disconnected));
        stop_pump();
        pump.join().unwrap();
    }
}
