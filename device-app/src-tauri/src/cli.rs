//! Find the `harness` CLI and run it: deadlines, NDJSON lines.

#[cfg(unix)]
use crate::child_unix as child;
#[cfg(windows)]
use crate::child_windows as child;
use crate::harness_home::{Entry, Look, harness_roots_with};
use crate::types::{Log, Output};
use std::collections::VecDeque;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak, mpsc};
use std::thread;
use std::time::{Duration, Instant};

/// A line of output longer than this is dropped: what a CLI prints is outside text.
pub const LINE_MAX: usize = 64 * 1024;
/// `auth status`, `--version`.
pub const STATUS_DEADLINE: Duration = Duration::from_secs(10);
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
/// The three shapes of a child's stderr its log carries as it comes (`logged_stderr`), as the watch says only there that
/// a newer one took its tabs stream and goes on, or that a sound or Notifications change failed: this line exactly,
/// SOUND_STDERR and a code, and NOTIFY_STDERR and a code. Every other line of stderr is outside text and stays out of
/// the log but for a failure's last line.
const LOGGED_STDERR: &str = "tabs stream replaced";
/// A failed sound change, then its code: one of the watch's own words or the daemon's error code, never a message.
const SOUND_STDERR: &str = "sound: ";
/// A failed Notifications change, then its code, of the same kind as a sound change's.
const NOTIFY_STDERR: &str = "notify: ";
const CODE_MAX: usize = 32;
/// The longest version the About panel shows: what the CLI prints is outside text.
const VERSION_MAX: usize = 32;

/// How to run the CLI: `program`, then `prefix`, then the arguments, with `env` on top of the app's own.
#[derive(Clone, Debug)]
pub struct Invocation {
    pub program: PathBuf,
    pub prefix: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    /// Where it was found, so a `HarnessCli` can look there again.
    from: Lookup,
}

/// The XDG variables Harness's folders are found by: this process's, or a test's.
type Env = fn(&str) -> Option<OsString>;

/// What `find_cli` looks with.
#[derive(Clone, Debug)]
struct Lookup {
    home: PathBuf,
    path_var: Option<OsString>,
    over: Option<PathBuf>,
    xdg: Env,
}

/// The desktop app's order: `over`, then the managed runtime with its `cli.js`, then `~/.local/bin/harness`, then a
/// `harness` in one of PATH's absolute folders. A Finder-launched app has launchd's bare PATH, hence the first two.
pub fn find_cli(home: &Path, path_var: Option<&OsStr>, over: Option<&Path>) -> Option<Invocation> {
    find_cli_with(home, path_var, over, |name| env::var_os(name))
}

/// `find_cli`, Harness's folders found by `xdg`'s XDG variables.
fn find_cli_with(home: &Path, path_var: Option<&OsStr>, over: Option<&Path>, xdg: Env) -> Option<Invocation> {
    let (program, prefix) = match over {
        Some(over) => (over.to_path_buf(), Vec::new()),
        None => installed_with(
            home,
            path_var,
            &Look { linux: cfg!(target_os = "linux"), env: &xdg, exists: &Path::exists, file: &Path::is_file },
        )?,
    };
    let locale =
        ["LC_ALL", "LC_CTYPE", "LANG"].into_iter().find_map(|name| env::var_os(name).filter(|value| !value.is_empty()));
    let from = Lookup {
        home: home.to_path_buf(),
        path_var: path_var.map(OsStr::to_os_string),
        over: over.map(Path::to_path_buf),
        xdg,
    };
    Some(Invocation { program, prefix, env: child_env(home, path_var, locale.as_deref()), from })
}

