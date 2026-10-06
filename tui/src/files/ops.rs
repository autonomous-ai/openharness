//! What the file manager does to files, and how it describes them: new files and folders, a
//! rename, copies and moves named as Finder and Nautilus name them ("name copy", "name copy 2"),
//! the Trash as freedesktop.org's spec has it, and a size, a date and a kind for the list view.

use std::fs;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::name_of;

/// Whether [name] can be given to a new thing in [dir] (or to the thing called [was] there): not
/// empty, no `/`, not `.` or `..`, nothing there by that name already.
pub(super) fn check_name(dir: &Path, name: &str, was: Option<&str>) -> Result<(), String> {
    if name.trim().is_empty() { return Err("A name is needed".into()) }
    if name.contains('/') { return Err("A name can't contain /".into()) }
    if name == "." || name == ".." { return Err(format!("'{name}' can't be a name")) }
    if Some(name) != was && dir.join(name).symlink_metadata().is_ok() { return Err(format!("'{name}' is already here")) }
    Ok(())
}

pub(super) fn new_file(dir: &Path, name: &str) -> io::Result<()> {
    fs::OpenOptions::new().write(true).create_new(true).open(dir.join(name)).map(|_| ())
}

pub(super) fn new_folder(dir: &Path, name: &str) -> io::Result<()> { fs::create_dir(dir.join(name)) }

/// [from] called [name] in its folder; where it is now.
pub(super) fn rename(from: &Path, name: &str) -> io::Result<PathBuf> {
    let to = from.with_file_name(name);
    fs::rename(from, &to)?;
    Ok(to)
}

/// [name] in [dir] if nothing has it, else Finder's copy names: `stem copy.ext`, `stem copy 2.ext`…
/// (a folder's whole name is its stem).
pub(super) fn free_name(dir: &Path, name: &str, folder: bool) -> String {
    if dir.join(name).symlink_metadata().is_err() { return name.to_string() }
    let (stem, ext) = match name.rfind('.') { Some(i) if i > 0 && !folder => name.split_at(i), _ => (name, "") };
    (1..).map(|n| if n == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {n}{ext}") })
        .find(|c| dir.join(c).symlink_metadata().is_err()).unwrap_or_default()
}

/// [from] copied to [to], a folder with all it holds (a link as a link).
pub(super) fn copy_all(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() { return std::os::unix::fs::symlink(fs::read_link(from)?, to) }
    if !meta.is_dir() { return fs::copy(from, to).map(|_| ()) }
    fs::create_dir(to)?;
    for e in fs::read_dir(from)? { let e = e?; copy_all(&e.path(), &to.join(e.file_name()))? }
    fs::set_permissions(to, meta.permissions())
}

/// [path] gone for good (a folder with all it holds; a link, not what it points to).
pub(super) fn remove_all(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
}

fn cross_device(e: &io::Error) -> bool { e.raw_os_error() == Some(libc::EXDEV) }

/// [from] moved to [to]: renamed, or across file systems copied and then removed.
pub(super) fn move_to(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
        Err(e) if cross_device(&e) => { copy_all(from, to)?; remove_all(from) }
        r => r,
    }
}

/// Paste: [paths] copied (moved, [cut]) into [dest], each under a free name. The names they have
/// there, and what went wrong with the others.
pub(super) fn paste(paths: &[PathBuf], cut: bool, dest: &Path) -> (Vec<String>, Vec<String>) {
    let (mut done, mut failed) = (Vec::new(), Vec::new());
    for p in paths {
        let name = name_of(p);
        let folder = p.is_dir();
        if folder && dest.starts_with(p) { failed.push(format!("'{name}' can't go inside itself")); continue }
        // (Cut and pasted where it is: it stays.)
        if cut && p.parent() == Some(dest) { done.push(name); continue }
        let to = free_name(dest, &name, folder);
        let r = if cut { move_to(p, &dest.join(&to)) } else { copy_all(p, &dest.join(&to)) };
        match r { Ok(()) => done.push(to), Err(e) => failed.push(format!("'{name}': {e}")) }
    }
    (done, failed)
}

// ── the Trash ────────────────────────────────────────────────────────────────

/// The home Trash: $XDG_DATA_HOME/Trash, else ~/.local/share/Trash.
pub(super) fn trash_home() -> PathBuf {
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute())
        .unwrap_or_else(|| super::home().join(".local/share"));
    data.join("Trash")
}

/// Why something could not go to the Trash: across file systems (it would be copied), or another.
pub(super) enum TrashError { CrossDevice, Other(io::Error) }

impl std::fmt::Display for TrashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { TrashError::CrossDevice => write!(f, "it is on another drive"), TrashError::Other(e) => write!(f, "{e}") }
    }
}

