//! Physical Harness devices, addressed through their owned host's existing connection.
//! Values are observations from firmware. A successful RPC alone does not confirm a write.
use std::{collections::HashMap, time::{Duration, Instant}};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::text::Line;
use serde_json::{Value, json};
use crate::{app::App, daemon::RpcError, modal::{Modal, PickerKind}, picker::{Picker, Row}};

const LANGUAGES: &[(&str, &str)] = &[("en", "English"), ("vi", "Tiếng Việt"), ("es", "Español"), ("fr", "Français"), ("ja", "日本語"), ("it", "Italiano")];
fn text(value: &Value, key: &str) -> String { value[key].as_str().unwrap_or("").into() }
fn clean(s: &str) -> String { s.chars().filter(|c| !c.is_control()).collect() }

#[derive(Clone)]
struct Device { key: String, machine: String, id: String, mac: String, attached: bool, updating: String, firmware: String, hardware: String, settings: Option<Value> }

#[derive(Default)]
struct Host { generation: Option<u64>, revision: Option<u64>, observed: u64, available: bool, reading: bool, error: String, read_at: Option<Instant> }

#[derive(Clone)]
struct Selection { key: String, machine: String, id: String, mac: String, owner: String, generation: Option<u64> }

impl Selection {
    fn connection_matches(&self, app: &App) -> bool {
        self.owner == app.fleet.local_id && self.generation == app.connection_generation(&self.machine)
            && app.fleet.machine(&self.machine).is_some_and(|m| !m.shared && m.usable() && m.online())
    }
    fn matches(&self, app: &App) -> bool {
        self.connection_matches(app) && app.hardware.devices.get(&self.key).is_some_and(|d| d.id == self.id && d.mac == self.mac)
    }
}

struct Pending { token: String, selection: Selection, patch: Value, since: Instant }

#[derive(Default)]
pub struct State {
    owner: String,
    hosts: HashMap<String, Host>,
    devices: HashMap<String, Device>,
    selection: Option<Selection>,
    field: Option<&'static str>,
    pending: HashMap<String, Pending>,
    errors: HashMap<String, String>,
    #[cfg(test)]
    pub sent: Vec<(String, String, Value)>,
}

fn reconcile(app: &mut App) {
    if app.hardware.owner != app.fleet.local_id {
        app.hardware = State { owner: app.fleet.local_id.clone(), ..Default::default() };
    }
    let owned: Vec<_> = app.fleet.visible_machines().filter(|m| !m.shared).map(|m| (m.id.clone(), m.usable() && m.online(), app.connection_generation(&m.id))).collect();
    app.hardware.hosts.retain(|id, _| owned.iter().any(|(m, _, _)| m == id));
    app.hardware.devices.retain(|_, d| owned.iter().any(|(m, _, _)| m == &d.machine));
    for (id, online, generation) in owned {
        let host = app.hardware.hosts.entry(id.clone()).or_default();
        if host.generation != generation || !online {
            host.available = false; host.reading = false; host.revision = None; host.read_at = None;
            host.generation = generation;
            for device in app.hardware.devices.values_mut().filter(|d| d.machine == id) { device.attached = false; }
        }
    }
    settle(app);
}

fn settings(v: &Value) -> Option<Value> {
    if !["brightness", "character", "face"].iter().all(|k| v[*k].is_number()) || !v["voiceLang"].is_string()
        || !["muted", "quiet", "straightTitle", "focusFace", "scrollReversed", "round"].iter().all(|k| v[*k].is_boolean()) { return None }
    let brightness = v["brightness"].as_f64()?.round().clamp(0.0, 100.0) as u64;
    let mut held = v.clone(); held["brightness"] = json!(brightness); Some(held)
}

