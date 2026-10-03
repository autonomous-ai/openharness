//! A daemon can acquire a new identity after sign-in without hn exiting. Treat that
//! transition explicitly: first sign-in keeps local work; a different account gets
//! its own desk, inventories and in-flight requests. No process is stopped here.
use super::*;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Identity { machine: String, #[serde(default)] local_only: bool }

fn identity(value: &Value) -> Option<Identity> {
    serde_json::from_value::<Identity>(value.clone()).ok().filter(|id| !id.machine.is_empty() && !crate::local::is_local(&id.machine))
}

fn remove_views(tabs: &mut Vec<Tab>, removed: &HashSet<u64>) {
    tabs.retain_mut(|tab| {
        let had_panes = tab.root.is_some();
        for id in removed {
            if !tab.panes().contains(id) { continue }
            tab.lose(*id);
            tab.root = tab.root.take().and_then(|root| root.remove(*id));
        }
        if tab.root.is_none() { tab.focus = None; tab.zoomed = false; }
        !had_panes || tab.root.is_some()
    });
    if tabs.is_empty() { tabs.push(Tab::home()); }
}

impl App {
    pub(super) fn saved_identity(&self) -> Value { json!(self.daemon_identity) }

    pub(super) fn reconcile_account_machines(&mut self, rows: &[Value], stale: bool) {
        let ids: HashSet<_> = rows.iter().filter_map(|r| r["machineId"].as_str()).collect();
        // A cache used during a backend outage cannot undo a confirmed removal.
        if !stale { self.removed_machines.retain(|id| !ids.contains(id.as_str())); }
        let removed: Vec<_> = self.fleet.machines.iter().filter(|m| !m.local && !crate::local::is_local(&m.id) && !ids.contains(m.id.as_str())).map(|m| m.id.clone()).collect();
        for machine in removed { self.forget_account_machine(&machine); }
    }

    /// Removing a computer closes its local views and data connection, never its agents.
    /// This also invalidates callbacks and menus captured before the inventory changed.
    pub(crate) fn forget_account_machine(&mut self, machine: &str) {
        if machine == self.fleet.local_id || crate::local::is_local(machine) { return }
        self.removed_machines.insert(machine.into());
        let removed: HashSet<_> = self.panes.iter().filter(|(_, p)| p.machine_id == machine).map(|(id, _)| *id).collect();
        let front = self.tab().id.clone();
        remove_views(&mut self.tabs, &removed);
        self.active = self.tabs.iter().position(|t| t.id == front).unwrap_or(0);
        for session in &mut self.sessions {
            let active = session.tabs.get(session.active).map(|t| t.id.clone());
            remove_views(&mut session.tabs, &removed);
            session.active = active.and_then(|id| session.tabs.iter().position(|t| t.id == id)).unwrap_or(0);
            session.lastw.retain(|id| session.tabs.iter().any(|t| &t.id == id));
            session.nums.retain(|id, _| session.tabs.iter().any(|t| &t.id == id));
        }
        for pane in removed { self.drop_pane(pane); }
        self.lastw.retain(|id| self.tabs.iter().any(|t| &t.id == id));
        self.nums.retain(|id, _| self.tabs.iter().any(|t| &t.id == id));
        if let Some(mut state) = self.links.remove(machine) { if let Some(link) = state.link.take() { link.close(); } }
        self.fleet.machines.retain(|m| m.id != machine);
        self.fleet.agents.retain(|(m, _), _| m != machine);
        self.shells.retain(|(m, _)| m != machine);
        self.homes.remove(machine); self.usage.remove(machine); self.rtt.remove(machine);
        self.pending_questions.retain(|(m, _, _)| m != machine);
        self.home_order.borrow_mut().clear(); self.fleet_marked = false;
        self.fit_panes(); self.redraw_all = true; self.server_dirty = true;
    }

    pub(crate) fn account_machine_removed(&mut self, machine: &str) {
        // An older in-flight list may still contain the machine whose delete just committed.
        self.machines_request = self.machines_request.wrapping_add(1);
        self.forget_account_machine(machine);
    }

    /// Session files predate account-aware restoration. The roster's public owner ID
    /// identifies those older files without reading credentials or adopting its agents.
    pub(super) fn restore_saved_identity(&mut self, doc: &Value) {
        if self.daemon_identity.is_some() { return }
        self.daemon_identity = identity(&doc["harnessIdentity"]).or_else(|| {
            doc["sessions"].as_array().into_iter().flatten().find_map(|r| identity(&r["harnessIdentity"]))
        }).or_else(|| crate::fleet::cached_owner().map(|machine| Identity { machine, local_only:false }));
    }

    /// Other hn clients may still advertise a session from the previous account.
    /// Keep local PTYs and local work across sign-in/sign-out; distinct accounts stay separate.
    pub(crate) fn scoped_window(&self, win: &Value) -> Option<Value> {
        let mut win = win.clone();
        let old = identity(&win["harnessIdentity"]);
        let changed = old.as_ref().zip(self.daemon_identity.as_ref()).filter(|(old, current)| old.machine != current.machine);
        let removed = win["panes"].as_array().into_iter().flatten().any(|pane| pane.get(0).and_then(Value::as_str).is_some_and(|id| self.removed_machines.contains(id)));
        if changed.is_none() && !removed { return Some(win) }
        let original = win["panes"].as_array()?.clone();
        let kept: Vec<_> = original.iter().enumerate().filter_map(|(i, pane)| {
            let host = pane.get(0)?.as_str()?;
            if self.removed_machines.contains(host) { return None }
            if crate::local::is_local(host) { return Some((i, pane.clone())) }
            let Some((old, current)) = changed else { return Some((i, pane.clone())) };
            if !(old.local_only || current.local_only) || host != old.machine { return None }
            let mut pane = pane.clone(); pane[0] = json!(current.machine); Some((i, pane))
        }).collect();
        if kept.is_empty() { return None }
        if kept.len() != original.len() {
            let ids: Vec<_> = original.iter().enumerate().map(|(i, p)| p.get(3).and_then(Value::as_u64).unwrap_or(i as u64 + 1)).collect();
            let layout = win["layout"].as_str().unwrap_or_default();
            let (w, h) = Node::tmux_size(layout).unwrap_or(self.size);
            let mut root = Node::from_tmux(layout, &ids, w, h);
            for (_, id) in ids.into_iter().enumerate().filter(|(index, _)| !kept.iter().any(|(i, _)| i == index)) {
                root = root.and_then(|root| root.remove(id));
            }
            win["layout"] = json!(root.map(|root| root.to_tmux()).unwrap_or_default());
            let focus = win["focus"].as_u64().unwrap_or(0) as usize;
            win["focus"] = json!(kept.iter().position(|(i, _)| *i == focus).unwrap_or(0));
            win["zoomed"] = json!(win["zoomed"] == true && kept.len() > 1);
        }
        win["panes"] = json!(kept.into_iter().map(|(_, p)| p).collect::<Vec<_>>());
        win["harnessIdentity"] = self.saved_identity();
        Some(win)
    }

    pub(crate) fn scoped_session(&self, row: &Value) -> Option<Value> {
        let mut row = row.clone();
        let Some(current) = &self.daemon_identity else { return Some(row) };
        let old = identity(&row["harnessIdentity"]);
        let different = old.as_ref().is_some_and(|old| old.machine != current.machine)
            || row["windows"].as_array().into_iter().flatten().any(|win| identity(&win["harnessIdentity"]).is_some_and(|old| old.machine != current.machine));
        let removed = row["windows"].as_array().into_iter().flatten().flat_map(|win| win["panes"].as_array().into_iter().flatten()).any(|pane| pane.get(0).and_then(Value::as_str).is_some_and(|id| self.removed_machines.contains(id)));
        if different || removed {
            if different && row["desk"] == true { return None }
            let original = row["windows"].as_array()?;
            let kept: Vec<_> = original.iter().enumerate().filter_map(|(i, win)| {
                let mut win = win.clone();
                if identity(&win["harnessIdentity"]).is_none() { win["harnessIdentity"] = json!(old); }
                self.scoped_window(&win).map(|win| (i, win))
            }).collect();
            if kept.is_empty() { return None }
            let active = row["active"].as_u64().unwrap_or(0) as usize;
            let last: Vec<_> = row["last"].as_array().into_iter().flatten().filter_map(|n| kept.iter().position(|(i, _)| Some(*i as u64) == n.as_u64())).collect();
            row["active"] = json!(kept.iter().position(|(i, _)| *i == active).unwrap_or(0));
            row["last"] = json!(last);
            row["windows"] = json!(kept.into_iter().map(|(_, win)| win).collect::<Vec<_>>());
            row["harnessIdentity"] = self.saved_identity();
        }
        Some(row)
    }

    pub(super) fn adopt_daemon_identity(&mut self, status: &Value) {
        let Some(machine) = status["machineId"].as_str().filter(|id| !id.is_empty()) else { return };
        if self.daemon_identity.as_ref().is_some_and(|old| old.machine == machine) { return }
        // signedIn is read live from the credentials, before the old daemon has necessarily
        // restarted. Its computerId still identifies the anonymous daemon in that interval.
        let local_only = status["signedIn"] == false || status["computerId"].as_str() == Some(machine);
        let next = Identity { machine:machine.into(), local_only };
        let Some(old) = self.daemon_identity.replace(next) else { return };
        self.account_epoch = self.account_epoch.wrapping_add(1);
        self.removed_machines.clear();
        let migrate = (old.local_only || local_only || status["computerId"].as_str() == Some(old.machine.as_str())).then_some(old.machine.as_str());

        crate::mirror::leave(self);
        self.mirror = None; self.mirror_attached = 0;
        for session in &mut self.sessions { session.mirror = None; }
        self.remote.borrow_mut().stamp = None;
        self.sessions_sig.clear();

        let links: Vec<_> = self.links.keys().filter(|m| !crate::local::is_local(m)).cloned().collect();
        for id in links { if let Some(mut state) = self.links.remove(&id) { if let Some(link) = state.link.take() { link.close(); } } }
        let mut removed = HashSet::new();
        for (id, pane) in &mut self.panes {
            if migrate == Some(pane.machine_id.as_str()) {
                pane.machine_id = machine.into();
                pane.stream = None; pane.opening = false; pane.open_token = pane.open_token.wrapping_add(1);
                pane.takeover_pending = false; pane.phase = Phase::Connecting("Connecting to your account…".into()); pane.dirty = true;
                crate::ids::desk_set(crate::ids::Kind::Pane, &format!("{machine}:{}", pane.agent_id), *id);
            } else if !crate::local::is_local(&pane.machine_id) { removed.insert(*id); }
        }
        let front_had_views = self.tabs.iter().any(|t| t.root.is_some());
        let front = self.tab().id.clone();
        remove_views(&mut self.tabs, &removed);
        self.active = self.tabs.iter().position(|t| t.id == front).unwrap_or(0);
        for session in &mut self.sessions {
            let front = session.tabs.get(session.active).map(|t| t.id.clone());
            remove_views(&mut session.tabs, &removed);
            session.active = front.and_then(|id| session.tabs.iter().position(|t| t.id == id)).unwrap_or(0);
            session.lastw.retain(|id| session.tabs.iter().any(|t| &t.id == id));
            session.nums.retain(|id, _| session.tabs.iter().any(|t| &t.id == id));
        }
        for id in removed { self.drop_pane(id); }
        self.lastw.retain(|id| self.tabs.iter().any(|t| &t.id == id));
        self.nums.retain(|id, _| self.tabs.iter().any(|t| &t.id == id));
        self.shells = self.shells.drain().filter_map(|(m, a)| {
            if migrate == Some(m.as_str()) { Some((machine.to_string(), a)) }
            else { crate::local::is_local(&m).then_some((m, a)) }
        }).collect();
        let old_local = self.fleet.machine(&old.machine).cloned();
        let mut kept = HashMap::new();
        for ((m, id), mut agent) in self.fleet.agents.drain() {
            if migrate == Some(m.as_str()) { agent.machine_id = machine.into(); kept.insert((machine.into(), id), agent); }
            else if crate::local::is_local(&m) { kept.insert((m, id), agent); }
        }
        self.fleet.agents = kept;
        self.fleet.machines.retain(|m| crate::local::is_local(&m.id));
        if let Some(mut host) = old_local { host.id = machine.into(); host.local = true; host.shared = false; host.reach = Reach::Unknown; self.fleet.machines.insert(0, host); }
        self.fleet.local_id = machine.into();

        self.local_tabs_to_sync.clear();
        for (desk, tabs) in std::iter::once((self.session_desk, &mut self.tabs)).chain(self.sessions.iter_mut().map(|s| (s.desk, &mut s.tabs))) {
            for tab in tabs {
                tab.on_desk = false; tab.desk_panes.clear(); tab.desk_layout = json!({});
                if migrate.is_some() && desk && tab.panes().iter().any(|id| self.panes.get(id).is_some_and(|p| p.machine_id == machine)) {
                    self.local_tabs_to_sync.insert(tab.id.clone());
                }
            }
        }
        self.desk_revision = -1; self.desk_loaded = false; self.desk_answered = false;
        self.desk_inflight = false; self.desk_stale = false; self.desk_no_tmux = false;
        self.desk_pending.clear(); self.desk_layouts.clear(); self.desk_acked_layouts.clear();
        self.desk_windows_saved.clear(); self.desk_active_saved = None;
        self.orphans.clear(); self.orphan_exits.clear(); self.last_focus_sent = None;
        self.recent.clear(); self.home_external.clear(); self.said.clear(); self.said_for.clear(); self.said_want.clear();
        self.said_generation = self.said_generation.wrapping_add(1); self.said_pending = 0; self.said_due = None;
        self.tails.clear(); self.tails_asked.clear(); self.pending_questions.clear();
        self.dsh.clear(); self.rtt.clear(); self.homes.clear(); self.usage.clear(); self.usage_checked = None;
        self.prs.clear(); self.pr_asking.clear(); self.prs_read = None; self.seen_rostered.clear(); self.enriching = 0;
        self.home_order.borrow_mut().clear(); self.fleet_marked = false;
        self.agent_errors.clear(); self.launch_failed = None; self.away = None;
        self.last_harness = None; self.loop_pane = None; self.loop_seen.clear();
        self.session_close = Default::default(); self.agent_switch = Default::default();
        self.hardware = Default::default(); self.controls = Default::default(); self.dial = Default::default();
        let runner = self.devices.runner.take(); self.devices = Default::default(); self.devices.runner = runner;
        crate::new_harness::account_changed(self, migrate, machine);
        if migrate.is_none() {
            // A saved ordinary session may have been the previous account's only view.
            // Return to this account's desk instead of leaving that empty session selected.
            if !self.session_desk && front_had_views && self.tabs.iter().all(|t| t.root.is_none()) {
                self.session_group = None;
                if let Some(id) = self.sessions.iter().find(|s| s.desk).map(|s| s.id) { self.swap_session(id); }
                else { self.session_alias = None; self.session_path = None; }
            }
            self.sessions.retain(|s| s.desk || s.tabs.iter().any(|t| t.root.is_some()));
            if self.session_desk { self.session_alias = None; self.session_path = None; }
            for session in &mut self.sessions { if session.desk { session.alias = None; session.path = None; } }
        }
        if !matches!(self.modal, Some(Modal::NewHarness(_)) | Some(Modal::Picker { kind:crate::modal::PickerKind::Account, .. })) { self.modal = None; }
        crate::account::identity_changed(self);
        crate::models::account_changed(self);
        self.fit_panes(); self.redraw_all = true; self.server_dirty = true;
    }

    /// Join the signed-in desk only after reading its baseline. Local tabs keep their
    /// window/pane identities and geometry, and do not overwrite the account's other tabs.
    pub(super) fn sync_local_tabs_after_sign_in(&mut self) {
        if self.local_tabs_to_sync.is_empty() || self.desk_mode != DeskMode::Sync || !self.session_desk { return }
        let ids = std::mem::take(&mut self.local_tabs_to_sync);
        let mut ops = Vec::new(); let mut agents = HashSet::new();
        for (index, tab) in self.tabs.iter_mut().enumerate().filter(|(_, t)| ids.contains(&t.id)) {
            // A standalone PTY is local to hn, even if it shares a tab with a daemon pane.
            if tab.panes().iter().any(|id| self.panes.get(id).is_some_and(|p| crate::local::is_local(&p.machine_id))) { continue }
            let panes: Vec<_> = tab.panes().iter().filter_map(|id| self.panes.get(id)).filter(|p| !crate::local::is_local(&p.machine_id)).collect();
            if panes.is_empty() { continue }
            tab.on_desk = true;
            ops.push(json!({"op":"tab.create","id":tab.id,"name":tab.name,"nameIsCustom":tab.named,"index":index}));
            for (at, pane) in panes.iter().enumerate() {
                ops.push(json!({"op":"pane.add","tabId":tab.id,"machineId":pane.machine_id,"agentId":pane.agent_id,"index":at}));
                agents.insert((pane.machine_id.clone(), pane.agent_id.clone()));
            }
            if let Some(root) = &tab.root {
                if !tab.layout.is_object() { tab.layout = json!({}); }
                tab.layout["tmux"] = json!(root.to_tmux());
                crate::desk_layout::Geometry::capture(root).write(&mut tab.layout);
                ops.push(json!({"op":"tab.layout","id":tab.id,"layout":tab.layout}));
            }
        }
        for (machine, agent) in agents { crate::agent_switch::retain_placement(self, &machine, &agent, &ops); }
        self.desk_ops(ops);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(machine: &str, signed_in: bool) -> Value { json!({"machineId":machine,"computerId":"computer","signedIn":signed_in}) }
    fn app(machine: &str, signed_in: bool) -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(0, sink, (100, 30));
        app.desk_mode = DeskMode::Sync; app.session_desk = true;
        app.fleet.local_id = machine.into();
        app.fleet.machines.push(Machine { id:machine.into(), name:"Studio".into(), local:true, shared:false, status:"running".into(), reach:Reach::Ready });
        app.adopt_daemon_identity(&status(machine, signed_in));
        app.tabs.clear();
        for (id, host, name) in [(1, machine, "Local work"), (2, "remote-old", "Old remote work"), (3, crate::local::MACHINE, "Local shell")] {
            let agent_id = format!("a{id}");
            app.fleet.agents.insert((host.into(), agent_id.clone()), fleet::agent_from(host, &json!({"id":agent_id,"engine":"codex","name":name}), None));
            app.panes.insert(id, Pane::new(id, host, &agent_id, 100, 29));
            let mut tab = Tab::with_wid(name, id); tab.id = format!("tab-{id}"); tab.root = Some(Node::new(id, 100, 29)); tab.focus = Some(id);
            tab.on_desk = id != 3; app.tabs.push(tab);
        }
        app.desk_revision = 900; app.desk_loaded = true; app.desk_inflight = true;
        app.desk_pending.push(json!({"op":"tab.rename","id":"old-tab","name":"Never replay"}));
        app
    }

    #[tokio::test]
    async fn removed_computers_leave_no_live_views_or_counts_and_cached_lists_cannot_restore_them() {
        let mut app = app("account-a", true);
        app.fleet.machines.push(Machine { id:"remote-old".into(), name:"Removed computer".into(), local:false, shared:false, status:"online".into(), reach:Reach::Ready });
        app.active = 1;
        let before = crate::workspace_resources::counts(&app).machines;
        let operations = app.desk_pending.clone();
        app.reconcile_account_machines(&[json!({"machineId":"account-a"})], false);
        assert!(app.fleet.machine("remote-old").is_none());
        assert!(!app.panes.contains_key(&2));
        assert!(app.panes.contains_key(&1) && app.panes.contains_key(&3));
        assert_eq!(app.focused(), Some(1));
        assert_eq!(crate::workspace_resources::counts(&app).machines, before - 1);
        assert_eq!(app.desk_pending, operations, "inventory removal never stops agents or writes the desk");
        let stale_desk = json!({"revision":901,"tabs":[{"id":"old-tab","name":"Old remote work","panes":[{"machineId":"remote-old","agentId":"a2"}]}]});
        app.apply_desk(&stale_desk);
        assert!(!app.panes.values().any(|p| p.machine_id == "remote-old"));
        let rows = vec![json!({"machineId":"account-a"}), json!({"machineId":"remote-old"})];
        app.reconcile_account_machines(&rows, true);
        assert!(app.removed_machines.contains("remote-old"));
        app.reconcile_account_machines(&rows, false);
        assert!(!app.removed_machines.contains("remote-old"), "a fresh inventory can make the computer available again");
        app.account_machine_removed("remote-old");
        assert_eq!(app.machines_request, 1, "a confirmed delete invalidates older list reads");
        app.account_machine_removed("account-a");
        assert!(app.fleet.machine("account-a").is_some(), "inventory cannot remove this computer's local transport");
    }

    #[tokio::test]
    async fn first_sign_in_keeps_local_pane_geometry_then_joins_the_new_desk() {
        let mut app = app("computer", false);
        let layout = app.tabs[0].root.as_ref().unwrap().to_tmux();
        app.adopt_daemon_identity(&status("account-a", true));
        assert_eq!(app.account_epoch, 1);
        assert_eq!(app.panes[&1].machine_id, "account-a");
        assert_eq!(app.tabs[0].root.as_ref().unwrap().to_tmux(), layout);
        assert_eq!(app.tab().id, "tab-1");
        assert!(!app.panes.contains_key(&2)); assert!(app.panes.contains_key(&3));
        assert!(app.desk_pending.is_empty() && !app.desk_inflight);
        assert_eq!(app.desk_revision, -1);
        app.apply_desk(&json!({"revision":1,"tabs":[{"id":"account-tab","name":"Other computer","panes":[{"machineId":"account-remote","agentId":"remote-agent"}],"layout":{}}]}));
        assert_eq!(app.tab().id, "tab-1", "reading the account's desk does not steal focus");
        assert!(app.tabs.iter().any(|t| t.id == "account-tab"));
        assert!(app.tabs.iter().any(|t| t.id == "tab-1" && t.on_desk));
        assert!(!app.tabs.iter().find(|t| t.id == "tab-3").unwrap().on_desk);
        assert!(app.local_tabs_to_sync.is_empty());
        assert!(crate::agent_switch::preserves(&app, 1), "local view stays until the new desk confirms it");
    }

    #[test]
    fn changing_accounts_drops_old_views_and_requests_but_never_stops_a_local_pty() {
        let mut app = app("account-a", true);
        app.recent.insert(("remote-old".into(), "a2".into()), json!({"private":"old account"}));
        app.adopt_daemon_identity(&status("account-b", true));
        assert_eq!(app.panes.keys().copied().collect::<Vec<_>>(), [3]);
        assert_eq!(app.fleet.local_id, "account-b");
        assert!(app.recent.is_empty() && app.desk_pending.is_empty());
        assert!(app.local_tabs_to_sync.is_empty());
        assert!(!app.quit); assert_eq!(app.tabs[0].name, "Local shell");
        assert!(app.fleet.agents.keys().all(|(m, _)| crate::local::is_local(m)));
        assert!(app.links.is_empty());
    }

    #[test]
    fn signing_out_keeps_this_computers_work_and_leaves_remote_account_views() {
        let mut app = app("account-a", true);
        app.adopt_daemon_identity(&status("computer", false));
        assert_eq!(app.panes[&1].machine_id, "computer");
        assert!(!app.panes.contains_key(&2));
        assert!(app.panes.contains_key(&3));
        assert_eq!(app.tab().id, "tab-1");
        assert!(!app.quit);
    }

    #[test]
    fn temporary_daemon_loss_and_live_signed_in_flag_do_not_change_the_identity() {
        let mut app = app("computer", false);
        app.fleet.local_id = crate::local::MACHINE.into();
        app.adopt_daemon_identity(&status("computer", true));
        assert_eq!(app.account_epoch, 0);
        assert!(app.panes.contains_key(&1));
        app.adopt_daemon_identity(&status("account-a", true));
        assert_eq!(app.panes[&1].machine_id, "account-a");
        assert_eq!(app.account_epoch, 1);
    }

    #[test]
    fn saved_identity_protects_the_first_boot_after_an_account_change() {
        let mut app = app("account-a", true);
        let saved = json!({"harnessIdentity":app.saved_identity(),"sessions":[]});
        app.daemon_identity = None;
        app.restore_saved_identity(&saved);
        app.adopt_daemon_identity(&status("account-b", true));
        assert!(!app.panes.contains_key(&1) && !app.panes.contains_key(&2));
        assert!(app.panes.contains_key(&3));
        assert_eq!(app.account_epoch, 1);
        assert_eq!(app.saved_identity()["machine"], "account-b");
    }

    #[test]
    fn importing_old_account_sessions_keeps_only_local_shells_and_their_geometry() {
        let mut app = app("account-a", true);
        let private = app.window_json(&app.tabs[0], Some(0));
        let mut mixed = app.window_json(&app.tabs[2], Some(1));
        let mut root = Node::new(3, 100, 30);
        assert!(root.split(3, 1, Dir::Horizontal));
        assert!(root.split(3, 2, Dir::Vertical));
        mixed["panes"] = json!([[crate::local::MACHINE,"a3",true,3],["account-a","a1",false,1],["remote-old","a2",false,2]]);
        mixed["layout"] = json!(root.to_tmux()); mixed["focus"] = json!(2); mixed["zoomed"] = json!(true);
        let row = json!({"name":"work","harnessIdentity":app.saved_identity(),"windows":[private,mixed],"active":1,"last":[0,1]});
        app.adopt_daemon_identity(&status("account-b", true));
        let scoped = app.scoped_session(&row).unwrap();
        let wins = scoped["windows"].as_array().unwrap();
        assert_eq!(wins.len(), 1);
        assert_eq!(wins[0]["panes"], json!([[crate::local::MACHINE,"a3",true,3]]));
        assert_eq!(wins[0]["focus"], 0); assert_eq!(wins[0]["zoomed"], false);
        assert_eq!(scoped["active"], 0); assert_eq!(scoped["last"], json!([0]));
        let layout = Node::from_tmux(wins[0]["layout"].as_str().unwrap(), &[3], 100, 30).unwrap();
        assert_eq!(layout.to_tmux(), Node::new(3, 100, 30).to_tmux());
        assert!(app.scoped_window(&row["windows"][0]).is_none());
        assert!(app.tab_from_json(&row["windows"][0]).is_none());
        assert!(app.scoped_session(&json!({"harnessIdentity":row["harnessIdentity"],"desk":true})).is_none());
    }

    #[test]
    fn another_clients_anonymous_session_can_join_but_its_remote_views_cannot() {
        let mut app = app("computer", false);
        let row = json!({"name":"local work","harnessIdentity":app.saved_identity(),"windows":[app.window_json(&app.tabs[0],Some(0)), app.window_json(&app.tabs[1],Some(1))]});
        app.adopt_daemon_identity(&status("account-a", true));
        let scoped = app.scoped_session(&row).unwrap();
        assert_eq!(scoped["windows"].as_array().unwrap().len(), 1);
        assert_eq!(scoped["windows"][0]["panes"][0][0], "account-a");
        assert_eq!(scoped["windows"][0]["panes"][0][3], 1);
        assert_eq!(scoped["harnessIdentity"], app.saved_identity());
        assert_eq!(scoped["windows"][0]["layout"], row["windows"][0]["layout"]);
    }
}
