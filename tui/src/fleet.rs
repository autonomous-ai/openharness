//! Every machine on the account and every harness on them, kept live from the machines' pushed
//! frames — the same facts the desktop's rail and ⌘O are drawn from.

use std::collections::HashMap;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reach {
    Unknown,
    Connecting,
    Ready,
    NeedsLink,
    Offline,
    Error(String),
}

#[derive(Clone, Debug)]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub local: bool,
    /// The control plane's word: running, offline, …
    pub status: String,
    pub reach: Reach,
}

impl Machine {
    pub fn online(&self) -> bool {
        self.local || matches!(self.status.to_ascii_lowercase().as_str(), "running" | "online" | "connected" | "ready")
    }
    pub fn usable(&self) -> bool { self.reach == Reach::Ready }
}

#[derive(Clone, Debug)]
pub struct Question {
    pub request_id: String,
    pub answer_key: String,
    pub prompt: String,
    pub options: Vec<String>,
    /// Several of its options may be chosen (the answer is them joined with ", ").
    pub multi: bool,
    pub since: Instant,
}

#[derive(Clone, Debug)]
pub struct Agent {
    pub machine_id: String,
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub engine: String,
    pub status: String,
    pub launch: String,
    pub cwd: String,
    pub project: String,
    pub branch: String,
    pub created_at: u64,
    /// When its conversation last moved (the daemon's `updatedAt`: dated work in its transcript,
    /// else its engine's last word, else its creation) — what the desktop and phone sort by.
    pub updated_at: u64,
    /// When this client first had it (a list's row, or one it just made).
    pub known_at: Instant,
    pub active_at: u64,
    pub working: bool,
    pub activity: crate::activity::Activity,
    pub last_beat: Option<Instant>,
    pub question: Option<Question>,
    pub unread: bool,
    pub dsh: String,
    pub viewer_url: String,
    pub viewer_name: String,
    pub viewer_error: String,
    /// The runtime profile it runs (`runtime-v1:…:claude:opus@high`) — what ⌥I switches.
    pub model: String,
    pub project_root: String,
    /// What it is doing now — its current tool, as a line (`Running npm test`), or what it is
    /// thinking about — from the live events; none between turns.
    pub doing: Option<String>,
    /// What it has written since its last tool call this turn: its final message, once the turn
    /// ends (the start of it is enough).
    pub said: String,
    /// What its last finished turn came to: the first line of its final message.
    pub did: Option<String>,
    /// When its state began (ms since the epoch): the turn it is on, or the turn it finished.
    pub since: u64,
    /// Its tokens so far (the daemon's tokenUsage), and the lines it changed and the pull requests
    /// it made (outputStats).
    pub tokens: u64,
    pub added: u64,
    pub removed: u64,
    pub prs_made: u64,
    /// Why its start failed, in the daemon's words (launch.detail, else its error code).
    pub launch_error: String,
    /// What it was last asked: the first line of the turn's message.
    pub asked: Option<String>,
    /// The pull request for its branch (git_pull_request), and when that was last asked.
    pub pr: Option<Pr>,
    pub pr_checked: Option<Instant>,
    /// Its last recap was asked of the daemon (agent_recent), once.
    pub recap_asked: bool,
    /// Its to-do list as it last wrote it (TodoWrite): each item's words and its state (pending,
    /// in_progress, completed).
    pub todos: Vec<(String, String)>,
    /// The sub-agents it has running (a Task's tool call, until its end): id and what each does.
    pub subagents: Vec<(String, String)>,
    /// Its last turn ended in an error (the daemon's `error`: an API error, a message not
    /// delivered) — failed, until you look at it or its next turn starts.
    pub errored: bool,
    /// Its last turn's final message, whole (to read it without opening the harness).
    pub last_text: String,
    /// When its transcript last changed, as the daemon last read it (tokenUsage.updatedAt, ms):
    /// what it last did, while no window was watching too.
    pub usage_at: u64,
    // ── models: the model its engine is pointed at (the frame's `grid`) ──
    /// A grid's or a saved API's model (`grid.model`; empty on its own login), that endpoint
    /// (`grid.baseUrl`, which tells one API from another), whether the computers serving it rest
    /// (`grid.state`: asleep, waking), and why it will not answer now (`grid.note`: its reason —
    /// offline, not_served — the model, and the computer).
    pub grid_model: String,
    pub grid_base_url: String,
    pub grid_state: String,
    pub grid_note: Option<(String, String, String)>,
}

/// `grid.note`, read as the desktop reads it: a reason it does not know, or one missing the names
/// its sentence needs, is no note.
fn grid_note(note: &Value) -> Option<(String, String, String)> {
    let model = s(note, "model");
    let machine = s(note, "machine");
    match s(note, "reason").as_str() {
        _ if model.is_empty() => None,
        "not_served" => Some(("not_served".into(), model, machine)),
        "offline" if !machine.is_empty() => Some(("offline".into(), model, machine)),
        _ => None,
    }
}

