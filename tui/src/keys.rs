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

/// tmux 3.5a's window menu (C-b <), as `list-keys` prints it.
pub const WINDOW_MENU: &str = r##"display-menu -T "#[align=centre]#{window_index}:#{window_name}" -x W -y W "#{?#{>:#{session_windows},1},,-}Swap Left" l { swap-window -t :-1 } "#{?#{>:#{session_windows},1},,-}Swap Right" r { swap-window -t :+1 } "#{?pane_marked_set,,-}Swap Marked" s { swap-window } '' Kill X { kill-window } Respawn R { respawn-window -k } "#{?pane_marked,Unmark,Mark}" m { select-pane -m } Rename n { command-prompt -F -I "#W" { rename-window -t "#{window_id}" "%%" } } '' "New After" w { new-window -a } "New At End" W { new-window }"##;

/// tmux 3.5a's pane menu (C-b >): the parts hn has — no mouse word under a key press.
pub const PANE_MENU: &str = r##"display-menu -T "#[align=centre]#{pane_index} (#{pane_id})" -x P -y P "#{?#{m/r:(copy|view)-mode,#{pane_mode}},Go To Top,}" < { send-keys -X history-top } "#{?#{m/r:(copy|view)-mode,#{pane_mode}},Go To Bottom,}" > { send-keys -X history-bottom } '' "Horizontal Split" h { split-window -h } "Vertical Split" v { split-window -v } '' "#{?#{>:#{window_panes},1},,-}Swap Up" u { swap-pane -U } "#{?#{>:#{window_panes},1},,-}Swap Down" d { swap-pane -D } "#{?pane_marked_set,,-}Swap Marked" s { swap-pane } '' Kill X { kill-pane } Respawn R { respawn-pane -k } "#{?pane_marked,Unmark,Mark}" m { select-pane -m } "#{?#{>:#{window_panes},1},,-}#{?window_zoomed_flag,Unzoom,Zoom}" z { resize-pane -Z }"##;

