//! The real `harness` binary, installed as install.ps1 installs it: `<root>\bin\harness.exe`, beside the pointers
//! it reads. It runs the CLI they name with its arguments untouched, in the caller's working folder and
//! environment, and exits with the CLI's exit code. A broken install says so in one sentence and exits 3.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use harness_pty::command::BROKEN;

const HARNESS: &str = env!("CARGO_BIN_EXE_harness");

/// The fake CLI prints what it was given and where it ran, and exits with the code `exit=<n>` asks for.
const CLI_JS: &str = "const a = process.argv.slice(2)\n\
console.log(JSON.stringify({ args: a, cwd: process.cwd(), env: process.env.HARNESS_COMMAND_TEST ?? null }))\n\
const exit = a.find((x) => x.startsWith('exit='))\n\
process.exitCode = exit ? Number(exit.slice(5)) : 0\n";

/// A Node to run the fake CLI with: $NODE, or the first one on PATH. With none, the test is skipped on a Rust-only
/// machine, and fails when `CI` is set (harness_launch.rs has the same rule).
fn node() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NODE").map(PathBuf::from).filter(|path| path.is_file()) {
        return Some(path);
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|path| path.is_file())
}

/// `<root>\bin\harness.exe`, a copy of the binary under test.
fn command(root: &Path) -> PathBuf {
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let exe = bin.join(Path::new(HARNESS).file_name().unwrap());
    fs::copy(HARNESS, &exe).unwrap();
    exe
}

/// An install under `root` whose Node is a hard link to the real one (or a copy), inside runtime\.
fn install(root: &Path, node: &Path) -> PathBuf {
    let node = fs::canonicalize(node).unwrap();
    let dir = root.join("runtime").join("node-test");
    fs::create_dir_all(&dir).unwrap();
    let linked = dir.join(node.file_name().unwrap());
    if fs::hard_link(&node, &linked).is_err() {
        fs::copy(&node, &linked).unwrap();
    }
    fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", linked.display())).unwrap();
    let cli = root.join("cli").join("1.2.3");
    fs::create_dir_all(&cli).unwrap();
    fs::write(cli.join("cli.js"), CLI_JS).unwrap();
    fs::write(root.join("cli").join("current"), "1.2.3\r\n").unwrap();
    command(root)
}

macro_rules! require_node {
    () => {
        match node() {
            Some(node) => node,
            None => {
                assert!(std::env::var_os("CI").is_none(), "no node on PATH, and CI is set: the runner must have one");
                eprintln!("skipped: no node on PATH");
                return;
            }
        }
    };
}

#[test]
fn passes_every_argument_through_untouched_from_the_callers_folder_and_environment() {
    let node = require_node!();
    let dir = tempfile::tempdir().unwrap();
    let exe = install(dir.path(), &node);
    let work = tempfile::tempdir().unwrap();
    let args = ["send", "a&b", "say \"hi\" & echo pwned > x", "%OS%", "50%", "x^y", "wow!", "two words", "", "a\\\\\"b", "|<>"];
    let out = Command::new(&exe).args(args).current_dir(work.path()).env("HARNESS_COMMAND_TEST", "seen").output().unwrap();
    assert!(out.status.success(), "{out:?}");
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["args"], serde_json::json!(args));
    assert_eq!(fs::canonicalize(report["cwd"].as_str().unwrap()).unwrap(), fs::canonicalize(work.path()).unwrap());
    assert_eq!(report["env"], "seen");
    // Nothing ran but the CLI: no file was created by a `> x`.
    assert_eq!(fs::read_dir(work.path()).unwrap().count(), 0);
}

#[test]
fn exits_with_the_clis_exit_code() {
    let node = require_node!();
    let dir = tempfile::tempdir().unwrap();
    let exe = install(dir.path(), &node);
    for code in [0, 1, 7, 255] {
        let status = Command::new(&exe).arg(format!("exit={code}")).output().unwrap().status;
        assert_eq!(status.code(), Some(code));
    }
}

#[test]
fn a_broken_install_says_so_in_one_sentence_and_exits_3() {
    let dir = tempfile::tempdir().unwrap();
    let exe = command(dir.path());
    let out = Command::new(&exe).arg("version").output().unwrap();
    assert_eq!(out.status.code(), Some(3));
    assert_eq!(String::from_utf8_lossy(&out.stderr).trim_end(), BROKEN);
    assert!(out.stdout.is_empty());
}

#[test]
fn a_node_that_cannot_start_exits_4() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // Both pointers resolve, but the "Node" is an empty file: not executable on Unix, not a program on Windows.
    let runtime = root.join("runtime").join("node-test");
    fs::create_dir_all(&runtime).unwrap();
    let fake = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
    fs::write(&fake, b"").unwrap();
    fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", fake.display())).unwrap();
    fs::create_dir_all(root.join("cli").join("1.2.3")).unwrap();
    fs::write(root.join("cli").join("1.2.3").join("cli.js"), b"").unwrap();
    fs::write(root.join("cli").join("current"), "1.2.3\r\n").unwrap();
    let out = Command::new(command(root)).arg("version").output().unwrap();
    assert_eq!(out.status.code(), Some(4));
    assert!(String::from_utf8_lossy(&out.stderr).contains("could not start its Node runtime"), "{out:?}");
}
