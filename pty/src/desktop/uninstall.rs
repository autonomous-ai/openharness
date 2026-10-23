//! Per-user desktop removal, retaining accepted physical paths before effects.
//! CLI/daemon/agent data stays. The final script requires positive launcher absence.
use super::system::System;
use super::{DISPLAY_NAME, EXIT_FAILED, EXIT_OK, Paths, registry};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const QUIT_WAIT: Duration = Duration::from_secs(10);
pub const DESKTOP_STATE_PREFIX: &str = "desktop-app";
pub const FINAL_MESSAGE: &str = "Harness's command line and agents stay on this PC. To remove them, run \u{60}harness uninstall\u{60}.";
pub const WAIT_TRIES: u32 = 120;
pub const REMOVE_PASSES: u32 = 10;

#[cfg(all(test, windows))]
#[path = "../../tests/desktop_common/owned_windows.rs"]
#[allow(dead_code)]
mod owned_windows;

#[derive(Clone)]
pub struct ScriptPlace {
    pub temp: PathBuf,
    pub system_root: PathBuf,
}
pub(crate) fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot")
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var_os("windir").filter(|s| !s.is_empty()))
        .unwrap_or_else(|| OsString::from(r"C:\Windows"))
        .into()
}
impl ScriptPlace {
    pub fn current() -> Self {
        Self {
            temp: std::env::temp_dir(),
            system_root: system_root(),
        }
    }
}
fn link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    }
    #[cfg(unix)]
    {
        meta.is_symlink()
    }
}

fn batch_path(path: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut parts = path.components();
        if let Some(Component::Prefix(prefix)) = parts.next() {
            let mut out = match prefix.kind() {
                Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:", char::from(drive))),
                Prefix::VerbatimUNC(server, share) => {
                    let mut root = OsString::from(r"\\");
                    root.push(server);
                    root.push(r"\");
                    root.push(share);
                    PathBuf::from(root)
                }
                Prefix::Disk(_) | Prefix::UNC(_, _) => return Ok(path.to_owned()),
                _ => {
                    return Err(format!(
                        "{} is not an ordinary Windows path",
                        path.display()
                    ));
                }
            };
            for part in parts {
                out.push(part.as_os_str());
            }
            return Ok(out);
        }
    }
    Ok(path.to_owned())
}
fn windows_full(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/') {
        return true;
    }
    if let Some(rest) = text.strip_prefix(r"\\") {
        let mut parts = rest.split(['\\', '/']);
        return parts
            .next()
            .is_some_and(|s| !s.is_empty() && s != "?" && s != ".")
            && parts.next().is_some_and(|s| !s.is_empty());
    }
    false
}
/// Full path representable as batch data. Pure Windows text fixtures work on Unix.
pub fn script_safe(path: &Path) -> Result<String, String> {
    let path = batch_path(path)?;
    let text = path
        .to_str()
        .ok_or_else(|| format!("{} is not Unicode", path.display()))?;
    if !(path.is_absolute() || windows_full(text))
        || text.starts_with(r"\\?\")
        || text.starts_with(r"\\.\")
        || text
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '*' | '?' | '<' | '>' | '|'))
        || text
            .char_indices()
            .any(|(i, c)| c == ':' && !(i == 1 && text.as_bytes()[0].is_ascii_alphabetic()))
        || text
            .split(['\\', '/'])
            .any(|s| !s.is_empty() && s.chars().all(|c| c == '.'))
    {
        return Err(format!("{text} is not a safe full path"));
    }
    #[cfg(windows)]
    if !windows_full(text) {
        return Err(format!("{text} is not a full Windows path"));
    }
    Ok(text.to_owned())
}
struct ResolvedPath {
    path: PathBuf,
    exists: bool,
}
fn resolve_path(path: &Path) -> Result<ResolvedPath, String> {
    resolve_with(path, |p| fs::symlink_metadata(p), |p| fs::canonicalize(p))
}
fn resolve_with(
    path: &Path,
    metadata: impl Fn(&Path) -> io::Result<Metadata>,
    canonicalize: impl Fn(&Path) -> io::Result<PathBuf>,
) -> Result<ResolvedPath, String> {
    script_safe(path)?;
    if !path.is_absolute() {
        return Err(format!("{} is not a full host path", path.display()));
    }
    let mut at = path;
    let mut missing = Vec::new();
    loop {
        match metadata(at) {
            Ok(meta) => {
                if !meta.is_dir() && !link(&meta) {
                    return Err(format!("{} is not a directory", at.display()));
                }
                let mut physical = batch_path(
                    &canonicalize(at)
                        .map_err(|e| format!("cannot resolve {}: {e}", at.display()))?,
                )?;
                for name in missing.iter().rev() {
                    physical.push(name);
                }
                script_safe(&physical)?;
                return Ok(ResolvedPath {
                    path: physical,
                    exists: missing.is_empty(),
                });
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                missing.push(
                    at.file_name()
                        .ok_or_else(|| format!("cannot inspect {}: {e}", path.display()))?
                        .to_owned(),
                );
                at = at
                    .parent()
                    .ok_or_else(|| format!("cannot inspect {}: {e}", path.display()))?;
            }
            Err(e) => return Err(format!("cannot inspect {}: {e}", at.display())),
        }
    }
}
fn equal_component(a: &OsStr, b: &OsStr) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CompareStringOrdinal(
                a: *const u16,
                na: i32,
                b: *const u16,
                nb: i32,
                ignore_case: i32,
            ) -> i32;
        }
        let a: Vec<u16> = a.encode_wide().collect();
        let b: Vec<u16> = b.encode_wide().collect();
        let na = i32::try_from(a.len()).map_err(|_| "path component is too long")?;
        let nb = i32::try_from(b.len()).map_err(|_| "path component is too long")?;
        return match unsafe { CompareStringOrdinal(a.as_ptr(), na, b.as_ptr(), nb, 1) } {
            2 => Ok(true),
            1 | 3 => Ok(false),
            _ => Err(format!(
                "cannot compare Windows paths: {}",
                io::Error::last_os_error()
            )),
        };
    }
    #[cfg(unix)]
    {
        Ok(a == b)
    }
}
fn contains_or_same(parent: &Path, child: &Path) -> Result<bool, String> {
    let mut child = child.components();
    for part in parent.components() {
        let Some(other) = child.next() else {
            return Ok(false);
        };
        if !equal_component(part.as_os_str(), other.as_os_str())? {
            return Ok(false);
        }
    }
    Ok(true)
}
fn fixed_chain(path: &Path) -> Vec<PathBuf> {
    let mut chain: Vec<_> = path
        .ancestors()
        .filter(|p| p.is_absolute())
        .map(Path::to_owned)
        .collect();
    chain.reverse();
    chain
}
fn check_chain(path: &Path, allow_missing: bool) -> Result<(), String> {
    for item in fixed_chain(path) {
        match fs::symlink_metadata(&item) {
            Ok(meta) if meta.is_dir() && !link(&meta) => {}
            Err(e) if allow_missing && e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Ok(_) => {
                return Err(format!(
                    "{} is a link or is not a directory",
                    item.display()
                ));
            }
            Err(e) => return Err(format!("cannot inspect {}: {e}", item.display())),
        }
    }
    Ok(())
}
fn install_identity(install: &Path, profile: &Path) -> Result<(ResolvedPath, PathBuf), String> {
    script_safe(install)?;
    if !install.is_absolute() {
        return Err(format!("{} is not a full path", install.display()));
    }
    if !install
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|n| n.eq_ignore_ascii_case(DISPLAY_NAME))
    {
        return Err("the install is not a folder named Harness".into());
    }
    match fs::symlink_metadata(install) {
        Ok(meta) if link(&meta) => return Err("the install is a link to another folder".into()),
        Err(e) if e.kind() != io::ErrorKind::NotFound => {
            return Err(format!("cannot inspect install: {e}"));
        }
        _ => {}
    }
    let install = resolve_path(install)?;
    let profile = resolve_path(profile)?.path;
    if contains_or_same(&install.path, &profile)? {
        return Err("your profile is in it".into());
    }
    let protected = resolve_path(&profile.join(".harness"))?.path;
    if contains_or_same(&protected, &install.path)? || contains_or_same(&install.path, &protected)?
    {
        return Err("the install overlaps the command line's files".into());
    }
    check_chain(&install.path, !install.exists)?;
    Ok((install, profile))
}
pub fn check_install(install: &Path, profile: &Path) -> Result<(), String> {
    install_identity(install, profile).map(|_| ())
}
struct Prepared {
    paths: Paths,
    place: ScriptPlace,
    install_exists: bool,
}
fn prepare(paths: &Paths, place: &ScriptPlace) -> Result<Prepared, String> {
    let (install, profile) = install_identity(&paths.install, &paths.profile)?;
    let programs = resolve_path(&paths.programs)?.path;
    let temp = resolve_path(&place.temp)?;
    if contains_or_same(&install.path, &temp.path)? {
        return Err("the temp folder is inside the install".into());
    }
    if !temp.exists {
        return Err("the temp folder does not exist".into());
    }
    check_chain(&temp.path, false)?;
    check_chain(&profile, true)?;
    check_chain(&programs, true)?;
    script_safe(&place.system_root)?;
    final_removal_script(
        1,
        &install.path,
        &temp.path.join("harness-desktop-uninstall-check.log"),
        &place.system_root,
    )?;
    let mut physical = paths.clone();
    physical.install = install.path;
    physical.profile = profile;
    physical.programs = programs;
    Ok(Prepared {
        paths: physical,
        place: ScriptPlace {
            temp: temp.path,
            system_root: place.system_root.clone(),
        },
        install_exists: install.exists,
    })
}