/// A pull request for an agent's branch: its number, state (Open, Draft, Merged, Closed), link.
#[derive(Clone, Debug, PartialEq)]
pub struct Pr { pub number: u64, pub state: String, pub url: String }

impl Pr {
    /// As a list or a title says it: `#123`, `#123 draft`, `#123 merged`, `#123 closed`.
    pub fn label(&self) -> String {
        match self.state.as_str() { "Open" | "" => format!("#{}", self.number), s => format!("#{} {}", self.number, s.to_lowercase()) }
    }
}

/// A rate limit's window as its vendor reports it: its name (5h, week, fable…), how much of it is
/// used (percent) and when it resets.
#[derive(Clone, Debug, PartialEq)]
pub struct Window { pub label: String, pub used: f64, pub resets: Option<String> }

/// One agent account's limits (usage_read's reading of Claude's or Codex's), read as the desktop
/// reads them (claude_usage_source.dart, codex_usage_source.dart).
#[derive(Clone, Debug, PartialEq)]
pub struct Usage { pub provider: String, pub account: Option<String>, pub windows: Vec<Window> }

impl Usage {
    /// `claude 5h 42% week 18%`.
    pub fn line(&self) -> String {
        let windows: Vec<String> = self.windows.iter().map(|w| format!("{} {:.0}%", w.label, w.used)).collect();
        format!("{} {}", self.provider, windows.join(" "))
    }
}

/// A usage_read reading, when the vendor answered with limits.
pub fn usage_from(reading: &Value) -> Option<Usage> {
    if reading.get("outcome").and_then(Value::as_str) != Some("answered") { return None }
    if reading.get("httpStatus").and_then(Value::as_u64).map(|s| s >= 300).unwrap_or(false) { return None }
    let body = reading.get("body")?;
    let provider = reading.get("provider").and_then(Value::as_str)?;
    // parseUsedPercent: a number or a numeral, held to 0–100.
    let percent = |v: Option<&Value>| v.and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.trim().parse().ok()))).filter(|f: &f64| f.is_finite()).map(|f| f.clamp(0.0, 100.0));
    let text = |w: &Value, k: &str| w.get(k).and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string())));
    let windows: Vec<Window> = match provider {
        "claude" => {
            let one = |label: &str, w: Option<&Value>| w.and_then(|w| Some(Window { label: label.into(), used: percent(w.get("utilization")).or_else(|| percent(w.get("used_percentage")))?, resets: text(w, "resets_at") }));
            let fable = ["fable_weekly", "fable_seven_day", "seven_day_fable"].iter().find_map(|k| body.get(*k));
            [one("5h", body.get("five_hour")), one("week", body.get("seven_day")), one("fable", fable)].into_iter().flatten().collect()
        }
        "codex" => {
            // A window named by how long it is (_labelFor).
            let label = |w: &Value| match w.get("limit_window_seconds").and_then(Value::as_f64).filter(|s| *s > 0.0).map(|s| s.round() as u64) {
                None => "limit".to_string(),
                Some(s) if s < 3600 => format!("{}m", s / 60),
                Some(s) if s < 86400 => format!("{}h", s / 3600),
                Some(s) if s / 86400 == 7 => "week".to_string(),
                Some(s) => format!("{}d", s / 86400),
            };
            let limits = body.get("rate_limit");
            ["primary_window", "secondary_window"].iter().filter_map(|k| limits.and_then(|l| l.get(*k))).filter_map(|w| Some(Window { label: label(w), used: percent(w.get("used_percent"))?, resets: text(w, "reset_at") })).collect()
        }
        _ => Vec::new(),
    };
    (!windows.is_empty()).then(|| Usage { provider: provider.to_string(), account: reading.get("account").and_then(Value::as_str).map(str::to_string), windows })
}

