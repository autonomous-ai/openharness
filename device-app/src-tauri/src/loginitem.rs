//! The login item, so the app starts at login.

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
