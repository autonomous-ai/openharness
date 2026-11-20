//! The ChatGPT follow on Linux X11: property changes on the root (`_NET_ACTIVE_WINDOW`) and on the active window
//! say when the title changed, and the title is the window's `_NET_WM_NAME`, else its `WM_NAME`.

#[cfg(test)]
mod tests {
    use super::*;

    const WAIT: std::time::Duration = std::time::Duration::from_secs(5);
    const NET_NAME: u32 = 300;
    const WM_NAME: u32 = 39;

    #[test]
    fn the_mask_moves_with_the_active_window() {
        let mut mask = ActiveMask::default();
        assert_eq!(mask.moved(Some(7)), (None, Some(7)));
        assert_eq!(mask.moved(Some(8)), (Some(7), Some(8)));
        assert_eq!(mask.moved(Some(8)), (None, None));
        assert_eq!(mask.moved(None), (Some(8), None));
        assert_eq!(mask.moved(None), (None, None));
    }

    #[test]
    fn net_wm_name_is_always_read_and_wm_name_only_without_it() {
        assert!(reads(NET_NAME, true, NET_NAME, WM_NAME));
        assert!(reads(NET_NAME, false, NET_NAME, WM_NAME));
        assert!(reads(WM_NAME, false, NET_NAME, WM_NAME));
        assert!(!reads(WM_NAME, true, NET_NAME, WM_NAME));
        // `_NET_WM_PID`, `WM_CLASS`, `_NET_WM_STATE`: never the title.
        for other in [301, 67, 302] {
            assert!(!reads(other, false, NET_NAME, WM_NAME), "{other}");
        }
    }

    #[test]
    fn the_title_is_net_wm_name_as_utf8_first_else_wm_name_by_its_type() {
        let wm = |kind, bytes: &'static [u8]| Some((kind, bytes));
        assert_eq!(
            title(Some("Fix login ✓".as_bytes()), wm(WmNameType::Latin1, b"Other")).as_deref(),
            Some("Fix login ✓")
        );
        assert_eq!(title(None, wm(WmNameType::Utf8, "Plan the trip ✓".as_bytes())).as_deref(), Some("Plan the trip ✓"));
        assert_eq!(title(None, wm(WmNameType::Latin1, b"Caf\xe9")).as_deref(), Some("Café"));
        // COMPOUND_TEXT and any other type: no title.
        assert_eq!(title(None, wm(WmNameType::Other, b"Fix login")), None);
        assert_eq!(title(None, None), None);
        // The window has `_NET_WM_NAME`: its bytes are the title or none, never WM_NAME's.
        assert_eq!(title(Some(b"Caf\xe9"), wm(WmNameType::Utf8, b"Fix login")), None);
        assert_eq!(title(None, wm(WmNameType::Utf8, b"Caf\xe9")), None);
    }

    #[test]
    fn a_display_with_no_server_is_no_observer_once() {
        let (tell, told) = std::sync::mpsc::channel();
        // A socket no server listens on: no TCP is tried for a `unix:` display.
        let door = X11Follow::new("unix:59000".into(), FollowSwitch::new(true));
        let _observation = door.observe_with(|_| true, Box::new(move |heard| drop(tell.send(heard))));
        assert_eq!(told.recv_timeout(WAIT), Ok(Heard::NoObserver));
        assert_eq!(told.recv_timeout(WAIT), Err(std::sync::mpsc::RecvTimeoutError::Disconnected));
    }

    #[test]
    fn the_permission_is_the_switch() {
        let door = X11Follow::new(":0".into(), FollowSwitch::new(false));
        let told = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = told.clone();
        door.start(Box::new(move || drop(count.fetch_add(1, std::sync::atomic::Ordering::SeqCst))));
        assert!(!door.trusted());
        door.switch(true);
        assert!(door.trusted());
        assert_eq!(told.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
