//! `harness device codex status|enable|disable`.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fake;
    use crate::types::CodexStatus;

    #[cfg(unix)]
    #[test]
    fn status_reads_the_three_fields() {
        let fake = Fake::new();
        fake.script("device codex status --json", &[r#"{"supported":true,"installed":true,"enabled":false}"#]);
        assert_eq!(status(&fake.cli()), Some(CodexStatus { supported: true, installed: true, enabled: false }));
        assert_eq!(fake.calls(), ["device codex status --json"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_without_the_command_has_no_codex() {
        // No script: the fake says `Unknown command` and exits 1.
        let fake = Fake::new();
        assert_eq!(status(&fake.cli()), None);
        for lines in [&["Usage: harness device <command>", "  status"][..], &["[]"][..]] {
            let fake = Fake::new();
            fake.script("device codex status --json", lines);
            assert_eq!(status(&fake.cli()), None, "{lines:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_line_without_supported_is_not_a_status() {
        let fake = Fake::new();
        fake.script("device codex status --json", &[r#"{"error":"x"}"#, "{}"]);
        assert_eq!(status(&fake.cli()), None);
    }

    #[cfg(unix)]
    #[test]
    fn on_and_off_run_one_command_each() {
        for (on, call) in [(true, "device codex enable"), (false, "device codex disable")] {
            let fake = Fake::new();
            fake.script(call, &["Done."]);
            assert_eq!(set(&fake.cli(), on), Ok(()));
            assert_eq!(fake.calls(), [call]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failure_says_why() {
        let long = "x".repeat(300);
        let cases: [(&[&str], String); 3] = [
            (&["@err Codex is not on this computer.", "@exit 1"], "Codex is not on this computer.".into()),
            (&["@exit 1"], FAILED.into()),
            (&[&long, "@exit 1"], "x".repeat(200)),
        ];
        for (lines, why) in cases {
            let fake = Fake::new();
            fake.script("device codex enable", lines);
            assert_eq!(set(&fake.cli(), true), Err(why), "{lines:?}");
        }
    }
}