pub fn remove_app_state(profile: &Path) -> Vec<PathBuf> {
    match resolve_path(profile) {
        Ok(profile) => remove_state_at(&profile.path),
        Err(_) => vec![profile.join(".harness")],
    }
}
fn remove_state_at(profile: &Path) -> Vec<PathBuf> {
    let root = profile.join(".harness");
    if check_chain(profile, true).is_err() {
        return vec![root];
    }
    match fs::symlink_metadata(&root) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Ok(meta) if meta.is_dir() && !link(&meta) => {}
        _ => return vec![root],
    }
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return vec![root],
    };
    let mut left = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                left.push(root.clone());
                break;
            }
        };
        if !entry
            .file_name()
            .as_encoded_bytes()
            .starts_with(DESKTOP_STATE_PREFIX.as_bytes())
        {
            continue;
        }
        if check_chain(&root, false).is_err() {
            left.push(root.clone());
            break;
        }
        let path = entry.path();
        let removed = fs::symlink_metadata(&path).and_then(|meta| {
            if link(&meta) {
                fs::remove_dir(&path).or_else(|_| fs::remove_file(&path))
            } else if meta.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            }
        });
        if removed.is_err() {
            left.push(path);
        }
    }
    left
}
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('%', "%%"))
}
fn echoed(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c == '%' {
            out.push_str("%%");
        } else {
            if "^&|<>()".contains(c) {
                out.push('^');
            }
            out.push(c);
        }
    }
    out
}
fn script_chain(text: &str) -> Vec<String> {
    if !windows_full(text) {
        return fixed_chain(Path::new(text))
            .iter()
            .map(|p| p.to_str().unwrap().to_owned())
            .collect();
    }
    let start = if text.starts_with(r"\\") {
        text.char_indices()
            .skip(2)
            .filter(|(_, c)| *c == '\\' || *c == '/')
            .nth(1)
            .map(|(i, _)| i)
            .unwrap_or(text.len())
    } else {
        3
    };
    let mut chain = vec![text[..start].to_owned()];
    for (i, _) in text
        .char_indices()
        .filter(|(i, c)| *i >= start && (*c == '\\' || *c == '/'))
    {
        if i > start && !chain.last().is_some_and(|p| p == &text[..i]) {
            chain.push(text[..i].to_owned());
        }
    }
    if chain.last().is_none_or(|p| p != text) {
        chain.push(text.to_owned());
    }
    chain
}
pub fn final_removal_script(
    pid: u32,
    install: &Path,
    log: &Path,
    system_root: &Path,
) -> Result<String, String> {
    removal_script(pid, install, log, system_root, WAIT_TRIES)
}
fn removal_script(
    pid: u32,
    install: &Path,
    log: &Path,
    system_root: &Path,
    waits: u32,
) -> Result<String, String> {
    if pid == 0 {
        return Err("the launcher PID is zero".into());
    }
    let root = script_safe(install)?;
    let log = script_safe(log)?;
    let scratch = script_safe(&PathBuf::from(&log).with_extension("tasks"))?;
    let tool =
        |name: &str| script_safe(&system_root.join("System32").join(name)).map(|p| quoted(&p));
    let (chcp, tasklist, find, ping) = (
        tool("chcp.com")?,
        tool("tasklist.exe")?,
        tool("find.exe")?,
        tool("PING.EXE")?,
    );
    let (q, l, s) = (quoted(&root), quoted(&log), quoted(&scratch));
    let mut lines = vec![
        "@echo off".into(),
        "setlocal DisableDelayedExpansion".into(),
        // Expand the existing Unicode environment before decoding any UTF-8 path.
        // Keep the fallback order identical to system_root(), then bind it to the
        // tool selected during preparation after switching the private console.
        "set \"harness_system_root=%SystemRoot%\"".into(),
        "if not defined harness_system_root set \"harness_system_root=%windir%\"".into(),
        "if not defined harness_system_root set \"harness_system_root=C:\\Windows\"".into(),
        "set \"harness_chcp=%harness_system_root%\\System32\\chcp.com\"".into(),
        "\"%harness_chcp%\" 65001 >nul".into(),
        "if errorlevel 1 goto encoding".into(),
        format!("if /i not \"%harness_chcp%\"=={chcp} goto encoding"),
        "set problem=".into(),
        "set tries=0".into(),
        ":wait".into(),
        format!("{tasklist} /FI \"PID eq {pid}\" /NH >{s} 2>nul"),
        "if errorlevel 1 goto unknown".into(),
        format!("{find} \" {pid} \" <{s} >nul 2>nul"),
        "if errorlevel 2 goto unknown".into(),
        "if errorlevel 1 goto remove".into(),
        "set /a tries+=1".into(),
        format!("if %tries% GEQ {waits} goto waiting"),
        format!("{ping} -n 2 127.0.0.1 >nul"),
        "goto wait".into(),
        ":remove".into(),
        "set pass=0".into(),
        ":again".into(),
    ];
    for parent in script_chain(&root) {
        lines.extend([
            "set attr=".into(),
            format!("for %%A in ({}) do set \"attr=%%~aA\"", quoted(&parent)),
            "if \"%attr%\"==\"\" goto refused".into(),
            "if not \"%attr%\"==\"%attr:l=%\" goto refused".into(),
            "if \"%attr%\"==\"%attr:d=%\" goto refused".into(),
        ]);
    }
    lines.extend([
        format!("rmdir /s /q {q} 2>nul"),
        "if not errorlevel 1 goto done".into(),
        "set /a pass+=1".into(),
        format!("if %pass% GEQ {REMOVE_PASSES} goto report"),
        format!("{ping} -n 3 127.0.0.1 >nul"),
        "goto again".into(),
    ]);
    for (label, reason) in [
        ("waiting", "its launcher is still running"),
        (
            "unknown",
            "Windows could not confirm that its launcher had exited",
        ),
        (
            "refused",
            "a folder is a link or its directory attributes could not be verified",
        ),
        ("report", "a program still had it open"),
    ] {
        lines.extend([
            format!(":{label}"),
            "set problem=1".into(),
            format!(">{l} echo Harness left {} because {reason}.", echoed(&root)),
            "goto done".into(),
        ]);
    }
    lines.extend([
        ":done".into(),
        format!("del /f /q {s} 2>nul"),
        format!("if not defined problem del /f /q {l} 2>nul"),
        "(goto) 2>nul & del \"%~f0\"".into(),
        ":encoding".into(),
        ">\"%~dpn0.log\" echo Windows could not enable UTF-8; no install files were removed."
            .into(),
        "del /f /q \"%~dpn0.tasks\" 2>nul".into(),
        "(goto) 2>nul & del \"%~f0\"".into(),
        String::new(),
    ]);
    Ok(lines.join("\r\n"))
}
pub fn schedule_final_removal(
    install: &Path,
    place: &ScriptPlace,
    system: &mut impl System,
) -> Result<(), String> {
    if fs::symlink_metadata(install).is_ok_and(|m| link(&m)) {
        return Err("the install is a link to another folder".into());
    }
    let root = resolve_path(install)?;
    check_chain(&root.path, !root.exists)?;
    let temp = resolve_path(&place.temp)?;
    if contains_or_same(&root.path, &temp.path)? {
        return Err("the temp folder is inside the install".into());
    }
    if !temp.exists {
        return Err("the temp folder does not exist".into());
    }
    schedule_at(
        &root.path,
        &ScriptPlace {
            temp: temp.path,
            system_root: place.system_root.clone(),
        },
        system,
        |f, t| {
            f.write_all(t)?;
            f.flush()
        },
    )
}