/// [read_observed] prevents a response sent before a push from overwriting that newer push.
fn receive(app: &mut App, machine: &str, status: &Value, revision: Option<u64>, read_observed: Option<u64>) -> bool {
    if !status.is_object() || !status["attached"].is_boolean() { return false }
    let Some(host) = app.hardware.hosts.get_mut(machine) else { return false };
    if read_observed.is_some_and(|n| n != host.observed) || revision.zip(host.revision).is_some_and(|(new, old)| new < old) { return true }
    host.observed = host.observed.wrapping_add(1);
    host.revision = revision.or(host.revision);
    host.available = true; host.error.clear();
    let list = status["devices"].as_array().filter(|a| !a.is_empty()).cloned().unwrap_or_else(|| {
        if status["attached"] == true || status["settings"].is_object() { vec![status.clone()] } else { vec![] }
    });
    let mut seen = Vec::new();
    for value in list {
        if !value.is_object() { continue }
        let id = text(&value, "id"); let mac = text(&value, "mac").to_lowercase();
        // When a greeting adds the MAC, retain the selection's key; host identity is mandatory.
        let known = app.hardware.devices.values().find(|d| d.machine == machine && ((!mac.is_empty() && d.mac == mac) || (!id.is_empty() && d.id == id))).cloned();
        let key = known.as_ref().map(|d| d.key.clone()).unwrap_or_else(|| serde_json::to_string(&(machine, if !mac.is_empty() { format!("mac:{mac}") } else { format!("usb:{id}") })).unwrap());
        seen.push(key.clone());
        let attached = value["attached"] == true;
        let setting = settings(&value["settings"]).or_else(|| if !attached { known.as_ref().and_then(|d| d.settings.clone()) } else { None });
        app.hardware.devices.insert(key.clone(), Device { key, machine: machine.into(), id,
            mac: if mac.is_empty() { known.as_ref().map(|d| d.mac.clone()).unwrap_or_default() } else { mac }, attached,
            updating: text(&value, "updating"), firmware: text(&value, "fw"), hardware: text(&value, "hw"), settings: setting });
    }
    for d in app.hardware.devices.values_mut().filter(|d| d.machine == machine && !seen.contains(&d.key)) { d.attached = false; d.updating.clear(); }
    settle(app);
    crate::input::refill(app);
    true
}

pub fn push(app: &mut App, machine: &str, ty: &str, payload: &Value) {
    reconcile(app);
    if app.fleet.machine(machine).is_none_or(|m| m.shared || !m.usable() || !m.online()) { return }
    if ty == "dial_status" {
        if machine == app.fleet.local_id { receive(app, machine, payload, None, None); }
    } else { receive(app, machine, &payload["status"], payload["revision"].as_u64(), None); }
}

fn rpc(app: &mut App, machine: &str, ty: &str, payload: Value, seconds: u64, then: impl FnOnce(&mut App, Result<Value, RpcError>) + Send + 'static) -> bool {
    #[cfg(test)] { let _ = (seconds, then); app.hardware.sent.push((machine.into(), ty.into(), payload)); true }
    #[cfg(not(test))] {
        let Some(link) = app.link(machine) else { return false };
        let ty = ty.to_string();
        app.spawn(async move { link.rpc(&ty, payload, Duration::from_secs(seconds)).await }, then);
        true
    }
}

fn refresh_host(app: &mut App, machine: &str) {
    let owner = app.fleet.local_id.clone(); let generation = app.connection_generation(machine);
    let Some(host) = app.hardware.hosts.get_mut(machine) else { return };
    if host.reading { return }
    host.reading = true; let observed = host.observed; let id = machine.to_string();
    if !rpc(app, machine, "harness_devices_list", json!({}), 5, move |app, reply| {
        if app.fleet.local_id != owner || app.connection_generation(&id) != generation { return }
        read_reply(app, &id, observed, reply);
    }) { read_reply(app, machine, observed, Err(RpcError { code:"OFFLINE".into(), detail:"Reconnect this machine to read its devices.".into() })); }
}

fn read_reply(app: &mut App, machine: &str, observed: u64, reply: Result<Value, RpcError>) {
    let Some(host) = app.hardware.hosts.get_mut(machine) else { return };
    host.reading = false; host.read_at = Some(Instant::now());
    let valid = match &reply { Ok(r) => receive(app, machine, &r["status"], r["revision"].as_u64(), Some(observed)), _ => false };
    if !valid {
        if let Some(host) = app.hardware.hosts.get_mut(machine) {
            // A push received while this request was in flight is a newer successful reading.
            if host.observed == observed {
                host.available = false;
                host.error = if reply.as_ref().is_err_and(|e| e.code == "UNSUPPORTED") { "Update Harness on this machine to manage its devices." } else { "Could not read devices. Reconnect or refresh to try again." }.into();
            }
        }
        settle(app); crate::input::refill(app);
    }
}

