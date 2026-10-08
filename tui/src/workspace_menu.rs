//! Small, ordinary menus shared by the workspace's mouse and keyboard commands.
//! Targets belong to commands, never to the focus when a later reply arrives.

use crate::app::App;
use crate::modal::{Menu, MenuItem, Modal};
use ratatui::layout::Rect;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// A confirmation's button row and the command each button runs; button 0 is the way out, so
/// `actions[0]` is also what Esc runs.
#[derive(Clone, Debug)]
pub struct Buttons { pub row: crate::buttons::Row, pub actions: Vec<String> }

#[derive(Clone, Debug)]
pub struct Layout { items: Vec<MenuItem>, anchor: Option<(u16, u16)>, buttons: Option<Buttons> }

/// Labels from a machine or conversation are text, not tmux format instructions.
pub fn literal(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect::<String>().replace('#', "##")
}

pub fn item(label: &str, key: &str, command: impl Into<String>) -> MenuItem {
    MenuItem { label: literal(label), key: key.into(), command: command.into(), disabled: false, separator: false }
}

pub fn note(label: &str) -> MenuItem {
    MenuItem { disabled: true, ..item(label, "", "") }
}

/// The menu stays inside the terminal. Callers with long lists use a picker instead.
pub fn open(app: &mut App, title: &str, items: Vec<MenuItem>, at: Option<(u16, u16)>, choice: Option<usize>) -> bool {
    let layout = Layout { items:items.clone(), anchor:at, buttons:None };
    let mut menu = Menu { title:literal(title), items, choice, x:0, y:0, width:0,
        stay_open:true, no_mouse:false, mouse:None, tree:None, complete:None, responsive:Some(Box::new(layout)), buttons:None };
    if !fit(&mut menu, app.size) { app.say("Make the terminal larger to show this menu", crate::theme::WARN); return false }
    app.toast = None;
    app.modal = Some(Modal::Menu(menu));
    true
}

/// A confirmation: [notes] over one row of [row]'s buttons, `actions[i]` the command button i runs.
pub fn open_buttons(app: &mut App, title: &str, notes: Vec<MenuItem>, row: crate::buttons::Row, actions: Vec<String>) -> bool {
    let buttons = Buttons { row, actions };
    let layout = Layout { items:notes.clone(), anchor:None, buttons:Some(buttons.clone()) };
    let mut menu = Menu { title:literal(title), items:notes, choice:None, x:0, y:0, width:0,
        stay_open:true, no_mouse:false, mouse:None, tree:None, complete:None, responsive:Some(Box::new(layout)), buttons:Some(buttons) };
    if !fit(&mut menu, app.size) { app.say(TOO_SMALL_TO_ANSWER, crate::theme::WARN); return false }
    app.toast = None;
    app.modal = Some(Modal::Menu(menu));
    true
}

/// What a question too big for the terminal says, as every dialog says it.
pub const TOO_SMALL_TO_ANSWER: &str = "Make the terminal larger to answer this";

/// A confirmation's parts as a `dialog::Dialog` lays them out: the keys hint's last line when its
/// row kept one.
pub fn dialog_parts(m: &Menu) -> crate::dialog::Parts {
    crate::dialog::Parts { hint: m.buttons.as_ref().is_some_and(|b| !b.row.hint.is_empty()), ..Default::default() }
}

/// A confirmation's box (a `dialog::Dialog`): its notes, a blank row, the buttons' row and the
/// keys hint's line inside the border. The drawing and the mouse both lay it out with
/// `dialog::areas` and [dialog_parts].
pub fn dialog_box(m: &Menu) -> Rect { Rect::new(m.x, m.y, m.width + 4, m.items.len() as u16 + 4 + 2 * u16::from(dialog_parts(m).hint)) }