/// A count of tokens as a list says it: 950, 12k, 1.2M.
pub fn compact(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1_000..=99_999 => format!("{:.1}k", n as f64 / 1e3).replace(".0k", "k"),
        100_000..=999_999 => format!("{}k", n / 1000),
        _ => format!("{:.1}M", n as f64 / 1e6).replace(".0M", "M"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum State {
    NeedsInput,
    Working,
    Done,
    Ready,
    Unknown,
    Starting,
    Failed,
    Paused,
    Offline,
}

impl Agent {
    pub fn key(&self) -> (String, String) { (self.machine_id.clone(), self.id.clone()) }

    pub fn state(&self, machine: Option<&Machine>) -> State {
        // Offline only when the machine is known to be unreachable — not while it is still being
        // dialled (a cached roster at startup), which lasts a second and is not news.
        let down = machine.map(|m| matches!(m.reach, Reach::Offline | Reach::NeedsLink | Reach::Error(_)) || (!m.online() && !m.local)).unwrap_or(false);
        if down || self.status == "offline" { return State::Offline }
        if self.status == "stopped" { return State::Paused }
        if self.launch == "starting" { return State::Starting }
        if self.launch == "failed" { return State::Failed }
        if self.question.is_some() { return State::NeedsInput }
        if self.working { return State::Working }
        if self.errored { return State::Failed }
        if self.unread { return State::Done }
        if self.activity.unknown { return State::Unknown }
        State::Ready
    }

    /// When it was last active: its conversation's time (updatedAt), or later what this client saw
    /// it do — never a bookkeeping stamp (its token count's refresh moves every harness at once).
    pub fn recency(&self) -> u64 { let t = self.updated_at.max(self.active_at); if t > 0 { t } else { self.created_at } }

    /// When it came to be as it is (ms since the epoch): waiting on you since its question, working
    /// since its turn began, done or failed since it ended; idle, paused or offline since it last
    /// did anything.
    pub fn state_since(&self, state: State) -> u64 {
        match &self.question {
            Some(q) => now_ms().saturating_sub(q.since.elapsed().as_millis() as u64),
            None if self.since > 0 && !matches!(state, State::Ready | State::Paused | State::Offline) => self.since,
            None => self.recency(),
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn s(v: &Value, key: &str) -> String { v.get(key).and_then(Value::as_str).unwrap_or("").to_string() }

fn time(v: &Value, key: &str) -> u64 {
    // RFC 3339 → ms, without a date crate: the daemon always writes `YYYY-MM-DDTHH:MM:SS.sssZ`.
    let text = s(v, key);
    parse_iso(&text).unwrap_or(0)
}

pub fn parse_iso(text: &str) -> Option<u64> {
    let b = text.as_bytes();
    if b.len() < 19 { return None }
    let n = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    let ms = if b.len() > 20 && b[19] == b'.' { text.get(20..23).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0) } else { 0 };
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + se) * 1000 + ms) as u64)
}

pub fn agent_from(machine_id: &str, row: &Value, previous: Option<&Agent>) -> Agent {
    if let Some(agent) = previous {
        if agent.session_id != s(row, "sessionId") && agent.activity.older(&row["activity"]) { return agent.clone() }
    }
    let activity = previous.map(|p| p.activity.clone()).unwrap_or_default();
    let previous = previous.filter(|agent| agent.session_id == s(row, "sessionId"));
    let project = row.get("project").cloned().unwrap_or(Value::Null);
    let launch = row.get("launch").cloned().unwrap_or(Value::Null);
    let title = s(row, "title");
    let mut name = s(row, "name");
    if name.is_empty() { name = if !title.is_empty() { title } else { s(&project, "name") } }
    if name.is_empty() { name = s(row, "engine") }
    let dsh = { let n = s(row, "dshName"); if n.is_empty() { s(row, "dsh") } else { n } };
    let mut agent = Agent {
        machine_id: machine_id.to_string(),
        id: s(row, "id"),
        session_id: s(row, "sessionId"),
        name,
        engine: { let e = s(row, "engine"); if e.is_empty() { "terminal".into() } else { e } },
        status: { let st = s(row, "status"); if st.is_empty() { "active".into() } else { st } },
        launch: { let l = s(&launch, "state"); if l.is_empty() { "ready".into() } else { l } },
        cwd: s(&project, "cwd"),
        project: s(&project, "name"),
        branch: s(&project, "branch"),
        created_at: time(row, "createdAt"),
        updated_at: time(row, "updatedAt"),
        known_at: previous.map(|p| p.known_at).unwrap_or_else(Instant::now),
        // Not `updatedAt`: the daemon restamps every row on each reconcile.
        active_at: previous.map(|p| p.active_at).unwrap_or(0),
        activity,
        working: previous.map(|p| p.working).unwrap_or(false),
        last_beat: previous.and_then(|p| p.last_beat),
        question: previous.and_then(|p| p.question.clone()),
        unread: previous.map(|p| p.unread).unwrap_or(false),
        dsh,
        viewer_url: s(row, "viewerUrl"),
        viewer_name: s(row, "viewerName"),
        viewer_error: s(row, "viewerError"),
        model: s(row, "selectedModel"),
        project_root: { let r = s(&project, "root"); if r.is_empty() { s(&project, "cwd") } else { r } },
        doing: previous.and_then(|p| p.doing.clone()),
        said: previous.map(|p| p.said.clone()).unwrap_or_default(),
        did: previous.and_then(|p| p.did.clone()),
        since: previous.map(|p| p.since).unwrap_or(0),
        tokens: row.pointer("/tokenUsage/totalTokens").and_then(Value::as_u64).or(previous.map(|p| p.tokens)).unwrap_or(0),
        added: row.pointer("/outputStats/linesAdded").and_then(Value::as_u64).or(previous.map(|p| p.added)).unwrap_or(0),
        removed: row.pointer("/outputStats/linesRemoved").and_then(Value::as_u64).or(previous.map(|p| p.removed)).unwrap_or(0),
        prs_made: row.pointer("/outputStats/pullRequestsCreated").and_then(Value::as_u64).or(previous.map(|p| p.prs_made)).unwrap_or(0),
        launch_error: {
            let detail = s(&launch, "detail");
            let code = s(&launch, "error");
            match first_line(&detail) { Some(d) => d, None if !code.is_empty() => { let t = code.to_lowercase().replace('_', " "); let mut c = t.chars(); c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default() } None => String::new() }
        },
        asked: previous.and_then(|p| p.asked.clone()),
        pr: previous.and_then(|p| p.pr.clone()),
        pr_checked: previous.and_then(|p| p.pr_checked),
        recap_asked: previous.map(|p| p.recap_asked).unwrap_or(false),
        errored: previous.map(|p| p.errored).unwrap_or(false),
        last_text: previous.map(|p| p.last_text.clone()).unwrap_or_default(),
        usage_at: row.get("tokenUsage").map(|u| time(u, "updatedAt")).filter(|t| *t > 0).or(previous.map(|p| p.usage_at)).unwrap_or(0),
        todos: previous.map(|p| p.todos.clone()).unwrap_or_default(),
        subagents: previous.map(|p| p.subagents.clone()).unwrap_or_default(),
        // ── models ── (the daemon pushes the row again when its note clears)
        grid_model: s(&row["grid"], "model"),
        grid_base_url: s(&row["grid"], "baseUrl"),
        grid_state: s(&row["grid"], "state"),
        grid_note: grid_note(&row["grid"]["note"]),
    };
    if let Some(working) = agent.activity.accept(&row["activity"], Instant::now()) { agent.working = working; }
    if matches!(agent.status.as_str(), "stopped" | "offline") { agent.working = false; agent.activity.unknown = false; }
    agent
}

/// TodoWrite's list: each item's words (its present-tense form while it is in progress) and state.
pub fn todos_of(input: &Value) -> Vec<(String, String)> {
    input.get("todos").and_then(Value::as_array).map(|todos| todos.iter().filter_map(|t| {
        let status = t.get("status").and_then(Value::as_str).unwrap_or("pending").to_string();
        let words = if status == "in_progress" { t.get("activeForm").or_else(|| t.get("content")) } else { t.get("content") }.and_then(Value::as_str)?;
        Some((words.to_string(), status))
    }).collect()).unwrap_or_default()
}

/// A tool call as the one line that says what an agent is doing (Claude Code's own words where
/// it gives them: a Bash call's description).
pub fn describe_tool(tool: &str, input: &Value) -> String {
    let text = |k: &str| input.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let file = |k: &str| text(k).map(|p| p.rsplit('/').next().unwrap_or(&p).to_string());
    let first = |v: String| v.lines().next().unwrap_or("").trim().to_string();
    let command = || match input.get("command") {
        Some(Value::Array(parts)) => parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        Some(Value::String(c)) => c.clone(),
        _ => String::new(),
    };
    let line = match tool {
        "Bash" | "shell" | "exec_command" | "local_shell" => text("description").unwrap_or_else(|| format!("$ {}", first(command()))),
        "Read" | "read_file" => format!("Reading {}", file("file_path").or_else(|| file("path")).unwrap_or_default()),
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "apply_patch" | "edit_file" | "write_file" =>
            match file("file_path").or_else(|| file("path")).or_else(|| file("notebook_path")) { Some(f) => format!("Editing {f}"), None => "Editing".into() },
        "Grep" | "grep" => format!("Searching for {}", text("pattern").unwrap_or_default()),
        "Glob" | "glob" => format!("Finding {}", text("pattern").unwrap_or_default()),
        "WebSearch" | "web_search" => format!("Searching the web for {}", text("query").unwrap_or_default()),
        "WebFetch" | "web_fetch" => format!("Reading {}", text("url").unwrap_or_default()),
        "Task" | "Agent" => text("description").map(|d| format!("Agent: {d}")).unwrap_or_else(|| "Running an agent".into()),
        "TodoWrite" => input.get("todos").and_then(Value::as_array)
            .and_then(|todos| todos.iter().find(|t| t.get("status").and_then(Value::as_str) == Some("in_progress")))
            .and_then(|t| t.get("activeForm").or_else(|| t.get("content")).and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| "Planning".into()),
        t => match t.strip_prefix("mcp__").and_then(|r| r.split_once("__")) { Some((server, name)) => format!("{name} ({server})"), None => t.to_string() },
    };
    line.chars().take(160).collect()
}

/// The line a message comes to: its first line with words in it, markdown taken off.
pub fn first_line(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| l.chars().any(char::is_alphanumeric))?;
    let line = line.trim_start_matches(['#', '>', '-', '*', '•', ' ']).replace("**", "").replace('`', "");
    let line = line.trim();
    (!line.is_empty()).then(|| line.chars().take(160).collect())
}