/// [path] (absolute) into the Trash at [trash], as the freedesktop.org Trash spec has it: its
/// `info/NAME.trashinfo` (its Path, URL-escaped, and DeletionDate) made first and exclusively, then
/// it renamed into `files/NAME` — NAME its name, or `stem.2.ext`… when that is taken. Where it is.
pub(super) fn trash(path: &Path, trash: &Path) -> Result<PathBuf, TrashError> {
    let other = TrashError::Other;
    let (files, info) = (trash.join("files"), trash.join("info"));
    let new = !trash.exists();
    fs::create_dir_all(&files).and_then(|_| fs::create_dir_all(&info)).map_err(other)?;
    if new { use std::os::unix::fs::PermissionsExt; let _ = fs::set_permissions(trash, fs::Permissions::from_mode(0o700)); }
    let name = name_of(path);
    let body = format!("[Trash Info]\nPath={}\nDeletionDate={}\n", escape(path), iso_now());
    let (stem, ext) = match name.rfind('.') { Some(i) if i > 0 => name.split_at(i), _ => (name.as_str(), "") };
    for n in 1.. {
        let candidate = if n == 1 { name.clone() } else { format!("{stem}.{n}{ext}") };
        let info_path = info.join(format!("{candidate}.trashinfo"));
        let mut f = match fs::OpenOptions::new().write(true).create_new(true).open(&info_path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(other(e)),
        };
        // (A file there with no info of its own: another name.)
        let to = files.join(&candidate);
        if to.symlink_metadata().is_ok() { drop(f); let _ = fs::remove_file(&info_path); continue }
        if let Err(e) = f.write_all(body.as_bytes()) { let _ = fs::remove_file(&info_path); return Err(other(e)) }
        return match fs::rename(path, &to) {
            Ok(()) => Ok(to),
            Err(e) => { let _ = fs::remove_file(&info_path); Err(if cross_device(&e) { TrashError::CrossDevice } else { other(e) }) }
        };
    }
    unreachable!()
}

/// A path as the spec's Path= key has it: URL-escaped, its slashes kept.
fn escape(path: &Path) -> String {
    let mut out = String::new();
    for &b in path.as_os_str().as_bytes() {
        if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) { out.push(b as char) } else { out.push_str(&format!("%{b:02X}")) }
    }
    out
}

fn secs(t: SystemTime) -> i64 { t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) }

/// Now as DeletionDate has it: local time, YYYY-MM-DDThh:mm:ss.
fn iso_now() -> String {
    let tm = crate::format::local_tm(secs(SystemTime::now()));
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}

// ── what the list view says ──────────────────────────────────────────────────

/// A size as a file manager says it (1000s, as Nautilus and Finder count): 512 B, 4.2 KB, 120 KB.
pub(super) fn human_size(n: u64) -> String {
    if n < 1000 { return format!("{n} B") }
    let mut v = n as f64;
    for unit in ["KB", "MB", "GB", "TB", "PB"] {
        v /= 1000.0;
        if v < 1000.0 || unit == "PB" { return if v < 10.0 { format!("{v:.1} {unit}") } else { format!("{v:.0} {unit}") } }
    }
    unreachable!()
}

/// When a thing was changed, as Finder says it: `Today 10:42` the same day, `Oct 3` the same year,
/// else `2025-11-02`.
pub(super) fn when(t: SystemTime, now: SystemTime) -> String {
    let (a, b) = (crate::format::local_tm(secs(t)), crate::format::local_tm(secs(now)));
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (a.tm_year, a.tm_yday) == (b.tm_year, b.tm_yday) { format!("Today {:02}:{:02}", a.tm_hour, a.tm_min) }
    else if a.tm_year == b.tm_year { format!("{} {}", MONTHS[a.tm_mon.clamp(0, 11) as usize], a.tm_mday) }
    else { format!("{:04}-{:02}-{:02}", a.tm_year + 1900, a.tm_mon + 1, a.tm_mday) }
}