#[derive(Clone, Debug)]
pub struct Keymap {
    pub prefix: Chord,
    pub prefix2: Option<Chord>,
    pub prefix_table: Vec<Binding>,
    pub root_table: Vec<Binding>,
    /// `bind -T copy-mode-vi` / `-T copy-mode`: over copy mode's own keys.
    pub copy_vi: Vec<Binding>,
    pub copy_emacs: Vec<Binding>,
    /// Tables of your own (`bind -T resize …`, `switch-client -T resize`).
    pub named: std::collections::BTreeMap<String, Vec<Binding>>,
    /// Copy-mode keys unbound (`unbind -T copy-mode-vi v`).
    pub copy_unbound: Vec<(Table, Chord)>,
    /// Tables `unbind -a` removed (tmux's key_bindings_remove_table): their defaults gone, and
    /// the table itself until something is bound in it again.
    pub removed: Vec<Table>,
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
        let shift = KeyModifiers::SHIFT;
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
        b(ch('-'), "delete-buffer", false, "Delete the most recent paste buffer");
        b(ch('.'), "command-prompt -p (move-window) move-window", false, "Move the current window");
        b(ch('/'), "command-prompt -k -p key { list-keys -1N \"%%\" }", false, "Describe key binding");
        for n in 0..=9u8 { b(ch((b'0' + n) as char), &format!("select-window -t {n}"), false, &format!("Select window {n}")); }
        b(ch(':'), "command-prompt", false, "Prompt for a command");
        b(ch(';'), "last-pane", false, "Move to the previously active pane");
        // No notes: 3.5a gives the two menus none (list-keys -N leaves them out).
        b(ch('<'), WINDOW_MENU, false, "");
        b(ch('>'), PANE_MENU, false, "");
        b(ch('='), "choose-buffer", false, "Choose a paste buffer");
        b(ch('?'), "list-keys", false, "List key bindings");
        b(ch('D'), "choose-client", false, "Choose a client (the windows that hold harnesses)");
        b(ch('E'), "select-layout -E", false, "Spread panes out evenly");
        b(ch('L'), "switch-client -l", false, "Switch to the last harness");
        b(ch('['), "copy-mode", false, "Enter copy mode");
        b(ch(']'), "paste-buffer -p", false, "Paste the most recent paste buffer");
        b(ch('c'), "new-window", false, "Create a new window (and choose its harness)");
        b(ch('d'), "detach-client", false, "Detach — everything keeps running");
        b(ch('f'), "command-prompt { find-window -Z \"%%\" }", false, "Search for a pane (every harness on every machine)");
        b(ch('i'), "display-message", false, "Display window information");
        b(ch('l'), "last-window", false, "Select the previously current window");
        b(ch('m'), "select-pane -m", false, "Toggle the marked pane");
        b(ch('M'), "select-pane -M", false, "Clear the marked pane");
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
        b(k(KeyCode::Delete, none), "refresh-client -c", true, "Reset so the visible part follows the cursor");
        b(k(KeyCode::Up, shift), "refresh-client -U 10", true, "Move the visible part of the window up");
        b(k(KeyCode::Down, shift), "refresh-client -D 10", true, "Move the visible part of the window down");
        b(k(KeyCode::Left, shift), "refresh-client -L 10", true, "Move the visible part of the window left");
        b(k(KeyCode::Right, shift), "refresh-client -R 10", true, "Move the visible part of the window right");
        b(k(KeyCode::Up, none), "select-pane -U", true, "Select the pane above the active pane");
        b(k(KeyCode::Down, none), "select-pane -D", true, "Select the pane below the active pane");
        b(k(KeyCode::Left, none), "select-pane -L", true, "Select the pane to the left of the active pane");
        b(k(KeyCode::Right, none), "select-pane -R", true, "Select the pane to the right of the active pane");
        b(k(KeyCode::Char('1'), alt), "select-layout even-horizontal", false, "Set the even-horizontal layout");
        b(k(KeyCode::Char('2'), alt), "select-layout even-vertical", false, "Set the even-vertical layout");
        b(k(KeyCode::Char('3'), alt), "select-layout main-horizontal", false, "Set the main-horizontal layout");
        b(k(KeyCode::Char('4'), alt), "select-layout main-vertical", false, "Set the main-vertical layout");
        b(k(KeyCode::Char('5'), alt), "select-layout tiled", false, "Set the tiled layout");
        b(k(KeyCode::Char('6'), alt), "select-layout main-horizontal-mirrored", false, "Set the main-horizontal-mirrored layout");
        b(k(KeyCode::Char('7'), alt), "select-layout main-vertical-mirrored", false, "Set the main-vertical-mirrored layout");
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
        b(ch('C'), "customize-mode -Z", false, "Customize options");
        // Harness's own, on keys tmux leaves unbound.
        b(ch('N'), "new-harness", false, "New harness: agent, machine, folder, first message");
        b(ch('@'), "choose-tree -m", false, "Machines (then their harnesses)");
        b(ch('T'), "new-terminal", false, "New terminal (a shell) beside this pane");
        b(ch('a'), "next-window -a", false, "Go to the next harness waiting on you");
        b(ch('A'), "choose-tree -a", false, "Harnesses waiting on you — answer from the list");
        b(ch('I'), "choose-tree -i", false, "Models: this harness's model and effort, local models");
        b(ch('S'), "choose-tree -S", false, "The Harness Store");
        b(ch('g'), "command-prompt -p (send) { send-task \"%%\" }", false, "Send a task — Harness picks the harness");
        b(ch('B'), "command-prompt -p (broadcast) { broadcast \"%%\" }", false, "Send one message to every harness in this window");
        b(ch('R'), "confirm-before -p \"restart #T? (y/n)\" restart-harness", false, "Restart this harness");
        b(ch('P'), "confirm-before -p \"pause #T? (y/n)\" pause-harness", false, "Pause this harness (the conversation is kept)");
        b(ch('K'), "clone-harness", false, "Clone this harness (a second one with its history)");
        drop(b);
        // `/` is list-keys -1N in tmux (describe a key); here it is the far more used search. The
        // describe variant stays reachable through `?`.
        t.retain(|x| !(x.chord == ch('/') && x.command == "list-keys"));
        // tmux's own keys run tmux's own commands, word for word (tests/fixtures, from tmux 3.5a
        // itself), with tmux's own words for them (list-keys -N, C-b ?, C-b /).
        let notes = tmux_notes();
        for line in include_str!("../tests/fixtures/tmux-3.5a-prefix.txt").lines() {
            let Some(fb) = fixture_binding(line) else { continue };
            match t.iter_mut().find(|b| b.chord == fb.chord) {
                Some(b) => { b.command = fb.command; b.repeat = fb.repeat }
                None => t.push(fb),
            }
        }
        for b in t.iter_mut() { if let Some(n) = notes.get(&name(&b.chord)) { b.note = n.clone() } }
        // The root table's defaults are tmux's mouse bindings (a click selects the pane, the wheel
        // enters copy mode, a drag on a border resizes, the right button opens the menus).
        let root: Vec<Binding> = include_str!("../tests/fixtures/tmux-3.5a-root.txt").lines().filter_map(fixture_binding).collect();
        Keymap { prefix: k(KeyCode::Char('b'), ctrl), prefix2: None, prefix_table: t, root_table: root, copy_vi: Vec::new(), copy_emacs: Vec::new(), named: Default::default(), copy_unbound: Vec::new(), removed: Vec::new(), repeat_ms: 500, hint_ms: 600 }
    }

    /// Every key table, as `list-keys` walks them: by name, each by key code. The copy-mode tables
    /// are tmux's defaults (tests/fixtures), with what was bound over them and without what was
    /// unbound.
    pub fn tables(&self) -> Vec<(String, Vec<Binding>)> {
        let mut out: Vec<(String, Vec<Binding>)> = Vec::new();
        for (name, own, defaults, table) in [("copy-mode", &self.copy_emacs, include_str!("../tests/fixtures/tmux-3.5a-copy-mode.txt"), Table::CopyEmacs), ("copy-mode-vi", &self.copy_vi, include_str!("../tests/fixtures/tmux-3.5a-copy-mode-vi.txt"), Table::CopyVi)] {
            let gone = self.removed.contains(&table);
            let mut list: Vec<Binding> = if gone { Vec::new() } else { defaults.lines().filter_map(fixture_binding)
                .filter(|b| !own.iter().any(|o| o.chord == b.chord) && !self.copy_unbound.contains(&(table, b.chord))).collect() };
            list.extend(own.iter().cloned());
            if !(gone && list.is_empty()) { out.push((name.to_string(), list)) }
        }
        if !(self.removed.contains(&Table::Prefix) && self.prefix_table.is_empty()) { out.push(("prefix".into(), self.prefix_table.clone())) }
        if !(self.removed.contains(&Table::Root) && self.root_table.is_empty()) { out.push(("root".into(), self.root_table.clone())) }
        for (n, list) in &self.named { out.push((n.clone(), list.clone())) }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, list) in out.iter_mut() { list.sort_by_key(|b| order(&b.chord)) }
        out
    }

    /// The binding a table has for a key, as list-keys shows it — the copy-mode tables' defaults
    /// included, less what was unbound.
    pub fn lookup(&self, table: &str, chord: &Chord) -> Option<Binding> {
        match table {
            "prefix" => self.prefix_command(chord).cloned(),
            "root" => self.root_command(chord).cloned(),
            "copy-mode" | "copy-mode-vi" => {
                let t = if table == "copy-mode" { Table::CopyEmacs } else { Table::CopyVi };
                let own = if t == Table::CopyVi { &self.copy_vi } else { &self.copy_emacs };
                if let Some(b) = own.iter().rev().find(|b| &b.chord == chord) { return Some(b.clone()) }
                if self.removed.contains(&t) || self.copy_unbound.contains(&(t, *chord)) { return None }
                copy_defaults(t).iter().find(|b| &b.chord == chord).cloned()
            }
            other => self.named.get(other).and_then(|l| l.iter().rev().find(|b| &b.chord == chord)).cloned(),
        }
    }

    pub fn prefix_command(&self, chord: &Chord) -> Option<&Binding> { self.prefix_table.iter().rev().find(|b| &b.chord == chord) }
    pub fn root_command(&self, chord: &Chord) -> Option<&Binding> { self.root_table.iter().rev().find(|b| &b.chord == chord) }

    /// `bind` / `unbind`, as a config file says them.
    pub fn table_mut(&mut self, table: Table) -> &mut Vec<Binding> {
        match table { Table::Prefix => &mut self.prefix_table, Table::Root => &mut self.root_table, Table::CopyVi => &mut self.copy_vi, Table::CopyEmacs => &mut self.copy_emacs }
    }
    pub fn bind(&mut self, table: Table, chord: Chord, command: String, repeat: bool) {
        self.copy_unbound.retain(|(t, c)| !(*t == table && *c == chord));
        let list = self.table_mut(table);
        list.retain(|b| b.chord != chord);
        list.push(Binding { chord, command, repeat, note: String::new() });
    }
    /// unbind -a: the table goes, its defaults with it.
    pub fn remove_table(&mut self, table: Table) {
        self.table_mut(table).clear();
        if !self.removed.contains(&table) { self.removed.push(table) }
    }

    /// Whether a copy-mode key is bound there (the table's defaults, less what was unbound).
    pub fn copy_key_bound(&self, table: Table, chord: &Chord) -> bool {
        let own = match table { Table::CopyVi => &self.copy_vi, _ => &self.copy_emacs };
        own.iter().any(|b| &b.chord == chord) || (!self.removed.contains(&table) && !self.copy_unbound.contains(&(table, *chord)))
    }

    pub fn unbind(&mut self, table: Table, chord: &Chord) {
        self.table_mut(table).retain(|b| &b.chord != chord);
        if matches!(table, Table::CopyVi | Table::CopyEmacs) && !self.copy_unbound.contains(&(table, *chord)) { self.copy_unbound.push((table, *chord)) }
    }

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
        if let Some(b) = self.root_table.iter().find(|b| b.command == command && !is_mouse(&b.chord.code)) { return Some(name(&b.chord)) }
        self.prefix_table.iter().find(|b| b.command == command).map(|b| format!("{} {}", name(&self.prefix), name(&b.chord)))
    }
}