pub fn refresh(app: &mut App) {
    reconcile(app);
    let machines: Vec<_> = app.fleet.visible_machines().filter(|m| !m.shared && m.usable() && m.online()).map(|m| m.id.clone()).collect();
    for machine in machines { refresh_host(app, &machine); }
}

pub fn open(app: &mut App) {
    reconcile(app); app.hardware.selection = None; app.hardware.field = None;
    crate::input::picker(app, PickerKind::Hardware, "Devices", "Search devices and computers");
    refresh(app);
}

fn can_edit(app: &App, selection: &Selection) -> bool {
    !app.read_only() && selection.matches(app) && !selection.id.is_empty()
        && app.hardware.hosts.get(&selection.machine).is_some_and(|h| h.available)
        && app.hardware.devices.get(&selection.key).is_some_and(|d| d.attached && d.updating.is_empty() && d.settings.is_some())
}

fn state(app: &App, d: &Device) -> &'static str {
    if app.fleet.machine(&d.machine).is_none_or(|m| !m.usable() || !m.online()) { "Computer offline" }
    else if app.hardware.hosts.get(&d.machine).is_none_or(|h| !h.available) { "Unavailable" }
    else if !d.updating.is_empty() { "Updating" }
    else if d.attached { "Connected" } else { "Disconnected" }
}

fn info(id: &str, label: impl Into<String>) -> Row { let mut row = Row::new(id, label); row.disabled = true; row }
fn language(code: &str) -> &str { LANGUAGES.iter().find(|(c, _)| *c == code).map(|(_, name)| *name).unwrap_or(code) }
fn title(app: &App, d: &Device) -> String {
    let identity = if !d.mac.is_empty() { &d.mac } else if !d.id.is_empty() { &d.id } else { "Device" };
    format!("{} · {}", app.fleet.machine_name(&d.machine), clean(identity))
}

