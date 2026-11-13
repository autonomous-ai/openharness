//! Find the `harness` CLI and run it: deadlines, NDJSON lines.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fake, wait_gone};
    use std::env;
    use std::fs;
    use std::time::Instant;

    const WAIT: Duration = Duration::from_secs(5);
    const WATCH: [&str; 3] = ["hardware", "watch", "--json"];
    const CANCELLED: &str = r#"{"type":"result","status":"error","code":"CANCELLED","message":"Sign-in stopped: the app that started it has gone."}"#;

    /// An empty file, with its folders.
    fn put(path: PathBuf) -> PathBuf {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "").unwrap();
        path
    }

    fn found(home: &Path, path_var: Option<&OsStr>) -> Option<(PathBuf, Vec<OsString>)> {
        find_cli(home, path_var, None).map(|cli| (cli.program, cli.prefix))
    }

    #[test]
    fn the_managed_cli_comes_first() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let runtime = home.join(".harness").join("runtime");
        let node = put(runtime.join("node-v22").join("bin").join("node"));
        fs::write(runtime.join("current-node"), format!("{}\n", node.display())).unwrap();
        let cli_js = put(home.join(".harness").join("cli").join("cli.js"));
        let launcher = put(home.join(".local").join("bin").join("harness"));
        let bin = home.join("bin");
        put(bin.join("harness"));
        assert_eq!(found(home, Some(bin.as_os_str())), Some((node, vec![cli_js.clone().into_os_string()])));
        // A runtime without its cli.js is no CLI.
        fs::remove_file(cli_js).unwrap();
        assert_eq!(found(home, Some(bin.as_os_str())), Some((launcher, vec![])));
    }

    #[test]
    fn a_node_pointer_outside_the_runtime_folder_is_not_used() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let runtime = home.join(".harness").join("runtime");
        fs::create_dir_all(&runtime).unwrap();
        put(home.join(".harness").join("cli").join("cli.js"));
        put(home.join(".harness").join("node"));
        let launcher = put(home.join(".local").join("bin").join("harness"));
        let pointers = [
            "/usr/bin/env".to_string(),
            runtime.join("missing").display().to_string(),
            String::new(),
            // Under the runtime folder as text, outside it as a path.
            runtime.join("..").join("node").display().to_string(),
        ];
        for pointer in pointers {
            fs::write(runtime.join("current-node"), &pointer).unwrap();
            assert_eq!(found(home, None), Some((launcher.clone(), vec![])), "{pointer}");
        }
    }

    #[test]
    fn then_the_launcher_then_path_then_nothing() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let folders = tempfile::tempdir().unwrap();
        let near = folders.path().join("near");
        put(near.join("harness"));
        let far = put(folders.path().join("far").join("harness"));
        // `near` named from here: a relative entry is skipped even when it holds a `harness`.
        let up: PathBuf = env::current_dir().unwrap().components().skip(1).map(|_| "..").collect();
        let relative = up.join(near.strip_prefix("/").unwrap());
        assert!(relative.join("harness").is_file());
        let path_var = env::join_paths([relative.clone(), far.parent().unwrap().to_path_buf()]).unwrap();
        assert_eq!(found(home, Some(&path_var)), Some((far, vec![])));
        assert_eq!(found(home, Some(relative.as_os_str())), None);
        assert_eq!(found(home, None), None);
        let launcher = put(home.join(".local").join("bin").join("harness"));
        assert_eq!(found(home, Some(&path_var)), Some((launcher, vec![])));
    }

    #[test]
    fn the_override_is_for_debug_builds() {
        let over = PathBuf::from("/opt/fake/harness");
        assert_eq!(cli_override(true, Some(over.clone().into_os_string())), Some(over.clone()));
        assert_eq!(cli_override(false, Some(over.clone().into_os_string())), None);
        assert_eq!(cli_override(true, None), None);
        let home = tempfile::tempdir().unwrap();
        put(home.path().join(".local").join("bin").join("harness"));
        let cli = find_cli(home.path(), None, Some(&over)).unwrap();
        assert_eq!((cli.program, cli.prefix), (over, vec![]));
    }

    #[test]
    fn the_child_path_starts_with_the_launcher_folder() {
        let home = Path::new("/Users/someone");
        let path = |value: &str| (OsString::from("PATH"), OsString::from(value));
        let c_utf8 = (OsString::from("LC_ALL"), OsString::from("C.UTF-8"));
        let system = Some(OsStr::new("/usr/bin:/bin"));
        let with_system = path("/Users/someone/.local/bin:/usr/bin:/bin");
        assert_eq!(child_env(home, system, None), [with_system.clone(), c_utf8.clone()]);
        assert_eq!(child_env(home, system, Some(OsStr::new("C"))), [with_system.clone(), c_utf8.clone()]);
        for locale in ["en_US.UTF-8", "vi_VN.utf8"] {
            assert_eq!(child_env(home, system, Some(OsStr::new(locale))), [with_system.clone()], "{locale}");
        }
        assert_eq!(child_env(home, None, None), [path("/Users/someone/.local/bin"), c_utf8]);
    }

    #[cfg(unix)]
    #[test]
    fn a_run_gives_code_and_output() {
        let fake = Fake::new();
        fake.script("auth status --json", &["ok", "@err bad", "@exit 7"]);
        let output = fake.cli().run(&["auth", "status", "--json"], WAIT).unwrap();
        assert_eq!(output, Output { code: Some(7), timed_out: false, stdout: "ok\n".into(), stderr: "bad\n".into() });
    }

    #[cfg(unix)]
    #[test]
    fn a_run_past_its_deadline_dies_with_its_children() {
        let folder = tempfile::tempdir().unwrap();
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 600 & echo $! > pid; wait"]).current_dir(folder.path());
        let started = Instant::now();
        let output = run(command, Duration::from_millis(300)).unwrap();
        assert!(output.timed_out);
        assert!(started.elapsed() < WAIT);
        let pid = fs::read_to_string(folder.path().join("pid")).unwrap().trim().parse().unwrap();
        assert!(wait_gone(pid));
    }

    #[cfg(unix)]
    #[test]
    fn a_child_gives_its_lines_then_ends() {
        let fake = Fake::new();
        fake.script("hardware watch --json", &["a", "b", "@stdin"]);
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        assert_eq!(child.line(WAIT), Ok(Some("a".into())));
        assert_eq!(child.line(WAIT), Ok(Some("b".into())));
        child.close_stdin();
        assert_eq!(child.line(WAIT), Ok(None));
        assert_eq!(child.exit(WAIT), Ok(Some(0)));
    }

    #[cfg(unix)]
    #[test]
    fn a_line_over_64_kib_is_dropped() {
        let fake = Fake::new();
        let longest = "y".repeat(LINE_MAX);
        fake.script("hardware watch --json", &[&"x".repeat(70_000), &longest, r#"{"a":1}"#]);
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        assert_eq!(child.line(WAIT), Ok(Some(longest)));
        assert_eq!(child.line(WAIT), Ok(Some(r#"{"a":1}"#.into())));
    }

    #[cfg(unix)]
    #[test]
    fn a_kill_ends_a_child_and_a_later_kill_does_nothing() {
        let fake = Fake::new();
        fake.script("hardware watch --json", &["started", "@hang"]);
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        assert_eq!(child.line(WAIT), Ok(Some("started".into())));
        let killer = child.killer();
        killer.kill();
        assert_eq!(child.exit(WAIT), Ok(None));
        assert!(wait_gone(fake.pids()[0]));
        killer.kill();
        assert_eq!(fake.log().lines(), ["harness hardware watch --json: killed by a signal"]);
    }

    #[cfg(unix)]
    #[test]
    fn every_run_is_one_log_line() {
        let short = Duration::from_millis(300);
        let cases: [(&[&str], Duration, &str); 4] = [
            (&[r#"{"loggedIn":true}"#], WAIT, "harness auth status --json: exit 0"),
            (&["@err no session", "@exit 1"], WAIT, "harness auth status --json: exit 1: no session"),
            // Never stdout: it may carry what a log must not hold.
            (&["person@example.com", "@exit 1"], WAIT, "harness auth status --json: exit 1"),
            (&["@hang"], short, "harness auth status --json: timed out after 0.3 s"),
        ];
        for (lines, deadline, logged) in cases {
            let fake = Fake::new();
            fake.script("auth status --json", lines);
            fake.cli().run(&["auth", "status", "--json"], deadline).unwrap();
            assert_eq!(fake.log().lines(), [logged]);
        }
        let fake = Fake::new();
        fake.script("hardware watch --json", &["@err gone", "@exit 3"]);
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        assert_eq!(child.exit(WAIT), Ok(Some(3)));
        assert_eq!(fake.log().lines(), ["harness hardware watch --json: exit 3: gone"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_fake_keeps_its_contract() {
        let fake = Fake::new();
        let cli = fake.cli();
        fake.script("auth status --json", &["ok"]);
        fake.script("hardware watch --json", &["started", "@hang"]);
        cli.run(&["auth", "status", "--json"], WAIT).unwrap();
        let mut hung = cli.spawn(&WATCH).unwrap();
        assert_eq!(hung.line(WAIT), Ok(Some("started".into())));
        hung.killer().kill();
        assert_eq!(hung.exit(WAIT), Ok(None));
        let unknown = cli.run(&["device", "claude", "status", "--json"], WAIT).unwrap();
        assert_eq!((unknown.code, unknown.stderr.as_str()), (Some(1), "Unknown command\n"));
        assert_eq!(fake.calls(), ["auth status --json", "hardware watch --json", "device claude status --json"]);
        let pids = fake.pids();
        assert_eq!(pids.len(), 3);
        assert!(pids[0] != pids[1] && pids[1] != pids[2]);
        assert_eq!(fake.ends(), ["auth status --json", "device claude status --json"]);

        fake.script("login --json", &["@wait go", "after"]);
        let mut waiting = cli.spawn(&["login", "--json"]).unwrap();
        assert_eq!(waiting.line(Duration::from_millis(200)), Err(Timeout));
        fake.touch("go");
        assert_eq!(waiting.line(WAIT), Ok(Some("after".into())));
        assert_eq!(waiting.exit(WAIT), Ok(Some(0)));

        fake.script("login --json", &["@driver", "@wait never"]);
        let mut driven = cli.spawn(&["login", "--json"]).unwrap();
        driven.close_stdin();
        assert_eq!(driven.line(WAIT), Ok(Some(CANCELLED.into())));
        assert_eq!(driven.line(WAIT), Ok(None));
        assert_eq!(driven.exit(WAIT), Ok(Some(1)));

        fake.script("login --json", &["@driver", "done"]);
        let mut finished = cli.spawn(&["login", "--json"]).unwrap();
        assert_eq!(finished.line(WAIT), Ok(Some("done".into())));
        assert_eq!(finished.line(WAIT), Ok(None));
        assert_eq!(finished.exit(WAIT), Ok(Some(0)));
    }
}