fn name_of(chord: &Chord) -> String { name(chord) }

/// Where tmux's key tables put a key: by its key code (key_bindings_cmp) — the character, or
/// the special key's place in tmux's list past KEYC_BASE — with M-, C- and S- as higher bits.
pub fn order(chord: &Chord) -> (u8, u32) {
    let shifted_letter = matches!(chord.code, KeyCode::Char(c) if c.is_alphabetic()) && chord.mods.contains(KeyModifiers::SHIFT);
    let mut m = 0u8;
    if chord.mods.contains(KeyModifiers::ALT) { m |= 1 }
    if chord.mods.contains(KeyModifiers::CONTROL) { m |= 2 }
    if chord.mods.contains(KeyModifiers::SHIFT) && !shifted_letter { m |= 4 }
    // KEYC_BSPACE and what follows it: after the mouse keys.
    const AFTER_MOUSE: u32 = MOUSE_FIRST + MOUSE_SLOTS * 6;
    let base = match chord.code {
        KeyCode::Char(c) if shifted_letter => c.to_ascii_uppercase() as u32,
        KeyCode::Char(c) => c as u32,
        KeyCode::Enter => 0x0d, KeyCode::Tab => 0x09, KeyCode::Esc => 0x1b,
        KeyCode::Backspace => AFTER_MOUSE,
        KeyCode::F(n) if n >= 100 => KEYC_USER + (n - 100) as u32,
        KeyCode::F(n) if n > 12 => AFTER_MOUSE + 24 + (n - 13) as u32,
        KeyCode::F(n) => AFTER_MOUSE + n as u32,
        KeyCode::Insert => AFTER_MOUSE + 13, KeyCode::Delete => AFTER_MOUSE + 14, KeyCode::Home => AFTER_MOUSE + 15, KeyCode::End => AFTER_MOUSE + 16,
        KeyCode::PageDown => AFTER_MOUSE + 17, KeyCode::PageUp => AFTER_MOUSE + 18, KeyCode::BackTab => AFTER_MOUSE + 19,
        KeyCode::Up => AFTER_MOUSE + 20, KeyCode::Down => AFTER_MOUSE + 21, KeyCode::Left => AFTER_MOUSE + 22, KeyCode::Right => AFTER_MOUSE + 23,
        _ => KEYC_USER - 1,
    };
    (m, base)
}

