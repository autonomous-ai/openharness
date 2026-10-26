//! The host's instance name, one per (protocol, version): `p<protocol>-<tag>`.
//!
//! Two builds of one protocol must be able to run side by side in one home, so the build is part of
//! the name that keys the discovery file, lock, pane-id counter, socket, pipe suffix, log and
//! `HARNESS_PANE`. Pre-G hosts used `p<protocol>`; this build never does.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::cli::VERSION;
use crate::protocol::PROTOCOL;

/// The longest socket path in bytes. `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on
/// Linux, so 100 leaves room for the terminating NUL on both.
const MAX_SOCKET_BYTES: usize = 100;

fn hex12(input: &str) -> String {
    Sha256::digest(input.as_bytes())[..6]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `p<protocol>-<version>` when the version is safe to put in a file name (`[0-9A-Za-z.-]{1,32}`),
/// otherwise `p<protocol>-h<12 hex of SHA-256(version)>`: a hash keeps odd or long versions
/// (build metadata, spaces) out of paths, and still gives each its own instance.
pub fn instance_name(protocol: u32, version: &str) -> String {
    let plain = (1..=32).contains(&version.len())
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    if plain {
        format!("p{protocol}-{version}")
    } else {
        format!("p{protocol}-h{}", hex12(version))
    }
}

/// This build's instance.
pub fn current() -> String {
    instance_name(PROTOCOL, VERSION)
}

/// `<run_dir>/pty-host-<instance>.<ext>`.
pub fn run_file(run_dir: &Path, instance: &str, ext: &str) -> PathBuf {
    run_dir.join(format!("pty-host-{instance}.{ext}"))
}

/// The Unix socket path. A long home would push the plain name past the OS limit on `sun_path`
/// (the bind then fails), so past 100 bytes the name is a hash of the instance instead.
pub fn socket_path(run_dir: &Path, instance: &str) -> PathBuf {
    let plain = run_file(run_dir, instance, "sock");
    if plain.as_os_str().len() <= MAX_SOCKET_BYTES {
        return plain;
    }
    run_dir.join(format!("pty-host-s{}.sock", hex12(instance)))
}

/// `<home>/logs/pty-host-<instance>.log`.
pub fn log_path(home: &Path, instance: &str) -> PathBuf {
    home.join("logs").join(format!("pty-host-{instance}.log"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_shared_vectors() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/instances.json"
        ))
        .unwrap();
        let vectors: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
        assert!(vectors.len() >= 6);
        for v in vectors {
            assert_eq!(
                instance_name(v["protocol"].as_u64().unwrap() as u32, v["version"].as_str().unwrap()),
                v["instance"].as_str().unwrap(),
                "{v}"
            );
        }
    }

    #[test]
    fn current_is_this_builds_instance() {
        assert_eq!(current(), instance_name(PROTOCOL, VERSION));
    }

    #[test]
    fn a_long_home_uses_the_hashed_socket_name() {
        let instance = "p2-0.4.20";
        let short = Path::new("/h/run");
        assert_eq!(
            socket_path(short, instance),
            Path::new("/h/run/pty-host-p2-0.4.20.sock")
        );
        let long = PathBuf::from(format!("/{}", "a".repeat(89)));
        assert_eq!(long.as_os_str().len(), 90);
        let got = socket_path(&long, instance);
        let name = got.file_name().unwrap().to_str().unwrap();
        assert_eq!(got.parent().unwrap(), long);
        let hex = name
            .strip_prefix("pty-host-s")
            .and_then(|r| r.strip_suffix(".sock"))
            .unwrap();
        assert_eq!(hex.len(), 12);
        assert!(hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(hex, hex12(instance));
    }

    #[test]
    fn two_builds_have_different_files() {
        let run = Path::new("/h/run");
        let a = run_file(run, &instance_name(2, "0.4.20"), "json");
        let b = run_file(run, &instance_name(2, "0.4.21"), "json");
        assert_ne!(a, b);
        assert_eq!(a, Path::new("/h/run/pty-host-p2-0.4.20.json"));
    }
}
