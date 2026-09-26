//! Copy mode in the client: a pane into it (cmd-copy-mode.c, window_pane_set_mode) and out
//! (window_pane_reset_mode), a command run for it (window_copy_command), what a command prints
//! shown in view mode (server_client_print), and the mouse's drags.

use super::*;
use crate::app::App;

fn tab_of(app: &App, pane: u64) -> (usize, String) {
    let i = app.tabs.iter().position(|t| t.panes().contains(&pane)).unwrap_or(app.active);
    (i, app.tabs.get(i).map(|t| t.id.clone()).unwrap_or_default())
}

/// The options copy mode reads for [pane]: mode-keys, wrap-search, word-separators.
pub fn ctx(app: &App, pane: u64) -> Ctx {
    let (_, tab) = tab_of(app, pane);
    let get = |n: &str| app.options.get(n, &tab, Some(pane)).unwrap_or_default();
    Ctx { vi: get("mode-keys") == "vi", wrap: get("wrap-search") != "off", ws: app.options.get("word-separators", "", None).unwrap_or_default() }
}

/// The looks copy mode draws [pane] with.
pub fn styles(app: &App, pane: u64) -> Styles {
    let (_, tab) = tab_of(app, pane);
    Styles::of(|n| app.options.get(n, &tab, Some(pane)).unwrap_or_default())
}

/// The mode's screen for [pane]: its tile's cells, or its terminal's when it is not on screen.
pub fn screen_size(app: &App, pane: u64) -> (u32, u32) {
    if let Some((_, r)) = app.rects.iter().find(|(id, _)| *id == pane) {
        let c = app.content_of(app.tab(), *r);
        return (c.width.max(1) as u32, c.height.max(1) as u32);
    }
    app.panes.get(&pane).map(|p| (p.cols as u32, p.rows as u32)).unwrap_or((80, 24))
}

/// A format against [pane] (format_single with it).
fn expand(app: &App, pane: u64, text: &str) -> String {
    let (w, _) = tab_of(app, pane);
    crate::format::expand(app, text, w, Some(pane), true)
}

/// window_pane_set_mode(copy mode): [pane] into copy mode over [source]'s screen and history
/// (itself unless copy-mode -s). True when it was in copy mode already (nothing changes).
pub fn enter(app: &mut App, pane: u64, source: u64, scroll_exit: bool, hide_position: bool) -> bool {
    let Some(p) = app.panes.get_mut(&pane) else { return true };
    if p.modes.last().map(|m| !m.view).unwrap_or(false) { return true }
    // A copy mode under a view mode comes back to the top.
    if let Some(i) = p.modes.iter().position(|m| !m.view) {
        let m = p.modes.remove(i);
        p.modes.push(m);
        p.dirty = true;
        return false;
    }
    let (sx, sy) = screen_size(app, pane);
    let c = ctx(app, pane);
    let Some(src) = app.panes.get(&source) else { return true };
    let grid = from_term(&src.term, &src.times, source != pane);
    let cur = src.term.grid().cursor.point;
    let cursor = (cur.column.0 as u32, cur.line.0.max(0) as u32);
    let ps = app.panes.get(&pane).map(|p| p.search.clone()).unwrap_or_default();
    let copy = Copy::copy(grid, cursor, sx, sy, &ps, !c.vi, scroll_exit, hide_position);
    if let Some(p) = app.panes.get_mut(&pane) { p.modes.push(Box::new(copy)); p.dirty = true }
    false
}

/// window_pane_reset_mode: [pane]'s top mode ends (the one under it, if any, fitted to the pane).
pub fn exit(app: &mut App, pane: u64) {
    let (sx, sy) = screen_size(app, pane);
    let c = ctx(app, pane);
    let Some(p) = app.panes.get_mut(&pane) else { return };
    if p.modes.pop().is_none() { return }
    match p.modes.last_mut() {
        None => p.unseen = false,
        Some(next) => { if (next.sx, next.sy) != (sx, sy) { next.resize(sx, sy, &c) } }
    }
    p.dirty = true;
}

/// window_pane_reset_mode_all.
pub fn exit_all(app: &mut App, pane: u64) {
    while app.panes.get(&pane).map(|p| !p.modes.is_empty()).unwrap_or(false) { exit(app, pane) }
}

