//! A machine's menu, from the side bar (a right press on its heading, or a click on one with no
//! window here): what can be done on it — New Harness, New Terminal, its harnesses — Connect… when
//! it needs a link, and Machines & devices on it. A `workspace_menu`, its items `machine-menu`
//! commands.

use crate::app::{App, Placement};
use crate::fleet::Reach;
use crate::theme;
use crate::workspace_menu as menu;

/// [machine]'s name, as the side bar shows it.
fn name(app: &App, machine: &str) -> String {
    app.fleet.machine(machine).map(|m| m.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| machine.to_string())
}

/// The menu for [machine] at [at] (the press), titled with its name, with only what it can do now.
pub fn open(app: &mut App, machine: &str, at: Option<(u16, u16)>) {
    let Some(m) = app.fleet.machine(machine) else { return };
    let (usable, link) = (m.usable(), m.reach == Reach::NeedsLink && m.online());
    let name = name(app, machine);
    // (Its id quoted as the command line reads it: an id with a space is one word.)
    let id = crate::tmuxconf::quote_word(machine);
    let run = |verb: &str| format!("machine-menu {verb} {id}");
    let mut items = Vec::new();
    if link { items.push(menu::item("Connect…", "c", run("connect"))) }
    if usable {
        items.push(menu::item(&format!("New Harness on {name}…"), "n", run("new-harness")));
        items.push(menu::item(&format!("New Terminal on {name}"), "t", run("new-terminal")));
        items.push(menu::item("Open its harnesses", "o", run("open")));
    }
    items.push(menu::item("Machines & devices…", "m", run("machine")));
    menu::open(app, &name, items, at, Some(0));
}

/// A left click on [machine]'s heading when no window here is on it: its menu when it is ready,
/// Connect… when it needs a link, else Machines & devices on it and what is wrong with it.
pub fn click(app: &mut App, machine: &str, at: Option<(u16, u16)>) {
    let Some(m) = app.fleet.machine(machine).cloned() else { return };
    let name = name(app, machine);
    let (said, colour) = match &m.reach {
        Reach::Ready => return open(app, machine, at),
        Reach::NeedsLink if m.online() => return crate::devices::connect_to(app, machine.to_string()),
        Reach::Connecting => (format!("{name} is connecting…"), theme::SOFT),
        Reach::Error(why) => (format!("{name}: {why}"), theme::WARN),
        _ => (format!("{name} is offline — start Harness on it"), theme::WARN),
    };
    crate::devices::open_machine(app, machine);
    app.say(said, colour);
}

/// `machine-menu <new-harness|new-terminal|open|connect|machine> <machine>`: an item of the menu.
pub fn command(app: &mut App, args: &[String]) {
    let [verb, machine] = args else { return };
    match verb.as_str() {
        "new-harness" => crate::new_harness::open(app, Some(machine.clone()), None),
        "new-terminal" => crate::input::new_shell_from(app, Some((machine.clone(), String::new())), Placement::Auto(None), None, None),
        "open" => crate::devices::open_machine_list(app, machine),
        "connect" => crate::devices::connect_to(app, machine.clone()),
        "machine" => crate::devices::open_machine(app, machine),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modal::Modal;

    fn grid() -> App {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19798, tx, (160, 40));
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "grid".into(), name: "grid-dev".into(), local: false, status: "online".into(), reach: Reach::Ready });
        app
    }

    fn machine(app: &mut App, id: &str, status: &str, reach: Reach) {
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: id.into(), name: id.into(), local: false, status: status.into(), reach });
    }

    fn labels(app: &App) -> Vec<String> {
        let Some(Modal::Menu(m)) = &app.modal else { panic!("a menu") };
        m.items.iter().map(|i| i.label.clone()).collect()
    }

    /// Run the menu item with this label the way a chosen item runs: its command.
    fn choose(app: &mut App, label: &str) {
        let Some(Modal::Menu(m)) = &app.modal else { panic!("a menu") };
        let command = m.items.iter().find(|i| i.label == label).unwrap_or_else(|| panic!("no item {label}")).command.clone();
        app.modal = None;
        crate::commands::execute(app, &command);
    }

    #[tokio::test]
    async fn new_harness_on_a_machine_opens_the_form_on_it() {
        let mut app = grid();
        open(&mut app, "grid", None);
        let Some(Modal::Menu(m)) = &app.modal else { panic!("a menu") };
        assert_eq!(m.title, "grid-dev");
        choose(&mut app, "New Harness on grid-dev…");
        let Some(Modal::NewHarness(form)) = &app.modal else { panic!("the form") };
        assert_eq!(form.draft.machine, "grid");
    }

    #[tokio::test]
    async fn its_harnesses_and_machines_and_devices_open_on_it() {
        let mut app = grid();
        open(&mut app, "grid", None);
        choose(&mut app, "Open its harnesses");
        assert!(matches!(&app.modal, Some(Modal::Picker { kind: crate::modal::PickerKind::Open { machine: Some(m), .. }, .. }) if m == "grid"));
        open(&mut app, "grid", None);
        choose(&mut app, "Machines & devices…");
        assert!(matches!(&app.modal, Some(Modal::Picker { kind: crate::modal::PickerKind::Devices(crate::devices::View::Machines), .. })));
        assert_eq!(app.devices.sub.as_deref(), Some("m:grid"), "on that machine's own actions");
    }

    #[tokio::test]
    async fn the_menu_lists_only_what_the_machine_can_do() {
        let mut app = grid();
        machine(&mut app, "air", "offline", Reach::Offline);
        open(&mut app, "air", None);
        assert_eq!(labels(&app), ["Machines & devices…"]);
        machine(&mut app, "lb", "online", Reach::NeedsLink);
        open(&mut app, "lb", None);
        assert_eq!(labels(&app), ["Connect…", "Machines & devices…"], "Connect… first");
        open(&mut app, "grid", None);
        assert!(!labels(&app).contains(&"Connect…".to_string()));
    }

    #[tokio::test]
    async fn a_machine_id_with_a_space_or_a_quote_is_one_word() {
        let mut app = grid();
        machine(&mut app, "my 'box'", "online", Reach::Ready);
        open(&mut app, "my 'box'", None);
        choose(&mut app, "Open its harnesses");
        assert!(matches!(&app.modal, Some(Modal::Picker { kind: crate::modal::PickerKind::Open { machine: Some(m), .. }, .. }) if m == "my 'box'"));
    }

    #[tokio::test]
    async fn a_click_says_what_is_wrong_with_a_machine_that_cannot_be_used() {
        let mut app = grid();
        machine(&mut app, "c", "online", Reach::Connecting);
        machine(&mut app, "e", "online", Reach::Error("certificate expired".into()));
        machine(&mut app, "u", "online", Reach::Unknown);
        for (id, said) in [("c", "c is connecting…"), ("e", "e: certificate expired"), ("u", "u is offline — start Harness on it")] {
            app.modal = None;
            click(&mut app, id, None);
            assert_eq!(app.toast.as_ref().map(|t| t.0.as_str()), Some(said));
            assert_eq!(app.devices.sub.as_deref(), Some(format!("m:{id}").as_str()), "Machines & devices on it");
        }
    }
}