fn fit(menu: &mut Menu, size: (u16, u16)) -> bool {
    // A resize keeps the button the keys were on.
    if let (Some(layout), Some(shown)) = (&mut menu.responsive, &menu.buttons) {
        if let Some(own) = &mut layout.buttons { own.row.chosen = shown.row.chosen }
    }
    let Some(layout) = &menu.responsive else { return true };
    let actions = layout.items.iter().filter(|i| !(i.disabled && i.command.is_empty() && !i.separator)).count();
    // The blank line, the buttons' row and the hint's line. The hint gives way first, where
    // either the rows or the columns run out; buttons that still do not fit are refused, never
    // overlapped.
    let mut buttons = layout.buttons.clone();
    let extra = |b: &Option<Buttons>| b.as_ref().map_or(0, |b| 2 + 2 * u16::from(!b.row.hint.is_empty()));
    if size.1 < actions as u16 + 2 + extra(&buttons) { if let Some(b) = &mut buttons { b.row.hint.clear() } }
    if size.0 < 12 || size.1 < actions as u16 + 2 + extra(&buttons) { return false }
    let choice = menu.choice.and_then(|at| menu.items.get(at)).and_then(|chosen| layout.items.iter().position(|i|
        !i.disabled && !i.separator && i.command == chosen.command && i.key == chosen.key));
    let width = layout.items.iter().map(|i| crate::draw::format_width(&i.label) as usize + if i.key.is_empty() { 0 } else { i.key.width() + 3 })
        .chain([crate::draw::format_width(&menu.title) as usize])
        .chain(buttons.iter().map(|b| b.row.width() as usize)).max().unwrap_or(1).min(size.0.saturating_sub(4) as usize) as u16;
    if let Some(b) = &mut buttons { if b.row.width() > width { b.row.hint.clear() } }
    if buttons.as_ref().is_some_and(|b| b.row.buttons_width() > width) { return false }
    let (items, choice) = wrap_notes(layout.items.clone(), choice, width as usize, size.1.saturating_sub(2 + extra(&buttons)) as usize);
    let height = items.len() as u16 + 2 + extra(&buttons);
    let (x, y) = layout.anchor.unwrap_or(((size.0 - width - 4) / 2, (size.1 - height) / 2));
    menu.x = x.min(size.0 - width - 4); menu.y = y.min(size.1 - height);
    menu.width = width; menu.items = items; menu.choice = choice; menu.buttons = buttons;
    true
}

pub fn resize(app: &mut App) {
    if let Some(Modal::Menu(menu)) = &mut app.modal {
        if !fit(menu, app.size) {
            // A confirmation going away is a cancel: what it was asking about must not stay pending.
            let cancel = menu.buttons.as_ref().and_then(|b| b.actions.first().cloned());
            app.modal = None;
            let asked = cancel.is_some();
            if let Some(command) = cancel { crate::commands::execute(app, &command) }
            app.say(if asked { TOO_SMALL_TO_ANSWER } else { "Make the terminal larger to show this menu" }, crate::theme::WARN);
        }
    }
}

pub fn replace_items(menu: &mut Menu, items: Vec<MenuItem>, size: (u16, u16)) -> bool {
    if let Some(layout) = &mut menu.responsive { layout.items = items; fit(menu, size) }
    else { menu.items = items; true }
}

fn wrap_notes(items: Vec<MenuItem>, choice: Option<usize>, width: usize, height: usize) -> (Vec<MenuItem>, Option<usize>) {
    let is_note = |i: &MenuItem| i.disabled && i.command.is_empty() && !i.separator;
    let mut remaining = height.saturating_sub(items.iter().filter(|i| !is_note(i)).count());
    let mut rows = Vec::new(); let mut selected = None; let mut last_note = None; let mut omitted = 0;
    for (index, item) in items.into_iter().enumerate() {
        if !is_note(&item) { if choice == Some(index) { selected = Some(rows.len()); } rows.push(item); continue }
        let text = item.label.replace("##", "#");
        for line in wrap(&text, width) {
            if remaining > 0 { last_note = Some(rows.len()); rows.push(note(&line)); remaining -= 1; } else { omitted += 1; }
        }
    }
    if omitted > 0 { if let Some(at) = last_note { rows[at] = note(&format!("… {} more lines; enlarge to read", omitted + 1)); } }
    (rows, selected)
}

