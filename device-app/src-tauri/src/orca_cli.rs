//! `harness device orca status --json` and `harness device orca connect [--approve <fingerprint>] --json`: the CLI
//! does all of the work with Orca, and the app reads the one line each prints.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{HarnessCli, find_cli};
    use crate::testing::Fake;
    use crate::types::{Fingerprint, MemoryLog, OrcaAnswer, OrcaError, OrcaStatus};
    use serde_json::json;
    use std::fs;
    use std::sync::Arc;
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(5);
    const SHORT: Duration = Duration::from_millis(300);
    const STATUS: &str = "device orca status --json";
    const CONNECT: &str = "device orca connect --json";
    const FINGERPRINT: &str = "ap1-0123456789abcdef0123456789abcdef";
    const DONE: &str = r#"{"connect":"done"}"#;

    fn grants() -> Vec<String> {
        vec![
            "Runs its own code in a separate Node.js process on the Orca host.".into(),
            "Read your projects and workspaces.".into(),
        ]
    }

    /// The CLI's `approve` line, with the name and version the app does not read.
    fn approve_line(fingerprint: &str, grants: &[String], update: bool) -> String {
        json!({
            "connect": "approve",
            "name": "Harness Device",
            "version": "0.6.70",
            "fingerprint": fingerprint,
            "grants": grants,
            "update": update,
        })
        .to_string()
    }

    fn approve(grants: Vec<String>, update: bool) -> OrcaAnswer {
        OrcaAnswer::Approve { fingerprint: Fingerprint::parse(FINGERPRINT).unwrap(), grants, update }
    }

    /// What `connect` reads from a CLI that prints these lines.
    fn connected(lines: &[&str]) -> OrcaAnswer {
        let fake = Fake::new();
        fake.script(CONNECT, lines);
        let answer = connect(&fake.cli(), None);
        assert_eq!(fake.calls(), [CONNECT]);
        answer
    }

    /// A CLI that is there and cannot be run, with the folder that holds it.
    fn unstartable() -> (tempfile::TempDir, HarnessCli) {
        let folder = tempfile::tempdir().unwrap();
        let program = folder.path().join("harness");
        fs::write(&program, "").unwrap();
        let cli =
            HarnessCli::new(find_cli(folder.path(), None, Some(&program)).unwrap(), Arc::new(MemoryLog::default()));
        (folder, cli)
    }

    #[cfg(unix)]
    #[test]
    fn status_reads_each_state() {
        let states = [
            ("absent", OrcaStatus::Absent),
            ("offer", OrcaStatus::Offer),
            ("off", OrcaStatus::Off),
            ("approve", OrcaStatus::Approve),
            ("behind", OrcaStatus::Behind),
            ("current", OrcaStatus::Current),
        ];
        for (word, state) in states {
            let fake = Fake::new();
            fake.script(STATUS, &[&format!(r#"{{"orca":"{word}"}}"#)]);
            assert_eq!(status(&fake.cli()), Some(state), "{word}");
            assert_eq!(fake.calls(), [STATUS], "{word}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_from_before_the_command() {
        // No script: the fake prints `Unknown command` on stderr and exits 1, as an older CLI prints its usage.
        let fake = Fake::new();
        assert_eq!(status(&fake.cli()), None);
        assert_eq!(fake.calls(), [STATUS]);
    }

    #[cfg(unix)]
    #[test]
    fn a_status_nobody_can_read_is_none() {
        let cases: [(&[&str], Duration); 4] = [
            (&[r#"{"orca":"later"}"#], WAIT),
            (&["offer"], WAIT),
            // It exits 0 in every state: any other end is a run that failed, whatever it printed.
            (&[r#"{"orca":"offer"}"#, "@exit 1"], WAIT),
            (&["@hang"], SHORT),
        ];
        for (case, (lines, deadline)) in cases.into_iter().enumerate() {
            let fake = Fake::new();
            fake.script(STATUS, lines);
            assert_eq!(status_within(&fake.cli(), deadline), None, "case {case}");
        }
        let (_folder, cli) = unstartable();
        assert_eq!(status(&cli), None);
    }

    #[cfg(unix)]
    #[test]
    fn connect_reads_its_line() {
        assert_eq!(connected(&[DONE]), OrcaAnswer::Done);
        for update in [false, true] {
            assert_eq!(connected(&[&approve_line(FINGERPRINT, &grants(), update)]), approve(grants(), update));
        }
        let codes = [
            ("not-running", OrcaError::NotRunning),
            ("no-plugin", OrcaError::NoPlugin),
            ("off", OrcaError::Off),
            ("timeout", OrcaError::Timeout),
            ("failed", OrcaError::Failed),
            // A newer CLI's code.
            ("later", OrcaError::Failed),
        ];
        for (code, error) in codes {
            let line = format!(r#"{{"connect":"failed","error":"{code}"}}"#);
            assert_eq!(connected(&[&line, "@exit 1"]), OrcaAnswer::Failed(error), "{code}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn connect_passes_the_fingerprint_only_when_handed_one() {
        let fake = Fake::new();
        let approved = format!("device orca connect --approve {FINGERPRINT} --json");
        fake.script(CONNECT, &[&approve_line(FINGERPRINT, &grants(), false)]);
        fake.script(&approved, &[DONE]);
        let cli = fake.cli();
        let OrcaAnswer::Approve { fingerprint, .. } = connect(&cli, None) else { panic!("no approve answer") };
        assert_eq!(connect(&cli, Some(&fingerprint)), OrcaAnswer::Done);
        assert_eq!(fake.calls(), [CONNECT, approved.as_str()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_fingerprint_off_the_pattern_is_never_an_answer() {
        let hex = &FINGERPRINT[4..];
        let fingerprints = [
            format!("AP1-{hex}"),
            format!("ap1-{}", &hex[1..]),
            format!("ap1-{hex}0"),
            format!("ap1-{}A", &hex[1..]),
            format!("{FINGERPRINT} "),
            String::new(),
        ];
        for fingerprint in fingerprints {
            let line = approve_line(&fingerprint, &grants(), false);
            assert_eq!(connected(&[&line]), OrcaAnswer::Failed(OrcaError::Failed), "{fingerprint:?}");
        }
        let line = json!({"connect": "approve", "fingerprint": 7, "grants": grants(), "update": false}).to_string();
        assert_eq!(connected(&[&line]), OrcaAnswer::Failed(OrcaError::Failed));
    }

    #[cfg(unix)]
    #[test]
    fn grants_past_ten_lines_or_300_characters_are_failed() {
        // Characters of two bytes: a count of bytes would fail these.
        let longest = vec!["é".repeat(300); 10];
        assert_eq!(connected(&[&approve_line(FINGERPRINT, &longest, false)]), approve(longest, false));
        let past = [
            vec!["Read your projects.".to_string(); 11],
            vec!["é".repeat(301)],
            vec!["Read your projects\nand more.".into()],
            vec!["Read\tyour projects.".into()],
            vec!["Read your projects.\u{7}".into()],
        ];
        for grants in past {
            let line = approve_line(FINGERPRINT, &grants, false);
            assert_eq!(connected(&[&line]), OrcaAnswer::Failed(OrcaError::Failed), "{grants:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_approve_line_with_no_grant() {
        // The CLI drops a blank grant and fails an answer with none left: one here would ask for a click on an empty
        // list, or an empty line in it.
        for listed in [vec![], vec![String::new()], vec![" ".into()], vec![grants()[0].clone(), " ".into()]] {
            let line = approve_line(FINGERPRINT, &listed, false);
            assert_eq!(connected(&[&line]), OrcaAnswer::Failed(OrcaError::Failed), "{listed:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn no_line_or_a_run_past_its_deadline_is_failed() {
        let failed = OrcaAnswer::Failed(OrcaError::Failed);
        assert_eq!(connected(&[]), failed);
        assert_eq!(connected(&["done"]), failed);
        assert_eq!(connected(&[r#"{"connect":"later"}"#]), failed);
        // A CLI from before the command.
        let fake = Fake::new();
        assert_eq!(connect(&fake.cli(), None), failed);
        let (_folder, cli) = unstartable();
        assert_eq!(connect(&cli, None), failed);
        let fake = Fake::new();
        fake.script(CONNECT, &["@hang"]);
        assert_eq!(connect_within(&fake.cli(), None, SHORT), OrcaAnswer::Failed(OrcaError::Timeout));
    }
}
