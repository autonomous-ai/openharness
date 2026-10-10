//! Copy to the clipboard of the computer the person is sitting at — which, over SSH, is not this
//! one. OSC 52 asks the outer terminal to do it; sitting at this computer, its own clipboard is set
//! too, because a terminal may refuse OSC 52: iTerm2 does unless "Applications in terminal may access
//! clipboard" is on, and it is off by default — a copy said "Copied" and left nothing to paste [run].

use std::io::Write;
use std::process::{Command, Stdio};

pub fn store(text: &str) { store_as("c", text) }

/// OSC 52 with its selection parameter as given (set-buffer -w sends none, as tmux's), and this
/// computer's clipboard when the person is at it.
pub fn store_as(which: &str, text: &str) {
    let encoded = base64(text.as_bytes());
    let mut out = std::io::stdout();
    let _ = write!(out, "\x1b]52;{which};{encoded}\x07");
    let _ = out.flush();
    // (Never in a test: it would be the developer's own clipboard.)
    if !cfg!(test) && (which.is_empty() || which.contains('c')) && at_this_computer(|k| std::env::var_os(k).is_some()) {
        let text = text.to_string();
        // Off the drawing thread: a clipboard tool waits on the window system.
        std::thread::spawn(move || { system_store(&text); });
    }
}

/// Whether the person is at this computer rather than reaching it over SSH, whose clipboard is the
/// other end's — OSC 52's alone. [set]: whether an environment variable is set.
fn at_this_computer(set: impl Fn(&str) -> bool) -> bool { !["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].iter().any(|k| set(k)) }

/// The tools that set this computer's clipboard, in the order tried: macOS's own, else Wayland's or X's
/// for the session there is ([set]: whether an environment variable is set).
fn clipboard_tools(set: impl Fn(&str) -> bool) -> Vec<(&'static str, &'static [&'static str])> {
    if cfg!(target_os = "macos") { return vec![("pbcopy", &[])] }
    let mut tools = Vec::new();
    if set("WAYLAND_DISPLAY") { tools.push(("wl-copy", &[][..])) }
    if set("DISPLAY") { tools.push(("xclip", &["-selection", "clipboard"][..])); tools.push(("xsel", &["--clipboard", "--input"][..])) }
    tools
}

/// [text] on this computer's clipboard through the first tool there is; true when one took it.
fn system_store(text: &str) -> bool {
    for (tool, args) in clipboard_tools(|k| std::env::var_os(k).is_some()) {
        let Ok(mut child) = Command::new(tool).args(args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { continue };
        if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(text.as_bytes()); }
        if child.wait().is_ok_and(|s| s.success()) { return true }
    }
    false
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes() { assert_eq!(super::base64(b"hello"), "aGVsbG8="); }

    #[test]
    fn sets_this_computers_clipboard_only_when_the_person_is_at_it() {
        assert!(super::at_this_computer(|_| false));
        for over_ssh in ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] { assert!(!super::at_this_computer(|k| k == over_ssh), "{over_ssh}") }
    }

    #[test]
    fn picks_the_clipboard_tool_for_the_session() {
        let tools = |vars: &[&str]| super::clipboard_tools(|k| vars.contains(&k)).into_iter().map(|(t, _)| t).collect::<Vec<_>>();
        if cfg!(target_os = "macos") { assert_eq!(tools(&[]), vec!["pbcopy"]); return }
        assert!(tools(&[]).is_empty(), "no window system: OSC 52 alone");
        assert_eq!(tools(&["WAYLAND_DISPLAY"]), vec!["wl-copy"]);
        assert_eq!(tools(&["DISPLAY"]), vec!["xclip", "xsel"]);
    }
}
