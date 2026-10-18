//! Native per-user install/COM/registry checks in fresh disposable worlds.
//! The shell row is compositional: Shell -> test bootstrap -> real installed launcher.
//! It does not claim direct browser -> Harness.exe acceptance (C5's fresh-user gate).
mod desktop_common;

fn main() {
    #[cfg(windows)]
    {
        // The shell need not inherit our environment. Bootstrap before any environment dispatch.
        if windows::bootstrap_entry() {
            return;
        }
        windows::main();
    }
}

#[cfg(windows)]
mod windows {
    use super::desktop_common::owned_windows::OwnedProcesses;
    use super::desktop_common::{self, *};
    use harness_pty::desktop::{registry, shortcut, win};
    use serde::{Deserialize, Serialize};
    use std::collections::BTreeMap;
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::os::windows::fs::MetadataExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output, Stdio};
    use std::time::{Duration, Instant};

    const BOOTSTRAP: &str = "harness-shell-bootstrap.exe";
    const CONFIG: &str = "shell-bootstrap.json";
    const ENV_KEYS: &[&str] = &[
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "HARNESS_DESKTOP_INSTALL_ROOT",
        "HARNESS_DESKTOP_PROGRAMS_DIR",
        "HARNESS_DESKTOP_REGISTRY_ROOT",
        "HARNESS_DESKTOP_NO_DIALOG",
        STANDIN_OUT,
    ];

    pub fn main() {
        if desktop_common::stand_in_entry() {
            return;
        }
        run_cases(&[
            (
                "repaired_version_resets_old_process_history_before_launch",
                repaired_version_resets_old_process_history_before_launch,
            ),
            (
                "uninstall_quits_the_app_and_leaves_the_cli",
                uninstall_quits_the_app_and_leaves_the_cli,
            ),
            (
                "uninstall_ends_only_owned_noncooperating_app_after_ten_seconds",
                uninstall_ends_only_owned_noncooperating_app_after_ten_seconds,
            ),
            (
                "junction_source_is_rejected_before_destination_effects",
                junction_source_is_rejected_before_destination_effects,
            ),
            (
                "missing_shell_handle_cleanup_reaps_an_unreported_bootstrap",
                missing_shell_handle_cleanup_reaps_an_unreported_bootstrap,
            ),
            (
                "unwind_cleanup_reaps_a_bootstrap_after_its_report",
                unwind_cleanup_reaps_a_bootstrap_after_its_report,
            ),
            ("installs_registers_and_opens", installs_registers_and_opens),
            (
                "same_version_repairs_registration_without_recopying",
                same_version_repairs_registration_without_recopying,
            ),
            (
                "newer_zip_replaces_current_and_keeps_previous",
                newer_zip_replaces_current_and_keeps_previous,
            ),
            (
                "an_older_zip_opens_the_installed_harness",
                an_older_zip_opens_the_installed_harness,
            ),
            (
                "installed_heals_but_zip_does_not_take_protocol",
                installed_heals_but_zip_does_not_take_protocol,
            ),
            (
                "shell_delivers_uri_to_bootstrap_then_real_installed_launcher",
                shell_delivers_uri_to_bootstrap_then_real_installed_launcher,
            ),
            (
                "bootstrap_requires_matching_owned_configuration",
                bootstrap_requires_matching_owned_configuration,
            ),
            (
                "bootstrap_reconstructs_environment_without_caller_overrides",
                bootstrap_reconstructs_environment_without_caller_overrides,
            ),
        ]);
    }

    /// Each case owns its World; let cleanup finish unwinding before trying the next case.
    fn run_cases(tests: &[(&str, fn())]) {
        let filter = std::env::args().skip(1).find(|arg| !arg.starts_with('-'));
        let mut passed = 0;
        let mut failed = Vec::new();
        for &(name, test) in tests {
            if filter.as_deref().is_none_or(|filter| name.contains(filter)) {
                println!("test {name} ...");
                if std::panic::catch_unwind(test).is_ok() {
                    println!("test {name} ... ok");
                    passed += 1;
                } else {
                    println!("test {name} ... FAILED");
                    failed.push(name);
                }
            }
        }
        assert!(
            passed + failed.len() > 0,
            "no desktop tests matched {filter:?}"
        );
        println!("{passed} desktop tests passed; {} failed", failed.len());
        assert!(
            failed.is_empty(),
            "failed desktop tests: {}",
            failed.join(", ")
        );
    }

    struct World {
        owned: OwnedProcesses,
        dir: tempfile::TempDir,
        profile: PathBuf,
        zip: PathBuf,
        install: PathBuf,
        programs: PathBuf,
        temp: PathBuf,
        registry: String,
        id: String,
    }

    impl Drop for World {
        fn drop(&mut self) {
            if let Err(error) = self.owned.cleanup(Duration::from_secs(5)) {
                self.dir.disable_cleanup(true);
                eprintln!(
                    "owned process cleanup failed; retained {}: {error}",
                    self.dir.path().display()
                );
                if !std::thread::panicking() {
                    panic!("owned fixture processes did not stop: {error}");
                }
                return;
            }
            // Never remove the shared parent, another test's keys, or a real Harness key.
            win::delete_key(r"Software\HarnessTest", &self.id).unwrap();
        }
    }

    fn world() -> World {
        let dir = tempfile::Builder::new().prefix(ODD_NAME).tempdir().unwrap();
        let profile = dir.path().join(ODD_NAME);
        let id = uuid::Uuid::new_v4().simple().to_string();
        let world = World {
            owned: OwnedProcesses::new(dir.path()),
            zip: profile.join("Downloads").join("zip"),
            install: profile
                .join("AppData")
                .join("Local")
                .join("Programs")
                .join("Harness"),
            programs: profile.join("Start Menu").join("Programs"),
            temp: profile.join("Temp"),
            registry: format!(r"Software\HarnessTest\{id}"),
            dir,
            profile,
            id,
        };
        for path in [
            &world.temp,
            &world.profile.join("AppData").join("Roaming"),
            &world.profile.join("AppData").join("Local"),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        for folder in ["desktop-app", "desktop-app-v2", "cli"] {
            fs::create_dir_all(world.profile.join(".harness").join(folder)).unwrap();
        }
        zip(&world.zip, "1.2.3");
        world
    }

    fn zip(root: &Path, version: &str) {
        put_app(root, version);
        point(root, "current", version);
        fs::copy(LAUNCHER, root.join("Harness.exe")).unwrap();
        fs::write(root.join("Harness.ico"), b"fixture icon").unwrap();
    }

    fn environment(world: &World, out: &Path) -> BTreeMap<String, String> {
        [
            ("USERPROFILE", world.profile.clone()),
            ("HOME", world.profile.clone()),
            ("APPDATA", world.profile.join("AppData").join("Roaming")),
            ("LOCALAPPDATA", world.profile.join("AppData").join("Local")),
            ("TEMP", world.temp.clone()),
            ("TMP", world.temp.clone()),
            ("HARNESS_DESKTOP_INSTALL_ROOT", world.install.clone()),
            ("HARNESS_DESKTOP_PROGRAMS_DIR", world.programs.clone()),
            (
                "HARNESS_DESKTOP_REGISTRY_ROOT",
                PathBuf::from(&world.registry),
            ),
            ("HARNESS_DESKTOP_NO_DIALOG", PathBuf::from("1")),
            (STANDIN_OUT, out.to_owned()),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.to_str().unwrap().into()))
        .collect()
    }

    /// No shell and no global test-process environment changes. Bound every fixture-owned launcher.
    fn bounded_output(command: &mut Command) -> Output {
        bounded_output_observed(command, |_| {})
    }
    fn bounded_output_observed(
        command: &mut Command,
        observe: impl Fn(&std::process::Child),
    ) -> Output {
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        observe(&child);
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            observe(&child);
            if child.try_wait().unwrap().is_some() {
                return child.wait_with_output().unwrap();
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("owned launcher timed out");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn run(world: &World, exe: &Path, args: &[&str], name: &str) -> (Output, serde_json::Value) {
        world.owned.allow(exe).unwrap();
        world
            .owned
            .allow(&world.install.join("Harness.exe"))
            .unwrap();
        for root in [exe.parent().unwrap(), world.install.as_path()] {
            if let Ok(version) = harness_pty::desktop::pointer::read(&root.join("current")) {
                world
                    .owned
                    .allow(
                        &world
                            .install
                            .join("app")
                            .join(version)
                            .join("harness-desktop.exe"),
                    )
                    .unwrap();
            }
        }
        let out = world.dir.path().join(format!("{name}.json"));
        let env = environment(world, &out);
        let output = bounded_output(isolated_command(exe).args(args).envs(&env));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let app = report(&out);
        // Finish before assertions/TempDir cleanup; a report precedes actual process exit.
        finish_app(&app);
        assert_eq!(app["env"], serde_json::to_value(&env).unwrap());
        (output, app)
    }

    fn assert_app(world: &World, app: &serde_json::Value, version: &str, args: &[&str]) {
        let folder = world.install.join("app").join(version);
        assert!(same(Path::new(app["cwd"].as_str().unwrap()), &folder));
        assert!(same(
            Path::new(app["exe"].as_str().unwrap()),
            &folder.join("harness-desktop.exe")
        ));
        assert_eq!(app["args"], serde_json::json!(args));
        assert!(app["pid"].as_u64().unwrap() > 0);
    }

    fn installed() -> World {
        let world = world();
        let (_, app) = run(
            &world,
            &world.zip.join("Harness.exe"),
            &["--install"],
            "installed",
        );
        assert_app(&world, &app, "1.2.3", &[]);
        world
    }

    fn value(world: &World, key: &str, name: &str) -> Option<String> {
        win::read_value(&world.registry, key, name).map(|v| v.into_string().unwrap())
    }

    fn number(world: &World, name: &str) -> u32 {
        use windows_sys::Win32::System::Registry::{
            HKEY_CURRENT_USER, REG_DWORD, RRF_RT_REG_DWORD, RegGetValueW,
        };
        let path = win::wide(OsStr::new(&format!(
            r"{}\Microsoft\Windows\CurrentVersion\Uninstall\Harness",
            world.registry
        )));
        let name = win::wide(OsStr::new(name));
        let (mut kind, mut size, mut value) = (0u32, 4u32, 0u32);
        assert_eq!(
            unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    path.as_ptr(),
                    name.as_ptr(),
                    RRF_RT_REG_DWORD,
                    &mut kind,
                    (&mut value as *mut u32).cast(),
                    &mut size,
                )
            },
            0
        );
        assert_eq!((kind, size), (REG_DWORD, 4));
        value
    }

    fn installs_registers_and_opens() {
        let world = installed();
        let launcher = world.install.join("Harness.exe");
        assert!(launcher.is_file() && world.install.join("Harness.ico").is_file());
        assert_eq!(
            fs::read_to_string(world.install.join("current")).unwrap(),
            "1.2.3\r\n"
        );
        assert_eq!(
            value(&world, r"Classes\harness\shell\open\command", ""),
            Some(format!("\"{}\" \"%1\"", launcher.display()))
        );
        assert_eq!(
            value(&world, r"Classes\harness", "URL Protocol"),
            Some(String::new())
        );
        assert_eq!(
            value(&world, r"Classes\harness", ""),
            Some("URL:Harness".into())
        );
        let key = r"Microsoft\Windows\CurrentVersion\Uninstall\Harness";
        for (name, want) in [
            ("DisplayName", "Harness".into()),
            ("DisplayVersion", "1.2.3".into()),
            ("Publisher", "Autonomous".into()),
            ("InstallLocation", world.install.to_str().unwrap().into()),
            (
                "DisplayIcon",
                format!("{},0", world.install.join("Harness.ico").display()),
            ),
            (
                "UninstallString",
                format!("\"{}\" --uninstall", launcher.display()),
            ),
        ] {
            assert_eq!(value(&world, key, name), Some(want), "{name}");
        }
        assert_eq!(
            (number(&world, "NoModify"), number(&world, "NoRepair")),
            (1, 1)
        );
        let (target, aumid) = shortcut::read(&world.programs.join("Harness.lnk")).unwrap();
        // COM may expand an 8.3 alias; it must still target this exact installed file.
        assert!(
            same(&target, &launcher),
            "shortcut target {target:?} != {launcher:?}"
        );
        assert_eq!(aumid, "Autonomous.Harness");
    }

    fn same_version_repairs_registration_without_recopying() {
        let world = installed();
        fs::write(
            world.install.join("app").join("1.2.3").join("keep"),
            b"keep",
        )
        .unwrap();
        fs::remove_file(world.programs.join("Harness.lnk")).unwrap();
        win::delete_key(&world.registry, r"Classes\harness").unwrap();
        win::delete_key(&world.registry, registry::UNINSTALL_KEY).unwrap();
        let (_, app) = run(
            &world,
            &world.zip.join("Harness.exe"),
            &["--install"],
            "same",
        );
        assert_app(&world, &app, "1.2.3", &[]);
        assert_eq!(
            fs::read(world.install.join("app").join("1.2.3").join("keep")).unwrap(),
            b"keep"
        );
        assert!(world.programs.join("Harness.lnk").is_file());
        assert_eq!(
            value(&world, registry::UNINSTALL_KEY, "DisplayVersion"),
            Some("1.2.3".into())
        );
        assert!(value(&world, r"Classes\harness\shell\open\command", "").is_some());
    }

    fn newer_zip_replaces_current_and_keeps_previous() {
        let world = installed();
        let newer = world.profile.join("Downloads").join("newer");
        zip(&newer, "1.3.0");
        let (_, app) = run(&world, &newer.join("Harness.exe"), &["--install"], "newer");
        assert_app(&world, &app, "1.3.0", &[]);
        assert_eq!(
            fs::read_to_string(world.install.join("current")).unwrap(),
            "1.3.0\r\n"
        );
        assert_eq!(
            fs::read_to_string(world.install.join("previous")).unwrap(),
            "1.2.3\r\n"
        );
        assert!(!world.install.join("app").join("1.3.0.staging").exists());
        assert_eq!(
            value(&world, registry::UNINSTALL_KEY, "DisplayVersion"),
            Some("1.3.0".into())
        );
    }

    fn an_older_zip_opens_the_installed_harness() {
        let world = installed();
        let older = world.profile.join("Downloads").join("older");
        zip(&older, "1.0.0");
        let (output, app) = run(&world, &older.join("Harness.exe"), &["--install"], "older");
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("version 1.0.0, older than the Harness 1.2.3")
        );
        assert_app(&world, &app, "1.2.3", &[]);
        assert!(!world.install.join("app").join("1.0.0").exists());
    }

    fn installed_heals_but_zip_does_not_take_protocol() {
        let world = installed();
        let different = world.profile.join("different.exe");
        win::write_keys(
            &world.registry,
            &registry::protocol_keys("harness", &different),
        )
        .unwrap();
        run(&world, &world.zip.join("Harness.exe"), &[], "zip-launch");
        assert_eq!(
            value(&world, r"Classes\harness\shell\open\command", ""),
            Some(format!("\"{}\" \"%1\"", different.display()))
        );
        let (_, app) = run(
            &world,
            &world.install.join("Harness.exe"),
            &["harness://healed"],
            "healed",
        );
        assert_app(&world, &app, "1.2.3", &["harness://healed"]);
        assert_eq!(
            value(&world, r"Classes\harness\shell\open\command", ""),
            Some(format!(
                "\"{}\" \"%1\"",
                world.install.join("Harness.exe").display()
            ))
        );
        let before = fs::read(world.install.join("launch.log")).unwrap();
        run(
            &world,
            &world.install.join("Harness.exe"),
            &[],
            "already-right",
        );
        // B's job fallback can append a diagnostic. The protocol-heal diagnostic must not repeat.
        let after = fs::read_to_string(world.install.join("launch.log")).unwrap();
        assert_eq!(
            after.matches("harness:// links now open").count(),
            String::from_utf8(before)
                .unwrap()
                .matches("harness:// links now open")
                .count()
        );
    }

    #[derive(Serialize, Deserialize)]
    struct BootstrapConfig {
        id: String,
        exe: PathBuf,
        launcher: PathBuf,
        identity: PathBuf,
        env: BTreeMap<String, String>,
        #[serde(default)]
        hang_before_report: bool,
        #[serde(default)]
        hang_after_report: bool,
    }

    pub fn bootstrap_entry() -> bool {
        let exe = std::env::current_exe().unwrap();
        if exe.file_name() != Some(OsStr::new(BOOTSTRAP)) {
            return false;
        }
        let result = (|| -> Result<(), String> {
            let dir = exe.parent().unwrap();
            let config: BootstrapConfig =
                serde_json::from_slice(&fs::read(dir.join(CONFIG)).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if !config.exe.is_file()
                || !same(&config.exe, &exe)
                || config.id.is_empty()
                || config.id.contains(['\\', '/'])
                || config.env.len() != ENV_KEYS.len()
                || ENV_KEYS.iter().any(|key| !config.env.contains_key(*key))
            {
                return Err("invalid bootstrap configuration".into());
            }
            let root = config
                .exe
                .parent()
                .ok_or("bootstrap has no fixture folder")?
                .to_owned();
            for path in [&config.launcher, &config.identity] {
                let absolute = std::path::absolute(path).map_err(|e| e.to_string())?;
                if absolute
                    .components()
                    .any(|c| c == std::path::Component::ParentDir)
                    || !absolute.starts_with(&root)
                {
                    return Err("bootstrap paths are outside its fixture".into());
                }
            }
            if config.env["HARNESS_DESKTOP_REGISTRY_ROOT"]
                != format!(r"Software\HarnessTest\{}", config.id)
                || Path::new(&config.env["HARNESS_DESKTOP_INSTALL_ROOT"]).join("Harness.exe")
                    != config.launcher
            {
                return Err("bootstrap installation identity does not match".into());
            }
            for key in [
                "USERPROFILE",
                "HOME",
                "APPDATA",
                "LOCALAPPDATA",
                "TEMP",
                "TMP",
                "HARNESS_DESKTOP_INSTALL_ROOT",
                "HARNESS_DESKTOP_PROGRAMS_DIR",
                STANDIN_OUT,
            ] {
                let path = Path::new(&config.env[key]);
                if !path.is_absolute()
                    || !path.starts_with(&root)
                    || path
                        .components()
                        .any(|c| c == std::path::Component::ParentDir)
                {
                    return Err("bootstrap environment is outside its fixture".into());
                }
            }
            // Dedicated single-threaded bootstrap only, never the parent test process.
            unsafe {
                std::env::remove_var(STANDIN_SLEEP_MS);
                for (key, value) in &config.env {
                    std::env::set_var(key, value);
                }
            }
            let args: Vec<_> = std::env::args_os().skip(1).collect();
            if args.len() != 1 {
                return Err("bootstrap expects exactly one URI".into());
            }
            if config.hang_before_report {
                std::thread::sleep(Duration::from_secs(60));
            }
            let identity = serde_json::json!({"exe":exe,"cwd":std::env::current_dir().unwrap(),"pid":std::process::id(),"args":args,"env":actual_environment()});
            fs::write(&config.identity, identity.to_string()).map_err(|e| e.to_string())?;
            if config.hang_after_report {
                std::thread::sleep(Duration::from_secs(60));
            }
            let output = bounded_output(
                isolated_command(&config.launcher)
                    .args(&args)
                    .envs(&config.env)
                    .current_dir(dir),
            );
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned());
            }
            finish_app(&report(Path::new(&config.env[STANDIN_OUT])));
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        true
    }

    fn actual_environment() -> BTreeMap<String, String> {
        ENV_KEYS
            .iter()
            .map(|key| ((*key).into(), std::env::var(key).unwrap()))
            .collect()
    }

    fn bootstrap(world: &World) -> (PathBuf, PathBuf, PathBuf) {
        // Keep all config paths under the bootstrap's own canonical directory.
        let exe = world.dir.path().join(BOOTSTRAP);
        fs::copy(std::env::current_exe().unwrap(), &exe).unwrap();
        world.owned.allow(&exe).unwrap();
        let out = world.dir.path().join("shell-app.json");
        let identity = world.dir.path().join("bootstrap-identity.json");
        let config = BootstrapConfig {
            id: world.id.clone(),
            exe: exe.clone(),
            launcher: world.install.join("Harness.exe"),
            identity: identity.clone(),
            env: environment(world, &out),
            hang_before_report: false,
            hang_after_report: false,
        };
        fs::write(
            world.dir.path().join(CONFIG),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        (exe, identity, out)
    }

    fn bootstrap_requires_matching_owned_configuration() {
        let world = installed();
        let (exe, _, out) = bootstrap(&world);
        fs::remove_file(world.dir.path().join(CONFIG)).unwrap();
        assert!(
            !bounded_output(isolated_command(&exe).arg("harness-test://x"))
                .status
                .success()
        );
        assert!(!out.exists());
        bootstrap(&world);
        let path = world.dir.path().join(CONFIG);
        let mut config: BootstrapConfig =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        config.exe = world.dir.path().join("different.exe");
        fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
        assert!(
            !bounded_output(isolated_command(exe).arg("harness-test://x"))
                .status
                .success()
        );
        assert!(!out.exists());
    }

    fn bootstrap_reconstructs_environment_without_caller_overrides() {
        let world = installed();
        let (exe, identity, out) = bootstrap(&world);
        let mut command = isolated_command(&exe);
        command
            .env_clear()
            .arg("harness-test://lost-environment")
            .current_dir(world.dir.path());
        // Keep only Windows loader basics; none of the fixture/profile variables survive.
        for key in ["SystemRoot", "PATH"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let output = bounded_output(&mut command);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let boot = report(&identity);
        let app = report(&out);
        finish_app(&app);
        assert_eq!(
            boot["env"],
            serde_json::to_value(environment(&world, &out)).unwrap()
        );
        assert_eq!(app["env"], boot["env"]);
        assert!(same(Path::new(boot["exe"].as_str().unwrap()), &exe));
        assert_app(&world, &app, "1.2.3", &["harness-test://lost-environment"]);
    }

    fn junction_source_is_rejected_before_destination_effects() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("outside")).unwrap();
        fs::write(
            dir.path().join("outside").join("sentinel"),
            b"external bytes",
        )
        .unwrap();
        fs::create_dir(dir.path().join("installed")).unwrap();
        fs::write(dir.path().join("installed").join("current"), b"1.2.3\r\n").unwrap();
        // Relative ASCII arguments avoid cmd reparsing the owned profile's special characters.
        // Directory junctions do not require symlink privileges or Developer Mode.
        // Rust preserves the program's spelling in argv0; give cmd native separators too.
        let cmd = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("cmd.exe");
        let output = bounded_output(
            Command::new(&cmd)
                .current_dir(dir.path())
                .args(["/d", "/v:off", "/c", "mklink", "/J", "junction", "outside"]),
        );
        assert!(
            output.status.success(),
            "mklink setup failed: program={cmd:?}, cwd={:?}, status={}, stdout={}, stderr={}",
            dir.path(),
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let junction = dir.path().join("junction");
        let metadata = fs::symlink_metadata(&junction).unwrap();
        assert_ne!(
            metadata.file_attributes()
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT,
            0,
            "mklink did not create a reparse point"
        );
        assert_eq!(
            fs::read(junction.join("sentinel")).unwrap(),
            b"external bytes"
        );
        assert!(
            harness_pty::desktop::install::copy_tree(
                &junction,
                &dir.path().join("installed").join("1.3.0")
            )
            .is_err()
        );
        assert!(!dir.path().join("installed").join("1.3.0").exists());
        assert_eq!(
            fs::read(dir.path().join("installed").join("current")).unwrap(),
            b"1.2.3\r\n"
        );
        assert_eq!(
            fs::read(dir.path().join("outside").join("sentinel")).unwrap(),
            b"external bytes"
        );
        fs::remove_dir(dir.path().join("junction")).unwrap();
    }

    fn configure_hang(world: &World, before_report: bool) {
        let path = world.dir.path().join(CONFIG);
        let mut config: BootstrapConfig =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        config.hang_before_report = before_report;
        config.hang_after_report = !before_report;
        fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
    }

    fn missing_shell_handle_cleanup_reaps_an_unreported_bootstrap() {
        let world = installed();
        let (exe, identity, _) = bootstrap(&world);
        configure_hang(&world, true);
        let mut child = isolated_command(&exe)
            .arg("harness-test://hang")
            .spawn()
            .unwrap();
        // Exercise exactly the optional-Shell-handle fallback, before any report exists.
        world
            .owned
            .watch_shell(&exe, &identity, std::ptr::null_mut())
            .unwrap();
        world
            .owned
            .await_observed(&exe, Duration::from_secs(3))
            .unwrap();
        assert!(!identity.exists());
        let started = Instant::now();
        world.owned.cleanup(Duration::from_secs(3)).unwrap();
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(!child.wait().unwrap().success());
        assert_eq!(world.owned.live_count().unwrap(), 0);
    }

    fn unwind_cleanup_reaps_a_bootstrap_after_its_report() {
        let mut fixture = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let world = installed();
            fixture = Some(world.dir.path().to_owned());
            let (exe, identity, _) = bootstrap(&world);
            configure_hang(&world, false);
            let child = isolated_command(&exe)
                .arg("harness-test://hang")
                .spawn()
                .unwrap();
            // Close this optional spawning handle: only the fixture guard owns cleanup now.
            drop(child);
            world
                .owned
                .watch_shell(&exe, &identity, std::ptr::null_mut())
                .unwrap();
            report(&identity);
            std::panic::resume_unwind(Box::new("intentional fixture unwind"));
        }));
        assert!(result.is_err());
        assert!(
            !fixture.unwrap().exists(),
            "the process was reaped before TempDir deletion"
        );
    }

    fn shell_delivers_uri_to_bootstrap_then_real_installed_launcher() {
        use windows_sys::Win32::System::Com::{
            COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize,
        };
        use windows_sys::Win32::UI::Shell::{
            SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
        };
        struct Scheme(String);
        impl Drop for Scheme {
            fn drop(&mut self) {
                win::delete_key("Software", &registry::protocol_key(&self.0)).unwrap();
            }
        }
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe { CoUninitialize() };
            }
        }
        let world = installed();
        let (exe, identity, out) = bootstrap(&world);
        let scheme = Scheme(format!("harness-test-{}", world.id));
        win::write_keys("Software", &registry::protocol_keys(&scheme.0, &exe)).unwrap();
        let link = format!("{}://notification/machine/agent?x=1&y=2", scheme.0);
        let hr = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
        assert!(hr >= 0, "COM initialization failed {hr:#x}");
        let _apartment = Apartment;
        let file = win::wide(OsStr::new(&link));
        let cwd = win::wide(world.dir.path().as_os_str());
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOCLOSEPROCESS;
        info.lpFile = file.as_ptr();
        info.lpDirectory = cwd.as_ptr();
        info.nShow = 1;
        assert_ne!(
            unsafe { ShellExecuteExW(&mut info) },
            0,
            "{}",
            std::io::Error::last_os_error()
        );
        world
            .owned
            .watch_shell(&exe, &identity, info.hProcess)
            .unwrap();
        let bootstrap = report(&identity);
        // Positive identity works even if the shell returns no process handle.
        assert!(same(Path::new(bootstrap["exe"].as_str().unwrap()), &exe));
        assert!(same(
            Path::new(bootstrap["cwd"].as_str().unwrap()),
            world.dir.path()
        ));
        // Cleanup owns the fallback if this bounded normal wait fails/unwinds.
        finish_app(&bootstrap);
        let app = report(&out);
        finish_app(&app);
        // The bootstrap records args_os, preserving Windows code units in Serde's OS-string form.
        let args: Vec<OsString> = serde_json::from_value(bootstrap["args"].clone()).unwrap();
        assert_eq!(args, [OsString::from(&link)]);
        assert_eq!(
            bootstrap["env"],
            serde_json::to_value(environment(&world, &out)).unwrap()
        );
        assert_eq!(app["env"], bootstrap["env"]);
        assert_app(&world, &app, "1.2.3", &[&link]);
    }

    /// Real OS tools are observed only through the owned launcher's lineage.
    fn uninstall_tools() -> Vec<PathBuf> {
        let source = std::env::var_os("SystemRoot").expect("Windows SystemRoot");
        [
            "cmd.exe",
            "chcp.com",
            "tasklist.exe",
            "find.exe",
            "PING.EXE",
        ]
        .map(|name| PathBuf::from(&source).join("System32").join(name))
        .into()
    }

    fn window_app(world: &World, mode: &str) -> std::process::Child {
        let exe = world
            .install
            .join("app")
            .join("1.2.3")
            .join("harness-desktop.exe");
        world.owned.allow(&exe).unwrap();
        let out = world.dir.path().join("window-ready.json");
        let mut env = environment(world, &out);
        env.insert(STANDIN_WINDOW.into(), mode.into());
        env.insert("HARNESS_DESKTOP_INSTANCE".into(), world.id.clone());
        let child = isolated_command(&exe)
            .envs(&env)
            .current_dir(exe.parent().unwrap())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let ready = report(&out);
        assert_eq!(ready["pid"].as_u64(), Some(u64::from(child.id())));
        assert_eq!(ready["window_ready"], true);
        assert!(ready["hwnd"].as_u64().is_some_and(|h| h > 0));
        assert!(same(Path::new(ready["exe"].as_str().unwrap()), &exe));
        assert_eq!(ready["env"], serde_json::to_value(&env).unwrap());
        assert!(win::app_processes(&world.install).contains(&child.id()));
        child
    }

    fn await_child(child: &mut std::process::Child) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "owned app did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn uninstall_window_case(forced: bool) {
        let world = installed();
        let sibling = installed();
        let mut unrelated = window_app(&sibling, "quit");
        let mut app = window_app(&world, if forced { "ignore" } else { "quit" });
        let tools = uninstall_tools();
        let harness = world.profile.join(".harness");
        let sentinels = [
            harness.join("cli").join("state.json"),
            harness.join("runtime").join("node"),
            harness.join("daemon-token"),
            world.profile.join(".codex").join("keep"),
        ];
        for file in &sentinels {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"preserved bytes").unwrap();
        }
        for folder in ["desktop-app", "desktop-app-v2"] {
            fs::write(harness.join(folder).join("state.json"), b"desktop").unwrap();
        }
        let launcher = world.install.join("Harness.exe");
        world.owned.allow(&launcher).unwrap();
        let started = Instant::now();
        let output = bounded_output_observed(
            isolated_command(&launcher)
                .arg("--uninstall")
                .envs(environment(&world, &world.dir.path().join("unused.json"))),
            |child| world.owned.observe_child(child, &launcher, &tools).unwrap(),
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .ends_with("To remove them, run \u{60}harness uninstall\u{60}.\n")
        );
        let status = await_child(&mut app);
        if forced {
            assert!(!status.success());
            assert!(started.elapsed() >= Duration::from_secs(10));
        } else {
            assert!(status.success(), "{status}");
        }
        assert!(started.elapsed() < Duration::from_secs(25));
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "sibling install was stopped"
        );
        assert!(!world.programs.join("Harness.lnk").exists());
        assert_eq!(
            value(&world, r"Classes\harness\shell\open\command", ""),
            None
        );
        assert_eq!(value(&world, registry::UNINSTALL_KEY, "DisplayName"), None);
        assert!(!harness.join("desktop-app").exists() && !harness.join("desktop-app-v2").exists());
        for file in &sentinels {
            assert_eq!(fs::read(file).unwrap(), b"preserved bytes");
        }
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            world.owned.live_count().unwrap();
            let files: Vec<_> = fs::read_dir(&world.temp)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            if !world.install.exists() && files.is_empty() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "install/scripts stayed: {files:?}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            win::quit_app(&sibling.install, Duration::from_secs(2)).unwrap(),
            1
        );
        assert!(await_child(&mut unrelated).success());
    }
    fn uninstall_quits_the_app_and_leaves_the_cli() {
        uninstall_window_case(false);
    }
    fn uninstall_ends_only_owned_noncooperating_app_after_ten_seconds() {
        uninstall_window_case(true);
    }
    fn repaired_version_resets_old_process_history_before_launch() {
        use harness_pty::desktop::{launch, rollback::Start};
        let world = world();
        run(
            &world,
            &world.zip.join("Harness.exe"),
            &["--install"],
            "before-repair",
        );
        put_app(&world.install, "1.0.0");
        world
            .owned
            .allow(
                &world
                    .install
                    .join("app")
                    .join("1.0.0")
                    .join("harness-desktop.exe"),
            )
            .unwrap();
        point(&world.install, "previous", "1.0.0");
        let start = |pid| Start {
            version: "1.2.3".into(),
            at_ms: 1,
            pid,
            created: 1,
        };
        launch::write_state(
            &world.install,
            &launch::State {
                starts: vec![start(10), start(11)],
            },
        )
        .unwrap();
        fs::write(
            world.zip.join("app").join("1.2.3").join(".started"),
            b"zip success is not installed success",
        )
        .unwrap();
        fs::remove_file(
            world
                .install
                .join("app")
                .join("1.2.3")
                .join("harness-desktop.exe"),
        )
        .unwrap();
        let (_, app) = run(
            &world,
            &world.zip.join("Harness.exe"),
            &["--install"],
            "after-repair",
        );
        assert!(same(
            Path::new(app["cwd"].as_str().unwrap()),
            &world.install.join("app").join("1.2.3")
        ));
        assert_eq!(
            fs::read(world.install.join("current")).unwrap(),
            b"1.2.3\r\n"
        );
        assert!(
            !world
                .install
                .join("app")
                .join("1.2.3")
                .join(".started")
                .exists()
        );
        let starts = launch::read_state(&world.install).starts;
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].version, "1.2.3");
    }
}
