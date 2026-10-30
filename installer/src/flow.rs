//! The install, step by step (spec §1.1 and §1.2), over a [Host] that does the Windows work and a [Report] that
//! shows it. Every decision is here, so the tests run it on any OS with a stand-in host; windows.rs only talks to
//! Windows.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::model::{self, Source, Step};

pub trait Host {
    fn windows_build(&self) -> u32;
    fn system_root(&self) -> PathBuf;
    fn machine(&self) -> model::Machine;
    fn local_app_data(&self) -> String;
    fn is_file(&self, path: &Path) -> bool;
    /// The manifest's bytes, at most [model::MANIFEST_LIMIT].
    fn read(&mut self, source: &Source) -> Result<Vec<u8>, String>;
    /// A new, empty temp folder.
    fn staging(&mut self) -> Result<PathBuf, String>;
    /// Writes [source] to [to], calling [received] with the running byte count; stops (with an error) as soon as
    /// it returns false.
    fn download(&mut self, source: &Source, to: &Path, received: &mut dyn FnMut(u64) -> bool) -> Result<(), String>;
    /// Unpacks [archive] into [into] with [tar]; the archive is gone afterwards.
    fn unpack(&mut self, tar: &Path, archive: &Path, into: &Path) -> Result<(), String>;
    /// Runs `<launcher> --install` and waits for it: its exit code.
    fn install(&mut self, launcher: &Path) -> Result<i32, String>;
    fn remove(&mut self, dir: &Path) -> Result<(), String>;
    fn pause(&mut self, time: Duration);
}

pub trait Report {
    fn step(&mut self, step: Step);
    fn progress(&mut self, received: u64, total: u64);
    fn cancelled(&self) -> bool;
    fn log(&mut self, line: &str);
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Installed { version: String },
    Failed { step: Step, message: String },
    Cancelled,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Finished {
    pub outcome: Outcome,
    /// The temp folder, when it could not be removed, and why.
    pub left: Option<(PathBuf, String)>,
}

impl Finished {
    pub fn exit_code(&self) -> i32 {
        match self.outcome {
            Outcome::Installed { .. } => model::EXIT_OK,
            Outcome::Failed { .. } => model::EXIT_FAILED,
            Outcome::Cancelled => model::EXIT_CANCELLED,
        }
    }

    /// What the person reads at the end: install.ps1's closing lines, in the same words.
    pub fn lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        match &self.outcome {
            Outcome::Installed { version } => lines.push(format!("Harness {version} is installed, and it is opening now.")),
            Outcome::Failed { step, message } => {
                lines.push(format!("Harness could not be installed. The step that failed: {}.", step.name()));
                lines.push(message.clone());
            }
            Outcome::Cancelled => lines.push("The install was cancelled. Nothing was installed.".to_owned()),
        }
        if let Some((dir, why)) = &self.left {
            lines.push(format!("Temporary files remain at {}.", dir.display()));
            lines.push(match self.outcome {
                Outcome::Installed { .. } => "Harness was installed and can be used.".to_owned(),
                _ => "The install failed for the reason above.".to_owned(),
            });
            lines.push(format!("Close anything using that folder, then remove it. {why}"));
        }
        lines
    }
}

fn sha256_of(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|err| format!("Could not read {}: {err}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut length = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(|err| format!("Could not read {}: {err}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        length += read as u64;
    }
    let hex = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((length, hex))
}

/// How a window whose Cancel was pressed ends once the run is over: with this exit code, or (None) by showing the
/// end face. The window hears of each step only after the worker enters it, so a Cancel can arrive after
/// `Harness.exe --install` has started: an install it could not stop is then reported, never hidden.
pub fn after_cancel(outcome: &Outcome) -> Option<i32> {
    match outcome {
        Outcome::Installed { .. } => Some(model::EXIT_OK),
        Outcome::Failed { step: Step::Install, .. } => None,
        Outcome::Failed { .. } | Outcome::Cancelled => Some(model::EXIT_CANCELLED),
    }
}

