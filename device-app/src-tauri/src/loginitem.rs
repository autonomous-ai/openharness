//! The login item, so the app starts at login.

pub trait LoginItem: Send + Sync {
    fn register(&self) -> Result<(), String>;
}

pub struct SystemLoginItem;

/// What ServiceManagement says of the app's login item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    NotRegistered,
    Enabled,
    /// Registered, and the person has not allowed it or has turned it off since.
    RequiresApproval,
    NotFound,
}

/// Registers the item only when it is not registered.
pub fn register_from(_status: Status, register: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    register()
}

#[cfg(target_os = "macos")]
impl LoginItem for SystemLoginItem {
    /// Never called under `cargo test`: it would make the test binary a login item of the
    /// developer's account.
    fn register(&self) -> Result<(), String> {
        // SAFETY: plain ServiceManagement calls on the main app's own service, with no arguments.
        let service = unsafe { objc2_service_management::SMAppService::mainAppService() };
        // The error code only: macOS's description may name the app's path.
        unsafe { service.registerAndReturnError() }
            .map_err(|error| format!("Login item not added (error {}).", error.code()))
    }
}

#[cfg(not(target_os = "macos"))]
impl LoginItem for SystemLoginItem {
    fn register(&self) -> Result<(), String> {
        Err("Login items are not supported here.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The status, and how many times `register` was called.
    fn from(status: Status) -> (Result<(), String>, usize) {
        let mut calls = 0;
        let result = register_from(status, || {
            calls += 1;
            Ok(())
        });
        (result, calls)
    }

    #[test]
    fn only_an_item_not_registered_is_registered() {
        assert_eq!(from(Status::NotRegistered), (Ok(()), 1));
        assert_eq!(from(Status::Enabled), (Ok(()), 0));
        // An item the person turned off stays off, also after the app's state file is lost.
        assert_eq!(from(Status::RequiresApproval), (Ok(()), 0));
        assert_eq!(from(Status::NotFound), (Err("Login item not found.".into()), 0));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn there_is_none_off_a_mac() {
        assert_eq!(SystemLoginItem.register(), Err("Login items are not supported here.".to_string()));
    }

    struct Counting(Arc<AtomicUsize>);

    impl LoginItem for Counting {
        fn register(&self) -> Result<(), String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn it_is_a_door() {
        let calls = Arc::new(AtomicUsize::new(0));
        let item: Box<dyn LoginItem> = Box::new(Counting(calls.clone()));
        assert_eq!(item.register(), Ok(()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
