//! The settings panel: `hn theme` drawn as one centred panel in the New Harness style — a quiet
//! backdrop over the panes, no border, and a fixed size, so it stays put as you step into a
//! section. The list is on the left; the right is one preview of the whole look (every section at
//! once), which only changes where the row under the cursor would change it.
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::App;
use crate::modal::PickerKind;
use crate::picker::Picker;
use crate::terminal_themes::{TerminalTheme, TERMINAL_THEMES};
use crate::theme;

/// `@hn-lists fzf`: hn's lists drawn as fzf draws them (full screen, FZF_DEFAULT_OPTS's look)
/// rather than as this panel — for those who want fzf's own. Settings and commands stay panels.
static FZF_LISTS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_fzf_lists(on: bool) { FZF_LISTS.store(on, std::sync::atomic::Ordering::Relaxed) }

/// The lists drawn as this panel rather than as fzf's full-screen list: every one, unless
/// `@hn-lists fzf` asks for fzf's.
pub fn is_panel(kind: &PickerKind) -> bool {
    matches!(kind, PickerKind::Theme | PickerKind::Commands | PickerKind::Keybinds | PickerKind::Devices(_) | PickerKind::Models) || !FZF_LISTS.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether [kind]'s list reads top-down (↑ toward its first row): fzf's under --layout=reverse,
/// and the panel's menus; the launcher's lists read bottom-up in the panel too, their query
/// under them, as fzf's do.
pub fn top_down(kind: &PickerKind) -> bool {
    if is_panel(kind) { !crate::modal::is_launcher(kind) } else { theme::fzf().reverse }
}

/// Step into [section]: its options in the same list, the cursor on the one in use.
pub fn open_section(app: &App, picker: &mut Picker, section: &str) {
    picker.theme_in = Some(section.to_string());
    picker.clear_query();
    picker.rows.clear();
    picker.set_rows(crate::modal::theme_options(app, section));
    let current = picker.rows.iter().find(|r| r.lead.iter().any(|s| s.content.as_ref() == "✓ ")).map(|r| r.id.clone());
    picker.scroll = 0;
    if let Some(id) = current { cursor_to(picker, &id) } else { picker.vset(0, 1) }
}

/// Step back out to the sections, the cursor on the one just left.
pub fn close_section(app: &App, picker: &mut Picker) {
    let from = picker.theme_in.take().map(|s| format!("section:{s}"));
    picker.clear_query();
    picker.rows.clear();
    picker.set_rows(crate::modal::theme_sections(app));
    picker.scroll = 0;
    if let Some(id) = from { cursor_to(picker, &id) }
}

/// Settings chosen in the command list: the same panel shows the sections, and Esc comes back.
pub fn into_settings(app: &App, picker: &mut Picker) {
    picker.from_commands = true;
    picker.placeholder = "Search appearance".into();
    picker.keep_order = true;
    picker.live = false;
    picker.theme_in = None;
    picker.clear_query();
    picker.rows.clear();
    picker.set_rows(crate::modal::theme_sections(app));
    picker.scroll = 0;
    picker.vset(0, 1);
}

// ── keys ──
/// Keybinds chosen in the command list: the same panel lists the keys, and Esc comes back.
pub fn into_keybinds(app: &App, picker: &mut Picker) {
    picker.from_commands = true;
    picker.placeholder = "Search keybinds".into();
    picker.keep_order = true;
    picker.live = false;
    picker.theme_in = None;
    picker.clear_query();
    picker.rows.clear();
    picker.set_rows(crate::modal::keybind_rows(app));
    picker.scroll = 0;
    picker.vset(0, 1);
}

/// Back from the settings to the command list, the cursor on Settings.
pub fn back_to_commands(app: &App, picker: &mut Picker) { back_to_commands_at(app, picker, "cmd:theme") }

/// Back to the command list, the cursor on [at] (the command that opened the panel).
pub fn back_to_commands_at(app: &App, picker: &mut Picker, at: &str) {
    picker.from_commands = false;
    picker.theme_in = None;
    picker.placeholder = "Type a command — appearance, new, layout, models…".into();
    picker.keep_order = false;
    picker.live = true;
    picker.clear_query();
    picker.rows.clear();
    picker.set_rows(crate::modal::command_rows_for(app, false, false));
    picker.scroll = 0;
    cursor_to(picker, at);
}

// ── tmux's commands: one row in the command list, Enter lists them here ──

/// The command list is showing tmux's commands (Enter on their row; Esc comes back).
pub fn in_tmux(picker: &Picker) -> bool { picker.theme_in.as_deref() == Some("tmux") }

/// Enter on "tmux commands…": tmux's commands, grouped, in this same panel.
pub fn into_tmux(app: &App, picker: &mut Picker) {
    picker.theme_in = Some("tmux".into());
    picker.placeholder = "Search tmux commands".into();
    picker.clear_query();
    picker.rows.clear();
    picker.set_rows(crate::modal::command_rows_for(app, false, true));
    picker.scroll = 0;
    picker.vset(0, 1);
}

/// Put the cursor on the row [id] (where the filter shows it).
pub fn cursor_to(picker: &mut Picker, id: &str) { picker.select(id) }

// ── keys: the prefix and a command's key, chosen in the panel ────────────────────

/// What the next key becomes: the prefix ([second]: the second one), or [command]'s key after the
/// prefix. [pending]: a key that runs another command, pressed once — the same key again takes it.
#[derive(Clone, Debug)]
pub enum Capture {
    Prefix { second: bool },
    Command { command: String, title: String, own: bool, pending: Option<crate::keys::Chord> },
}

const PRESS: &str = "press a key · Esc cancels";
const AGAIN: &str = "press another key · Esc cancels";

/// A Keybinds row chosen: the next key pressed becomes the prefix (`prefix`, `prefix2`) or a
/// command's (`key`, its index). None: not a Keybinds row.
pub fn set_key(app: &mut App, knob: &str, value: &str) -> Option<String> {
    match knob {
        "key" => {
            let (title, runs, _) = value.parse::<usize>().ok().and_then(|i| crate::modal::KEYBINDS.get(i))?;
            app.capturing = Some(Capture::Command { command: runs.to_string(), title: title.to_string(), own: true, pending: None });
            Some(format!("{}: {PRESS}", title.trim_end_matches('…')))
        }
        "prefix" => { app.capturing = Some(Capture::Prefix { second: false }); Some(format!("Prefix: {PRESS}")) }
        "prefix2" => { app.capturing = Some(Capture::Prefix { second: true }); Some("Second prefix: press a key · ⌫ none · Esc cancels".into()) }
        _ => None,
    }
}

/// `set -g prefix` (or `prefix2`; [chord] None: none) — every hn window takes it — and tui.toml's
/// `prefix`, so it is the prefix the next time hn starts too.
fn set_prefix_option(app: &mut App, second: bool, chord: Option<crate::keys::Chord>) -> std::io::Result<()> {
    let option = if second { "prefix2" } else { "prefix" };
    let name = chord.map(|c| crate::keys::name(&c)).unwrap_or_else(|| "None".to_string());
    crate::commands::execute(app, &format!("set -g {option} {}", crate::tmuxconf::quote_word(&name)));
    app.server_dirty = true;
    crate::config::write_top(option, chord.is_some().then_some(name.as_str()))
}

/// The prefix (or the second one, [chord] None: none) set and saved — as `set -g prefix` does in
/// tmux: no binding added or changed (what the key ran after the prefix it still runs).
fn apply_prefix(app: &mut App, second: bool, chord: Option<crate::keys::Chord>) -> String {
    let what = if second { "Second prefix" } else { "Prefix" };
    let shown = chord.map(|c| crate::keys::name(&c)).unwrap_or_else(|| "none".into());
    match set_prefix_option(app, second, chord) { Ok(()) => format!("{what}: {shown} — saved"), Err(e) => format!("{what}: {shown} — could not save: {e}") }
}

/// The key pressed for a prefix: any key the terminal sends becomes it at once (Esc cancels; for
/// the second, ⌫ is none). A key that also runs something is the person's to choose, as in tmux.
fn captured_prefix(app: &mut App, second: bool, key: crossterm::event::KeyEvent) -> String {
    use crossterm::event::KeyCode;
    if key.code == KeyCode::Esc && key.modifiers.is_empty() { return "Unchanged".into() }
    if second && key.code == KeyCode::Backspace && key.modifiers.is_empty() { return apply_prefix(app, true, None) }
    apply_prefix(app, second, Some(crate::keys::of(&key)))
}

/// Alt-k on a command in the command panel: its key is the next key you press. A command with
/// no key of its own to run (one that needs words) says so.
pub fn capture_for_row(app: &mut App, picker: &mut Picker) {
    let Some(id) = picker.current_id() else { return };
    let title = picker.rows.iter().find(|r| r.id == id).map(|r| r.label.clone()).unwrap_or_default();
    let command = if let Some(name) = id.strip_prefix("tmux:") { (!crate::modal::NEEDS_ARGS.contains(&name)).then(|| name.to_string()) }
        else { id.strip_prefix("cmd:").and_then(crate::modal::runs_of).map(str::to_string) };
    let Some(command) = command else { picker.say(format!("{title} can not have a key here: it asks for words")); return };
    picker.say(format!("{}: {PRESS}", title.trim_end_matches('…')));
    app.capturing = Some(Capture::Command { command, title, own: id.starts_with("cmd:"), pending: None });
}

/// The key pressed while waiting ([Capture]): Esc cancels; a key that can not be one is refused,
/// and one that runs another command is named first — the same key again replaces it, any other
/// keeps it; else it becomes the command's. What happened is said in the panel, whose rows show it.
pub fn captured(app: &mut App, key: crossterm::event::KeyEvent) {
    use crossterm::event::KeyCode;
    let (command, title, own, pending) = match app.capturing.take() {
        Some(Capture::Command { command, title, own, pending }) => (command, title, own, pending),
        Some(Capture::Prefix { second }) => {
            let said = captured_prefix(app, second, key);
            return show_captured(app, said);
        }
        None => return,
    };
    let chord = crate::keys::of(&key);
    let name = crate::keys::name(&chord);
    let prefix = crate::keys::name(&app.keymap.prefix);
    let wait = |pending| Some(Capture::Command { command: command.clone(), title: title.clone(), own, pending });
    let (said, next) = if key.code == KeyCode::Esc && key.modifiers.is_empty() { ("Unchanged".to_string(), None) }
        else if let Some(p) = pending { if p == chord { (rebind(app, &command, &title, own, chord), None) } else { ("Unchanged".to_string(), None) } }
        else if chord == app.keymap.prefix { (format!("{name} is the prefix — {AGAIN}"), wait(None)) }
        else if Some(chord) == app.keymap.prefix2 { (format!("{name} is the second prefix — {AGAIN}"), wait(None)) }
        else if key.code == KeyCode::Enter { (format!("Enter can not be a key here ({prefix} Enter is Commands) — {AGAIN}"), wait(None)) }
        else if key.code == KeyCode::Esc { (format!("Esc can not be a key here (it cancels) — {AGAIN}"), wait(None)) }
        else if let Some(other) = app.keymap.prefix_command(&chord).map(|b| b.command.clone()).filter(|c| *c != full_command(app, &command, own)) {
            (format!("{prefix} {name} is {} — {name} again to replace · Esc to keep", running(app, &chord, &other)), wait(Some(chord)))
        }
        else { (rebind(app, &command, &title, own, chord), None) };
    app.capturing = next;
    show_captured(app, said)
}

/// The panel's rows again, with the keys as they are now, and [said] in it.
fn show_captured(app: &mut App, said: String) {
    if let Some(crate::modal::Modal::Picker { kind, picker }) = app.modal.take() {
        let mut picker = picker;
        let at = picker.current_id();
        match &kind {
            PickerKind::Keybinds => picker.set_rows(crate::modal::keybind_rows(app)),
            PickerKind::Commands => picker.set_rows(crate::modal::command_rows_for(app, !picker.query.is_empty(), in_tmux(&picker))),
            _ => {}
        }
        if let Some(at) = at { cursor_to(&mut picker, &at) }
        picker.say(said);
        app.modal = Some(crate::modal::Modal::Picker { kind, picker });
    } else { app.say(said, theme::MUTED) }
    app.redraw_all = true;
}

/// What [chord] (running [command]) is called: its Keybinds title, else the command itself.
fn running(app: &App, chord: &crate::keys::Chord, command: &str) -> String {
    crate::modal::KEYBINDS.iter().find(|(_, runs, _)| crate::modal::key_running(app, runs).as_ref() == Some(chord))
        .map(|(title, _, _)| title.trim_end_matches('…').to_string()).unwrap_or_else(|| command.to_string())
}

/// [command]'s key now: the one running exactly it — or, for one of hn's own commands, the key
/// the panel shows for it (its command with words after it).
fn current_key(app: &App, command: &str, own: bool) -> Option<crate::keys::Chord> {
    if own { crate::modal::key_running(app, command) } else { app.keymap.prefix_table.iter().find(|b| b.command == command).map(|b| b.chord) }
}

/// What [command]'s key runs in full (a rename still asks for the name) — [command] itself where
/// it has no key.
fn full_command(app: &App, command: &str, own: bool) -> String {
    current_key(app, command, own).and_then(|o| app.keymap.prefix_command(&o)).map(|b| b.command.clone()).unwrap_or_else(|| command.to_string())
}

/// [command] on [chord] after the prefix, and on no other key (a command with two keys, `%` and
/// `|`, has the one chosen); whatever the new key ran replaced — all written to tui.toml's
/// `[prefix_keys]`.
fn rebind(app: &mut App, command: &str, title: &str, own: bool, chord: crate::keys::Chord) -> String {
    use crate::keys::Table;
    let title = title.trim_end_matches('…');
    let key = crate::keys::name(&chord);
    let was = app.keymap.prefix_command(&chord).map(|b| b.command.clone()).filter(|c| c != command && !c.contains(command));
    let mut saved = Ok(());
    // The new key runs what the old one did, in full.
    let full = full_command(app, command, own);
    let olds: Vec<crate::keys::Chord> = app.keymap.prefix_table.iter().filter(|b| b.command == full && b.chord != chord).map(|b| b.chord).collect();
    for old in olds {
        app.keymap.unbind(Table::Prefix, &old);
        saved = saved.and(crate::config::write_prefix_key(&crate::keys::name(&old), "none"));
    }
    app.keymap.bind(Table::Prefix, chord, full.clone(), false);
    app.server_dirty = true;
    saved = saved.and(crate::config::write_prefix_key(&key, &full));
    let prefix = crate::keys::name(&app.keymap.prefix);
    let replaced = was.map(|c| format!(" (it ran {c})")).unwrap_or_default();
    match saved { Ok(()) => format!("{title}: {prefix} {key}{replaced} — saved to tui.toml"), Err(e) => format!("{title}: {prefix} {key}{replaced} — could not write tui.toml: {e}") }
}

/// The panel's colours, shared with the New Harness form so the two read as one component:
/// its surface, muted and accent text, and the backdrop laid over the panes behind it.
pub struct Chrome { pub base: Style, pub muted: Style, pub accent: Style, pub backdrop: Style, pub selected: Style }

pub fn chrome() -> Chrome {
    if theme::no_color() {
        let base = Style::default();
        return Chrome { base, muted: base.add_modifier(Modifier::DIM), accent: base.add_modifier(Modifier::BOLD), backdrop: base.add_modifier(Modifier::DIM), selected: base.add_modifier(Modifier::REVERSED) };
    }
    chrome_for(theme::pane_palette())
}

/// The panel's colours from [pal] — the theme in use (or the terminal's own colours): the panel is
/// its surface lifted a little toward the text, the backdrop its surface pushed down, so the panel
/// stands out in any theme, light or dark.
pub fn chrome_for(pal: theme::PanePalette) -> Chrome {
    let (bg, fg) = (pal.background, pal.foreground);
    let light = matches!(bg, Color::Rgb(r, g, b) if 299 * r as u32 + 587 * g as u32 + 114 * b as u32 > 128_000);
    let floor = if light { Color::Rgb(160, 160, 160) } else { Color::Rgb(0, 0, 0) };
    let panel = mix(bg, fg, if light { 3 } else { 7 });
    let base = theme::fg(fg).bg(theme::depth_fit(panel));
    let muted = base.patch(theme::fg(pal.muted));
    let accent = base.patch(theme::bold(theme::accent()));
    let backdrop = theme::fg(mix(bg, fg, 18)).bg(theme::depth_fit(mix(bg, floor, 45)))
        .remove_modifier(Modifier::BOLD | Modifier::REVERSED | Modifier::DIM | Modifier::UNDERLINED);
    // (The cursor's row: the text's own colour, bold, on a lifted surface — the accent is for the
    // pointer and the query's mark, not for words.)
    // (Lifted further where the terminal has 256 colours and a small lift is the panel's colour.)
    let panel_fit = theme::depth_fit(panel);
    let lifted = [10, 18, 28, 40].iter().map(|a| theme::depth_fit(mix(panel, fg, *a))).find(|c| *c != panel_fit).unwrap_or(panel_fit);
    let selected = base.add_modifier(Modifier::BOLD).bg(lifted);
    Chrome { base, muted, accent, backdrop, selected }
}

/// A pane you are not in, a little quieter (`@hn-dim on`): every cell's text moved toward its
/// background — the terminal's own colours ([background], [foreground]) where it keeps them, and
/// the terminal's faint where the text is one of its indexed colours.
pub fn dim(buf: &mut Buffer, area: Rect, background: Color, foreground: Color) {
    const DIM: u16 = 35;
    for y in area.y..area.bottom() { for x in area.x..area.right() {
        let Some(c) = buf.cell_mut((x, y)) else { continue };
        let bg = if matches!(c.bg, Color::Rgb(..)) { c.bg } else { background };
        match c.fg {
            Color::Rgb(..) => c.fg = theme::depth_fit(mix(c.fg, bg, DIM)),
            Color::Reset => c.fg = theme::depth_fit(mix(foreground, bg, DIM)),
            _ => c.modifier.insert(Modifier::DIM),
        }
    } }
}

/// [a] moved [amount] % toward [b] (RGB; any other colour stays as it is).
fn mix(a: Color, b: Color, amount: u16) -> Color {
    let (Color::Rgb(ar, ag, ab), Color::Rgb(br, bg, bb)) = (a, b) else { return a };
    let c = |a: u8, b: u8| ((a as u16 * (100 - amount) + b as u16 * amount) / 100) as u8;
    Color::Rgb(c(ar, br), c(ag, bg), c(ab, bb))
}

/// Dim every cell of [area] under the panel, keeping what is drawn there visible.
pub fn backdrop(buf: &mut Buffer, area: Rect, style: Style) {
    crate::term_out::clear_extras(area);
    for y in area.y..area.bottom() { for x in area.x..area.right() { if let Some(c) = buf.cell_mut((x, y)) { c.set_style(style); } } }
}

/// Fill [r] with the panel's surface — no border: the surface against the backdrop is the edge.
pub fn fill(buf: &mut Buffer, r: Rect, base: Style) {
    crate::term_out::clear_extras(r);
    for y in r.y..r.bottom() { for x in r.x..r.right() { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); c.set_style(base); } } }
}

