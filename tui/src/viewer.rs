//! A harness's graphics live in the user's browser. SSH returns an authenticated web-app
//! destination; only the invoking terminal process may launch a local browser.

use std::io::IsTerminal;
use std::process::Stdio;
use std::time::Duration;
use tokio_tungstenite::tungstenite::http::Uri;

use crate::{app::App, fleet::Agent};

pub const USAGE: &str = "usage: hn view [-pcw] [-t harness]";

#[derive(Default, Debug)]
pub struct Options { pub print: bool, pub copy: bool, pub web: bool, pub target: Option<String> }
impl Options {
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut out = Self::default();
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "-t" => out.target = Some(args.next().filter(|s| !s.is_empty()).ok_or(USAGE)?.clone()),
                "-p" | "--print" => out.print = true,
                "-c" | "--copy" => out.copy = true,
                "-w" | "--web" => out.web = true,
                _ if arg.starts_with('-') && arg.len() > 1 && arg[1..].chars().all(|c| "pcw".contains(c)) => {
                    out.print |= arg.contains('p'); out.copy |= arg.contains('c'); out.web |= arg.contains('w');
                }
                _ => return Err(USAGE.into()),
            }
        }
        Ok(out)
    }
}

fn valid_url(value: &str) -> bool {
    if value.chars().any(|c| c.is_control() || c.is_whitespace()) || value.contains('\\') { return false }
    let Ok(uri) = value.split('#').next().unwrap_or("").parse::<Uri>() else { return false };
    matches!(uri.scheme_str(), Some("http" | "https")) && uri.host().is_some_and(|h| !h.is_empty())
        && !uri.authority().is_some_and(|a| a.as_str().contains('@'))
}

fn encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { out.push(b as char) }
        else { use std::fmt::Write; let _ = write!(out, "%{b:02X}"); }
    }
    out
}

