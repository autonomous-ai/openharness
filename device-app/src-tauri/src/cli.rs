//! Find the `harness` CLI and run it: deadlines, NDJSON lines.

use crate::types::{Log, Output};
use std::collections::VecDeque;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, Weak, mpsc};
use std::thread;
use std::time::{Duration, Instant};

/// A line of output longer than this is dropped: what a CLI prints is outside text.
pub const LINE_MAX: usize = 64 * 1024;
/// `auth status`, `device claude status`.
pub const STATUS_DEADLINE: Duration = Duration::from_secs(10);
/// `device claude enable` and `disable`.
pub const CHANGE_DEADLINE: Duration = Duration::from_secs(60);
/// `start --if-down`.
pub const START_DEADLINE: Duration = Duration::from_secs(90);
/// Each install script.
pub const INSTALL_DEADLINE: Duration = Duration::from_secs(600);
/// `login` until its `result`.
pub const LOGIN_DEADLINE: Duration = Duration::from_secs(600);
/// `login` after its `result`, while it restarts the daemon.
pub const LOGIN_EXIT_DEADLINE: Duration = Duration::from_secs(60);

/// What a run keeps of each stream: its end, where a failure says why.
const TAIL_MAX: usize = 256 * 1024;
/// Lines a child has printed and nobody has read yet; past this the child waits on its pipe.
const LINES_QUEUED: usize = 16;
/// How long a child's end waits for its stderr to end too, so the log has its last line. The stream ends with the child
/// unless something it left behind holds it open.
const STDERR_GRACE: Duration = Duration::from_secs(1);

/// How to run the CLI: `program`, then `prefix`, then the arguments, with `env` on top of the app's own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invocation {
    pub program: PathBuf,
    pub prefix: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    /// Where it was found, so a `HarnessCli` can look there again.
    from: Lookup,
}

/// What `find_cli` looks with.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Lookup {
    home: PathBuf,
    path_var: Option<OsString>,
    over: Option<PathBuf>,
}

/// The desktop app's order: `over`, then the managed runtime with its `cli.js`, then `~/.local/bin/harness`, then a
/// `harness` in one of PATH's absolute folders. A Finder-launched app has launchd's bare PATH, hence the first two.
pub fn find_cli(home: &Path, path_var: Option<&OsStr>, over: Option<&Path>) -> Option<Invocation> {
    let (program, prefix) = match over {
        Some(over) => (over.to_path_buf(), Vec::new()),
        None => installed(home, path_var)?,
    };
    let locale =
        ["LC_ALL", "LC_CTYPE", "LANG"].into_iter().find_map(|name| env::var_os(name).filter(|value| !value.is_empty()));
    let from = Lookup {
        home: home.to_path_buf(),
        path_var: path_var.map(OsStr::to_os_string),
        over: over.map(Path::to_path_buf),
    };
    Some(Invocation { program, prefix, env: child_env(home, path_var, locale.as_deref()), from })
}

fn installed(home: &Path, path_var: Option<&OsStr>) -> Option<(PathBuf, Vec<OsString>)> {
    let harness = home.join(".harness");
    let cli_js = harness.join("cli").join("cli.js");
    if let Some(node) = managed_node(&harness.join("runtime")).filter(|_| cli_js.is_file()) {
        return Some((node, vec![cli_js.into_os_string()]));
    }
    let launcher = home.join(".local").join("bin").join("harness");
    if launcher.is_file() {
        return Some((launcher, Vec::new()));
    }
    let on_path = env::split_paths(path_var?)
        .filter(|folder| folder.is_absolute())
        .map(|folder| folder.join("harness"))
        .find(|file| file.is_file())?;
    Some((on_path, Vec::new()))
}

/// The node `current-node` names, when it is there and lies under the runtime folder.
fn managed_node(runtime: &Path) -> Option<PathBuf> {
    let node = PathBuf::from(fs::read_to_string(runtime.join("current-node")).ok()?.trim());
    let inside = node.starts_with(runtime) && !node.components().any(|part| part == Component::ParentDir);
    (inside && node.is_file()).then_some(node)
}

/// The fake CLI's path, for tests: a release build never reads it.
pub fn cli_override(debug: bool, var: Option<OsString>) -> Option<PathBuf> {
    var.filter(|var| debug && !var.is_empty()).map(PathBuf::from)
}

/// What the child's environment changes: `harness` on its PATH names the launcher, and its output is UTF-8.
pub fn child_env(home: &Path, path_var: Option<&OsStr>, locale: Option<&OsStr>) -> Vec<(OsString, OsString)> {
    let mut path = home.join(".local").join("bin").into_os_string();
    if let Some(rest) = path_var.filter(|rest| !rest.is_empty()) {
        path.push(":");
        path.push(rest);
    }
    let mut env = vec![("PATH".into(), path)];
    let utf8 = locale.is_some_and(|locale| {
        let locale = locale.to_string_lossy().to_lowercase();
        locale.contains("utf-8") || locale.contains("utf8")
    });
    if !utf8 {
        env.push(("LC_ALL".into(), "C.UTF-8".into()));
    }
    env
}