// ── tmux's mouse keys ────────────────────────────────────────────────────────

/// tmux's KEYC_BASE: its special keys are characters past it, in the private-use plane — so are
/// hn's mouse keys, in tmux's order, and they sort as tmux's key codes do.
const KEYC_BASE: u32 = 0x10e000;
const KEYC_USER: u32 = 0x10f000;
/// KEYC_MOUSEMOVE_PANE, the first mouse key: each event takes six, one for each place.
const MOUSE_FIRST: u32 = KEYC_BASE + 8;
const MOUSE_SLOTS: u32 = 66;
/// Where a mouse event was (the six of each mouse key, in tmux's order).
pub const WHERE: [&str; 6] = ["Pane", "Status", "StatusLeft", "StatusRight", "StatusDefault", "Border"];
pub const PANE: usize = 0;
pub const STATUS: usize = 1;
pub const STATUS_LEFT: usize = 2;
pub const STATUS_RIGHT: usize = 3;
pub const STATUS_DEFAULT: usize = 4;
pub const BORDER: usize = 5;
/// The buttons a mouse key can name (tmux has no 4 or 5: those are the wheel).
pub const MOUSE_BUTTONS: [u8; 9] = [1, 2, 3, 6, 7, 8, 9, 10, 11];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseKind { Move, Down, Up, Drag, DragEnd, WheelUp, WheelDown, Second, Double, Triple }