#[cfg(any(windows, test))]
pub(super) fn script_warning(install: &Path, warning: &str) {
    super::launch::log(install, warning);
}
fn schedule_at(
    install: &Path,
    place: &ScriptPlace,
    system: &mut impl System,
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> Result<(), String> {
    check_chain(install, false)?;
    check_chain(&place.temp, false)?;
    let stamp = format!("{}-{}", system.pid(), system.now_ms());
    let script = place
        .temp
        .join(format!("harness-desktop-uninstall-{stamp}.cmd"));
    let log = script.with_extension("log");
    let scratch = script.with_extension("tasks");
    let text = final_removal_script(system.pid(), install, &log, &place.system_root)?;
    let mut owned = Vec::new();
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&script)
            .map_err(|e| format!("could not write {}: {e}", script.display()))?;
        owned.push(script.clone());
        write(&mut file, text.as_bytes())
            .map_err(|e| format!("could not write {}: {e}", script.display()))?;
        drop(file);
        for path in [&log, &scratch] {
            script_safe(path)?;
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|e| format!("could not write {}: {e}", path.display()))?;
            owned.push(path.to_owned());
        }
        system.start_script_logged(&script, install).map_err(|e| {
            format!(
                "Windows did not start the step that removes {}: {e}",
                install.display()
            )
        })
    })();
    if let Err(mut error) = result {
        for path in owned {
            if let Err(e) = fs::remove_file(&path) {
                error.push_str(&format!("; {} stayed ({e})", path.display()));
            }
        }
        return Err(error);
    }
    Ok(())
}

