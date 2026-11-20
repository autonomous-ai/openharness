//! The ChatGPT window on macOS, through Accessibility: only its focused window's title, read and never set. Nothing
//! polls: an observer on a thread of its own hears when the focused window or its title changes, and reads the title
//! again. `follow.rs`'s test holds this file to the four Accessibility names and the calls it uses.

use crate::follow::{AxTrust, CHATGPT_BUNDLE, ChatgptWindow, Heard, chatgpt_installed};
use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2_app_kit::NSWorkspace;
use objc2_application_services::{
    AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXObserver, AXUIElement, kAXTrustedCheckOptionPrompt,
};
use objc2_core_foundation::{
    CFBoolean, CFDictionary, CFNotificationCenter, CFNotificationName, CFNotificationSuspensionBehavior, CFRetained,
    CFRunLoop, CFString, CFType, kCFRunLoopDefaultMode,
};
use objc2_foundation::{NSDictionary, NSString, NSURL, ns_string};
use std::cell::RefCell;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;

/// Seconds each Accessibility call waits for ChatGPT: a hung app answers an error, and never holds the thread for good.
const TIMEOUT: f32 = 1.0;

/// The macOS door: Accessibility for the ChatGPT window, and whether Harness may use it.
pub struct MacFollow {
    home: PathBuf,
}

impl MacFollow {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    fn installed_in(&self, applications: &Path) -> bool {
        chatgpt_installed(&self.home, applications, &bundle_id)
    }
}

impl ChatgptWindow for MacFollow {
    fn installed(&self) -> bool {
        self.installed_in(Path::new("/Applications"))
    }

    fn observe(&self, heard: Box<dyn Fn(Heard) + Send + Sync>) -> Option<Box<dyn Send>> {
        // The pid of the app in front: a lookup by bundle id can answer several ChatGPT processes.
        let pid = autoreleasepool(|_| {
            let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
            (app.bundleIdentifier()?.to_string() == CHATGPT_BUNDLE).then(|| app.processIdentifier())
        })?;
        Some(observe_pid(pid, heard))
    }
}

impl AxTrust for MacFollow {
    fn trusted(&self) -> bool {
        // SAFETY: no argument; it asks the system about this process.
        unsafe { AXIsProcessTrusted() }
    }

    fn prompt(&self) {
        // SAFETY: the framework's constant, set before any code runs.
        let key: &CFString = unsafe { kAXTrustedCheckOptionPrompt };
        let options = CFDictionary::<CFString, CFBoolean>::from_slices(&[key], &[CFBoolean::new(true)]);
        // SAFETY: the one option it documents, a CFBoolean under its key. macOS shows its prompt by itself.
        unsafe { AXIsProcessTrustedWithOptions(Some(options.as_ref())) };
    }

    fn start(&self, changed: Box<dyn Fn() + Send + Sync>) {
        let Some(center) = CFNotificationCenter::distributed_center() else { return };
        // Kept for the app's life, as the centre keeps the observer.
        let context = Box::into_raw(Box::new(changed));
        let name = CFString::from_static_str("com.apple.accessibility.api");
        // SAFETY: `context` is never freed and `trust_changed` reads it as the box it is. Delivered immediately:
        // AppKit holds distributed notifications back while the app is not active, and Harness almost never is.
        unsafe {
            center.add_observer(
                context.cast_const().cast(),
                Some(trust_changed),
                Some(&name),
                ptr::null(),
                CFNotificationSuspensionBehavior::DeliverImmediately,
            );
        }
    }
}

/// macOS posts it when the Accessibility list changes.
unsafe extern "C-unwind" fn trust_changed(
    _center: *mut CFNotificationCenter,
    observer: *mut c_void,
    _name: *const CFNotificationName,
    _object: *const c_void,
    _info: *const CFDictionary,
) {
    // SAFETY: `observer` is the box `start` registered and never freed.
    let changed = unsafe { &*observer.cast::<Box<dyn Fn() + Send + Sync>>() };
    changed();
}