/// A pane in a mode at a new size (window_copy_resize).
pub fn fit(app: &mut App, pane: u64, sx: u32, sy: u32) {
    let c = ctx(app, pane);
    if let Some(m) = app.panes.get_mut(&pane).and_then(|p| p.modes.last_mut()) {
        if (m.sx, m.sy) != (sx.max(1), sy.max(1)) { m.resize(sx, sy, &c) }
    }
}

/// vis(3) as utf8_stravisx(VIS_OCTAL|VIS_CSTYLE|VIS_NOSLASH) leaves a printed line: control
/// characters written out (`\r`, `\033`), a tab and a newline kept.
fn vis(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\t' | '\n' => out.push(c),
            '\x07' => out.push_str("\\a"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '\x0b' => out.push_str("\\v"),
            '\0' => out.push_str("\\000"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\{:03o}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// A line of program output as a writing screen shows it (input_parse_screen, then its first
/// row): the escapes read, the look carried on from the line before.
fn parse_line(line: &str, sx: u32, template: &mut Option<alacritty_terminal::term::cell::Cell>) -> Vec<(Cell, Option<String>)> {
    use alacritty_terminal::index::{Column, Line as ALine};
    use alacritty_terminal::term::cell::Flags;
    let rows = (line.chars().count() as u32 / sx.max(1) + 2).min(200) as u16;
    let size = crate::pane::Size(sx.max(1) as u16, rows);
    let config = alacritty_terminal::term::Config { scrolling_history: 0, ..Default::default() };
    let mut term = alacritty_terminal::Term::new(config, &size, crate::pane::Listener::default());
    if let Some(t) = template.clone() { term.grid_mut().cursor.template = t }
    let mut parser: alacritty_terminal::vte::ansi::Processor = alacritty_terminal::vte::ansi::Processor::new();
    parser.advance(&mut term, line.as_bytes());
    *template = Some(term.grid().cursor.template.clone());
    let colors = term.colors();
    let row = &term.grid()[ALine(0)];
    let mut out = Vec::new();
    for x in 0..sx as usize {
        let cell = &row[Column(x)];
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) { continue }
        let (fg, dim) = crate::ui::map_color(cell.fg, colors, true);
        let (bg, _) = crate::ui::map_color(cell.bg, colors, false);
        let mut mods = Modifier::empty();
        if cell.flags.contains(Flags::BOLD) { mods |= Modifier::BOLD }
        if cell.flags.contains(Flags::ITALIC) { mods |= Modifier::ITALIC }
        if cell.flags.intersects(Flags::ALL_UNDERLINES) { mods |= Modifier::UNDERLINED }
        if cell.flags.contains(Flags::DIM) || dim { mods |= Modifier::DIM }
        if cell.flags.contains(Flags::INVERSE) { mods |= Modifier::REVERSED }
        let width = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
        let extra = cell.zerowidth().filter(|z| !z.is_empty()).map(|z| z.iter().collect());
        out.push((Cell { c: if cell.c == '\0' { ' ' } else { cell.c }, width, fg, bg, mods }, extra));
    }
    // The line's own cells, not the blanks after them (the rest of a full-width screen row).
    while out.last().map(|(c, e)| *c == Cell::DEFAULT && e.is_none()).unwrap_or(false) { out.pop(); }
    out
}

/// server_client_print for the attached client: [lines] into the current pane's view mode (one
/// pushed over whatever mode it is in unless that is view mode), [parse]: their escapes read, as
/// run-shell's output is. False when there is no pane to show them in.
pub fn print(app: &mut App, lines: &[String], parse: bool) -> bool {
    let Some(pane) = app.focused() else { return false };
    if !app.panes.contains_key(&pane) { return false }
    let top_view = app.panes.get(&pane).and_then(|p| p.modes.last()).map(|m| m.view).unwrap_or(false);
    if !top_view {
        let (sx, sy) = screen_size(app, pane);
        let c = ctx(app, pane);
        let ps = app.panes.get(&pane).map(|p| p.search.clone()).unwrap_or_default();
        let view = Copy::view(sx, sy, &ps, !c.vi);
        if let Some(p) = app.panes.get_mut(&pane) { p.modes.push(Box::new(view)) }
    }
    let Some(m) = app.panes.get_mut(&pane).and_then(|p| p.modes.last_mut()) else { return false };
    for line in lines {
        if parse {
            let mut template = m.ictx_template.take();
            let cells = parse_line(line, m.backing.sx, &mut template);
            m.ictx_template = template;
            m.add_cells(cells);
        } else {
            m.add_text(&vis(line));
        }
    }
    if let Some(p) = app.panes.get_mut(&pane) { p.dirty = true }
    app.sync_copy_modal();
    true
}

/// window_copy_command: a copy-mode command (`send -X`) for [pane], [words] its name and
/// arguments, [f] -F, [mouse] the event of the mouse key that ran it.
pub fn command(app: &mut App, pane: u64, words: &[String], f: bool, mouse: Option<&crate::mouse::Event>) {
    if words.is_empty() { return }
    let m = mouse.filter(|m| m.valid).cloned();
    // window_copy_move_mouse: a mouse key's command starts where the mouse is.
    if let Some(ev) = m.as_ref().filter(|ev| !crate::mouse::is_wheel(ev.b)) {
        if let Some((_, mp)) = crate::mouse::mouse_pane(app, ev) {
            if let Some((x, y)) = crate::mouse::mouse_at(app, mp, ev, false) {
                if let Some(c) = app.panes.get_mut(&mp).and_then(|p| p.modes.last_mut()) { c.move_mouse(x as u32, y as u32); }
            }
        }
    }
    let name = words[0].clone();
    let c = ctx(app, pane);
    let mut args = words.to_vec();
    if expands_args(&name) { for i in 1..args.len() { let e = expand(app, pane, &args[i]); args[i] = e } }
    if f && matches!(name.as_str(), "search-backward" | "search-backward-text" | "search-forward" | "search-forward-text") {
        if let Some(a) = args.get(1).cloned() { args[1] = expand(app, pane, &a) }
    }
    let pos = m.as_ref().and_then(|ev| {
        let (x, y) = crate::mouse::mouse_at(app, pane, ev, false)?;
        let (lx, ly) = crate::mouse::mouse_at(app, pane, ev, true).unwrap_or((x, y));
        Some(MousePos { lx: lx as u32, ly: ly as u32 })
    });
    let Some(p) = app.panes.get_mut(&pane) else { return };
    let (modes, search) = (&mut p.modes, &mut p.search);
    let Some(copy) = modes.last_mut() else { return };
    let (action, outs) = run(copy, search, &c, args, pos);
    p.dirty = true;
    for out in outs { apply(app, pane, out, m.as_ref()) }
    if action == Action::Cancel { exit(app, pane) }
    app.sync_copy_modal();
}

/// The heart of window_copy_command: the command found in the table and run (with as many
/// arguments as it takes, else nothing), the search marks cleared as it says (emacs-only ones
/// kept in vi), the count back to one.
pub fn run(copy: &mut Copy, ps: &mut PaneSearch, c: &Ctx, args: Vec<String>, mouse: Option<MousePos>) -> (Action, Vec<Out>) {
    let name = args.first().cloned().unwrap_or_default();
    let mut action = Action::Nothing;
    let mut clear = Clear::Never;
    let mut outs = Vec::new();
    if let Some(&(_, min, max, cl, f)) = TABLE.iter().find(|e| e.0 == name) {
        let count = args.len() - 1;
        if count >= min && count <= max {
            clear = cl;
            let mut cs = Cs { args, ps, ctx: c.clone(), mouse, out: Vec::new() };
            action = f(copy, &mut cs);
            outs = cs.out;
        }
    }
    if !name.starts_with("search-") && copy.searchmark.is_some() {
        if clear == Clear::EmacsOnly && c.vi { clear = Clear::Never }
        if clear != Clear::Never {
            copy.searchmark = None;
            copy.searchx = -1;
            copy.searchy = -1;
        }
        if action == Action::Nothing { action = Action::Redraw }
    }
    copy.prefix = 1;
    (action, outs)
}

/// What a command asked for, done.
fn apply(app: &mut App, pane: u64, out: Out, m: Option<&crate::mouse::Event>) {
    let clipboard = app.options.get("set-clipboard", "", None).as_deref() != Some("off");
    let limit = app.buffer_limit();
    match out {
        Out::Copy { prefix, text } => {
            if clipboard { crate::clipboard::store(&text) }
            app.paste.add_prefixed(prefix.as_deref(), text, limit);
        }
        Out::Pipe { cmd, text, copy } => {
            let cmd = cmd.or_else(|| app.options.get("copy-command", "", None)).filter(|c| !c.is_empty());
            if let Some(cmd) = cmd { crate::input::pipe_to(&cmd, &text) }
            if let Some(prefix) = copy {
                if clipboard { crate::clipboard::store(&text) }
                app.paste.add_prefixed(prefix.as_deref(), text, limit);
            }
        }
        Out::Append(text) => {
            if clipboard { crate::clipboard::store(&text) }
            match app.paste.top().map(|b| (b.name.clone(), b.data.clone())) {
                Some((name, data)) => { let _ = app.paste.set(data + &text, Some(&name), limit); }
                None => { let _ = app.paste.set(text, None, limit); }
            }
        }
        Out::Drag => {
            app.mouse_state.drag = Some(crate::mouse::Drag::Copy);
            if let Some(m) = m { drag_update(app, m) }
        }
        Out::Refresh => {
            let c = ctx(app, pane);
            let Some(p) = app.panes.get(&pane) else { return };
            let grid = from_term(&p.term, &p.times, false);
            if let Some(m) = app.panes.get_mut(&pane).and_then(|p| p.modes.last_mut()) { m.refresh(grid, &c) }
        }
    }
}

/// window_copy_start_drag (copy-mode -M): a selection begun where the mouse went down.
pub fn start_drag(app: &mut App, m: &crate::mouse::Event) {
    let Some((_, pane)) = crate::mouse::mouse_pane(app, m) else { return };
    if app.panes.get(&pane).map(|p| p.modes.is_empty()).unwrap_or(true) { return }
    let Some((x, y)) = crate::mouse::mouse_at(app, pane, m, true) else { return };
    app.mouse_state.drag = Some(crate::mouse::Drag::Copy);
    let c = ctx(app, pane);
    if let Some(copy) = app.panes.get_mut(&pane).and_then(|p| p.modes.last_mut()) { copy.start_drag(x as u32, y as u32, &c) }
    drag_update(app, m);
}

/// window_copy_drag_update: the selection's end to the mouse; on the pane's top or bottom row
/// the view scrolls, and again every 50ms while it stays there.
pub fn drag_update(app: &mut App, m: &crate::mouse::Event) {
    app.mouse_state.scroll_gen += 1;
    let Some((_, pane)) = crate::mouse::mouse_pane(app, m) else { return };
    let Some((x, y)) = crate::mouse::mouse_at(app, pane, m, false) else { return };
    let c = ctx(app, pane);
    let Some(p) = app.panes.get_mut(&pane) else { return };
    let Some(copy) = p.modes.last_mut() else { return };
    let scroll = copy.drag_update(x as u32, y as u32, &c);
    p.dirty = true;
    if scroll.is_some() {
        let generation = app.mouse_state.scroll_gen;
        app.spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(50)).await }, move |app, _| scroll_timer(app, pane, generation));
    }
}

/// window_copy_scroll_timer.
fn scroll_timer(app: &mut App, pane: u64, generation: u64) {
    if app.mouse_state.scroll_gen != generation || app.mouse_state.drag != Some(crate::mouse::Drag::Copy) { return }
    let c = ctx(app, pane);
    let Some(p) = app.panes.get_mut(&pane) else { return };
    let Some(copy) = p.modes.last_mut() else { return };
    if copy.scroll_timer(&c) {
        p.dirty = true;
        app.spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(50)).await }, move |app, _| scroll_timer(app, pane, generation));
    }
}

/// window_copy_drag_release: the drag's scrolling stops.
pub fn drag_release(app: &mut App) { app.mouse_state.scroll_gen += 1 }

#[cfg(test)]
mod tests {
    #[test]
    fn vis_writes_control_characters() {
        assert_eq!(super::vis("a\tb\x1bc\rd\x7f"), "a\tb\\033c\\rd\\177");
    }
}
