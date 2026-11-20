//! The ChatGPT window on macOS, through Accessibility: only its focused window's title, read and never set. Nothing
//! polls: an observer on a thread of its own hears when the focused window or a title changes, and reads the title
//! again. `follow.rs`'s test holds this file to the four Accessibility names it uses.

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
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr::{self, NonNull};
use std::sync::mpsc;
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
        Some(observe_pid(pid, heard, || {}))
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

/// An observation: dropped, it stops its thread's run loop and returns at once, without waiting for a thread that may
/// be inside a call ChatGPT has yet to answer.
struct Observation(Option<RunLoop>);

impl Drop for Observation {
    fn drop(&mut self) {
        let Some(RunLoop(run_loop)) = &self.0 else { return };
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

/// Observes the app `pid` on a thread of its own until the handle is dropped; `ended` runs as the thread ends.
fn observe_pid(
    pid: libc::pid_t,
    heard: Box<dyn Fn(Heard) + Send + Sync>,
    ended: impl FnOnce() + Send + 'static,
) -> Box<dyn Send> {
    let (give, run_loop) = mpsc::sync_channel(1);
    thread::spawn(move || {
        // Given before any Accessibility call, so the caller never waits on ChatGPT.
        let _ = give.send(CFRunLoop::current().map(RunLoop));
        observe_here(pid, &*heard);
        ended();
    });
    Box::new(Observation(run_loop.recv().ok().flatten()))
}

/// What a notification needs, on the observer's thread.
struct Watched<'a> {
    app: &'a AXUIElement,
    heard: &'a (dyn Fn(Heard) + Send + Sync),
}

/// On the observer's thread: the title now, then at each change, until the run loop is stopped.
fn observe_here(pid: libc::pid_t, heard: &(dyn Fn(Heard) + Send + Sync)) {
    let Some((run_loop, observer)) = CFRunLoop::current().zip(observer(pid)) else {
        heard(Heard::NoObserver);
        return;
    };
    // SAFETY: any pid makes an element; a call to one that is gone answers an error.
    let app = unsafe { AXUIElement::new_application(pid) };
    // SAFETY: a positive timeout, for every call on the application element.
    unsafe { app.set_messaging_timeout(TIMEOUT) };
    let watched = Watched { app: &app, heard };
    let refcon = ptr::from_ref(&watched).cast_mut().cast();
    // On the application element, which hears both from each of its windows.
    let names = [CFString::from_static_str("AXFocusedWindowChanged"), CFString::from_static_str("AXTitleChanged")];
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
        heard(Heard::Title(read_title(&app)));
        CFRunLoop::run();
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
    _element: NonNull<AXUIElement>,
    _name: NonNull<CFString>,
    refcon: *mut c_void,
) {
    // SAFETY: `refcon` is the `Watched` of `observe_here`, alive while its run loop runs, which is when this is called.
    let watched = unsafe { &*refcon.cast::<Watched<'_>>() };
    (watched.heard)(Heard::Title(read_title(watched.app)));
}

/// The focused window's title; None with no window, or on any error (a ChatGPT that does not answer in time included).
fn read_title(app: &AXUIElement) -> Option<String> {
    let window = copied(app, "AXFocusedWindow")?.downcast::<AXUIElement>().ok()?;
    // SAFETY: a positive timeout.
    unsafe { window.set_messaging_timeout(TIMEOUT) };
    let title = copied(&window, "AXTitle")?.downcast::<CFString>().ok()?;
    Some(title.to_string())
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
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

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

    #[test]
    fn the_observer_thread_ends_when_its_handle_is_dropped() {
        // This test's own process has no window and may or may not be trusted: either way its thread ends.
        for after_first_heard in [false, true] {
            let (heard_to, heard) = mpsc::channel();
            let (ended_to, ended) = mpsc::channel();
            let observation = observe_pid(
                std::process::id() as libc::pid_t,
                Box::new(move |told| {
                    let _ = heard_to.send(told);
                }),
                move || {
                    let _ = ended_to.send(());
                },
            );
            if after_first_heard {
                heard.recv_timeout(Duration::from_secs(5)).expect("a first title or no observer");
            }
            let dropping = Instant::now();
            drop(observation);
            // A drop that waited for the thread would wait out ChatGPT's 1 s timeout.
            assert!(dropping.elapsed() < Duration::from_millis(250), "{:?}", dropping.elapsed());
            ended.recv_timeout(Duration::from_secs(5)).expect("the observer thread ended");
        }
    }

    #[test]
    fn the_permission_is_read_and_its_notification_registered() {
        // Never prompt(): it shows macOS's dialog.
        let follow = MacFollow::new(PathBuf::from("/nonexistent"));
        let _either = follow.trusted();
        follow.start(Box::new(|| {}));
    }
}