pub fn question_from(payload: &Value, previous: Option<&Question>) -> Option<Question> {
    let request_id = s(payload, "requestId");
    let first = payload.get("questions")?.as_array()?.first()?.clone();
    let prompt = first.get("q").or_else(|| first.get("key")).and_then(Value::as_str).unwrap_or("").trim().to_string();
    if request_id.is_empty() || prompt.is_empty() { return None }
    let options = first.get("options").and_then(Value::as_array).map(|a| a.iter().filter_map(|o| o.as_str().map(|x| x.trim().to_string())).filter(|x| !x.is_empty()).collect()).unwrap_or_default();
    Some(Question {
        answer_key: first.get("key").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| prompt.clone()),
        since: previous.filter(|p| p.request_id == request_id).map(|p| p.since).unwrap_or_else(Instant::now),
        multi: first.get("multi").and_then(Value::as_bool).unwrap_or(false),
        request_id,
        prompt,
        options,
    })
}

/// An answer as typed: numbers (`2`, `1,3`) are those options (several joined with ", ", as the
/// daemon keys a multi-choice answer); anything else is the answer in your own words.
/// An error's line without the JSON an API wraps it in: `API Error: 529 {"type":"error","error":
/// {"type":"overloaded_error","message":"Overloaded"}}` is `API Error: 529 Overloaded`.
pub fn tidy_error(line: &str) -> String {
    if let Some(i) = line.find('{') {
        if let Ok(v) = serde_json::from_str::<Value>(&line[i..]) {
            let what = v.pointer("/error/message").or_else(|| v.pointer("/error/type")).or_else(|| v.get("message")).and_then(Value::as_str);
            if let Some(w) = what { return format!("{} {w}", line[..i].trim_end()).trim().to_string() }
        }
    }
    line.to_string()
}

