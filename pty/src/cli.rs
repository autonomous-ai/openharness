//! Command line: `serve`, `version`, `ps --json`.
//!
//! The protocol is fixed at build time (`protocol::PROTOCOL`); `version` prints it.

use std::path::{Path, PathBuf};

use crate::protocol::{FEATURES, PROTOCOL};

/// How many random pipe names a Windows host tries before it gives up.
#[cfg(windows)]
const PIPE_NAME_TRIES: usize = 3;

/// tmux's default `history-limit`.
const DEFAULT_HISTORY_LIMIT: usize = 2000;

const USAGE: &str =
    "usage: harness-pty serve --home <dir> [--history-limit N] | version | ps --json";

/// The version this host reports. A release stamps it with the CLI's version (`HARNESS_PTY_VERSION`, set by
/// windows.yml's release mode) instead of editing Cargo.toml, which would put the lockfile out of date for
/// `--locked`.
pub const VERSION: &str = release_version(option_env!("HARNESS_PTY_VERSION"));

pub const fn release_version(given: Option<&'static str>) -> &'static str {
    match given {
        Some(version) if !version.is_empty() => version,
        _ => env!("CARGO_PKG_VERSION"),
    }
}

pub fn version_line() -> String {
    serde_json::json!({"version": VERSION, "protocol": PROTOCOL, "features": FEATURES}).to_string()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Serve {
        home: PathBuf,
        history_limit: usize,
        /// Whether a Windows host started in a job may start a copy of itself outside it.
        /// `--no-reexec` (that copy's own flag) turns it off.
        reexec: bool,
    },
    Version,
    Ps,
}

pub fn parse(args: &[String]) -> Result<Command, String> {
    let mut args = args.iter().map(String::as_str);
    match args.next() {
        Some("version") => Ok(Command::Version),
        Some("ps") => match args.next() {
            Some("--json") => Ok(Command::Ps),
            _ => Err("ps needs --json".into()),
        },
        Some("serve") => {
            let mut home = None;
            let mut history_limit = DEFAULT_HISTORY_LIMIT;
            let mut reexec = true;
            while let Some(arg) = args.next() {
                match arg {
                    "--no-reexec" => reexec = false,
                    "--home" => {
                        home = Some(PathBuf::from(
                            args.next().ok_or("--home needs a directory")?,
                        ))
                    }
                    "--history-limit" => {
                        history_limit = args
                            .next()
                            .and_then(|n| n.parse().ok())
                            .ok_or("--history-limit needs a number")?
                    }
                    other => return Err(format!("unknown argument {other}")),
                }
            }
            Ok(Command::Serve {
                home: home.ok_or("serve needs --home")?,
                history_limit,
                reexec,
            })
        }
        _ => Err(USAGE.into()),
    }
}

pub fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse(&args) {
        Ok(Command::Version) => println!("{}", version_line()),
        Ok(Command::Ps) => ps(),
        Ok(Command::Serve {
            home,
            history_limit,
            reexec,
        }) => {
            // Before anything else the host does: the daemon starts it with no stdio, so the log
            // file is where its diagnostics go (stderr still has them for a host run by hand).
            crate::logfile::install(&home);
            log::info!(
                "harness-pty {} (protocol {PROTOCOL}) serving {} (pid {})",
                VERSION,
                home.display(),
                std::process::id()
            );
            if let Err(err) = serve(&home, history_limit, reexec) {
                log::error!("harness-pty: {err}");
                log::logger().flush();
                std::process::exit(1);
            }
        }
        Err(err) => {
            eprintln!("{err}\n{USAGE}");
            std::process::exit(2);
        }
    }
}

/// `ps --json`: `{"rows":[…]}` on Windows; elsewhere `{"unsupported":true}`, exit 3 (the daemon
/// reads `ps` there).
fn ps() {
    #[cfg(windows)]
    match crate::ps::snapshot() {
        Ok(rows) => println!("{}", serde_json::json!({ "rows": rows })),
        Err(err) => {
            eprintln!("harness-pty: process table: {err}");
            std::process::exit(1);
        }
    }
    #[cfg(not(windows))]
    {
        println!("{{\"unsupported\":true}}");
        std::process::exit(3);
    }
}

/// Create `<home>/run` if it is missing, the owner's alone: mode 0700 on Unix; on Windows a
/// protected DACL that lets only the user in (and that what is created inside inherits), set on
/// a run directory that already exists as well, before anything is written in it.
fn run_dir(home: &Path) -> std::io::Result<PathBuf> {
    let run = home.join("run");
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&run)?;
    }
    #[cfg(windows)]
    {
        std::fs::create_dir_all(home)?;
        crate::transport::windows::secure_dir(&run)?;
    }
    Ok(run)
}

