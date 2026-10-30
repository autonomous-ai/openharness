//! The binary's own surface, on every OS: usage and version need no Windows.
use std::process::Command;

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_harness-serial"))
        .args(args)
        .output()
        .expect("harness-serial runs")
}

#[test]
fn a_bad_command_line_is_a_usage_error() {
    for args in [&["open"][..], &["open", "NUL"][..], &[][..]] {
        let out = run(args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("usage: harness-serial"),
            "{args:?}"
        );
    }
}

#[test]
fn version_prints_one_json_line() {
    let out = run(&["version"]);
    assert_eq!(out.status.code(), Some(0));
    let line = String::from_utf8(out.stdout).unwrap();
    assert!(
        line.starts_with(r#"{"version":""#) && line.trim_end().ends_with(r#","protocol":1}"#),
        "{line}"
    );
}