pub fn fill(app: &App, picker: &mut Picker) {
    let mut rows = Vec::new();
    if let Some(selection) = &app.hardware.selection {
        rows.push(Row::new("back", if app.hardware.field.is_some() { "Back to device" } else { "Back to Devices" }));
        if let Some(d) = app.hardware.devices.get(&selection.key) {
            picker.title = title(app, d);
            let editable = can_edit(app, selection) && !app.hardware.pending.contains_key(&d.key);
            if let Some(held) = &d.settings {
                match app.hardware.field {
                    Some("brightness") => {
                        // Firmware may report a value between our steps. Enter on the current
                        // value must preserve it, including values such as 33%.
                        let mut values: Vec<u64> = (0..=100).step_by(5).collect();
                        if let Some(current) = held["brightness"].as_u64() { values.push(current); values.sort_unstable(); values.dedup(); }
                        for value in values { rows.push(Row::new(format!("brightness:{value}"), format!("{value}%")).right(if held["brightness"] == value { "Current" } else { "" })); }
                    }
                    Some("voiceLang") => {
                        for (code, label) in LANGUAGES { rows.push(Row::new(format!("language:{code}"), *label).right(if held["voiceLang"] == *code { "Current" } else { "" })); }
                        let code = text(held, "voiceLang");
                        if !LANGUAGES.iter().any(|(c, _)| *c == code) { rows.push(info("language-current", format!("{} (current)", clean(&code)))); }
                    }
                    _ => {
                        rows.push(Row::new("field:brightness", "Brightness").right(format!("{}%", held["brightness"])));
                        rows.push(Row::new("toggle:muted", "Sound").right(if held["muted"] == true { "Off" } else { "On" }));
                        rows.push(Row::new("toggle:scrollReversed", "Reverse scrolling").right(if held["scrollReversed"] == true { "On" } else { "Off" }));
                        rows.push(Row::new("field:voiceLang", "Voice language").right(clean(language(held["voiceLang"].as_str().unwrap_or("")))));
                    }
                }
                for row in rows.iter_mut().skip(1) { if !editable { row.disabled = true; } }
            } else { rows.push(info("waiting", if d.attached { "Waiting for device settings. Check its firmware." } else { "Connect this device to read its settings." })); }
            rows.push(Row::new("refresh", "Refresh devices"));
            picker.status = app.hardware.errors.get(&d.key).cloned().unwrap_or_else(|| {
                if app.hardware.pending.contains_key(&d.key) { "Waiting for the device to confirm…".into() }
                else if !selection.matches(app) { "This device's connection changed. Go back and select it again.".into() }
                else if state(app, d) == "Connected" { "Settings are saved on this device.".into() }
                else { format!("{}. Showing last reported settings.", state(app, d)) }
            });
        } else { rows.push(info("missing", "This device is no longer available.")); picker.status.clear(); }
    } else {
        picker.title = "Devices".into();
        for m in app.fleet.visible_machines().filter(|m| !m.shared) {
            let mut devices: Vec<_> = app.hardware.devices.values().filter(|d| d.machine == m.id).collect();
            devices.sort_by(|a, b| a.key.cmp(&b.key));
            if devices.is_empty() {
                let host = app.hardware.hosts.get(&m.id);
                let word = if !m.usable() || !m.online() { if m.reach == crate::fleet::Reach::NeedsLink { "Link in Machines to see its devices" } else { "Computer offline" } }
                    else if host.is_some_and(|h| h.reading) { "Reading devices…" }
                    else if host.is_some_and(|h| !h.error.is_empty()) { host.unwrap().error.as_str() }
                    else { "No devices connected" };
                rows.push(info(&format!("host:{}", m.id), word).group(clean(&m.name)));
            }
            for (i, d) in devices.iter().enumerate() { rows.push(Row::new(format!("device:{}", d.key), format!("Harness device {}", i + 1)).group(clean(&m.name)).extra(format!("{} {} {}", d.id, d.mac, d.firmware)).right(state(app, d))); }
        }
        if rows.is_empty() { rows.push(info("empty", "Start Harness to read connected devices.")); }
        rows.push(Row::new("refresh", "Refresh devices"));
        rows.push(Row::new("machines", "Machines").right("Manage computer connections"));
        picker.status = "Physical Harness devices connected to your computers".into();
    }
    // Device settings have a fixed order, independent of the inventory page
    // that led here. Live inventory updates retain their existing row positions.
    if app.hardware.selection.is_some() { picker.rows.clear(); }
    picker.keep_order = true; picker.set_rows(rows);
    picker.hints = vec![("enter", "choose"), ("esc", "back")];
}

pub fn preview(app: &App, id: &str) -> Vec<Line<'static>> {
    let key = id.strip_prefix("device:").or_else(|| app.hardware.selection.as_ref().map(|s| s.key.as_str()));
    let Some(d) = key.and_then(|key| app.hardware.devices.get(key)) else {
        return vec![Line::raw("Connect a Harness device to a computer with a USB data cable."), Line::raw("Devices on linked computers appear here too. Offline computers are not woken up.")];
    };
    let mut lines = vec![Line::raw(title(app, d)), Line::raw(state(app, d)), Line::raw("")];
    for (label, value) in [("Device", &d.id), ("Address", &d.mac), ("Firmware", &d.firmware), ("Hardware", &d.hardware)] {
        if !value.is_empty() { lines.push(Line::raw(format!("{label}: {}", clean(value)))); }
    }
    if !d.updating.is_empty() { lines.push(Line::raw(format!("Updating to {}. Keep the device connected.", clean(&d.updating)))); }
    if let Some(error) = app.hardware.errors.get(&d.key) { lines.extend([Line::raw(""), Line::raw(error.clone())]); }
    lines
}

fn back(app: &mut App, mut picker: Picker) {
    picker.set_query("");
    let focus = if let Some(field) = app.hardware.field.take() { format!("field:{field}") }
    else if let Some(selection) = app.hardware.selection.take() { format!("device:{}", selection.key) }
    else if picker.from_commands {
        crate::settings::back_to_commands_at(app, &mut picker, "cmd:hardware-devices");
        app.modal = Some(Modal::Picker { kind: PickerKind::Commands, picker }); return;
    } else { app.modal = None; return };
    picker.rows.clear();
    fill(app, &mut picker);
    picker.scroll = 0; picker.select(&focus);
    app.modal = Some(Modal::Picker { kind: PickerKind::Hardware, picker });
}