/// Runs the install once. The temp folder is removed whatever happened, and said when it could not be.
pub fn run(host: &mut impl Host, report: &mut impl Report, manifest: &Source, staging_build: bool) -> Finished {
    let mut staging = None;
    let outcome = attempt(host, report, manifest, staging_build, &mut staging);
    let left = staging.and_then(|dir| host.remove(&dir).err().map(|why| (dir, why)));
    let finished = Finished { outcome, left };
    for line in finished.lines() {
        report.log(&line);
    }
    finished
}

/// Why a step stopped.
#[derive(Debug)]
enum Stop {
    Failed(String),
    Cancelled,
}

/// A network read gets [model::ATTEMPTS] tries, as install.ps1's Invoke-HarnessRetry gives it; a file gets one.
fn attempts(source: &Source) -> u32 {
    if matches!(source, Source::Https(_)) { model::ATTEMPTS } else { 1 }
}

fn retrying(host: &mut impl Host, report: &mut impl Report, why: &str, next: u32, total: u32) {
    report.log(why);
    report.log(&format!("Connection interrupted; retrying ({next}/{total})..."));
    host.pause(Duration::from_secs(2));
}

fn enter(report: &mut impl Report, step: &mut Step, next: Step) -> Result<(), Stop> {
    if report.cancelled() {
        return Err(Stop::Cancelled);
    }
    *step = next;
    report.step(next);
    report.log(&format!("{}…", next.name()));
    Ok(())
}

fn attempt(
    host: &mut impl Host,
    report: &mut impl Report,
    manifest: &Source,
    staging_build: bool,
    staging: &mut Option<PathBuf>,
) -> Outcome {
    let mut step = Step::Check;
    match steps(host, report, manifest, staging_build, staging, &mut step) {
        Ok(version) => Outcome::Installed { version },
        Err(Stop::Cancelled) => Outcome::Cancelled,
        Err(Stop::Failed(_)) if report.cancelled() && step != Step::Install => Outcome::Cancelled,
        Err(Stop::Failed(message)) => Outcome::Failed { step, message },
    }
}