/// Bind the endpoint, publish the discovery file, and serve until killed. Returns at once, with
/// success, when another host already serves this home (or, on Windows, when a copy of this host
/// started outside the job this one is in serves it: `breakaway`).
pub fn serve(home: &Path, history_limit: usize, reexec: bool) -> std::io::Result<()> {
    #[cfg(windows)]
    if reexec && leave_job(home, history_limit) {
        log::info!("a copy of this host started outside its job serves; exiting");
        return Ok(());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

        // The daemon starts this host in a new process group. Windows then makes its
        // Ctrl+C-ignore setting inheritable, so ConPTY children keep running after ETX.
        // Clear it in the serving host before any pseudoconsole or pane is created.
        if unsafe { SetConsoleCtrlHandler(None, 0) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    #[cfg(not(windows))]
    let _ = reexec;
    let run = run_dir(home)?;
    // Before the endpoint and the pane counter: one host per home.
    let Some(_lock) = crate::host_lock::take(&run)? else {
        log::info!("another host serves this home; exiting");
        return Ok(());
    };
    // This host is the home's: it alone rotates the log (logfile.rs).
    crate::logfile::own_rotation();
    #[cfg(unix)]
    let bound = {
        use crate::transport::unix;
        // Owner-only from its creation, so no other user can connect before the chmod. The umask
        // is the process's: set while this is the only thread, restored before panes are spawned.
        let old = unsafe { libc::umask(0o177) };
        let bound = unix::bind(&unix::socket_path(&run));
        unsafe { libc::umask(old) };
        bound
    };
    // A new random name each start (transport/windows.rs): a name another process holds is one it
    // happened on, so the next is tried; the home's lock, not the name, keeps one host per home.
    #[cfg(windows)]
    let bound = {
        use crate::transport::{Bound, windows};
        let mut bound = windows::bind(&windows::pipe_name_for(home)?);
        for _ in 1..PIPE_NAME_TRIES {
            if !matches!(bound, Ok(Bound::Taken)) {
                break;
            }
            log::warn!("the pipe name drawn is taken; drawing another");
            bound = windows::bind(&windows::pipe_name_for(home)?);
        }
        bound
    };
    match bound? {
        crate::transport::Bound::Listening(listener) => {
            publish_and_serve(listener, &run, history_limit)
        }
        // This host holds the home's lock, so no other host of this home has the endpoint:
        // another process squats on the name (on Windows, on every random name drawn). The
        // discovery file (a dead host's) may point at it; set it aside so no client follows it.
        crate::transport::Bound::Taken => {
            set_discovery_aside(&run);
            Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "pipe name held by another process",
            ))
        }
    }
}

/// Move this build's `pty-host-<instance>.json` to `.json.stale`, when there is one.
fn set_discovery_aside(run: &Path) {
    let file = crate::discovery::file_path(run);
    let mut aside = file.clone().into_os_string();
    aside.push(".stale");
    match crate::files::rename(&file, Path::new(&aside)) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
            log::error!("cannot set the old discovery file aside: {err}")
        }
        _ => {}
    }
}

/// Windows: start a copy of this host outside the job it is in, if it is in one. True when the
/// copy serves and this process should exit.
#[cfg(windows)]
fn leave_job(home: &Path, history_limit: usize) -> bool {
    use crate::breakaway::{Left, in_job, spawn_copy};
    let in_job = in_job().unwrap_or_else(|err| {
        log::warn!("cannot tell whether the host is in a job: {err}");
        false
    });
    let args: Vec<std::ffi::OsString> = vec![
        "serve".into(),
        "--home".into(),
        home.as_os_str().to_owned(),
        "--history-limit".into(),
        history_limit.to_string().into(),
        "--no-reexec".into(),
    ];
    let left = crate::breakaway::leave_job(
        in_job,
        |flags| spawn_copy(&args, flags),
        |warning| log::warn!("{warning}"),
    );
    matches!(left, Left::BrokeAway | Left::Detached)
}

