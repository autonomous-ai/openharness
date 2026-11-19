//! `harness logs export --json`: the zip it wrote, read from its answer before it is shown (`open.rs`).

use crate::cli::{Cli, LINE_MAX};
use crate::types::{ExportFailure, Exported, Output};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Twice the desktop app's 30 s: the CLI's status commands alone may take 10 s, and a slow disk zips 25 MB of logs.
pub const EXPORT_DEADLINE: Duration = Duration::from_secs(60);

/// The longest path kept, in bytes: it becomes a menu line.
const PATH_MAX: usize = 1024;

/// Runs `logs export --json` and reads its answer.
pub fn export(cli: &dyn Cli, home: &Path) -> Result<Exported, ExportFailure> {
    export_within(cli, home, EXPORT_DEADLINE)
}

fn export_within(cli: &dyn Cli, home: &Path, deadline: Duration) -> Result<Exported, ExportFailure> {
    // A CLI gone since it was found is an answer too, so the menu never waits on an export that never ran.
    let output = cli.run(&["logs", "export", "--json"], deadline).map_err(|_| ExportFailure::NoAnswer)?;
    let zip = parse(&output)?;
    Ok(Exported { shown: shown(&zip, home), zip })
}

/// The zip a finished run names: `path` in its last line, as the desktop app reads it. What the CLI prints is outside
/// text, and the path becomes a menu line and an argument of what shows it. The file is not looked for on disk.
pub fn parse(output: &Output) -> Result<PathBuf, ExportFailure> {
    if output.timed_out {
        return Err(ExportFailure::TimedOut);
    }
    let line = output.stdout.lines().last().filter(|line| output.code == Some(0) && line.len() <= LINE_MAX);
    let Some(Ok(Value::Object(answer))) = line.map(serde_json::from_str::<Value>) else {
        return Err(ExportFailure::NoAnswer);
    };
    let path = answer.get("path").and_then(Value::as_str).filter(|path| bundle_path(path, cfg!(windows)));
    path.map(PathBuf::from).ok_or(ExportFailure::NoFile)
}

/// Absolute, so what shows it never reads it as an option; one short line; its file name
/// `harness-logs-YYYYMMDD-HHMM.zip`, whole. On Windows, no `"`: Explorer reads the path between quotes.
fn bundle_path(path: &str, windows: bool) -> bool {
    // Every line break, not only the control characters: the menu shows the path on one line.
    let one_line = !path.chars().any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'));
    // The text after the last separator, not `file_name`, which skips a trailing one. Windows takes both; a unix file
    // name may hold a `\`.
    let name = if windows { path.rsplit(['/', '\\']).next() } else { path.rsplit('/').next() }.unwrap_or_default();
    let digits = |part: &str, len: usize| part.len() == len && part.bytes().all(|byte| byte.is_ascii_digit());
    let stamp = name.strip_prefix("harness-logs-").and_then(|rest| rest.strip_suffix(".zip"));
    path.len() <= PATH_MAX
        && Path::new(path).is_absolute()
        && one_line
        && !(windows && path.contains('"'))
        && stamp.and_then(|stamp| stamp.split_once('-')).is_some_and(|(day, time)| digits(day, 8) && digits(time, 4))
}

/// `~/Desktop/…` for a zip under `home`, else the whole path. Whole folders: `/Users/pp/…` is not under `/Users/p`.
pub fn shown(zip: &Path, home: &Path) -> String {
    match zip.strip_prefix(home) {
        Ok(rest) => Path::new("~").join(rest).display().to_string(),
        Err(_) => zip.display().to_string(),
    }
}

