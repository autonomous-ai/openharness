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
        system().start(changed);
        assert_eq!(told.lock().unwrap().len(), 1);
    }
}
