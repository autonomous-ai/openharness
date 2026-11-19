//! Opening things: a page, a file in its folder, the desktop app. Windows and Linux have no single `open` program.

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const URL: &str = "https://id.example/a?state=S";
    const ZIP: &str = "/Users/p/Desktop/harness-logs-20261118-1030.zip";

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn what_opens_a_url_on_each_os() {
        assert_eq!(url_args("macos", URL), Some(("/usr/bin/open", strings(&[URL]))));
        assert_eq!(url_args("linux", URL), Some(("xdg-open", strings(&[URL]))));
        // Windows' shell opens it: there is no program to run.
        assert_eq!(url_args("windows", URL), None);
    }

    #[test]
    fn only_an_https_url_goes_to_the_windows_shell() {
        assert_eq!(shell_url(URL), Some(URL));
        let refused = [
            "http://id.example/a",
            "HTTPS://id.example/a",
            " https://id.example/a",
            "file:///C:/Windows/System32/calc.exe",
            r"C:\Windows\System32\calc.exe",
            "calc",
            "",
            // The shell puts the URL in a browser's command line, between quotes.
            r#"https://id.example/a" --flag"#,
            "https://id.example/a --flag",
            "https://id.example/a\n",
        ];
        for url in refused {
            assert_eq!(shell_url(url), None, "{url:?}");
        }
    }

    #[test]
    fn what_shows_the_zip_on_each_os() {
        assert_eq!(reveal_args("macos", Path::new(ZIP)), ("/usr/bin/open", strings(&["-R", ZIP])));
        assert_eq!(reveal_args("linux", Path::new(ZIP)), ("xdg-open", strings(&["/Users/p/Desktop"])));
        let zip = r"C:\Users\p\Desktop\harness-logs-20261118-1030.zip";
        let select = r#"/select,"C:\Users\p\Desktop\harness-logs-20261118-1030.zip""#;
        assert_eq!(reveal_args("windows", Path::new(zip)), ("explorer.exe", strings(&[select])));
    }

    #[test]
    fn explorer_selects_a_zip_whose_path_has_a_space() {
        let zip = r"C:\Users\Nguyễn Văn A\Desktop\harness-logs-20261118-1030.zip";
        let select = r#"/select,"C:\Users\Nguyễn Văn A\Desktop\harness-logs-20261118-1030.zip""#;
        assert_eq!(explorer_select(Path::new(zip)), select);
    }

    #[test]
    fn open_harness_is_one_fixed_command_on_a_mac_and_the_apps_own_file_elsewhere() {
        assert_eq!(desktop_args("macos"), Some(("/usr/bin/open", strings(&["-b", "ai.autonomous.harness"]))));
        // desktop::desktop_app(), run with no argument.
        assert_eq!(desktop_args("linux"), None);
        assert_eq!(desktop_args("windows"), None);
    }
}