/// tmux's mouse events in its order, each with a key per button or just the one.
const EVENTS: [(MouseKind, &str, bool); 10] = [
    (MouseKind::Move, "MouseMove", false), (MouseKind::Down, "MouseDown", true), (MouseKind::Up, "MouseUp", true),
    (MouseKind::Drag, "MouseDrag", true), (MouseKind::DragEnd, "MouseDragEnd", true), (MouseKind::WheelUp, "WheelUp", false),
    (MouseKind::WheelDown, "WheelDown", false), (MouseKind::Second, "SecondClick", true), (MouseKind::Double, "DoubleClick", true),
    (MouseKind::Triple, "TripleClick", true),
];

/// The key for a mouse event: its kind, its button (1–3, 6–11; none for the wheel and a move)
/// and where it was (WHERE's index).
pub fn mouse_code(kind: MouseKind, button: u8, place: usize) -> Option<KeyCode> {
    let mut slot = 0;
    for (k, _, buttons) in EVENTS {
        if k == kind {
            let b = if buttons { MOUSE_BUTTONS.iter().position(|x| *x == button)? as u32 } else { 0 };
            return char::from_u32(MOUSE_FIRST + (slot + b) * 6 + place as u32).map(KeyCode::Char);
        }
        slot += if buttons { 9 } else { 1 };
    }
    None
}

/// A mouse key's kind, button and place.
pub fn mouse_parts(code: &KeyCode) -> Option<(MouseKind, u8, usize)> {
    let KeyCode::Char(c) = code else { return None };
    let i = (*c as u32).checked_sub(MOUSE_FIRST)?;
    if i >= MOUSE_SLOTS * 6 { return None }
    let (mut slot, place) = (i / 6, (i % 6) as usize);
    for (k, _, buttons) in EVENTS {
        let n = if buttons { 9 } else { 1 };
        if slot < n { return Some((k, if buttons { MOUSE_BUTTONS[slot as usize] } else { 0 }, place)) }
        slot -= n;
    }
    None
}

pub fn is_mouse(code: &KeyCode) -> bool { mouse_parts(code).is_some() }

fn mouse_name(code: &KeyCode) -> Option<String> {
    let (kind, button, place) = mouse_parts(code)?;
    let (_, name, buttons) = EVENTS.iter().find(|(k, _, _)| *k == kind)?;
    Some(if *buttons { format!("{name}{button}{}", WHERE[place]) } else { format!("{name}{}", WHERE[place]) })
}

