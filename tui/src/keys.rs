//! Key tables, the way tmux has them: a prefix (C-b), a `prefix` table of what follows it, a `root`
//! table for keys that need no prefix (empty by default — every key goes to the pane), and `-r`
//! bindings that repeat without the prefix for a moment.
//!
//! The defaults ARE tmux's defaults (`tmux -f /dev/null list-keys -T prefix`), mapped onto
//! harnesses: a window is a tab, a pane is a harness, a "session" is a harness you can switch to.
//! Keys tmux leaves unbound carry the Harness-only commands (C a A M I S g B T).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

pub use crate::config::Chord;

#[derive(Clone, Debug)]
pub struct Binding {
    pub chord: Chord,
    /// A command line in tmux syntax (`split-window -h`, `select-layout tiled`).
    pub command: String,
    /// `bind -r`: may be pressed again without the prefix while the repeat window is open.
    pub repeat: bool,
    /// What `list-keys -N` says about it.
    pub note: String,
}

#[derive(Clone, Debug)]
pub struct Keymap {
    pub prefix: Chord,
    pub prefix2: Option<Chord>,
    pub prefix_table: Vec<Binding>,
    pub root_table: Vec<Binding>,
    /// `bind -T copy-mode-vi` / `-T copy-mode`: over copy mode's own keys.
    pub copy_vi: Vec<Binding>,
    pub copy_emacs: Vec<Binding>,
    /// tmux `repeat-time`.
    pub repeat_ms: u64,
    /// How long after the prefix before the key hint shows (`set -g @hn-hint-time`; 0: never).
    pub hint_ms: u64,
}

fn k(code: KeyCode, mods: KeyModifiers) -> Chord { Chord::normal(code, mods) }
fn ch(c: char) -> Chord { Chord::normal(KeyCode::Char(c), KeyModifiers::NONE) }

