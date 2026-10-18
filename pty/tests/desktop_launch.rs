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
            "a_relative_override_is_rejected_before_launch",
            a_relative_override_is_rejected_before_launch,
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
        (
            "invalid_explicit_overrides_never_launch",
            invalid_explicit_overrides_never_launch,
        ),
        (
            "empty_overrides_keep_portable_launch",
            empty_overrides_keep_portable_launch,
        ),
        #[cfg(windows)]
        (
            "windowless_original_survives_ended_secondary_attempts",
            windows_rollback::windowless_original_survives_ended_secondary_attempts,
        ),
        #[cfg(windows)]
        (
            "two_starts_without_a_window_go_back_to_previous",
            windows_rollback::two_starts_without_a_window_go_back_to_previous,
        ),
        #[cfg(windows)]
        (
            "slow_starts_stay_current_and_a_marker_forgets_old_failures",
            windows_rollback::slow_starts_stay_current_and_a_marker_forgets_old_failures,
        ),
        #[cfg(windows)]
        (
            "contended_history_does_not_spawn_then_recovers",
            windows_rollback::contended_history_does_not_spawn_then_recovers,
        ),
    ]);
}

fn launcher_at(root: &std::path::Path) -> std::process::Command {
    let mut command = launcher();
    command
        .env("HARNESS_DESKTOP_INSTALL_ROOT", root)
        .env("HARNESS_DESKTOP_PROGRAMS_DIR", root.join("test-programs"))
        .env(
            "HARNESS_DESKTOP_REGISTRY_ROOT",
            format!(r"Software\HarnessTest\{}", uuid::Uuid::new_v4().simple()),
        )
        .env("USERPROFILE", root.join("test-profile"))
        .env("HOME", root.join("test-profile"));
    command
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
    let status = launcher_at(&root)
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
    let state: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("launch-state.json")).unwrap()).unwrap();
    assert_eq!(state["starts"][0]["version"], "1.2.3");
    // Success and B's refused-breakaway warning are bounded launcher diagnostics.
    let log = fs::read_to_string(root.join("launch.log")).unwrap_or_default();
    assert!(
        log.lines()
            .all(|line| line.contains("refuses a breakaway")
                || line.contains("started 1.2.3 (process ")),
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
    let status = launcher_at(&root)
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
    let output = launcher_at(dir.path())
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

fn a_relative_override_is_rejected_before_launch() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("relative-root");
    put_app(&root, "1.2.3");
    point(&root, "current", "1.2.3");
    let out = dir.path().join("report.json");
    let output = launcher_at(&root)
        .current_dir(dir.path())
        .env("HARNESS_DESKTOP_INSTALL_ROOT", "relative-root")
        .env(STANDIN_OUT, &out)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("not a full path"));
    assert!(!out.exists());
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
    let status = launcher_at(&root)
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
    let output = launcher_at(dir.path())
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
    let output = launcher_at(dir.path())
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

