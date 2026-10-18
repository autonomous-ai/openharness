//! The real `Harness.exe` launch path: it starts `app\<current>\harness-desktop.exe` from its version folder with the
//! link it was given and exits; `--wait-pid` waits for the app being replaced; a broken install
//! exits 3 and says why in launch.log. The app is this test's own executable (desktop_common).
mod desktop_common;

use std::fs;
use std::time::{Duration, Instant};

use desktop_common::*;

fn main() {
    desktop_common::main(&[
        (
            "starts_the_current_version_with_the_link_from_its_folder",
            starts_the_current_version_with_the_link_from_its_folder,
        ),
        (
            "waits_for_the_app_being_replaced",
            waits_for_the_app_being_replaced,
        ),
        (
            "a_broken_install_exits_3_and_says_why_in_the_log",
            a_broken_install_exits_3_and_says_why_in_the_log,
        ),
        ("a_usage_error_exits_2", a_usage_error_exits_2),
        (
            "starts_from_its_own_folder_without_an_override",
            starts_from_its_own_folder_without_an_override,
        ),
        (
            "a_relative_override_is_resolved_from_the_callers_folder",
            a_relative_override_is_resolved_from_the_callers_folder,
        ),
        (
            "an_already_exited_app_does_not_block_launch",
            an_already_exited_app_does_not_block_launch,
        ),
        (
            "a_resolved_app_that_cannot_spawn_exits_4",
            a_resolved_app_that_cannot_spawn_exits_4,
        ),
        (
            "an_invalid_wait_fails_without_starting_the_app",
            an_invalid_wait_fails_without_starting_the_app,
        ),
    ]);
}

fn starts_the_current_version_with_the_link_from_its_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(ODD_NAME).join("Harness");
    put_app(&root, "1.2.3");
    point(&root, "current", "1.2.3");
    let out = dir.path().join("report.json");
    let started = Instant::now();
    let args = [
        "harness://notification/machine 1/agent",
        "",
        r#"a\"b"#,
        r"C:\a b\",
        "Nguyễn 日",
    ];
    let status = launcher()
        .args(args)
        .env("HARNESS_DESKTOP_INSTALL_ROOT", &root)
        .env(STANDIN_OUT, &out)
        .env(STANDIN_SLEEP_MS, "3000")
        .status()
        .unwrap();
    let elapsed = started.elapsed();
    assert!(status.success(), "{status:?}");
    let report = report(&out);
    finish_app(&report);
    // It does not wait for the app.
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    assert_eq!(report["args"], serde_json::json!(args));
    assert!(same(
        report["cwd"].as_str().unwrap().as_ref(),
        &root.join("app").join("1.2.3")
    ));
    // The one line allowed is a job's refused breakaway: an SSH session's job is one, and the app then starts in it.
    let log = fs::read_to_string(root.join("launch.log")).unwrap_or_default();
    assert!(
        log.lines().all(|line| line.contains("refuses a breakaway")),
        "{log}"
    );
}

fn waits_for_the_app_being_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Harness");
    put_app(&root, "1.2.3");
    point(&root, "current", "1.2.3");
    // The app being replaced: this executable as the stand-in, for two seconds.
    let mut old = stand_in_command()
        .env(STANDIN_OUT, dir.path().join("old.json"))
        .env(STANDIN_SLEEP_MS, "2000")
        .spawn()
        .unwrap();
    report(&dir.path().join("old.json"));
    let pid = old.id();
    // Reap concurrently: Unix kill(pid, 0) otherwise still sees the exited zombie.
    let reaper = std::thread::spawn(move || old.wait().unwrap());
    let started = Instant::now();
    let out = dir.path().join("new.json");
    let status = launcher()
        .args(["--wait-pid", &pid.to_string()])
        .env("HARNESS_DESKTOP_INSTALL_ROOT", &root)
        .env(STANDIN_OUT, &out)
        .status()
        .unwrap();
    let elapsed = started.elapsed();
    assert!(reaper.join().unwrap().success());
    assert!(status.success());
    let report = report(&out);
    finish_app(&report);
    assert!(
        elapsed >= Duration::from_millis(1500) && elapsed < Duration::from_secs(10),
        "{elapsed:?}"
    );
    assert_eq!(report["args"], serde_json::json!([]));
}

