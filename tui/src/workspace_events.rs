//! A confirmed lifecycle result also changes ordinary tmux sessions owned by another hn
//! client. Shared desk tabs follow the daemon's desk protocol. These events only update
//! existing views; receiving one never launches or stops a process and never rebroadcasts it.
use serde_json::Value;
use crate::{app::App, session_close::Identity};

pub fn publish(app: &App, identity: &Identity, replacement: Option<Value>) {
    if !identity.owner_matches(app) { return }
    let mut event = identity.payload("view");
    event["machineId"] = identity.machine.clone().into();
    event["owner"] = app.fleet.local_id.clone().into();
    event["replacement"] = replacement.into();
    let words = vec!["hn-harness-view-event".into(), "-j".into(), event.to_string()];
    #[cfg(not(test))]
    for peer in crate::commands::other_clients() {
        let words = words.clone();
        tokio::spawn(async move { crate::ipc::notify(&peer, &words).await });
    }
    #[cfg(test)] let _ = words;
}

pub fn receive(app: &mut App, event: &Value) {
    if event["owner"] != app.fleet.local_id { return }
    let Some(machine) = event["machineId"].as_str() else { return };
    if app.fleet.machine(machine).is_none_or(|m| m.shared) { return }
    let Some(previous) = event["agentId"].as_str() else { return };
    if event["sessionId"].as_str().is_none() || event["createdAt"].as_str().is_none_or(str::is_empty) { return }
    if app.fleet.agent(machine, previous).is_some_and(|a| a.session_id != event["sessionId"] || a.created_at_wire != event["createdAt"]) { return }
    let views = app.owned_ordinary_views(machine, previous);
    if views.is_empty() { return }
    if event["replacement"].is_null() {
        if let Some(agent) = app.fleet.agents.get_mut(&(machine.into(), previous.into())) { agent.status = "stopped".into(); agent.working = false; }
        for (sid, pane) in views {
            // Explicit session targeting uses the normal context save/restore path, even
            // when the receiving client currently watches a different client's session.
            crate::commands::execute(app, &format!("kill-pane -t '${sid}:.{}'", crate::pane::tag(pane)));
        }
    } else {
        let row = &event["replacement"];
        let Some(next) = row["id"].as_str().filter(|id| !id.is_empty() && *id != previous) else { return };
        if row["engine"].as_str().is_none_or(str::is_empty) || row.pointer("/terminal/available") != Some(&Value::Bool(true)) { return }
        if let Some(existing) = app.fleet.agent(machine, next) {
            if !row["createdAt"].is_null() && existing.created_at_wire != row["createdAt"] { return }
        }
        let agent = crate::fleet::agent_from(machine, row, app.fleet.agent(machine, next));
        app.fleet.agents.insert(agent.key(), agent);
        app.replace_ordinary_harness_views(machine, previous, next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::{app::{Stash, Tab}, fleet::{Machine, Reach}, layout::{Dir, Node}, pane::Pane};

    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19799, sink, (100, 30));
        app.handed_over = true; app.cfg_finished = true; app.session_id = 42; app.session_desk = false;
        app.session_alias = Some("owned".into()); app.fleet.local_id = "local".into();
        app.fleet.machines.push(Machine { id:"local".into(), name:"Studio".into(), local:true, shared:false, status:"online".into(), reach:Reach::Ready });
        let old = json!({"id":"old", "sessionId":"conversation", "createdAt":"2026-10-03T10:00:00.123Z", "name":"Task", "engine":"codex", "terminal":{"available":true}});
        app.fleet.merge_roster("local", &[old]);
        let mut tab = Tab::with_wid("work", 1); let mut root = Node::new(1, 100, 28);
        root.split(1, 2, Dir::Horizontal); tab.root = Some(root); tab.focus = Some(2); app.tabs = vec![tab];
        for (id, agent) in [(1,"old"), (2,"unrelated"), (3,"old")] { app.panes.insert(id, Pane::new(id, "local", agent, 50, 28)); }
        let mut desk = Tab::with_wid("desk", 3); desk.root = Some(Node::new(3, 100, 28)); desk.focus = Some(3); desk.on_desk = true;
        app.sessions.push(Stash { id:43, used:0, mirror:None, alias:None, desk:true, tabs:vec![desk], active:0, lastw:vec![], nums:Default::default(),
            created:0, activity:0, last_attached:0, options:Default::default(), env:Default::default(), path:None, group:None });
        app.fit_panes(); app
    }

    fn event(replace: bool) -> Value {
        json!({"owner":"local", "machineId":"local", "agentId":"old", "sessionId":"conversation", "createdAt":"2026-10-03T10:00:00.123Z",
            "replacement":replace.then(|| json!({"id":"new", "sessionId":"new-conversation", "createdAt":"2026-10-03T11:00:00.123Z", "engine":"claude", "name":"Task", "terminal":{"available":true}}))})
    }

    #[tokio::test]
    async fn replacement_updates_owned_sessions_once_without_writing_shared_desk_tabs() {
        let mut app = app(); let shape = app.tab().root.as_ref().unwrap().to_tmux();
        let event = event(true);
        receive(&mut app, &event); receive(&mut app, &event);
        assert_eq!(app.panes[&1].agent_id, "new");
        assert_eq!(app.panes[&3].agent_id, "old", "shared desk replacement comes from its authoritative desk document");
        assert_eq!(app.focused(), Some(2)); assert_eq!(app.session_id, 42);
        assert_eq!(app.tab().root.as_ref().unwrap().to_tmux(), shape);
        assert!(!crate::agent_switch::sync_pending(&app)); assert!(app.agent_switch.sent.is_empty());
    }

    #[tokio::test]
    async fn stop_receipt_only_closes_its_owned_view_and_never_sends_another_stop() {
        let mut app = app();
        receive(&mut app, &event(false));
        assert!(!app.panes.contains_key(&1));
        assert!(app.panes.contains_key(&2) && app.panes.contains_key(&3));
        assert_eq!(app.focused(), Some(2)); assert_eq!(app.session_id, 42);
        assert!(app.session_close.sent.is_empty()); assert!(!crate::agent_switch::sync_pending(&app));
    }

    #[tokio::test]
    async fn old_accounts_reused_agent_ids_and_mirrors_cannot_apply_a_receipt() {
        for patch in [json!({"owner":"other"}), json!({"sessionId":"other"}), json!({"createdAt":"old"}), json!({"machineId":"unknown"})] {
            let mut app = app(); let mut event = event(true);
            for (key, value) in patch.as_object().unwrap() { event[key] = value.clone(); }
            receive(&mut app, &event);
            assert_eq!(app.panes[&1].agent_id, "old");
        }
        let mut app = app(); app.mirror = Some(crate::app::Mirror { owner:"fixture".into(), readonly:false });
        receive(&mut app, &event(true));
        assert_eq!(app.panes[&1].agent_id, "old", "a mirror follows the session owner's saved view");
    }
}
