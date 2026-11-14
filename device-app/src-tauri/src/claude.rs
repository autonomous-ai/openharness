//! `harness device claude status|enable|disable`.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fake;
    use crate::types::ClaudeStatus;

    #[cfg(unix)]
    #[test]
    fn status_reads_the_four_fields() {
        let fake = Fake::new();
        fake.script(
            "device claude status --json",
            &[r#"{"supported":true,"installed":true,"enabled":false,"claudeVersion":"2.1.0"}"#],
        );
        assert_eq!(
            status(&fake.cli()),
            Some(ClaudeStatus {
                supported: true,
                installed: true,
                enabled: false,
                claude_version: Some("2.1.0".into())
            })
        );
        assert_eq!(fake.calls(), ["device claude status --json"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_without_the_command_has_no_claude() {
        // No script: the fake says `Unknown command` and exits 1.
        let fake = Fake::new();
        assert_eq!(status(&fake.cli()), None);
        for lines in [
            &["Usage: harness device <command>", "  status"][..],
            &["[]"][..],
        ] {
            let fake = Fake::new();
            fake.script("device claude status --json", lines);
            assert_eq!(status(&fake.cli()), None, "{lines:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn on_and_off_run_one_command_each() {
        for (on, call) in [
            (true, "device claude enable"),
            (false, "device claude disable"),
        ] {
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
        let cases: [(&[&str], String); 4] = [
            (
                &["@err ✗ Could not write Claude Code's settings.", "@exit 1"],
                "Could not write Claude Code's settings.".into(),
            ),
            (
                &[r#"{"error":"Claude Code is too old."}"#, "@exit 1"],
                "Claude Code is too old.".into(),
            ),
            (&["@exit 1"], FAILED.into()),
            (&[&long, "@exit 1"], "x".repeat(200)),
        ];
        for (lines, why) in cases {
            let fake = Fake::new();
            fake.script("device claude enable", lines);
            assert_eq!(set(&fake.cli(), true), Err(why), "{lines:?}");
        }
    }
}
