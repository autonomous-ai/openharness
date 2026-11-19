//! The app in front on Windows: the system tells each foreground change. No timer, no permission.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_value_is_the_exe_file_name() {
        assert_eq!(file_name(r"C:\Program Files\Microsoft VS Code\Code.exe"), "Code.exe");
        assert_eq!(file_name("C:/x/wezterm-gui.exe"), "wezterm-gui.exe");
        assert_eq!(file_name("WindowsTerminal.exe"), "WindowsTerminal.exe");
        assert_eq!(file_name(""), "");
    }

    #[cfg(windows)]
    #[test]
    fn the_source_tells_the_app_in_front_once_at_start() {
        use crate::front::{FrontSource, front_line};
        use crate::types::MemoryLog;
        use std::sync::Arc;
        use std::sync::mpsc;

        let (send, told) = mpsc::channel();
        WinFront { log: Arc::new(MemoryLog::default()) }.start(Box::new(move |value| {
            let _ = send.send(value);
        }));
        let value = told.recv_timeout(std::time::Duration::from_secs(5)).expect("a value within 5 s");
        // A runner's service session may have no window in front: the empty value.
        if !value.is_empty() {
            assert_eq!(front_line(&value), serde_json::json!({ "front": value }).to_string());
        }
    }
}
