#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fake;
    use crate::types::{Vscode, VscodeFailure};
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(5);
    const SHORT: Duration = Duration::from_millis(300);
    const STATUS: &str = "device vscode status --json";
    const ENABLE: &str = "device vscode enable";

    #[cfg(unix)]
    #[test]
    fn status_reads_the_three_words() {
        let cases = [
            (r#"{"vscode":"off"}"#, Vscode::Off),
            (r#"{"vscode":"on","version":"0.6.60"}"#, Vscode::On),
            (r#"{"vscode":"absent"}"#, Vscode::Absent),
        ];
        for (line, vscode) in cases {
            let fake = Fake::new();
            fake.script(STATUS, &[line]);
            assert_eq!(status(&fake.cli()), Some(vscode), "{line}");
            assert_eq!(fake.calls(), [STATUS], "{line}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_with_no_such_word_is_none() {
        let cases: [(&[&str], Duration); 6] = [
            // An older CLI: its usage, and exit 1.
            (&["@err Usage: harness device <claude|codex|orca>", "@exit 1"], WAIT),
            (&["Visual Studio Code is off"], WAIT),
            (&[r#"{"vscode":"later"}"#], WAIT),
            (&[r#"{"enabled":true}"#], WAIT),
            (&[r#"{"vscode":"off"}"#, "@exit 1"], WAIT),
            (&["@hang"], SHORT),
        ];
        for (case, (lines, deadline)) in cases.into_iter().enumerate() {
            let fake = Fake::new();
            fake.script(STATUS, lines);
            assert_eq!(status_within(&fake.cli(), deadline), None, "case {case}");
        }
        // No script: the fake says `Unknown command` and exits 1.
        assert_eq!(status(&Fake::new().cli()), None);
    }

    #[cfg(unix)]
    #[test]
    fn turn_on_is_ok_only_when_it_says_on() {
        let fake = Fake::new();
        fake.script(ENABLE, &[r#"{"vscode":"on","version":"0.6.60"}"#]);
        assert_eq!(turn_on(&fake.cli()), Ok(()));
        assert_eq!(fake.calls(), [ENABLE]);

        let cases: [&[&str]; 4] = [
            &[r#"{"vscode":"off"}"#],
            &[r#"{"vscode":"on"}"#, "@exit 1"],
            &["installed"],
            &[],
        ];
        for lines in cases {
            let fake = Fake::new();
            fake.script(ENABLE, lines);
            assert_eq!(turn_on(&fake.cli()), Err(VscodeFailure::Failed), "{lines:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failure_keeps_the_clis_word_and_no_other_text() {
        let cases: [(&[&str], Duration, VscodeFailure); 6] = [
            (&[r#"{"vscode":"off","error":"no-code"}"#, "@exit 1"], WAIT, VscodeFailure::NoCode),
            (&[r#"{"vscode":"off","error":"timeout"}"#, "@exit 1"], WAIT, VscodeFailure::Timeout),
            (&[r#"{"vscode":"off","error":"failed"}"#, "@exit 1"], WAIT, VscodeFailure::Failed),
            // A word it does not know, which may be any text: none of it is kept.
            (&[r#"{"vscode":"off","error":"/Users/someone/.vscode"}"#, "@exit 1"], WAIT, VscodeFailure::Failed),
            (&[r#"{"vscode":"off","error":7}"#, "@exit 1"], WAIT, VscodeFailure::Failed),
            (&["@hang"], SHORT, VscodeFailure::Timeout),
        ];
        for (case, (lines, deadline, failure)) in cases.into_iter().enumerate() {
            let fake = Fake::new();
            fake.script(ENABLE, lines);
            assert_eq!(turn_on_within(&fake.cli(), deadline), Err(failure), "case {case}");
        }
        let words = [VscodeFailure::NoCode, VscodeFailure::Timeout, VscodeFailure::Failed].map(VscodeFailure::as_str);
        assert_eq!(words, ["no-code", "timeout", "failed"]);
        assert_eq!(TURN_ON_DEADLINE, Duration::from_secs(90));
    }
}