fn invalid_explicit_overrides_never_launch() {
    for case in [
        "install_only",
        "invalid_registry",
        "relative_programs",
        "relative_install",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Harness");
        put_app(&root, "1.2.3");
        point(&root, "current", "1.2.3");
        let out = dir.path().join("report.json");
        let mut command = launcher();
        command
            .current_dir(dir.path())
            .env("USERPROFILE", dir.path())
            .env("HOME", dir.path())
            .env("HARNESS_DESKTOP_INSTALL_ROOT", &root)
            .env("HARNESS_DESKTOP_PROGRAMS_DIR", dir.path().join("programs"))
            .env(
                "HARNESS_DESKTOP_REGISTRY_ROOT",
                r"Software\HarnessTest\invalid-launch",
            )
            .env(STANDIN_OUT, &out);
        match case {
            "install_only" => {
                command
                    .env_remove("HARNESS_DESKTOP_PROGRAMS_DIR")
                    .env_remove("HARNESS_DESKTOP_REGISTRY_ROOT");
            }
            "invalid_registry" => {
                command.env("HARNESS_DESKTOP_REGISTRY_ROOT", r"\Software");
            }
            "relative_programs" => {
                command.env("HARNESS_DESKTOP_PROGRAMS_DIR", "relative");
            }
            "relative_install" => {
                command.env("HARNESS_DESKTOP_INSTALL_ROOT", "Harness");
            }
            _ => unreachable!(),
        }
        let output = command.output().unwrap();
        // RED must not leave the incorrectly started fixture process mapped.
        if output.status.success() {
            finish_app(&report(&out));
        }
        assert_eq!(
            output.status.code(),
            Some(1),
            "{case}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!out.exists(), "{case}");
        assert!(
            !root.join("launch.log").exists(),
            "invalid overrides did not reach wait/healing"
        );
    }
}

fn empty_overrides_keep_portable_launch() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Harness");
    put_app(&root, "1.2.3");
    point(&root, "current", "1.2.3");
    let exe = root.join("Harness.exe");
    fs::copy(LAUNCHER, &exe).unwrap();
    let out = dir.path().join("report.json");
    let output = isolated_command(exe)
        .env("HARNESS_DESKTOP_INSTALL_ROOT", "")
        .env("HARNESS_DESKTOP_PROGRAMS_DIR", "")
        .env("HARNESS_DESKTOP_REGISTRY_ROOT", "")
        .env(STANDIN_OUT, &out)
        .output()
        .unwrap();
    assert!(output.status.success());
    finish_app(&report(&out));
}