fn steps(
    host: &mut impl Host,
    report: &mut impl Report,
    manifest: &Source,
    staging_build: bool,
    staging: &mut Option<PathBuf>,
    step: &mut Step,
) -> Result<String, Stop> {
    enter(report, step, Step::Check)?;
    model::check_build(host.windows_build()).map_err(Stop::Failed)?;
    let tar = model::tar_path(&host.system_root());
    if !host.is_file(&tar) {
        return Err(Stop::Failed(model::missing_tar(&tar)));
    }
    let machine = host.machine();

    enter(report, step, Step::Manifest)?;
    report.log(&format!("Manifest: {}", manifest.display()));
    let (total, mut tried) = (attempts(manifest), 1);
    let bytes = loop {
        match host.read(manifest) {
            Ok(bytes) => break bytes,
            Err(why) if tried < total && !report.cancelled() => {
                tried += 1;
                retrying(host, report, &why, tried, total);
            }
            Err(why) => return Err(Stop::Failed(why)),
        }
    };
    let document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|err| Stop::Failed(format!("The manifest {} is not valid JSON: {err}", manifest.display())))?;
    let entry = model::select_entry(&document, machine).map_err(Stop::Failed)?;
    report.log(&format!(
        "Installing the Harness desktop app {} for {} ({})",
        entry.version,
        machine.platform(),
        entry.key
    ));

    enter(report, step, Step::Download)?;
    let source = model::resolve_ref(&entry.url, manifest, staging_build).map_err(Stop::Failed)?;
    let shown = source.display();
    model::check_sha256(&entry.sha256, &shown).map_err(Stop::Failed)?;
    let dir = host.staging().map_err(Stop::Failed)?;
    *staging = Some(dir.clone());
    let zip = dir.join("harness-desktop.zip");
    let limit = model::size_limit(entry.size);
    let (total, mut tried) = (attempts(&source), 1);
    let too_big = loop {
        let mut too_big = None;
        let mut last = 0;
        let result = {
            let mut received = |count: u64| {
                last = count;
                report.progress(count.min(limit), limit);
                if count > limit {
                    too_big = Some(count);
                    return false;
                }
                !report.cancelled()
            };
            host.download(&source, &zip, &mut received)
        };
        match result {
            // A connection closed early ends the body without an error: short of its size, it is tried again.
            Ok(()) if last < limit && tried < total => {
                tried += 1;
                retrying(host, report, &format!("The download stopped at {last} of {limit} bytes."), tried, total);
            }
            Ok(()) => break None,
            // A body already past its size is wrong: the size check says so, with no other try.
            Err(_) if too_big.is_some() => break too_big,
            Err(_) if report.cancelled() => return Err(Stop::Cancelled),
            Err(why) if tried < total => {
                tried += 1;
                retrying(host, report, &why, tried, total);
            }
            Err(why) => return Err(Stop::Failed(why)),
        }
    };
    let (length, got) = match too_big {
        Some(count) => (count, String::new()),
        None => sha256_of(&zip).map_err(Stop::Failed)?,
    };
    model::check_download(&shown, length, entry.size, &got, &entry.sha256).map_err(Stop::Failed)?;

    enter(report, step, Step::Unpack)?;
    let folder = dir.join("zip");
    host.unpack(&tar, &zip, &folder).map_err(Stop::Failed)?;
    let launcher = folder.join("Harness.exe");
    if !host.is_file(&launcher) {
        return Err(Stop::Failed(model::no_launcher()));
    }

    // The last point a cancel is taken: Harness.exe --install stages and renames, and is not stopped halfway.
    enter(report, step, Step::Install)?;
    let code = host.install(&launcher).map_err(Stop::Failed)?;
    if code != 0 {
        return Err(Stop::Failed(model::install_stopped(code, &host.local_app_data())));
    }
    Ok(entry.version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Machine, PRODUCTION_BASE};
    use std::cell::Cell;
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    const URL: &str = "https://cdn.autonomous.ai/harness/desktop/1.4.0/Harness-windows-x64.zip";
    const BODY: &[u8] = b"a zip, as far as this test cares";

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn manifest_for(url: &str, size: usize, sha256: &str) -> Vec<u8> {
        serde_json::json!({ "desktop-windows-x64": { "version": "1.4.0", "url": url, "sha256": sha256, "size": size } })
            .to_string()
            .into_bytes()
    }

    fn scratch() -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "harness-install-flow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Fake {
        root: PathBuf,
        build: u32,
        tar: bool,
        manifest: VecDeque<Result<Vec<u8>, String>>,
        downloads: VecDeque<Result<Vec<u8>, String>>,
        download_calls: u32,
        launcher: bool,
        unpack: Result<(), String>,
        exit: Result<i32, String>,
        installed: Vec<PathBuf>,
        remove_fails: bool,
        made: Vec<PathBuf>,
        pauses: u32,
    }

    impl Fake {
        fn new() -> Fake {
            Fake {
                root: scratch(),
                build: 26200,
                tar: true,
                manifest: VecDeque::from([Ok(manifest_for(URL, BODY.len(), &sha(BODY)))]),
                downloads: VecDeque::from([Ok(BODY.to_vec())]),
                download_calls: 0,
                launcher: true,
                unpack: Ok(()),
                exit: Ok(0),
                installed: Vec::new(),
                remove_fails: false,
                made: Vec::new(),
                pauses: 0,
            }
        }
    }

    impl Host for Fake {
        fn windows_build(&self) -> u32 {
            self.build
        }
        fn system_root(&self) -> PathBuf {
            PathBuf::from("W")
        }
        fn machine(&self) -> Machine {
            Machine::X64
        }
        fn local_app_data(&self) -> String {
            "L".into()
        }
        fn is_file(&self, path: &Path) -> bool {
            if path.ends_with("tar.exe") { self.tar } else { path.is_file() }
        }
        fn read(&mut self, _: &Source) -> Result<Vec<u8>, String> {
            self.manifest.pop_front().expect("no more manifest answers")
        }
        fn staging(&mut self) -> Result<PathBuf, String> {
            let dir = self.root.join(format!("staging-{}", self.made.len()));
            fs::create_dir_all(&dir).unwrap();
            self.made.push(dir.clone());
            Ok(dir)
        }
        fn download(&mut self, _: &Source, to: &Path, received: &mut dyn FnMut(u64) -> bool) -> Result<(), String> {
            self.download_calls += 1;
            let body = self.downloads.pop_front().expect("no more download answers")?;
            let mut written = Vec::new();
            for chunk in body.chunks(4) {
                written.extend_from_slice(chunk);
                if !received(written.len() as u64) {
                    fs::write(to, &written).unwrap();
                    return Err("stopped".into());
                }
            }
            fs::write(to, &written).unwrap();
            Ok(())
        }
        fn unpack(&mut self, _: &Path, archive: &Path, into: &Path) -> Result<(), String> {
            self.unpack.clone()?;
            fs::create_dir_all(into).unwrap();
            fs::remove_file(archive).unwrap();
            if self.launcher {
                fs::write(into.join("Harness.exe"), b"MZ").unwrap();
            }
            Ok(())
        }
        fn install(&mut self, launcher: &Path) -> Result<i32, String> {
            self.installed.push(launcher.to_path_buf());
            self.exit.clone()
        }
        fn remove(&mut self, dir: &Path) -> Result<(), String> {
            if self.remove_fails {
                return Err("held by another program".into());
            }
            fs::remove_dir_all(dir).map_err(|err| err.to_string())
        }
        fn pause(&mut self, _: Duration) {
            self.pauses += 1;
        }
    }

    #[derive(Default)]
    struct Seen {
        steps: Vec<Step>,
        log: Vec<String>,
        progress: Vec<(u64, u64)>,
        cancel: Cell<bool>,
        cancel_at_byte: Option<u64>,
        cancel_at_step: Option<Step>,
    }

    impl Report for Seen {
        fn step(&mut self, step: Step) {
            self.steps.push(step);
            if self.cancel_at_step == Some(step) {
                self.cancel.set(true);
            }
        }
        fn progress(&mut self, received: u64, total: u64) {
            self.progress.push((received, total));
            if self.cancel_at_byte.is_some_and(|at| received >= at) {
                self.cancel.set(true);
            }
        }
        fn cancelled(&self) -> bool {
            self.cancel.get()
        }
        fn log(&mut self, line: &str) {
            self.log.push(line.to_owned());
        }
    }

    fn published() -> Source {
        Source::Https(format!("{PRODUCTION_BASE}desktop/metadata.json"))
    }

    fn go(fake: &mut Fake, seen: &mut Seen) -> Finished {
        run(fake, seen, &published(), false)
    }

    fn failed(finished: &Finished) -> (Step, &str) {
        match &finished.outcome {
            Outcome::Failed { step, message } => (*step, message.as_str()),
            other => panic!("not a failure: {other:?}"),
        }
    }

    #[test]
    fn installs_in_order_and_removes_its_temp_folder() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.outcome, Outcome::Installed { version: "1.4.0".into() });
        assert_eq!(finished.exit_code(), model::EXIT_OK);
        assert_eq!(seen.steps, [Step::Check, Step::Manifest, Step::Download, Step::Unpack, Step::Install]);
        assert_eq!(fake.installed.len(), 1);
        assert!(fake.installed[0].ends_with(Path::new("zip").join("Harness.exe")));
        assert!(fake.made.iter().all(|dir| !dir.exists()));
        assert_eq!(seen.progress.last(), Some(&(BODY.len() as u64, BODY.len() as u64)));
        assert!(seen.log.contains(&"Installing the Harness desktop app 1.4.0 for win32-x64 (desktop-windows-x64)".to_owned()));
        assert_eq!(seen.log.last().unwrap(), "Harness 1.4.0 is installed, and it is opening now.");
    }

    #[test]
    fn an_old_windows_or_a_missing_tar_stops_before_anything_is_downloaded() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.build = 17134;
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished).0, Step::Check);
        assert!(failed(&finished).1.contains("build 17134"));
        assert!(fake.made.is_empty());

        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.tar = false;
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished), (Step::Check, model::missing_tar(&model::tar_path(Path::new("W"))).as_str()));
        assert_eq!(fake.download_calls, 0);
    }

    #[test]
    fn a_manifest_read_gets_three_tries_over_the_network_and_one_from_a_file() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.manifest = VecDeque::from([Err("timed out".into()), Err("reset".into()), Err("refused".into())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished), (Step::Manifest, "refused"));
        assert_eq!(fake.pauses, 2);
        assert!(seen.log.contains(&"Connection interrupted; retrying (3/3)...".to_owned()));

        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.manifest = VecDeque::from([Err("The manifest m.json does not exist.".into())]);
        let finished = run(&mut fake, &mut seen, &Source::File("m.json".into()), false);
        assert_eq!(failed(&finished), (Step::Manifest, "The manifest m.json does not exist."));
        assert_eq!(fake.pauses, 0);
    }

    #[test]
    fn a_manifest_that_is_not_json_or_has_no_app_for_this_pc_fails_its_step() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.manifest = VecDeque::from([Ok(b"<html>".to_vec())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished).0, Step::Manifest);
        assert!(failed(&finished).1.starts_with("The manifest https://storage.googleapis.com/"));

        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.manifest = VecDeque::from([Ok(b"{}".to_vec())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(
            failed(&finished),
            (Step::Manifest, "The desktop manifest has no Harness desktop app for this computer (win32-x64) yet.")
        );
    }

    #[test]
    fn a_download_outside_harnesss_folders_is_never_fetched() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.manifest = VecDeque::from([Ok(manifest_for("https://example.com/x.zip", 1, &sha(b"x")))]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished).0, Step::Download);
        assert_eq!(fake.download_calls, 0);
        assert!(fake.made.is_empty());
    }

    #[test]
    fn a_dropped_download_is_tried_again_from_the_start() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.downloads = VecDeque::from([Err("reset".into()), Err("reset".into()), Ok(BODY.to_vec())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.outcome, Outcome::Installed { version: "1.4.0".into() });
        assert_eq!((fake.download_calls, fake.pauses), (3, 2));
    }

    // A proxy, CDN edge or NAT that closes the connection mid-zip ends the body early without an error.
    #[test]
    fn a_body_that_ends_short_is_tried_again_and_fails_only_when_the_tries_run_out() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.downloads = VecDeque::from([Ok(BODY[..10].to_vec()), Ok(BODY.to_vec())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.outcome, Outcome::Installed { version: "1.4.0".into() });
        assert_eq!((fake.download_calls, fake.pauses), (2, 1));

        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.downloads = VecDeque::from([Ok(BODY[..10].to_vec()), Ok(BODY[..10].to_vec()), Ok(BODY[..10].to_vec())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(
            failed(&finished),
            (Step::Download, format!("{URL} is 10 bytes, but the manifest says 32: the download is incomplete, or is not the published file.").as_str())
        );
        assert_eq!(fake.download_calls, 3);
    }

    #[test]
    fn a_download_whose_hash_differs_is_not_installed() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.downloads = VecDeque::from([Ok(b"another body, same length!!!!!!!".to_vec())]);
        assert_eq!(BODY.len(), 32);
        let finished = go(&mut fake, &mut seen);
        let (step, message) = failed(&finished);
        assert_eq!(step, Step::Download);
        assert!(message.starts_with(&format!("{URL} failed its checksum (expected {}", sha(BODY))), "{message}");
        assert!(fake.installed.is_empty());
        assert!(fake.made.iter().all(|dir| !dir.exists()));
    }

    #[test]
    fn a_body_past_its_size_stops_at_once_and_is_not_tried_again() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.downloads = VecDeque::from([Ok([BODY, b"more"].concat())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(
            failed(&finished),
            (Step::Download, format!("{URL} is 36 bytes, but the manifest says 32: the download is incomplete, or is not the published file.").as_str())
        );
        assert_eq!(fake.download_calls, 1);
        assert!(seen.progress.iter().all(|(received, total)| received <= total));
    }

    #[test]
    fn cancel_during_the_download_installs_nothing_and_removes_the_temp_folder() {
        let (mut fake, mut seen) = (Fake::new(), Seen { cancel_at_byte: Some(8), ..Seen::default() });
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.outcome, Outcome::Cancelled);
        assert_eq!(finished.exit_code(), model::EXIT_CANCELLED);
        assert_eq!(fake.download_calls, 1);
        assert!(!seen.steps.contains(&Step::Unpack));
        assert!(fake.installed.is_empty());
        assert!(fake.made.iter().all(|dir| !dir.exists()));
    }

    #[test]
    fn a_cancel_once_the_install_has_started_does_not_stop_it() {
        let (mut fake, mut seen) = (Fake::new(), Seen { cancel_at_step: Some(Step::Install), ..Seen::default() });
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.outcome, Outcome::Installed { version: "1.4.0".into() });
        assert_eq!(fake.installed.len(), 1);
    }

    #[test]
    fn an_archive_that_does_not_unpack_or_has_no_launcher_fails_unpacking() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.unpack = Err("Could not unpack x (tar.exe exit code 1).".into());
        assert_eq!(failed(&go(&mut fake, &mut seen)), (Step::Unpack, "Could not unpack x (tar.exe exit code 1)."));

        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.launcher = false;
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished), (Step::Unpack, model::no_launcher().as_str()));
        assert!(fake.installed.is_empty());
    }

    // Cancel can land just as the worker enters Installing Harness, before the window has heard of it.
    #[test]
    fn a_cancel_that_came_too_late_to_stop_the_install_still_says_how_it_ended() {
        assert_eq!(after_cancel(&Outcome::Cancelled), Some(model::EXIT_CANCELLED));
        assert_eq!(after_cancel(&Outcome::Installed { version: "1.4.0".into() }), Some(model::EXIT_OK));
        let failed = |step| Outcome::Failed { step, message: "x".into() };
        assert_eq!(after_cancel(&failed(Step::Install)), None);
        assert_eq!(after_cancel(&failed(Step::Download)), Some(model::EXIT_CANCELLED));
    }

    #[test]
    fn a_failed_install_points_at_the_launchers_log() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.exit = Ok(1);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished), (Step::Install, model::install_stopped(1, "L").as_str()));
        assert_eq!(
            finished.lines()[..1],
            ["Harness could not be installed. The step that failed: Installing Harness.".to_owned()]
        );
    }

    #[test]
    fn a_temp_folder_it_could_not_remove_is_said_without_changing_the_result() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.remove_fails = true;
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.exit_code(), model::EXIT_OK);
        let (dir, why) = finished.left.clone().unwrap();
        assert_eq!(dir, fake.made[0]);
        assert_eq!(why, "held by another program");
        let lines = finished.lines();
        assert_eq!(lines[1], format!("Temporary files remain at {}.", fake.made[0].display()));
        assert_eq!(lines[2], "Harness was installed and can be used.");
        fs::remove_dir_all(&fake.root).unwrap();
    }
}