/// An answer given by its choices' numbers (`2`; `1,3` for a question that takes several): the
/// choices' words — anything else is refused, never sent as words (answer -l for words).
pub fn choices(q: &Question, typed: &str) -> Result<String, String> {
    let parts: Vec<&str> = typed.split([',', ' ']).filter(|s| !s.is_empty()).collect();
    let n = q.options.len();
    if n == 0 { return Err("this question has no choices: answer -l with words".into()) }
    let mut picked = Vec::new();
    for p in &parts {
        match p.parse::<usize>() {
            Ok(k) if k >= 1 && k <= n => picked.push(q.options[k - 1].clone()),
            _ => return Err(format!("{p} is not a choice (1–{n}; -l for words)")),
        }
    }
    if picked.is_empty() { return Err("no choice given".into()) }
    if picked.len() > 1 && !q.multi { return Err(format!("one choice only (1–{n})")) }
    Ok(picked.join(", "))
}

pub fn answer_text(q: &Question, typed: &str) -> Option<String> {
    let typed = typed.trim();
    if typed.is_empty() { return None }
    let numbers: Option<Vec<usize>> = typed.split([',', ' ']).filter(|s| !s.is_empty()).map(|s| s.parse::<usize>().ok().filter(|n| *n >= 1 && *n <= q.options.len())).collect();
    match numbers {
        Some(ns) if !ns.is_empty() && (q.multi || ns.len() == 1) => Some(ns.iter().map(|n| q.options[n - 1].clone()).collect::<Vec<_>>().join(", ")),
        _ => Some(typed.to_string()),
    }
}

#[derive(Default)]
pub struct Fleet {
    pub local_id: String,
    pub machines: Vec<Machine>,
    pub agents: HashMap<(String, String), Agent>,
}

/// Match the desktop and phone: the app's saved name, or its stable machine-id label.
pub fn machine_display_name(id: &str, name: Option<&str>) -> String {
    name.map(str::trim).filter(|name| !name.is_empty()).map(str::to_string)
        .unwrap_or_else(|| format!("machine-{}", id.chars().take(8).collect::<String>()))
}

impl Fleet {
    pub fn machine(&self, id: &str) -> Option<&Machine> { self.machines.iter().find(|m| m.id == id) }
    pub fn machine_mut(&mut self, id: &str) -> Option<&mut Machine> { self.machines.iter_mut().find(|m| m.id == id) }
    /// The account's record for this computer; the local PTY transport is not another machine.
    pub fn registered_local_machine(&self) -> Option<&Machine> {
        self.machine(&self.local_id).filter(|m| !crate::local::is_local(&m.id))
            .or_else(|| self.machines.iter().find(|m| m.local && !crate::local::is_local(&m.id)))
    }
    pub fn local_machine_name(&self) -> String {
        self.registered_local_machine().map(|m| machine_display_name(&m.id, Some(&m.name)))
            .unwrap_or_else(|| "This computer".into())
    }
    pub fn machine_name(&self, id: &str) -> String {
        if crate::local::is_local(id) { return self.local_machine_name() }
        machine_display_name(id, self.machine(id).map(|m| m.name.as_str()))
    }
    /// New work from a local shell goes through Harness when its daemon is connected.
    /// Existing PTYs keep their transport identity so their sessions survive reconnects.
    pub fn launch_machine_id<'a>(&'a self, id: &'a str) -> &'a str {
        if crate::local::is_local(id) {
            if let Some(machine) = self.registered_local_machine().filter(|m| m.usable()) { return &machine.id }
        }
        id
    }
    pub fn visible_machines(&self) -> impl Iterator<Item = &Machine> {
        let connected_local = self.registered_local_machine().is_some_and(Machine::usable);
        self.machines.iter().filter(move |m| !connected_local || !crate::local::is_local(&m.id))
    }
    pub fn agent(&self, machine: &str, id: &str) -> Option<&Agent> { self.agents.get(&(machine.to_string(), id.to_string())) }