/// Runs `command` in its own process group to its end, stdin empty. Past `deadline` the whole group is killed and
/// `timed_out` is true. Each stream keeps its last 256 KiB.
pub fn run(mut command: Command, deadline: Duration) -> io::Result<Output> {
    let end = Instant::now() + deadline;
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let mut child = command.spawn()?;
    let pid = child.id() as libc::pid_t;
    let (done, finished) = mpsc::channel();
    let stdout = tail(child.stdout.take().expect("stdout is piped"), done.clone());
    let stderr = tail(child.stderr.take().expect("stderr is piped"), done.clone());
    thread::spawn(move || {
        exited(pid);
        let _ = done.send(());
    });
    // Its exit and both streams' ends. The child is reaped only after this, so its group is still its own to kill.
    let timed_out = (0..3).any(|_| finished.recv_timeout(end.saturating_duration_since(Instant::now())).is_err());
    if timed_out {
        kill_group(pid);
    }
    let code = child.wait()?.code();
    Ok(Output { code, timed_out, stdout: text(&stdout), stderr: text(&stderr) })
}

/// The `harness` CLI, behind a trait so every rule is tested against a fake.
pub trait Cli: Send + Sync {
    fn run(&self, args: &[&str], deadline: Duration) -> io::Result<Output>;
    fn spawn(&self, args: &[&str]) -> io::Result<Child>;
}

/// The CLI `find_cli` found, looked for again the same way at each run and spawn: the CLI's updater repoints
/// `current-node` while the app runs, and the Node it named goes. Each run and each child writes one log line when it
/// ends.
pub struct HarnessCli {
    from: Lookup,
    log: Arc<dyn Log>,
}

impl HarnessCli {
    pub fn new(invocation: Invocation, log: Arc<dyn Log>) -> Self {
        HarnessCli { from: invocation.from, log }
    }

    /// NotFound when the CLI has gone since, as when it was never there.
    fn command(&self, args: &[&str]) -> io::Result<Command> {
        let Lookup { home, path_var, over } = &self.from;
        let invocation = find_cli(home, path_var.as_deref(), over.as_deref()).ok_or(io::ErrorKind::NotFound)?;
        let mut command = Command::new(&invocation.program);
        command.args(&invocation.prefix).args(args).envs(invocation.env);
        Ok(command)
    }
}

impl Cli for HarnessCli {
    fn run(&self, args: &[&str], deadline: Duration) -> io::Result<Output> {
        let output = run(self.command(args)?, deadline)?;
        let name = name(args);
        self.log.line(&if output.timed_out {
            format!("{name}: timed out after {} s", deadline.as_secs_f64())
        } else {
            ended(&name, output.code, &output.stderr)
        });
        Ok(output)
    }

    fn spawn(&self, args: &[&str]) -> io::Result<Child> {
        Child::start(self.command(args)?, name(args), self.log.clone())
    }
}

/// A running CLI in its own process group: its stdin is held open until closed or dropped, its stdout comes a line
/// at a time.
pub struct Child {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    lines: mpsc::Receiver<String>,
    exit: mpsc::Receiver<Option<i32>>,
    code: Option<Option<i32>>,
    killer: Killer,
}

/// `line` or `exit` waited and nothing came.
#[derive(Debug, PartialEq, Eq)]
pub struct Timeout;

impl Child {
    fn start(mut command: Command, name: String, log: Arc<dyn Log>) -> io::Result<Child> {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
        let mut child = command.spawn()?;
        let pid = child.id() as libc::pid_t;
        // Taken out, or `wait` below would close it.
        let stdin = Arc::new(Mutex::new(child.stdin.take()));
        let stdout = child.stdout.take().expect("stdout is piped");
        let (send, lines) = mpsc::sync_channel(LINES_QUEUED);
        thread::spawn(move || read_lines(stdout, |line| send.send(line).is_ok()));
        let (stderr_done, stderr_ended) = mpsc::channel();
        let stderr = tail(child.stderr.take().expect("stderr is piped"), stderr_done);
        let killer = Killer(Arc::new(Unreaped { pid: Mutex::new(Some(pid)), reaped: Condvar::new() }));
        let unreaped = killer.0.clone();
        let (send_exit, exit) = mpsc::channel();
        thread::spawn(move || {
            exited(pid);
            let _ = stderr_ended.recv_timeout(STDERR_GRACE);
            let status = {
                let mut pid = unreaped.pid.lock().unwrap();
                *pid = None;
                child.wait()
            };
            unreaped.reaped.notify_all();
            let code = status.ok().and_then(|status| status.code());
            log.line(&ended(&name, code, &text(&stderr)));
            let _ = send_exit.send(code);
        });
        Ok(Child { stdin, lines, exit, code: None, killer })
    }