/// The installed CLI, Harness's folders found by one look, so its `cli.js` and its Node never come from two layouts.
fn installed_with(home: &Path, path_var: Option<&OsStr>, look: &Look) -> Option<(PathBuf, Vec<OsString>)> {
    let roots = harness_roots_with(home, look);
    let cli_js = roots.path(Entry::Cli).join("cli.js");
    if let Some(node) = managed_node(&roots.path(Entry::Runtime)).filter(|_| cli_js.is_file()) {
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

/// Held around every spawn. macOS has no pipe2: a child's pipes are made, then marked close-on-exec, and a child
/// another thread starts between the two keeps them, holding the first child's output open after it has ended.
pub(crate) fn spawn_lock() -> MutexGuard<'static, ()> {
    static SPAWNING: Mutex<()> = Mutex::new(());
    SPAWNING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs `command` in its own process group to its end, stdin empty. Past `deadline` the whole group is killed and
/// `timed_out` is true. Each stream keeps its last 256 KiB.
pub fn run(command: Command, deadline: Duration) -> io::Result<Output> {
    run_lines(command, deadline, &mut |_| {})
}

/// As `run`, and hands `sink` each line of stdout and stderr, without its newline, on the caller's thread, in the
/// order the lines arrive. A line longer than LINE_MAX is not handed. Past the deadline no more lines are handed.
pub fn run_lines(command: Command, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output> {
    run_until(command, Instant::now() + deadline, &Instant::now, sink)
}

/// As `run_lines`, until `end` on the clock `now` reads: a test moves its own clock past `end` instead of sleeping
/// there.
fn run_until(
    mut command: Command,
    end: Instant,
    now: &dyn Fn() -> Instant,
    sink: &mut dyn FnMut(&str),
) -> io::Result<Output> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let (mut child, group) = child::spawn(&mut command)?;
    // One queue for both streams, so their lines come in the order they were read; bounded, so a slow sink makes the
    // child wait on its pipe instead of lines piling up here.
    let (send, lines) = mpsc::sync_channel(LINES_QUEUED);
    let stdout = tailed_lines(child.stdout.take().expect("stdout is piped"), send.clone());
    let stderr = tailed_lines(child.stderr.take().expect("stderr is piped"), send);
    let (send_exit, exit) = mpsc::channel();
    let exiting = group.clone();
    thread::spawn(move || {
        exiting.exited();
        let _ = send_exit.send(());
    });
    let left = || end.saturating_duration_since(now());
    // Both streams' ends, then its exit. The child is reaped only after this, so its group is still its own to kill.
    // The deadline is checked at each line too: recv_timeout hands a waiting line however late, and behind a slow sink
    // a child that never stops printing always has one waiting.
    let timed_out = loop {
        match lines.recv_timeout(left()) {
            Ok(line) if now() < end => sink(&line),
            Err(mpsc::RecvTimeoutError::Disconnected) => break exit.recv_timeout(left()).is_err(),
            _ => break true,
        }
    };
    if timed_out {
        group.kill();
    }
    let code = group.code(child.wait()?);
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
        let Lookup { home, path_var, over, xdg } = &self.from;
        let invocation =
            find_cli_with(home, path_var.as_deref(), over.as_deref(), *xdg).ok_or(io::ErrorKind::NotFound)?;
        let mut command = Command::new(&invocation.program);
        command.args(&invocation.prefix).args(args).envs(invocation.env);
        Ok(command)
    }

    /// `start` with the command. One that cannot start is a log line too: its error's kind, never a path.
    fn started<T>(&self, args: &[&str], start: impl FnOnce(Command) -> io::Result<T>) -> io::Result<T> {
        let started = self.command(args).and_then(start);
        if let Err(error) = &started {
            self.log.line(&format!("{}: could not start: {}", name(args), error.kind()));
        }
        started
    }
}

impl Cli for HarnessCli {
    fn run(&self, args: &[&str], deadline: Duration) -> io::Result<Output> {
        let output = self.started(args, |command| run(command, deadline))?;
        let name = name(args);
        self.log.line(&if output.timed_out {
            format!("{name}: timed out after {} s", deadline.as_secs_f64())
        } else {
            ended(&name, output.code, &output.stderr)
        });
        Ok(output)
    }

    fn spawn(&self, args: &[&str]) -> io::Result<Child> {
        self.started(args, |command| Child::start(command, name(args), self.log.clone()))
    }
}

/// `harness --version`: its first line, when it reads as a version (digits, letters, `.`, `+` and `-`).
pub fn version(cli: &dyn Cli) -> Option<String> {
    let output = cli.run(&["--version"], STATUS_DEADLINE).ok()?;
    if output.timed_out || output.code != Some(0) {
        return None;
    }
    let line = output.stdout.lines().next()?.trim();
    let valid = |c: char| c.is_ascii_alphanumeric() || ".+-".contains(c);
    (!line.is_empty() && line.len() <= VERSION_MAX && line.chars().all(valid)).then(|| line.to_string())
}

/// A running CLI in its own process group: its stdin is held open until closed or dropped, its stdout comes a line
/// at a time.
pub struct Child {
    stdin: Arc<Mutex<Option<child::Stdin>>>,
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
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (mut child, group) = child::spawn(&mut command)?;
        // Taken out, or `wait` below would close it. A StdinWriter writes on the thread the OS tells the app in front
        // on: a child that stops reading must not hold it, nor a closer waiting on the same lock, so child::Stdin never
        // waits.
        let stdin = Arc::new(Mutex::new(child.stdin.take().map(child::Stdin::new)));
        let stdout = child.stdout.take().expect("stdout is piped");
        let (send, lines) = mpsc::sync_channel(LINES_QUEUED);
        thread::spawn(move || read_lines(stdout, |line| send.send(line).is_ok()));
        let (stderr_done, stderr_ended) = mpsc::channel();
        let (stderr_log, stderr_name) = (log.clone(), name.clone());
        let stderr = tail(child.stderr.take().expect("stderr is piped"), stderr_done, move |line| {
            stderr_log.line(&format!("{stderr_name}: {line}"))
        });
        let killer = Killer(Arc::new(Unreaped { group: Mutex::new(Some(group.clone())), reaped: Condvar::new() }));
        let unreaped = killer.0.clone();
        let (send_exit, exit) = mpsc::channel();
        thread::spawn(move || {
            group.exited();
            let _ = stderr_ended.recv_timeout(STDERR_GRACE);
            let status = {
                let mut held = unreaped.group.lock().unwrap();
                *held = None;
                child.wait()
            };
            unreaped.reaped.notify_all();
            let code = status.ok().and_then(|status| group.code(status));
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

    pub fn stdin_closer(&self) -> StdinCloser {
        StdinCloser(Arc::downgrade(&self.stdin))
    }

    pub fn stdin_writer(&self) -> StdinWriter {
        StdinWriter(Arc::downgrade(&self.stdin))
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

/// Kills a child's process group from any thread. Its group while the child is unreaped: once reaped, the pid may be
/// another process's, so a kill then does nothing.
#[derive(Clone)]
pub struct Killer(Arc<Unreaped>);

/// A child's group until it is reaped, and the word that it has been.
struct Unreaped {
    group: Mutex<Option<child::Group>>,
    reaped: Condvar,
}

impl Killer {
    pub fn kill(&self) {
        if let Some(group) = &*self.0.group.lock().unwrap() {
            group.kill();
        }
    }

    /// SIGTERM to the child alone, which it may catch to clean up (Windows has none: its job ends at once), then
    /// `kill_after(grace)`.
    pub fn stop(&self, grace: Duration) {
        if let Some(group) = &*self.0.group.lock().unwrap() {
            group.stop();
        }
        self.kill_after(grace);
    }

    /// Kills the group unless the child is reaped within `grace`, on a thread of its own: for a child asked to end,
    /// which may not.
    pub fn kill_after(&self, grace: Duration) {
        let unreaped = self.0.clone();
        thread::spawn(move || {
            let group = unreaped.group.lock().unwrap();
            let (group, _) = unreaped.reaped.wait_timeout_while(group, grace, |group| group.is_some()).unwrap();
            if let Some(group) = &*group {
                group.kill();
            }
        });
    }
}

/// Closes a child's stdin from any thread, while another waits on its lines. It holds the pipe weakly, so a dropped
/// child's stdin still closes with it, and a close after that does nothing.
#[derive(Clone)]
pub struct StdinCloser(Weak<Mutex<Option<child::Stdin>>>);

impl StdinCloser {
    /// True when this call closed it.
    pub fn close(&self) -> bool {
        self.0.upgrade().is_some_and(|stdin| stdin.lock().unwrap().take().is_some())
    }
}

/// Writes lines on a child's stdin from any thread. It holds the pipe weakly, as StdinCloser does.
pub struct StdinWriter(Weak<Mutex<Option<child::Stdin>>>);

/// Why a line was not written.
#[derive(Debug, PartialEq, Eq)]
pub enum Unwritten {
    /// Stdin is closed, or the child has gone.
    Closed,
    /// The pipe is full: the writer never waits (Child::start), and only a child that has stopped reading fills it.
    Full,
}

impl StdinWriter {
    /// The text and a newline.
    pub fn line(&self, text: &str) -> Result<(), Unwritten> {
        let stdin = self.0.upgrade().ok_or(Unwritten::Closed)?;
        let mut stdin = stdin.lock().unwrap();
        stdin.as_mut().ok_or(Unwritten::Closed)?.line(text)
    }
}

type Tail = Arc<Mutex<VecDeque<u8>>>;

/// True for the lines of stderr a log carries as they come: LOGGED_STDERR exactly, or SOUND_STDERR or NOTIFY_STDERR and
/// a code of 1 to CODE_MAX of `A-Z`, `0-9` and `_`, starting with a letter. Nothing else, so no path, address or message.
fn logged_stderr(line: &[u8]) -> bool {
    let is_code = |code: &[u8]| match code {
        [first, rest @ ..] => {
            code.len() <= CODE_MAX
                && first.is_ascii_uppercase()
                && rest.iter().all(|&byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        }
        [] => false,
    };
    line == LOGGED_STDERR.as_bytes()
        || [SOUND_STDERR, NOTIFY_STDERR].iter().any(|prefix| line.strip_prefix(prefix.as_bytes()).is_some_and(is_code))
}

/// Reads `stream` to its end on a thread, keeping its last TAIL_MAX bytes, then says so on `done`. `logged` is handed
/// each line that passes `logged_stderr`, without its newline.
fn tail(
    mut stream: impl Read + Send + 'static,
    done: mpsc::Sender<()>,
    logged: impl Fn(&str) + Send + 'static,
) -> Tail {
    let kept = Tail::default();
    let writer = kept.clone();
    thread::spawn(move || {
        let mut chunk = [0; 8192];
        // The line so far, held only to one byte past the longest logged line: a longer line is not one.
        let longest = LOGGED_STDERR.len().max(SOUND_STDERR.len().max(NOTIFY_STDERR.len()) + CODE_MAX);
        let mut line = Vec::with_capacity(longest + 1);
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    for &byte in &chunk[..read] {
                        if byte == b'\n' {
                            if logged_stderr(&line) {
                                logged(&String::from_utf8_lossy(&line));
                            }
                            line.clear();
                        } else if line.len() <= longest {
                            line.push(byte);
                        }
                    }
                    keep(&writer, &chunk[..read]);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = done.send(());
    });
    kept
}

/// Adds `bytes` to `tail`, which keeps its last TAIL_MAX.
fn keep(tail: &Tail, bytes: &[u8]) {
    let mut kept = tail.lock().unwrap();
    kept.extend(bytes);
    let over = kept.len().saturating_sub(TAIL_MAX);
    kept.drain(..over);
}

/// A stream that keeps what is read of it in a Tail.
struct Tailed<R> {
    stream: R,
    kept: Tail,
}

impl<R: Read> Read for Tailed<R> {
    fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
        let read = self.stream.read(into)?;
        keep(&self.kept, &into[..read]);
        Ok(read)
    }
}

/// Reads `stream` on a thread, keeping its last TAIL_MAX bytes and sending its lines as `read_lines` splits them,
/// until it ends or nobody receives. `send` is dropped only once the tail is whole, so a queue that has ended means
/// both tails are.
fn tailed_lines(stream: impl Read + Send + 'static, send: mpsc::SyncSender<String>) -> Tail {
    let kept = Tail::default();
    let stream = Tailed { stream, kept: kept.clone() };
    thread::spawn(move || read_lines(stream, |line| send.send(line).is_ok()));
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

/// The run's name in the log: its fixed arguments.
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
    use crate::harness_home::Look;
    #[cfg(unix)]
    use crate::testing::{Fake, wait_gone};
    #[cfg(unix)]
    use crate::types::MemoryLog;
    use std::cell::Cell;
    #[cfg(unix)]
    use std::env;
    use std::fs;
    #[cfg(unix)]
    use std::time::Instant;

    const WAIT: Duration = Duration::from_secs(5);
    #[cfg(unix)]
    const WATCH: [&str; 3] = ["hardware", "watch", "--json"];
    #[cfg(unix)]
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

    /// No XDG variable set: the folders a test lays out are the only ones the rule finds, whatever the computer
    /// running it holds.
    fn no_env(_: &str) -> Option<OsString> {
        None
    }

    #[cfg(unix)]
    fn found(home: &Path, path_var: Option<&OsStr>) -> Option<(PathBuf, Vec<OsString>)> {
        find_cli_with(home, path_var, None, no_env).map(|cli| (cli.program, cli.prefix))
    }

    #[test]
    fn the_cli_and_its_node_come_from_one_look() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let legacy = home.join(".harness");
        let node = put(legacy.join("runtime").join("node-v22").join("bin").join("node"));
        fs::write(legacy.join("runtime").join("current-node"), node.display().to_string()).unwrap();
        let cli_js = put(legacy.join("cli").join("cli.js"));
        // The move lands between two looks: the XDG data root's marker is there from the second one on.
        let marker = home.join(".local").join("share").join("harness").join(".harness-root");
        let asked = Cell::new(0);
        let exists = |path: &Path| {
            if path == marker {
                asked.set(asked.get() + 1);
                return asked.get() > 1;
            }
            path.exists()
        };
        let look = Look { linux: true, env: &no_env, exists: &exists, file: &exists };
        assert_eq!(installed_with(home, None, &look), Some((node, vec![cli_js.into_os_string()])));
        assert_eq!(asked.get(), 1);
    }

    // The unix layout, which Windows does not read (the Windows layout's tests below).
    #[cfg(unix)]
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

    #[cfg(unix)]
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

    // The launcher and the folders are unix ones.
    #[cfg(unix)]
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

    // A unix PATH, `:` between its folders.
    #[cfg(unix)]
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
            assert_eq!(
                child_env(home, system, Some(OsStr::new(locale))),
                std::slice::from_ref(&with_system),
                "{locale}"
            );
        }
        assert_eq!(child_env(home, None, None), [path("/Users/someone/.local/bin"), c_utf8]);
    }

    /// What Windows finds under `home`, whose Harness folder is `<home>/.harness`.
    fn found_windows(home: &Path, path_var: Option<&OsStr>) -> Option<(PathBuf, Vec<OsString>)> {
        let look = Look { linux: false, env: &no_env, exists: &Path::exists, file: &Path::is_file };
        installed_windows(home, path_var, &look)
    }

    /// install.ps1's layout under `home`: `runtime/current-node` names a node.exe inside `runtime`, `cli/current` the
    /// version folder that holds `cli.js`. What the CLI is then run as.
    fn lay_out(home: &Path, version: &str) -> (PathBuf, Vec<OsString>) {
        let root = home.join(".harness");
        let node = put(root.join("runtime").join("node-v24.11.1-win-x64").join("node.exe"));
        fs::write(root.join("runtime").join("current-node"), node.display().to_string()).unwrap();
        let cli_js = put(root.join("cli").join(version).join("cli.js"));
        fs::write(root.join("cli").join("current"), version).unwrap();
        (node, vec![cli_js.into_os_string()])
    }

    /// A link at `at` to `target`, a file or a folder.
    fn link(target: &Path, at: PathBuf) -> PathBuf {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, &at).unwrap();
        #[cfg(windows)]
        match target.is_dir() {
            true => std::os::windows::fs::symlink_dir(target, &at).unwrap(),
            false => std::os::windows::fs::symlink_file(target, &at).unwrap(),
        }
        at
    }

    #[test]
    fn the_windows_layout_names_node_and_the_version_folders_cli_js() {
        let home = tempfile::tempdir().unwrap();
        let (node, cli_js) = lay_out(home.path(), "0.6.12");
        let version = home.path().join(".harness").join("cli").join("0.6.12");
        assert_eq!(cli_js, [version.join("cli.js").into_os_string()]);
        assert_eq!(found_windows(home.path(), None), Some((node, cli_js)));
    }

    #[test]
    fn a_pointer_with_a_byte_order_mark_and_a_crlf_reads() {
        // As Notepad and Windows PowerShell 5.1 write a file, and as Node's trim() reads it.
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".harness");
        let (node, cli_js) = lay_out(home.path(), "0.6.12");
        fs::write(root.join("runtime").join("current-node"), format!("\u{feff}{}\r\n", node.display())).unwrap();
        fs::write(root.join("cli").join("current"), "\u{feff}0.6.12\r\n").unwrap();
        assert_eq!(found_windows(home.path(), None), Some((node, cli_js)));
    }

    #[test]
    fn a_pointer_that_leads_out_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".harness");
        let (runtime, cli) = (root.join("runtime"), root.join("cli"));
        let (node, _) = lay_out(home.path(), "0.6.12");
        let outside = tempfile::tempdir().unwrap();
        let elsewhere = put(outside.path().join("node.exe"));
        let nodes = [
            elsewhere.clone(),
            // Under the runtime folder as text, outside it as a path, to a file that is there.
            runtime.join("..").join("cli").join("0.6.12").join("cli.js"),
            PathBuf::from("node.exe"),
            link(&elsewhere, runtime.join("linked.exe")),
        ];
        for pointer in nodes {
            fs::write(runtime.join("current-node"), pointer.display().to_string()).unwrap();
            assert_eq!(found_windows(home.path(), None), None, "{}", pointer.display());
        }
        fs::write(runtime.join("current-node"), node.display().to_string()).unwrap();
        // Each names a `cli.js` that is there, so only the rule refuses it.
        put(root.join("cli.js"));
        put(cli.join("cli.js"));
        put(cli.join("a").join("b").join("cli.js"));
        put(cli.join(r"a\b").join("cli.js"));
        put(outside.path().join("cli.js"));
        link(outside.path(), cli.join("linked"));
        for version in ["..", ".", "  ", "a/b", r"a\b", "c:", "0.6.12/../0.6.12", "linked"] {
            fs::write(cli.join("current"), version).unwrap();
            assert_eq!(found_windows(home.path(), None), None, "{version:?}");
        }
    }

    #[test]
    fn then_bin_harness_exe_then_a_harness_exe_on_path() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let folders = tempfile::tempdir().unwrap();
        // A unix `harness` is not Windows's.
        let unix = put(folders.path().join("unix").join("harness"));
        let near = put(folders.path().join("near").join("harness.exe"));
        let far = put(folders.path().join("far").join("harness.exe"));
        let path_var = env::join_paths([&unix, &near, &far].map(|file| file.parent().unwrap())).unwrap();
        assert_eq!(found_windows(home, None), None);
        assert_eq!(found_windows(home, Some(&path_var)), Some((near, vec![])));
        let bin = put(home.join(".harness").join("bin").join("harness.exe"));
        assert_eq!(found_windows(home, Some(&path_var)), Some((bin, vec![])));
        let cli = lay_out(home, "0.6.12");
        assert_eq!(found_windows(home, Some(&path_var)), Some(cli));
    }

    #[test]
    fn the_layout_is_found_under_a_home_with_a_space_and_an_accent() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("Nguyễn Văn A");
        let cli = lay_out(&home, "0.6.12");
        assert_eq!(found_windows(&home, None), Some(cli));
        fs::remove_file(home.join(".harness").join("cli").join("current")).unwrap();
        let bin = put(home.join(".harness").join("bin").join("harness.exe"));
        assert_eq!(found_windows(&home, None), Some((bin, vec![])));
    }

    #[test]
    fn a_windows_child_has_bin_first_a_semicolon_and_no_lc_all() {
        let home = Path::new("/h");
        let path = |rest: &str| {
            let mut path = home.join(".harness").join("bin").into_os_string();
            path.push(rest);
            [(OsString::from("PATH"), path)]
        };
        let system = Some(OsStr::new(r"C:\Windows\system32;C:\Windows"));
        for locale in [None, Some("C"), Some("en_US.UTF-8")] {
            let env = child_env_for(true, home, system, locale.map(OsStr::new));
            assert_eq!(env, path(r";C:\Windows\system32;C:\Windows"), "{locale:?}");
        }
        assert_eq!(child_env_for(true, home, None, None), path(""));
        assert_eq!(child_env_for(true, home, Some(OsStr::new("")), None), path(""));
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
        let cli = HarnessCli::new(find_cli_with(home, None, None, no_env).unwrap(), Arc::new(MemoryLog::default()));
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

    /// Runs `sh -c script` in a folder of its own, its deadline WAIT away on a clock the sink moves: at the first line,
    /// which the script prints once it has written `pid`, the sink reads that file and moves the clock to the deadline.
    /// Gives whether the run timed out, the lines it handed and the pid read.
    #[cfg(unix)]
    fn past_its_deadline(script: &str) -> (bool, usize, Option<i32>) {
        let folder = tempfile::tempdir().unwrap();
        let mut command = Command::new("sh");
        command.args(["-c", script]).current_dir(folder.path());
        let pid_file = folder.path().join("pid");
        // On a thread, so a run that hands lines for ever fails the test instead of hanging it.
        let (send, back) = mpsc::channel();
        thread::spawn(move || {
            let start = Instant::now();
            let (clock, end) = (Cell::new(start), start + WAIT);
            let (mut handed, mut pid) = (0, None);
            let output = run_until(command, end, &|| clock.get(), &mut |_| {
                handed += 1;
                if handed == 1 {
                    pid = fs::read_to_string(&pid_file).ok().and_then(|pid| pid.trim().parse().ok());
                    clock.set(end);
                }
            });
            send.send((output.map(|output| output.timed_out), handed, pid))
        });
        let (timed_out, handed, pid) = back.recv_timeout(WAIT * 2).expect("back within WAIT twice");
        (timed_out.unwrap(), handed, pid)
    }

    #[cfg(unix)]
    #[test]
    fn a_run_past_its_deadline_dies_with_its_children() {
        let (timed_out, handed, pid) = past_its_deadline("sleep 600 & echo $! > pid; echo started; wait");
        assert!(timed_out);
        assert_eq!(handed, 1);
        assert!(wait_gone(pid.expect("the pid sh wrote")));
    }

    /// What `sh -c script` hands a sink, and its output. `args` are the script's `$1` on.
    #[cfg(unix)]
    fn handed(script: &str, args: &[&str]) -> (Vec<String>, Output) {
        let mut command = Command::new("sh");
        command.args(["-c", script, "sh"]).args(args);
        let mut seen = Vec::new();
        let output = run_lines(command, WAIT, &mut |line| seen.push(line.to_string())).unwrap();
        (seen, output)
    }

    /// A child that prints `a` on stdout, `b` on stderr, then `c` on stdout and exits 3, each line only once the sink
    /// has the one before: it waits on a FIFO the sink writes to.
    #[cfg(unix)]
    fn in_turn() -> (Vec<String>, Output) {
        let folder = tempfile::tempdir().unwrap();
        let mut command = Command::new("sh");
        command
            .args(["-c", "mkfifo one two; echo a; read go < one; echo b >&2; read go < two; echo c; exit 3"])
            .current_dir(folder.path());
        let mut fifos = ["one", "two"].map(|name| folder.path().join(name)).into_iter();
        let mut seen = Vec::new();
        let output = run_lines(command, WAIT, &mut |line| {
            seen.push(line.to_string());
            if let Some(fifo) = fifos.next() {
                // On a thread: a run that held its lines back would leave this open waiting for a reader, not the test.
                thread::spawn(move || fs::write(fifo, "\n"));
            }
        })
        .unwrap();
        (seen, output)
    }

    #[cfg(unix)]
    #[test]
    fn a_run_hands_each_line_as_it_arrives_in_the_order_written() {
        assert_eq!(in_turn().0, ["a", "b", "c"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_run_with_a_sink_still_gives_code_and_both_streams() {
        let output = Output { code: Some(3), timed_out: false, stdout: "a\nc\n".into(), stderr: "b\n".into() };
        assert_eq!(in_turn().1, output);
    }

    #[cfg(unix)]
    #[test]
    fn a_line_over_64_kib_is_not_handed_and_the_next_one_is() {
        let (over, longest) = ("x".repeat(LINE_MAX + 1), "y".repeat(LINE_MAX));
        let (seen, _) = handed(r#"printf '%s\n' "$1" "$2" next"#, &[&over, &longest]);
        assert_eq!(seen, [longest.as_str(), "next"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_last_line_without_a_newline_is_handed() {
        assert_eq!(handed(r"printf 'a\nb'", &[]).0, ["a", "b"]);
    }

    #[cfg(unix)]
    #[test]
    fn bytes_that_are_not_utf_8_are_handed_as_text() {
        let (seen, output) = handed(r"printf 'a\377b\n'", &[]);
        assert_eq!(seen, ["a\u{fffd}b"]);
        assert_eq!((output.code, output.timed_out), (Some(0), false));
    }

    #[cfg(unix)]
    #[test]
    fn a_sink_slower_than_the_child_loses_no_line() {
        let folder = tempfile::tempdir().unwrap();
        let mut command = Command::new("sh");
        // `written` opens once every line is in the pipe, past the lines the run queues.
        command.args(["-c", "mkfifo written; seq 2000; : > written"]).current_dir(folder.path());
        let written = folder.path().join("written");
        let (all_written, child_done) = mpsc::channel();
        let mut seen = Vec::new();
        let output = run_lines(command, WAIT, &mut |line| {
            if seen.is_empty() {
                // The first line waits for the child to have written them all. On a thread, so a run that never gets
                // there fails the test instead of hanging it.
                let (written, all_written) = (written.clone(), all_written.clone());
                thread::spawn(move || all_written.send(fs::read(written).is_ok()));
                assert_eq!(child_done.recv_timeout(WAIT), Ok(true));
            }
            seen.push(line.to_string());
        })
        .unwrap();
        let all: Vec<String> = (1..=2000).map(|line| line.to_string()).collect();
        assert_eq!(seen, all);
        assert_eq!((output.code, output.timed_out), (Some(0), false));
    }

    #[cfg(unix)]
    #[test]
    fn a_run_past_its_deadline_stops_handing_lines_and_dies_with_its_children() {
        // A child that never stops printing: lines wait behind the sink when the deadline passes, and none is handed.
        let (timed_out, handed, pid) = past_its_deadline("sleep 600 & echo $! > pid; while :; do echo x; done");
        assert!(timed_out);
        assert_eq!(handed, 1);
        assert!(wait_gone(pid.expect("the pid sh wrote")));
    }

    #[cfg(unix)]
    #[test]
    fn a_child_gives_its_lines_then_ends() {
        let fake = Fake::new();
        fake.script("hardware watch --json", &["a", "b", "@stdin"]);
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        assert_eq!(child.line(WAIT), Ok(Some("a".into())));
        assert_eq!(child.line(WAIT), Ok(Some("b".into())));
        child.stdin_closer().close();
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
    fn a_writer_reaches_the_child_and_stops_when_stdin_is_closed() {
        let fake = Fake::new();
        fake.script("hardware watch --json", &["@record"]);
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        let writer = child.stdin_writer();
        assert_eq!(writer.line(r#"{"front":"a"}"#), Ok(()));
        assert_eq!(writer.line(r#"{"front":"b"}"#), Ok(()));
        assert!(child.stdin_closer().close());
        assert_eq!(writer.line(r#"{"front":"c"}"#), Err(Unwritten::Closed));
        assert_eq!(child.exit(WAIT), Ok(Some(0)));
        assert_eq!(fake.stdin(), [r#"{"front":"a"}"#, r#"{"front":"b"}"#]);
        drop(child);
        assert_eq!(writer.line(r#"{"front":"d"}"#), Err(Unwritten::Closed));
    }

    #[cfg(unix)]
    #[test]
    fn a_writer_never_waits_on_a_child_that_reads_nothing() {
        // The app in front is written on the thread the OS tells it on, AppKit's main thread on a Mac: a stuck child
        // must not hold it. Once its pipe is full, a line is dropped, and told apart from a closed pipe.
        let fake = Fake::new();
        fake.script("hardware watch --json", &["@hang"]);
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        let writer = child.stdin_writer();
        // On a thread, so a write that waits fails the test instead of hanging it.
        let (send, dropped) = mpsc::channel();
        thread::spawn(move || {
            let line = "x".repeat(100);
            // 1 MB, past any pipe's buffer.
            let _ = send.send((0..10_000).find_map(|_| writer.line(&line).err()));
        });
        assert_eq!(dropped.recv_timeout(WAIT), Ok(Some(Unwritten::Full)));
        // The closer is not held up either.
        assert!(child.stdin_closer().close());
        child.killer().kill();
        assert_eq!(child.exit(WAIT), Ok(None));
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

    #[test]
    fn a_run_is_named_by_every_argument() {
        assert_eq!(name(&["x", "--approve", "y"]), "harness x --approve y");
    }

    #[cfg(unix)]
    #[test]
    fn a_watch_logs_its_replaced_stream_as_it_comes_and_no_other_stderr() {
        let fake = Fake::new();
        fake.script(
            "hardware watch --json",
            &["@err tabs stream replaced", "@err /dev/ttys001 iterm", "@err tabs stream replaced!", "started", "@hang"],
        );
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        assert_eq!(child.line(WAIT), Ok(Some("started".into())));
        // Its end waits for stderr's, so the line, logged as it is read, comes first.
        child.killer().kill();
        assert_eq!(child.exit(WAIT), Ok(None));
        assert_eq!(
            fake.log().lines(),
            [
                "harness hardware watch --json: tabs stream replaced",
                "harness hardware watch --json: killed by a signal"
            ]
        );
    }

    #[test]
    fn only_three_shapes_of_stderr_are_logged_as_they_come() {
        let longest = format!("sound: {}", "A".repeat(32));
        let longest_notify = format!("notify: {}", "A".repeat(32));
        for line in [
            "tabs stream replaced",
            "sound: DEVICE_OFFLINE",
            "sound: NO_DIAL",
            "sound: A",
            "sound: E2E_9",
            &longest,
            "notify: NO_DIAL",
            "notify: WRITE_FAILED",
            "notify: A",
            &longest_notify,
        ] {
            assert!(logged_stderr(line.as_bytes()), "{line}");
        }
        let too_long = format!("sound: {}", "A".repeat(33));
        let too_long_notify = format!("notify: {}", "A".repeat(33));
        let refused = [
            "",
            "sound: ",
            "sound:NO_DIAL",
            " sound: NO_DIAL",
            "sound: NO_DIAL ",
            "sound: device_offline",
            "sound: DEVICE OFFLINE",
            "sound: 9A",
            "sound: _A",
            "sound: /Users/person",
            "sound: person@example.com",
            &too_long,
            "tabs stream replaced!",
            "notify: ",
            "notify:NO_DIAL",
            " notify: NO_DIAL",
            "notify: no dial",
            "Notify: NO_DIAL",
            "notify: /Users/person",
            "notify: person@example.com",
            &too_long_notify,
        ];
        for line in refused {
            assert!(!logged_stderr(line.as_bytes()), "{line}");
        }
        assert!(!logged_stderr(b"sound: \xff"));
    }

    #[cfg(unix)]
    #[test]
    fn a_watch_logs_a_sound_code_as_it_comes_and_no_other_stderr() {
        let fake = Fake::new();
        fake.script(
            "hardware watch --json",
            &["@err sound: DEVICE_OFFLINE", "@err sound: /Users/person/x", "@err sound: no dial", "started", "@hang"],
        );
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        assert_eq!(child.line(WAIT), Ok(Some("started".into())));
        // Its end waits for stderr's, so the line, logged as it is read, comes first.
        child.killer().kill();
        assert_eq!(child.exit(WAIT), Ok(None));
        assert_eq!(
            fake.log().lines(),
            [
                "harness hardware watch --json: sound: DEVICE_OFFLINE",
                "harness hardware watch --json: killed by a signal"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_watch_logs_a_notify_code_as_it_comes_and_no_other_stderr() {
        let fake = Fake::new();
        fake.script(
            "hardware watch --json",
            &[
                "@err notify: WRITE_FAILED",
                "@err notify: /Users/person/x",
                "@err notify: Connect the VPN",
                "started",
                "@hang",
            ],
        );
        let mut child = fake.cli().spawn(&WATCH).unwrap();
        assert_eq!(child.line(WAIT), Ok(Some("started".into())));
        // Its end waits for stderr's, so the line, logged as it is read, comes first.
        child.killer().kill();
        assert_eq!(child.exit(WAIT), Ok(None));
        assert_eq!(
            fake.log().lines(),
            [
                "harness hardware watch --json: notify: WRITE_FAILED",
                "harness hardware watch --json: killed by a signal"
            ]
        );
    }

    /// A stream that hands on each chunk it is sent, as one read, and ends once its sender is gone.
    struct Chunks(mpsc::Receiver<Vec<u8>>);

    impl Read for Chunks {
        fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
            let Ok(chunk) = self.0.recv() else { return Ok(0) };
            into[..chunk.len()].copy_from_slice(&chunk);
            Ok(chunk.len())
        }
    }

    #[test]
    fn the_replaced_line_is_found_across_reads_and_only_whole() {
        let (send, chunks) = mpsc::channel();
        let (done, ended) = mpsc::channel();
        let (logged, said) = mpsc::channel();
        tail(Chunks(chunks), done, move |line| logged.send(line.to_string()).unwrap());
        // Split across reads, and found before the stream ends.
        send.send(b"tabs str".to_vec()).unwrap();
        send.send(b"eam replaced\n".to_vec()).unwrap();
        assert_eq!(said.recv_timeout(WAIT), Ok("tabs stream replaced".into()));
        send.send(b"sound: DEVICE_".to_vec()).unwrap();
        send.send(b"OFFLINE\n".to_vec()).unwrap();
        assert_eq!(said.recv_timeout(WAIT), Ok("sound: DEVICE_OFFLINE".into()));
        send.send(b"notify: NO_".to_vec()).unwrap();
        send.send(b"ANSWER\n".to_vec()).unwrap();
        assert_eq!(said.recv_timeout(WAIT), Ok("notify: NO_ANSWER".into()));
        // A line that starts or ends with it, or holds it far into a long one, is not it.
        send.send(b"tabs stream replaced!\nx tabs stream replaced\n".to_vec()).unwrap();
        let long = [b"tabs stream replaced".repeat(400), b"\n".to_vec()].concat();
        send.send(long[..4096].to_vec()).unwrap();
        send.send(long[4096..].to_vec()).unwrap();
        // Held only to one byte past the longest code, a longer one is still too long.
        let long = [b"sound: ".to_vec(), b"A".repeat(8000), b"\n".to_vec()].concat();
        send.send(long[..4096].to_vec()).unwrap();
        send.send(long[4096..].to_vec()).unwrap();
        // The longest prefix's code one letter too long, not cut to one that fits.
        send.send([b"notify: ".to_vec(), b"A".repeat(33), b"\n".to_vec()].concat()).unwrap();
        send.send(b"tabs stream replaced\n".to_vec()).unwrap();
        drop(send);
        assert_eq!(ended.recv_timeout(WAIT), Ok(()));
        assert_eq!(said.try_iter().collect::<Vec<_>>(), ["tabs stream replaced"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_that_cannot_start_is_one_log_line() {
        let home = tempfile::tempdir().unwrap();
        // There, and not executable.
        let program = put(home.path().join("harness"));
        let log = Arc::new(MemoryLog::default());
        let cli = HarnessCli::new(find_cli(home.path(), None, Some(&program)).unwrap(), log.clone());
        let denied = Some(io::ErrorKind::PermissionDenied);
        assert_eq!(cli.run(&["auth", "status", "--json"], WAIT).err().map(|error| error.kind()), denied);
        assert_eq!(cli.spawn(&WATCH).err().map(|error| error.kind()), denied);
        assert_eq!(
            log.lines(),
            [
                "harness auth status --json: could not start: permission denied",
                "harness hardware watch --json: could not start: permission denied",
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_version_is_the_first_line_when_it_reads_as_one() {
        let longest = "1".repeat(32);
        let too_long = "1".repeat(33);
        let cases: [(&[&str], Option<&str>); 9] = [
            (&["0.6.58"], Some("0.6.58")),
            (&["  0.6.58-dev.3+a1  ", "more"], Some("0.6.58-dev.3+a1")),
            (&[&longest], Some(&longest)),
            (&[&too_long], None),
            (&["0.6.58 (node 24)"], None),
            (&["<b>0.6.58</b>"], None),
            (&["", "0.6.58"], None),
            (&[], None),
            (&["0.6.58", "@exit 1"], None),
        ];
        for (case, (lines, version)) in cases.into_iter().enumerate() {
            let fake = Fake::new();
            fake.script("--version", lines);
            assert_eq!(super::version(&fake.cli()).as_deref(), version, "case {case}");
            assert_eq!(fake.calls(), ["--version"], "case {case}");
        }
        // No script: the fake says `Unknown command` and exits 1.
        assert_eq!(super::version(&Fake::new().cli()), None);
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
        let unknown = cli.run(&["no", "such", "command"], WAIT).unwrap();
        assert_eq!((unknown.code, unknown.stderr.as_str()), (Some(1), "Unknown command\n"));
        assert_eq!(fake.calls(), ["auth status --json", "hardware watch --json", "no such command"]);
        let pids = fake.pids();
        assert_eq!(pids.len(), 3);
        assert!(pids[0] != pids[1] && pids[1] != pids[2]);
        assert_eq!(fake.ends(), ["auth status --json", "no such command"]);

        fake.script("login --json", &["@wait go", "after"]);
        let mut waiting = cli.spawn(&["login", "--json"]).unwrap();
        assert_eq!(waiting.line(Duration::from_millis(200)), Err(Timeout));
        fake.touch("go");
        assert_eq!(waiting.line(WAIT), Ok(Some("after".into())));
        assert_eq!(waiting.exit(WAIT), Ok(Some(0)));

        fake.script("login --json", &["@driver", "@wait never"]);
        let mut driven = cli.spawn(&["login", "--json"]).unwrap();
        driven.stdin_closer().close();
        assert_eq!(driven.line(WAIT), Ok(Some(CANCELLED.into())));
        assert_eq!(driven.line(WAIT), Ok(None));
        assert_eq!(driven.exit(WAIT), Ok(Some(1)));

        fake.script("login --json", &["@driver", "done"]);
        let mut finished = cli.spawn(&["login", "--json"]).unwrap();
        assert_eq!(finished.line(WAIT), Ok(Some("done".into())));
        assert_eq!(finished.line(WAIT), Ok(None));
        assert_eq!(finished.exit(WAIT), Ok(Some(0)));
    }

    /// A child on Windows, run with Windows' own programs.
    #[cfg(windows)]
    mod windows_children {
        use crate::child_windows::CREATION_FLAGS;
        use crate::cli::*;
        use crate::types::MemoryLog;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
        };

        const WAIT: Duration = Duration::from_secs(5);
        /// For a child's first line: PowerShell on a cold machine, and C# it compiles, take seconds.
        const FIRST_LINE: Duration = Duration::from_secs(60);
        /// Plenty for a process in a job that was ended to be gone.
        const GONE: Duration = Duration::from_secs(1);

        /// Starts its first argument outside the job it runs in, as harness-launch.exe starts the daemon, prints the
        /// pid it started (a CreateProcess error as a negative number), then waits. STARTUPINFOW and
        /// PROCESS_INFORMATION are bytes: 104 on 64-bit Windows with the size first, and 24 with the pid at 16.
        const BREAKS_AWAY: &str = r#"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Breakaway {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder line, IntPtr process, IntPtr thread, bool inherit,
        uint flags, IntPtr env, string folder, byte[] startup, byte[] started);

    public static int Start(string line) {
        var startup = new byte[104];
        startup[0] = 104;
        var started = new byte[24];
        // CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW
        if (!CreateProcessW(null, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, false, 0x09000000, IntPtr.Zero,
                null, startup, started)) {
            return -Marshal.GetLastWin32Error();
        }
        return BitConverter.ToInt32(started, 16);
    }
}
'@
[Console]::Out.WriteLine([Breakaway]::Start($args[0]))
Start-Sleep 600
"#;

        /// A program of Windows' own, by its full path, so no PATH puts another first.
        fn system32(parts: &[&str]) -> PathBuf {
            let mut path = PathBuf::from(env::var_os("SystemRoot").expect("SystemRoot")).join("System32");
            path.extend(parts);
            path
        }

        fn powershell_exe() -> PathBuf {
            system32(&["WindowsPowerShell", "v1.0", "powershell.exe"])
        }

        /// `cmd /C line`, the line as written: cmd reads its own command line.
        fn cmd(line: &str) -> Command {
            let mut command = Command::new(system32(&["cmd.exe"]));
            command.arg("/C").raw_arg(line);
            command
        }

        fn powershell(script: &str) -> Command {
            let mut command = Command::new(powershell_exe());
            command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
            command
        }

        fn start(command: Command) -> Child {
            Child::start(command, "child".into(), Arc::new(MemoryLog::default())).unwrap()
        }

        /// The next line, without the `\r` Windows' programs end it with.
        fn next(child: &mut Child, wait: Duration) -> String {
            child.line(wait).expect("a line in time").expect("a line").trim_end().to_string()
        }

        /// The process a child printed the pid of, held open so the pid is never another's while the test looks.
        fn process(pid: &str) -> OwnedHandle {
            let pid: u32 = pid.parse().unwrap_or_else(|_| panic!("a pid: {pid}"));
            // SAFETY: OpenProcess only opens a handle, which OwnedHandle closes.
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
            assert!(!handle.is_null(), "{pid}: {}", io::Error::last_os_error());
            // SAFETY: a new handle, which nothing else owns.
            unsafe { OwnedHandle::from_raw_handle(handle) }
        }

        /// Whether the process is gone, or goes within `wait`.
        fn gone_within(process: &OwnedHandle, wait: Duration) -> bool {
            // SAFETY: the handle is open while `process` lives.
            unsafe { WaitForSingleObject(process.as_raw_handle(), wait.as_millis() as u32) == WAIT_OBJECT_0 }
        }

        #[test]
        fn the_flags_hide_the_console() {
            // CREATE_NO_WINDOW: a console no one sees, which the console programs the child starts share.
            assert_ne!(CREATION_FLAGS & 0x0800_0000, 0);
            // Never DETACHED_PROCESS: with no console at all, each console program the child starts shows one.
            assert_eq!(CREATION_FLAGS & 0x0000_0008, 0);
        }

        #[test]
        fn a_run_gives_its_code_and_its_lines_in_order() {
            let mut lines = Vec::new();
            let output =
                run_lines(cmd("echo a& echo b& exit 3"), WAIT, &mut |line| lines.push(line.trim_end().to_string()))
                    .unwrap();
            assert_eq!(lines, ["a", "b"]);
            assert_eq!((output.code, output.timed_out), (Some(3), false));
        }

        #[test]
        fn a_run_past_its_deadline_has_no_code() {
            let started = Instant::now();
            let output = run(powershell("Start-Sleep 60"), Duration::from_secs(2)).unwrap();
            assert!(output.timed_out);
            assert_eq!(output.code, None);
            assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
        }

        /// A child that prints its pid and the pid of a process it started, then waits, is ended by `end`: then
        /// neither is left.
        fn ends_with_what_it_started(end: impl FnOnce(&Killer)) {
            let mut child = start(powershell(concat!(
                "$started = Start-Process -PassThru -NoNewWindow $env:ComSpec '/C ping -n 600 127.0.0.1 >NUL'; ",
                "[Console]::Out.WriteLine($PID); [Console]::Out.WriteLine($started.Id); Start-Sleep 600",
            )));
            let both = [next(&mut child, FIRST_LINE), next(&mut child, WAIT)].map(|pid| process(&pid));
            end(&child.killer());
            assert_eq!(child.exit(WAIT), Ok(None));
            for process in &both {
                assert!(gone_within(process, WAIT));
            }
        }

        #[test]
        fn a_kill_ends_the_child_and_what_it_started() {
            ends_with_what_it_started(|killer| killer.kill());
            // Windows has no SIGTERM: a stop ends them at once, whatever the grace.
            ends_with_what_it_started(|killer| killer.stop(Duration::from_secs(600)));
        }

        #[test]
        fn a_killed_child_has_no_code() {
            let mut child = start(cmd("ping -n 600 127.0.0.1 >NUL"));
            child.killer().kill();
            assert_eq!(child.exit(WAIT), Ok(None));
        }

        #[test]
        fn a_process_that_broke_away_outlives_the_kill() {
            let folder = tempfile::tempdir().unwrap();
            let script = folder.path().join("breaks-away.ps1");
            fs::write(&script, BREAKS_AWAY).unwrap();
            let mut command = Command::new(powershell_exe());
            command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
            command.arg(&script).arg(format!("{} -n 600 127.0.0.1", system32(&["ping.exe"]).display()));
            let mut child = start(command);
            let away = process(&next(&mut child, FIRST_LINE));
            child.killer().kill();
            assert_eq!(child.exit(WAIT), Ok(None));
            let outlived = !gone_within(&away, GONE);
            // SAFETY: the handle is open, with the right to end it.
            unsafe { TerminateProcess(away.as_raw_handle(), 1) };
            assert!(outlived);
        }

        #[test]
        fn a_writer_never_waits_on_a_child_that_reads_nothing() {
            let mut child = start(cmd("ping -n 600 127.0.0.1 >NUL"));
            let writer = child.stdin_writer();
            // On a thread, so a write that waits fails the test instead of hanging it.
            let (send, dropped) = mpsc::channel();
            thread::spawn(move || {
                let line = "x".repeat(100);
                // 1 MB, past any pipe's buffer.
                let _ = send.send((0..10_000).find_map(|_| writer.line(&line).err()));
            });
            assert_eq!(dropped.recv_timeout(Duration::from_secs(10)), Ok(Some(Unwritten::Full)));
            // The closer is not held up either.
            assert!(child.stdin_closer().close());
            child.killer().kill();
            assert_eq!(child.exit(WAIT), Ok(None));
        }

        #[test]
        fn closing_stdin_ends_a_child_that_reads_it() {
            // It prints what it read, as it was, once its stdin has ended.
            let mut child = start(powershell("[Console]::Out.Write([Console]::In.ReadToEnd())"));
            let writer = child.stdin_writer();
            assert_eq!(writer.line("a"), Ok(()));
            assert_eq!(writer.line("b"), Ok(()));
            assert!(child.stdin_closer().close());
            assert_eq!([next(&mut child, FIRST_LINE), next(&mut child, WAIT)], ["a", "b"]);
            assert_eq!(child.line(WAIT), Ok(None));
            assert_eq!(child.exit(WAIT), Ok(Some(0)));
        }
    }
}