    pub fn state_of(&self, agent: &Agent) -> State { agent.state(self.machine(&agent.machine_id)) }

    /// Replace one machine's roster from an `agents_list` reply, keeping live state on survivors.
    /// A machine's roster from an `agents_list` reply asked for at [asked]: one this client made
    /// after it was asked (a shell just started) stays, though the list could not have it.
    pub fn replace_roster(&mut self, machine_id: &str, rows: &[Value], asked: Instant) {
        let mut next = HashMap::new();
        for row in rows {
            let id = s(row, "id");
            if id.is_empty() { continue }
            let key = (machine_id.to_string(), id);
            let agent = agent_from(machine_id, row, self.agents.get(&key));
            next.insert(key, agent);
        }
        self.agents.retain(|(m, _), a| m != machine_id || a.known_at > asked);
        self.agents.extend(next);
    }

    /// Upsert rows without dropping anyone — the fast live-only list arriving before the full one.
    pub fn merge_roster(&mut self, machine_id: &str, rows: &[Value]) {
        for row in rows {
            let id = s(row, "id");
            if id.is_empty() { continue }
            let key = (machine_id.to_string(), id);
            let agent = agent_from(machine_id, row, self.agents.get(&key));
            self.agents.insert(key, agent);
        }
    }

    pub fn find_by_session(&mut self, machine_id: &str, session: &str) -> Option<&mut Agent> {
        self.agents.values_mut().find(|a| a.machine_id == machine_id && a.session_id == session)
    }

    /// The agent a pushed event is about: `agentId`, else its session.
    pub fn event_agent(&mut self, machine_id: &str, payload: &Value) -> Option<&mut Agent> {
        let id = s(payload, "agentId");
        if !id.is_empty() && self.agents.contains_key(&(machine_id.to_string(), id.clone())) {
            let agent = self.agents.get_mut(&(machine_id.to_string(), id))?;
            let session = payload.get("sessionId").or_else(|| payload.get("dbSessionId")).and_then(Value::as_str);
            if agent.status == "stopped" || session.is_some_and(|s| !agent.session_id.is_empty() && s != agent.session_id) { return None }
            return Some(agent);
        }
        let session = { let x = s(payload, "sessionId"); if x.is_empty() { s(payload, "dbSessionId") } else { x } };
        if session.is_empty() { return None }
        self.find_by_session(machine_id, &session)
    }

    /// Sorted the way ⌥O lists them: waiting on you, working, running by recency, paused, offline.
    /// Every harness in the order it needs you: waiting on you, failed, done and unread, working,
    /// starting, idle, paused, offline — within the first three and working, the one that has
    /// waited (or run) longest first; the rest most recent first.
    pub fn ranked(&self) -> Vec<&Agent> {
        let bucket = |st: State| match st { State::NeedsInput => 0, State::Failed => 1, State::Done => 2, State::Working => 3, State::Starting => 4, State::Unknown => 5, State::Ready => 6, State::Paused => 7, State::Offline => 8 };
        // Each one's key once (the clock read once for all: a comparison that read it again could
        // order two alike harnesses both ways, which a sort must never see).
        let now = now_ms();
        let mut keyed: Vec<((u8, u64, &str), &Agent)> = self.agents.values().map(|a| {
            let b = bucket(self.state_of(a));
            let age = match &a.question { Some(q) => now.saturating_sub(q.since.elapsed().as_millis() as u64), None => a.since };
            // The urgent ones longest waiting first; the rest most recent first.
            let order = if b <= 3 { age } else { u64::MAX - a.recency() };
            ((b, order, a.name.as_str()), a)
        }).collect();
        keyed.sort_by(|x, y| x.0.cmp(&y.0));
        keyed.into_iter().map(|(_, a)| a).collect()
    }

    /// How many harnesses (shells aside) are in each state: the status line's counts.
    pub fn count(&self, state: State) -> usize {
        self.agents.values().filter(|a| a.engine != "terminal" && self.state_of(a) == state).count()
    }