/// What kind of thing a name is, by its extension.
pub(super) fn kind(name: &str, folder: bool) -> String {
    if folder { return "Folder".into() }
    let ext = name.rsplit_once('.').filter(|(s, _)| !s.is_empty()).map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
    let known = match ext.as_str() {
        "rs" => "Rust source", "py" => "Python script", "js" | "mjs" | "cjs" | "jsx" => "JavaScript", "ts" | "tsx" => "TypeScript",
        "go" => "Go source", "c" | "h" => "C source", "cpp" | "cc" | "hpp" => "C++ source", "sh" | "bash" | "zsh" | "fish" => "Shell script",
        "md" => "Markdown", "txt" => "Plain text", "log" => "Log", "json" => "JSON", "toml" => "TOML", "yaml" | "yml" => "YAML",
        "html" | "htm" => "HTML", "css" => "CSS", "pdf" => "PDF document", "csv" => "CSV",
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "bmp" | "ico" => "Image",
        "zip" | "tar" | "gz" | "tgz" | "xz" | "bz2" | "zst" | "7z" | "rar" => "Archive",
        "mp3" | "wav" | "flac" | "ogg" | "m4a" => "Audio", "mp4" | "mkv" | "webm" | "mov" | "avi" => "Video",
        "" => "File",
        _ => return format!("{} file", ext.to_uppercase()),
    };
    known.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("hn-files-ops-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn copies_are_named_as_finder_names_them() {
        let d = scratch();
        fs::write(d.join("a.txt"), "x").unwrap();
        fs::create_dir(d.join("dir.d")).unwrap();
        assert_eq!(free_name(&d, "b.txt", false), "b.txt");
        assert_eq!(free_name(&d, "a.txt", false), "a copy.txt");
        fs::write(d.join("a copy.txt"), "").unwrap();
        assert_eq!(free_name(&d, "a.txt", false), "a copy 2.txt");
        assert_eq!(free_name(&d, "dir.d", true), "dir.d copy");
        // Pasted where they are: copies, the folder with what it holds.
        fs::write(d.join("dir.d/in"), "y").unwrap();
        let (done, failed) = paste(&[d.join("a.txt"), d.join("dir.d")], false, &d);
        assert_eq!((done, failed.len()), (vec!["a copy 2.txt".to_string(), "dir.d copy".to_string()], 0));
        assert_eq!(fs::read_to_string(d.join("dir.d copy/in")).unwrap(), "y");
        // Into itself: refused.
        let (_, failed) = paste(&[d.join("dir.d")], false, &d.join("dir.d"));
        assert_eq!(failed.len(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn cut_and_paste_moves_and_clashes_get_a_copy_name() {
        let d = scratch();
        fs::create_dir(d.join("to")).unwrap();
        fs::write(d.join("x.txt"), "1").unwrap();
        fs::write(d.join("to/x.txt"), "2").unwrap();
        let (done, _) = paste(&[d.join("x.txt")], true, &d.join("to"));
        assert_eq!(done, ["x copy.txt"]);
        assert!(!d.join("x.txt").exists());
        assert_eq!(fs::read_to_string(d.join("to/x copy.txt")).unwrap(), "1");
        assert_eq!(fs::read_to_string(d.join("to/x.txt")).unwrap(), "2", "nothing overwritten");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_trash_gets_the_file_and_its_info() {
        let d = scratch();
        let t = d.join("Trash");
        fs::write(d.join("my file.txt"), "x").unwrap();
        let to = trash(&d.join("my file.txt"), &t).ok().unwrap();
        assert_eq!(to, t.join("files/my file.txt"));
        assert!(!d.join("my file.txt").exists());
        let info = fs::read_to_string(t.join("info/my file.txt.trashinfo")).unwrap();
        assert!(info.starts_with("[Trash Info]\nPath=/"), "{info}");
        assert!(info.contains("/my%20file.txt\n") && info.contains("DeletionDate=2"), "{info}");
        // A second of the same name: its own.
        fs::write(d.join("my file.txt"), "y").unwrap();
        assert_eq!(trash(&d.join("my file.txt"), &t).ok().unwrap(), t.join("files/my file.2.txt"));
        assert!(t.join("info/my file.2.txt.trashinfo").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn names_are_checked() {
        let d = scratch();
        fs::write(d.join("here"), "").unwrap();
        assert!(check_name(&d, "", None).is_err() && check_name(&d, "  ", None).is_err());
        assert!(check_name(&d, "a/b", None).is_err() && check_name(&d, "..", None).is_err());
        assert_eq!(check_name(&d, "here", None), Err("'here' is already here".into()));
        assert!(check_name(&d, "here", Some("here")).is_ok() && check_name(&d, "new", None).is_ok());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn sizes_dates_and_kinds_read_as_a_file_manager_says_them() {
        assert_eq!((human_size(512), human_size(4200), human_size(120_000), human_size(1_300_000)), ("512 B".into(), "4.2 KB".into(), "120 KB".into(), "1.3 MB".into()));
        let now = SystemTime::now();
        assert!(when(now, now).starts_with("Today "));
        let old = when(now - Duration::from_secs(400 * 86400), now);
        assert!(old.len() == 10 && old.as_bytes()[4] == b'-', "{old}");
        assert_eq!((kind("a.rs", false), kind("x", true), kind("a.xyz", false), kind("Makefile", false)), ("Rust source".into(), "Folder".into(), "XYZ file".into(), "File".into()));
    }
}
