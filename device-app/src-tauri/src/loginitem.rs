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

/// Registers the item only when it is not registered: one the person turned off reads RequiresApproval, and is never
/// turned on again over their choice.
pub fn register_from(status: Status, register: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    match status {
        Status::NotRegistered => register(),
        Status::Enabled | Status::RequiresApproval => Ok(()),
        Status::NotFound => Err("Login item not found.".into()),
    }
}

#[cfg(target_os = "macos")]
impl LoginItem for SystemLoginItem {
    /// Never called under `cargo test`: it would make the test binary a login item of the
    /// developer's account.
    fn register(&self) -> Result<(), String> {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        // SAFETY: plain ServiceManagement calls on the main app's own service, with no arguments.
        let service = unsafe { SMAppService::mainAppService() };
        let status = match unsafe { service.status() } {
            SMAppServiceStatus::NotRegistered => Status::NotRegistered,
            SMAppServiceStatus::Enabled => Status::Enabled,
            SMAppServiceStatus::RequiresApproval => Status::RequiresApproval,
            _ => Status::NotFound,
        };
        register_from(status, || {
            // The error code only: macOS's description may name the app's path.
            unsafe { service.registerAndReturnError() }
                .map_err(|error| format!("Login item not added (error {}).", error.code()))
        })
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
}