    pub fn waiting(&self) -> usize { self.agents.values().filter(|a| a.question.is_some() && a.status != "stopped").count() }
}

// ── the roster between runs ────────────────────────────────────────────────────

fn cache_path() -> std::path::PathBuf {
    crate::app::state_dir().join("fleet.json")
}

impl Fleet {
    /// Restore only after this user's daemon identifies the current account's machine. Old caches
    /// had no owner and may have come from another OS user's TCP listener; never adopt those.
    pub fn load_cache(&mut self, owner: &str) {
        let Ok(text) = std::fs::read_to_string(cache_path()) else { return };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { return };
        self.restore_cache(&value, owner);
    }

    fn restore_cache(&mut self, value: &Value, owner: &str) {
        if owner.is_empty() || value.get("owner").and_then(Value::as_str) != Some(owner) { return }
        for m in value.get("machines").and_then(Value::as_array).into_iter().flatten() {
            let id = s(m, "id");
            if id.is_empty() || self.machine(&id).is_some() { continue }
            self.machines.push(Machine { name: s(m, "name"), local: m.get("local").and_then(Value::as_bool).unwrap_or(false), status: s(m, "status"), reach: Reach::Unknown, id });
        }
        for a in value.get("agents").and_then(Value::as_array).into_iter().flatten() {
            let machine = s(a, "machine");
            let row = a.get("row").cloned().unwrap_or(Value::Null);
            let id = s(&row, "id");
            if machine.is_empty() || id.is_empty() { continue }
            let mut agent = agent_from(&machine, &row, None);
            agent.active_at = a.get("activeAt").and_then(Value::as_u64).unwrap_or(0);
            self.agents.entry((machine, id)).or_insert(agent);
        }
    }

    pub fn save_cache(&self) {
        if self.agents.is_empty() || self.local_id.is_empty() || crate::local::is_local(&self.local_id) { return }
        let machines: Vec<Value> = self.machines.iter().map(|m| serde_json::json!({ "id": m.id, "name": m.name, "local": m.local, "status": m.status })).collect();
        let agents: Vec<Value> = self.agents.values().map(|a| serde_json::json!({
            "machine": a.machine_id, "activeAt": a.active_at,
            "row": { "id": a.id, "sessionId": a.session_id, "name": a.name, "engine": a.engine, "status": a.status,
                     "launch": { "state": a.launch }, "selectedModel": a.model, "dshName": a.dsh,
                     "project": { "cwd": a.cwd, "name": a.project, "branch": a.branch, "root": a.project_root } },
        })).collect();
        let path = cache_path();
        if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
        let temp = path.with_extension("json.tmp");
        if std::fs::write(&temp, serde_json::json!({ "owner": self.local_id, "machines": machines, "agents": agents }).to_string()).is_ok() { let _ = std::fs::rename(temp, path); }
    }
}