pub fn key(app: &mut App, kind: PickerKind, picker: Picker, key: KeyEvent) -> Result<(), (PickerKind, Picker)> {
    if matches!(kind, PickerKind::Hardware) && (key.code == KeyCode::Esc || (key.code == KeyCode::Left && key.modifiers.is_empty() && picker.query.is_empty())) {
        back(app, picker); Ok(())
    } else { Err((kind, picker)) }
}

pub fn choose(app: &mut App, mut picker: Picker, id: &str) {
    if id == "back" { back(app, picker); return }
    if id == "machines" { crate::devices::open(app, crate::devices::View::Machines); return }
    picker.set_query("");
    app.modal = Some(Modal::Picker { kind: PickerKind::Hardware, picker });
    if id == "refresh" { refresh(app); return }
    let mut focus = id.to_string();
    if let Some(key) = id.strip_prefix("device:") {
        if let Some(d) = app.hardware.devices.get(key) { app.hardware.selection = Some(Selection { key:d.key.clone(), machine:d.machine.clone(), id:d.id.clone(), mac:d.mac.clone(), owner:app.fleet.local_id.clone(), generation:app.connection_generation(&d.machine) }); app.hardware.field = None; focus = "field:brightness".into(); }
    } else if let Some(field) = id.strip_prefix("field:") {
        if matches!(field, "brightness" | "voiceLang") {
            app.hardware.field = Some(if field == "brightness" { "brightness" } else { "voiceLang" });
            if let Some(held) = app.hardware.selection.as_ref().and_then(|s| app.hardware.devices.get(&s.key)).and_then(|d| d.settings.as_ref()) {
                focus = if field == "brightness" { format!("brightness:{}", held["brightness"]) } else { format!("language:{}", held["voiceLang"].as_str().unwrap_or("")) };
            }
        }
    } else if let Some(selection) = app.hardware.selection.clone() {
        if let Some(field) = id.strip_prefix("toggle:").filter(|f| matches!(*f, "muted" | "scrollReversed")) {
            if let Some(value) = app.hardware.devices.get(&selection.key).and_then(|d| d.settings.as_ref()).and_then(|s| s[field].as_bool()) { change(app, selection, json!({field:!value})); }
        } else if let Some(n) = id.strip_prefix("brightness:").and_then(|n| n.parse::<u16>().ok()).filter(|n| *n <= 100) {
            change(app, selection, json!({"brightness":n})); app.hardware.field = None; focus = "field:brightness".into();
        } else if let Some(code) = id.strip_prefix("language:").filter(|c| LANGUAGES.iter().any(|(v, _)| v == c)) {
            change(app, selection, json!({"voiceLang":code})); app.hardware.field = None; focus = "field:voiceLang".into();
        }
    }
    crate::input::refill(app);
    if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.scroll = 0; picker.select(&focus); }
}

fn change(app: &mut App, selection: Selection, patch: Value) {
    if !can_edit(app, &selection) { app.error("Reconnect and select this device again before changing its settings"); return }
    if app.hardware.pending.contains_key(&selection.key) { return }
    let key = selection.key.clone(); let machine = selection.machine.clone();
    let Some(held) = app.hardware.devices.get(&key).and_then(|d| d.settings.as_ref()) else { return };
    if patch.as_object().is_some_and(|p| p.iter().all(|(k, v)| held[k] == *v)) { return }
    let observed = app.hardware.hosts.get(&machine).map(|h| h.observed).unwrap_or(0);
    let token = uuid::Uuid::new_v4().to_string();
    app.hardware.errors.remove(&key);
    app.hardware.pending.insert(key.clone(), Pending { token:token.clone(), selection:selection.clone(), patch:patch.clone(), since:Instant::now() });
    let payload = json!({"id":selection.id,"patch":patch}); let callback_key = key.clone(); let callback_token = token.clone();
    if !rpc(app, &machine, "harness_device_settings", payload, 6, move |app, reply| write_reply(app, &callback_key, &callback_token, observed, reply)) {
        write_reply(app, &key, &token, observed, Err(RpcError { code:"OFFLINE".into(), detail:String::new() }));
    }
}