pub(crate) fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1); let mut lines = Vec::new(); let mut line = String::new(); let mut used = 0;
    for word in text.split_whitespace() {
        if !line.is_empty() && used + 1 + word.width() > width { lines.push(std::mem::take(&mut line)); used = 0; }
        if !line.is_empty() { line.push(' '); used += 1; }
        for c in word.chars() {
            let cells = c.width().unwrap_or(0);
            if used + cells > width && !line.is_empty() { lines.push(std::mem::take(&mut line)); used = 0; }
            line.push(c); used += cells;
        }
    }
    if !line.is_empty() || lines.is_empty() { lines.push(line); }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resize_reflows_diagnostics_without_changing_the_confirmed_action() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19799, tx, (160, 32));
        let text = "Could not save this conversation because the machine disconnected. Wait for it to reconnect and try again.";
        assert!(open(&mut app, "Stop harness", vec![note(text), item("Cancel", "Escape", "cancel"), item("Stop", "s", "stop")], None, Some(1)));
        for size in [(40, 8), (160, 32)] {
            app.size = size; resize(&mut app);
            let Some(Modal::Menu(menu)) = &app.modal else { panic!("lost confirmation"); };
            assert_eq!(menu.items[menu.choice.unwrap()].command, "cancel");
            assert_eq!(menu.items.last().unwrap().command, "stop");
            assert!(menu.x + menu.width + 4 <= size.0 && menu.y + menu.items.len() as u16 + 2 <= size.1);
        }
        let Some(Modal::Menu(menu)) = &mut app.modal else { unreachable!() };
        assert_eq!(menu.items[0].label, text, "enlarging restores the original diagnostic");
        menu.responsive = None;
        let position = (menu.x, menu.y, menu.width);
        app.size = (40, 8); resize(&mut app);
        let Some(Modal::Menu(menu)) = &app.modal else { unreachable!() };
        assert_eq!((menu.x, menu.y, menu.width), position, "explicit tmux menus retain their coordinate behavior");
    }

    #[test]
    fn long_diagnostic_wraps_with_cancel_selected_and_stop_always_reachable() {
        let notes = vec![note("Could not save 界面 because the machine disconnected. #[fg=red] is literal."), item("Cancel", "Escape", "cancel"), item("Stop", "s", "stop")];
        let (rows, choice) = wrap_notes(notes.clone(), Some(1), 24, 12);
        assert_eq!(rows[choice.unwrap()].command, "cancel");
        assert!(rows.iter().filter(|r| r.disabled).all(|r| crate::draw::format_width(&r.label) <= 24));
        assert!(rows.iter().any(|r| r.label.contains("##[fg=red]")));
        let (rows, choice) = wrap_notes(notes, Some(1), 24, 4);
        assert_eq!(rows.len(), 4); assert_eq!(rows[choice.unwrap()].command, "cancel");
        assert_eq!(rows.last().unwrap().command, "stop");
    }

    fn confirm(hint: &str) -> crate::buttons::Row {
        let button = |label: &str, key| crate::buttons::Button { label: label.into(), key };
        crate::buttons::Row { buttons: vec![button("Cancel", None), button("Stop", Some('s'))], chosen: 0, hint: hint.into() }
    }

    #[test]
    fn buttons_widen_the_box_drop_the_hint_first_and_never_overlap() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19799, tx, (100, 20));
        assert!(open_buttons(&mut app, "Hi", vec![note("Stop?")], confirm(crate::buttons::KEYS), vec!["x".into(), "y".into()]));
        let Some(Modal::Menu(menu)) = &mut app.modal else { panic!("closed") };
        assert!(menu.width >= confirm(crate::buttons::KEYS).width(), "the box holds the hint's line and the buttons");
        assert_eq!(dialog_box(menu).height, menu.items.len() as u16 + 6, "notes, a blank, the buttons, a blank, the hint: the last line");
        assert_eq!(menu.items.len(), 1);
        menu.buttons.as_mut().unwrap().row.chosen = 1;
        app.size = (26, 20); resize(&mut app);   // 22 columns of room: buttons need 20, the hint 38
        let Some(Modal::Menu(menu)) = &app.modal else { panic!("closed") };
        let b = menu.buttons.as_ref().unwrap();
        assert!(b.row.hint.is_empty(), "the hint goes first");
        assert_eq!(dialog_box(menu).height, menu.items.len() as u16 + 4, "no hint, no line for it");
        assert_eq!(b.row.chosen, 1, "a resize keeps the chosen button");
        assert!(menu.width >= b.row.buttons_width());
        app.size = (20, 20); resize(&mut app);   // 16 columns: the buttons cannot fit
        assert!(app.modal.is_none(), "refused, never overlapped");
        assert!(!open_buttons(&mut app, "Hi", vec![note("Stop?")], confirm(""), vec!["x".into(), "y".into()]));
    }

    #[test]
    fn a_confirmation_removed_by_a_resize_runs_its_cancel_action() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19799, tx, (100, 20));
        assert!(open_buttons(&mut app, "Hi", vec![note("Stop?")], confirm(""), vec!["set -g @clicked cancel".into(), "set -g @clicked stop".into()]));
        app.size = (20, 20); resize(&mut app);
        assert!(app.modal.is_none());
        assert_eq!(app.options.get("@clicked", "", None).as_deref(), Some("cancel"));
    }
}