/// "3m", "2h", "4d".
pub fn ago(ms: u64) -> String {
    if ms == 0 { return String::new() }
    let secs = now_ms().saturating_sub(ms) / 1000;
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m", secs / 60),
        3600..=86_399 => format!("{}h", secs / 3600),
        _ => format!("{}d", secs / 86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_needs_the_current_accounts_owner_and_drops_legacy_unscoped_data() {
        let mut cached = serde_json::json!({
            "owner": "account-a", "machines": [{"id": "remote-a", "name": "private-machine"}],
            "agents": [{"machine": "remote-a", "row": {"id": "private-agent", "name": "private work"}}]
        });
        let mut fleet = Fleet::default();
        fleet.restore_cache(&cached, "account-b");
        assert!(fleet.machines.is_empty() && fleet.agents.is_empty());
        cached.as_object_mut().unwrap().remove("owner");
        fleet.restore_cache(&cached, "account-a");
        fleet.restore_cache(&cached, "");
        assert!(fleet.machines.is_empty() && fleet.agents.is_empty());
        cached["owner"] = serde_json::json!("account-a");
        fleet.restore_cache(&cached, "account-a");
        assert_eq!(fleet.machines.len(), 1);
        assert_eq!(fleet.agents.len(), 1);
    }

    #[test]
    fn local_shells_share_the_app_name_without_changing_their_transport() {
        let shell = crate::local::MACHINE;
        let mut fleet = Fleet { local_id: "registered-local".into(), ..Default::default() };
        for (id, name, local) in [(shell, "m0", true), ("registered-local", "office", true), ("remote", "GPU rig", false)] {
            fleet.machines.push(Machine { id: id.into(), name: name.into(), local, status: "running".into(), reach: Reach::Ready });
        }
        assert_eq!(fleet.machine_name(shell), "office");
        assert_eq!(fleet.machine_name("registered-local"), "office");
        assert_eq!(fleet.machine_name("remote"), "GPU rig");
        assert_eq!(fleet.launch_machine_id(shell), "registered-local");
        assert_eq!(fleet.visible_machines().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["registered-local", "remote"]);
        assert_eq!(fleet.machine(shell).unwrap().id, shell);
        // A rename is visible even to existing shell panes. Offline boot keeps the cached app name.
        fleet.machine_mut("registered-local").unwrap().name = "Work Mac".into();
        assert_eq!(fleet.machine_name(shell), "Work Mac");
        fleet.local_id = shell.into();
        fleet.machine_mut("registered-local").unwrap().reach = Reach::Offline;
        assert_eq!(fleet.local_machine_name(), "Work Mac");
        assert_eq!(fleet.machine_name(shell), "Work Mac");
        assert_eq!(fleet.launch_machine_id(shell), shell);
        // An unnamed account machine follows the desktop/phone convention, not its hostname.
        fleet.machine_mut("registered-local").unwrap().name.clear();
        assert_eq!(fleet.machine_name(shell), "machine-register");
        assert_eq!(Fleet::default().machine_name(shell), "This computer");
    }

    #[test]
    fn parses_iso() {
        assert_eq!(parse_iso("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(parse_iso("2026-09-25T17:13:11.614Z"), Some(1790356391614));
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;

    #[test]
    fn limits_read_as_the_desktop_reads_them() {
        let claude = serde_json::json!({ "provider": "claude", "account": "a", "outcome": "answered", "httpStatus": 200, "body": { "five_hour": { "utilization": 92.4 }, "seven_day": { "utilization": "18" }, "seven_day_fable": { "used_percentage": 5 } } });
        assert_eq!(usage_from(&claude).unwrap().line(), "claude 5h 92% week 18% fable 5%");
        let codex = serde_json::json!({ "provider": "codex", "outcome": "answered", "body": { "rate_limit": { "primary_window": { "used_percent": 3, "limit_window_seconds": 18000 }, "secondary_window": { "used_percent": 150, "limit_window_seconds": 604800 } } } });
        assert_eq!(usage_from(&codex).unwrap().line(), "codex 5h 3% week 100%");
        assert!(usage_from(&serde_json::json!({ "provider": "claude", "outcome": "signedOut" })).is_none());
        assert!(usage_from(&serde_json::json!({ "provider": "claude", "outcome": "answered", "httpStatus": 401, "body": {} })).is_none());
        assert_eq!(compact(1_240_000), "1.2M");
        assert_eq!(compact(88_400), "88.4k");
        assert_eq!(compact(12_000), "12k");
        assert_eq!(compact(356_000), "356k");
    }
}

#[cfg(test)]
mod tidy_tests {
    #[test]
    fn api_errors_without_their_json() {
        assert_eq!(super::tidy_error(r#"API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#), "API Error: 529 Overloaded");
        assert_eq!(super::tidy_error("API Error: 529 overloaded"), "API Error: 529 overloaded");
        assert_eq!(super::tidy_error("a {not json"), "a {not json");
    }
}

#[cfg(test)]
mod answer_tests {
    use super::*;

    #[test]
    fn typed_answers() {
        let q = |multi| Question { request_id: "r".into(), answer_key: "k".into(), prompt: "p".into(), options: vec!["Per API key".into(), "Per IP".into(), "Both".into()], multi, since: Instant::now() };
        assert_eq!(answer_text(&q(false), "2").as_deref(), Some("Per IP"));
        assert_eq!(answer_text(&q(true), "1,3").as_deref(), Some("Per API key, Both"));
        assert_eq!(answer_text(&q(true), "1 3").as_deref(), Some("Per API key, Both"));
        // Several numbers for a one-choice question, a number out of range, words: as typed.
        assert_eq!(answer_text(&q(false), "1,3").as_deref(), Some("1,3"));
        assert_eq!(answer_text(&q(false), "9").as_deref(), Some("9"));
        assert_eq!(answer_text(&q(false), " per user, please ").as_deref(), Some("per user, please"));
        assert_eq!(answer_text(&q(false), "  "), None);
    }
}

#[cfg(test)]
mod activity_evidence_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn late_snapshot_cannot_restore_an_old_conversation() {
        let old = json!({"id":"agent","sessionId":"old","activity":{"state":"working","epoch":"daemon","revision":1,"validForMs":30000}});
        let new = json!({"id":"agent","sessionId":"new","activity":{"state":"idle","epoch":"daemon","revision":2,"validForMs":0}});
        let first = agent_from("m", &old, None);
        let replacement = agent_from("m", &new, Some(&first));
        let late = agent_from("m", &old, Some(&replacement));
        assert_eq!(late.session_id, "new"); assert!(!late.working);
    }
    #[test]
    fn unavailable_activity_is_neither_working_nor_done() {
        let row = json!({"id":"agent","sessionId":"s","activity":{"state":"unknown","epoch":"daemon","revision":1,"validForMs":0}});
        let agent = agent_from("m", &row, None);
        assert_eq!(agent.state(None), State::Unknown); assert!(!agent.unread);
    }
}
