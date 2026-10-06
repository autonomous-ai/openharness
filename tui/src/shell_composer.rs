//! Literal shell-line completion and per-invocation context. Never evaluates a draft.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::ops::Range;

pub fn engine(command: &str) -> Option<&str> {
    let name = match command {
        "cursor-agent" => "cursor",
        "cmd" => "commandcode",
        other => other,
    };
    crate::modal::ENGINES
        .contains(&name)
        .then_some(name)
        .filter(|s| *s != "terminal")
}
pub fn command(engine: &str) -> &str {
    match engine {
        "cursor" => "cursor-agent",
        "commandcode" => "cmd",
        other => other,
    }
}

#[derive(Clone, Debug)]
struct Word {
    span: Range<usize>,
    value: String,
}
// A deliberately literal subset. Expansions, pipelines, redirects, command
// substitutions and comments keep ordinary shell behavior; we never parse/eval them.
fn words(line: &str) -> Option<Vec<Word>> {
    let mut out = Vec::new();
    let mut iter = line.char_indices().peekable();
    while let Some(&(start, c)) = iter.peek() {
        if c.is_whitespace() {
            iter.next();
            continue;
        }
        let mut value = String::new();
        let mut quote = None;
        let mut end = start;
        while let Some(&(at, c)) = iter.peek() {
            if quote.is_none() && c.is_whitespace() {
                break;
            }
            iter.next();
            end = at + c.len_utf8();
            match (quote, c) {
                (Some('\''), '\'') | (Some('"'), '"') => quote = None,
                (Some('\''), _) => value.push(c),
                (None, '\'' | '"') => quote = Some(c),
                (_, '\\') => {
                    let (at, c) = iter.next()?;
                    end = at + c.len_utf8();
                    value.push(c);
                }
                (_, '$' | '`')
                | (None, ';' | '|' | '&' | '<' | '>' | '(' | ')' | '#' | '\n' | '\r') => {
                    return None;
                }
                _ => value.push(c),
            }
        }
        out.push(Word {
            span: start..end,
            value,
        });
    }
    Some(out)
}
pub fn quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || "@:/._~%+=,-".contains(c))
    {
        value.into()
    } else {
        crate::shell_context::quote(value)
    }
}