/// [text] at (x, y) in at most [width] columns, cut with an ellipsis. Returns the columns used.
pub fn put(buf: &mut Buffer, x: u16, y: u16, width: u16, text: &str, style: Style) -> u16 {
    if width == 0 { return 0 }
    let limit = width as usize;
    let cut = text.width() > limit;
    let (mut out, mut used) = (String::new(), 0);
    for ch in text.chars().filter(|c| !c.is_control()) {
        let w = ch.width().unwrap_or(0);
        if used + w > limit - usize::from(cut) { break }
        out.push(ch);
        used += w;
    }
    if cut { out.push('…'); used += 1 }
    buf.set_stringn(x, y, out, limit, style);
    used as u16
}

// ── sizes ──

/// A panel's size: Large for a list with a preview, Palette for a short menu near the top, Form
/// for a form, as tall as its fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelSize { Large, Palette, Form }

/// Of the window, in tenths: the most a panel takes each way (a palette's height, its own).
const SHARE: u16 = 9;
const PALETTE_SHARE_H: u16 = 7;
/// Large: as wide as this at most, however wide the window.
const LARGE_MAX_W: u16 = 160;
/// (Room for a command's name, its hint and its key apart.)
const PALETTE_W: u16 = 96;
/// (New harness's form: its chooser opens beside it where there is room.)
const FORM_W: u16 = 60;
/// A form keeps this many rows however short the window (its action stays on screen), up to the
/// window's own.
const FORM_MIN_H: u16 = 5;
/// A palette's top: this part of the way down the window (in its upper third).
const PALETTE_TOP: u16 = 6;
/// A palette's rows around its list: the title, the query, the gaps and the footer.
const PALETTE_CHROME: u16 = 8;
/// Around any panel, at least 4 columns and 2 rows of the window.
const MARGIN_W: u16 = 4;
const MARGIN_H: u16 = 2;

