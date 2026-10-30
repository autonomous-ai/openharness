//! `<home>/run/pty-host-<instance>.json`: how a client finds and proves itself to the host.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Discovery {
    pub protocol: u32,
    pub instance: String,
    pub endpoint: String,
    pub pid: u32,
    pub version: String,
    pub token: String,
}

pub fn file_path(run_dir: &Path) -> PathBuf {
    crate::instance::run_file(run_dir, &crate::instance::current(), "json")
}

/// Write the discovery file atomically: a reader sees the old file or the whole new one, never a
/// part. The owner's alone from its creation (the token in it is the host's password): mode 0600
/// on Unix, on Windows the pipe's DACL `D:P(A;;GA;;;<user SID>)` (`files::replace_private`).
pub fn write(run_dir: &Path, discovery: &Discovery) -> io::Result<PathBuf> {
    let path = file_path(run_dir);
    let mut tmp = path.clone().into_os_string();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let body = serde_json::to_vec(discovery).map_err(io::Error::other)?;
    crate::files::replace_private(&tmp, &path, &body)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::PROTOCOL;

    fn sample(token: &str) -> Discovery {
        Discovery {
            protocol: PROTOCOL,
            instance: crate::instance::current(),
            endpoint: "/x.sock".into(),
            pid: 7,
            version: "0.1.0".into(),
            token: token.into(),
        }
    }

    #[test]
    fn writes_and_replaces_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), &sample("a")).unwrap();
        assert_eq!(path, crate::instance::run_file(dir.path(), &crate::instance::current(), "json"));
        write(dir.path(), &sample("b")).unwrap();
        let read: Discovery = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(read, sample("b"));
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(v["protocol"], PROTOCOL);
        assert_eq!(v["instance"], crate::instance::current());
        // No temporary file is left behind.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn the_file_is_the_users_alone() {
        use crate::transport::windows::file_dacl;
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), &sample("a")).unwrap();
        // Protected (no entry inherited from the directory), one entry: the user's. Compared by
        // SID: SDDL writes some users as an alias (the built-in Administrator as `LA`).
        file_dacl(&path).assert_users_alone(false);
        // Replacing the file keeps it so.
        write(dir.path(), &sample("b")).unwrap();
        file_dacl(&path).assert_users_alone(false);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), &sample("a")).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