fn write_reply(app: &mut App, key: &str, token: &str, observed: u64, reply: Result<Value, RpcError>) {
    let Some(pending) = app.hardware.pending.get(key).filter(|p| p.token == token) else { return };
    if !pending.selection.matches(app) { settle(app); return }
    let machine = pending.selection.machine.clone();
    match reply {
        Ok(r) if r["ok"] == true => {
            receive(app, &machine, &r["status"], r["revision"].as_u64(), Some(observed));
        }
        _ => { app.hardware.pending.remove(key); app.hardware.errors.insert(key.into(), "The change was not confirmed. Refresh Devices before trying again.".into()); }
    }
    crate::input::refill(app);
}

fn settle(app: &mut App) {
    let finished: Vec<_> = app.hardware.pending.iter().filter_map(|(key, p)| {
        let d = app.hardware.devices.get(key);
        let problem = if !can_edit(app, &p.selection) { Some("Device disconnected or started updating before confirming. Reconnect and try again.") }
            else if p.since.elapsed() > Duration::from_secs(8) { Some("The device did not confirm the change. Refresh before trying again.") } else { None };
        let confirmed = d.filter(|d| d.attached && d.updating.is_empty()).and_then(|d| d.settings.as_ref()).is_some_and(|s| p.patch.as_object().is_some_and(|patch| patch.iter().all(|(k, v)| s[k] == *v)));
        (problem.is_some() || confirmed).then(|| (key.clone(), problem))
    }).collect();
    for (key, error) in finished {
        app.hardware.pending.remove(&key);
        if let Some(error) = error { app.hardware.errors.insert(key, error.into()); } else { app.hardware.errors.remove(&key); }
    }
}