impl PickerKind {
    /// Each list's size, in one place: a new kind does not compile until it has one.
    pub fn size(&self) -> PanelSize {
        match self {
            // (Every launcher tab is the same size — Help too — so ←/→ on the tab row never moves it.)
            PickerKind::Open { .. } | PickerKind::Palette | PickerKind::Projects | PickerKind::Models | PickerKind::Inbox | PickerKind::Machines | PickerKind::Store | PickerKind::Help | PickerKind::Theme
                | PickerKind::Route { .. } | PickerKind::Messages | PickerKind::Keys | PickerKind::Buffers | PickerKind::Output { .. } | PickerKind::Devices(_) => PanelSize::Large,
            PickerKind::Commands | PickerKind::Keybinds | PickerKind::Layout => PanelSize::Palette,
        }
    }
}

/// Where a panel of [size] goes in [body]; [content]: the rows it needs (a palette's list rows, a
/// form's height) — a large panel's size is the window's.
pub fn area(body: Rect, size: PanelSize, content: u16) -> Rect {
    let most_w = (body.width * SHARE / 10).min(body.width.saturating_sub(MARGIN_W));
    let most_h = (body.height * SHARE / 10).min(body.height.saturating_sub(MARGIN_H));
    let (w, h) = match size {
        PanelSize::Large => (most_w.min(LARGE_MAX_W), most_h),
        PanelSize::Palette => (most_w.min(PALETTE_W), content.saturating_add(PALETTE_CHROME).min(body.height * PALETTE_SHARE_H / 10).min(most_h)),
        PanelSize::Form => (most_w.min(FORM_W), content.min(most_h).max(FORM_MIN_H.min(body.height))),
    };
    let x = body.x + (body.width - w) / 2;
    let y = if size == PanelSize::Palette { body.y + (body.height - h).min(body.height / PALETTE_TOP) } else { body.y + (body.height - h) / 2 };
    Rect::new(x, y, w, h)
}