/// The app's CFBundleIdentifier, from its Info.plist read fresh: NSBundle would keep its first read for the process's
/// life, and ChatGPT may be installed or removed while Harness runs.
fn bundle_id(app: &Path) -> Option<String> {
    let plist = app.join("Contents").join("Info.plist");
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(plist.to_str()?));
        // SAFETY: a plist's keys at the top are strings, and AnyObject asks nothing of its values. A file it cannot
        // read, or a folder, is an error.
        let info = unsafe { NSDictionary::<NSString, AnyObject>::dictionaryWithContentsOfURL_error(&url) }.ok()?;
        let id = info.objectForKey(ns_string!("CFBundleIdentifier"))?.downcast::<NSString>().ok()?;
        Some(id.to_string())
    })
}

/// The observer thread's run loop.
struct RunLoop(CFRetained<CFRunLoop>);

// SAFETY: another thread only queues a block on it, wakes it and releases it, each of which CoreFoundation allows from
// any thread; only its own thread runs it.
unsafe impl Send for RunLoop {}

/// An observation: dropped, it tells its thread to read nothing more, stops the thread's run loop and returns at once,
/// without waiting for a thread that may be inside a call ChatGPT has yet to answer.
struct Observation {
    run_loop: Option<RunLoop>,
    stopped: Arc<AtomicBool>,
}

impl Drop for Observation {
    fn drop(&mut self) {
        // The stop below waits for the loop to run, and a notification queued before it would still be read.
        self.stopped.store(true, Ordering::Release);
        let Some(RunLoop(run_loop)) = &self.run_loop else { return };
        // A block, not CFRunLoopStop: a stop that comes before the loop runs is lost, and the thread may still be
        // making its observer. A queued block waits for the loop and stops it from inside.
        let stop = RcBlock::new(|| {
            if let Some(current) = CFRunLoop::current() {
                current.stop();
            }
        });
        // SAFETY: CoreFoundation's constant, the mode the observer's loop runs in.
        let mode = unsafe { kCFRunLoopDefaultMode };
        // SAFETY: a block that takes and returns nothing, run on the observer's thread.
        unsafe { run_loop.perform_block(mode.map(|mode| mode.as_ref()), Some(&stop)) };
        run_loop.wake_up();
    }
}

/// Observes the app `pid` on a thread of its own until the handle is dropped.
fn observe_pid(pid: libc::pid_t, heard: Box<dyn Fn(Heard) + Send + Sync>) -> Box<dyn Send> {
    let heard: Arc<dyn Fn(Heard) + Send + Sync> = Arc::from(heard);
    let told = Arc::clone(&heard);
    on_own_run_loop(move |stopped| observe_here(pid, &*told, stopped)).unwrap_or_else(|| {
        // No thread to observe on: told as an observer not made, and an empty observation, where a panic would end
        // the runner's follow thread without a word.
        heard(Heard::NoObserver);
        Box::new(())
    })
}

/// Runs `body` on a thread of its own; None when the system makes no thread. Dropped, the handle sets the flag `body`
/// is given and stops the thread's run loop.
fn on_own_run_loop(body: impl FnOnce(&AtomicBool) + Send + 'static) -> Option<Box<dyn Send>> {
    let stopped = Arc::new(AtomicBool::new(false));
    let told = Arc::clone(&stopped);
    let (give, run_loop) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("chatgpt-observer".into())
        .spawn(move || {
            // Given before `body` runs, so the caller never waits on ChatGPT.
            let _ = give.send(CFRunLoop::current().map(RunLoop));
            body(&told);
        })
        .ok()?;
    Some(Box::new(Observation { run_loop: run_loop.recv().ok().flatten(), stopped }))
}

/// What a notification needs, on the observer's thread.
struct Watched<'a> {
    app: &'a AXUIElement,
    heard: &'a (dyn Fn(Heard) + Send + Sync),
    stopped: &'a AtomicBool,
    /// The focus change's name, to tell it from a title change.
    focus_changed: &'a CFString,
    /// The focused window last read: only its title is the thread's.
    window: RefCell<Option<CFRetained<AXUIElement>>>,
}

impl Watched<'_> {
    /// The focused window's title, told, and the window kept.
    fn read(&self) {
        let window = focused_window(self.app);
        let title = window.as_deref().and_then(title_of);
        self.window.replace(window);
        (self.heard)(Heard::Title(title));
    }
}