/// A mouse key by its name, in any case (key_string_search_table); MouseMove… is not one tmux
/// lets you bind.
fn mouse_from_name(s: &str) -> Option<KeyCode> {
    let lower = s.to_ascii_lowercase();
    for (kind, name, buttons) in EVENTS {
        if kind == MouseKind::Move { continue }
        let Some(rest) = lower.strip_prefix(&name.to_ascii_lowercase()) else { continue };
        let (button, place) = if buttons {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            match digits.parse::<u8>() { Ok(b) if b.to_string() == digits => (b, &rest[digits.len()..]), _ => continue }
        } else { (0, rest) };
        let Some(place) = WHERE.iter().position(|w| w.to_ascii_lowercase() == place) else { continue };
        if let Some(code) = mouse_code(kind, button, place) { return Some(code) }
    }
    None
}

/// tmux's copy-mode tables as it starts (tests/fixtures), read once.
fn copy_defaults(t: Table) -> &'static [Binding] {
    static VI: std::sync::OnceLock<Vec<Binding>> = std::sync::OnceLock::new();
    static EMACS: std::sync::OnceLock<Vec<Binding>> = std::sync::OnceLock::new();
    if t == Table::CopyVi { VI.get_or_init(|| include_str!("../tests/fixtures/tmux-3.5a-copy-mode-vi.txt").lines().filter_map(fixture_binding).collect()) }
    else { EMACS.get_or_init(|| include_str!("../tests/fixtures/tmux-3.5a-copy-mode.txt").lines().filter_map(fixture_binding).collect()) }
}

/// A line of `tmux list-keys` as a binding (the fixtures).
fn fixture_binding(line: &str) -> Option<Binding> {
    let words = crate::tmuxconf::split_marked(line).into_iter().next()?;
    let at = words.iter().position(|w| w == "-T")? + 2;
    let repeat = words.iter().any(|w| w == "-r");
    let chord = parse(words.get(at)?).ok()?;
    let command = words[at + 1..].iter().map(|w| crate::tmuxconf::quote_word(w)).collect::<Vec<_>>().join(" ");
    Some(Binding { chord, command, repeat, note: String::new() })
}

/// tmux's notes for its prefix keys (`tmux list-keys -N`), by key name.
fn tmux_notes() -> std::collections::HashMap<String, String> {
    include_str!("../tests/fixtures/tmux-3.5a-notes.txt").lines().filter_map(|l| {
        let rest = l.strip_prefix("C-b ")?;
        let (key, note) = rest.split_once(' ')?;
        Some((key.to_string(), note.trim_start().to_string()))
    }).collect()
}

pub fn table_named(name: &str) -> Option<Table> {
    match name { "root" => Some(Table::Root), "prefix" => Some(Table::Prefix), "copy-mode-vi" => Some(Table::CopyVi), "copy-mode" => Some(Table::CopyEmacs), _ => None }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
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
        KeyCode::Char(_) if is_mouse(&chord.code) => mouse_name(&chord.code).unwrap_or_default(),
        KeyCode::Char(c) if shifted_letter && chord.mods.contains(KeyModifiers::SHIFT) => c.to_ascii_uppercase().to_string(),
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "Enter".into(), KeyCode::Tab => "Tab".into(), KeyCode::BackTab => "BTab".into(), KeyCode::Esc => "Escape".into(),
        KeyCode::Backspace => "BSpace".into(), KeyCode::Up => "Up".into(), KeyCode::Down => "Down".into(), KeyCode::Left => "Left".into(),
        KeyCode::Right => "Right".into(), KeyCode::PageUp => "PPage".into(), KeyCode::PageDown => "NPage".into(), KeyCode::Home => "Home".into(),
        KeyCode::End => "End".into(), KeyCode::Delete => "DC".into(), KeyCode::Insert => "IC".into(), KeyCode::F(n) if n >= 100 => format!("User{}", n - 100),
        KeyCode::F(n) if n > 12 => KEYPAD.get(n as usize - 13).map(|k| k.to_string()).unwrap_or_else(|| format!("F{n}")),
        KeyCode::F(n) => format!("F{n}"),
        _ => "?".into(),
    });
    out
}

/// tmux's keypad keys (KP/ … KP.), kept past F12 so they bind and list as tmux's do.
const KEYPAD: [&str; 16] = ["KP/", "KP*", "KP-", "KP7", "KP8", "KP9", "KP+", "KP4", "KP5", "KP6", "KP1", "KP2", "KP3", "KPEnter", "KP0", "KP."];