/// Draw the panel for [picker] over [body]; returns where the terminal cursor goes (the query),
/// and the rect on the right where the list's own preview goes (the caller draws it: a harness's
/// preview is its live screen, which needs the whole app).
pub fn draw(buf: &mut Buffer, app: &App, body: Rect, kind: &PickerKind, picker: &mut Picker) -> (Option<Position>, Option<Rect>) {
    // ── machines & devices ── (the same panel, laid out by devices.rs: Add phone's QR code takes
    // the panel's whole height, and each view draws its own right side)
    if let PickerKind::Devices(view) = kind { return (crate::devices::draw(buf, app, body, *view, picker), None) }
    let c = chrome();
    backdrop(buf, body, c.backdrop);
    if body.width < 24 || body.height < 8 {
        put(buf, body.x, body.y, body.width, &format!("{} · resize or Esc", title(app, kind, picker)), c.base);
        return (None, None);
    }
    // (A palette as tall as all its rows, not the ones a search leaves, so it stays put as you type;
    // Commands' search reaches every tmux command, so theirs is the most a palette takes.)
    let all = if matches!(kind, PickerKind::Commands) { u16::MAX } else { picker.rows.len().min(u16::MAX as usize) as u16 };
    let r = area(body, kind.size(), all);
    fill(buf, r, c.base);
    picker.screen_area.set(r);
    let (x, right) = (r.x + 2, r.right().saturating_sub(2));
    let inner_w = right.saturating_sub(x);

    // Title: where you are, and how to leave.
    let mut at = x + put(buf, x, r.y + 1, inner_w, &title(app, kind, picker), c.base.add_modifier(Modifier::BOLD));
    if let Some(section) = picker.theme_in.as_deref() {
        at += put(buf, at, r.y + 1, right.saturating_sub(at), "  ›  ", c.muted);
        at += put(buf, at, r.y + 1, right.saturating_sub(at), section_title(section), c.accent);
    }
    // What the list says of itself (a count, "searching…"), before the way out — with a spinner
    // while it waits on something (a read, a model moving), so a still panel is not a stuck one.
    let working = picker.busy.clone().or_else(|| if matches!(kind, PickerKind::Models) { crate::models::working(app) } else { None });
    let status = match working { Some(w) => format!("{} {w}", theme::spinner(app.tick)), None => picker.status.clone() };
    if !status.is_empty() {
        let w = (status.width() as u16).min(right.saturating_sub(at + 8));
        put(buf, right.saturating_sub(w + 6), r.y + 1, w, &status, c.muted);
    }
    put(buf, right.saturating_sub(3), r.y + 1, 3, "esc", c.muted);

    // The query: at the top of the menus (as the New Harness chooser has its own); at the bottom
    // of the launcher's lists, fzf's way, its keys and its count over it (below).
    let launcher = crate::modal::is_launcher(kind);
    let qy = if launcher { r.bottom().saturating_sub(2) } else { r.y + 3 };
    put(buf, x, qy, 2, "›", c.accent);
    let hint = if launcher { format!("Search {}", title(app, kind, picker).to_lowercase()) } else { picker.placeholder.clone() };
    let shown = if picker.query.is_empty() { (hint.as_str(), c.muted) } else { (picker.query.as_str(), c.base) };
    let qw = put(buf, x + 2, qy, inner_w.saturating_sub(2), shown.0, shown.1);
    picker.prompt_at.set((qy, x + 2));
    let before: String = picker.query.chars().take(picker.qcursor).collect();
    let cursor = Position::new((x + 2 + before.width() as u16).min(right), qy);
    // (On the tab row the keys are not the query's: no text cursor.)
    let cursor = Some(cursor).filter(|_| !picker.on_tabs);

    if launcher {
        // After the query: the tabs it switches between, the one you are in marked — lit while the
        // tab row has the keys (↓ past the list's last row).
        let here = crate::picker::scope_of(&picker.query);
        let mut sx = x + 2 + qw + 3;
        for (ch, name) in crate::modal::LAUNCHER_TABS {
            let text = ch.map(|ch| format!("{ch} {name}")).unwrap_or_else(|| name.to_string());
            // (The one you are in in brackets — seen in any theme, colour or none.)
            let text = if here == *ch { format!("[{text}]") } else { text };
            if sx + text.width() as u16 > right { break }
            let style = match (here == *ch, picker.on_tabs) { (true, true) => c.selected.add_modifier(Modifier::BOLD), (true, false) => c.base.add_modifier(Modifier::BOLD | Modifier::UNDERLINED), _ => c.muted };
            sx += put(buf, sx, qy, right.saturating_sub(sx), &text, style) + 3;
        }
        // Over it: how many rows match of how many (and how many marked), a rule after.
        let count = format!("{}/{} ({})", picker.visible.len(), picker.rows.len(), picker.marked.len());
        let cw = put(buf, x, qy - 1, inner_w, &count, c.muted);
        for cx in x + cw + 1..right { put(buf, cx, qy - 1, 1, "─", c.muted.remove_modifier(Modifier::BOLD)); }
        // Over that: this list's keys, `key what` · `key what`, the keys bold (the tab row's own,
        // while it has the keys).
        let mut kx = x;
        let tab_keys = [("← →", "switch"), ("↑", "list"), ("type", "to search")];
        for (i, (k, what)) in if picker.on_tabs { &tab_keys[..] } else { &picker.hints[..] }.iter().enumerate() {
            if i > 0 { kx += put(buf, kx, qy - 2, right.saturating_sub(kx), " · ", c.muted); }
            kx += put(buf, kx, qy - 2, right.saturating_sub(kx), k, c.base.add_modifier(Modifier::BOLD));
            kx += put(buf, kx, qy - 2, right.saturating_sub(kx), &format!(" {what}"), c.muted);
            if kx >= right { break }
        }
    }

    // The list, and beside it the preview when there is room for both.
    // (Without a keys row, the list and the preview reach down to the panel's last rows; the
    // launcher's reach down to its keys.)
    let (top, bottom) = if launcher { (r.y + 3, r.bottom().saturating_sub(5)) } else { (r.y + 5, r.bottom().saturating_sub(if keyed(kind) { 3 } else { 1 })) };
    let rows = bottom.saturating_sub(top) as usize;
    // (Commands need no preview: the list takes the width, a row's hint beside its name. A list
    // that is the whole answer — output, messages, keys — has none either.)
    // (Keybinds are keys, not a look: no preview; the list takes the width, a key beside each.)
    let settings = matches!(kind, PickerKind::Theme);
    // (A palette is a list only.)
    let side = inner_w >= 64 && kind.size() == PanelSize::Large && (settings || (picker.preview && !matches!(kind, PickerKind::Commands | PickerKind::Theme)));
    // (A list's preview gets at least half: a harness's screen, a machine's, a model's facts —
    // the list room for a row's name and what it says, a harness's doing.)
    let list_w = if !side { inner_w } else if settings { (inner_w * 2 / 5).clamp(28, 40) } else { (inner_w / 2).clamp(30, 56) };
    list_from(buf, picker, Rect::new(x, top, list_w, rows as u16), &c, !side, launcher);
    picker.preview_area.set(None);
    picker.bar.set(None);
    let mut shown = None;
    if side {
        let px = x + list_w + 3;
        // (The settings' preview is the page's picture, from the query line down; a list's is
        // beside its rows, under the query and the scopes, which keep the whole width.)
        let from = if settings { r.y + 3 } else { top };
        let pr = Rect::new(px, from, right.saturating_sub(px), bottom.saturating_sub(from));
        if settings {
            let look = Look::of(app).with(picker.theme_in.as_ref().and(picker.current_id()).as_deref());
            preview(buf, pr, &look, &c);
        } else {
            // A thin rule between the list and its preview, in the panel's muted colour.
            for y in pr.y..pr.bottom() { put(buf, px - 2, y, 1, "│", c.muted.remove_modifier(Modifier::BOLD)); }
            picker.preview_area.set(Some((pr, 'r')));
            shown = Some(pr);
        }
    }

    // The footer: what was just said, else — in the menus (Commands, Appearance) — their keys. The
    // other lists say nothing there: their room is the list's and the preview's.
    // (The launcher's: in place of its keys, for the moment it is said.)
    let fy = r.bottom().saturating_sub(if launcher { 4 } else if keyed(kind) { 2 } else { 1 });
    let flash = picker.flash.as_ref().filter(|(_, at)| at.elapsed().as_secs() < 3).map(|(t, _)| t.clone());
    let keys = match kind {
        PickerKind::Commands if in_tmux(picker) => Some("↑↓ move   enter run   type to search   esc back"),
        PickerKind::Commands => Some("↑↓ move   enter run   type to search   esc close"),
        PickerKind::Theme if picker.theme_in.is_some() => Some("↑↓ move   enter apply   ← back   esc back"),
        PickerKind::Theme if picker.from_commands => Some("↑↓ move   → open   type to search   esc back"),
        PickerKind::Theme => Some("↑↓ move   → open   type to search   esc close"),
        // ── keys ──
        PickerKind::Keybinds if picker.from_commands => Some("↑↓ move   enter change   type to search   esc back"),
        PickerKind::Keybinds => Some("↑↓ move   enter change   type to search   esc close"),
        _ => None,
    };
    match (flash, keys) {
        (Some(text), _) => { put(buf, x, fy, inner_w, &" ".repeat(inner_w as usize), c.base); put(buf, x, fy, inner_w, &text, c.accent); }
        (None, Some(keys)) => { put(buf, x, fy, inner_w, keys, c.muted); }
        (None, None) => {}
    }
    (cursor, shown)
}

/// The menus, whose footer says their keys (the other lists give that row to their rows).
fn keyed(kind: &PickerKind) -> bool { matches!(kind, PickerKind::Theme | PickerKind::Commands | PickerKind::Keybinds) }

/// The panel's title: the list's own name (the launcher's for its lists, else what opened it).
fn title(app: &App, kind: &PickerKind, picker: &Picker) -> String {
    match kind {
        PickerKind::Theme => "Appearance".into(),
        PickerKind::Commands => "Commands".into(),
        PickerKind::Keybinds => "Keybinds".into(),
        PickerKind::Devices(view) => view.title().into(),
        k if crate::modal::is_launcher(k) => capital(&crate::modal::launcher_title(app, k).0),
        _ => capital(&picker.heading.clone().unwrap_or_else(|| picker.title.clone())),
    }
}

fn capital(t: &str) -> String { let mut c = t.chars(); c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default() }

pub fn section_title(section: &str) -> &'static str {
    match section {
        "status" => "Pane titles", "focus" => "Focus",
        "theme" => "Theme",
        // ── status bar ──
        "bar" => "Status bar", "boxes" => "Borders",
        // (The command list's tmux commands.)
        "tmux" => "tmux commands",
        _ => "",
    }
}

/// The rows, top-down, the cursor's row marked as the New Harness chooser marks its own.
pub fn list(buf: &mut Buffer, picker: &mut Picker, r: Rect, c: &Chrome, details: bool) { list_from(buf, picker, r, c, details, false) }