/// Like a file-completion widget, insert a literal directory into an ordinary
/// command. Never interpret the draft or mistake it for an agent invocation.
pub fn insert_folder(line: &str, cursor: usize, value: &str) -> Result<(String, usize), String> {
    if line.len() > 24000 || line.chars().any(char::is_control) || value.chars().any(char::is_control) {
        return Err("This command cannot be completed.".into());
    }
    let path = if value == "~" || value.starts_with("~/") {
        format!("{}{}", std::env::var("HOME").map_err(|_| "Home folder is unavailable.")?, &value[1..])
    } else { value.into() };
    if !path.starts_with('/') {return Err("Choose an absolute folder path.".into())}
    let at = line.char_indices().nth(cursor).map(|(i,_)|i).unwrap_or(line.len());
    let (before, after) = line.split_at(at);
    let (mut quote, mut escaped) = (None, false);
    for c in before.chars() {
        if escaped {escaped=false;continue}
        match (quote,c) {
            (Some('\''),'\'') | (Some('"'),'"') => quote=None,
            (Some('\''),_) => {},
            (_, '\\') => escaped=true,
            (None, '\''|'"') => quote=Some(c),
            _ => {},
        }
    }
    if escaped {return Err("Finish the escape before inserting a folder.".into())}
    let inserted = match quote {
        Some('\'') => path.replace('\'', "'\\''"),
        Some('"') => path.replace('\\', "\\\\").replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`"),
        _ => format!("{}{}{}",
            if !before.is_empty() && !before.ends_with(char::is_whitespace) {" "} else {""},
            crate::shell_context::quote(&path),
            if after.starts_with(char::is_whitespace) {""} else {" "}),
    };
    let cursor = before.chars().count() + inserted.chars().count();
    Ok((format!("{before}{inserted}{after}"), cursor))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Launch {
    pub engine: String,
    pub host: Option<String>,
    pub path: Option<String>,
    pub model: Option<String>,
    pub args: Vec<String>,
    pub cwd: String,
}
impl Launch {
    pub fn parse(agent: &str, args: &[String]) -> Result<Self, String> {
        let Some(agent) = engine(agent) else {
            return Err("Choose a supported agent.".into());
        };
        let mut launch = Self {
            engine: agent.into(),
            ..Self::default()
        };
        let mut native = false;
        let mut value = false;
        for arg in args {
            if value {
                launch.args.push(arg.clone());
                value = false;
                continue;
            }
            if arg == "--" {
                native = true;
                launch.args.push(arg.clone());
                continue;
            }
            if !native {
                if let Some(value) = arg.strip_prefix('@') {
                    let (host, path) = value
                        .split_once(':')
                        .map(|(h, p)| (h, Some(p)))
                        .unwrap_or((value, None));
                    if host.is_empty() {
                        return Err("Choose a computer after @.".into());
                    }
                    if launch.host.replace(host.into()).is_some() {
                        return Err("Use one @computer per command.".into());
                    }
                    if let Some(path) = path {
                        set_path(&mut launch, path)?;
                    }
                    continue;
                }
                if let Some(path) = arg.strip_prefix(':') {
                    set_path(&mut launch, path)?;
                    continue;
                }
                if let Some(model) = arg.strip_prefix('%') {
                    if model.is_empty() {
                        return Err("Choose a model after %.".into());
                    }
                    if launch.model.replace(model.into()).is_some() {
                        return Err("Use one %model per command.".into());
                    }
                    continue;
                }
            }
            launch.args.push(arg.clone());
            // Values of native options are never Harness selectors. Unknown
            // options can use --key=value or the explicit -- passthrough boundary.
            value = !native && native_value_option(arg);
        }
        if args.len() > 256
            || args.iter().map(String::len).sum::<usize>() > 24000
            || args.iter().any(|s| s.contains('\0'))
        {
            return Err("This command is too long.".into());
        }
        if launch.model.is_some() && has_native_model(&launch.engine, &launch.args) {
            return Err(
                "Choose either %model or native model/profile options for this command.".into(),
            );
        }
        Ok(launch)
    }
}
fn native_value_option(arg: &str) -> bool {
    [
        "--model",
        "-m",
        "--profile",
        "--provider",
        "--local-provider",
        "--config",
        "-c",
        "--settings",
        "--prompt",
        "-p",
        "--resume",
        "-r",
        "--permission-mode",
        "--sandbox",
        "--agent",
        "--session",
        "--output-format",
        "--input-format",
        "--add-dir",
        "--cd",
        "-C",
    ]
    .contains(&arg)
}
fn set_path(launch: &mut Launch, path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Choose a folder after :.".into());
    }
    if launch.path.replace(path.into()).is_some() {
        return Err("Use one folder per command.".into());
    }
    Ok(())
}
pub fn has_native_model(engine: &str, args: &[String]) -> bool {
    args.iter().take_while(|s| s.as_str() != "--").any(|s| {
        [
            "--model",
            "-m",
            "--profile",
            "--provider",
            "--oss",
            "--local-provider",
            "--config",
            "-c",
            "--settings",
        ]
        .iter()
        .any(|key| s == key || s.starts_with(&format!("{key}=")))
            || s.starts_with("-m") && s.len() > 2
            || engine == "codex" && (s == "-p" || s.starts_with("-p") && s.len() > 2)
    })
}

#[derive(Clone, Debug)]
pub struct Draft {
    pub line: String,
    pub cursor: usize,
    words: Vec<Word>,
    active: Option<usize>,
    pub launch: Launch,
}
impl Draft {
    pub fn new(line: &str, cursor: usize) -> Option<Self> {
        if line.len() > 24000 || line.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
            return None;
        }
        let words = words(line)?;
        let at = line
            .char_indices()
            .nth(cursor)
            .map(|(n, _)| n)
            .unwrap_or(line.len());
        let active = words
            .iter()
            .position(|w| w.span.start <= at && at <= w.span.end);
        let first = words.first().map(|w| w.value.as_str()).unwrap_or("");
        let known = engine(first);
        let partial = words.len() <= 1
            && crate::modal::ENGINES
                .iter()
                .filter(|e| **e != "terminal")
                .any(|e| command(e).starts_with(first));
        let selectors = first.starts_with(['@', ':', '%']);
        if !first.is_empty() && known.is_none() && !partial && !selectors {
            return None;
        }
        // Context collection tolerates the incomplete word being completed.
        let argv = words
            .iter()
            .skip(usize::from(!selectors))
            .filter(|w| w.value != "@" && w.value != ":" && w.value != "%")
            .map(|w| w.value.trim_end_matches(':').to_string())
            .collect::<Vec<_>>();
        let launch = Launch::parse(known.unwrap_or("codex"), &argv).unwrap_or_else(|_| Launch {
            engine: known.unwrap_or("").into(),
            ..Launch::default()
        });
        Some(Self {
            line: line.into(),
            cursor: at,
            words,
            active,
            launch,
        })
    }
    pub fn initial(&self) -> String {
        if self.words.is_empty() {
            return String::new();
        }
        if self.active == Some(0) && !self.words[0].value.starts_with(['@', ':', '%']) {
            return format!("&{}", self.words[0].value);
        }
        if let Some(word) = self.active.map(|i| &self.words[i]) {
            if let Some((_, path)) = word.value.strip_prefix('@').and_then(|s| s.split_once(':')) {
                return format!(":{path}");
            }
            if word.value.starts_with(['@', ':', '%']) {
                return word.value.clone();
            }
        }
        String::new()
    }
    pub fn has_agent(&self) -> bool {
        self.words
            .first()
            .is_some_and(|w| engine(&w.value).is_some())
    }
    pub fn automatic(&self) -> bool {
        let Some(active) = self.active.filter(|i| *i > 0) else {
            return false;
        };
        let word = &self.words[active];
        if !self.has_agent()
            || self.cursor != word.span.end
            || self.line[word.span.clone()] != word.value
            || !(matches!(word.value.as_str(), "@" | ":" | "%")
                || word.value.starts_with('@')
                    && word.value.ends_with(':')
                    && word.value.matches(':').count() == 1)
        {
            return false;
        }
        let mut value = false;
        for word in &self.words[1..active] {
            if value {
                value = false;
                continue;
            }
            if word.value == "--" {
                return false;
            }
            if !word.value.starts_with(['@', ':', '%', '-']) {
                return false;
            }
            value = native_value_option(&word.value);
        }
        !value
    }
    /// The query is an inline edit of the selector that opened suggestions.
    /// Deleting that selector removes only its trigger from the shell draft;
    /// in `@office:` this leaves the already chosen computer intact.
    pub fn erase_automatic_trigger(&self) -> Option<(String, usize)> {
        if !self.automatic() { return None }
        let at = self.cursor.checked_sub(1)?;
        let mut line = self.line.clone();
        line.remove(at); // automatic() guarantees an ASCII @, : or % here.
        let cursor = line[..at].chars().count();
        Some((line, cursor))
    }
    pub fn metadata(&self) -> Value {
        json!({"host":self.launch.host,"engine":if self.has_agent() { self.launch.engine.as_str() } else { "" },"cwd":std::env::current_dir().ok().map(|p|p.to_string_lossy().into_owned())})
    }
    pub fn change_host(&self, value: &str) -> Result<(String, usize), String> {
        self.apply_context("host", value, true)
    }
    pub fn apply(&self, kind: &str, value: &str) -> Result<(String, usize), String> {
        self.apply_context(kind, value, false)
    }
    // Native option values and everything after -- are literal arguments, even
    // when they start with a selector character.
    fn selectors(&self) -> Vec<usize> {
        let mut indices = Vec::new();
        let mut value = false;
        for (i, word) in self.words.iter().enumerate() {
            if value { value = false; continue }
            if word.value == "--" { break }
            if word.value.starts_with(['@', ':', '%']) { indices.push(i); }
            value = native_value_option(&word.value);
        }
        indices
    }
    fn apply_context(&self, kind: &str, value: &str, clear_folder: bool) -> Result<(String, usize), String> {
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err("Invalid completion.".into());
        }
        if kind == "agent" && engine(value).is_none() {
            return Err("Choose a supported agent.".into());
        }
        let mut edits: Vec<(Range<usize>, String)> = Vec::new();
        let selectors = self.selectors();
        let matching = |w: &Word| match kind {
            "host" => w.value.starts_with('@'),
            "folder" => {
                w.value.starts_with(':') || w.value.starts_with('@') && w.value.contains(':')
            }
            "model" => w.value.starts_with('%'),
            _ => false,
        };
        let boundary = self
            .words
            .iter()
            .position(|w| w.value == "--")
            .unwrap_or(self.words.len());
        let target = if kind == "agent" {
            self.words
                .first()
                .filter(|w| !w.value.starts_with(['@', ':', '%']))
                .map(|_| 0)
        } else {
            selectors.iter().copied().find(|i| matching(&self.words[*i]))
                // Replace a standalone old folder with the new machine when
                // no @ word exists; never insert into the word being removed.
                .or_else(|| clear_folder.then(|| selectors.iter().copied()
                    .find(|i| self.words[*i].value.starts_with(':'))).flatten())
        };
        let existing = target.map(|i| &self.words[i]);
        let text = match kind {
            "agent" => command(engine(value).unwrap()).to_string(),
            "host" => format!(
                "@{value}{}",
                existing
                    .filter(|_| !clear_folder)
                    .and_then(|w| w.value.split_once(':'))
                    .map(|(_, p)| format!(":{p}"))
                    .unwrap_or_default()
            ),
            "folder" => format!(
                "{}:{value}",
                existing
                    .filter(|w| w.value.starts_with('@'))
                    .and_then(|w| w.value.split_once(':'))
                    .map(|(h, _)| h)
                    .unwrap_or("")
            ),
            "model" => format!("%{value}"),
            _ => return Err("Unknown completion.".into()),
        };
        let at = if let Some(w) = existing {
            w.span.clone()
        } else if kind == "agent" {
            0..0
        } else {
            let cursor = self
                .words
                .get(boundary)
                .map(|w| w.span.start.min(self.cursor))
                .unwrap_or(self.cursor);
            cursor..cursor
        };
        let lead = if at.start > 0 && !self.line[..at.start].ends_with(char::is_whitespace) {
            " "
        } else {
            ""
        };
        let tail = if self.line[at.end..].starts_with(char::is_whitespace) {
            ""
        } else {
            " "
        };
        let replacement = format!("{lead}{}{tail}", quote(&text));
        // A newly chosen field replaces its earlier occurrence, not a duplicate.
        for &i in &selectors {
            let w = &self.words[i];
            if Some(i) != target && (matching(w) || clear_folder && w.value.starts_with(':')) {
                let end = self.words.get(i + 1).map(|w| w.span.start).unwrap_or(self.line.len());
                edits.push((w.span.start..end, String::new()));
            }
        }
        edits.push((at.clone(), replacement.clone()));
        edits.sort_by_key(|(r, _)| r.start);
        let mut output = String::new();
        let mut offset = 0;
        let mut cursor = 0;
        for (span, text) in edits {
            output.push_str(&self.line[offset..span.start]);
            output.push_str(&text);
            if span == at {
                cursor = output.chars().count();
            }
            offset = span.end;
        }
        output.push_str(&self.line[offset..]);
        // Continue composing at the end when a choice was inserted ahead of the
        // existing selectors. Editing an existing word in the middle stays there.
        if (kind == "agent" && target.is_none())
            || (self.cursor == self.line.len() && at.end < self.line.len())
        {
            if !output.ends_with(char::is_whitespace) {
                output.push(' ');
            }
            cursor = output.chars().count();
        }
        Ok((output, cursor))
    }
}

pub fn run(args: &[String]) -> std::io::Result<i32> {
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    let Some(agent) = args.first() else {
        return Err(std::io::Error::other("Choose an agent."));
    };
    let mut launch = Launch::parse(agent, &args[1..]).map_err(std::io::Error::other)?;
    launch.cwd = std::env::current_dir()?.to_string_lossy().into_owned();
    let plan = crate::shell_picker::exchange("compose-launch", &serde_json::to_value(&launch)?)?;
    if plan["attached"] == true {
        if let Some(message) = plan["message"].as_str().filter(|s| !s.is_empty()) {
            eprintln!("{message}");
        }
        return Ok(0);
    }
    let raw = plan["cwd"]
        .as_str()
        .ok_or_else(|| std::io::Error::other("Invalid launch response."))?;
    let cwd = if raw == "~" || raw.starts_with("~/") {
        format!("{}{}", std::env::var("HOME").unwrap_or_default(), &raw[1..])
    } else {
        raw.into()
    };
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(std::io::Error::other(
            "That folder does not exist on this computer. The command was not started.",
        ));
    }
    let args: Vec<String> = serde_json::from_value(plan["args"].clone())?;
    use std::os::unix::fs::PermissionsExt;
    let binary = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|p| p.join(command(&launch.engine)))
            .find(|p| {
                p.is_file()
                    && p.metadata()
                        .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
            })
    });
    let mut child = if let Some(binary) = binary.filter(|_| plan["grid"].is_null()) {
        // Installed native agents need no Node process, shell wrapper, or setup probe.
        std::process::Command::new(binary)
    } else {
        let mut child = std::process::Command::new(
            std::env::var("_HN_CLI").unwrap_or_else(|_| "harness".into()),
        );
        child.arg("shell-launch").arg(&launch.engine);
        if let (Some(grid), Some(model)) = (plan["grid"].as_str(), plan["model"].as_str()) {
            child.args([grid, model, "--"]);
        } else {
            child.args(["--native", "--"]);
        }
        child
    };
    child.args(args).current_dir(cwd);
    // The agent owns SIGINT; the waiting helper must not abandon its foreground
    // child or return a broken terminal to Readline/ZLE.
    let old = unsafe { libc::signal(libc::SIGINT, libc::SIG_IGN) };
    unsafe {
        child.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            Ok(())
        });
    }
    let result = child.status();
    unsafe {
        libc::signal(libc::SIGINT, old);
    }
    result.map(|s| s.code().unwrap_or(128 + s.signal().unwrap_or(1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_folder_completion_quotes_paths_without_evaluating_the_draft() {
        let path = "/tmp/日本語 a'b;$(nope)";
        for (draft, cursor) in [("vim ", 4), ("vim ''", 5), ("vim \"\"", 5)] {
            let (line, at) = insert_folder(draft, cursor, path).unwrap();
            assert_eq!(words(&line).unwrap()[1].value, path, "{line}");
            assert!(at <= line.chars().count());
        }
        assert!(insert_folder("vim \\", 5, path).is_err());
        assert!(insert_folder("vim ", 4, "/tmp/a\ncommand").is_err());
    }
    fn parse(args: &[&str]) -> Result<Launch, String> {
        Launch::parse(
            "claude",
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
    }
    #[test]
    fn selectors_are_order_independent_and_native_separator_is_literal() {
        for args in [["@office:~/repo", "%sonnet"], ["%sonnet", "@office:~/repo"]] {
            let l = parse(&args).unwrap();
            assert_eq!(l.host.as_deref(), Some("office"));
            assert_eq!(l.path.as_deref(), Some("~/repo"));
            assert_eq!(l.model.as_deref(), Some("sonnet"));
            assert!(l.args.is_empty());
        }
        let l = parse(&[":/a b", "@office", "--", "%literal", "@person"]).unwrap();
        assert_eq!(l.args, ["--", "%literal", "@person"]);
        for args in [
            vec!["@a", "@b"],
            vec!["%a", "%b"],
            vec![":x", "@a:y"],
            vec!["%a", "--model", "b"],
            vec!["@"],
            vec![":"],
            vec!["%"],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
    }
    #[test]
    fn native_profile_options_keep_their_agent_specific_meaning() {
        for profile in [vec!["-p", "work"], vec!["-pwork"], vec!["--profile=work"]] {
            let mut args = vec!["%default".to_string()];
            args.extend(profile.iter().map(|s| s.to_string()));
            assert!(Launch::parse("codex", &args).is_err(), "{args:?}");
        }
        // Claude's -p means print, so it can be combined with a model choice.
        let l = parse(&["%sonnet", "-p", "@a literal prompt"]).unwrap();
        assert_eq!(l.args, ["-p", "@a literal prompt"]);
        assert!(!has_native_model("codex", &["--".into(), "-pwork".into()]));
    }
    #[test]
    fn edits_preserve_suffix_and_quote_literal_values() {
        let line = "claude @office:~/repo %sonnet -- 'keep this task'";
        let d = Draft::new(line, 7).unwrap();
        let (line, _) = d.apply("host", "M2").unwrap();
        assert_eq!(line, "claude @M2:~/repo %sonnet -- 'keep this task'");
        let (line, _) = Draft::new(&line, 7)
            .unwrap()
            .apply("folder", "/tmp/a b;$(touch nope)")
            .unwrap();
        assert_eq!(
            line,
            "claude '@M2:/tmp/a b;$(touch nope)' %sonnet -- 'keep this task'"
        );
        assert_eq!(
            Draft::new(&line, 7).unwrap().launch.path.as_deref(),
            Some("/tmp/a b;$(touch nope)")
        );
        assert!(Draft::new("echo $(danger)", 4).is_none());
        assert!(Draft::new("claude | cat", 6).is_none());
    }
    #[test]
    fn changing_machine_removes_its_folder_but_keeps_agent_model_and_native_arguments() {
        for original in [
            "codex ':~/日本語 old project' %gpt @",
            "codex '@M2:~/日本語 old project' %gpt",
            "codex @M2 ':~/日本語 old project' %gpt",
            "codex ':~/日本語 old project' @M2 %gpt",
            "codex :~/old %gpt --prompt ':literal' -- @literal :literal",
        ] {
            let before = Draft::new(original, original.chars().count()).unwrap();
            let (line, cursor) = before.change_host("Office").unwrap();
            let after = Draft::new(&line, cursor).unwrap();
            assert_eq!(after.launch.host.as_deref(), Some("Office"), "{line}");
            assert_eq!(after.launch.path, None, "old machine's folder survived: {line}");
            assert_eq!(after.launch.engine, "codex");
            assert_eq!(after.launch.model.as_deref(), Some("gpt"));
            assert_eq!(after.launch.args, before.launch.args, "{line}");
            let (line, cursor) = after.apply("folder", "~/remote project").unwrap();
            let after = Draft::new(&line, cursor).unwrap();
            assert_eq!(after.launch.path.as_deref(), Some("~/remote project"), "{line}");
            assert_eq!(after.launch.host.as_deref(), Some("Office"), "{line}");
        }
        let (line, cursor) = Draft::new(":~/local", 8).unwrap().change_host("Office").unwrap();
        let after = Draft::new(&line, cursor).unwrap();
        assert!(!after.has_agent());
        assert_eq!(after.launch.host.as_deref(), Some("Office"));
        assert_eq!(after.launch.path, None);
    }
    #[test]
    fn completions_do_not_replace_selector_shaped_native_option_values() {
        let line = "claude --prompt ':keep' --resume @thread --settings %config :~/old @M2 -- :literal @literal %literal";
        for changed in [false, true] {
            let draft = Draft::new(line, line.chars().count()).unwrap();
            let (line, cursor) = if changed { draft.change_host("Office") } else { draft.apply("host", "M2") }.unwrap();
            let after = Draft::new(&line, cursor).unwrap();
            assert_eq!(after.launch.args, draft.launch.args);
            assert_eq!(after.launch.path.as_deref(), if changed { None } else { Some("~/old") });
            assert!(line.contains("--prompt ':keep' --resume @thread --settings %config"));
            let (line, cursor) = after.apply("folder", "~/new").unwrap();
            let after = Draft::new(&line, cursor).unwrap();
            assert_eq!(after.launch.path.as_deref(), Some("~/new"));
            assert_eq!(after.launch.args, draft.launch.args);
        }
    }
    #[test]
    fn automatic_completion_only_opens_for_literal_selector_boundaries() {
        for line in [
            "codex :",
            "claude @",
            "pi %",
            "claude @office:",
            "codex :~/日本語 %",
        ] {
            assert!(
                Draft::new(line, line.chars().count()).unwrap().automatic(),
                "{line}"
            );
        }
        for line in [
            "printf :",
            "codex -- :",
            "claude --prompt :",
            "codex --model %",
            "claude ':'",
            "claude 'unfinished :",
            "claude hello :",
            "codex exec :",
            "codex :repo",
        ] {
            assert!(
                !Draft::new(line, line.chars().count()).is_some_and(|d| d.automatic()),
                "{line}"
            );
        }
        assert!(!Draft::new("codex :repo", 7).unwrap().automatic());
    }

    #[test]
    fn erasing_automatic_trigger_preserves_other_choices_and_cursor() {
        for (line, cursor, expected) in [
            ("codex :~/repo %", "codex :~/repo %".chars().count(), "codex :~/repo "),
            ("codex ':~/日本語 a b' %gpt @", "codex ':~/日本語 a b' %gpt @".chars().count(), "codex ':~/日本語 a b' %gpt "),
            ("claude @office:", "claude @office:".chars().count(), "claude @office"),
            ("codex :~/日本語 % --resume thread", "codex :~/日本語 %".chars().count(), "codex :~/日本語  --resume thread"),
        ] {
            let draft = Draft::new(line, cursor).unwrap();
            assert_eq!(draft.erase_automatic_trigger(), Some((expected.into(), cursor - 1)));
        }
        for line in ["codex -- %", "claude --prompt :", "codex :repo", "codex '%'", "codex"] {
            assert!(Draft::new(line, line.chars().count()).unwrap().erase_automatic_trigger().is_none(), "{line}");
        }
    }

    #[test]
    fn choosing_agent_after_folder_continues_at_end_but_middle_edits_stay_local() {
        for line in [":~/日本語", "@office:~/my-project %sonnet "] {
            let (s, c) = Draft::new(line, line.chars().count())
                .unwrap()
                .apply("agent", "claude")
                .unwrap();
            assert_eq!(s.trim_end(), format!("claude {}", line.trim_end()));
            assert_eq!(c, s.chars().count());
            assert!(s.ends_with(' '));
        }
        let line = "codex :~/日本語 %default";
        let (s, c) = Draft::new(line, 3)
            .unwrap()
            .apply("agent", "claude")
            .unwrap();
        assert_eq!(s, "claude :~/日本語 %default");
        assert_eq!(
            c, 6,
            "editing the agent in the middle keeps the cursor after it"
        );
        let (s, c) = Draft::new(line, line.chars().count())
            .unwrap()
            .apply("agent", "claude")
            .unwrap();
        assert_eq!(
            c,
            s.chars().count(),
            "a picker opened at the end returns to the end"
        );
    }

    #[test]
    fn empty_partial_unicode_and_middle_of_field() {
        let (s, c) = Draft::new("", 0).unwrap().apply("agent", "claude").unwrap();
        assert_eq!((s.as_str(), c), ("claude ", 7));
        assert_eq!(Draft::new("clau", 4).unwrap().initial(), "&clau");
        let d = Draft::new("claude :~/日本語", 11).unwrap();
        assert_eq!(d.initial(), ":~/日本語");
        let (s, c) = d.apply("folder", "~/café").unwrap();
        assert_eq!(s, "claude :~/café ");
        assert_eq!(c, s.chars().count());
    }
}