/// The menu's and the log's words for a failure: fixed, never the CLI's own text.
pub fn reason(failure: ExportFailure) -> &'static str {
    match failure {
        ExportFailure::TimedOut => "timed out",
        ExportFailure::NoAnswer => "Harness did not answer",
        ExportFailure::NoFile => "no file",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::LINE_MAX;
    #[cfg(unix)]
    use crate::testing::Fake;
    use crate::types::ExportFailure::{NoAnswer, NoFile, TimedOut};
    use serde_json::json;
    #[cfg(unix)]
    use std::fs;

    const NAME: &str = "harness-logs-20261118-1030.zip";
    // An absolute folder, a zip in one and an answer naming it, on the OS that runs the test.
    #[cfg(unix)]
    const ROOT: &str = "/";
    #[cfg(windows)]
    const ROOT: &str = r"C:\";
    #[cfg(unix)]
    const ZIP: &str = "/Users/p/Desktop/harness-logs-20261118-1030.zip";
    #[cfg(windows)]
    const ZIP: &str = r"C:\Users\p\Desktop\harness-logs-20261118-1030.zip";
    #[cfg(unix)]
    const GOOD: &str = r#"{"path":"/Users/p/Desktop/harness-logs-20261118-1030.zip","included":["a"],"bytes":9}"#;
    #[cfg(windows)]
    const GOOD: &str = r#"{"path":"C:\\Users\\p\\Desktop\\harness-logs-20261118-1030.zip","included":["a"],"bytes":9}"#;
    /// Paths an answer may name that are no bundle the CLI writes.
    #[cfg(unix)]
    const NOT_BUNDLES: [&str; 7] = [
        "tmp/harness-logs-20261118-1030.zip",
        "/tmp/evil.zip",
        "/tmp/harness-logs-2026118-1030.zip",
        "/tmp/harness-logs-20261118-1030.zip.sh",
        "/tmp/xharness-logs-20261118-1030.zip",
        "/tmp/harness-logs-20261118-1030.zip/",
        // Digits of another script are no date the CLI writes.
        "/tmp/harness-logs-٢٠٢٦١١١٨-1030.zip",
    ];
    #[cfg(windows)]
    const NOT_BUNDLES: [&str; 11] = [
        r"tmp\harness-logs-20261118-1030.zip",
        // Rooted on no drive, on a drive's working folder, or unix's: none is absolute.
        r"\tmp\harness-logs-20261118-1030.zip",
        r"C:tmp\harness-logs-20261118-1030.zip",
        "/tmp/harness-logs-20261118-1030.zip",
        r"C:\tmp\evil.zip",
        r"C:\tmp\harness-logs-2026118-1030.zip",
        r"C:\tmp\harness-logs-20261118-1030.zip.sh",
        r"C:\tmp\xharness-logs-20261118-1030.zip",
        r"C:\tmp\harness-logs-20261118-1030.zip\",
        r"C:\tmp\harness-logs-20261118-1030.zip/",
        r"C:\tmp\harness-logs-٢٠٢٦١١١٨-1030.zip",
    ];
    #[cfg(unix)]
    const SHORT: Duration = Duration::from_millis(300);

    /// A run that ended by itself with this code and stdout.
    fn ended(code: i32, stdout: &str) -> Output {
        Output { code: Some(code), stdout: stdout.into(), ..Output::default() }
    }

    /// A finished run whose answer names this path.
    fn naming(path: &str) -> Output {
        ended(0, &format!("{}\n", json!({ "path": path, "included": [], "bytes": 1 })))
    }

    /// GOOD, after spaces JSON allows, `len` bytes long in all.
    fn padded(len: usize) -> Output {
        ended(0, &format!("{}{GOOD}\n", " ".repeat(len - GOOD.len())))
    }

    /// The path under ROOT made of these parts.
    fn absolute(parts: &[&str]) -> String {
        parts.iter().fold(PathBuf::from(ROOT), |path, part| path.join(part)).display().to_string()
    }

    #[test]
    fn only_an_absolute_bundle_path_is_kept() {
        let good = format!("{GOOD}\n");
        let kept = [ended(0, &good), ended(0, &format!("note\n{GOOD}\n")), padded(LINE_MAX)];
        for (case, output) in kept.iter().enumerate() {
            assert_eq!(parse(output), Ok(PathBuf::from(ZIP)), "kept {case}");
        }
        let no_answer = [
            ended(1, &good),
            Output { code: None, stdout: good.clone(), ..Output::default() },
            ended(0, "oops\n"),
            ended(0, ""),
            ended(0, "[1]\n"),
            ended(0, "\"x\"\n"),
            padded(LINE_MAX + 1),
        ];
        for (case, output) in no_answer.iter().enumerate() {
            assert_eq!(parse(output), Err(NoAnswer), "no answer {case}");
        }
        let mut no_file = vec![ended(0, "{\"bytes\":1}\n"), ended(0, "{\"path\":7}\n")];
        no_file.extend(NOT_BUNDLES.map(naming));
        for (case, output) in no_file.iter().enumerate() {
            assert_eq!(parse(output), Err(NoFile), "no file {case}: {output:?}");
        }
        let timed_out = Output { timed_out: true, ..ended(0, &good) };
        assert_eq!(parse(&timed_out), Err(TimedOut));
    }

    #[test]
    fn a_path_that_is_no_menu_line() {
        let longest = absolute(&[&"a".repeat(1024 - ROOT.len() - 1 - NAME.len()), NAME]);
        assert_eq!(longest.len(), 1024);
        assert_eq!(parse(&naming(&longest)), Ok(PathBuf::from(&longest)));
        let too_long = absolute(&[&"a".repeat(1025 - ROOT.len() - 1 - NAME.len()), NAME]);
        let breaks = ["\n", "\r", "\t", "\u{7f}", "\u{85}", "\u{2028}", "\u{2029}"]
            .map(|text| absolute(&["tmp", &format!("a{text}b"), NAME]));
        for path in breaks.iter().chain([&too_long]) {
            assert_eq!(parse(&naming(path)), Err(NoFile), "{path:?}");
        }
    }

    #[test]
    fn a_windows_zip_is_named_after_its_last_backslash() {
        // Absolute where the test runs; only the separator before the name differs.
        #[cfg(unix)]
        let zip = r"/Users/p/Desktop\harness-logs-20261118-1030.zip";
        #[cfg(windows)]
        let zip = r"C:\Users\p\Desktop\harness-logs-20261118-1030.zip";
        assert!(bundle_path(zip, true));
        // A unix file name may hold a `\`: the name is then all of `Desktop\…`.
        assert!(!bundle_path(zip, false));
    }

    #[test]
    fn a_windows_path_with_a_quote_is_no_bundle() {
        // Explorer reads the path between quotes, which one inside would end. Windows forbids it in a path; unix
        // does not.
        #[cfg(unix)]
        let zip = r#"/Users/p/a"b\harness-logs-20261118-1030.zip"#;
        #[cfg(windows)]
        let zip = r#"C:\Users\p\a"b\harness-logs-20261118-1030.zip"#;
        assert!(!bundle_path(zip, true));
        #[cfg(unix)]
        assert!(bundle_path(r#"/Users/p/a"b/harness-logs-20261118-1030.zip"#, false));
    }

    #[cfg(unix)]
    #[test]
    fn the_export_is_one_fixed_run() {
        let home = Path::new("/Users/p");
        let fake = Fake::new();
        fake.script("logs export --json", &["note", GOOD]);
        let exported = Exported { zip: PathBuf::from(ZIP), shown: format!("~/Desktop/{NAME}") };
        assert_eq!(export(&fake.cli(), home), Ok(exported));
        assert_eq!(fake.calls(), ["logs export --json"]);
        let failures: [(&[&str], Duration, ExportFailure); 2] =
            [(&[GOOD, "@exit 1"], EXPORT_DEADLINE, NoAnswer), (&["@hang"], SHORT, TimedOut)];
        for (lines, deadline, failure) in failures {
            let fake = Fake::new();
            fake.script("logs export --json", lines);
            assert_eq!(export_within(&fake.cli(), home, deadline), Err(failure), "{lines:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_that_cannot_start() {
        let fake = Fake::new();
        fake.script("logs export --json", &[GOOD]);
        let cli = fake.cli();
        fs::remove_file(fake.program()).unwrap();
        assert_eq!(export(&cli, Path::new("/Users/p")), Err(NoAnswer));
        assert!(fake.calls().is_empty());
    }

    // `~/Desktop/…` with a unix separator.
    #[cfg(unix)]
    #[test]
    fn the_home_reads_as_a_tilde() {
        for home in ["/Users/p", "/Users/p/"] {
            assert_eq!(shown(Path::new("/Users/p/Desktop/x.zip"), Path::new(home)), "~/Desktop/x.zip", "{home}");
        }
        for elsewhere in ["/Volumes/Work/x.zip", "/Users/pp/x.zip"] {
            assert_eq!(shown(Path::new(elsewhere), Path::new("/Users/p")), elsewhere);
        }
    }

    // `~\Desktop\…` with Windows' separator.
    #[cfg(windows)]
    #[test]
    fn the_home_reads_as_a_tilde() {
        for home in [r"C:\Users\p", r"C:\Users\p\"] {
            assert_eq!(shown(Path::new(r"C:\Users\p\Desktop\x.zip"), Path::new(home)), r"~\Desktop\x.zip", "{home}");
        }
        for elsewhere in [r"D:\Work\x.zip", r"C:\Users\pp\x.zip"] {
            assert_eq!(shown(Path::new(elsewhere), Path::new(r"C:\Users\p")), elsewhere);
        }
    }

    #[test]
    fn every_failure_has_its_fixed_reason() {
        assert_eq!(reason(TimedOut), "timed out");
        assert_eq!(reason(NoAnswer), "Harness did not answer");
        assert_eq!(reason(NoFile), "no file");
    }
}