/// On the observer's thread: the title now, then at each change, until the run loop is stopped. Once `stopped` is set,
/// nothing more is read.
fn observe_here(pid: libc::pid_t, heard: &(dyn Fn(Heard) + Send + Sync), stopped: &AtomicBool) {
    let Some((run_loop, observer)) = CFRunLoop::current().zip(observer(pid)) else {
        heard(Heard::NoObserver);
        return;
    };
    // SAFETY: any pid makes an element; a call to one that is gone answers an error.
    let app = unsafe { AXUIElement::new_application(pid) };
    // SAFETY: a positive timeout, for every call on the application element.
    unsafe { app.set_messaging_timeout(TIMEOUT) };
    // On the application element, which hears both from each of its windows.
    let names = [CFString::from_static_str("AXFocusedWindowChanged"), CFString::from_static_str("AXTitleChanged")];
    let watched = Watched { app: &app, heard, stopped, focus_changed: &names[0], window: RefCell::new(None) };
    let refcon = ptr::from_ref(&watched).cast_mut().cast();
    // SAFETY: `refcon` is `watched`, alive until both are removed below, and read only on this thread.
    let added = names
        .iter()
        .take_while(|name| unsafe { observer.add_notification(&app, name, refcon) } == AXError::Success)
        .count();
    if added == names.len() {
        // SAFETY: an observer made above.
        let source = unsafe { observer.run_loop_source() };
        // SAFETY: CoreFoundation's constant.
        let mode = unsafe { kCFRunLoopDefaultMode };
        run_loop.add_source(Some(&source), mode);
        // Dropped while the observer was made: the title is not read.
        if !stopped.load(Ordering::Acquire) {
            watched.read();
        }
        // Checked again, as that read may have waited out ChatGPT's timeout: a loop that would stop at once is not run.
        if !stopped.load(Ordering::Acquire) {
            CFRunLoop::run();
        }
        run_loop.remove_source(Some(&source), mode);
    } else {
        heard(Heard::NoObserver);
    }
    for name in &names[..added] {
        // SAFETY: a name added above on this element.
        unsafe { observer.remove_notification(&app, name) };
    }
}

/// An observer of the app `pid`, whose notifications call `notified`.
fn observer(pid: libc::pid_t) -> Option<CFRetained<AXObserver>> {
    let mut made: *mut AXObserver = ptr::null_mut();
    // SAFETY: `notified` is an AXObserverCallback, and `made` is written only on success.
    if unsafe { AXObserver::create(pid, Some(notified), NonNull::from(&mut made)) } != AXError::Success {
        return None;
    }
    // SAFETY: AXObserverCreate's result is ours to release.
    NonNull::new(made).map(|made| unsafe { CFRetained::from_raw(made) })
}