/// Windows-only real-binary rollback with positively owned app/launcher lifetimes.
#[cfg(windows)]
mod windows_rollback {
    use super::*;
    use desktop_common::owned_windows::OwnedProcesses;
    use harness_pty::desktop::{launch, pointer, win};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output, Stdio};

    struct World {
        owned: OwnedProcesses,
        dir: tempfile::TempDir,
        root: PathBuf,
        profile: PathBuf,
        id: String,
    }
    impl Drop for World {
        fn drop(&mut self) {
            if let Err(error) = self.owned.cleanup(Duration::from_secs(5)) {
                self.dir.disable_cleanup(true);
                eprintln!(
                    "owned rollback cleanup uncertain; retained {}: {error}",
                    self.dir.path().display()
                );
                if !std::thread::panicking() {
                    panic!("owned rollback cleanup: {error}");
                }
                return;
            }
            win::delete_key(r"Software\HarnessTest", &self.id).unwrap();
        }
    }
    impl World {
        fn new() -> Self {
            let dir = tempfile::Builder::new().prefix(ODD_NAME).tempdir().unwrap();
            let profile = dir.path().join(ODD_NAME);
            let root = profile
                .join("AppData")
                .join("Local")
                .join("Programs")
                .join("Harness");
            for v in ["1.0.0", "2.0.0"] {
                put_app(&root, v);
            }
            point(&root, "current", "2.0.0");
            point(&root, "previous", "1.0.0");
            fs::write(root.join("app").join("1.0.0").join(".started"), b"once").unwrap();
            fs::copy(LAUNCHER, root.join("Harness.exe")).unwrap();
            for path in [
                profile.join("AppData").join("Roaming"),
                profile.join("Temp"),
            ] {
                fs::create_dir_all(path).unwrap();
            }
            let world = Self {
                owned: OwnedProcesses::new(dir.path()),
                dir,
                root,
                profile,
                id: uuid::Uuid::new_v4().simple().to_string(),
            };
            world.owned.allow(&world.root.join("Harness.exe")).unwrap();
            for v in ["1.0.0", "2.0.0"] {
                world.owned.allow(&world.app(v)).unwrap();
            }
            world
        }
        fn app(&self, v: &str) -> PathBuf {
            self.root.join("app").join(v).join("harness-desktop.exe")
        }
        fn command(&self, out: &Path, sleep_ms: u32) -> Command {
            let mut cmd = isolated_command(self.root.join("Harness.exe"));
            cmd.env("USERPROFILE", &self.profile)
                .env("HOME", &self.profile)
                .env("APPDATA", self.profile.join("AppData").join("Roaming"))
                .env("LOCALAPPDATA", self.profile.join("AppData").join("Local"))
                .env("TEMP", self.profile.join("Temp"))
                .env("TMP", self.profile.join("Temp"))
                .env("HARNESS_DESKTOP_INSTALL_ROOT", &self.root)
                .env(
                    "HARNESS_DESKTOP_PROGRAMS_DIR",
                    self.profile.join("Start Menu").join("Programs"),
                )
                .env(
                    "HARNESS_DESKTOP_REGISTRY_ROOT",
                    format!(r"Software\HarnessTest\{}", self.id),
                )
                .env("HARNESS_DESKTOP_INSTANCE", &self.id)
                .env(STANDIN_OUT, out)
                .env(STANDIN_SLEEP_MS, sleep_ms.to_string());
            cmd
        }
        fn output(&self, cmd: &mut Command) -> Output {
            let mut child = cmd
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            self.owned
                .observe_child(&child, &self.root.join("Harness.exe"), &[])
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(30);
            while child.try_wait().unwrap().is_none() {
                assert!(Instant::now() < deadline, "owned launcher timed out");
                std::thread::sleep(Duration::from_millis(10));
            }
            child.wait_with_output().unwrap()
        }
        fn start(&self, name: &str, sleep: u32) -> serde_json::Value {
            let out = self.dir.path().join(format!("{name}.json"));
            let output = self.output(&mut self.command(&out, sleep));
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let value = report(&out);
            let exe = Path::new(value["exe"].as_str().unwrap());
            assert!(same(exe, &self.app("1.0.0")) || same(exe, &self.app("2.0.0")));
            assert!(same(
                Path::new(value["env"]["USERPROFILE"].as_str().unwrap()),
                &self.profile
            ));
            assert_eq!(value["env"]["HARNESS_DESKTOP_INSTANCE"], self.id);
            self.owned
                .await_observed(exe, Duration::from_secs(5))
                .unwrap();
            value
        }
    }

    pub fn two_starts_without_a_window_go_back_to_previous() {
        let world = World::new();
        let mut versions = Vec::new();
        for n in 0..3 {
            let value = world.start(&format!("rollback-{n}"), 500);
            versions.push(
                Path::new(value["cwd"].as_str().unwrap())
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
            finish_app(&value);
        }
        assert_eq!(versions, ["2.0.0", "2.0.0", "1.0.0"]);
        assert_eq!(fs::read(world.root.join("current")).unwrap(), b"1.0.0\r\n");
        assert!(!world.root.join("previous").exists());
        assert!(launch::read_state(&world.root).starts.is_empty());
        assert!(
            fs::read_to_string(world.root.join("launch.log"))
                .unwrap()
                .contains("went back to 1.0.0")
        );
    }
    pub fn slow_starts_stay_current_and_a_marker_forgets_old_failures() {
        let world = World::new();
        let mut values = Vec::new();
        for n in 0..3 {
            values.push(world.start(&format!("slow-{n}"), 3000));
        }
        assert_eq!(pointer::read(&world.root.join("current")).unwrap(), "2.0.0");
        let history = launch::read_state(&world.root);
        assert_eq!(history.starts.len(), 1);
        assert_eq!(
            u64::from(history.starts[0].pid),
            values[0]["pid"].as_u64().unwrap()
        );
        for value in &values {
            finish_app(value);
        }
        fs::write(
            world.root.join("app").join("2.0.0").join(".started"),
            b"once",
        )
        .unwrap();
        finish_app(&world.start("marked", 500));
        assert_eq!(pointer::read(&world.root.join("current")).unwrap(), "2.0.0");
        assert!(launch::read_state(&world.root).starts.is_empty());
    }
    /// Actual recorded-process observation, not execution of the runner's 15s listener timeout.
    pub fn windowless_original_survives_ended_secondary_attempts() {
        use harness_pty::desktop::rollback::{Liveness, Start};
        use std::os::windows::io::AsRawHandle;
        use std::process::Child;
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::GetProcessTimes;

        fn created(child: &Child) -> u64 {
            let zero = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut made, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            assert_ne!(
                unsafe {
                    GetProcessTimes(
                        child.as_raw_handle() as _,
                        &mut made,
                        &mut exited,
                        &mut kernel,
                        &mut user,
                    )
                },
                0
            );
            (u64::from(made.dwHighDateTime) << 32) | u64::from(made.dwLowDateTime)
        }
        let world = World::new();
        let primary_out = world.dir.path().join("windowless-primary.json");
        let environment = world.command(&primary_out, 30_000);
        let mut command = isolated_command(world.app("2.0.0"));
        command.envs(
            environment
                .get_envs()
                .filter_map(|(key, value)| value.map(|v| (key, v))),
        );
        let mut primary = command.spawn().unwrap();
        world
            .owned
            .observe_child(&primary, &world.app("2.0.0"), &[])
            .unwrap();
        let pid = primary.id();
        let creation = created(&primary);
        assert_ne!(creation, 0);
        let ready = report(&primary_out);
        assert_eq!(ready["pid"].as_u64().unwrap(), u64::from(pid));
        assert!(same(
            Path::new(ready["exe"].as_str().unwrap()),
            &world.app("2.0.0")
        ));
        assert!(
            win::app_processes(&world.root).is_empty(),
            "A must have no Flutter window"
        );
        assert_eq!(win::liveness(pid, creation), Liveness::Running);
        launch::write_state(
            &world.root,
            &launch::State {
                starts: vec![Start {
                    version: "2.0.0".into(),
                    at_ms: 1,
                    pid,
                    created: creation,
                }],
            },
        )
        .unwrap();
        let original = fs::read(world.root.join("launch-state.json")).unwrap();
        for secondary in ["B", "C", "D"] {
            let value = world.start(&format!("windowless-{secondary}"), 500);
            assert!(same(
                Path::new(value["cwd"].as_str().unwrap()),
                &world.root.join("app").join("2.0.0")
            ));
            finish_app(&value);
            assert_eq!(primary.id(), pid);
            assert_eq!(created(&primary), creation);
            assert!(primary.try_wait().unwrap().is_none());
            assert_eq!(win::liveness(pid, creation), Liveness::Running);
            assert!(win::app_processes(&world.root).is_empty());
            assert_eq!(
                fs::read(world.root.join("launch-state.json")).unwrap(),
                original
            );
            assert_eq!(pointer::read(&world.root.join("current")).unwrap(), "2.0.0");
            assert_eq!(
                pointer::read(&world.root.join("previous")).unwrap(),
                "1.0.0"
            );
        }
        assert!(
            !fs::read_to_string(world.root.join("launch.log"))
                .unwrap()
                .contains("went back")
        );
        // Kill/reap only this retained actual Child. A and the next cold start now
        // become two ended attempts; the following launch must recover normally.
        primary.kill().unwrap();
        primary.wait().unwrap();
        assert_eq!(win::liveness(pid, creation), Liveness::Ended);
        assert!(
            !world
                .root
                .join("app")
                .join("2.0.0")
                .join(".started")
                .exists()
        );
        let cold = world.start("cold-after-windowless-primary", 500);
        assert!(same(
            Path::new(cold["cwd"].as_str().unwrap()),
            &world.root.join("app").join("2.0.0")
        ));
        finish_app(&cold);
        assert_eq!(launch::read_state(&world.root).starts.len(), 2);
        let recovered = world.start("recovered-after-cold-failures", 500);
        assert!(same(
            Path::new(recovered["cwd"].as_str().unwrap()),
            &world.root.join("app").join("1.0.0")
        ));
        finish_app(&recovered);
        assert!(!world.root.join("previous").exists());
        assert!(launch::read_state(&world.root).starts.is_empty());
    }

    pub fn contended_history_does_not_spawn_then_recovers() {
        let world = World::new();
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(world.root.join("launch-state.lock"))
            .unwrap();
        lock.try_lock().unwrap();
        let out = world.dir.path().join("blocked.json");
        let began = Instant::now();
        let output = world.output(&mut world.command(&out, 500));
        assert_eq!(output.status.code(), Some(1));
        assert!(
            began.elapsed() >= Duration::from_secs(9) && began.elapsed() < Duration::from_secs(25)
        );
        assert!(!out.exists());
        assert!(!world.root.join("launch-state.json").exists());
        assert_eq!(pointer::read(&world.root.join("current")).unwrap(), "2.0.0");
        assert!(String::from_utf8_lossy(&output.stderr).contains("still finishing"));
        drop(lock);
        finish_app(&world.start("after-lock", 500));
    }
}
