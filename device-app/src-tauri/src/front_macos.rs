//! The app in front on macOS: AppKit says when another app becomes active. No timer, no Accessibility or Screen
//! Recording permission.

use crate::front::FrontSource;
use block2::RcBlock;
use objc2_app_kit::{
    NSRunningApplication, NSWorkspace, NSWorkspaceApplicationKey, NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::{NSNotification, NSString};
use std::ptr::NonNull;
use std::sync::Arc;

/// `NSWorkspace`'s front app now, then each app its notification centre says was activated.
pub struct MacFront;

impl FrontSource for MacFront {
    fn start(&self, changed: Box<dyn Fn(String) + Send + Sync>) {
        let workspace = NSWorkspace::sharedWorkspace();
        let changed: Arc<dyn Fn(String) + Send + Sync> = Arc::from(changed);
        let told = changed.clone();
        let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
            // SAFETY: the centre passes a notification that lives for the call.
            let info = unsafe { notification.as_ref() }.userInfo();
            // SAFETY: an AppKit constant, set before any code runs.
            let key = unsafe { NSWorkspaceApplicationKey };
            let app = info.and_then(|info| info.objectForKey(key)).and_then(|app| app.downcast().ok());
            told(app_value(app.as_deref()));
        });
        // SAFETY: no object filter, and with no queue the block runs on the thread that posts (AppKit's main thread);
        // `changed` is Send + Sync. The centre holds the observer for the app's life, so the token is dropped.
        unsafe {
            workspace.notificationCenter().addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                None,
                &block,
            );
        }
        // Read after the observer is registered, so a change between the two is not missed; FrontFeed drops a repeat.
        changed(app_value(workspace.frontmostApplication().as_deref()));
    }
}

fn app_value(app: Option<&NSRunningApplication>) -> String {
    value(app.and_then(|app| app.bundleIdentifier()).as_deref())
}

/// An app with no bundle id (a bare executable) is the empty value.
fn value(bundle_id: Option<&NSString>) -> String {
    bundle_id.map(NSString::to_string).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::front::{FRONT_MAX, system};
    use objc2_foundation::NSString;
    use std::sync::{Arc, Mutex};

    /// What a source tells, kept in order.
    fn recorder() -> (Arc<Mutex<Vec<String>>>, Box<dyn Fn(String) + Send + Sync>) {
        let told = Arc::new(Mutex::new(Vec::new()));
        let into = told.clone();
        (told, Box::new(move |value| into.lock().unwrap().push(value)))
    }

    #[test]
    fn an_app_with_no_bundle_id_is_the_empty_value() {
        assert_eq!(value(None), "");
        assert_eq!(value(Some(&NSString::from_str("com.mitchellh.ghostty"))), "com.mitchellh.ghostty");
    }

    #[test]
    fn start_tells_the_app_in_front_once() {
        let (told, changed) = recorder();
        MacFront.start(changed);
        let told = told.lock().unwrap();
        assert_eq!(told.len(), 1, "{}", told.len());
        assert!(told[0].chars().count() <= FRONT_MAX);
    }

    #[test]
    fn system_is_the_appkit_source_on_macos() {
        // NoFront tells nothing; the AppKit source tells the app in front at once, even when there is none.
        let (told, changed) = recorder();
        system(Arc::new(crate::types::MemoryLog::default())).start(changed);
        assert_eq!(told.lock().unwrap().len(), 1);
    }
}