fn publish_and_serve<L: crate::transport::Listener>(
    listener: L,
    run: &Path,
    history_limit: usize,
) -> std::io::Result<()> {
    let info = crate::server::HostInfo {
        token: uuid::Uuid::new_v4().to_string(),
        instance: crate::instance::current(),
        version: VERSION.to_owned(),
        pid: std::process::id(),
    };
    // Before the host is published: a host that cannot keep its pane counter must not serve.
    let (panes, events) =
        crate::panes::Panes::persistent(history_limit, info.instance.clone(), run)?;
    crate::discovery::write(
        run,
        &crate::discovery::Discovery {
            protocol: PROTOCOL,
            instance: info.instance.clone(),
            endpoint: listener.endpoint(),
            pid: info.pid,
            version: info.version.clone(),
            token: info.token.clone(),
        },
    )?;
    log::info!("listening as {} on {}", info.instance, listener.endpoint());
    let published = (crate::discovery::file_path(run), listener.endpoint());
    // Once: the connection that was granted it and its reply's deadline (server.rs) may both call it;
    // the second waits in `call_once` while the first exits.
    let once = std::sync::Once::new();
    let on_shutdown = std::sync::Arc::new(move || {
        once.call_once(|| {
            let (discovery, endpoint) = &published;
            // The discovery file first: a client must not find a host that is about to be gone.
            // This host holds the home's lock, so the file is its own. The pane counter and the
            // lock stay: pane ids never repeat for the home and protocol.
            let _ = std::fs::remove_file(discovery);
            #[cfg(unix)]
            let _ = std::fs::remove_file(endpoint);
            #[cfg(not(unix))]
            let _ = endpoint;
            std::process::exit(0);
        })
    });
    crate::server::run(listener, panes, events, info, on_shutdown)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn version_line_is_json_with_protocol() {
        let v: serde_json::Value = serde_json::from_str(&version_line()).unwrap();
        assert_eq!(v["version"], VERSION);
        assert_eq!(v["protocol"], PROTOCOL);
        assert_eq!(v["features"], serde_json::json!(["seed"]));
    }

    #[test]
    fn a_release_build_reports_the_cli_release_version() {
        // The release builds the host with the CLI's version, so its folder runtime\pty\<version>\ and the
        // `version` in its discovery file are the version current-pty names. A plain build keeps the crate's.
        assert_eq!(release_version(Some("0.3.120")), "0.3.120");
        assert_eq!(release_version(None), env!("CARGO_PKG_VERSION"));
        // An unset workflow input arrives as an empty string, never as a version.
        assert_eq!(release_version(Some("")), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn parses_commands() {
        assert_eq!(parse(&args(&["version"])), Ok(Command::Version));
        assert_eq!(parse(&args(&["ps", "--json"])), Ok(Command::Ps));
        assert_eq!(
            parse(&args(&["serve", "--home", "/h"])),
            Ok(Command::Serve {
                home: "/h".into(),
                history_limit: DEFAULT_HISTORY_LIMIT,
                reexec: true,
            })
        );
        assert_eq!(
            parse(&args(&["serve", "--history-limit", "50", "--home", "/h"])),
            Ok(Command::Serve {
                home: "/h".into(),
                history_limit: 50,
                reexec: true,
            })
        );
        assert_eq!(
            parse(&args(&["serve", "--home", "/h", "--no-reexec"])),
            Ok(Command::Serve {
                home: "/h".into(),
                history_limit: DEFAULT_HISTORY_LIMIT,
                reexec: false,
            })
        );
        assert!(parse(&args(&["serve"])).is_err());
        assert!(parse(&args(&["serve", "--home"])).is_err());
        assert!(parse(&args(&["serve", "--home", "/h", "--x"])).is_err());
        assert!(parse(&args(&["ps"])).is_err());
        assert!(parse(&args(&[])).is_err());
    }

    #[test]
    fn run_dir_is_created() {
        let home = tempfile::tempdir().unwrap();
        let run = run_dir(&home.path().join("nested")).unwrap();
        assert!(run.is_dir());
        #[cfg(windows)]
        {
            use crate::transport::windows::file_dacl;
            // Only the user, inherited by what is made inside.
            file_dacl(&run).assert_users_alone(true);
            // A run directory that exists already is made the user's alone as well.
            let open = home.path().join("open");
            std::fs::create_dir_all(open.join("run")).unwrap();
            assert!(!file_dacl(&open.join("run")).protected);
            run_dir(&open).unwrap();
            file_dacl(&open.join("run")).assert_users_alone(true);
            // A file made in it has nobody else's entries either.
            std::fs::write(open.join("run").join("x"), "x").unwrap();
            file_dacl(&open.join("run").join("x")).assert_only_user_entries();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&run).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
}
