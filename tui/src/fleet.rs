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
    pub active_at: u64,
    pub working: bool,
    pub last_beat: Option<Instant>,
    pub question: Option<Question>,
    pub unread: bool,
    pub dsh: String,
    /// The runtime profile it runs (`runtime-v1:…:claude:opus@high`) — what ⌥I switches.
    pub model: String,
    pub project_root: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum State {
    NeedsInput,
    Working,
    Done,
    Ready,
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
        if self.unread { return State::Done }
        State::Ready
    }

    pub fn recency(&self) -> u64 { self.active_at.max(self.created_at) }
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
    let project = row.get("project").cloned().unwrap_or(Value::Null);
    let launch = row.get("launch").cloned().unwrap_or(Value::Null);
    let title = s(row, "title");
    let mut name = s(row, "name");
    if name.is_empty() { name = if !title.is_empty() { title } else { s(&project, "name") } }
    if name.is_empty() { name = s(row, "engine") }
    let dsh = { let n = s(row, "dshName"); if n.is_empty() { s(row, "dsh") } else { n } };
    Agent {
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
        // Not `updatedAt`: the daemon restamps every row on each reconcile.
        active_at: previous.map(|p| p.active_at).unwrap_or(0),
        working: previous.map(|p| p.working).unwrap_or(false),
        last_beat: previous.and_then(|p| p.last_beat),
        question: previous.and_then(|p| p.question.clone()),
        unread: previous.map(|p| p.unread).unwrap_or(false),
        dsh,
        model: s(row, "selectedModel"),
        project_root: { let r = s(&project, "root"); if r.is_empty() { s(&project, "cwd") } else { r } },
    }
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
        request_id,
        prompt,
        options,
    })
}

#[derive(Default)]
pub struct Fleet {
    pub local_id: String,
    pub machines: Vec<Machine>,
    pub agents: HashMap<(String, String), Agent>,
}

impl Fleet {
    pub fn machine(&self, id: &str) -> Option<&Machine> { self.machines.iter().find(|m| m.id == id) }
    pub fn machine_mut(&mut self, id: &str) -> Option<&mut Machine> { self.machines.iter_mut().find(|m| m.id == id) }
    pub fn machine_name(&self, id: &str) -> String { self.machine(id).map(|m| m.name.clone()).unwrap_or_default() }
    pub fn agent(&self, machine: &str, id: &str) -> Option<&Agent> { self.agents.get(&(machine.to_string(), id.to_string())) }

    pub fn state_of(&self, agent: &Agent) -> State { agent.state(self.machine(&agent.machine_id)) }

    /// Replace one machine's roster from an `agents_list` reply, keeping live state on survivors.
    pub fn replace_roster(&mut self, machine_id: &str, rows: &[Value]) {
        let mut next = HashMap::new();
        for row in rows {
            let id = s(row, "id");
            if id.is_empty() { continue }
            let key = (machine_id.to_string(), id);
            let agent = agent_from(machine_id, row, self.agents.get(&key));
            next.insert(key, agent);
        }
        self.agents.retain(|(m, _), _| m != machine_id);
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
            return self.agents.get_mut(&(machine_id.to_string(), id));
        }
        let session = { let x = s(payload, "sessionId"); if x.is_empty() { s(payload, "dbSessionId") } else { x } };
        if session.is_empty() { return None }
        self.find_by_session(machine_id, &session)
    }

    /// Sorted the way ⌥O lists them: waiting on you, working, running by recency, paused, offline.
    pub fn ranked(&self) -> Vec<&Agent> {
        let mut all: Vec<&Agent> = self.agents.values().collect();
        all.sort_by(|a, b| {
            let (sa, sb) = (self.state_of(a), self.state_of(b));
            let bucket = |st: State| match st { State::NeedsInput => 0, State::Working => 1, State::Done | State::Ready | State::Starting | State::Failed => 2, State::Paused => 3, State::Offline => 4 };
            bucket(sa).cmp(&bucket(sb)).then(b.recency().cmp(&a.recency())).then(a.name.cmp(&b.name))
        });
        all
    }

    pub fn waiting(&self) -> usize { self.agents.values().filter(|a| a.question.is_some() && a.status != "stopped").count() }
    pub fn working(&self) -> usize { self.agents.values().filter(|a| a.working && a.status != "stopped").count() }
    pub fn running(&self) -> usize { self.agents.values().filter(|a| a.status == "active").count() }
}

// ── the roster between runs ────────────────────────────────────────────────────

fn cache_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".harness").join("tui").join("fleet.json")
}

impl Fleet {
    /// Last run's machines and harnesses — searchable the instant the TUI opens, replaced by the
    /// live rosters as each machine answers.
    pub fn load_cache(&mut self) {
        let Ok(text) = std::fs::read_to_string(cache_path()) else { return };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { return };
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
        if self.agents.is_empty() { return }
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
        if std::fs::write(&temp, serde_json::json!({ "machines": machines, "agents": agents }).to_string()).is_ok() { let _ = std::fs::rename(temp, path); }
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
    fn parses_iso() {
        assert_eq!(parse_iso("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(parse_iso("2026-09-25T17:13:11.614Z"), Some(1790356391614));
    }
}