pub fn web_link(base: &str, machine: &str, agent: &str) -> Result<String, String> {
    if !valid_url(base) || base.contains(['?', '#']) || machine.is_empty() || agent.is_empty() {
        return Err("the daemon has no browser address — update Harness on this machine".into())
    }
    let uri: Uri = base.parse().map_err(|_| "invalid browser address")?;
    if uri.path() != "/" && !uri.path().is_empty() {
        return Err("the daemon browser address must point to the website root".into())
    }
    if uri.scheme_str() != Some("https") && !matches!(uri.host(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1")) {
        return Err("the browser address must use HTTPS (HTTP is allowed for localhost development)".into())
    }
    Ok(format!("{}/?viewer=1&machine={}&agent={}", base.trim_end_matches('/'), encode(machine), encode(agent)))
}

pub fn destination(agent: &Agent, local: &str, web: &str, remote: bool) -> Result<String, String> {
    if agent.viewer_url.is_empty() && agent.viewer_name.is_empty() {
        return Err(if agent.viewer_error.is_empty() { "this harness has no viewer".into() } else { agent.viewer_error.clone() })
    }
    // A peer's loopback URL is owned by a particular daemon connection and can disappear when
    // that connection closes. Use the browser's own authenticated connection for every peer.
    if !remote && agent.machine_id == local && !agent.viewer_url.is_empty() {
        if !valid_url(&agent.viewer_url) { return Err("the harness returned an invalid viewer address".into()) }
        return Ok(agent.viewer_url.clone())
    }
    web_link(web, &agent.machine_id, &agent.id)
}

pub fn ssh() -> bool {
    ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
}

async fn open(url: &str) -> bool {
    if !valid_url(url) || ssh() { return false }
    if cfg!(target_os = "linux") && ["DISPLAY", "WAYLAND_DISPLAY"].iter().all(|k| std::env::var_os(k).is_none_or(|v| v.is_empty())) { return false }
    let mut command = tokio::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" });
    let Ok(mut child) = command.arg(url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).spawn() else { return false };
    matches!(tokio::time::timeout(Duration::from_secs(5), child.wait()).await, Ok(Ok(status)) if status.success())
}

pub fn show(app: &mut App, key: (String, String), options: Options) {
    let Some(agent) = app.fleet.agent(&key.0, &key.1) else { return app.error("can't find harness") };
    let url = match destination(agent, &app.fleet.local_id, &app.viewer_web_url, options.web || options.copy || (app.capture.is_none() && ssh())) {
        Ok(url) => url, Err(e) => return app.error(e),
    };
    if app.capture.is_some() || options.print { app.print("Viewer", vec![url]); return }
    if options.copy {
        crate::clipboard::store(&url);
        app.say("Viewer link sent to the terminal clipboard", crate::theme::ONLINE);
        return
    }
    if ssh() { show_link(app, &url); return }
    app.spawn(async move { let opened = open(&url).await; (url, opened) }, |app, (url, opened)| {
        if opened { app.say("Opened viewer in your browser", crate::theme::ONLINE) } else { show_link(app, &url) }
    });
}

fn show_link(app: &mut App, url: &str) {
    app.print("Viewer", vec!["Open this link in your browser:".into(), url.into(), String::new(), "Use :view -c to copy the browser link. Sign in and link this machine if asked.".into()]);
}

pub async fn cli(port: u16, args: &[String], socket: Option<&str>, name: Option<&str>) -> i32 {
    if args == ["--help"] || args == ["-h"] { println!("{USAGE}\nOpen the current harness's viewer. Over SSH, prints a browser link.\n-p  Print only   -c  Copy browser link   -w  Use authenticated browser app"); return 0 }
    let options = match Options::parse(args) { Ok(o) => o, Err(e) => { eprintln!("{e}"); return 2 } };
    let remote = options.web || options.copy || ssh();
    let result = if crate::ipc::alive(socket, name) {
        let Some(path) = crate::ipc::chosen(socket, name) else { eprintln!("hn: no client running"); return 1 };
        let mut words = vec!["open-viewer".into(), "-p".into()];
        if remote { words.push("-w".into()) }
        if let Some(t) = &options.target { words.extend(["-t".into(), t.clone()]) }
        match tokio::task::spawn_blocking(move || crate::ipc::ask(&path, &words)).await {
            Ok(Some((out, err, 0))) if err.is_empty() && out.len() == 1 => Ok(out[0].clone()),
            Ok(Some((_, err, _))) => Err(err.join("\n")),
            _ => Err("could not reach the hn client".into()),
        }
    } else { standalone(port, &options, remote).await };
    let url = match result { Ok(url) if valid_url(&url) => url, Ok(_) => { eprintln!("hn: invalid viewer address"); return 1 }, Err(e) => { eprintln!("hn: {e}"); return 1 } };
    if options.copy && std::io::stdout().is_terminal() { crate::clipboard::store(&url) }
    if !options.print && !options.copy && !ssh() && open(&url).await { return 0 }
    // Plain output remains usable with any terminal and in scripts; terminal apps can recognize
    // the URL without an OSC extension. Never start a browser process on an SSH host.
    println!("{url}");
    if !options.print && !options.copy { eprintln!("Open this link in your browser. Sign in and link the machine if asked.") }
    0
}

async fn standalone(port: u16, options: &Options, remote: bool) -> Result<String, String> {
    let target = options.target.as_deref().ok_or("no current hn pane — use hn view -t <harness>")?;
    let status = crate::daemon::http_json(port, "GET", "/api/status", None).await.map_err(|_| "the daemon is not running — harness start")?;
    let (local, machines) = crate::cli::machines(port).await?;
    let mut all = Vec::new();
    for (id, name, online) in machines {
        if !online { continue }
        let wanted = match target.split_once(':') {
            Some((m, a)) if m == id || m == name => a,
            Some(_) => continue,
            None => target,
        };
        for agent in crate::cli::roster(port, &id).await {
            let exact = agent.id == wanted || agent.name == wanted;
            if exact || agent.name.starts_with(wanted) { all.push((exact, agent)) }
        }
    }
    if all.iter().any(|(exact, _)| *exact) { all.retain(|(exact, _)| *exact) }
    match all.as_slice() {
        [(_, agent)] => destination(agent, &local, status.get("webUrl").and_then(serde_json::Value::as_str).unwrap_or(""), remote),
        [] => Err(format!("can't find harness: {target}")),
        _ => Err(format!("more than one harness: {target} — use -t machine:agent-id")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn addresses_are_data_and_ssh_never_uses_remote_loopback() {
        let a = crate::fleet::agent_from("remote", &json!({"id":"a /?&é", "viewerUrl":"http://127.0.0.1:19777/?file=model.glb", "viewerName":"3D Viewer"}), None);
        assert_eq!(destination(&a, "remote", "https://harness.example", false).unwrap(), a.viewer_url);
        let expected = "https://harness.example/?viewer=1&machine=remote&agent=a%20%2F%3F%26%C3%A9";
        assert_eq!(destination(&a, "remote", "https://harness.example/", true).unwrap(), expected);
        assert_eq!(destination(&a, "local", "https://harness.example", false).unwrap(), expected);
        for url in ["javascript:alert(1)", "file:///tmp/a", "https://a\nInjected", "https://user:pass@host/", "https://a/\\x", "https://a/a b"] { assert!(!valid_url(url), "{url}") }
        assert!(web_link("http://example.com", "m", "a").is_err());
        assert!(web_link("http://127.0.0.1:19778", "m", "a").is_ok());
        assert!(web_link("https://harness.example?x=1", "m", "a").is_err());
        assert!(web_link("https://harness.example/workspace", "m", "a").is_err());
        for base in ["http://localhost:19682", "http://[::1]:19682", "https://harness.example/"] {
            assert!(web_link(base, "m", "a").is_ok(), "{base}");
        }
        for base in ["", "https://", "https://harness.example/#token", "https://user@host", "file:///tmp/test", "--help"] {
            assert!(web_link(base, "m", "a").is_err(), "{base}");
        }
    }
    #[test]
    fn no_viewer_is_an_error_and_waiting_viewer_gets_its_own_page() {
        let mut a = crate::fleet::agent_from("m", &json!({"id":"a"}), None);
        assert!(destination(&a, "m", "https://harness.example", false).is_err());
        a.viewer_name = "3D Viewer".into();
        assert_eq!(destination(&a, "m", "https://harness.example", false).unwrap(), "https://harness.example/?viewer=1&machine=m&agent=a");
        assert!(Options::parse(&["--unknown".into()]).is_err());
        assert!(Options::parse(&["-t".into()]).is_err());
        let o = Options::parse(&["-pcw".into(), "-t".into(), "name with spaces".into()]).unwrap();
        assert!(o.print && o.copy && o.web);
        assert_eq!(o.target.as_deref(), Some("name with spaces"));
    }
}