fn a_broken_install_exits_3_and_says_why_in_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let output = launcher()
        .env("HARNESS_DESKTOP_INSTALL_ROOT", dir.path())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Download Harness again"));
    assert!(
        fs::read_to_string(dir.path().join("launch.log"))
            .unwrap()
            .contains("`current` is missing")
    );
}

fn a_usage_error_exits_2() {
    let output = launcher().args(["--install", "now"]).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("usage:"));
}

fn starts_from_its_own_folder_without_an_override() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(ODD_NAME).join("Harness");
    put_app(&root, "1.2.3");
    point(&root, "current", "1.2.3");
    let exe = root.join("Harness.exe");
    fs::copy(LAUNCHER, &exe).unwrap();
    let out = dir.path().join("report.json");
    let status = isolated_command(&exe)
        .arg("harness://own-folder")
        .env(STANDIN_OUT, &out)
        .status()
        .unwrap();
    assert!(status.success());
    let value = report(&out);
    finish_app(&value);
    assert_eq!(value["args"], serde_json::json!(["harness://own-folder"]));
    assert!(same(
        value["cwd"].as_str().unwrap().as_ref(),
        &root.join("app/1.2.3")
    ));
}

fn a_relative_override_is_resolved_from_the_callers_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("relative-root");
    put_app(&root, "1.2.3");
    point(&root, "current", "1.2.3");
    let out = dir.path().join("report.json");
    let status = launcher()
        .current_dir(dir.path())
        .env("HARNESS_DESKTOP_INSTALL_ROOT", "relative-root")
        .env(STANDIN_OUT, &out)
        .status()
        .unwrap();
    assert!(status.success());
    let value = report(&out);
    finish_app(&value);
    assert!(same(
        value["cwd"].as_str().unwrap().as_ref(),
        &root.join("app/1.2.3")
    ));
}

fn an_already_exited_app_does_not_block_launch() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Harness");
    put_app(&root, "1.2.3");
    point(&root, "current", "1.2.3");
    let mut old = stand_in_command()
        .env(STANDIN_OUT, dir.path().join("old.json"))
        .spawn()
        .unwrap();
    let pid = old.id();
    assert!(old.wait().unwrap().success());
    drop(old);
    let out = dir.path().join("new.json");
    let started = Instant::now();
    let status = launcher()
        .args(["--wait-pid", &pid.to_string()])
        .env("HARNESS_DESKTOP_INSTALL_ROOT", &root)
        .env(STANDIN_OUT, &out)
        .status()
        .unwrap();
    assert!(status.success());
    assert!(started.elapsed() < Duration::from_secs(10));
    finish_app(&report(&out));
}

fn a_resolved_app_that_cannot_spawn_exits_4() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app/1.2.3");
    fs::create_dir_all(&app).unwrap();
    fs::write(app.join("harness-desktop.exe"), b"not an executable").unwrap();
    point(dir.path(), "current", "1.2.3");
    let output = launcher()
        .env("HARNESS_DESKTOP_INSTALL_ROOT", dir.path())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    assert!(
        fs::read_to_string(dir.path().join("launch.log"))
            .unwrap()
            .contains("could not start")
    );
}

fn an_invalid_wait_fails_without_starting_the_app() {
    // PID 0 is rejected by parsing on every platform. On Unix a Windows-sized pid
    // is syntactically valid but must never wrap into a process-group probe.
    let dir = tempfile::tempdir().unwrap();
    put_app(dir.path(), "1.2.3");
    point(dir.path(), "current", "1.2.3");
    let out = dir.path().join("new.json");
    let invalid = if cfg!(unix) { u32::MAX } else { 0 };
    let output = launcher()
        .args(["--wait-pid", &invalid.to_string()])
        .env("HARNESS_DESKTOP_INSTALL_ROOT", dir.path())
        .env(STANDIN_OUT, &out)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(if cfg!(unix) { 1 } else { 2 }));
    assert!(!out.exists());
    if cfg!(unix) {
        assert!(String::from_utf8_lossy(&output.stderr).contains("Close Harness and try again"));
        assert!(
            fs::read_to_string(dir.path().join("launch.log"))
                .unwrap()
                .contains("could not wait")
        );
    }
}
