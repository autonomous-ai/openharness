//! `current` and `previous`, the install's two pointer files. Each holds one line naming a version folder in `app\`,
//! by B's rules (`launcher::single_segment`, `launcher::read_pointer`): UTF-8 with no BOM written (one read is
//! dropped, as Notepad writes one), CRLF or LF, and one path segment. A version folder name is also never a name
//! Windows keeps for a device (`CON`, `NUL`, `COM1`…, with or without an extension) and never ends in a dot or a
//! space, which Windows drops: `1.2.3.` would open `1.2.3`.
//!
//! A write goes to `<name>.tmp`, is flushed, then renamed over the pointer, so a reader sees the old value or the
//! new one, never half of one.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use crate::launcher::{read_pointer, single_segment};

pub const CURRENT: &str = "current";
pub const PREVIOUS: &str = "previous";

fn reserved(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let numbered = |prefix: &str| {
        // Win32 also reserves the three ISO-8859-1 superscript digits in COM/LPT
        // names. Match the whole suffix so COM10 and ordinary Unicode stay valid.
        matches!(
            stem.strip_prefix(prefix),
            Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        )
    };
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || numbered("COM")
        || numbered("LPT")
}

/// Whether [value] may name a version folder.
pub fn valid(value: &str) -> bool {
    single_segment(value)
        && !reserved(value)
        && !value.ends_with(['.', ' '])
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
}

/// The version folder [file] names.
pub fn read(file: &Path) -> Result<String, String> {
    let value = read_pointer(file)?;
    if !valid(&value) {
        return Err(format!(
            "{} names {value:?}, which is not one version folder",
            file.display()
        ));
    }
    Ok(value)
}

/// Point [file] at [value], through a flushed temporary file and a rename.
pub fn write(file: &Path, value: &str) -> io::Result<()> {
    if !valid(value) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{value:?} is not one version folder"),
        ));
    }
    let tmp = file.with_extension("tmp");
    let written = (|| {
        let _ = fs::remove_file(&tmp);
        let mut out = fs::File::create(&tmp)?;
        out.write_all(format!("{value}\r\n").as_bytes())?;
        out.sync_all()?;
        drop(out);
        crate::files::rename(&tmp, file)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

/// Remove [file]; a pointer that is not there is already removed.
pub fn remove(file: &Path) -> io::Result<()> {
    match fs::remove_file(file) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        done => done,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_one_line_with_crlf_and_reads_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(CURRENT);
        write(&file, "1.2.3").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"1.2.3\r\n");
        assert_eq!(read(&file).unwrap(), "1.2.3");
        // Overwritten in place, and no temporary file is left.
        write(&file, "1.2.4-dev.win1").unwrap();
        assert_eq!(read(&file).unwrap(), "1.2.4-dev.win1");
        assert!(!dir.path().join("current.tmp").exists());
    }

    #[test]
    fn reads_lf_and_a_byte_order_mark_as_b_does() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(PREVIOUS);
        fs::write(&file, "\u{feff}1.0.0\n").unwrap();
        assert_eq!(read(&file).unwrap(), "1.0.0");
    }

    #[test]
    fn refuses_anything_but_one_version_folder() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(CURRENT);
        for bad in [
            "..", "a/b", r"a\b", "C:x", "1.2.3.", "CON", "nul.txt", "com1", "LPT9.1", "a*b", "a\"b",
        ] {
            assert!(!valid(bad), "{bad:?}");
            fs::write(&file, format!("{bad}\r\n")).unwrap();
            assert!(read(&file).is_err(), "{bad:?}");
            assert_eq!(
                write(&file, bad).unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "{bad:?}"
            );
        }
        // A trailing space never reaches a read (the line is trimmed), but a write refuses it.
        assert!(!valid("1.2.3 "));
        for good in ["1.2.3", "0.3.120-dev.abc123", "COM10", "console"] {
            assert!(valid(good), "{good:?}");
        }
        assert!(
            read(&dir.path().join("missing"))
                .unwrap_err()
                .contains("cannot read")
        );
    }

    #[test]
    fn removing_a_missing_pointer_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        remove(&dir.path().join(PREVIOUS)).unwrap();
        write(&dir.path().join(PREVIOUS), "1.0.0").unwrap();
        remove(&dir.path().join(PREVIOUS)).unwrap();
        assert!(!dir.path().join(PREVIOUS).exists());
    }

    #[test]
    fn superscript_device_names_are_rejected_without_replacing_a_valid_pointer() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(CURRENT);
        // These are pointer CONTENTS, never filesystem paths to COM/LPT devices.
        for bad in [
            "COM¹",
            "COM²",
            "COM³",
            "LPT¹",
            "LPT²",
            "LPT³",
            "com¹.txt",
            "cOm².tar.gz",
            "CoM³.log",
            "lpt¹.txt",
            "LpT².tar.gz",
            "lPt³.log",
        ] {
            assert!(!valid(bad), "accepted device name {bad:?}");
            fs::write(&file, b"1.2.3\r\n").unwrap();
            assert_eq!(
                write(&file, bad).unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "{bad:?}"
            );
            assert_eq!(
                fs::read(&file).unwrap(),
                b"1.2.3\r\n",
                "invalid write replaced pointer: {bad:?}"
            );
            assert!(!file.with_extension("tmp").exists());
            fs::write(&file, format!("{bad}\r\n")).unwrap();
            assert!(read(&file).is_err(), "read accepted device name {bad:?}");
        }
    }

    #[test]
    fn ordinary_unicode_versions_and_longer_device_prefixes_still_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(CURRENT);
        for good in [
            "COM10",
            "LPT10",
            "Nguyễn-1.2.3",
            "1.2.3-日²",
            "COM⁴",
            "LPT⁴",
            "COM١",
            "COM¹0",
            "LPT¹0",
        ] {
            assert!(valid(good), "rejected ordinary name {good:?}");
            write(&file, good).unwrap();
            assert_eq!(fs::read(&file).unwrap(), format!("{good}\r\n").as_bytes());
            assert_eq!(read(&file).unwrap(), good);
        }
    }
}