pub fn run(
    paths: &Paths,
    place: &ScriptPlace,
    system: &mut impl System,
) -> Result<Vec<String>, String> {
    run_prepared(prepare(paths, place)?, system)
}
fn run_prepared(prepared: Prepared, system: &mut impl System) -> Result<Vec<String>, String> {
    let (prepared, mut problems) = run_steps(prepared, system)?;
    finish_removal(&prepared, system, &mut problems);
    Ok(problems)
}
fn run_steps(
    prepared: Prepared,
    system: &mut impl System,
) -> Result<(Prepared, Vec<String>), String> {
    let Prepared {
        paths,
        place: _,
        install_exists,
    } = &prepared;
    check_chain(&paths.install, !install_exists)?;
    system
        .quit_app(&paths.install, QUIT_WAIT)
        .map_err(|e| format!("Harness could not quit the desktop app: {e}"))?;
    let mut problems = Vec::new();
    let shortcut =
        check_chain(&paths.programs, true).and_then(|_| match fs::remove_file(paths.shortcut()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        });
    if let Err(e) = shortcut {
        problems.push(format!("the Start Menu shortcut stayed ({e})"));
    }
    for key in [
        registry::protocol_key(registry::SCHEME),
        registry::UNINSTALL_KEY.to_owned(),
    ] {
        if let Err(e) = system.delete_key(&paths.registry, &key) {
            problems.push(format!(
                "HKEY_CURRENT_USER\\{}\\{key} stayed ({e})",
                paths.registry
            ));
        }
    }
    problems.extend(
        remove_state_at(&paths.profile)
            .into_iter()
            .map(|p| format!("{} stayed", p.display())),
    );
    Ok((prepared, problems))
}
fn finish_removal(prepared: &Prepared, system: &mut impl System, problems: &mut Vec<String>) {
    if prepared.install_exists {
        if let Err(e) = schedule_at(&prepared.paths.install, &prepared.place, system, |f, t| {
            f.write_all(t)?;
            f.flush()
        }) {
            problems.push(format!(
                "{e}; when this command ends, delete {} yourself",
                prepared.paths.install.display()
            ));
        }
    }
}
pub fn main(paths: &Paths, system: &mut impl System) -> i32 {
    main_at(paths, &ScriptPlace::current(), system)
}
fn main_at(paths: &Paths, place: &ScriptPlace, system: &mut impl System) -> i32 {
    match prepare(paths, place).and_then(|prepared| run_steps(prepared, system)) {
        Ok((prepared, mut problems)) => {
            let good = problems.is_empty();
            let text = if good {
                "The Harness desktop app will finish uninstalling after this window closes."
                    .to_owned()
            } else {
                format!(
                    "The Harness desktop app could not be fully removed: {}.",
                    problems.join("; ")
                )
            };
            // MessageBox may stay open indefinitely; start the bounded launcher wait only after it closes.
            system.say(&format!("{text}\n\n{FINAL_MESSAGE}"));
            let prior = problems.len();
            finish_removal(&prepared, system, &mut problems);
            if problems.len() > prior {
                system.say(&format!(
                    "The Harness desktop app could not be fully removed: {}.\n\n{FINAL_MESSAGE}",
                    problems[prior..].join("; ")
                ));
            }
            if problems.is_empty() {
                EXIT_OK
            } else {
                EXIT_FAILED
            }
        }
        Err(error) => {
            system.say(&format!(
                "{error}. App files and settings were not removed.\n\n{FINAL_MESSAGE}"
            ));
            EXIT_FAILED
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::system::Fake;

    struct ModalSystem {
        fake: Fake,
        dialog_dismissed: bool,
        script_attempted: bool,
    }

    impl System for ModalSystem {
        fn start_app(&mut self, _: &Path, _: &Path, _: &[OsString]) -> io::Result<(u32, u64)> {
            unreachable!()
        }
        fn wait_for_exit(&mut self, _: u32, _: Duration) -> io::Result<()> {
            unreachable!()
        }
        fn liveness(&mut self, _: u32, _: u64) -> crate::desktop::rollback::Liveness {
            unreachable!()
        }
        fn app_processes(&mut self, _: &Path) -> Vec<u32> {
            unreachable!()
        }
        fn quit_app(&mut self, root: &Path, wait: Duration) -> io::Result<usize> {
            self.fake.quit_app(root, wait)
        }
        fn read_value(&mut self, _: &str, _: &str, _: &str) -> Option<OsString> {
            unreachable!()
        }
        fn write_keys(&mut self, _: &str, _: &[registry::Key]) -> io::Result<()> {
            unreachable!()
        }
        fn delete_key(&mut self, registry: &str, key: &str) -> io::Result<()> {
            self.fake.delete_key(registry, key)
        }
        fn start_script(&mut self, script: &Path) -> io::Result<()> {
            assert!(
                self.dialog_dismissed,
                "cleanup started before the final dialog closed"
            );
            self.script_attempted = true;
            self.fake.start_script(script)
        }
        fn pid(&mut self) -> u32 {
            self.fake.pid()
        }
        fn create_shortcut(&mut self, _: &Path, _: &Path, _: &Path, _: &Path) -> io::Result<()> {
            unreachable!()
        }
        fn say(&mut self, text: &str) {
            self.dialog_dismissed = true;
            self.fake.say(text);
        }
        fn now_ms(&mut self) -> u64 {
            self.fake.now_ms()
        }
    }

    #[test]
    fn final_removal_starts_only_after_the_modal_message_closes() {
        let World { _dir, paths, place } = world();
        let mut system = ModalSystem {
            fake: Fake::default(),
            dialog_dismissed: false,
            script_attempted: false,
        };
        assert_eq!(main_at(&paths, &place, &mut system), EXIT_OK);
        assert!(system.script_attempted);
        assert_eq!(system.fake.said.len(), 1);
    }

    #[test]
    fn cleanup_start_failure_after_dialog_gets_an_explicit_second_message() {
        let World { _dir, paths, place } = world();
        let mut system = ModalSystem {
            fake: Fake {
                fail_script: true,
                ..Fake::default()
            },
            dialog_dismissed: false,
            script_attempted: false,
        };
        assert_eq!(main_at(&paths, &place, &mut system), EXIT_FAILED);
        assert!(system.script_attempted);
        assert_eq!(system.fake.said.len(), 2);
        assert!(system.fake.said[1].contains("Windows did not start the step"));
        assert!(system.fake.said[1].contains("delete"));
        assert!(fs::read_dir(&place.temp).unwrap().next().is_none());
    }

    #[test]
    fn inspection_errors_never_become_missing_paths() {
        let World { _dir, paths, .. } = world();
        assert!(
            resolve_with(
                &paths.install,
                |_| Err(io::ErrorKind::PermissionDenied.into()),
                |_| panic!("access failure must not canonicalize or fall back")
            )
            .is_err()
        );
        let missing = paths.install.join("not-created").join("more");
        let resolved = resolve_path(&missing).unwrap();
        assert!(!resolved.exists);
        assert_eq!(resolved.path, missing);
        assert!(!resolved.path.exists());
    }

    #[test]
    fn owned_partial_write_is_cleaned_and_registry_failures_are_reported() {
        let World { _dir, paths, place } = world();
        let mut system = Fake::default();
        assert!(
            schedule_at(&paths.install, &place, &mut system, |file, _| {
                file.write_all(b"partial")?;
                Err(io::ErrorKind::WriteZero.into())
            })
            .is_err()
        );
        assert!(system.scripts.is_empty());
        assert!(fs::read_dir(&place.temp).unwrap().next().is_none());
        let mut system = Fake {
            fail_delete: true,
            ..Fake::default()
        };
        assert_eq!(main_at(&paths, &place, &mut system), EXIT_FAILED);
        assert!(system.said[0].contains("HKEY_CURRENT_USER"));
        assert!(system.said[0].ends_with(FINAL_MESSAGE));
    }

    #[cfg(windows)]
    #[test]
    fn canonical_windows_paths_preserve_unc_and_ordinal_components() {
        assert_eq!(
            batch_path(Path::new(r"\\?\C:\Users\Nguyễn\Harness")).unwrap(),
            PathBuf::from(r"C:\Users\Nguyễn\Harness")
        );
        assert_eq!(
            batch_path(Path::new(r"\\?\UNC\server\share\Nguyễn\Harness")).unwrap(),
            PathBuf::from(r"\\server\share\Nguyễn\Harness")
        );
        assert!(batch_path(Path::new(r"\\?\Volume{123}\Harness")).is_err());
        assert!(
            contains_or_same(Path::new(r"C:\Ä\Harness"), Path::new(r"c:\ä\HARNESS\child")).unwrap()
        );
        assert!(!contains_or_same(Path::new(r"C:\Harness"), Path::new(r"C:\Harness2")).unwrap());
        assert!(
            !contains_or_same(
                Path::new(r"\\server\share\Harness"),
                Path::new(r"\\server\other\Harness")
            )
            .unwrap()
        );
    }

    #[test]
    fn failed_quit_preserves_files_registration_state_and_script_directory() {
        let World { _dir, paths, place } = world();
        let mut system = Fake {
            fail_quit: true,
            ..Fake::default()
        };
        let keys =
            registry::uninstall_keys(&paths.install, "1.2.3", &paths.install.join("Harness.ico"));
        system.write_keys(&paths.registry, &keys).unwrap();
        let values = system.values.clone();
        let numbers = system.numbers.clone();
        assert!(
            run(&paths, &place, &mut system)
                .unwrap_err()
                .contains("quit")
        );
        assert!(paths.shortcut().exists());
        assert!(
            paths
                .profile
                .join(".harness/desktop-app/state.json")
                .exists()
        );
        assert!(paths.install.join("Harness.exe").exists());
        assert_eq!(system.values, values);
        assert_eq!(system.numbers, numbers);
        assert!(system.deleted.is_empty() && system.scripts.is_empty());
        assert!(fs::read_dir(&place.temp).unwrap().next().is_none());
    }

    #[test]
    fn invalid_places_fail_before_quit_or_any_deletion() {
        let World { _dir, paths, place } = world();
        for temp in [
            paths.install.clone(),
            paths.install.join("tmp"),
            place.temp.join("missing"),
        ] {
            let bad = ScriptPlace {
                temp,
                system_root: place.system_root.clone(),
            };
            let mut system = Fake::default();
            assert!(run(&paths, &bad, &mut system).is_err());
            assert!(paths.shortcut().exists());
            assert!(
                system.quit.is_empty() && system.deleted.is_empty() && system.scripts.is_empty()
            );
        }
    }

    #[test]
    fn missing_install_still_cleans_owned_registration_and_state() {
        let World { _dir, paths, place } = world();
        fs::remove_dir_all(&paths.install).unwrap();
        let mut system = Fake::default();
        assert!(run(&paths, &place, &mut system).unwrap().is_empty());
        assert!(!paths.shortcut().exists());
        assert!(!paths.profile.join(".harness/desktop-app").exists());
        assert_eq!(
            fs::read(paths.profile.join(".harness/cli/state.json")).unwrap(),
            b"{}"
        );
        assert!(system.scripts.is_empty());
        assert!(!paths.install.exists());
    }

    #[test]
    fn install_cannot_overlap_preserved_cli_data() {
        let World { _dir, paths, place } = world();
        let bad = Paths {
            install: paths.profile.join(".harness/cli/Harness"),
            ..paths.clone()
        };
        let mut system = Fake::default();
        assert!(run(&bad, &place, &mut system).is_err());
        assert!(paths.shortcut().exists() && system.quit.is_empty());
        assert_eq!(
            fs::read(paths.profile.join(".harness/cli/state.json")).unwrap(),
            b"{}"
        );
    }

    #[test]
    fn script_collision_never_truncates_or_removes_someone_elses_file() {
        let World { _dir, paths, place } = world();
        let script = place
            .temp
            .join("harness-desktop-uninstall-4242-1001000.cmd");
        fs::write(&script, b"keep").unwrap();
        assert!(schedule_final_removal(&paths.install, &place, &mut Fake::default()).is_err());
        assert_eq!(fs::read(script).unwrap(), b"keep");
    }

    #[test]
    fn state_inspection_failure_is_a_leftover_not_success() {
        let World { _dir, paths, .. } = world();
        let root = paths.profile.join(".harness");
        fs::remove_dir_all(&root).unwrap();
        fs::write(&root, b"not a directory").unwrap();
        assert_eq!(remove_app_state(&paths.profile), vec![root]);
    }

    #[test]
    fn relative_script_paths_and_zero_pids_are_refused() {
        for path in [
            "relative",
            "C:relative",
            r"C:\a\..\Harness",
            r"C:\a|b\Harness",
        ] {
            assert!(script_safe(Path::new(path)).is_err(), "{path}");
        }
        assert!(
            final_removal_script(
                0,
                Path::new(r"C:\T\Harness"),
                Path::new(r"C:\T\log"),
                Path::new(r"C:\Windows")
            )
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn prepared_physical_identity_survives_logical_parent_retarget() {
        use std::os::unix::fs::symlink;
        let World { _dir, paths, place } = world();
        let logical = _dir.path().join("redirect");
        symlink(paths.install.parent().unwrap(), &logical).unwrap();
        let input = Paths {
            install: logical.join("Harness"),
            ..paths.clone()
        };
        let accepted = prepare(&input, &place).unwrap();
        fs::remove_file(&logical).unwrap();
        let other = _dir.path().join("keep");
        fs::create_dir_all(other.join("Harness")).unwrap();
        fs::write(other.join("Harness/sentinel"), b"outside").unwrap();
        symlink(&other, &logical).unwrap();
        let mut system = Fake::default();
        assert!(run_prepared(accepted, &mut system).unwrap().is_empty());
        assert_eq!(system.script_roots, vec![paths.install.clone()]);
        assert!(
            system.scripts[0]
                .1
                .contains(&paths.install.to_str().unwrap().replace('%', "%%"))
        );
        assert_eq!(
            fs::read(other.join("Harness/sentinel")).unwrap(),
            b"outside"
        );
    }

    #[cfg(unix)]
    #[test]
    fn breakaway_warning_logs_to_the_accepted_physical_install() {
        let World { _dir, paths, place } = world();
        let logical = _dir.path().join("warning-alias");
        std::os::unix::fs::symlink(paths.install.parent().unwrap(), &logical).unwrap();
        let input = Paths {
            install: logical.join("Harness"),
            ..paths.clone()
        };
        let accepted = prepare(&input, &place).unwrap();
        fs::remove_file(&logical).unwrap();
        let alternate = _dir.path().join("alternate");
        fs::create_dir_all(alternate.join("Harness")).unwrap();
        std::os::unix::fs::symlink(&alternate, &logical).unwrap();
        crate::launcher::start(
            |flags| {
                if flags & crate::breakaway::CREATE_BREAKAWAY_FROM_JOB != 0 {
                    Err(io::Error::from_raw_os_error(5))
                } else {
                    Ok(7)
                }
            },
            |warning| script_warning(&accepted.paths.install, &warning),
        )
        .unwrap();
        let log = fs::read_to_string(paths.install.join("launch.log")).unwrap();
        assert!(log.contains("inside the job"), "{log}");
        assert!(!alternate.join("Harness").join("launch.log").exists());
    }

    #[cfg(unix)]
    #[test]
    fn new_physical_parent_link_is_refused_without_following() {
        use std::os::unix::fs::symlink;
        let World { _dir, paths, place } = world();
        let accepted = prepare(&paths, &place).unwrap();
        let parent = paths.install.parent().unwrap();
        let moved = parent.with_extension("saved");
        fs::rename(parent, &moved).unwrap();
        let outside = _dir.path().join("outside");
        fs::create_dir_all(outside.join("Harness")).unwrap();
        fs::write(outside.join("Harness/keep"), b"outside").unwrap();
        symlink(&outside, parent).unwrap();
        let mut system = Fake::default();
        assert!(run_prepared(accepted, &mut system).is_err());
        assert!(system.quit.is_empty() && system.scripts.is_empty());
        assert_eq!(fs::read(outside.join("Harness/keep")).unwrap(), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn linked_harness_root_is_reported_without_touching_target() {
        let World { _dir, paths, .. } = world();
        let root = paths.profile.join(".harness");
        fs::remove_dir_all(&root).unwrap();
        let outside = _dir.path().join("outside");
        fs::create_dir_all(outside.join("desktop-app")).unwrap();
        fs::write(outside.join("desktop-app/keep"), b"outside").unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        assert_eq!(remove_app_state(&paths.profile), vec![root]);
        assert_eq!(
            fs::read(outside.join("desktop-app/keep")).unwrap(),
            b"outside"
        );
    }

    #[cfg(windows)]
    mod native {
        use super::super::owned_windows::OwnedProcesses;
        use super::*;
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::time::Instant;

        struct Native {
            owned: OwnedProcesses,
            dir: tempfile::TempDir,
            install: PathBuf,
            temp: PathBuf,
            tools: PathBuf,
        }
        impl Drop for Native {
            fn drop(&mut self) {
                if let Err(error) = self.owned.cleanup(Duration::from_secs(5)) {
                    self.dir.disable_cleanup(true);
                    eprintln!("retained {}: {error}", self.dir.path().display());
                    if !std::thread::panicking() {
                        panic!("native fixture cleanup: {error}");
                    }
                }
            }
        }
        impl Native {
            fn new() -> Self {
                let dir = tempfile::Builder::new()
                    .prefix("Nguyễn A' & %OS% !x! (2)^")
                    .tempdir()
                    .unwrap();
                let fixture = Self {
                    owned: OwnedProcesses::new(dir.path()),
                    install: dir.path().join("apps").join("Harness"),
                    temp: dir.path().join("Temp"),
                    tools: system_root(),
                    dir,
                };
                for p in [&fixture.install, &fixture.temp] {
                    fs::create_dir_all(p).unwrap();
                }
                fs::write(fixture.install.join("desktop"), b"owned").unwrap();
                fs::write(fixture.dir.path().join("keep"), b"outside").unwrap();
                fixture
            }
            fn tool_paths(&self) -> Vec<PathBuf> {
                [
                    "cmd.exe",
                    "chcp.com",
                    "tasklist.exe",
                    "find.exe",
                    "PING.EXE",
                ]
                .map(|name| self.tools.join("System32").join(name))
                .into()
            }
            fn command(&self) -> Command {
                let mut command = Command::new(self.tools.join("System32").join("cmd.exe"));
                command
                    .args(["/d", "/v:off", "/c"])
                    .creation_flags(0x0800_0000 | 0x0000_0200)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                command
            }
            fn wait(&self, child: &mut std::process::Child) {
                self.owned
                    .observe_child(
                        child,
                        &self.tools.join("System32").join("cmd.exe"),
                        &self.tool_paths(),
                    )
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(30);
                while child.try_wait().unwrap().is_none() {
                    self.owned.live_count().unwrap();
                    assert!(Instant::now() < deadline, "owned command timed out");
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            fn exited_pid(&self) -> u32 {
                let mut child = self.command().args(["exit", "0"]).spawn().unwrap();
                let pid = child.id();
                self.wait(&mut child);
                pid
            }
            fn text(&self, pid: u32) -> String {
                removal_script(
                    pid,
                    &self.install,
                    &self.temp.join("harness-desktop-uninstall-1-1.log"),
                    &self.tools,
                    1,
                )
                .unwrap()
            }
            fn execute(&self, text: &str) -> String {
                self.execute_with_codepage(text, false)
            }
            fn execute_with_codepage(&self, text: &str, start_437: bool) -> String {
                let script = self.temp.join("harness-desktop-uninstall-1-1.cmd");
                let log = script.with_extension("log");
                let scratch = script.with_extension("tasks");
                for (path, bytes) in [
                    (&script, text.as_bytes()),
                    (&log, &b""[..]),
                    (&scratch, &b""[..]),
                ] {
                    let mut file = File::create_new(path).unwrap();
                    file.write_all(bytes).unwrap();
                }
                let entry = if start_437 {
                    fs::write(
                        self.temp.join("start-437.cmd"),
                        concat!(
                            "@echo off\r\n",
                            "\"%SystemRoot%\\System32\\chcp.com\" 437 >nul\r\n",
                            "if errorlevel 1 exit /b 1\r\n",
                            "\"%SystemRoot%\\System32\\chcp.com\" >initial-codepage.txt\r\n",
                            "call .\\harness-desktop-uninstall-1-1.cmd\r\n",
                        ),
                    )
                    .unwrap();
                    r".\start-437.cmd"
                } else {
                    r".\harness-desktop-uninstall-1-1.cmd"
                };
                let mut child = self
                    .command()
                    .arg(entry)
                    .current_dir(&self.temp)
                    .spawn()
                    .unwrap();
                self.wait(&mut child);
                assert!(
                    !script.exists(),
                    "script did not finish; log={:?}",
                    fs::read_to_string(&log)
                );
                assert!(!scratch.exists(), "enumeration scratch stayed");
                fs::read_to_string(log).unwrap_or_default()
            }
        }

        #[test]
        fn unicode_script_bootstraps_from_437_without_changing_the_parent_console() {
            use windows_sys::Win32::System::Console::{GetConsoleCP, GetConsoleOutputCP};
            let parent = unsafe { (GetConsoleCP(), GetConsoleOutputCP()) };
            let fixture = Native::new();
            let text = fixture.text(fixture.exited_pid());
            assert!(fixture.execute_with_codepage(&text, true).is_empty());
            let initial = fs::read(fixture.temp.join("initial-codepage.txt")).unwrap();
            assert!(
                String::from_utf8_lossy(&initial).contains("437"),
                "{initial:?}"
            );
            assert!(!fixture.install.exists());
            assert_eq!(unsafe { (GetConsoleCP(), GetConsoleOutputCP()) }, parent);
            assert_eq!(
                fs::read(fixture.dir.path().join("keep")).unwrap(),
                b"outside"
            );
        }
        #[test]
        fn actual_script_removes_only_install_with_unicode_and_metacharacters() {
            let fixture = Native::new();
            let text = fixture.text(fixture.exited_pid());
            assert!(fixture.execute(&text).is_empty());
            assert!(!fixture.install.exists());
            assert_eq!(
                fs::read(fixture.dir.path().join("keep")).unwrap(),
                b"outside"
            );
        }
        #[test]
        fn live_launcher_timeout_retains_install_and_explains_why() {
            let fixture = Native::new();
            let log = fixture.execute(&fixture.text(std::process::id()));
            assert!(log.contains("launcher is still running"), "{log}");
            assert_eq!(fs::read(fixture.install.join("desktop")).unwrap(), b"owned");
        }
        #[test]
        fn unknown_enumeration_or_match_status_never_authorizes_removal() {
            for absent in ["tasklist.exe", "find.exe"] {
                let fixture = Native::new();
                let selected =
                    quoted(&script_safe(&fixture.tools.join("System32").join(absent)).unwrap());
                let missing = quoted(&script_safe(&fixture.dir.path().join(absent)).unwrap());
                let text = fixture
                    .text(std::process::id())
                    .replacen(&selected, &missing, 1);
                assert!(!text.contains(&selected));
                let log = fixture.execute(&text);
                assert!(log.contains("could not confirm"), "{absent}: {log}");
                assert_eq!(fs::read(fixture.install.join("desktop")).unwrap(), b"owned");
            }
        }
        #[test]
        fn fixed_physical_parent_junction_is_refused_and_outside_bytes_stay() {
            use std::os::windows::fs::MetadataExt;
            let fixture = Native::new();
            let text = fixture.text(fixture.exited_pid());
            fs::rename(
                fixture.dir.path().join("apps"),
                fixture.dir.path().join("saved"),
            )
            .unwrap();
            fs::create_dir_all(fixture.dir.path().join("outside").join("Harness")).unwrap();
            fs::write(
                fixture
                    .dir
                    .path()
                    .join("outside")
                    .join("Harness")
                    .join("keep"),
                b"outside",
            )
            .unwrap();
            let mut child = fixture
                .command()
                .args(["mklink", "/J", "apps", "outside"])
                .current_dir(fixture.dir.path())
                .spawn()
                .unwrap();
            fixture.wait(&mut child);
            let parent = fixture.dir.path().join("apps");
            assert_ne!(
                fs::symlink_metadata(&parent).unwrap().file_attributes() & 0x400,
                0
            );
            let log = fixture.execute(&text);
            assert!(log.contains("link") || log.contains("attributes"), "{log}");
            assert_eq!(
                fs::read(
                    fixture
                        .dir
                        .path()
                        .join("outside")
                        .join("Harness")
                        .join("keep")
                )
                .unwrap(),
                b"outside"
            );
            assert_eq!(
                fs::read(
                    fixture
                        .dir
                        .path()
                        .join("saved")
                        .join("Harness")
                        .join("desktop")
                )
                .unwrap(),
                b"owned"
            );
            fs::remove_dir(parent).unwrap();
        }
        #[test]
        fn vanished_root_has_unknown_attributes_and_cannot_trigger_rmdir() {
            let fixture = Native::new();
            let text = fixture.text(fixture.exited_pid());
            fs::remove_dir_all(&fixture.install).unwrap();
            assert!(fixture.execute(&text).contains("attributes"));
            assert_eq!(
                fs::read(fixture.dir.path().join("keep")).unwrap(),
                b"outside"
            );
        }
        #[test]
        fn desktop_state_junctions_never_empty_the_outside_target() {
            use std::os::windows::fs::MetadataExt;
            let fixture = Native::new();
            let profile = fixture.dir.path().join("profile");
            let harness = profile.join(".harness");
            let outside = fixture.dir.path().join("outside");
            fs::create_dir_all(&harness).unwrap();
            fs::create_dir_all(&outside).unwrap();
            fs::write(outside.join("keep"), b"outside").unwrap();
            let mut child = fixture
                .command()
                .args(["mklink", "/J", "desktop-app", r"..\..\outside"])
                .current_dir(&harness)
                .spawn()
                .unwrap();
            fixture.wait(&mut child);
            let entry = harness.join("desktop-app");
            assert_ne!(
                fs::symlink_metadata(&entry).unwrap().file_attributes() & 0x400,
                0
            );
            assert_eq!(fs::read(entry.join("keep")).unwrap(), b"outside");
            assert!(remove_app_state(&profile).is_empty());
            assert!(fs::symlink_metadata(&entry).is_err());
            assert_eq!(fs::read(outside.join("keep")).unwrap(), b"outside");
            fs::remove_dir(&harness).unwrap();
            let mut child = fixture
                .command()
                .args(["mklink", "/J", ".harness", r"..\outside"])
                .current_dir(&profile)
                .spawn()
                .unwrap();
            fixture.wait(&mut child);
            assert_ne!(
                fs::symlink_metadata(&harness).unwrap().file_attributes() & 0x400,
                0
            );
            assert_eq!(remove_app_state(&profile).len(), 1);
            assert_eq!(fs::read(outside.join("keep")).unwrap(), b"outside");
            fs::remove_dir(harness).unwrap();
        }
        #[test]
        fn real_start_failure_propagates_without_a_process() {
            let fixture = Native::new();
            let absent = fixture
                .temp
                .join("missing")
                .join("harness-desktop-uninstall-1-1.cmd");
            assert!(crate::desktop::win::start_script(&absent).is_err());
        }
    }

    struct World {
        _dir: tempfile::TempDir,
        paths: Paths,
        place: ScriptPlace,
    }

    /// An installed Harness under a profile named as Review Focus 1 asks, with the CLI's `.harness` beside the app's.
    fn world() -> World {
        let dir = tempfile::tempdir().unwrap();
        let profile = batch_path(&fs::canonicalize(dir.path()).unwrap())
            .unwrap()
            .join("Nguyễn Văn A' & 100% !x");
        let install = profile.join("Programs").join("Harness");
        fs::create_dir_all(install.join("app").join("1.2.3")).unwrap();
        fs::write(install.join("Harness.exe"), b"").unwrap();
        let programs = profile.join("Start Menu");
        fs::create_dir_all(&programs).unwrap();
        fs::write(programs.join("Harness.lnk"), b"").unwrap();
        for entry in ["desktop-app", "desktop-app-v2", "cli", "runtime"] {
            fs::create_dir_all(profile.join(".harness").join(entry)).unwrap();
            fs::write(
                profile.join(".harness").join(entry).join("state.json"),
                b"{}",
            )
            .unwrap();
        }
        fs::write(profile.join(".harness").join("daemon-token"), b"t").unwrap();
        let temp = dir.path().join("temp");
        fs::create_dir_all(&temp).unwrap();
        let place = ScriptPlace {
            temp,
            system_root: PathBuf::from(r"C:\Windows"),
        };
        let paths = Paths {
            own: install.clone(),
            install,
            programs,
            registry: r"Software\HarnessTest".into(),
            profile,
        };
        World {
            _dir: dir,
            paths,
            place,
        }
    }

    #[test]
    fn removes_the_app_and_leaves_the_cli_alone() {
        let World { _dir, paths, place } = world();
        let mut system = Fake {
            running: vec![3],
            ..Fake::default()
        };
        assert_eq!(
            run(&paths, &place, &mut system).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            system.quit,
            vec![batch_path(&fs::canonicalize(&paths.install).unwrap()).unwrap()]
        );
        assert!(!paths.shortcut().exists());
        assert_eq!(
            system.deleted,
            vec![
                (paths.registry.clone(), r"Classes\harness".to_owned()),
                (paths.registry.clone(), registry::UNINSTALL_KEY.to_owned())
            ]
        );
        let harness = paths.profile.join(".harness");
        assert!(!harness.join("desktop-app").exists() && !harness.join("desktop-app-v2").exists());
        assert!(
            harness.join("cli").join("state.json").exists() && harness.join("runtime").exists()
        );
        assert!(harness.join("daemon-token").exists());
        // The folder itself goes once the launcher has exited.
        assert!(paths.install.exists());
        assert_eq!(system.scripts.len(), 1);
        assert!(system.scripts[0].1.contains(&format!(
            "rmdir /s /q \"{}\"",
            paths.install.display().to_string().replace('%', "%%")
        )));
    }

    #[test]
    fn codepage_bootstrap_is_ascii_until_the_switch_and_checks_the_selected_tool() {
        let text = final_removal_script(
            42,
            Path::new(r"C:\Users\Nguyễn\Harness"),
            Path::new(r"C:\Temp\remove.log"),
            Path::new(r"C:\Nguyễn Windows"),
        )
        .unwrap();
        let (prelude, rest) = text.split_once("65001 >nul").unwrap();
        assert!(prelude.is_ascii(), "{prelude}");
        assert!(prelude.contains("%SystemRoot%") && prelude.contains("%windir%"));
        let selected = Path::new(r"C:\Nguyễn Windows")
            .join("System32")
            .join("chcp.com");
        let check = rest.find(&script_safe(&selected).unwrap()).unwrap();
        assert!(check < rest.find("tasklist.exe").unwrap());
        assert!(rest[..check].contains("if /i not"));
    }

    #[test]
    fn main_ends_with_the_line_about_the_cli() {
        let World { _dir, paths, place } = world();
        let mut system = Fake::default();
        assert_eq!(main_at(&paths, &place, &mut system), EXIT_OK);
        assert!(system.said[0].ends_with(FINAL_MESSAGE), "{:?}", system.said);
    }

    #[test]
    fn refuses_an_install_folder_that_is_not_harness_or_holds_the_profile() {
        let World { _dir, paths, place } = world();
        for install in [
            paths.profile.clone(),
            paths.profile.join("Programs"),
            PathBuf::from("Harness"),
            paths.profile.join("x").join("..").join("Harness"),
        ] {
            let bad = Paths {
                install,
                ..paths.clone()
            };
            assert!(
                run(&bad, &place, &mut Fake::default()).is_err(),
                "{:?}",
                bad.install
            );
        }
        let above = Paths {
            install: paths.profile.parent().unwrap().join("Harness"),
            profile: paths.profile.parent().unwrap().join("Harness").join("me"),
            ..paths.clone()
        };
        assert!(
            check_install(&above.install, &above.profile)
                .unwrap_err()
                .contains("your profile is in it")
        );
        // Nothing was touched.
        assert!(
            paths.shortcut().exists()
                && paths.profile.join(".harness").join("desktop-app").exists()
        );
    }

    #[cfg(unix)]
    #[test]
    fn links_are_removed_as_links_and_never_followed() {
        let World { _dir, paths, place } = world();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep"), b"x").unwrap();
        let harness = paths.profile.join(".harness");
        fs::remove_dir_all(harness.join("desktop-app")).unwrap();
        std::os::unix::fs::symlink(outside.path(), harness.join("desktop-app")).unwrap();
        run(&paths, &place, &mut Fake::default()).unwrap();
        assert!(fs::symlink_metadata(harness.join("desktop-app")).is_err());
        assert!(outside.path().join("keep").exists());
        // An install folder that is a link is refused.
        let linked = paths.profile.join("Linked").join("Harness");
        fs::create_dir_all(linked.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(outside.path(), &linked).unwrap();
        assert!(
            check_install(&linked, &paths.profile)
                .unwrap_err()
                .contains("is a link")
        );
        let link_place = ScriptPlace {
            temp: _dir.path().join("link-temp"),
            system_root: place.system_root.clone(),
        };
        fs::create_dir_all(&link_place.temp).unwrap();
        assert!(
            schedule_final_removal(&linked, &link_place, &mut Fake::default())
                .unwrap_err()
                .contains("link")
        );
    }

    #[test]
    fn the_script_waits_for_the_launcher_and_carries_the_path_as_data() {
        let install =
            PathBuf::from(r"C:\Users\Nguyễn Văn A' & 100% !x (2)\AppData\Local\Programs\Harness");
        let text = final_removal_script(
            4242,
            &install,
            Path::new(r"C:\T\h.log"),
            Path::new(r"C:\Windows"),
        )
        .unwrap();
        // Joined by the host's rules, so the test reads the same on every OS.
        let tool = |name: &str| {
            Path::new(r"C:\Windows")
                .join("System32")
                .join(name)
                .display()
                .to_string()
        };
        assert!(text.starts_with("@echo off\r\nsetlocal DisableDelayedExpansion\r\n"));
        assert!(text.contains(&format!(
            "if /i not \"%harness_chcp%\"==\"{}\" goto encoding",
            tool("chcp.com")
        )));
        assert!(text.contains(&format!(
            r#""{}" /FI "PID eq 4242" /NH >"C:\T\h.tasks" 2>nul"#,
            tool("tasklist.exe")
        )));
        assert!(text.contains("if errorlevel 2 goto unknown\r\nif errorlevel 1 goto remove"));
        assert!(text.contains("if %tries% GEQ 120 goto waiting"));
        assert!(text.contains(r#"rmdir /s /q "C:\Users\Nguyễn Văn A' & 100%% !x (2)\AppData\Local\Programs\Harness" 2>nul"#));
        assert!(text.contains(r#"echo Harness left C:\Users\Nguyễn Văn A' ^& 100%% !x ^(2^)\AppData\Local\Programs\Harness because"#));
        assert!(text.contains(r#"for %%A in ("C:\Users\Nguyễn Văn A' & 100%% !x (2)\AppData\Local\Programs\Harness") do set "attr=%%~aA""#));
        assert!(text.ends_with("(goto) 2>nul & del \"%~f0\"\r\n"));
        assert!(
            final_removal_script(
                1,
                Path::new("C:\\a\"b\\Harness"),
                Path::new(r"C:\T\h.log"),
                Path::new(r"C:\Windows")
            )
            .is_err()
        );
    }

    #[test]
    fn a_step_that_cannot_be_written_or_started_leaves_no_script_and_says_what_to_delete() {
        let World { _dir, paths, place } = world();
        // A temp folder inside the install is refused before anything is written.
        let inside = ScriptPlace {
            temp: paths.install.join("tmp"),
            system_root: place.system_root.clone(),
        };
        assert!(
            schedule_final_removal(&paths.install, &inside, &mut Fake::default())
                .unwrap_err()
                .contains("is inside")
        );
        let mut system = Fake {
            fail_script: true,
            ..Fake::default()
        };
        let problems = run(&paths, &place, &mut system).unwrap();
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(
            problems[0].contains("Windows did not start the step")
                && problems[0].contains("yourself"),
            "{problems:?}"
        );
        assert!(fs::read_dir(&place.temp).unwrap().next().is_none());
    }
}
