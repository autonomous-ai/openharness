//! The login item, so the app starts at login.

pub trait LoginItem: Send + Sync {
    fn register(&self) -> Result<(), String>;
}

pub struct SystemLoginItem;

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

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn there_is_none_off_a_mac() {
        assert_eq!(
            SystemLoginItem.register(),
            Err("Login items are not supported here.".to_string())
        );
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