/// [list], [bottom_up]: the first row at the bottom, by the query under it, the rest going up
/// (fzf's way, for the launcher's lists) — a group's heading over its rows still.
pub fn list_from(buf: &mut Buffer, picker: &mut Picker, r: Rect, c: &Chrome, details: bool, bottom_up: bool) {
    picker.list_area.set(r);
    let mut row_at = Vec::new();
    let n = r.height as usize;
    if n == 0 { picker.row_at = row_at; return }
    if picker.visible.is_empty() {
        // (A list says what its emptiness means — "no harnesses yet" — where it can.)
        let empty = if picker.empty.is_empty() || !picker.query.is_empty() { "Nothing matches".to_string() } else { picker.empty.clone() };
        put(buf, r.x + 2, if bottom_up { r.bottom() - 1 } else { r.y }, r.width.saturating_sub(2), &empty, c.muted);
        picker.row_at = row_at;
        return;
    }
    // The lines as drawn: each row, and a titled heading (a blank line before it) wherever the
    // group changes — as opencode's palette groups its commands. The scroll counts lines.
    let mut lines: Vec<Option<usize>> = Vec::new();
    let mut titles: Vec<(usize, String)> = Vec::new();
    let mut last: Option<&str> = None;
    // (While typing, the best matches come first, untitled — as opencode's search reads.)
    // (A launcher's scope character alone — `:` — is no search yet: its list keeps its headings.)
    let grouped = picker.query.is_empty() || (picker.prefixed && crate::picker::scope_of(&picker.query).is_some() && picker.query.trim().chars().count() == 1);
    if !bottom_up {
        for vi in 0..picker.visible.len() {
            let group = picker.rows[picker.visible[vi].0].group.as_deref().filter(|_| grouped);
            if group.is_some() && group != last {
                if !lines.is_empty() { lines.push(None) }
                titles.push((lines.len(), group.unwrap_or_default().to_string()));
                lines.push(None);
            }
            last = group;
            lines.push(Some(vi));
        }
    } else {
        // Bottom up: a group's rows, then its heading (drawn over them), then a blank.
        let mut pending: Option<String> = None;
        for vi in 0..picker.visible.len() {
            let group = picker.rows[picker.visible[vi].0].group.as_deref().filter(|_| grouped);
            if group != last {
                if let Some(title) = pending.take() { titles.push((lines.len(), title)); lines.push(None); lines.push(None) }
                pending = group.map(str::to_string);
            }
            last = group;
            lines.push(Some(vi));
        }
        if let Some(title) = pending { titles.push((lines.len(), title)); lines.push(None) }
    }
    let at_line = lines.iter().position(|l| *l == Some(picker.cursor)).unwrap_or(0);
    // (The cursor's heading comes into view with it.)
    let top = if !bottom_up && at_line >= 1 && titles.iter().any(|(i, _)| *i + 1 == at_line) { at_line - 1 } else { at_line };
    // (Scrolled by the wheel: the list stays where it was put, the cursor wherever it is.)
    if !picker.free_scroll {
        if top < picker.scroll { picker.scroll = top }
        if at_line >= picker.scroll + n { picker.scroll = at_line + 1 - n }
    }
    picker.scroll = picker.scroll.min(lines.len().saturating_sub(n));
    for (slot, line) in lines.iter().enumerate().skip(picker.scroll).take(n).map(|(i, l)| (i - picker.scroll, (i, *l))) {
        let y = if bottom_up { r.bottom() - 1 - slot as u16 } else { r.y + slot as u16 };
        let (li, Some(vi)) = line else {
            if let Some((_, title)) = titles.iter().find(|(i, _)| *i == line.0) { put(buf, r.x + 2, y, r.width.saturating_sub(2), title, c.muted.add_modifier(Modifier::BOLD)); }
            continue;
        };
        let _ = li;
        let row = &picker.rows[picker.visible[vi].0];
        let here = vi == picker.cursor;
        let style = if here { c.selected } else { c.base };
        if here { for x in r.x..r.right() { if let Some(cell) = buf.cell_mut((x, y)) { cell.set_style(style); } } }
        put(buf, r.x, y, 1, if here { "›" } else { " " }, if here { c.selected } else { c.accent });
        // Marked with Tab (several at once): a dot beside the pointer.
        if picker.marked.contains(&row.id) { put(buf, r.x + 1, y, 1, "•", if here { c.selected } else { c.accent }); }
        let mut at = r.x + 2;
        for span in &row.lead {
            let s = if here { style.patch(Style::default().fg(span.style.fg.unwrap_or(Color::Reset))) } else { c.base.patch(span.style) };
            at += put(buf, at, y, r.right().saturating_sub(at), &span.content, s);
        }
        // The right column as the row has it for this width (its short form in a narrow list:
        // a harness's age, not its project and machine), and never more than a third of the
        // row — so it can not run off the panel or over the name.
        let right_text = row.right_at(r.width as usize);
        let right_w = (right_text.width() as u16).min(r.width / 3);
        // (The last column is the scroll mark's, with a blank before it.)
        let end = r.right().saturating_sub(if right_w > 0 { right_w + 3 } else { 2 });
        // The hint after the name, in a column of its own, where there is room for both.
        let hint: String = if details { row.detail.iter().map(|s| s.content.as_ref()).collect() } else { String::new() };
        let hx = at + 28;
        let with_hint = !hint.is_empty() && hx + 8 < end;
        at += put(buf, at, y, if with_hint { 26 } else { end.saturating_sub(at) }, &row.label, style);
        let quiet = if here { style.remove_modifier(Modifier::BOLD) } else { c.muted };
        if with_hint { put(buf, hx.max(at + 2), y, end - hx.max(at + 2), &hint, quiet); }
        else if !details && at + 10 < end {
            // Beside a preview, what the row says (what a harness is doing, what it did) follows
            // its name, where it fits.
            let said: String = row.detail.iter().map(|s| s.content.as_ref()).collect();
            if !said.is_empty() { put(buf, at, y, end - at, &format!(" · {said}"), quiet); }
        }
        if right_w > 0 { put(buf, r.right().saturating_sub(right_w + 2), y, right_w, right_text, if here { style } else { c.muted }); }
        row_at.push((y, vi));
    }
    // (No scrollbar: the list follows the cursor, the wheel scrolls it.)
    picker.row_at = row_at;
}

// ── the preview: a small hn with the whole look applied ─────────────────────────────

/// Every setting the panel covers, as the preview draws it.
#[derive(Clone, Debug)]
pub struct Look {
    pub status: String,
    pub indicators: String,
    pub lines: String,
    pub surface: bool,
    pub split: String,
    pub layout: String,
    pub theme: Option<&'static TerminalTheme>,
    // ── status bar ──
    /// Where the status bar is (bottom, top, left, right), and box panes.
    pub bar: String,
    pub boxes: bool,
    /// The panes you are not in, a little quieter (`@hn-dim`).
    pub dim: bool,
}

impl Look {
    /// The look as the options hold it now.
    pub fn of(app: &App) -> Look {
        let o = &app.options;
        let get = |k: &str, d: &str| o.get(k, "", None).unwrap_or_else(|| d.to_string());
        let theme = o.get("@hn-theme", "", None).and_then(|n| TERMINAL_THEMES.iter().find(|t| t.name == n));
        Look {
            status: get("pane-border-status", "top"),
            indicators: get("pane-border-indicators", "colour"),
            lines: get("pane-border-lines", "single"),
            surface: o.focus_style() == "surface",
            split: o.look_orientation().to_string(),
            layout: get("@hn-layout-preset", "auto"),
            theme,
            // ── status bar ──
            bar: match o.status_bar() { "bottom" if app.status_top => "top".into(), b => b.into() },
            boxes: o.border_style() == "box",
            dim: o.dim_others(),
        }
    }

    /// The look with the row under the cursor (`knob:value`) in effect — what choosing it would do.
    pub fn with(mut self, row: Option<&str>) -> Look {
        let Some((knob, value)) = row.and_then(|r| r.split_once(':')) else { return self };
        match knob {
            "border_status" => self.status = value.into(),
            "border_indicators" => self.indicators = value.into(),
            "border_lines" => self.lines = value.into(),
            "focus" => self.surface = value == "surface",
            "layout_orientation" => self.split = value.into(),
            "layout_preset" => self.layout = value.into(),
            "theme" => self.theme = TERMINAL_THEMES.iter().find(|t| t.name == value),
            // ── status bar ──
            "status_bar" => self.bar = value.into(),
            "border_style" => self.boxes = value == "box",
            "dim" => self.dim = value == "on",
            _ => {}
        }
        self
    }
}

fn rgb(c: [u8; 3]) -> Color { theme::depth_fit(Color::Rgb(c[0], c[1], c[2])) }

/// hn's own accent on the terminal's own colours (no theme's): its teal, for light or dark.
fn native_accent() -> Color {
    let light = crate::term_out::native_terminal_colours().and_then(|(bg, _)| crate::tmuxconf::colour(&bg)).is_some_and(|c| matches!(c, Color::Rgb(r, g, b) if 299 * r as u32 + 587 * g as u32 + 114 * b as u32 > 128_000));
    if light { Color::Rgb(0, 100, 120) } else { Color::Rgb(95, 215, 230) }
}

/// The panes a layout makes of [r], the first the active one: tmux's presets with three panes,
/// `auto` two split the way the split direction says (left|right when it is free to choose here).
pub fn tiles(r: Rect, layout: &str, split: &str) -> Vec<Rect> {
    let cols = |r: Rect, n: u16| -> Vec<Rect> {
        let w = r.width.saturating_sub(n - 1) / n;
        (0..n).map(|i| { let x = r.x + i * (w + 1); Rect::new(x, r.y, if i + 1 == n { r.right().saturating_sub(x) } else { w }, r.height) }).collect()
    };
    let rows = |r: Rect, n: u16| -> Vec<Rect> {
        let h = r.height.saturating_sub(n - 1) / n;
        (0..n).map(|i| { let y = r.y + i * (h + 1); Rect::new(r.x, y, r.width, if i + 1 == n { r.bottom().saturating_sub(y) } else { h }) }).collect()
    };
    match layout {
        "even-horizontal" => cols(r, 3),
        "even-vertical" => rows(r, 3),
        "main-horizontal" => {
            let h = (r.height * 3 / 5).max(1);
            let mut v = vec![Rect::new(r.x, r.y, r.width, h)];
            v.extend(cols(Rect::new(r.x, r.y + h + 1, r.width, r.height.saturating_sub(h + 1)), 2));
            v
        }
        "main-vertical" => {
            let w = (r.width * 3 / 5).max(1);
            let mut v = vec![Rect::new(r.x, r.y, w, r.height)];
            v.extend(rows(Rect::new(r.x + w + 1, r.y, r.width.saturating_sub(w + 1), r.height), 2));
            v
        }
        "tiled" => {
            let halves = rows(r, 2);
            let mut v = cols(halves[0], 2);
            v.push(halves[1]);
            v
        }
        // (Horizontal is a left|right split, as `smart_dir` splits a wide pane.)
        _ => if split == "vertical" { rows(r, 2) } else { cols(r, 2) },
    }
}

