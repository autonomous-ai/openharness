//! Small, ordinary menus shared by the workspace's mouse and keyboard commands.
//! Targets belong to commands, never to the focus when a later reply arrives.

use crate::app::App;
use crate::modal::{Menu, MenuItem, Modal};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

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
    if app.size.0 < 12 || app.size.1 < items.len() as u16 + 2 {
        app.say("Make the terminal larger to show this menu", crate::theme::WARN);
        return false;
    }
    let width = items.iter().map(|i| crate::draw::format_width(&i.label) as usize + if i.key.is_empty() { 0 } else { i.key.width() + 3 })
        .chain([title.width()]).max().unwrap_or(1).min(app.size.0.saturating_sub(4) as usize) as u16;
    let (items, choice) = wrap_notes(items, choice, width as usize, app.size.1.saturating_sub(2) as usize);
    let height = items.len() as u16 + 2;
    let (x, y) = at.unwrap_or(((app.size.0 - width - 4) / 2, (app.size.1 - height) / 2));
    app.toast = None;
    app.modal = Some(Modal::Menu(Menu {
        title: literal(title), items, choice, x: x.min(app.size.0 - width - 4), y: y.min(app.size.1 - height), width,
        stay_open: true, no_mouse: false, mouse: None, tree: None, complete: None,
    }));
    true
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

fn wrap(text: &str, width: usize) -> Vec<String> {
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
}
