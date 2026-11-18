//! `harness logs export --json`: the zip it wrote, read from its answer before `open` is run with it.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::LINE_MAX;
    use crate::testing::Fake;
    use crate::types::ExportFailure::{NoAnswer, NoFile, TimedOut};
    use serde_json::json;
    use std::fs;

    const NAME: &str = "harness-logs-20261118-1030.zip";
    const ZIP: &str = "/Users/p/Desktop/harness-logs-20261118-1030.zip";
    const GOOD: &str = r#"{"path":"/Users/p/Desktop/harness-logs-20261118-1030.zip","included":["a"],"bytes":9}"#;
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
        no_file.extend(
            [
                "tmp/harness-logs-20261118-1030.zip",
                "/tmp/evil.zip",
                "/tmp/harness-logs-2026118-1030.zip",
                "/tmp/harness-logs-20261118-1030.zip.sh",
                "/tmp/xharness-logs-20261118-1030.zip",
                "/tmp/harness-logs-20261118-1030.zip/",
                // Digits of another script are no date the CLI writes.
                "/tmp/harness-logs-٢٠٢٦١١١٨-1030.zip",
            ]
            .map(naming),
        );
        for (case, output) in no_file.iter().enumerate() {
            assert_eq!(parse(output), Err(NoFile), "no file {case}: {output:?}");
        }
        let timed_out = Output { timed_out: true, ..ended(0, &good) };
        assert_eq!(parse(&timed_out), Err(TimedOut));
    }

    #[test]
    fn a_path_that_is_no_menu_line() {
        let longest = format!("/{}/{NAME}", "a".repeat(1024 - NAME.len() - 2));
        assert_eq!(longest.len(), 1024);
        assert_eq!(parse(&naming(&longest)), Ok(PathBuf::from(&longest)));
        let too_long = format!("/{}/{NAME}", "a".repeat(1025 - NAME.len() - 2));
        let breaks =
            ["\n", "\r", "\t", "\u{7f}", "\u{85}", "\u{2028}", "\u{2029}"].map(|text| format!("/tmp/a{text}b/{NAME}"));
        for path in breaks.iter().chain([&too_long]) {
            assert_eq!(parse(&naming(path)), Err(NoFile), "{path:?}");
        }
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

    #[test]
    fn the_home_reads_as_a_tilde() {
        for home in ["/Users/p", "/Users/p/"] {
            assert_eq!(shown(Path::new("/Users/p/Desktop/x.zip"), Path::new(home)), "~/Desktop/x.zip", "{home}");
        }
        for elsewhere in ["/Volumes/Work/x.zip", "/Users/pp/x.zip"] {
            assert_eq!(shown(Path::new(elsewhere), Path::new("/Users/p")), elsewhere);
        }
    }

    #[test]
    fn the_reveal_is_open_r_on_a_mac_and_the_folder_elsewhere() {
        assert_eq!(reveal_args("macos", Path::new(ZIP)), ["-R", ZIP]);
        assert_eq!(reveal_args("linux", Path::new(ZIP)), ["/Users/p/Desktop"]);
    }

    #[test]
    fn every_failure_has_its_fixed_reason() {
        assert_eq!(reason(TimedOut), "timed out");
        assert_eq!(reason(NoAnswer), "Harness did not answer");
        assert_eq!(reason(NoFile), "no file");
    }
}