impl Keymap {
    pub fn tmux_defaults() -> Keymap {
        let none = KeyModifiers::NONE;
        let ctrl = KeyModifiers::CONTROL;
        let alt = KeyModifiers::ALT;
        let mut t: Vec<Binding> = Vec::new();
        let mut b = |chord: Chord, command: &str, repeat: bool, note: &str| t.push(Binding { chord, command: command.into(), repeat, note: note.into() });
        // ── tmux's own table ──
        b(ch(' '), "next-layout", false, "Select next layout");
        b(ch('!'), "break-pane", false, "Break pane to a new window");
        b(ch('"'), "split-window", false, "Split window vertically (a harness below)");
        b(ch('#'), "list-buffers", false, "List paste buffers");
        b(ch('%'), "split-window -h", false, "Split window horizontally (a harness beside)");
        b(ch('&'), "confirm-before -p \"kill-window #W? (y/n)\" kill-window", false, "Kill current window (harnesses keep running)");
        b(ch('\''), "command-prompt -p index select-window", false, "Prompt for window index to select");
        b(ch(','), "command-prompt -I \"#W\" -p (rename-window) rename-window", false, "Rename current window");
        // The split keys nearly every tmux.conf adds, beside % and " (tmux's `-` was delete-buffer).
        b(ch('|'), "split-window -h", false, "Split window horizontally (as %)");
        b(ch('-'), "split-window", false, "Split window vertically (as \")");
        b(ch('.'), "command-prompt -p (move-window) move-window", false, "Move the current window");
        b(ch('/'), "list-keys", false, "Describe key binding");
        for n in 0..=9u8 { b(ch((b'0' + n) as char), &format!("select-window -t {n}"), false, &format!("Select window {n}")); }
        b(ch(':'), "command-prompt", false, "Prompt for a command");
        b(ch(';'), "last-pane", false, "Move to the previously active pane");
        b(ch('<'), "move-window -L", false, "Move this window left");
        b(ch('>'), "move-window -R", false, "Move this window right");
        b(ch('='), "choose-buffer", false, "Choose a paste buffer");
        b(ch('?'), "list-keys", false, "List key bindings");
        b(ch('D'), "choose-client", false, "Choose a client (the windows that hold harnesses)");
        b(ch('E'), "select-layout -E", false, "Spread panes out evenly");
        b(ch('L'), "switch-client -l", false, "Switch to the last harness");
        b(ch('['), "copy-mode", false, "Enter copy mode");
        b(ch(']'), "paste-buffer", false, "Paste the most recent paste buffer");
        b(ch('c'), "new-window", false, "Create a new window (and choose its harness)");
        b(ch('d'), "detach-client", false, "Detach — everything keeps running");
        b(ch('f'), "find-window", false, "Search every harness on every machine");
        b(ch('i'), "display-message", false, "Display window information");
        b(ch('l'), "last-window", false, "Select the previously current window");
        b(ch('m'), "select-pane -m", false, "Toggle the marked pane");
        b(ch('M'), "choose-tree -m", false, "Machines (then their harnesses)");
        b(ch('n'), "next-window", false, "Select the next window");
        b(ch('o'), "select-pane -t :.+", false, "Select the next pane");
        b(ch('p'), "previous-window", false, "Select the previous window");
        b(ch('q'), "display-panes", false, "Display pane numbers");
        b(ch('r'), "refresh-client", false, "Redraw the client");
        b(ch('s'), "choose-tree -s", false, "Choose a harness (every machine)");
        b(ch('t'), "clock-mode", false, "Show a clock");
        b(ch('w'), "choose-tree -w", false, "Choose a window from a list");
        b(ch('x'), "confirm-before -p \"kill-pane #P? (y/n)\" kill-pane", false, "Kill the active pane (the harness keeps running)");
        b(ch('z'), "resize-pane -Z", false, "Zoom the active pane");
        b(ch('{'), "swap-pane -U", false, "Swap the active pane with the pane above");
        b(ch('}'), "swap-pane -D", false, "Swap the active pane with the pane below");
        b(ch('~'), "show-messages", false, "Show messages");
        b(k(KeyCode::PageUp, none), "copy-mode -u", false, "Enter copy mode and scroll up");
        b(k(KeyCode::Up, none), "select-pane -U", true, "Select the pane above the active pane");
        b(k(KeyCode::Down, none), "select-pane -D", true, "Select the pane below the active pane");
        b(k(KeyCode::Left, none), "select-pane -L", true, "Select the pane to the left of the active pane");
        b(k(KeyCode::Right, none), "select-pane -R", true, "Select the pane to the right of the active pane");
        b(k(KeyCode::Char('1'), alt), "select-layout even-horizontal", false, "Set the even-horizontal layout");
        b(k(KeyCode::Char('2'), alt), "select-layout even-vertical", false, "Set the even-vertical layout");
        b(k(KeyCode::Char('3'), alt), "select-layout main-horizontal", false, "Set the main-horizontal layout");
        b(k(KeyCode::Char('4'), alt), "select-layout main-vertical", false, "Set the main-vertical layout");
        b(k(KeyCode::Char('5'), alt), "select-layout tiled", false, "Set the tiled layout");
        b(k(KeyCode::Char('n'), alt), "next-window -a", false, "Select the next window with an alert (a harness waiting on you)");
        b(k(KeyCode::Char('p'), alt), "previous-window -a", false, "Select the previous window with an alert");
        b(k(KeyCode::Char('o'), alt), "rotate-window -D", false, "Rotate through the panes in reverse");
        b(k(KeyCode::Char('o'), ctrl), "rotate-window", false, "Rotate through the panes");
        b(k(KeyCode::Char('z'), ctrl), "suspend-client", false, "Suspend the current client");
        b(ch('$'), "command-prompt -I \"#S\" -p (rename-session) rename-session", false, "Rename the session (this computer's name here)");
        b(ch('('), "switch-client -p", false, "Switch to the previous harness");
        b(ch(')'), "switch-client -n", false, "Switch to the next harness");
        b(k(KeyCode::Up, alt), "resize-pane -U 5", true, "Resize the pane up by 5");
        b(k(KeyCode::Down, alt), "resize-pane -D 5", true, "Resize the pane down by 5");
        b(k(KeyCode::Left, alt), "resize-pane -L 5", true, "Resize the pane left by 5");
        b(k(KeyCode::Right, alt), "resize-pane -R 5", true, "Resize the pane right by 5");
        b(k(KeyCode::Up, ctrl), "resize-pane -U", true, "Resize the pane up");
        b(k(KeyCode::Down, ctrl), "resize-pane -D", true, "Resize the pane down");
        b(k(KeyCode::Left, ctrl), "resize-pane -L", true, "Resize the pane left");
        b(k(KeyCode::Right, ctrl), "resize-pane -R", true, "Resize the pane right");
        // ── keys tmux leaves unbound: the Harness ones ──
        b(ch('C'), "new-harness", false, "New harness: agent, machine, folder, first message");
        b(ch('T'), "new-terminal", false, "New terminal (a shell) beside this pane");
        b(ch('a'), "next-window -a", false, "Go to the next harness waiting on you");
        b(ch('A'), "choose-tree -a", false, "Harnesses waiting on you — answer from the list");
        b(ch('I'), "choose-tree -i", false, "Models: this harness's model and effort, local models");
        b(ch('S'), "choose-tree -S", false, "The Harness Store");
        b(ch('g'), "command-prompt -p (send) send-task", false, "Send a task — Harness picks the harness");
        b(ch('B'), "command-prompt -p (broadcast) broadcast", false, "Send one message to every harness in this window");
        b(ch('R'), "confirm-before -p \"restart #T? (y/n)\" restart-harness", false, "Restart this harness");
        b(ch('P'), "confirm-before -p \"pause #T? (y/n)\" pause-harness", false, "Pause this harness (the conversation is kept)");
        b(ch('K'), "clone-harness", false, "Clone this harness (a second one with its history)");
        b(ch('/'), "copy-mode ; search-backward", false, "Search this pane's history");
        drop(b);
        // `/` is list-keys -1N in tmux (describe a key); here it is the far more used search. The
        // describe variant stays reachable through `?`.
        t.retain(|x| !(x.chord == ch('/') && x.command == "list-keys"));
        Keymap { prefix: k(KeyCode::Char('b'), ctrl), prefix2: None, prefix_table: t, root_table: Vec::new(), copy_vi: Vec::new(), copy_emacs: Vec::new(), repeat_ms: 500, hint_ms: 600 }
    }