/// A notification, on the observer's thread: the focused window may be another, or its title new.
unsafe extern "C-unwind" fn notified(
    _observer: NonNull<AXObserver>,
    element: NonNull<AXUIElement>,
    name: NonNull<CFString>,
    refcon: *mut c_void,
) {
    // SAFETY: `refcon` is the `Watched` of `observe_here`, alive while its run loop runs, which is when this is called.
    let watched = unsafe { &*refcon.cast::<Watched<'_>>() };
    // Queued before the drop, and run before its stop.
    if watched.stopped.load(Ordering::Acquire) {
        return;
    }
    // SAFETY: the element and the name of this notification, alive for the call.
    let (element, name) = unsafe { (element.as_ref(), name.as_ref()) };
    let again = reads_again(name == watched.focus_changed, element, watched.window.borrow().as_deref());
    if again {
        watched.read();
    }
}

/// Whether a notification may change the thread's title: the focus moved, or the focused window's own title changed.
/// Another element's title (a tab, a button, a line of the page ChatGPT shows) is not read: each read is two calls into
/// ChatGPT, and an app whose page tree is on changes such titles many times a second. Elements compare with CFEqual.
/// With no window known (none yet, or a read ChatGPT did not answer in time), any title change is read until one is
/// found: else the observer would hear no title until the focus moves.
fn reads_again(focus_changed: bool, element: &AXUIElement, window: Option<&AXUIElement>) -> bool {
    focus_changed || window.is_none_or(|window| window == element)
}

/// The focused window; None with no window, or on any error (a ChatGPT that does not answer in time included).
fn focused_window(app: &AXUIElement) -> Option<CFRetained<AXUIElement>> {
    let window = copied(app, "AXFocusedWindow")?.downcast::<AXUIElement>().ok()?;
    // SAFETY: a positive timeout.
    unsafe { window.set_messaging_timeout(TIMEOUT) };
    Some(window)
}

/// A window's title; None on any error.
fn title_of(window: &AXUIElement) -> Option<String> {
    Some(copied(window, "AXTitle")?.downcast::<CFString>().ok()?.to_string())
}

/// One attribute's value, copied: Accessibility is only read.
fn copied(element: &AXUIElement, attribute: &'static str) -> Option<CFRetained<CFType>> {
    let mut value: *const CFType = ptr::null();
    let name = CFString::from_static_str(attribute);
    // SAFETY: `value` is written only on success.
    if unsafe { element.copy_attribute_value(&name, NonNull::from(&mut value)) } != AXError::Success {
        return None;
    }
    // SAFETY: a copied value is ours to release.
    NonNull::new(value.cast_mut()).map(|value| unsafe { CFRetained::from_raw(value) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_core_foundation::{CFRunLoopSource, CFRunLoopSourceContext};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    const CODEX: &str = "<key>CFBundleIdentifier</key><string>com.openai.codex</string>";

    /// An app at `app` whose Info.plist's dict holds `dict`.
    fn app_with(app: &Path, dict: &str) {
        fs::create_dir_all(app.join("Contents")).unwrap();
        let plist =
            format!(r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>{dict}</dict></plist>"#);
        fs::write(app.join("Contents").join("Info.plist"), plist).unwrap();
    }

    #[test]
    fn a_bundle_id_is_read_from_its_info_plist() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("X.app");
        app_with(&app, CODEX);
        assert_eq!(bundle_id(&app).as_deref(), Some("com.openai.codex"));

        let unnamed = root.path().join("Unnamed.app");
        app_with(&unnamed, "<key>CFBundleName</key><string>Unnamed</string>");
        assert_eq!(bundle_id(&unnamed), None);
        let numbered = root.path().join("Numbered.app");
        app_with(&numbered, "<key>CFBundleIdentifier</key><integer>7</integer>");
        assert_eq!(bundle_id(&numbered), None);
        let bare = root.path().join("Bare.app");
        fs::create_dir_all(bare.join("Contents")).unwrap();
        assert_eq!(bundle_id(&bare), None);
        let folder = root.path().join("Folder.app");
        fs::create_dir_all(folder.join("Contents").join("Info.plist")).unwrap();
        assert_eq!(bundle_id(&folder), None);
        assert_eq!(bundle_id(&root.path().join("Gone.app")), None);
    }

    #[test]
    fn installed_reads_only_the_two_places() {
        // Never the real /Applications: an empty folder stands in for it.
        let home = tempfile::tempdir().unwrap();
        let applications = tempfile::tempdir().unwrap();
        let follow = MacFollow::new(home.path().to_path_buf());
        assert!(!follow.installed_in(applications.path()));
        app_with(&home.path().join("Applications").join("ChatGPT.app"), CODEX);
        assert!(follow.installed_in(applications.path()));
    }

    /// A source that never fires: a run loop with none in its mode returns at once instead of running.
    fn idle_source() -> CFRetained<CFRunLoopSource> {
        unsafe extern "C-unwind" fn never(_info: *mut c_void) {}
        let mut context = CFRunLoopSourceContext {
            version: 0,
            info: ptr::null_mut(),
            retain: None,
            release: None,
            copyDescription: None,
            equal: None,
            hash: None,
            schedule: None,
            cancel: None,
            perform: Some(never),
        };
        // SAFETY: a version 0 context with no info, which CFRunLoopSourceCreate copies.
        unsafe { CFRunLoopSource::new(None, 0, &mut context) }.unwrap()
    }

    /// Runs this thread's run loop until it is stopped, as the observer's runs with its source.
    fn run_until_stopped() {
        let run_loop = CFRunLoop::current().unwrap();
        let source = idle_source();
        // SAFETY: CoreFoundation's constant.
        let mode = unsafe { kCFRunLoopDefaultMode };
        run_loop.add_source(Some(&source), mode);
        CFRunLoop::run();
        run_loop.remove_source(Some(&source), mode);
    }

    #[test]
    fn a_drop_before_the_run_loop_runs_stops_it_as_it_starts() {
        // The gate holds the thread before its run loop runs, as a ChatGPT slow to answer holds the observer's.
        let (open, gate) = mpsc::channel::<()>();
        let (ended_to, ended) = mpsc::channel();
        let observation = on_own_run_loop(move |_| {
            let _ = gate.recv();
            run_until_stopped();
            let _ = ended_to.send(());
        })
        .expect("a thread");
        let (dropped_to, dropped) = mpsc::channel();
        thread::spawn(move || {
            drop(observation);
            let _ = dropped_to.send(());
        });
        // A drop that waited for the thread would wait out ChatGPT.
        dropped.recv_timeout(Duration::from_millis(250)).expect("the drop returned at once");
        open.send(()).unwrap();
        ended.recv_timeout(Duration::from_secs(5)).expect("the thread ended");
    }

    #[test]
    fn a_drop_while_the_run_loop_runs_stops_it() {
        let (running_to, running) = mpsc::channel();
        let (ended_to, ended) = mpsc::channel();
        let observation = on_own_run_loop(move |_| {
            // A block runs only inside its loop's run: told, the loop surely runs.
            let told = RcBlock::new(move || {
                let _ = running_to.send(());
            });
            // SAFETY: CoreFoundation's constant.
            let mode = unsafe { kCFRunLoopDefaultMode };
            // SAFETY: a block that takes and returns nothing, run on this thread.
            unsafe { CFRunLoop::current().unwrap().perform_block(mode.map(|mode| mode.as_ref()), Some(&told)) };
            run_until_stopped();
            let _ = ended_to.send(());
        })
        .expect("a thread");
        running.recv_timeout(Duration::from_secs(5)).expect("the run loop runs");
        drop(observation);
        ended.recv_timeout(Duration::from_secs(5)).expect("the thread ended");
    }

    #[test]
    fn a_thread_held_past_its_drop_finds_it_dropped_before_it_reads() {
        // The gate holds the thread as ChatGPT holds one still making its observer: what it would read next is not
        // read once the handle is dropped.
        let (open, gate) = mpsc::channel::<()>();
        let (told_to, told) = mpsc::channel();
        let observation = on_own_run_loop(move |stopped| {
            let _ = told_to.send(stopped.load(Ordering::Acquire));
            let _ = gate.recv();
            let _ = told_to.send(stopped.load(Ordering::Acquire));
        })
        .expect("a thread");
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Ok(false));
        drop(observation);
        open.send(()).unwrap();
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Ok(true));
    }

    #[test]
    fn only_a_focus_change_or_the_focused_windows_own_title_is_read_again() {
        // Application elements stand in for windows: making one calls nothing, and no process has these pids (macOS
        // gives none above 99998). Two made for one pid are one element.
        // SAFETY: any pid makes an element.
        let element = |pid| unsafe { AXUIElement::new_application(pid) };
        let window = element(100_001);
        let (same, other) = (element(100_001), element(100_002));
        assert!(reads_again(false, &same, Some(&window)));
        // Another element's title: a tab, a button, a line of the page ChatGPT shows.
        assert!(!reads_again(false, &other, Some(&window)));
        // No window known (none yet, or a read ChatGPT did not answer in time): any title is read, until one is.
        assert!(reads_again(false, &other, None));
        assert!(reads_again(true, &other, Some(&window)));
        assert!(reads_again(true, &other, None));
    }

    #[test]
    fn the_permission_is_read_and_its_notification_registered() {
        // Never prompt(): it shows macOS's dialog.
        let follow = MacFollow::new(PathBuf::from("/nonexistent"));
        let _either = follow.trusted();
        follow.start(Box::new(|| {}));
    }
}
