//! harness.exe, the `harness` command on Windows (harness_pty::command). A console program: it runs the CLI in the
//! caller's console and exits with its exit code.

fn main() {
    std::process::exit(harness_pty::command::run(std::env::current_exe(), std::env::args_os().skip(1).collect()));
}