    pub fn prefix_command(&self, chord: &Chord) -> Option<&Binding> { self.prefix_table.iter().rev().find(|b| &b.chord == chord) }
    pub fn root_command(&self, chord: &Chord) -> Option<&Binding> { self.root_table.iter().rev().find(|b| &b.chord == chord) }

    /// `bind` / `unbind`, as a config file says them.
    pub fn table_mut(&mut self, table: Table) -> &mut Vec<Binding> {
        match table { Table::Prefix => &mut self.prefix_table, Table::Root => &mut self.root_table, Table::CopyVi => &mut self.copy_vi, Table::CopyEmacs => &mut self.copy_emacs }
    }
    pub fn bind(&mut self, table: Table, chord: Chord, command: String, repeat: bool) {
        let list = self.table_mut(table);
        list.retain(|b| b.chord != chord);
        list.push(Binding { chord, command, repeat, note: String::new() });
    }
    pub fn unbind(&mut self, table: Table, chord: &Chord) { self.table_mut(table).retain(|b| &b.chord != chord) }

    /// The first key that runs [command] (for hints: "C-b s").
    /// The key for a command by name: its exact binding, else one that runs it with arguments
    /// (`split-window -h`) or behind a prompt (`confirm-before … kill-window`) — never the wrapper's.
    pub fn key_for_name(&self, name: &str) -> Option<String> {
        let wrapper = matches!(name, "confirm-before" | "command-prompt");
        let hit = |b: &&Binding| b.command == name || (!wrapper && (b.command.starts_with(&format!("{name} ")) || b.command.ends_with(&format!(" {name}"))));
        let exact = self.prefix_table.iter().find(|b| b.command == name);
        exact.or_else(|| self.prefix_table.iter().find(hit)).map(|b| format!("{} {}", name_of(&self.prefix), name_of(&b.chord)))
    }

    pub fn hint(&self, command: &str) -> Option<String> {
        if let Some(b) = self.root_table.iter().find(|b| b.command == command) { return Some(name(&b.chord)) }
        self.prefix_table.iter().find(|b| b.command == command).map(|b| format!("{} {}", name(&self.prefix), name(&b.chord)))
    }
}

fn name_of(chord: &Chord) -> String { name(chord) }

