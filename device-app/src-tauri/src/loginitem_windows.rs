//! Open at login on Windows: the Run value, and the switch Windows' startup settings keep beside it.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loginitem::Status;
    use std::path::Path;

    const EXE: &str = r#""C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe""#;
    const ON: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const OFF: [u8; 12] = [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    #[test]
    fn only_a_missing_value_is_written_and_a_turned_off_one_stays_off() {
        assert_eq!(status(None, None), Status::NotRegistered);
        assert_eq!(status(Some(EXE), None), Status::Enabled);
        assert_eq!(status(Some(EXE), Some(&ON)), Status::Enabled);
        assert_eq!(status(Some(EXE), Some(&OFF)), Status::RequiresApproval);
        // Turned off in Startup Apps, then its value removed: a value written again would stay off, so none is.
        assert_eq!(status(None, Some(&OFF)), Status::RequiresApproval);
        assert_eq!(status(Some(EXE), Some(&[])), Status::Enabled);
    }

    #[test]
    fn the_value_is_the_quoted_exe() {
        let exe = Path::new(r"C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe");
        assert_eq!(run_data(exe), EXE);
    }

    /// Scratch keys under HKCU, removed when dropped, so no test touches the machine's real Run key.
    #[cfg(windows)]
    struct Scratch(Vec<u16>);

    #[cfg(windows)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RegDeleteTreeW};
            // SAFETY: the subkey is NUL-terminated and outlives the call.
            unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, self.0.as_ptr()) };
        }
    }

    #[cfg(windows)]
    #[test]
    fn register_writes_the_value_once_and_never_turns_one_back_on() {
        use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, REG_BINARY, RegDeleteKeyValueW};
        let root = format!(r"Software\HarnessDeviceTest-{}", std::process::id());
        let _scratch = Scratch(wide(&root));
        let keys = Keys { run: format!(r"{root}\Run").leak(), approved: format!(r"{root}\StartupApproved\Run").leak() };
        let exe = Path::new(r"C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe");
        let run = || read(keys.run, RUN_VALUE).unwrap();

        register_in(&keys, exe).unwrap();
        assert_eq!(run(), Some(sz(&run_data(exe))));

        // A value there is never written again, also by another build.
        register_in(&keys, Path::new(r"C:\Other\harness-device.exe")).unwrap();
        assert_eq!(run(), Some(sz(&run_data(exe))));

        // Turned off in Startup Apps, then the value removed: it stays off.
        write(keys.approved, RUN_VALUE, REG_BINARY, &OFF).unwrap();
        // SAFETY: both strings are NUL-terminated and outlive the call.
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, wide(keys.run).as_ptr(), wide(RUN_VALUE).as_ptr()) };
        register_in(&keys, exe).unwrap();
        assert_eq!(run(), None);

        // Turned on again in Startup Apps: the missing value is written.
        write(keys.approved, RUN_VALUE, REG_BINARY, &ON).unwrap();
        register_in(&keys, exe).unwrap();
        assert_eq!(run(), Some(sz(&run_data(exe))));
    }
}