pub fn tick(app: &mut App) {
    let open = matches!(&app.modal, Some(Modal::Picker { kind:PickerKind::Hardware, .. }));
    if !open && app.hardware.pending.is_empty() { return }
    reconcile(app);
    let machines: Vec<_> = app.fleet.visible_machines().filter(|m| !m.shared && m.usable() && m.online())
        .filter(|m| app.hardware.hosts.get(&m.id).is_some_and(|h| !h.reading && h.read_at.is_none_or(|t| t.elapsed() > Duration::from_secs(if app.hardware.pending.values().any(|p| p.selection.machine == m.id) { 1 } else { 10 }))))
        .map(|m| m.id.clone()).collect();
    for machine in machines { refresh_host(app, &machine); }
    crate::input::refill(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::{Machine, Reach};

    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19799, sink, (100, 30));
        app.fleet.local_id = "local".into();
        for (id, local, shared, reach) in [("local", true, false, Reach::Ready), ("remote", false, false, Reach::Ready),
            ("offline", false, false, Reach::Offline), ("shared", false, true, Reach::Ready)] {
            app.fleet.machines.push(Machine { id:id.into(), name:id.into(), local, shared, status:if reach == Reach::Offline { "offline" } else { "online" }.into(), reach });
        }
        reconcile(&mut app); app
    }

    fn status(brightness: u64) -> Value { json!({"attached":true,"devices":[{"id":"usb-1","mac":"AB:CD","attached":true,"fw":"0.4.0","hw":"cst9217+axp2101","settings":{
        "brightness":brightness,"character":2,"face":360,"muted":false,"quiet":false,"straightTitle":false,"focusFace":true,"scrollReversed":false,"round":true,"voiceLang":"en"}}]}) }

    fn select(app: &mut App, machine: &str) -> Selection {
        let d = app.hardware.devices.values().find(|d| d.machine == machine).unwrap();
        let selection = Selection { key:d.key.clone(), machine:d.machine.clone(), id:d.id.clone(), mac:d.mac.clone(), owner:app.fleet.local_id.clone(), generation:app.connection_generation(machine) };
        app.hardware.selection = Some(selection.clone()); selection
    }

    #[test]
    fn targets_the_owned_host_even_when_two_devices_have_the_same_serial() {
        let mut app = app();
        push(&mut app, "local", "dial_status", &status(40));
        push(&mut app, "remote", "harness_devices_changed", &json!({"status":status(70),"revision":8}));
        push(&mut app, "shared", "harness_devices_changed", &json!({"status":status(90),"revision":8}));
        assert_eq!(app.hardware.devices.len(), 2);
        let selected = select(&mut app, "remote");
        change(&mut app, selected.clone(), json!({"brightness":35}));
        assert_eq!(app.hardware.sent, vec![("remote".into(), "harness_device_settings".into(), json!({"id":"usb-1","patch":{"brightness":35}}))]);
        assert_eq!(app.hardware.devices[&selected.key].settings.as_ref().unwrap()["brightness"], 70);
        let (token, observed) = (app.hardware.pending[&selected.key].token.clone(), app.hardware.hosts["remote"].observed);
        write_reply(&mut app, &selected.key, &token, observed, Ok(json!({"ok":true,"status":status(70),"revision":8})));
        assert!(app.hardware.pending.contains_key(&selected.key), "acceptance is not firmware confirmation");
        push(&mut app, "remote", "harness_devices_changed", &json!({"status":status(35),"revision":9}));
        assert!(!app.hardware.pending.contains_key(&selected.key));
        assert!(!app.hardware.errors.contains_key(&selected.key));
    }

    #[test]
    fn newer_push_wins_over_inflight_read_and_write_replies() {
        let mut app = app(); push(&mut app, "local", "dial_status", &status(40));
        let observed = app.hardware.hosts["local"].observed;
        push(&mut app, "local", "dial_status", &status(50));
        read_reply(&mut app, "local", observed, Ok(json!({"status":status(40),"revision":10})));
        let selected = select(&mut app, "local");
        assert_eq!(app.hardware.devices[&selected.key].settings.as_ref().unwrap()["brightness"], 50);
        change(&mut app, selected.clone(), json!({"brightness":60}));
        let (token, observed) = (app.hardware.pending[&selected.key].token.clone(), app.hardware.hosts["local"].observed);
        push(&mut app, "local", "dial_status", &status(60));
        write_reply(&mut app, &selected.key, &token, observed, Ok(json!({"ok":true,"status":status(50),"revision":10})));
        assert_eq!(app.hardware.devices[&selected.key].settings.as_ref().unwrap()["brightness"], 60);
        assert!(app.hardware.pending.is_empty());
        push(&mut app, "remote", "harness_devices_changed", &json!({"status":status(80),"revision":12}));
        push(&mut app, "remote", "harness_devices_changed", &json!({"status":status(10),"revision":11}));
        let remote = select(&mut app, "remote");
        assert_eq!(app.hardware.devices[&remote.key].settings.as_ref().unwrap()["brightness"], 80);
    }

    #[test]
    fn no_write_is_replayed_after_disconnect_update_or_timeout() {
        for reason in ["disconnect", "update", "timeout"] {
            let mut app = app(); push(&mut app, "local", "dial_status", &status(40));
            let selected = select(&mut app, "local"); change(&mut app, selected.clone(), json!({"brightness":60}));
            match reason {
                "disconnect" => push(&mut app, "local", "dial_status", &json!({"attached":false,"devices":[]})),
                "update" => { let mut value = status(40); value["devices"][0]["updating"] = json!("0.5.0"); push(&mut app, "local", "dial_status", &value); }
                _ => { app.hardware.pending.get_mut(&selected.key).unwrap().since = Instant::now() - Duration::from_secs(9); settle(&mut app); }
            }
            assert!(app.hardware.pending.is_empty(), "{reason}");
            assert!(app.hardware.errors.contains_key(&selected.key));
            push(&mut app, "local", "dial_status", &status(40));
            assert_eq!(app.hardware.sent.iter().filter(|(_, ty, _)| ty == "harness_device_settings").count(), 1);
        }
    }

    #[test]
    fn stale_device_identity_and_changed_account_cannot_write() {
        let mut app = app(); push(&mut app, "local", "dial_status", &status(40));
        let selected = select(&mut app, "local");
        let mut replacement = status(40); replacement["devices"][0]["mac"] = json!("EF:12");
        push(&mut app, "local", "dial_status", &replacement);
        change(&mut app, selected.clone(), json!({"muted":true}));
        assert!(app.hardware.sent.is_empty());
        app.fleet.local_id = "another-owner".into();
        change(&mut app, selected, json!({"muted":true}));
        reconcile(&mut app);
        assert!(app.hardware.devices.is_empty()); assert!(app.hardware.pending.is_empty());
    }

    #[test]
    fn missing_firmware_settings_never_invent_defaults_and_future_language_is_preserved() {
        let mut app = app(); let mut value = status(40);
        value["devices"][0]["settings"].as_object_mut().unwrap().remove("muted");
        push(&mut app, "local", "dial_status", &value);
        let selected = select(&mut app, "local");
        assert!(!can_edit(&app, &selected));
        let mut value = status(40); value["devices"][0]["settings"]["voiceLang"] = json!("de");
        push(&mut app, "local", "dial_status", &value);
        let mut picker = Picker::new("Devices", "Search");
        app.hardware.field = Some("voiceLang"); fill(&app, &mut picker);
        assert!(picker.rows.iter().any(|r| r.id == "language-current" && r.label == "de (current)"));
        assert_eq!(app.hardware.devices[&selected.key].settings.as_ref().unwrap()["voiceLang"], "de");
        assert!(app.hardware.sent.is_empty());
    }

    #[test]
    fn opening_reads_only_connected_owned_hosts_and_escape_stays_in_settings() {
        let mut app = app(); open(&mut app);
        let mut hosts: Vec<_> = app.hardware.sent.iter().map(|(m, _, _)| m.as_str()).collect(); hosts.sort();
        assert_eq!(hosts, ["local", "remote"]);
        push(&mut app, "local", "dial_status", &status(40)); select(&mut app, "local");
        app.hardware.field = Some("brightness");
        let picker = Picker::new("Devices", "Search");
        assert!(key(&mut app, PickerKind::Hardware, picker, KeyEvent::from(KeyCode::Esc)).is_ok());
        assert!(app.hardware.field.is_none()); assert!(app.hardware.selection.is_some());
        assert!(matches!(app.modal, Some(Modal::Picker { kind:PickerKind::Hardware, .. })));
    }

    #[test]
    fn keyboard_settings_open_at_the_reported_value_and_back_restores_context() {
        let mut app = app(); push(&mut app, "local", "dial_status", &status(33));
        let device = app.hardware.devices.values().next().unwrap().key.clone();
        let mut picker = Picker::new("Devices", "Search"); fill(&app, &mut picker);
        choose(&mut app, picker, &format!("device:{device}"));
        let Some(Modal::Picker { picker, .. }) = app.modal.take() else { panic!("missing device") };
        assert_eq!(picker.current_id().as_deref(), Some("field:brightness"));
        choose(&mut app, picker, "field:brightness");
        let Some(Modal::Picker { picker, .. }) = app.modal.take() else { panic!("missing brightness") };
        assert_eq!(picker.current_id().as_deref(), Some("brightness:33"));
        choose(&mut app, picker, "brightness:33");
        assert!(app.hardware.sent.is_empty(), "accepting the reported value does not round or write it");
        let Some(Modal::Picker { picker, .. }) = app.modal.take() else { panic!("missing device") };
        assert_eq!(picker.current_id().as_deref(), Some("field:brightness"));
        choose(&mut app, picker, "field:voiceLang");
        let Some(Modal::Picker { mut picker, .. }) = app.modal.take() else { panic!("missing language") };
        assert_eq!(picker.current_id().as_deref(), Some("language:en"));
        picker.set_query("a search with the cursor in the middle"); picker.qcursor = 3;
        back(&mut app, picker);
        let Some(Modal::Picker { picker, .. }) = app.modal.take() else { panic!("missing device") };
        assert!(picker.query.is_empty());
        assert_eq!(picker.current_id().as_deref(), Some("field:voiceLang"));
        back(&mut app, picker);
        let Some(Modal::Picker { picker, .. }) = app.modal.take() else { panic!("missing devices") };
        assert_eq!(picker.current_id(), Some(format!("device:{device}")));
    }
}