    /// The next line of stdout; `Ok(None)` once it has ended.
    pub fn line(&mut self, wait: Duration) -> Result<Option<String>, Timeout> {
        match self.lines.recv_timeout(wait) {
            Ok(line) => Ok(Some(line)),
            Err(mpsc::RecvTimeoutError::Disconnected) => Ok(None),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(Timeout),
        }
    }

    pub fn close_stdin(&mut self) {
        self.stdin.lock().unwrap().take();
    }

    pub fn stdin_closer(&self) -> StdinCloser {
        StdinCloser(Arc::downgrade(&self.stdin))
    }

    /// The exit code once it has exited; `Ok(None)`: it was ended by a signal.
    pub fn exit(&mut self, wait: Duration) -> Result<Option<i32>, Timeout> {
        if self.code.is_none() {
            self.code = Some(self.exit.recv_timeout(wait).map_err(|_| Timeout)?);
        }
        Ok(self.code.flatten())
    }

    pub fn killer(&self) -> Killer {
        self.killer.clone()
    }
}

/// Kills a child's process group from any thread. Its pid while the child is unreaped: once reaped, the pid may be
/// another process's, so a kill then does nothing.
#[derive(Clone)]
pub struct Killer(Arc<Unreaped>);

/// A child's pid until it is reaped, and the word that it has been.
struct Unreaped {
    pid: Mutex<Option<libc::pid_t>>,
    reaped: Condvar,
}

impl Killer {
    pub fn kill(&self) {
        if let Some(pid) = *self.0.pid.lock().unwrap() {
            kill_group(pid);
        }
    }