/// A key as tmux writes it (`C-a`, `M-Left`, `S-Up`, `Space`, `\;`, `MouseDown1Pane`) or as a
/// person does (`ctrl+a`) — tmux's key_string_lookup_string: modifiers in either case, `^x` for
/// C-x, a key's name in any case.
pub fn parse(text: &str) -> Result<Chord, String> {
    let raw = text.trim();
    // A lone quote IS the key (`unbind '"'` arrives here as `"`).
    if raw.chars().count() == 1 { return Ok(Chord::normal(KeyCode::Char(raw.chars().next().unwrap()), KeyModifiers::NONE)) }
    let t = raw.trim_matches('"').trim_matches('\'');
    let t = t.strip_prefix('\\').unwrap_or(t);
    // `ctrl+a`, `alt+shift+x`: a person's spelling (tmux's `C-+` and `KP+` are not).
    let words_first = t.split('+').next().map(|w| w.len() > 1 && w.chars().all(|c| c.is_ascii_alphabetic())).unwrap_or(false);
    if t.contains('+') && t.len() > 1 && words_first && !t.to_ascii_uppercase().starts_with("KP") { return Chord::parse(t) }
    let unknown = || format!("unknown key: {raw}");
    let mut mods = KeyModifiers::NONE;
    let mut rest = t;
    // ^x: C-x (`^` alone, or with more after it, is the start of a longer name).
    if let Some(r) = rest.strip_prefix('^') {
        if r.chars().count() == 1 { return Ok(Chord::normal(KeyCode::Char(r.chars().next().unwrap().to_ascii_lowercase()), KeyModifiers::CONTROL)) }
        if !r.is_empty() { mods |= KeyModifiers::CONTROL; rest = r }
    }
    loop {
        let b = rest.as_bytes();
        if b.len() >= 2 && b[1] == b'-' {
            let m = match b[0] { b'C' | b'c' => KeyModifiers::CONTROL, b'M' | b'm' => KeyModifiers::ALT, b'S' | b's' => KeyModifiers::SHIFT, b'D' | b'd' if b.len() > 2 => KeyModifiers::SUPER, _ => return Err(unknown()) };
            mods |= m;
            rest = &rest[2..];
            continue;
        }
        break;
    }
    if rest.is_empty() { return Err(unknown()) }
    if rest.chars().count() == 1 {
        let c = rest.chars().next().unwrap();
        if (c as u32) < 32 { return Err(unknown()) }
        return Ok(Chord::normal(KeyCode::Char(c), mods));
    }
    let lower = rest.to_ascii_lowercase();
    let code = match lower.as_str() {
        "space" => KeyCode::Char(' '), "enter" => KeyCode::Enter, "tab" => KeyCode::Tab, "btab" => KeyCode::BackTab, "escape" => KeyCode::Esc,
        "bspace" => KeyCode::Backspace, "up" => KeyCode::Up, "down" => KeyCode::Down, "left" => KeyCode::Left, "right" => KeyCode::Right,
        "ppage" | "pageup" | "pgup" => KeyCode::PageUp, "npage" | "pagedown" | "pgdn" => KeyCode::PageDown, "home" => KeyCode::Home, "end" => KeyCode::End,
        "dc" | "delete" => KeyCode::Delete, "ic" | "insert" => KeyCode::Insert,
        // tmux knows F1 to F12, and User0… (user-keys) — kept here past the F keys.
        f if f.len() > 1 && f.starts_with('f') && matches!(f[1..].parse::<u8>(), Ok(1..=12)) && !f[1..].starts_with('0') => KeyCode::F(f[1..].parse().unwrap()),
        u if u.starts_with("user") && matches!(u[4..].parse::<u8>(), Ok(0..=155)) => KeyCode::F(100 + u[4..].parse::<u8>().unwrap()),
        k if KEYPAD.iter().any(|p| p.to_ascii_lowercase() == k) => KeyCode::F(13 + KEYPAD.iter().position(|p| p.to_ascii_lowercase() == k).unwrap() as u8),
        _ => match mouse_from_name(rest) { Some(code) => code, None => {
            // One character as UTF-8 (a key tmux reads as the character).
            return Err(unknown())
        } },
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
    fn mouse_keys_as_tmux_names_them() {
        for n in ["MouseDown1Pane", "MouseDragEnd1Pane", "WheelUpStatus", "DoubleClick3Border", "MouseUp11StatusDefault", "TripleClick1StatusLeft", "SecondClick2StatusRight", "M-MouseDown3Pane", "S-WheelDownPane", "C-M-MouseDrag1Border"] {
            assert_eq!(name(&parse(n).unwrap()), n);
        }
        assert_eq!(name(&parse("mousedown1pane").unwrap()), "MouseDown1Pane");
        assert!(parse("MouseMovePane").is_err());
        assert!(parse("MouseDown4Pane").is_err());
        assert!(parse("MouseDown01Pane").is_err());
        assert_eq!(name(&parse("enter").unwrap()), "Enter");
        assert_eq!(name(&parse("c-M-x").unwrap()), "C-M-x");
        assert_eq!(name(&parse("^A").unwrap()), "C-a");
        assert_eq!(name(&parse("KP+").unwrap()), "KP+");
        assert_eq!(name(&parse("C-+").unwrap()), "C-+");
        // tmux's key codes: the mouse keys before BSpace, F1 and the arrows; modifiers after all.
        let o = |n: &str| order(&parse(n).unwrap());
        assert!(o("MouseDown1Pane") < o("MouseDown1Status") && o("WheelUpPane") < o("DoubleClick1Pane") && o("TripleClick11Border") < o("BSpace"));
        assert!(o("~") < o("MouseDown1Pane") && o("Right") < o("KP/") && o("KP.") < o("User0") && o("User0") < o("M-a"));
    }

    #[test]
    fn defaults_are_tmux() {
        let km = Keymap::tmux_defaults();
        assert_eq!(km.prefix_command(&ch('%')).unwrap().command, "split-window -h");
        assert_eq!(km.prefix_command(&ch('"')).unwrap().command, "split-window");
        assert_eq!(km.prefix_command(&ch('c')).unwrap().command, "new-window");
        assert!(km.prefix_command(&Chord::normal(KeyCode::Up, KeyModifiers::NONE)).unwrap().repeat);
        // The root table is tmux's: its mouse keys, nothing else.
        assert!(km.root_table.iter().all(|b| is_mouse(&b.chord.code)));
        assert_eq!(km.root_table.len(), 16);
        assert_eq!(km.hint("new-window").as_deref(), Some("C-b c"));
    }
}

#[cfg(test)]
mod tmux_parity {
    use super::*;

    /// tmux 3.5a's own prefix table (`tmux -f /dev/null list-keys -T prefix`): every key in it does
    /// in hn what it does in tmux — the same command, the same repeat.
    #[test]
    fn every_tmux_key_does_what_tmux_does() {
        let km = Keymap::tmux_defaults();
        let mut wrong = Vec::new();
        for line in include_str!("../tests/fixtures/tmux-3.5a-prefix.txt").lines() {
            let words: Vec<&str> = line.split(' ').collect();
            let repeat = words.contains(&"-r");
            let at = words.iter().position(|w| *w == "prefix").unwrap() + 1;
            let key = words[at].strip_prefix('\\').unwrap_or(words[at]);
            let tmux_cmd = crate::commands::canonical_name(words[at + 1]);
            // C-b itself is the prefix (C-b C-b sends it); tested by the prefix handling instead.
            if key == "C-b" { continue }
            let chord = parse(key).unwrap_or_else(|e| panic!("{key}: {e}"));
            match km.prefix_command(&chord) {
                Some(b) => {
                    let ours = crate::commands::canonical_name(b.command.split_whitespace().next().unwrap_or(""));
                    if ours != tmux_cmd || b.repeat != repeat { wrong.push(format!("{key}: tmux `{tmux_cmd}`{} — hn `{}`{}", if repeat { " -r" } else { "" }, b.command, if b.repeat { " -r" } else { "" })) }
                }
                None => wrong.push(format!("{key}: unbound in hn (tmux: {tmux_cmd})")),
            }
        }
        assert!(wrong.is_empty(), "keys that differ from tmux 3.5a:\n{}", wrong.join("\n"));
    }
}