/// A border cell's glyph from the border cells around it — the lines join as tmux's do.
pub(crate) fn joint(lines: &str, up: bool, down: bool, left: bool, right: bool) -> &'static str {
    let set: [&str; 11] = match lines {
        "double" => ["═", "║", "╔", "╗", "╚", "╝", "╠", "╣", "╦", "╩", "╬"],
        "heavy" => ["━", "┃", "┏", "┓", "┗", "┛", "┣", "┫", "┳", "┻", "╋"],
        "simple" => ["-", "|", "+", "+", "+", "+", "+", "+", "+", "+", "+"],
        _ => ["─", "│", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼"],
    };
    match (up, down, left, right) {
        (true, true, true, true) => set[10],
        (true, true, false, true) => set[6],
        (true, true, true, false) => set[7],
        (false, true, true, true) => set[8],
        (true, false, true, true) => set[9],
        (false, true, false, true) => set[2],
        (false, true, true, false) => set[3],
        (true, false, false, true) => set[4],
        (true, false, true, false) => set[5],
        (true, _, false, false) | (_, true, false, false) => set[1],
        _ => set[0],
    }
}

/// The preview: a label, then a small hn — its panes in the layout, their borders, title rows and
/// focus, drawn in the theme's colours, with the status line under them.
pub fn preview(buf: &mut Buffer, r: Rect, look: &Look, c: &Chrome) {
    if r.width < 16 || r.height < 6 { return }
    // Everything in it — the status bar and borders too — from the theme it shows.
    let (pal, accent) = match look.theme {
        Some(t) => (theme::pane_palette_of(t.background, t.foreground), rgb(theme::theme_accent_rgb(t))),
        None => (theme::native_pane_palette(), native_accent()),
    };
    let (bg, fg) = (pal.background, pal.foreground);
    let name = look.theme.map(|t| t.name).unwrap_or("your terminal's colours");
    let at = r.x + put(buf, r.x, r.y, r.width, "Preview · ", c.muted);
    put(buf, at, r.y, r.right().saturating_sub(at), name, c.base);

    let screen = Rect::new(r.x, r.y + 2, r.width, r.height.saturating_sub(2).min(18));
    // ── status bar ──
    // The status line at the bottom or the top, or the bar down a side.
    let (body, status_row, side) = match look.bar.as_str() {
        "top" => (Rect::new(screen.x, screen.y + 1, screen.width, screen.height - 1), Some(screen.y), None),
        "left" | "right" => {
            let w = (screen.width / 4).clamp(10, 16);
            let bar = Rect::new(if look.bar == "left" { screen.x } else { screen.right() - w }, screen.y, w, screen.height);
            (Rect::new(if look.bar == "left" { screen.x + w } else { screen.x }, screen.y, screen.width - w, screen.height), None, Some(bar))
        }
        _ => (Rect::new(screen.x, screen.y, screen.width, screen.height - 1), Some(screen.bottom() - 1), None),
    };
    let boxed = look.boxes && !look.surface;
    // Blurred surfaces too sit on the terminal's own background.
    for y in body.y..body.bottom() { for x in body.x..body.right() { if let Some(cell) = buf.cell_mut((x, y)) { cell.reset(); cell.set_style(Style::default().bg(bg)); } } }

    let panes = tiles(body, &look.layout, &look.split);
    let names = ["claude", "codex", "shell"];
    let inside = |x: u16, y: u16| panes.iter().any(|p| x >= p.x && x < p.right() && y >= p.y && y < p.bottom());
    let border = |x: u16, y: u16| x >= body.x && x < body.right() && y >= body.y && y < body.bottom() && !inside(x, y);
    let active = panes[0];
    // Next to the active pane: its borders take the indicator (a colour, arrows, or both).
    let touches = |x: u16, y: u16| x + 1 >= active.x && x <= active.right() && y + 1 >= active.y && y <= active.bottom();
    let colour = matches!(look.indicators.as_str(), "colour" | "both");
    let arrows = matches!(look.indicators.as_str(), "arrows" | "both");
    if !look.surface && !boxed {
        for y in body.y..body.bottom() {
            for x in body.x..body.right() {
                if !border(x, y) { continue }
                let g = joint(&look.lines, y > body.y && border(x, y - 1), border(x, y + 1), x > body.x && border(x - 1, y), border(x + 1, y));
                let style = if colour && touches(x, y) { Style::default().fg(accent).bg(bg) } else { Style::default().fg(pal.border).bg(bg) };
                buf.set_string(x, y, g, style);
            }
        }
        if arrows {
            // One arrow on each border beside the active pane, pointing into it.
            let style = Style::default().fg(accent).bg(bg).add_modifier(Modifier::BOLD);
            let mid_y = active.y + active.height / 2;
            let mid_x = active.x + active.width / 2;
            if border(active.right(), mid_y) { buf.set_string(active.right(), mid_y, "◀", style) }
            if active.x > body.x && border(active.x - 1, mid_y) { buf.set_string(active.x - 1, mid_y, "▶", style) }
            if border(mid_x, active.bottom()) { buf.set_string(mid_x, active.bottom(), "▲", style) }
        }
    }

    let lines: [&[(&str, bool)]; 3] = [
        &[("❯ ", true), ("fix the login bug", false)],
        &[("⠹ ", true), ("Reading src/auth.rs", false)],
        &[("$ ", true), ("cargo test", false)],
    ];
    for (i, p) in panes.iter().enumerate() {
        let here = i == 0;
        let (pbg, pfg) = if look.surface && !here { (pal.inactive_surface, pal.inactive_foreground) } else { (bg, fg) };
        for y in p.y..p.bottom() { for x in p.x..p.right() { if let Some(cell) = buf.cell_mut((x, y)) { cell.reset(); cell.set_style(Style::default().bg(pbg)); } } }
        let mut content = *p;
        // ── status bar ──
        // A box: the focused pane's frame in the accent, the next one's as a harness waiting on
        // you draws it, the rest quiet; the title in the frame's top or bottom line.
        if boxed && p.width >= 3 && p.height >= 3 {
            let frame = Style::default().fg(if here { accent } else if i == 1 { theme::paint(theme::ATTENTION) } else { pal.border }).bg(pbg);
            let (x1, y1) = (p.right() - 1, p.bottom() - 1);
            for x in p.x + 1..x1 { buf.set_string(x, p.y, joint(&look.lines, false, false, true, true), frame); buf.set_string(x, y1, joint(&look.lines, false, false, true, true), frame) }
            for y in p.y + 1..y1 { buf.set_string(p.x, y, joint(&look.lines, true, true, false, false), frame); buf.set_string(x1, y, joint(&look.lines, true, true, false, false), frame) }
            for (x, y, g) in [(p.x, p.y, joint(&look.lines, false, true, false, true)), (x1, p.y, joint(&look.lines, false, true, true, false)), (p.x, y1, joint(&look.lines, true, false, false, true)), (x1, y1, joint(&look.lines, true, false, true, false))] { buf.set_string(x, y, g, frame) }
            if look.status != "off" {
                let ty = if look.status == "bottom" { y1 } else { p.y };
                let ls = if here { frame.add_modifier(Modifier::BOLD) } else if i == 1 { frame } else { Style::default().fg(pfg).bg(pbg) };
                put(buf, p.x + 1, ty, p.width.saturating_sub(2), &format!(" {} {} ", i + 1, names[i]), ls);
            }
            content = Rect::new(p.x, p.y + 1, p.width, p.height - 2);
        } else if look.status != "off" && p.height >= 3 {
            // The title row, above or below the pane, as pane-border-status puts it.
            let ty = if look.status == "bottom" { p.bottom() - 1 } else { p.y };
            let rule = if look.surface { " " } else { joint(&look.lines, false, false, true, true) };
            let tstyle = if colour && here { Style::default().fg(accent).bg(pbg) } else { Style::default().fg(pal.border).bg(pbg) };
            for x in p.x..p.right() { buf.set_string(x, ty, rule, tstyle) }
            let label = format!(" {} {} ", i + 1, names[i]);
            let ls = if here { Style::default().fg(accent).bg(pbg).add_modifier(Modifier::BOLD) } else { Style::default().fg(pfg).bg(pbg) };
            put(buf, p.x + 1, ty, p.width.saturating_sub(2), &label, ls);
            content = if look.status == "bottom" { Rect::new(p.x, p.y, p.width, p.height - 1) } else { Rect::new(p.x, p.y + 1, p.width, p.height - 1) };
        }
        let inner = Rect::new(content.x + 1, content.y, content.width.saturating_sub(2), content.height);
        for (row, segs) in lines.iter().enumerate() {
            let y = inner.y + row as u16;
            if y >= inner.bottom() { break }
            let mut x = inner.x;
            for (text, lead) in segs.iter() {
                let s = Style::default().fg(if *lead { accent } else { pfg }).bg(pbg);
                x += put(buf, x, y, inner.right().saturating_sub(x), text, s);
            }
        }
        if look.dim && !here { dim(buf, inner, pbg, pfg) }
        // The theme's sixteen colours, in the first pane where it has room.
        if let (Some(t), true) = (look.theme, here) {
            let y = inner.y + lines.len() as u16 + 1;
            if y < inner.bottom() && inner.width >= 8 {
                for (k, col) in t.palette.iter().take((inner.width as usize / 2).min(16)).enumerate() {
                    buf.set_string(inner.x + k as u16 * 2, y, "██", Style::default().fg(rgb(*col)).bg(pbg));
                }
            }
        }
    }

    // The status line, as hn's own sits under the panes (or over them).
    if let Some(status_row) = status_row {
        let sstyle = Style::default().fg(pal.status_foreground).bg(pal.status);
        for x in screen.x..screen.right() { buf.set_string(x, status_row, " ", sstyle) }
        let mut x = screen.x + 1;
        for (i, n) in names.iter().take(panes.len()).enumerate() {
            let s = if i == 0 { sstyle.fg(accent).add_modifier(Modifier::BOLD) } else { sstyle };
            x += put(buf, x, status_row, screen.right().saturating_sub(x), &format!("{}:{}{} ", i, n, if i == 0 { "*" } else { "" }), s);
        }
        put(buf, screen.right().saturating_sub(7), status_row, 6, "studio", sstyle);
    }
    // ── status bar ──
    if let Some(bar) = side { preview_bar(buf, bar, look.bar == "left", &pal, accent, &names[..panes.len().min(2)]) }
}