    /// SIGTERM to the child alone, which it may catch to clean up, then `kill_after(grace)`.
    pub fn stop(&self, grace: Duration) {
        if let Some(pid) = *self.0.pid.lock().unwrap() {
            // SAFETY: kill only sends a signal, to an unreaped child's own pid.
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        self.kill_after(grace);
    }

    /// Kills the group unless the child is reaped within `grace`, on a thread of its own: for a child asked to end,
    /// which may not.
    pub fn kill_after(&self, grace: Duration) {
        let unreaped = self.0.clone();
        thread::spawn(move || {
            let pid = unreaped.pid.lock().unwrap();
            let (pid, _) = unreaped.reaped.wait_timeout_while(pid, grace, |pid| pid.is_some()).unwrap();
            if let Some(pid) = *pid {
                kill_group(pid);
            }
        });
    }
}

/// Closes a child's stdin from any thread, while another waits on its lines. It holds the pipe weakly, so a dropped
/// child's stdin still closes with it, and a close after that does nothing.
#[derive(Clone)]
pub struct StdinCloser(Weak<Mutex<Option<ChildStdin>>>);

impl StdinCloser {
    /// True when this call closed it.
    pub fn close(&self) -> bool {
        self.0.upgrade().is_some_and(|stdin| stdin.lock().unwrap().take().is_some())
    }
}

/// Blocks until the child `pid` has exited, and leaves it unreaped: until it is reaped neither its pid nor its group
/// can be another's.
fn exited(pid: libc::pid_t) {
    // SAFETY: waitid writes only the siginfo it is handed, which zeroes are a valid value of.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    while unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) } == -1
        && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
    {}
}

/// SIGKILL to the child and everything it started in its group.
fn kill_group(pid: libc::pid_t) {
    // SAFETY: kill only sends a signal; callers hold an unreaped child's pid, which is its group's id.
    unsafe { libc::kill(-pid, libc::SIGKILL) };
}

type Tail = Arc<Mutex<VecDeque<u8>>>;

/// Reads `stream` to its end on a thread, keeping its last TAIL_MAX bytes, then says so on `done`.
fn tail(mut stream: impl Read + Send + 'static, done: mpsc::Sender<()>) -> Tail {
    let kept = Tail::default();
    let writer = kept.clone();
    thread::spawn(move || {
        let mut chunk = [0; 8192];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    let mut kept = writer.lock().unwrap();
                    kept.extend(&chunk[..read]);
                    let over = kept.len().saturating_sub(TAIL_MAX);
                    kept.drain(..over);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = done.send(());
    });
    kept
}

fn text(tail: &Tail) -> String {
    String::from_utf8_lossy(tail.lock().unwrap().make_contiguous()).into_owned()
}

/// Hands each line of `stream`, without its newline, to `send` until it says stop. A line longer than LINE_MAX is
/// read through and dropped, never held whole.
fn read_lines(stream: impl Read, mut send: impl FnMut(String) -> bool) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let (used, complete) = match reader.fill_buf() {
            Ok([]) => break,
            Ok(chunk) => {
                let newline = chunk.iter().position(|&byte| byte == b'\n');
                let part = &chunk[..newline.unwrap_or(chunk.len())];
                too_long |= line.len() + part.len() > LINE_MAX;
                if too_long {
                    line.clear();
                } else {
                    line.extend_from_slice(part);
                }
                (part.len() + usize::from(newline.is_some()), newline.is_some())
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        reader.consume(used);
        if complete {
            if !too_long && !send(String::from_utf8_lossy(&line).into_owned()) {
                return;
            }
            line.clear();
            too_long = false;
        }
    }
    if !too_long && !line.is_empty() {
        send(String::from_utf8_lossy(&line).into_owned());
    }
}

fn name(args: &[&str]) -> String {
    format!("harness {}", args.join(" "))
}

/// The log line for a child that ended: its code and, after a failure, stderr's last line. Never stdout, which may
/// hold what a log must not (the sign-in's email).
fn ended(name: &str, code: Option<i32>, stderr: &str) -> String {
    let last = stderr.lines().rev().map(str::trim).find(|line| !line.is_empty());
    match (code, last) {
        (None, _) => format!("{name}: killed by a signal"),
        (Some(code), Some(last)) if code != 0 => format!("{name}: exit {code}: {last}"),
        (Some(code), _) => format!("{name}: exit {code}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fake, wait_gone};
    use crate::types::MemoryLog;
    use std::env;
    use std::fs;
    use std::time::Instant;

    const WAIT: Duration = Duration::from_secs(5);
    const WATCH: [&str; 3] = ["hardware", "watch", "--json"];
    const CANCELLED: &str = concat!(
        r#"{"type":"result","status":"error","code":"CANCELLED","#,
        r#""message":"Sign-in stopped: the app that started it has gone."}"#
    );

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
    fn each_run_looks_for_the_cli_again() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let runtime = home.join(".harness").join("runtime");
        put(home.join(".harness").join("cli").join("cli.js"));
        // Two Nodes that end apart, linked rather than written (testing::Fake on ETXTBSY).
        let (old, new) = (runtime.join("node-old"), runtime.join("node-new"));
        fs::create_dir_all(&runtime).unwrap();
        std::os::unix::fs::symlink("/usr/bin/true", &old).unwrap();
        std::os::unix::fs::symlink("/usr/bin/false", &new).unwrap();
        fs::write(runtime.join("current-node"), old.display().to_string()).unwrap();
        let cli = HarnessCli::new(find_cli(home, None, None).unwrap(), Arc::new(MemoryLog::default()));
        let status = ["auth", "status", "--json"];
        assert_eq!(cli.run(&status, WAIT).unwrap().code, Some(0));
        // The CLI's updater repoints it while the app runs.
        fs::write(runtime.join("current-node"), new.display().to_string()).unwrap();
        assert_eq!(cli.run(&status, WAIT).unwrap().code, Some(1));
        // Gone by the time of a run: not found, as when it was never there.
        fs::remove_file(runtime.join("current-node")).unwrap();
        assert_eq!(cli.run(&status, WAIT).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(cli.spawn(&WATCH).err().map(|error| error.kind()), Some(io::ErrorKind::NotFound));
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
        // Under load `sh` can take the whole deadline to start and die before it writes the pid: the deadline then
        // doubles until a run got that far.
        let mut deadline = Duration::from_millis(300);
        loop {
            let folder = tempfile::tempdir().unwrap();
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 600 & echo $! > pid; wait"]).current_dir(folder.path());
            let started = Instant::now();
            let output = run(command, deadline).unwrap();
            assert!(output.timed_out);
            assert!(started.elapsed() < deadline + WAIT);
            let pid = fs::read_to_string(folder.path().join("pid")).ok().and_then(|pid| pid.trim().parse().ok());
            if let Some(pid) = pid {
                assert!(wait_gone(pid));
                return;
            }
            deadline *= 2;
            assert!(deadline < Duration::from_secs(10), "sh never wrote the pid");
        }
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
    fn a_closer_ends_stdin_from_another_thread_and_later_does_nothing() {
        let fake = Fake::new();
        fake.script("hardware watch --json", &["a", "@stdin"]);
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        assert_eq!(child.line(WAIT), Ok(Some("a".into())));
        let closer = child.stdin_closer();
        let other = closer.clone();
        thread::spawn(move || other.close());
        assert_eq!(child.line(WAIT), Ok(None));
        assert_eq!(child.exit(WAIT), Ok(Some(0)));
        closer.close();
        drop(child);
        closer.close();
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
