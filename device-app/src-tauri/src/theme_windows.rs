//! The Windows taskbar's colour, light or dark, told as it changes.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_value_of_one_is_a_light_panel() {
        assert!(light_panel(Some(1)));
        assert!(!light_panel(Some(0)));
        assert!(!light_panel(Some(2)));
        // Windows 10's taskbar with no value is dark.
        assert!(!light_panel(None));
    }

    /// The person's theme is read, never written: the changes go to a hive file of the test's own, which no other
    /// program sees.
    #[cfg(windows)]
    #[test]
    fn the_watch_tells_a_change_once() {
        use std::ptr;
        use std::sync::mpsc;
        use std::time::Duration;
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{HKEY, KEY_ALL_ACCESS, REG_DWORD, RegCloseKey, RegLoadAppKeyW, RegSetKeyValueW};

        // The real value reads, whichever it is.
        let _ = read(PERSONALIZE);

        let folder = tempfile::tempdir().unwrap();
        let hive = wide(&folder.path().join("theme.dat").display().to_string());
        let mut root: HKEY = ptr::null_mut();
        // SAFETY: the path is NUL-terminated and outlives the call; `root` receives the loaded hive.
        assert_eq!(unsafe { RegLoadAppKeyW(hive.as_ptr(), &mut root, KEY_ALL_ACCESS, 0, 0) }, ERROR_SUCCESS);
        let (key, name) = (wide("Personalize"), wide(VALUE));
        let set = |value: u32| {
            let data = value.to_le_bytes();
            // SAFETY: `root` is open; both strings are NUL-terminated; `data` holds the four bytes named.
            let code =
                unsafe { RegSetKeyValueW(root, key.as_ptr(), name.as_ptr(), REG_DWORD, data.as_ptr().cast(), 4) };
            assert_eq!(code, ERROR_SUCCESS);
        };
        set(0);

        let (told, tells) = mpsc::channel();
        watch_under(root, "Personalize", move |light| {
            let _ = told.send(light);
        });
        let wait = Duration::from_secs(10);
        set(1);
        assert_eq!(tells.recv_timeout(wait), Ok(true));
        // 1 again tells nothing: the next value told is the 0 after it.
        set(1);
        set(0);
        assert_eq!(tells.recv_timeout(wait), Ok(false));
        // SAFETY: `root` is open and closed once.
        unsafe { RegCloseKey(root) };
    }
}