/// The status bar down a side, small: the windows, the current one with its panes under it (the
/// first focused, each with its repo), a rule, the machine with its window, and the separator
/// facing the panes.
fn preview_bar(buf: &mut Buffer, bar: Rect, left: bool, pal: &theme::PanePalette, accent: Color, names: &[&str]) {
    let (bg, fg) = (pal.background, pal.foreground);
    for y in bar.y..bar.bottom() { for x in bar.x..bar.right() { if let Some(cell) = buf.cell_mut((x, y)) { cell.reset(); cell.set_style(Style::default().bg(bg)); } } }
    let sx = if left { bar.right() - 1 } else { bar.x };
    for y in bar.y..bar.bottom() { buf.set_string(sx, y, "│", Style::default().fg(pal.border).bg(bg)) }
    let x = if left { bar.x } else { bar.x + 1 };
    let w = bar.width - 1;
    let row = theme::depth_fit(mix(bg, fg, 12));
    let header = Style::default().fg(pal.muted).bg(bg).add_modifier(Modifier::BOLD);
    let mut y = bar.y;
    let line = |buf: &mut Buffer, y: &mut u16, spans: &[(&str, Style)], fill: Option<Color>| {
        if *y >= bar.bottom() { return }
        if let Some(f) = fill { for cx in x..x + w { buf.set_string(cx, *y, " ", Style::default().bg(f)) } }
        let mut at = x;
        for (t, s) in spans { let s = match fill { Some(f) => s.bg(f), None => *s }; at += put(buf, at, *y, (x + w).saturating_sub(at), t, s) }
        *y += 1;
    };
    let dim = Style::default().fg(pal.muted);
    // (The marks the bar gives: the harnesses' own — a spinner working, `?` waiting, `·` idle — and
    // `✓` for a connected machine; no round ones.)
    line(buf, &mut y, &[(" ", header), ("✓", Style::default().fg(theme::paint(theme::ONLINE))), (" studio", header)], None);
    y += 1;
    let count = format!(" {}", names.len());
    line(buf, &mut y, &[(" ", header), ("?", Style::default().fg(theme::paint(theme::ATTENTION))), (" 0:claude", Style::default().fg(fg).add_modifier(Modifier::BOLD)), (&count, dim)], Some(row));
    for (i, n) in names.iter().enumerate() {
        let (here, last) = (i == 0, i + 1 == names.len());
        let fill = here.then_some(row);
        let (glyph, gc) = if here { (theme::spinner(0), theme::paint(theme::ACCENT_SOFT)) } else { ("?", theme::paint(theme::ATTENTION)) };
        let name = if here { Style::default().fg(fg).add_modifier(Modifier::BOLD) } else { Style::default().fg(pal.inactive_foreground) };
        line(buf, &mut y, &[(if last { " └─ " } else { " ├─ " }, dim), (glyph, Style::default().fg(gc)), (" ", name), (n, name)], fill);
        line(buf, &mut y, &[(if last { "      " } else { " │    " }, dim), ("autonomous-harness · main", Style::default().fg(if here { accent } else { pal.muted }))], fill);
    }
    line(buf, &mut y, &[(" ", header), ("·", Style::default().fg(pal.muted)), (" 1:ops", Style::default().fg(pal.inactive_foreground))], None);
    let rule = "─".repeat(w as usize);
    line(buf, &mut y, &[(&rule, Style::default().fg(pal.border))], None);
    line(buf, &mut y, &[(" machines", header)], None);
    y += 1;
    line(buf, &mut y, &[(" ", header), ("✓", Style::default().fg(theme::paint(theme::ONLINE))), (" studio", Style::default().fg(fg).add_modifier(Modifier::BOLD))], None);
    line(buf, &mut y, &[(" └─ ", Style::default().fg(pal.muted)), ("?", Style::default().fg(theme::paint(theme::ATTENTION))), (" 0:claude", Style::default().fg(fg).add_modifier(Modifier::BOLD))], Some(row));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modal;

    fn app(size: (u16, u16)) -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, size);
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(crate::fleet::Machine { id: "local".into(), name: "studio".into(), local: true, status: "online".into(), reach: crate::fleet::Reach::Ready });
        app
    }

    fn text(buf: &Buffer) -> String {
        let a = buf.area;
        (a.y..a.bottom()).map(|y| (a.x..a.right()).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    fn open(app: &App, section: Option<&str>) -> Picker {
        let mut p = Picker::new("t", "Search settings");
        p.keep_order = true;
        match section {
            Some(s) => { p.theme_in = Some(s.into()); p.set_rows(modal::theme_options(app, s)) }
            None => p.set_rows(modal::theme_sections(app)),
        }
        p
    }

    /// The panel stays where it is, the same size, whether it shows the sections or one section's
    /// options — and draws at every size without a panic.
    #[test]
    fn the_panel_does_not_move_when_a_section_opens() {
        let app = app((150, 42));
        let body = Rect::new(0, 0, 150, 41);
        let mut a = open(&app, None);
        let mut b = open(&app, Some("status"));
        let mut buf = Buffer::empty(body);
        draw(&mut buf, &app, body, &PickerKind::Theme, &mut a);
        let mut buf2 = Buffer::empty(body);
        draw(&mut buf2, &app, body, &PickerKind::Theme, &mut b);
        assert_eq!(a.screen_area.get(), b.screen_area.get());
        assert_eq!(a.list_area.get(), b.list_area.get());
        for w in [10, 24, 40, 80, 150] { for h in [3, 8, 12, 24, 42] {
            let r = Rect::new(0, 0, w, h);
            for section in [None, Some("theme"), Some("layout")] {
                let mut p = open(&app, section);
                draw(&mut Buffer::empty(r), &app, r, &PickerKind::Theme, &mut p);
            }
        }}
    }

    /// Inside a section its options are listed, and the panel has no border line around it.
    #[test]
    fn a_section_lists_its_options_without_a_border() {
        let app = app((150, 42));
        let body = Rect::new(0, 0, 150, 41);
        let mut p = open(&app, Some("status"));
        let mut buf = Buffer::empty(body);
        draw(&mut buf, &app, body, &PickerKind::Theme, &mut p);
        let s = text(&buf);
        for v in ["off", "top", "bottom"] { assert!(s.contains(v), "{v} missing:\n{s}") }
        assert!(s.contains("Appearance") && s.contains("Pane titles"));
        let r = p.screen_area.get();
        for x in r.x..r.right() { assert!(!["─", "╭", "╮", "┌"].contains(&buf[(x, r.y)].symbol()), "a border on the panel's top row") }
    }

    /// The preview shows every section at once, and a hovered option changes only its own part.
    #[test]
    fn the_preview_is_the_whole_look_and_follows_the_cursor() {
        let app = app((150, 42));
        let look = Look::of(&app);
        assert_eq!(look.clone().with(Some("border_lines:double")).lines, "double");
        assert_eq!(look.clone().with(Some("border_lines:double")).status, look.status);
        assert_eq!(look.clone().with(Some("layout_preset:tiled")).layout, "tiled");
        assert!(look.clone().with(Some("theme:Adwaita")).theme.is_some());
        let r = Rect::new(0, 0, 60, 24);
        let mut buf = Buffer::empty(r);
        preview(&mut buf, r, &look.clone().with(Some("border_lines:double")), &chrome());
        let s = text(&buf);
        assert!(s.contains('║') || s.contains('═'), "double lines drawn:\n{s}");
        assert!(s.contains("claude") && s.contains("codex"), "the status line names the windows:\n{s}");
        let mut buf = Buffer::empty(r);
        preview(&mut buf, r, &look.clone().with(Some("border_status:top")), &chrome());
        assert!(text(&buf).contains("1 claude"), "title rows drawn");
    }

    /// The panel takes the theme's colours: two themes, two panels; a light theme a light panel.
    #[test]
    fn the_panel_follows_the_theme() {
        let theme = |n: &str| TERMINAL_THEMES.iter().find(|t| t.name == n).unwrap();
        let (dark, light) = (theme("Atom One Dark"), theme("Adwaita"));
        let a = chrome_for(theme::pane_palette_of(dark.background, dark.foreground));
        let b = chrome_for(theme::pane_palette_of(light.background, light.foreground));
        assert_ne!(a.base.bg, b.base.bg);
        // (In truecolor an RGB; with 256 colours — a CI runner's terminal — an index into xterm's
        // cube or its greys.)
        let rgb = |c: Color| match c {
            Color::Rgb(r, g, b) => (r, g, b),
            Color::Indexed(i) if (16..232).contains(&i) => { let k = i - 16; let v = |n: u8| if n == 0 { 0 } else { 55 + 40 * n }; (v(k / 36), v(k / 6 % 6), v(k % 6)) }
            Color::Indexed(i) if i >= 232 => { let g = 8 + 10 * (i - 232); (g, g, g) }
            _ => (0, 0, 0),
        };
        let lum = |s: Style| { let (r, g, b) = rgb(s.bg.unwrap_or(Color::Reset)); 299 * r as u32 + 587 * g as u32 + 114 * b as u32 };
        assert!(lum(b.base) > lum(a.base), "a light theme gives a light panel");
        assert_ne!(a.base.bg, a.backdrop.bg, "the panel stands out from its backdrop");
        assert_ne!(a.base.bg, a.selected.bg, "the cursor's row stands out");
    }

    // ── sizes ──

    /// Each size's numbers on a small, a medium and a very wide body.
    #[test]
    fn each_size_has_its_numbers_on_small_medium_and_very_wide_bodies() {
        let small = Rect::new(0, 0, 40, 12);
        assert_eq!(area(small, PanelSize::Large, 0), Rect::new(2, 1, 36, 10));
        assert_eq!(area(small, PanelSize::Palette, 5), Rect::new(2, 2, 36, 8));
        assert_eq!(area(small, PanelSize::Form, 20), Rect::new(2, 1, 36, 10));
        let medium = Rect::new(0, 0, 120, 40);
        assert_eq!(area(medium, PanelSize::Large, 0), Rect::new(6, 2, 108, 36));
        // (Rows and chrome; at most seven tenths of the height; in the upper third.)
        assert_eq!(area(medium, PanelSize::Palette, 5), Rect::new(12, 6, 96, 13));
        assert_eq!(area(medium, PanelSize::Palette, 100), Rect::new(12, 6, 96, 28));
        assert_eq!(area(medium, PanelSize::Form, 20), Rect::new(30, 10, 60, 20));
        let wide = Rect::new(0, 0, 400, 60);
        assert_eq!(area(wide, PanelSize::Large, 0), Rect::new(120, 3, 160, 54));
        assert_eq!(area(wide, PanelSize::Palette, 5), Rect::new(152, 10, 96, 13));
        assert_eq!(area(wide, PanelSize::Form, 20), Rect::new(170, 20, 60, 20));
    }

    /// Each list says its size: the launcher's lists, Models, Machines, Store, Appearance and the
    /// devices are large; Commands and Help a palette.
    #[test]
    fn each_kind_has_its_size() {
        let open = PickerKind::Open { filter: modal::Filter::All, machine: None, project: None };
        for k in [open, PickerKind::Models, PickerKind::Machines, PickerKind::Store, PickerKind::Help, PickerKind::Theme, PickerKind::Devices(crate::devices::View::Machines)] { assert_eq!(k.size(), PanelSize::Large, "{k:?}") }
        for k in [PickerKind::Commands, PickerKind::Keybinds] { assert_eq!(k.size(), PanelSize::Palette, "{k:?}") }
    }

    /// Commands is a palette near the top, narrower than the harnesses' panel; its height does not
    /// change as a search narrows it.
    #[test]
    fn commands_is_a_palette_narrower_than_harnesses() {
        let app = app((200, 51));
        let body = Rect::new(0, 0, 200, 50);
        let mut c = Picker::new("Commands", "Type a command");
        c.set_rows(modal::command_rows_for(&app, false, false));
        draw(&mut Buffer::empty(body), &app, body, &PickerKind::Commands, &mut c);
        let mut h = Picker::new("harnesses", "");
        draw(&mut Buffer::empty(body), &app, body, &PickerKind::Open { filter: modal::Filter::All, machine: None, project: None }, &mut h);
        let (cr, hr) = (c.screen_area.get(), h.screen_area.get());
        assert!(cr.width < hr.width, "{cr:?} {hr:?}");
        assert!(cr.y < body.height / 3, "{cr:?}");
        c.set_query("lay");
        draw(&mut Buffer::empty(body), &app, body, &PickerKind::Commands, &mut c);
        assert_eq!(c.screen_area.get(), cr);
        let mut help = Picker::new("help", "");
        help.set_rows(modal::mode_rows(&app));
        draw(&mut Buffer::empty(body), &app, body, &PickerKind::Help, &mut help);
        let before = help.screen_area.get();
        help.set_query("zzz");
        draw(&mut Buffer::empty(body), &app, body, &PickerKind::Help, &mut help);
        assert_eq!(help.screen_area.get(), before, "the palette does not jump as you type");
    }

    #[test]
    fn every_layout_tiles_the_screen_without_overlap() {
        let r = Rect::new(0, 0, 50, 16);
        for layout in ["auto", "even-horizontal", "even-vertical", "main-horizontal", "main-vertical", "tiled"] {
            let t = tiles(r, layout, "auto");
            assert!(t.len() >= 2, "{layout}");
            for (i, a) in t.iter().enumerate() { for b in &t[i + 1..] { assert!(a.intersection(*b).area() == 0, "{layout} overlaps") } }
        }
        assert!(tiles(r, "auto", "vertical")[1].y > 0, "vertical stacks");
        assert!(tiles(r, "auto", "horizontal")[1].x > 0, "horizontal is left|right");
    }

    // ── status bar ──

    /// The preview draws where the status bar goes — the line at the bottom or top, or the bar
    /// down a side: the windows with the current one's panes and their repos, then the machines —
    /// and the panes as boxes: the focused one's frame in the accent, one waiting on you in the
    /// attention colour.
    #[test]
    fn the_preview_draws_the_status_bar_where_it_goes_and_the_boxes_in_their_colours() {
        let app = app((150, 42));
        let look = Look::of(&app);
        assert_eq!((look.bar.as_str(), look.boxes), ("bottom", true));
        let r = Rect::new(0, 0, 64, 20);
        let draw = |look: &Look| { let mut buf = Buffer::empty(r); preview(&mut buf, r, look, &chrome()); buf };
        let row = |buf: &Buffer, y: u16| (0..r.width).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>();
        // (The preview's screen: rows 2 to 19.)
        let bottom = draw(&look);
        assert!(row(&bottom, 19).contains("0:claude*"), "{}", text(&bottom));
        let top = draw(&look.clone().with(Some("status_bar:top")));
        assert!(row(&top, 2).contains("0:claude*") && !row(&top, 19).contains("0:claude*"), "{}", text(&top));
        let left = draw(&look.clone().with(Some("status_bar:left")));
        let s = text(&left);
        assert!(row(&left, 2).starts_with(" ✓ studio") && row(&left, 4).starts_with(" ? 0:claude 2"), "{s}");
        assert!(row(&left, 5).starts_with(" ├─ ") && row(&left, 5).contains(" claude") && row(&left, 6).starts_with(" │    autonom") && row(&left, 7).starts_with(" └─ ? codex"), "{s}");
        assert!(row(&left, 9).starts_with(" · 1:ops") && s.contains(" machines") && s.contains("└─ ? 0:claude"), "{s}");
        assert!(!s.contains('●') && !s.contains('○'), "no round marks:\n{s}");
        assert_eq!(left[(15, 2)].symbol(), "│", "the separator faces the panes:\n{s}");
        // No tabs over the panes: the window starts at the screen's first row, beside the bar.
        assert_eq!(left[(16, 2)].symbol(), "┌", "{s}");
        let right = draw(&look.clone().with(Some("status_bar:right")));
        assert_eq!(right[(64 - 16, 5)].symbol(), "│");
        // Boxes: each pane its own frame; the focused one's in the accent, the next the attention colour.
        // (The accent as this draw had it: the current window's name on the status line.)
        let accent = bottom[(1, 19)].fg;
        let panes = tiles(Rect::new(0, 2, 64, 17), &look.layout, &look.split);
        assert_eq!(bottom[(panes[0].x, panes[0].y)].symbol(), "┌");
        assert_eq!(bottom[(panes[1].x, panes[1].y)].symbol(), "┌");
        assert_eq!(bottom[(panes[0].x, panes[0].y)].fg, accent);
        assert_ne!(accent, bottom[(panes[1].x, panes[1].y)].fg);
        assert_eq!(bottom[(panes[1].x, panes[1].y)].fg, theme::paint(theme::ATTENTION));
        let line = draw(&look.clone().with(Some("border_style:line")));
        assert_ne!(line[(panes[1].x, panes[1].y)].symbol(), "┌", "tmux's shared lines");
    }
}
