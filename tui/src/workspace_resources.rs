//! Inventory counts shared with desktop. Reading them never starts work or samples CPU/RAM.
use std::collections::HashSet;
use crate::{app::App, fleet::Reach};

pub struct Counts { pub harnesses: usize, pub machines: usize, pub models: Option<usize> }

pub fn counts(app: &App) -> Counts {
    let owned: HashSet<_> = app.fleet.visible_machines().filter(|m| !m.shared && (m.local || m.reach != Reach::NeedsLink)).map(|m| m.id.as_str()).collect();
    let harnesses = app.fleet.agents.values().filter(|a| owned.contains(a.machine_id.as_str()) && a.status != "stopped"
        && (a.terminal_available || a.launch == "starting")
        && app.fleet.machine(&a.machine_id).is_some_and(|m| m.usable() && m.online())).count();
    let inventories: Vec<_> = app.models_view.local.iter().filter(|(m, _)| owned.contains(m.as_str())).collect();
    let models = (!inventories.is_empty()).then(|| inventories.iter().flat_map(|(_, s)| &s.models)
        .filter(|m| m.downloaded() || m.can_stop).map(|m| (m.id.trim().to_lowercase(), m.quantization().map(|q| q.to_lowercase())))
        .collect::<HashSet<_>>().len());
    Counts { harnesses, machines: owned.len(), models }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{fleet::{agent_from, Machine}, models::{LocalModel, Snapshot}};
    use serde_json::json;

    #[test]
    fn counts_live_owned_sessions_and_distinct_installed_variants() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19799, sink, (120, 32));
        app.fleet.local_id = "local".into();
        for (id, local, shared, reach) in [("local", true, false, Reach::Ready), ("remote", false, false, Reach::Ready),
            ("offline", false, false, Reach::Offline), ("unlinked", false, false, Reach::NeedsLink), ("shared", false, true, Reach::Ready)] {
            app.fleet.machines.push(Machine { id: id.into(), name: id.into(), local, shared, status: if reach == Reach::Offline { "offline" } else { "running" }.into(), reach });
        }
        for (m, id, status, launch, terminal) in [("local", "one", "running", "ready", true), ("remote", "two", "running", "starting", false),
            ("remote", "saved", "stopped", "ready", true), ("offline", "old", "running", "ready", true), ("shared", "view", "running", "ready", true)] {
            let agent = agent_from(m, &json!({"id":id,"status":status,"launch":{"state":launch},"terminal":{"available":terminal}}), None);
            app.fleet.agents.insert((m.into(), id.into()), agent);
        }
        assert_eq!(counts(&app).harnesses, 2);
        assert_eq!(counts(&app).machines, 3);
        assert_eq!(counts(&app).models, None);
        let model = |id: &str, q: &str, state: &str| LocalModel { id: id.into(), quant: Some(q.into()), state: state.into(), ..Default::default() };
        app.models_view.local.insert("local".into(), Snapshot { models: vec![model("Qwen", "Q4", "downloaded"), model("catalog", "Q4", "available")], ..Default::default() });
        app.models_view.local.insert("remote".into(), Snapshot { models: vec![model(" qwen ", "q4", "running"), model("Qwen", "Q8", "downloaded")], ..Default::default() });
        app.models_view.local.insert("shared".into(), Snapshot { models: vec![model("Shared", "Q4", "running")], ..Default::default() });
        assert_eq!(counts(&app).models, Some(2));
    }
}