/// A `-T` table name.
pub fn table_named(name: &str) -> Option<Table> {
    match name { "root" => Some(Table::Root), "prefix" => Some(Table::Prefix), "copy-mode-vi" => Some(Table::CopyVi), "copy-mode" => Some(Table::CopyEmacs), _ => None }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Table { Prefix, Root, CopyVi, CopyEmacs }

/// A key in tmux's spelling: `C-b`, `M-o`, `S-Up`, `%`, `Space`, `PPage`.
pub fn name(chord: &Chord) -> String {
    let mut out = String::new();
    if chord.mods.contains(KeyModifiers::CONTROL) { out.push_str("C-") }
    if chord.mods.contains(KeyModifiers::ALT) { out.push_str("M-") }
    if chord.mods.contains(KeyModifiers::SUPER) { out.push_str("D-") }
    let shifted_letter = matches!(chord.code, KeyCode::Char(c) if c.is_alphabetic());
    if chord.mods.contains(KeyModifiers::SHIFT) && !shifted_letter { out.push_str("S-") }
    out.push_str(&match chord.code {
        KeyCode::Char(' ') => "Space".into(),
        KeyCode::Char(c) if shifted_letter && chord.mods.contains(KeyModifiers::SHIFT) => c.to_ascii_uppercase().to_string(),
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "Enter".into(), KeyCode::Tab => "Tab".into(), KeyCode::BackTab => "BTab".into(), KeyCode::Esc => "Escape".into(),
        KeyCode::Backspace => "BSpace".into(), KeyCode::Up => "Up".into(), KeyCode::Down => "Down".into(), KeyCode::Left => "Left".into(),
        KeyCode::Right => "Right".into(), KeyCode::PageUp => "PPage".into(), KeyCode::PageDown => "NPage".into(), KeyCode::Home => "Home".into(),
        KeyCode::End => "End".into(), KeyCode::Delete => "DC".into(), KeyCode::Insert => "IC".into(), KeyCode::F(n) => format!("F{n}"),
        _ => "?".into(),
    });
    out
}

/// A key as tmux writes it (`C-a`, `M-Left`, `S-Up`, `Space`, `\;`) or as a person does (`ctrl+a`).
pub fn parse(text: &str) -> Result<Chord, String> {
    let raw = text.trim();
    // A lone quote IS the key (`unbind '"'` arrives here as `"`).
    if raw.chars().count() == 1 { return Ok(Chord::normal(KeyCode::Char(raw.chars().next().unwrap()), KeyModifiers::NONE)) }
    let t = raw.trim_matches('"').trim_matches('\'');
    let t = t.strip_prefix('\\').unwrap_or(t);
    if t.contains('+') && t.len() > 1 { return Chord::parse(t) }
    let mut mods = KeyModifiers::NONE;
    let mut rest = t;
    loop {
        if rest.len() > 2 {
            let (head, tail) = rest.split_at(2);
            let m = match head { "C-" => Some(KeyModifiers::CONTROL), "M-" => Some(KeyModifiers::ALT), "S-" => Some(KeyModifiers::SHIFT), "D-" => Some(KeyModifiers::SUPER), _ => None };
            if let Some(m) = m { mods |= m; rest = tail; continue }
        }
        break;
    }
    let code = match rest {
        "Space" => KeyCode::Char(' '), "Enter" => KeyCode::Enter, "Tab" => KeyCode::Tab, "BTab" => KeyCode::BackTab, "Escape" => KeyCode::Esc,
        "BSpace" => KeyCode::Backspace, "Up" => KeyCode::Up, "Down" => KeyCode::Down, "Left" => KeyCode::Left, "Right" => KeyCode::Right,
        "PPage" | "PageUp" | "PgUp" => KeyCode::PageUp, "NPage" | "PageDown" | "PgDn" => KeyCode::PageDown, "Home" => KeyCode::Home, "End" => KeyCode::End,
        "DC" => KeyCode::Delete, "IC" => KeyCode::Insert,
        f if f.len() > 1 && f.starts_with('F') && f[1..].parse::<u8>().is_ok() => KeyCode::F(f[1..].parse().unwrap()),
        c if c.chars().count() == 1 => KeyCode::Char(c.chars().next().unwrap()),
        other => return Err(format!("unknown key {other:?}")),
    };
    Ok(Chord::normal(code, mods))
}

pub fn of(key: &KeyEvent) -> Chord { Chord::of(key) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmux_spellings() {
        assert_eq!(parse("C-b").unwrap(), Chord::normal(KeyCode::Char('b'), KeyModifiers::CONTROL));
        assert_eq!(parse("M-Left").unwrap(), Chord::normal(KeyCode::Left, KeyModifiers::ALT));
        assert_eq!(parse("\\;").unwrap(), Chord::normal(KeyCode::Char(';'), KeyModifiers::NONE));
        assert_eq!(parse("'\"'").unwrap(), Chord::normal(KeyCode::Char('"'), KeyModifiers::NONE));
        assert_eq!(parse("|").unwrap().code, KeyCode::Char('|'));
        assert_eq!(parse("ctrl+a").unwrap(), parse("C-a").unwrap());
        assert_eq!(name(&parse("C-b").unwrap()), "C-b");
        assert_eq!(name(&parse("M-1").unwrap()), "M-1");
        assert_eq!(name(&parse("S").unwrap()), "S");
    }

    #[test]
    fn defaults_are_tmux() {
        let km = Keymap::tmux_defaults();
        assert_eq!(km.prefix_command(&ch('%')).unwrap().command, "split-window -h");
        assert_eq!(km.prefix_command(&ch('"')).unwrap().command, "split-window");
        assert_eq!(km.prefix_command(&ch('c')).unwrap().command, "new-window");
        assert!(km.prefix_command(&Chord::normal(KeyCode::Up, KeyModifiers::NONE)).unwrap().repeat);
        assert!(km.root_table.is_empty());
        assert_eq!(km.hint("new-window").as_deref(), Some("C-b c"));
    }
}
