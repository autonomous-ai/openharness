//! Pane surfaces with space between them, integrated titles, and a status line at the bottom.
//! The tmux split tree remains intact beneath presentation insets. Classic and tmux looks
//! retain line borders; the search keeps fzf's layout and colours with a preview window.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::vte::ansi::{Color as AColor, NamedColor};
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

use crate::app::App;
use crate::fleet::ago;
use crate::format::clip_middle;
use crate::keys;
use crate::modal::{Modal, PickerKind, PromptKind};
use crate::pane::{Pane, Phase};
use crate::picker::Picker;
use crate::theme::{self, bold, fg, engine_mark, state_mark};
use crate::input::{home_rows, HomeRow};

/// Time-dependent content asks for its next repaint; a static surface asks for
/// none. Hints and messages are deadlines, independent of reduced motion.
pub fn next_repaint(app: &App, frame_started: Instant) -> Option<Instant> {
    // A deadline crossed during rendering still needs one more frame. The next
    // draw starts after it, so expired messages cannot create a repaint loop.
    let now = frame_started;
    let mut next = theme::needs_animation_frame().then(|| now + Duration::from_millis(100));
    let mut deadline = |at: Instant, ms: u64| {
        if let Some(at) = at.checked_add(Duration::from_millis(ms)).filter(|at| *at > now) {
            next = Some(next.map_or(at, |old| old.min(at)));
        }
    };
    if let Some((_, _, at)) = app.toast.as_ref().filter(|_| app.toast_ms() != u64::MAX) {
        deadline(*at, app.toast_ms());
    }
    let hints = !(app.options.tmux_look() && app.options.get("@hn-hint-time", "", None).is_none());
    if app.prefix && hints {
        if let Some(at) = app.prefix_at { deadline(at, app.keymap.hint_ms); }
    }
    next
}

#[cfg(test)]
mod repaint_tests {
    use super::*;

    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (100, 30));
        app.started = Instant::now() - Duration::from_secs(4);
        app
    }

    fn render(app: &mut App) {
        let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 30)).unwrap();
        term.draw(|frame| draw(frame, app)).unwrap();
    }

    #[test]
    fn rendered_formats_start_and_stop_motion_and_terminal_titles_count_too() {
        let mut app = app();
        render(&mut app);
        assert!(next_repaint(&app, Instant::now()).is_none(), "an empty, settled home is static");
        app.options.global_session.insert("status-right".into(), "#{spinner}".into());
        render(&mut app);
        assert!(next_repaint(&app, Instant::now()).is_some());
        app.options.global_session.insert("@hn-animations".into(), "off".into());
        render(&mut app);
        assert!(next_repaint(&app, Instant::now()).is_none());
        app.options.global_session.insert("@hn-animations".into(), "on".into());
        app.options.global_session.insert("status".into(), "off".into());
        render(&mut app);
        assert!(next_repaint(&app, Instant::now()).is_none(), "a hidden status must not keep its spinner alive");
        app.options.global_session.insert("set-titles-string".into(), "#{spinner}".into());
        assert!(app.window_title().is_some());
        assert!(next_repaint(&app, Instant::now()).is_some(), "terminal titles are expanded after the screen");
        app.options.global_session.insert("set-titles-string".into(), "Harness".into());
        render(&mut app);
        app.window_title();
        assert!(next_repaint(&app, Instant::now()).is_none());
    }

    #[test]
    fn timed_notices_and_hints_keep_their_deadlines_without_motion() {
        let mut app = app();
        theme::begin_animation_frame(false);
        let at = Instant::now();
        app.toast = Some(("notice".into(), Color::Yellow, at));
        app.display_ms = 2500;
        app.prefix = true;
        app.prefix_at = Some(at);
        app.keymap.hint_ms = 1000;
        assert_eq!(next_repaint(&app, Instant::now()), Some(at + Duration::from_millis(1000)));
        app.prefix = false;
        assert_eq!(next_repaint(&app, Instant::now()), Some(at + Duration::from_millis(2500)));
        app.toast_exact = Some(0);
        assert!(next_repaint(&app, Instant::now()).is_none(), "until-keypress notices have no expiry timer");
        app.toast_exact = Some(20);
        app.toast.as_mut().unwrap().2 = at - Duration::from_secs(1);
        app.prefix = true;
        app.prefix_at = Some(at - Duration::from_secs(2));
        assert!(next_repaint(&app, Instant::now()).is_none(), "expired deadlines must not spin the loop");
        app.keymap.hint_ms = u64::MAX;
        next_repaint(&app, Instant::now()); // user-configured delays must not overflow Instant
    }

    #[test]
    fn a_deadline_crossed_during_drawing_gets_one_more_frame() {
        let mut app = app();
        theme::begin_animation_frame(false);
        let now = Instant::now();
        let at = now - Duration::from_millis(100);
        app.toast = Some(("notice".into(), Color::Yellow, at));
        app.toast_exact = Some(90);
        assert_eq!(next_repaint(&app, at), Some(at + Duration::from_millis(90)));
        assert!(next_repaint(&app, now).is_none());
        app.toast = None;
        app.prefix = true;
        app.prefix_at = Some(at);
        app.keymap.hint_ms = 90;
        assert_eq!(next_repaint(&app, at), Some(at + Duration::from_millis(90)));
        assert!(next_repaint(&app, now).is_none());
    }

    #[test]
    fn tmux_hints_only_request_a_frame_when_enabled() {
        let mut app = app();
        theme::begin_animation_frame(false);
        app.options.global_session.insert("@hn-look".into(), "tmux".into());
        app.prefix = true;
        app.prefix_at = Some(Instant::now());
        assert!(next_repaint(&app, Instant::now()).is_none());
        app.options.global_session.insert("@hn-hint-time".into(), "600".into());
        assert_eq!(next_repaint(&app, Instant::now()), app.prefix_at.map(|at| at + Duration::from_millis(600)));
    }
}

/// screen_write_box_border_set: a box's corners, sides and its rule's joins, for tmux's box
/// lines (single, double, heavy, simple, rounded, padded, none).
fn box_set(lines: &str) -> (&'static str, &'static str, &'static str, &'static str, &'static str, &'static str, &'static str, &'static str) {
    match lines {
        "double" => ("╔", "╗", "╚", "╝", "═", "║", "╠", "╣"),
        "heavy" => ("┏", "┓", "┗", "┛", "━", "┃", "┣", "┫"),
        "simple" => ("+", "+", "+", "+", "-", "|", "+", "+"),
        "rounded" => ("╭", "╮", "╰", "╯", "─", "│", "├", "┤"),
        "padded" | "none" => (" ", " ", " ", " ", " ", " ", " ", " "),
        _ => ("┌", "┐", "└", "┘", "─", "│", "├", "┤"),
    }
}

pub fn draw(frame: &mut Frame, app: &mut App) {
    theme::begin_animation_frame(app.options.animations());
    app.renumber();
    // automatic-rename as of this frame: a pane that went into a mode ([tmux]) or out of one is
    // named so in the window list it is drawn with.
    app.sync_titles();
    let (usstyle, links) = crate::term_out::outer_features(&app.options.array("terminal-features"));
    crate::term_out::set_colours(crate::term_out::colours_for(&std::env::var("TERM").unwrap_or_default(), &std::env::var("COLORTERM").unwrap_or_default(), &app.options.array("terminal-features"), &app.options.array("terminal-overrides")));
    crate::term_out::begin_frame(usstyle, links);
    let area = frame.area();
    if area.width == 0 || area.height == 0 { return }
    // Ratatui can observe a resize before the queued terminal event reaches the app.
    // Every pane and popup must use this frame's dimensions before drawing into its buffer.
    if app.size != (area.width, area.height) {
        app.size = (area.width, area.height);
        app.fit_panes();
    }
    // The status lines (tmux's status: off, on, 2 … 5), at the bottom or (status-position) the top.
    let lines = app.status_lines().max(1).min(area.height);
    let status = Rect::new(0, if app.status_top { 0 } else { area.height - lines }, area.width, lines);
    let body = app.body();
    // The window in front at the terminal's size, whatever brought it there.
    let window_area = app.window_area(app.tab());
    if app.tab().root.as_ref().is_some_and(|r| r.size() != (window_area.width, window_area.height)) { app.fit_panes() }
    let buf = frame.buffer_mut();
    let mut cursor: Option<Position> = None;
    // A list takes the window (with --height, only its bottom rows: the panes stay in view).
    // (The settings panel is not one: it floats over the panes, as the New Harness form does.)
    let full_screen = matches!(&app.modal, Some(Modal::Picker { kind, .. }) if theme::fzf_opts().height.is_none() && !crate::settings::is_panel(kind));
    if !full_screen {
        if app.tab().home || app.tab().root.is_none() { empty_window(buf, app, body) }
        else { cursor = window(buf, app, body) }
    }
    // Panes in clock mode: the time over each (its cursor hidden).
    if !full_screen && app.tab().root.is_some() {
        let clocks: Vec<Rect> = app.rects.iter().filter(|(id, _)| app.panes.get(id).map(|p| p.clock).unwrap_or(false)).map(|(id, r)| { if Some(*id) == app.focused() { cursor = None } app.content_of(app.tab(), *r) }).collect();
        for rect in clocks { clock(buf, app, rect) }
    }
    // ── status bar ──
    // The status bar down a side, and the tabs over the panes beside it.
    crate::bar::draw(buf, app);
    if let Some(Modal::DisplayPanes { .. }) = &app.modal { display_panes(buf, app) }
    let search_busy = app.said_due.is_some() || app.said_pending > 0;
    let msg_style = app.message_style();
    if let Some(Modal::Picker { kind, mut picker }) = app.modal.take_if(|m| matches!(m, Modal::Picker { kind, .. } if crate::settings::is_panel(kind))) {
        let (at, shown) = crate::settings::draw(buf, app, body, &kind, &mut picker);
        cursor = at;
        if let Some(rect) = shown { panel_preview(buf, app, &kind, &picker, rect) }
        app.modal = Some(Modal::Picker { kind, picker });
    }
    if let Some(modal) = &mut app.modal {
        match modal {
            Modal::Picker { kind, .. } if crate::settings::is_panel(kind) => {}
            // (--no-input: no prompt, no cursor.)
            // (Too small to hold a list — a window being dragged, a drop-down terminal opening: none
            // drawn until it has the room, as fzf clamps and tmux draws what fits; never a crash.)
            Modal::Picker { kind, picker } if body.height >= 1 && body.width >= 2 => { let at = fzf(buf, body, picker, kind, search_busy, msg_style); cursor = (!theme::fzf_opts().no_input).then_some(at) }
            _ => {}
        }
    }
    // The picker drew with a placeholder preview; a live pane preview needs the whole app.
    if let Some(Modal::Picker { kind, picker }) = app.modal.as_ref().filter(|m| body.height >= 1 && body.width >= 2 && !matches!(m, Modal::Picker { kind, .. } if crate::settings::is_panel(kind))) {
        if let (_, Some(pbox), _) = fzf_split(fzf_frame(body, picker).inner, picker) { preview(buf, app, kind, picker, &pbox) }
    }
    let popup = match &app.modal { Some(Modal::Popup { pane, x, y, width, height, border, title, look }) => Some((*pane, *x, *y, *width, *height, *border, title.clone(), look.clone())), _ => None };
    if let Some((pane, px, py, width, height, border_on, title, look)) = popup {
        // popup.c: its box (popup-border-lines, -b) in popup-border-style (-S) where display-popup
        // placed it, the title a format drawn over the top border from its third cell
        // (screen_write_box), the program inside in popup-style (-s).
        let size = *buf.area();
        let (w, h) = (width.min(size.width), height.min(size.height));
        let area = Rect::new(px.min(size.width - w), py.min(size.height - h), w, h);
        crate::term_out::clear_extras(area);
        let style = crate::draw::style_over(if look.style.is_empty() { "default" } else { &look.style }, Style::default());
        let border = crate::draw::style_over(if look.border_style.is_empty() { "default" } else { &look.border_style }, style);
        for y in area.y..area.y + h { for x in area.x..area.x + w { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); c.set_style(style); } } }
        let colours = (style.fg.filter(|c| *c != Color::Reset), style.bg.filter(|c| *c != Color::Reset));
        if !border_on {
            if let Some(p) = app.panes.get_mut(&pane) { cursor = pane_body(buf, p, area, true, colours); }
        } else {
            let (tl, tr, bl, br, hz, vt, _, _) = box_set(&look.lines);
            let put = |buf: &mut Buffer, x: u16, y: u16, s: &str| { if let Some(c) = buf.cell_mut((x, y)) { c.set_symbol(s); c.set_style(border); } };
            let (x1, y1) = (area.x + w - 1, area.y + h - 1);
            for x in area.x + 1..x1 { put(buf, x, area.y, hz); put(buf, x, y1, hz) }
            for y in area.y + 1..y1 { put(buf, area.x, y, vt); put(buf, x1, y, vt) }
            put(buf, area.x, area.y, tl); put(buf, x1, area.y, tr); put(buf, area.x, y1, bl); put(buf, x1, y1, br);
            if !title.is_empty() && w > 4 {
                for (i, cell) in crate::draw::format_draw_over(&title, border, w - 4).into_iter().enumerate() {
                    if let Some((ch, cs)) = cell { if let Some(c) = buf.cell_mut((area.x + 2 + i as u16, area.y)) { c.set_symbol(if ch.is_empty() { " " } else { &ch }); c.set_style(cs); } }
                }
            }
            let inner = Rect::new(area.x + 1, area.y + 1, w.saturating_sub(2), h.saturating_sub(2));
            if let Some(p) = app.panes.get_mut(&pane) { cursor = pane_body(buf, p, inner, true, colours); }
        }
    }
    // (Not under @hn-look tmux unless @hn-hint-time asks for it: tmux shows nothing after the prefix.)
    let hints = !(app.options.tmux_look() && app.options.get("@hn-hint-time", "", None).is_none());
    if hints && app.prefix && app.prefix_at.map(|t| t.elapsed() >= Duration::from_millis(app.keymap.hint_ms)).unwrap_or(false) { which_key(buf, app, body) }
    // `set -g status off`: no status line — a prompt or a message still borrows the last row.
    let hidden = app.status_lines() == 0;
    let speaking = matches!(app.modal, Some(Modal::Prompt(_)) | Some(Modal::Confirm { .. })) || app.toast.as_ref().map(|(_, _, at)| at.elapsed() < Duration::from_millis(app.toast_ms())).unwrap_or(false);
    if !hidden || speaking { if let Some(pos) = status_line(buf, app, status) { cursor = Some(pos) } }
    // A menu is tmux's overlay: over the status line too, where it is kept on the screen.
    if let Some(Modal::Menu(m)) = &app.modal { menu(buf, app, m) }
    if let Some(Modal::NewHarness(form)) = &mut app.modal { cursor = crate::new_harness::draw(buf, body, form); }
    if let Some(pos) = cursor { frame.set_cursor_position(pos) }
}

/// tmux's menu (menu_draw_cb, screen_write_menu, screen_write_box): a box width + 4 wide at its
/// place in menu-border-lines and menu-border-style, the title drawn over the top border from its
/// third column, each item from the third column in menu-style — menu-selected-style when chosen,
/// dim when disabled — its key right-aligned as (k); '' a rule across, joined to the sides.
fn menu(buf: &mut Buffer, app: &App, m: &crate::modal::Menu) {
    let opt = |name: &str, default: &str| Some(app.style_spec(name, app.active, app.focused())).filter(|s| !s.is_empty()).unwrap_or_else(|| default.to_string());
    let base = Style::default();
    // tmux's menu_set_style keeps colours, clearing attributes for each menu pair.
    let plain = |mut st: Style| { st.add_modifier = Modifier::empty(); st.sub_modifier = Modifier::empty(); st };
    let style = plain(crate::draw::style_over(&opt("menu-style", "default"), base));
    let selected = plain(crate::draw::style_over(&opt("menu-selected-style", "bg=yellow,fg=black"), base));
    let border = plain(crate::draw::style_over(&opt("menu-border-style", "default"), style));
    let lines = opt("menu-border-lines", "single");
    let (tl, tr, bl, br, hz, vt, lj, rj) = box_set(&lines);
    let (w, h) = (m.width + 4, m.items.len() as u16 + 2);
    let (x0, y0) = (m.x, m.y);
    crate::term_out::clear_extras(Rect::new(x0, y0, w, h));
    let put = |buf: &mut Buffer, x: u16, y: u16, s: &str, st: Style| { if let Some(c) = buf.cell_mut((x, y)) { c.set_symbol(s); c.set_style(st); } };
    for y in y0..y0 + h { for x in x0..x0 + w { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); c.set_style(style); } } }
    let (x1, y1) = (x0 + w - 1, y0 + h - 1);
    for x in x0 + 1..x1 { put(buf, x, y0, hz, border); put(buf, x, y1, hz, border) }
    for y in y0 + 1..y1 { put(buf, x0, y, vt, border); put(buf, x1, y, vt, border) }
    put(buf, x0, y0, tl, border); put(buf, x1, y0, tr, border); put(buf, x0, y1, bl, border); put(buf, x1, y1, br, border);
    let draw_at = |buf: &mut Buffer, x: u16, y: u16, text: &str, st: Style, avail: u16| {
        for (i, cell) in crate::draw::format_draw_over(text, st, avail).into_iter().enumerate() {
            if let Some((ch, cs)) = cell { if let Some(c) = buf.cell_mut((x + i as u16, y)) { c.set_symbol(if ch.is_empty() { " " } else { &ch }); c.set_style(cs); } }
        }
    };
    if !m.title.is_empty() { draw_at(buf, x0 + 2, y0, &m.title, border, w.saturating_sub(4)) }
    for (i, it) in m.items.iter().enumerate() {
        let y = y0 + 1 + i as u16;
        if it.separator {
            put(buf, x0, y, lj, border);
            for x in x0 + 1..x1 { put(buf, x, y, hz, border) }
            put(buf, x1, y, rj, border);
            continue;
        }
        // screen_write_menu: the row padded first, then a disabled item's words drawn dim.
        let pad = if m.choice == Some(i) && !it.disabled { selected } else { style };
        for x in x0 + 1..x0 + 1 + m.width + 2 { put(buf, x, y, " ", pad) }
        let st = if it.disabled { style.add_modifier(Modifier::DIM) } else { pad };
        let text = if it.key.is_empty() { it.label.clone() } else { format!("{}#[default] #[align=right]({})", it.label, it.key) };
        draw_at(buf, x0 + 2, y, &text, st, m.width);
    }
}

/// A pause after the prefix: every key that can come next, from the live table (your binds too),
/// in a box over the bottom of the window — tmux's keys, with the hint zellij users praise.
fn which_key(buf: &mut Buffer, app: &App, body: Rect) {
    if body.width < 16 || body.height < 4 { return }
    let mut items: Vec<(String, String)> = Vec::new();
    let mut digits = false;
    for b in &app.keymap.prefix_table {
        let key = crate::keys::name(&b.chord);
        if b.command.starts_with("select-window -t ") && key.len() == 1 && key.chars().all(|c| c.is_ascii_digit()) { digits = true; continue }
        let what = if b.note.is_empty() { b.command.clone() } else { b.note.clone() };
        items.push((key, what));
    }
    if digits { items.insert(0, ("0-9".into(), "Select window 0 to 9".into())) }
    // The keys a tmux user reaches for every day first (what fits of a small window is those),
    // then the rest in the table's order.
    const FIRST: &[&str] = &["c", "N", "n", "p", "l", "0-9", "w", "s", "d", "%", "\"", "x", "z", "o", ";", "[", "]", ":", "?", "&", ",", "$", "!", "q", "t", "{", "}", "Space"];
    items.sort_by_key(|(k, _)| FIRST.iter().position(|f| f == k).unwrap_or(FIRST.len()));
    let key_w = items.iter().map(|(k, _)| k.width()).max().unwrap_or(1).min(8);
    let col_w: usize = key_w + if body.width >= 150 { 44 } else { 32 };
    let cols = ((body.width as usize).saturating_sub(4) / col_w).max(1);
    // (The columns share the width: a note is cut only where the panel ends.)
    let col_w = ((body.width as usize).saturating_sub(4) / cols).max(col_w);
    let rows_needed = items.len().div_ceil(cols);
    // (A third of the window at most: the panes stay in view above it.)
    let height = (rows_needed as u16 + 2).min((body.height / 3).max(4)).min(body.height);
    let area = Rect::new(body.x, body.y + body.height - height, body.width, height);
    // The shortcut box takes hn's chrome colours (the terminal's surfaces), so it sits with the
    // status line and pane surfaces rather than floating in the terminal's default colours.
    let pal = theme::pane_palette();
    let panel = Style::default().bg(pal.surface);
    let border = Style::default().fg(pal.border).bg(pal.surface);
    crate::term_out::clear_extras(area);
    for y in area.y..area.y + area.height { for x in area.x..area.x + area.width { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); c.set_style(panel); } } }
    for x in area.x..area.x + area.width { buf.set_string(x, area.y, "─", border); buf.set_string(x, area.y + area.height - 1, "─", border) }
    for y in area.y..area.y + area.height { buf.set_string(area.x, y, "│", border); buf.set_string(area.x + area.width - 1, y, "│", border) }
    buf.set_string(area.x, area.y, "┌", border); buf.set_string(area.x + area.width - 1, area.y, "┐", border);
    buf.set_string(area.x, area.y + area.height - 1, "└", border); buf.set_string(area.x + area.width - 1, area.y + area.height - 1, "┘", border);
    let title = format!(" {} ", crate::keys::name(&app.keymap.prefix));
    buf.set_string(area.x + 2, area.y, &title, Style::default().fg(pal.foreground).bg(pal.surface).add_modifier(Modifier::BOLD));
    let inner_rows = area.height.saturating_sub(2) as usize;
    // Column-major, like ls: read down, then across.
    let fits = cols * inner_rows.max(1);
    if items.len() > fits && fits > 0 {
        // Say there is more, bottom right of the box (C-b ? has them all).
        let more = format!(" +{} more — {} ? ", items.len() - fits + 1, crate::keys::name(&app.keymap.prefix));
        let mx = (area.x + area.width).saturating_sub(more.width() as u16 + 2);
        buf.set_string(mx, area.y + area.height - 1, &more, Style::default().fg(pal.muted).bg(pal.surface).add_modifier(Modifier::DIM));
    }
    for (i, (key, what)) in items.iter().enumerate() {
        let (col, row) = (i / inner_rows.max(1), i % inner_rows.max(1));
        if col >= cols || (items.len() > fits && i + 1 >= fits) { break }
        let x = area.x + 2 + (col * col_w) as u16;
        let y = area.y + 1 + row as u16;
        buf.set_string(x, y, format!("{key:>key_w$}"), Style::default().fg(theme::accent()).bg(pal.surface).add_modifier(Modifier::BOLD));
        let room = col_w - key_w - 3;
        buf.set_stringn(x + key_w as u16 + 1, y, clip(what, room), room, Style::default().fg(pal.foreground).bg(pal.surface));
    }
}



// ── the window ───────────────────────────────────────────────────────────────

/// The active window's programs, then their pane surfaces or classic borders and titles.
fn window(buf: &mut Buffer, app: &mut App, body: Rect) -> Option<Position> {
    let focus = app.focused();
    let surfaces = app.options.pane_look();
    // A theme chosen in Appearance is the panes' too, as a terminal's theme is: their default text
    // and background, and the sixteen colours programs name (None: the terminal's own).
    let themed = chosen_theme(app);
    if surfaces {
        crate::term_out::clear_extras(body);
        buf.set_style(body, Style::default().bg(Color::Reset));
    } else if let Some(t) = themed {
        buf.set_style(body, Style::default().bg(theme::depth_fit(rgb(t.background))));
    }
    let rects = app.rects.clone();
    let mut cursor = None;
    for (id, rect) in rects.iter() {
        let active = Some(*id) == focus;
        let content = app.content_of(app.tab(), *rect);
        // tmux's window-style / window-active-style: the default colours a pane's cells fall back to.
        // tty_default_colours: the active pane's window-active-style where it sets a colour, else
        // window-style (both the pane's own, its window's or the global ones) — else the theme's.
        let (a, w) = (app.style_of("window-active-style", app.active, Some(*id)), app.style_of("window-style", app.active, Some(*id)));
        let window = if active { (a.fg.or(w.fg), a.bg.or(w.bg)) } else { (w.fg, w.bg) };
        // (A style's `default` is Reset: the terminal's colour, which the theme stands in for.)
        let set = |c: Option<Color>| c.filter(|c| *c != Color::Reset);
        let window = match themed {
            Some(t) => (set(window.0).or(Some(theme::depth_fit(rgb(t.foreground)))), set(window.1).or(Some(theme::depth_fit(rgb(t.background))))),
            None => window,
        };
        if surfaces {
            let f = crate::pane_frame::frame(*rect, app.window_area(app.tab()), app.box_inner(app.tab()), app.pane_status(app.tab()));
            // Single and zoomed panes also sit directly on the terminal background.
            buf.set_style(f.surface, Style::default().fg(window.0.unwrap_or(Color::Reset)).bg(window.1.unwrap_or(Color::Reset)));
        }
        // choose-tree's tree, over the pane.
        if app.panes.get(id).map(|p| p.tree_top()).unwrap_or(false) {
            if let Some(bg) = window.1 { buf.set_style(content, Style::default().bg(bg)) }
            crate::tree::draw(app, *id, buf, content);
            if let Some(pane) = app.panes.get_mut(id) { pane.dirty = false }
            continue;
        }
        if app.panes.get(id).map(|p| p.copy_top()).unwrap_or(false) {
            let (styles, ctx) = (crate::copy::styles(app, *id), crate::copy::ctx(app, *id));
            if let Some(m) = app.panes.get(id).and_then(|p| p.modes.last()) {
                if let Some(bg) = window.1 { buf.set_style(content, Style::default().bg(bg)) }
                let (x, y) = m.draw(buf, content, &styles, window, &ctx);
                if active && x < content.width && y < content.height { cursor = Some(Position::new(content.x + x, content.y + y)) }
            }
            if let Some(pane) = app.panes.get_mut(id) { pane.dirty = false }
            continue;
        }
        if let Some(pane) = app.panes.get_mut(id) {
            if let Some(pos) = pane_body(buf, pane, content, active, window) { cursor = Some(pos) }
            pane.dirty = false;
        }
        if let Some(t) = themed { theme_ansi(buf, content, t) }
        // `@hn-dim on`: a pane you are not in, a little quieter (with one pane, nothing to set apart).
        if !active && rects.len() > 1 && app.options.dim_others() {
            let pal = theme::pane_palette();
            crate::settings::dim(buf, content, window.1.unwrap_or(pal.background), window.0.unwrap_or(pal.foreground));
        }
    }
    if surfaces { pane_chrome(buf, app); } else if app.options.box_panes() { boxes(buf, app); } else { borders(buf, app, body); }
    if app.modal.is_some() && !matches!(app.modal, Some(Modal::Copy { .. })) { None } else { cursor }
}

/// Integrated titles on borderless pane surfaces. Background contrast identifies focus.
/// Program cells retain their ANSI colours; moving focus changes no content dimensions or mouse coordinates.
fn pane_chrome(buf: &mut Buffer, app: &App) {
    let (canvas, inner) = (app.window_area(app.tab()), app.box_inner(app.tab()));
    for (id, rect) in &app.rects {
        let f = crate::pane_frame::frame(*rect, canvas, inner, app.pane_status(app.tab()));
        let active = Some(*id) == app.focused();
        let style_name = if active { "pane-active-border-style" } else { "pane-border-style" };
        let style = app.style_of(style_name, app.active, Some(*id));
        let own = |name| app.options.has_window_override(name, &app.tab().id, *id);
        let a = app.style_of("window-active-style", app.active, Some(*id));
        let w = app.style_of("window-style", app.active, Some(*id));
        let pane_bg = if active { a.bg.or(w.bg) } else { w.bg };
        let bg = if own(style_name) { style.bg.or(pane_bg) } else { pane_bg };
        let style = style.bg(bg.unwrap_or(Color::Reset));
        let Some(title) = f.title else { continue };
        let style = if own(style_name) { style } else {
            let palette = theme::pane_palette();
            style.fg(if active { palette.active_foreground } else { palette.muted })
        };
        buf.set_style(title, style);
        let marker = if app.marked == Some(*id) { "◆" } else { " " };
        if title.width > 0 { if let Some(cell) = buf.cell_mut((title.x, title.y)) { cell.set_symbol(marker).set_style(style); } }
        let text = Rect::new(title.x + 1.min(title.width), title.y, title.width.saturating_sub(2), 1);
        title_line(buf, app, *id, text, style);
    }
}

/// screen-redraw.c over the window: every border cell (its junction, the active pane's in
/// pane-active-border-style, the marked pane's reversed, pane-border-indicators' arrows) and each
/// pane's status line, the format drawn over border characters from two cells in.
fn borders(buf: &mut Buffer, app: &App, body: Rect) {
    let tab = app.tab();
    let status = app.pane_status(tab);
    let all = app.pane_geoms(app.active);
    let visible: Vec<(u64, crate::layout::Geom)> = if tab.zoomed {
        app.rects.iter().map(|(id, r)| { let c = app.content_of(tab, *r); (*id, crate::layout::Geom { x: (c.x - body.x) as u32, y: (c.y - body.y) as u32, w: c.width as u32, h: c.height as u32 }) }).collect()
    } else { all.clone() };
    let get = |name: &str| app.options.get(name, &tab.id, None).unwrap_or_default();
    let frame = crate::borders::Frame {
        sx: body.width as u32, sy: body.height as u32, all: &all, visible: &visible, active: app.focused(), marked: app.marked,
        status, lines: crate::borders::Lines::of(&get("pane-border-lines")), indicators: crate::borders::Indicators::of(&get("pane-border-indicators")), base: app.pane_base(app.active),
    };
    for c in frame.cells() {
        let style = border_style(app, c.paint == crate::borders::Paint::Active);
        let style = if c.marked { style.add_modifier(if app.options.tmux_look() { Modifier::REVERSED } else { Modifier::BOLD }) } else { style };
        if let Some(cell) = buf.cell_mut((body.x + c.x as u16, body.y + c.y as u16)) { cell.set_symbol(&c.glyph).set_style(style); }
    }
    for t in frame.titles() {
        let style = border_style(app, t.active);
        let (x, y) = (body.x + t.x as u16, body.y + t.y as u16);
        for (k, g) in t.fill.iter().enumerate() { if let Some(cell) = buf.cell_mut((x + k as u16, y)) { cell.set_symbol(g).set_style(style); } }
        title_line(buf, app, t.pane, Rect::new(x, y, t.width as u16, 1), style);
    }
}

/// pane-border-style, or for the active pane pane-active-border-style (tmux's: yellow while the
/// pane is in copy mode, red while the window's panes are synchronized, else green), as the
/// window has them: colours, background and attributes, a format in them expanded for the pane.
/// hn leaves a stock border — tmux's green active border — alone only when you set one yourself;
/// otherwise it takes the theme's readable foreground (the active pane dimmed), so the selected
/// pane reads as the theme rather than tmux's green.
fn border_style(app: &App, active: bool) -> Style {
    let mut s = app.style_of(if active { "pane-active-border-style" } else { "pane-border-style" }, app.active, app.focused());
    let own = if active { app.look.active_border.is_some() } else { app.look.border.is_some() };
    if !own && !app.options.tmux_look() {
        let (_, fg, _) = crate::theme::palette();
        s = s.fg(fg);
        if !active { s = s.add_modifier(Modifier::DIM) }
    }
    s
}

/// A pane's status line over its border characters: its pane-border-format (hn's: the harness's
/// name, its state symbol, and as far as the pane is wide, its project and branch), drawn as
/// screen_redraw_make_pane_status draws it — format_draw over the border, so #[align=right],
/// #[align=centre] and #[fill] place it as tmux does, the border showing wherever the format
/// writes nothing.
fn title_line(buf: &mut Buffer, app: &App, id: u64, area: Rect, style: Style) {
    if area.width == 0 { return }
    let Some(fmt) = app.options.get("pane-border-format", &app.tab().id, Some(id)) else { return };
    let expanded = crate::format::expand(app, &fmt, app.active, Some(id), true);
    for (i, cell) in crate::draw::format_draw_over(&expanded, style, area.width).into_iter().enumerate() {
        if let Some((ch, cs)) = cell { if let Some(c) = buf.cell_mut((area.x + i as u16, area.y)) { c.set_symbol(if ch.is_empty() { " " } else { &ch }); c.set_style(cs); } }
    }
}

// ── box panes ──

/// Box panes (`@hn-border box`, the default): every pane its own frame in pane-border-lines' box
/// lines — the accent around the focused one, the attention colour around one whose harness waits
/// on you (a question, a permission, its input), as the app colours its line; the quiet border
/// colour elsewhere (or your pane-border-style / pane-active-border-style). The pane's title is
/// drawn into the frame's top or bottom line as ` title `, in the accent and bold when focused.
fn boxes(buf: &mut Buffer, app: &App) {
    let tab = app.tab();
    let (canvas, status) = (app.window_area(tab), app.pane_status(tab));
    let lines = app.options.get("pane-border-lines", &tab.id, None).unwrap_or_default();
    let hz = box_set(&lines).4;
    let inner = app.box_inner(tab);
    let frames: Vec<(u64, crate::pane_frame::Frame)> = app.rects.iter().map(|(id, r)| (*id, crate::pane_frame::boxed_in(*r, canvas, inner, status))).filter(|(_, f)| f.content != f.surface).collect();
    // Each box its own line, in its own colour — boxes side by side touch (`││`), never sharing a
    // line or joining at a corner.
    for (id, f) in &frames {
        let (r, style) = (f.surface, box_style(app, *id));
        let edge: std::collections::HashSet<(u16, u16)> = (r.x..r.right()).flat_map(|x| [(x, r.y), (x, r.bottom() - 1)]).chain((r.y..r.bottom()).flat_map(|y| [(r.x, y), (r.right() - 1, y)])).collect();
        for &(x, y) in &edge {
            let on = |dx: i32, dy: i32| edge.contains(&((x as i32 + dx) as u16, (y as i32 + dy) as u16));
            let g = crate::settings::joint(&lines, y > 0 && on(0, -1), on(0, 1), x > 0 && on(-1, 0), on(1, 0));
            if let Some(c) = buf.cell_mut((x, y)) { c.set_symbol(g).set_style(style); }
        }
    }
    for (id, f) in &frames {
        let (id, style) = (*id, box_style(app, *id));
        let active = Some(id) == app.focused();
        let Some(t) = f.title else { continue };
        // (Its own colour for the words: the frame's when it waits on you, else a quieter one.)
        let words = if active { style.add_modifier(Modifier::BOLD) } else if app.pane_state(id) == Some(crate::fleet::State::NeedsInput) { style } else { style.fg(theme::paint(theme::pane_palette().muted)) };
        let Some(fmt) = app.options.get("pane-border-format", &tab.id, Some(id)) else { continue };
        let expanded = crate::format::expand(app, &fmt, app.active, Some(id), true);
        let cells = crate::draw::format_draw_over(&expanded, words, t.width.saturating_sub(1));
        // ` title `: a blank after the words where the line would run on.
        let end = cells.iter().position(|c| c.is_none()).unwrap_or(cells.len());
        for (i, cell) in cells.into_iter().enumerate() {
            if let Some((ch, cs)) = cell { if let Some(c) = buf.cell_mut((t.x + i as u16, t.y)) { c.set_symbol(if ch.is_empty() { " " } else { &ch }); c.set_style(cs); } }
        }
        if end > 0 { if let Some(c) = buf.cell_mut((t.x + end as u16, t.y)) { if c.symbol() == hz { c.set_symbol(" ").set_style(words); } } }
    }
}

/// A box's frame colour: focused → the accent, waiting on you → the attention colour, else the
/// quiet border colour; your own pane-(active-)border-style where you set one (and tmux's own
/// under `@hn-look tmux`, which draws no boxes). The marked pane's frame is bold.
fn box_style(app: &App, id: u64) -> Style {
    let active = Some(id) == app.focused();
    let own = if active { app.look.active_border.is_some() } else { app.look.border.is_some() };
    let style = if own { border_style(app, active) }
        else if active { Style::default().fg(theme::paint(theme::accent())).add_modifier(if theme::no_color() { Modifier::BOLD } else { Modifier::empty() }) }
        else if app.pane_state(id) == Some(crate::fleet::State::NeedsInput) { Style::default().fg(theme::paint(theme::ATTENTION)) }
        else { Style::default().fg(theme::paint(theme::pane_palette().border)) };
    if app.marked == Some(id) { style.add_modifier(Modifier::BOLD) } else { style }
}

/// A window with no harness in it: the harnesses you were just with, one key away.
const WORDMARK: [&str; 2] = ["█ █ ▄▀█ █▀█ █▄ █ █▀▀ █▀ █▀", "█▀█ █▀█ █▀▄ █ ▀█ ██▄ ▄█ ▄█"];

fn empty_window(buf: &mut Buffer, app: &App, area: Rect) {
    if app.os_session && (app.os_live || home_rows(app).is_empty()) { os_welcome(buf, app, area); return }
    let rows = home_rows(app);
    let (_, theme_fg, _) = crate::theme::palette();
    let width = area.width.min(84).saturating_sub(4);
    let left = area.x + (area.width.saturating_sub(width)) / 2;
    let compact = area.height < 22;
    let mut lines: Vec<Line> = Vec::new();
    if !compact { for w in WORDMARK { lines.push(Line::styled(w, fg(theme::accent()))) } lines.push(Line::raw("")) }
    else { lines.push(Line::styled("harness", bold(theme::accent()))) }
    let local = app.fleet.local_machine_name();
    let up = app.fleet.visible_machines().filter(|m| m.usable()).count();
    let total = app.fleet.visible_machines().count();
    let sub = if total > 1 { format!("{local} · {up}/{total} machines connected") } else { local };
    lines.push(Line::styled(sub, fg(theme::MUTED)));
    lines.push(Line::raw(""));
    let centered = lines.len();
    if app.daemon_down {
        lines.push(Line::styled("The Harness daemon is not running here.", bold(theme::DANGER)));
        lines.push(Line::styled("Run `harness start` — this screen connects by itself.", fg(theme::SOFT)));
    } else if app.fleet.agents.is_empty() && app.started.elapsed().as_secs() < 3 {
        lines.push(Line::styled(format!("{} Finding your harnesses…", theme::spinner(app.tick)), fg(theme::SOFT)));
    } else if rows.is_empty() {
        lines.push(Line::styled("Nothing running.", fg(theme::SOFT)));
        let hint = |c: &str| app.keymap.hint(c).unwrap_or_default();
        lines.push(Line::from(vec![Span::styled(hint("new-harness"), bold(theme::accent())), Span::styled(" starts a harness · ", fg(theme::MUTED)), Span::styled(hint("choose-tree -Zs"), bold(theme::accent())), Span::styled(" opens a paused one", fg(theme::MUTED))]));
    } else {
        let many = up > 1;
        for (index, row) in rows.iter().enumerate() {
            // A harness as its state says; a conversation Harness did not start as a paused one
            // would be (nothing running), its folder where the project goes.
            let (m, dot, color, engine, title, recency, detail) = match row {
                HomeRow::Harness(m, a) => {
                    let Some(agent) = app.fleet.agent(m, a) else { continue };
                    let (dot, _, color) = state_mark(app.fleet.state_of(agent), app.tick);
                    let detail = agent.question.as_ref().map(|q| (q.prompt.clone(), theme::ATTENTION)).unwrap_or((if agent.project.is_empty() { agent.cwd.clone() } else { agent.project.clone() }, theme::MUTED));
                    (m.clone(), dot, color, agent.engine.clone(), agent.name.clone(), agent.recency(), detail)
                }
                HomeRow::External(x) => {
                    let (dot, _, color) = state_mark(crate::fleet::State::Paused, app.tick);
                    let folder = x.cwd.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
                    (x.machine.clone(), dot, color, x.engine.clone(), if x.title.is_empty() { folder.clone() } else { x.title.clone() }, x.last_at, (folder, theme::MUTED))
                }
            };
            let m = &m;
            let (mark, mark_color) = engine_mark(&engine);
            // Narrow: the machine goes before the title gives way (then the age).
            let right = if width < 56 { String::new() } else { format!("{}{}", if many && width >= 70 { format!("{}  ", app.fleet.machine_name(m)) } else { String::new() }, ago(recency)) };
            let name_w = if width < 56 { (width as usize).saturating_sub(10).min(28) } else { 28 };
            // Widths are display widths: a CJK or emoji title keeps the columns straight.
            let name = clip_middle(&title, name_w);
            let name = format!("{name}{}", " ".repeat(name_w.saturating_sub(name.width())));
            let detail_room = (width as usize).saturating_sub(name_w + right.width() + 12);
            let detail_text = clip(&detail.0, detail_room);
            let used = 2 + 2 + 2 + name_w + 2 + detail_text.width();
            let pad = (width as usize).saturating_sub(used + right.width());
            let selected = app.home_moved && index == app.home_cursor;
            // The chosen row as fzf draws its current line (reverse video where there is no colour).
            let bg = match (selected, theme::fzf().bw) { (true, true) => Style::default().add_modifier(Modifier::REVERSED), (true, false) => Style::default().bg(theme::fzf().bg_plus), _ => Style::default() };
            let tint = |c: Color| if c == theme::MUTED || c == theme::SOFT { bg.fg(theme::paint(theme_fg)).add_modifier(Modifier::DIM) } else { bg.fg(theme::paint(c)) };
            lines.push(Line::from(vec![
                Span::styled(format!("{} ", index + 1), tint(theme::accent())),
                Span::styled(format!("{dot} "), tint(color)),
                Span::styled(format!("{mark} "), tint(mark_color)),
                Span::styled(format!("{name}  "), bg.fg(theme::paint(theme_fg)).add_modifier(Modifier::BOLD)),
                Span::styled(detail_text, tint(detail.1)),
                Span::styled(" ".repeat(pad), bg),
                Span::styled(right, tint(theme::MUTED)),
            ]));
        }
    }
    lines.push(Line::raw(""));
    // Typing here is a shell's (as after tmux's C-b c); the rows by number, or the arrows and Enter;
    // the rest on the prefix's keys, as everywhere.
    let hint = |c: &str| app.keymap.hint(c).unwrap_or_default();
    let keys: Vec<(String, &str)> = vec![("1-9".into(), "open"), ("↑↓ enter".into(), "choose"), ("type".into(), "a shell here"), (hint("new-terminal"), "new terminal"), (hint("choose-tree -Zs"), "harnesses"), (hint("new-harness"), "new agent"), (hint("choose-tree -a"), "waiting"), (hint("choose-tree -m"), "machines")];
    let keys: Vec<(String, &str)> = keys.into_iter().filter(|(k, _)| !k.is_empty()).collect();
    let mut row: Vec<Span> = Vec::new();
    let mut row_w = 0;
    for (k, w) in keys {
        let piece_w = k.width() + w.width() + 4;
        if row_w + piece_w > width as usize { lines.push(Line::from(std::mem::take(&mut row))); row_w = 0 }
        row.push(Span::styled(k.clone(), bold(theme::accent())));
        row.push(Span::styled(format!(" {w}   "), fg(theme::SOFT)));
        row_w += piece_w;
    }
    if !row.is_empty() { lines.push(Line::from(row)) }
    lines.push(Line::raw(""));
    let prefix = crate::keys::name(&app.keymap.prefix);
    let (key, description) = if app.os_session { ("Super+B".into(), " browser · Super+Enter terminal") }
        else { (format!("{prefix} d"), " detach — everything keeps running") };
    lines.push(Line::from(vec![Span::styled(format!("{prefix} ?"), bold(theme::accent())), Span::styled(" every key   ", fg(theme::SOFT)), Span::styled(key, bold(theme::accent())), Span::styled(description, fg(theme::SOFT))]));
    let top = area.y + area.height.saturating_sub(lines.len() as u16) / 2;
    for (index, line) in lines.iter().enumerate() {
        let y = top + index as u16;
        if y >= area.y + area.height { break }
        let w = line.width() as u16;
        let x = if index < centered { area.x + area.width.saturating_sub(w) / 2 } else { left };
        buf.set_line(x, y, line, area.width.saturating_sub(x - area.x));
    }
    themed_home(buf, area);
}

fn os_welcome(buf: &mut Buffer, app: &App, area: Rect) {
    let mut lines = Vec::new();
    if area.height >= 24 {
        for word in WORDMARK { lines.push(Line::styled(word, fg(theme::accent()))) }
    } else { lines.push(Line::styled("harness", bold(theme::accent()))) }
    lines.push(Line::raw(""));
    let centered = lines.len();
    let actions = if app.os_live { vec![("Enter", "Install Harness"), ("T", "Try without installing")] }
        else { vec![("Enter", "Start OpenCode"), ("T", "New terminal"), ("W", "Connect to Wi-Fi")] };
    for (key, action) in actions {
        lines.push(Line::from(vec![Span::styled(format!("{key:7}"), bold(theme::accent())), Span::styled(action, bold(theme::TEXT))]));
        lines.push(Line::raw(""));
    }
    lines.push(Line::raw(""));
    let prefix = crate::keys::name(&app.keymap.prefix);
    lines.push(Line::styled(format!("{prefix} T terminal · {prefix} W Wi-Fi · Super+B browser"), fg(theme::MUTED)));
    if app.os_live { lines.push(Line::styled(format!("Inside a session: {prefix} I install"), fg(theme::MUTED))) }
    let width = area.width.saturating_sub(4).min(58);
    let left = area.x + area.width.saturating_sub(width) / 2;
    let top = area.y + area.height.saturating_sub(lines.len() as u16) / 2;
    for (index, line) in lines.iter().enumerate() {
        let y = top + index as u16;
        if y >= area.y + area.height { break }
        let x = if index < centered { area.x + area.width.saturating_sub(line.width() as u16) / 2 } else { left };
        buf.set_line(x, y, line, area.width.saturating_sub(x - area.x));
    }
}

#[cfg(test)]
mod os_welcome_tests {
    use super::*;

    #[test]
    fn usb_prioritizes_install_and_installed_home_never_offers_it() {
        for (width, height) in [(80, 24), (60, 18), (120, 40)] {
            let (sink, _) = tokio::sync::mpsc::unbounded_channel();
            let mut app = App::new(19789, sink, (width, height));
            app.handed_over = true;
            app.os_session = true;
            for live in [true, false] {
                app.os_live = live;
                let area = Rect::new(0, 0, width, height);
                let mut buf = Buffer::empty(area);
                empty_window(&mut buf, &app, area);
                let text = (0..height).map(|y| (0..width).map(|x| buf[(x, y)].symbol()).collect::<String>()).collect::<Vec<_>>().join("\n");
                if live {
                    assert!(text.contains("Enter  Install Harness"), "{text}");
                    assert!(text.contains("T      Try without installing"), "{text}");
                    assert!(!text.contains("Nothing running"), "{text}");
                } else {
                    assert!(text.contains("Start OpenCode"), "{text}");
                    assert!(text.contains("New terminal"), "{text}");
                    assert!(!text.contains("Install Harness"), "{text}");
                }
            }
        }
    }
}

// ── a theme over the panes ──

fn rgb(c: [u8; 3]) -> Color { Color::Rgb(c[0], c[1], c[2]) }

/// The theme chosen in Appearance (`@hn-theme`), where one is and colour is on.
fn chosen_theme(app: &App) -> Option<&'static crate::terminal_themes::TerminalTheme> {
    if theme::no_color() { return None }
    let name = app.options.get("@hn-theme", "", None).filter(|n| !n.is_empty())?;
    crate::terminal_themes::TERMINAL_THEMES.iter().find(|t| t.name == name)
}

/// The sixteen colours a program names (red, bright green…), in [area], as [t] has them — what a
/// terminal with that theme would show. Colours a program gives exactly (256-colour, RGB) stay.
fn theme_ansi(buf: &mut Buffer, area: Rect, t: &crate::terminal_themes::TerminalTheme) {
    let ansi = |c: Color| -> Color {
        let i = match c {
            Color::Black => 0, Color::Red => 1, Color::Green => 2, Color::Yellow => 3, Color::Blue => 4, Color::Magenta => 5, Color::Cyan => 6, Color::Gray => 7,
            Color::DarkGray => 8, Color::LightRed => 9, Color::LightGreen => 10, Color::LightYellow => 11, Color::LightBlue => 12, Color::LightMagenta => 13, Color::LightCyan => 14, Color::White => 15,
            Color::Indexed(i) if i < 16 => i as usize,
            other => return other,
        };
        theme::depth_fit(rgb(t.palette[i]))
    };
    for y in area.y..area.bottom() { for x in area.x..area.right() {
        if let Some(c) = buf.cell_mut((x, y)) { c.fg = ansi(c.fg); c.bg = ansi(c.bg); }
    } }
}

/// With a theme chosen (Settings → Theme), the home screen stands on the theme's background where
/// the terminal's showed — as the panes the daemon paints and the status line already do. (Its
/// text is the theme's already: `fg` dims the theme's own foreground.) Without one, as the
/// terminal has it.
fn themed_home(buf: &mut Buffer, area: Rect) {
    if !crate::term_out::theme_chosen() || theme::no_color() { return }
    // The theme's own background (a pane's surface is lifted off it).
    let (bg, fg, _) = theme::palette();
    for y in area.y..area.bottom() {
        for x in area.x..area.right() {
            let Some(c) = buf.cell_mut((x, y)) else { continue };
            if matches!(c.bg, Color::Reset) { c.bg = theme::depth_fit(bg) }
            if matches!(c.fg, Color::Reset) { c.fg = theme::depth_fit(fg) }
        }
    }
}


// ── the status line ──────────────────────────────────────────────────────────

/// tmux's status line — or, while there is one, the prompt, question or message that takes it.
fn status_line(buf: &mut Buffer, app: &mut App, rect: Rect) -> Option<Position> {
    crate::term_out::clear_extras(rect);
    // A message replaces only message-line, leaving all other status-format rows visible.
    status_formats(buf, app, rect);
    let line = app.options.get("message-line", "", None).and_then(|n| n.parse::<u16>().ok()).unwrap_or(0).min(rect.height.saturating_sub(1));
    let rect = Rect::new(rect.x, rect.y + line, rect.width, 1);
    // Messages inherit the configured status message colors.
    let yellow = app.message_style();
    // (A prompt's completion menu keeps the prompt on the status line under it.)
    let under_menu = match &app.modal { Some(Modal::Menu(m)) => m.complete.as_ref().map(|c| &c.prompt), _ => None };
    let prompt_like: Option<(String, String, usize, String, bool)> = match (&app.modal, under_menu) {
        (_, Some(p)) | (Some(Modal::Prompt(p)), _) => {
            let shown: String = if p.secret { "*".repeat(p.value.chars().count()) } else { p.value.clone() };
            Some((p.label.clone(), shown, p.cursor, p.hint.clone(), p.vi_normal))
        }
        (Some(Modal::Confirm { prompt, .. }), _) => Some((format!("{prompt} "), String::new(), 0, String::new(), false)),
        _ => None,
    };
    if let Some((mut label, value, cursor, hint, command_mode)) = prompt_like {
        app.status_ranges.retain(|(row, _)| *row != line);
        // status_prompt_redraw: the line in message-style (message-command-style in vi's command
        // mode), the prompt, then the text with the cursor's cell reversed — a reversed blank
        // after it at the end; scrolled to keep the cursor in view. The terminal's own cursor is
        // hidden, as tmux hides it.
        if !label.ends_with(' ') && label != ":" { label.push(' ') }
        let gc = if command_mode { app.style_of("message-command-style", app.active, None) } else { yellow };
        let cursorgc = if gc.add_modifier.contains(Modifier::REVERSED) { gc.remove_modifier(Modifier::REVERSED) } else { gc.add_modifier(Modifier::REVERSED) };
        for x in rect.x..rect.x + rect.width { if let Some(c) = buf.cell_mut((x, rect.y)) { c.reset(); c.set_symbol(" "); c.set_style(gc); } }
        let sx = rect.width as usize;
        let start = label.width().min(sx);
        for (i, cell) in crate::draw::format_draw_over(&label, gc, start as u16).into_iter().enumerate() {
            if let Some((ch, st)) = cell { if let Some(c) = buf.cell_mut((rect.x + i as u16, rect.y)) { c.set_symbol(if ch.is_empty() { " " } else { &ch }); c.set_style(st); } }
        }
        let left = sx - start;
        if left > 0 {
            let chars: Vec<char> = value.chars().collect();
            let w = |c: &char| unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0);
            let pcursor: usize = chars.iter().take(cursor).map(w).sum();
            let mut pwidth: usize = chars.iter().map(w).sum();
            let offset = if pcursor >= left { pwidth = left; pcursor - left + 1 } else { 0 };
            if pwidth > left { pwidth = left }
            let (mut width, mut x, mut i) = (0usize, rect.x + start as u16, 0usize);
            while i < chars.len() {
                let cw = w(&chars[i]);
                if width < offset { width += cw; i += 1; continue }
                if width >= offset + pwidth { break }
                width += cw;
                if width > offset + pwidth { break }
                if let Some(c) = buf.cell_mut((x, rect.y)) { c.set_char(chars[i]); c.set_style(if i != cursor { gc } else { cursorgc }); }
                x += cw as u16;
                i += 1;
            }
            if x < rect.x + rect.width && cursor >= i { if let Some(c) = buf.cell_mut((x, rect.y)) { c.set_symbol(" "); c.set_style(cursorgc); } }
            if !hint.is_empty() {
                let used = label.width() + value.width() + 3;
                if used + hint.width() < sx { buf.set_string(rect.x + rect.width - hint.width() as u16 - 1, rect.y, &hint, gc.add_modifier(Modifier::DIM)); }
            }
        }
        return None;
    }
    if let Some((text, _, at)) = &app.toast {
        if at.elapsed() < Duration::from_millis(app.toast_ms()) {
            app.status_ranges.retain(|(row, _)| *row != line);
            for x in rect.x..rect.right() { if let Some(cell) = buf.cell_mut((x, rect.y)) { cell.reset(); cell.set_symbol(" "); cell.set_style(yellow); } }
            // Cut at the edge, as tmux's (no … in the last cell).
            buf.set_stringn(rect.x, rect.y, text, rect.width as usize, yellow);
            return None;
        }
    }
    None
}

fn status_formats(buf: &mut Buffer, app: &mut App, rect: Rect) {
    let base = app.status_style();
    buf.set_style(rect, base);
    // Each line is its status-format, expanded and drawn as tmux's format_draw draws it: the
    // left, the window list (cut around the current window, `<` `>` where it was cut) and the
    // right; the windows' ranges are where a click selects them.
    app.status_ranges.clear();
    let tab_id = app.tab().id.clone();
    for row in 0..rect.height {
        let Some(fmt) = app.options.get(&format!("status-format[{row}]"), &tab_id, None) else { continue };
        let expanded = crate::format::expand(app, &fmt, app.active, app.focused(), true);
        let (cells, ranges) = crate::draw::format_draw(&expanded, base, rect.width);
        for (x, (ch, st)) in cells.iter().enumerate() {
            if let Some(cell) = buf.cell_mut((rect.x + x as u16, rect.y + row)) {
                if !ch.is_empty() { cell.set_symbol(ch); } else { cell.set_symbol(""); }
                cell.set_style(*st);
            }
        }
        for mut r in ranges { r.start += rect.x; r.end += rect.x; app.status_ranges.push((row, r)) }
    }
}



/// "%H:%M" and "%d-%b-%y" in local time, without a date crate.
fn local_time(offset: i64) -> (String, String) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) + offset;
    let (days, secs) = (now.div_euclid(86_400), now.rem_euclid(86_400));
    // Civil date from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    (format!("{:02}:{:02}", secs / 3600, (secs / 60) % 60), format!("{:02}-{}-{:02}", d, MONTHS[(m - 1) as usize], y % 100))
}

// ── fzf ──────────────────────────────────────────────────────────────────────

/// Where a list is drawn (fzf's adjustMarginAndPadding and resizeWindows): the screen it has — the
/// window, or with --height its bottom rows, as fzf takes the rows under a prompt at the bottom of
/// a terminal (the panes stay in view above) — the outer --border's box, and the area inside the
/// margin, the border and the padding, where the list and its preview go.
pub struct FzfFrame { pub screen: Rect, pub border: Option<Rect>, pub inner: Rect, pub padded: Rect }

/// The --border shape's sides (top, right, bottom, left); none without one.
fn border_sides() -> (bool, bool, bool, bool) {
    match theme::fzf_opts().border.as_deref() {
        None | Some("none") | Some("line") => (false, false, false, false),
        Some("horizontal") => (true, false, true, false), Some("vertical") => (false, true, false, true),
        Some("top") => (true, false, false, false), Some("right") => (false, true, false, false),
        Some("bottom") => (false, false, true, false), Some("left") => (false, false, false, true),
        _ => (true, true, true, true),
    }
}

/// fzf's noSeparatorLine: no line for the separator (--info=inline, or hidden and inline-right
/// with --no-separator).
fn no_separator_line() -> bool {
    let o = theme::fzf_opts();
    if o.no_input { return true }
    match o.info_mode.as_str() { "inline" => true, "hidden" | "inline-right" => !separator_on(), _ => false }
}

/// Whether the separator's rule shows: --separator's (or --no-separator's) say, else yes — unless
/// an input border is set (fzf leaves the rule out inside one).
fn separator_on() -> bool {
    let o = theme::fzf_opts();
    if o.separator_set || !o.separator { o.separator } else { section_shape(&o.input_border, false).is_none() }
}

/// fzf's --height over a screen [h] rows tall: at least its minimum, no more than the screen
/// (maxHeightFunc); with `~` no more than its items and the lines around them need (Loop's fit).
fn fzf_rows(h: u16, height: theme::Height, picker: &Picker) -> u16 {
    let o = theme::fzf_opts();
    let term = h as i64;
    let border_lines = |(t, _, b, _): (bool, bool, bool, bool)| t as i64 + b as i64;
    // --min-height's automatic value (10 and what surrounds the list) for a height in percent.
    let mut min_height = o.min_height;
    if height.size.percent && min_height < 0 {
        min_height = -min_height + border_lines(border_sides()) + 1 + if no_separator_line() { 0 } else { 1 };
        if !picker.hints.is_empty() || picker.heading.is_some() { min_height += 1 }
        for s in [o.margin[0], o.margin[2], o.padding[0], o.padding[2]] { if !s.percent { min_height += s.size as i64 } }
    }
    let size = height.size.size;
    let evaluated = if height.size.percent {
        ((if height.inverse { 100.0 - size } else { size } * term as f64 / 100.0) as i64).max(min_height)
    } else if height.inverse { term - size as i64 } else { size as i64 };
    let effective_min = 3 - no_separator_line() as i64 + border_lines(border_sides());
    let mut rows = term.min(evaluated.max(effective_min));
    if height.auto {
        // The rows it takes: its items (as many as fit) and the lines around them, and the margins.
        let (_, m, p) = margin_and_padding(Rect::new(0, 0, 1000, rows.max(0) as u16));
        let pad = (m[0] + m[2] + p[0] + p[2]) as i64;
        let extra = 1 + !no_separator_line() as i64 + (!picker.hints.is_empty() || picker.heading.is_some()) as i64;
        let fit = (rows - pad - extra).max(0);
        let items = picker.rows.iter().filter(|r| !r.disabled).count() as i64;
        rows = term.min(items.min(fit) + extra + pad);
    }
    rows.clamp(0, term) as u16
}

/// adjustMarginAndPadding over [screen]: the margins (each with the border's width in it) and the
/// paddings, top, right, bottom, left — both given up, in proportion, where the screen cannot hold
/// them and fzf's smallest list.
fn margin_and_padding(screen: Rect) -> (Rect, [u16; 4], [u16; 4]) {
    let o = theme::fzf_opts();
    let (sw, sh) = (screen.width as i64, screen.height as i64);
    let to_int = |idx: usize, s: theme::Size| -> i64 { if s.percent { ((if idx % 2 == 0 { sh } else { sw }) as f64 * s.size * 0.01) as i64 } else { s.size as i64 } };
    let mut padding = [0i64; 4];
    let mut margin = [0i64; 4];
    let mut extra = [0i64; 4];
    let (t, r, b, l) = border_sides();
    for idx in 0..4 {
        padding[idx] = to_int(idx, o.padding[idx]);
        // A row for a top or bottom side, two columns (the glyph and a blank) for a left or right one.
        extra[idx] = match idx { 0 => t as i64, 1 => 2 * r as i64, 2 => b as i64, _ => 2 * l as i64 };
        margin[idx] = to_int(idx, o.margin[idx]) + extra[idx];
    }
    let mut adjust = |i1: usize, i2: usize, max: i64, min: i64| {
        let min = min.min(max);
        let total = margin[i1] + margin[i2] + padding[i1] + padding[i2];
        if max - total < min {
            let desired = max - min;
            padding[i1] = desired * padding[i1] / total;
            padding[i2] = desired * padding[i2] / total;
            margin[i1] = extra[i1].max(desired * margin[i1] / total);
            margin[i2] = extra[i2].max(desired * margin[i2] / total);
        }
    };
    adjust(1, 3, sw, 4);
    adjust(0, 2, sh, 3 - no_separator_line() as i64);
    let m = margin.map(|v| v.max(0) as u16);
    let p = padding.map(|v| v.max(0) as u16);
    (screen, m, p)
}

pub fn fzf_frame(body: Rect, picker: &Picker) -> FzfFrame {
    let screen = match theme::fzf_opts().height { Some(h) => { let rows = fzf_rows(body.height, h, picker); Rect::new(body.x, body.y + body.height - rows, body.width, rows) } None => body };
    let (_, m, p) = margin_and_padding(screen);
    let width = screen.width.saturating_sub(m[1] + m[3]);
    let height = screen.height.saturating_sub(m[0] + m[2]);
    let (t, r, b, l) = border_sides();
    let border = (t || r || b || l).then(|| {
        let x = screen.x + m[3] - 2 * l as u16;
        let y = screen.y + m[0] - t as u16;
        Rect::new(x, y, width + 2 * l as u16 + 2 * r as u16, height + t as u16 + b as u16)
    });
    let inner = Rect::new(screen.x + m[3] + p[3], screen.y + m[0] + p[0], width.saturating_sub(p[1] + p[3]), height.saturating_sub(p[0] + p[2]));
    // The window inside its margin: its padding is its own, in its colours.
    let padded = Rect::new(screen.x + m[3], screen.y + m[0], width, height);
    FzfFrame { screen, border, inner, padded }
}

/// The outer --border (rounded, sharp, bold, block, thinblock, double, horizontal, vertical, top,
/// bottom, left, right) around [body], in the border colour, and --border-label on it where
/// --border-label-pos puts it (printLabel: centred by default; a column from the left, or from the
/// right when negative; the bottom line with :bottom), cut with the ellipsis when it is too long.
/// fzf's glyphs for a border style (tui.go MakeBorderStyle): top, bottom, left, right, then the
/// corners — ASCII under --no-unicode.
fn border_glyphs(style: &str) -> (&'static str, &'static str, &'static str, &'static str, &'static str, &'static str, &'static str, &'static str) {
    if !theme::fzf().unicode { return ("-", "-", "|", "|", "+", "+", "+", "+") }
    match style {
        "sharp" => ("─", "─", "│", "│", "┌", "┐", "└", "┘"),
        "bold" => ("━", "━", "┃", "┃", "┏", "┓", "┗", "┛"),
        "double" => ("═", "═", "║", "║", "╔", "╗", "╚", "╝"),
        "block" => ("▀", "▄", "▌", "▐", "▛", "▜", "▙", "▟"),
        "thinblock" => ("▔", "▁", "▏", "▕", "🭽", "🭾", "🭼", "🭿"),
        _ => ("─", "─", "│", "│", "╭", "╮", "╰", "╯"),
    }
}

/// fzf's section borders (--list-border, --input-border, --header-border, --footer-border): a
/// shape that shows (`line` shows as a rule on the side toward the list: top, or bottom under
/// --layout=reverse; a list's `line` shows nothing).
fn section_shape(shape: &Option<String>, rule_down: bool) -> Option<String> {
    let s = shape.as_deref()?;
    match s { "none" => None, "line" => Some(if rule_down { "bottom".into() } else { "top".into() }), _ => Some(s.to_string()) }
}

/// fzf's resizeWindows, the sections' half: inside [area] the list's window (its border's box and
/// what is inside it), and the input's (prompt and info), the header's and the footer's windows
/// when they have one — each a box and its inside.
#[derive(Default, Clone, Copy)]
struct Sections { list_box: Option<Rect>, list: Rect, input_box: Option<Rect>, input: Option<Rect>, header_box: Option<Rect>, header: Option<Rect>, footer_box: Option<Rect>, footer: Option<Rect> }

fn sections(area: Rect, has_header: bool, prompt_top: bool, reverse: bool) -> (Sections, [Option<String>; 4]) {
    let o = theme::fzf_opts();
    let layout_reverse = prompt_top;
    let list_shape = o.list_border.as_deref().filter(|s| *s != "none" && *s != "line").map(str::to_string);
    let input_shape = section_shape(&o.input_border, layout_reverse);
    let header_shape = section_shape(&o.header_border, layout_reverse);
    // (fzf's footer border is a rule unless set otherwise.)
    let footer_shape = if o.footer.is_empty() { None } else { match o.footer_border.as_deref() { Some("line") | None => Some(if layout_reverse { "top".to_string() } else { "bottom".to_string() }), Some("none") => None, Some(s) => Some(s.to_string()) } };
    let lines = |s: &Option<String>| s.as_deref().map(|s| { let (t, _, b, _) = shape_sides(s); t as i64 + b as i64 }).unwrap_or(0);
    let has_header_window = has_header && (header_shape.is_some() || input_shape.is_some());
    let has_input_window = !o.no_input && (input_shape.is_some() || has_header_window);
    let input_window_h = if no_separator_line() { 1 } else { 2 };
    let mut avail = area.height as i64;
    let input_h = if has_input_window { (lines(&input_shape) + input_window_h).clamp(0, avail) } else { 0 };
    avail -= input_h;
    let header_h = if has_header_window { (lines(&header_shape) + 1).clamp(0, avail) } else { 0 };
    avail -= header_h;
    let footer_h = if o.footer.is_empty() { 0 } else { (lines(&footer_shape) + o.footer.len() as i64).clamp(0, avail) };
    let shrink = input_h + header_h + footer_h;
    let shift = if layout_reverse { input_h + header_h } else { footer_h };
    let rect = |x: i64, y: i64, w: i64, h: i64| Rect::new(x.max(0) as u16, y.max(0) as u16, w.max(0) as u16, h.max(0) as u16);
    let (ax, ay, aw) = (area.x as i64, area.y as i64, area.width as i64);
    // The list's window: its border's box, what is inside.
    let whole = rect(ax, ay + shift, aw, area.height as i64 - shrink);
    let mut sec = Sections { list: whole, ..Default::default() };
    if let Some(shape) = &list_shape {
        let (t, r, b, l) = shape_sides(shape);
        sec.list_box = Some(whole);
        sec.list = rect(ax + if l { 2 } else { 0 }, whole.y as i64 + t as i64, aw - if l { 2 } else { 0 } - r as i64, whole.height as i64 - t as i64 - b as i64);
    }
    let w = sec.list_box.unwrap_or(sec.list);
    let (wt, wh) = (w.y as i64, w.height as i64);
    // createInnerWindow: a box's inside (no wider than the list's).
    let inner = |b: Rect, shape: &Option<String>, shift: i64| {
        let (t, r, bo, l) = shape.as_deref().map(shape_sides).unwrap_or((false, false, false, false));
        let cols = if l { 2 } else { 0 } + if r { 2 } else { 0 };
        let indent = (if list_shape.as_deref().is_some_and(|s| shape_sides(s).3) { 2i64 } else { 0 }).saturating_sub(if l { 2 } else { 0 }).max(0);
        let width = (b.width as i64 - cols - shift + r as i64).min(sec.list.width as i64 + indent);
        rect(b.x as i64 + shift + if l { 2 } else { 0 }, b.y as i64 + t as i64, width, b.height as i64 - t as i64 - bo as i64)
    };
    let header_first = o.header_first;
    if has_input_window {
        let btop = match (header_first && has_header_window, layout_reverse, reverse) {
            (true, false, _) => wt + wh,
            (true, true, _) => wt - input_h,
            (false, true, _) => wt - shrink + footer_h,
            (false, false, _) => wt + wh + header_h,
        };
        let b = rect(w.x as i64, btop, w.width as i64, input_h);
        let (_, _, _, il) = input_shape.as_deref().map(shape_sides).unwrap_or((false, false, false, false));
        let lshift = if !il && list_shape.as_deref().map(|s| shape_sides(s).3).unwrap_or(false) { 2 } else { 0 };
        sec.input_box = Some(b);
        sec.input = Some(inner(b, &input_shape, lshift));
    }
    if has_header_window {
        let btop = match (header_first && has_input_window, layout_reverse) {
            (true, true) => wt - shrink + footer_h,
            (true, false) => wt + wh + input_h,
            (false, true) => wt - header_h,
            (false, false) => wt + wh,
        };
        let b = rect(w.x as i64, btop, w.width as i64, header_h);
        sec.header_box = Some(b);
        sec.header = Some(inner(b, &header_shape, 0));
    }
    if footer_h > 0 {
        let btop = if layout_reverse { wt + wh } else { wt - footer_h };
        let b = rect(w.x as i64, btop, w.width as i64, footer_h);
        sec.footer_box = Some(b);
        sec.footer = Some(inner(b, &footer_shape, 0));
    }
    (sec, [list_shape, input_shape, header_shape, footer_shape])
}

/// --info-command's output (its first line, ANSI colours retained), run again only when what it is
/// given changes.
fn info_command(cmd: &str, info: &str, picker: &Picker, total: usize, area: Rect) -> String {
    let query = &picker.query;
    let matched = picker.matched_rows.len();
    thread_local! { static LAST: std::cell::RefCell<Option<(String, String)>> = const { std::cell::RefCell::new(None) }; }
    let key = format!("{cmd}\0{info}\0{query}\0{matched}\0{total}\0{:?}\0{:?}", picker.opened, (area, picker.cursor, theme::fzf_opts().raw, &theme::fzf().prompt_text));
    if let Some(out) = LAST.with(|l| l.borrow().as_ref().filter(|(k, _)| *k == key).map(|(_, o)| o.clone())) { return out }
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "sh".into());
    let mut command = std::process::Command::new(shell);
    if theme::fzf_opts().raw { command.env("FZF_RAW", if picker.is_match(picker.cursor) { "1" } else { "0" }); } else { command.env_remove("FZF_RAW"); }
    let out = command.arg("-c").arg(cmd)
        .env("FZF_INFO", info).env("FZF_QUERY", query).env("FZF_MATCH_COUNT", matched.to_string()).env("FZF_TOTAL_COUNT", total.to_string())
        .env("FZF_SELECT_COUNT", picker.marked.len().to_string()).env("FZF_POS", (picker.cursor + 1).min(picker.visible.len()).to_string())
        .env("FZF_LINES", area.height.to_string()).env("FZF_COLUMNS", area.width.to_string())
        .env("FZF_PROMPT", &theme::fzf().prompt_text).env("FZF_INPUT_STATE", if theme::fzf_opts().no_input { "hidden" } else { "enabled" })
        .stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").to_string()).unwrap_or_default();
    LAST.with(|l| *l.borrow_mut() = Some((key, out.clone())));
    out
}

/// [text] with its SGR codes read, at (x, y): each part in its own colours over [base] (fzf's
/// ansiToColorPair), no wider than [max].
fn put_ansi(buf: &mut Buffer, x: u16, y: u16, text: &str, base: Style, max: usize) -> usize {
    let line = crate::preview::ansi_line(text, 8);
    let mut used = 0usize;
    for sp in &line.spans {
        if used >= max { break }
        let st = if sp.style == Style::default() { base } else { base.patch(sp.style) };
        let (end, _) = buf.set_stringn(x + used as u16, y, sp.content.as_ref(), max - used, st);
        used = end.saturating_sub(x) as usize;
    }
    used
}

/// headerIndentImpl: a header's (or footer's) indent in a window of its own — the rows' gutter,
/// and the list box's left side, less its own box's.
fn section_indent(list: &Option<String>, own: &Option<String>) -> u16 {
    let left = |s: &Option<String>| s.as_deref().map(|s| shape_sides(s).3).unwrap_or(false);
    (gutter_width() + if left(list) { 2 } else { 0 }).saturating_sub(if left(own) { 2 } else { 0 })
}

/// A section's box (LightWindow.drawBorder): its shape's sides in the pair, the column inside a
/// left side in it too; its label on the top (or bottom) edge, centred.
fn section_box(buf: &mut Buffer, b: Rect, shape: &str, st: Style, label: &str, label_style: Style, label_pos: (i64, bool)) {
    if b.width < 2 || b.height == 0 { return }
    let (top_c, bottom_c, left_c, right_c, tl, tr, bl, br) = border_glyphs(shape);
    let (top, right, bottom, left) = shape_sides(shape);
    let (x1, y1) = (b.x + b.width - 1, b.y + b.height - 1);
    if top { for x in b.x..=x1 { buf.set_string(x, b.y, top_c, st) } }
    if bottom { for x in b.x..=x1 { buf.set_string(x, y1, bottom_c, st) } }
    let (y0, yn) = (b.y + top as u16, y1.saturating_sub(bottom as u16));
    if left { for y in b.y..=y1 { buf.set_string(b.x, y, left_c, st) } if y0 <= yn { for y in y0..=yn { buf.set_string(b.x + 1, y, " ", st) } } }
    if right { for y in b.y..=y1 { buf.set_string(x1, y, right_c, st) } }
    if top && left { buf.set_string(b.x, b.y, tl, st) }
    if top && right { buf.set_string(x1, b.y, tr, st) }
    if bottom && left { buf.set_string(b.x, y1, bl, st) }
    if bottom && right { buf.set_string(x1, y1, br, st) }
    if label.is_empty() || !(top || bottom) { return }
    let (w, len) = (b.width as i64, theme::strip_ansi(label).width() as i64);
    let (column, at_bottom) = label_pos;
    let col = match column { 0 => (w - len) / 2, n if n < 0 => w + n + 1 - len, n => (n - 1).min(w - len) }.max(0) as u16;
    let row = if at_bottom || !top { y1 } else { b.y };
    put_ansi(buf, b.x + col, row, label, label_style, b.width.saturating_sub(col) as usize);
}

fn fzf_border(buf: &mut Buffer, body: Rect) {
    let Some(style) = theme::fzf_opts().border.clone() else { return };
    let st = theme::fzf().border_style();
    let (top_c, bottom_c, left_c, right_c, tl, tr, bl, br) = border_glyphs(&style);
    let (top, bottom, left, right) = match style.as_str() { "none" => (false, false, false, false), "horizontal" => (true, true, false, false), "vertical" => (false, false, true, true), "top" => (true, false, false, false), "bottom" => (false, true, false, false), "left" => (false, false, true, false), "right" => (false, false, false, true), _ => (true, true, true, true) };
    if body.width < 2 || body.height < 2 { return }
    let (x1, y1) = (body.x + body.width - 1, body.y + body.height - 1);
    if top { for x in body.x..=x1 { buf.set_string(x, body.y, top_c, st) } }
    if bottom { for x in body.x..=x1 { buf.set_string(x, y1, bottom_c, st) } }
    // A side's glyph and the column of margin inside it, both in the border's pair (the corners'
    // rows have no margin).
    let (y0, yn) = if top || bottom { (body.y + top as u16, y1 - bottom as u16) } else { (body.y, y1) };
    if left { for y in body.y..=y1 { buf.set_string(body.x, y, left_c, st) } for y in y0..=yn { buf.set_string(body.x + 1, y, " ", st) } }
    // The right side's glyph only: the column inside it is the window's (default colours), where
    // the left one's is the border's (LightWindow.drawBorder).
    if right { for y in body.y..=y1 { buf.set_string(x1, y, right_c, st) } for y in y0..=yn { buf.set_string(x1 - 1, y, " ", st.fg(Color::Reset)) } }
    if top && left { buf.set_string(body.x, body.y, tl, st) }
    if top && right { buf.set_string(x1, body.y, tr, st) }
    if bottom && left { buf.set_string(body.x, y1, bl, st) }
    if bottom && right { buf.set_string(x1, y1, br, st) }
    let o = theme::fzf_opts();
    // (Measured without its colour codes; drawn with them when it fits whole.)
    let plain = theme::strip_ansi(&o.border_label);
    if plain.is_empty() || !(top || bottom) { return }
    let w = body.width as i64;
    let len = plain.width() as i64;
    let (column, at_bottom) = o.border_label_pos;
    let col = if column == 0 { ((w - len) / 2).max(0) } else if column < 0 { (w + column + 1 - len).max(0) } else { (column - 1).min(w - len) };
    let row = if style == "bottom" || at_bottom { y1 } else { body.y };
    // ansiLabelPrinter: the whole label when it fits, else as much as fits and the ellipsis.
    let text = if len > w {
        let ell: String = { let mut used = 0; o.ellipsis.chars().take_while(|c| { used += unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0) as i64; used <= w }).collect() };
        trim_right(&plain, (w - ell.width() as i64) as i32) + &ell
    } else { o.border_label.clone() };
    if col >= 0 { put_ansi(buf, body.x + col as u16, row, &text, theme::fzf().pal.border_label.style(), (w - col).max(0) as usize); }
}

/// The preview's box (its border, its shape) and what is inside it: the text, and the column of
/// its scrollbar.
pub struct PreviewBox { pub rect: Rect, pub shape: String, pub inner: Rect, pub bar_x: u16, pub opts: theme::PreviewWindow }

/// A list's preview inside the settings panel: the same preview fzf's window shows (a harness's
/// live screen, a machine's notes…), without a box, on the panel's own surface.
fn panel_preview(buf: &mut Buffer, app: &App, kind: &PickerKind, picker: &Picker, rect: Rect) {
    let opts = picker.preview_window.clone().unwrap_or_else(|| theme::fzf_opts().preview_window.clone());
    let inner = Rect::new(rect.x, rect.y, rect.width.saturating_sub(1), rect.height);
    let pb = PreviewBox { rect, shape: "none".into(), inner, bar_x: rect.right().saturating_sub(1), opts };
    preview(buf, app, kind, picker, &pb);
    // What the preview left in the terminal's colours takes the panel's; its scrollbar's column
    // is left blank (the panel draws no scrollbars: the wheel and the keys scroll it).
    let base = crate::settings::chrome().base;
    picker.preview_bar.set(None);
    for y in rect.y..rect.bottom() { if let Some(c) = buf.cell_mut((pb.bar_x, y)) { c.set_symbol(" ").set_style(base); } }
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            if let Some(c) = buf.cell_mut((x, y)) {
                if matches!(c.bg, Color::Reset) { c.bg = base.bg.unwrap_or(Color::Reset) }
                if matches!(c.fg, Color::Reset) { c.fg = base.fg.unwrap_or(Color::Reset) }
            }
        }
    }
}

/// A border shape's sides: top, right, bottom, left.
fn shape_sides(shape: &str) -> (bool, bool, bool, bool) {
    match shape {
        "none" | "line" => (false, false, false, false),
        "horizontal" => (true, false, true, false), "vertical" => (false, true, false, true),
        "top" => (true, false, false, false), "right" => (false, true, false, false),
        "bottom" => (false, false, true, false), "left" => (false, false, false, true),
        _ => (true, true, true, true),
    }
}

/// fzf's calculateSize: a size (cells, or a percentage of [base]) kept to at least [min] and to what
/// [occupied] leaves.
fn calculate_size(base: i64, size: theme::Size, occupied: i64, min: i64) -> i64 {
    let max = (base - occupied).max(min);
    let v = if size.percent { (base as f64 * 0.01 * size.size) as i64 } else { size.size as i64 + min - 1 };
    v.clamp(min, max)
}

/// resizeWindows, the preview's half: the list's window and the preview's box inside [inner] —
/// right, left, up or down, its size, its border, the alternative under its threshold, none when
/// hidden or the list has none; with the outer border on the right and nothing of the preview's
/// there, the list (and the preview) take back the border's column of padding (listStickToRight).
/// The third value: whether that column is the list's (else it is left blank).
/// Whether the list sorts by score (--no-sort, turned over by toggle-sort).
fn o_sorts(picker: &Picker) -> bool { theme::fzf_opts().no_sort == picker.sort_flipped }

fn fzf_split(inner: Rect, picker: &Picker) -> (Rect, Option<PreviewBox>, bool) {
    let o = theme::fzf_opts();
    let (_, outer_right, _, _) = border_sides();
    // listStickToRight: only when no inner box (the list's, the input's, a shown header's) has a
    // right side of its own — one that does keeps a blank column before the outer border.
    let right = |s: &Option<String>| s.as_deref().map(|s| shape_sides(s).1).unwrap_or(false);
    let header_shown = picker.header_text.as_deref().map(|h| !h.is_empty()).unwrap_or(!picker.hints.is_empty() || picker.heading.is_some());
    let outer_right = outer_right && !right(&o.list_border) && !right(&o.input_border) && !(header_shown && right(&o.header_border));
    let (x, y) = (inner.x as i64, inner.y as i64);
    let (width, height) = (inner.width as i64, inner.height as i64);
    let rect = |x: i64, y: i64, w: i64, h: i64| Rect::new(x.max(0) as u16, y.max(0) as u16, w.max(0) as u16, h.max(0) as u16);
    let alone = |stick: bool| (rect(x, y, width + stick as i64, height), None, stick);
    if !picker.preview { return alone(outer_right) }
    let mut pw = picker.preview_window.as_ref().unwrap_or(&o.preview_window);
    picker.preview_alt.set(false);
    loop {
        let shape = pw.shape().to_string();
        let (bt, br, bb, bl) = shape_sides(&shape);
        let bar = o.preview_scrollbar.is_some();
        let min_w = 1 + 2 * (bl as i64 + br as i64) + (matches!(pw.position, 'l' | 'r') && bar && !br) as i64;
        let min_h = 1 + bt as i64 + bb as i64;
        let (list, pbox, stick) = match pw.position {
            'u' | 'd' => {
                // Its border dragged: the rows it was given, its border's included.
                let ph = match picker.preview_cells { Some(n) => n.clamp(min_h, (height - (3 - no_separator_line() as i64)).max(min_h)), None => calculate_size(height, pw.size, 3 - no_separator_line() as i64, min_h) };
                if pw.threshold > 0 && ph < pw.threshold as i64 { if let Some(alt) = &pw.alternative { picker.preview_alt.set(true); if alt.hidden { return alone(outer_right) } pw = alt; continue } }
                if pw.hidden { return alone(outer_right) }
                let stick = outer_right && !br;
                let w = width + stick as i64;
                let available = height - (2 - no_separator_line() as i64) - min_h;
                let ph = ph.min(available).max(min_h);
                if pw.position == 'u' { (rect(x, y + ph, w, height - ph), rect(x, y, w, ph), stick) }
                else { (rect(x, y, w, height - ph), rect(x, y + height - ph, w, ph), stick) }
            }
            _ => {
                let pwidth = match picker.preview_cells { Some(n) => n.clamp(min_w, (width - 4).max(min_w)), None => calculate_size(width, pw.size, 4, min_w) };
                if pw.threshold > 0 && pwidth < pw.threshold as i64 { if let Some(alt) = &pw.alternative { picker.preview_alt.set(true); if alt.hidden { return alone(outer_right) } pw = alt; continue } }
                if pw.hidden { return alone(outer_right) }
                if pw.position == 'l' {
                    // A column between the preview and the list; the list against the outer border.
                    let inner_w = width + outer_right as i64;
                    (rect(x + pwidth + 1, y, inner_w - pwidth - 1, height), rect(x, y, pwidth, height), outer_right)
                } else {
                    let stick = outer_right && !br;
                    let w = width + stick as i64;
                    (rect(x, y, w - pwidth, height), rect(x + w - pwidth, y, pwidth, height), stick)
                }
            }
        };
        // createPreviewWindow: inside the border's sides (a side and its margin), a column for the
        // scrollbar where the border has no right side.
        let (px, py) = (pbox.x as i64 + 2 * bl as i64, pbox.y as i64 + bt as i64);
        let pw_w = pbox.width as i64 - 2 * (bl as i64 + br as i64) - (bar && !br) as i64;
        let ph_h = pbox.height as i64 - bt as i64 - bb as i64;
        let bar_x = (pbox.x + pbox.width).saturating_sub(if br { 2 } else { 1 });
        return (list, Some(PreviewBox { rect: pbox, shape, inner: rect(px, py, pw_w, ph_h), bar_x, opts: pw.clone() }), stick);
    }
}

/// fzf 0.67's default layout, measured: rows bottom-up (best nearest the prompt), `▌` gutter
/// (236; the current row's in 161 on 236), matches in 108 (151 on the current row), the info line
/// `  4/7 ───` (144, separator 59), the prompt `> ` (110). Returns where the cursor goes.
fn fzf(buf: &mut Buffer, body: Rect, picker: &mut Picker, kind: &PickerKind, search_busy: bool, msg_style: Style) -> Position {
    let frame = fzf_frame(body, picker);
    crate::term_out::clear_extras(frame.screen);
    picker.screen_area.set(frame.screen);
    // (A --height list is drawn over the panes: its rows are its own.)
    for y in frame.screen.y..frame.screen.y + frame.screen.height {
        for x in frame.screen.x..frame.screen.x + frame.screen.width { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } }
    }
    if let Some(b) = frame.border { fzf_border(buf, b) }
    let body = frame.inner;
    // --color=bg: under everything (the preview and the padding too); list-bg: under the list alone.
    let pal = theme::fzf().pal;
    if let Some(bg) = pal.border.style().bg { buf.set_style(frame.padded, Style::default().bg(bg)) }
    let (area, pbox, stick) = fzf_split(body, picker);
    picker.list_area.set(area);
    picker.preview_area.set(pbox.as_ref().map(|p| (p.rect, p.opts.position)));
    let (_, right_border, _, _) = border_sides();
    if right_border {
        // The outer border's margin on the right: the list's column now (listStickToRight), blank
        // until it draws there, or cleared between the border and a preview with a side of its own.
        // (Cleared, it is the border window's: its colour on a blank, as fzf's is.)
        // (…right of the padding: the border's own column, the height of the window inside it.)
        if stick {
            let plain = theme::fzfcolor::P { fg: theme::fzfcolor::Col::Default, bg: pal.normal.bg, attr: 0 }.style();
            for y in area.y..area.y + area.height { buf.set_string(body.x + body.width, y, " ", plain) }
        }
        let edge = frame.padded.x + frame.padded.width;
        if !stick || edge != body.x + body.width {
            let plain = theme::fzfcolor::P { fg: pal.border.fg, bg: pal.border.bg, attr: 0 }.style();
            for y in frame.padded.y..frame.padded.y + frame.padded.height { buf.set_string(edge, y, " ", plain) }
        }
    }
    let preview = pbox.as_ref().map(|p| p.rect).filter(|p| p.x > area.x);
    if let Some(bg) = pal.normal.style().bg { buf.set_style(area, Style::default().bg(bg)) }
    let width = area.width as usize;
    // Prompt, then info, then the header (the keys), then the list above — or, with
    // `--layout=reverse` in FZF_DEFAULT_OPTS, all of it top-down.
    let reverse = theme::fzf().reverse;
    let o = theme::fzf_opts();
    // --layout=reverse puts the prompt on top; reverse-list keeps it at the bottom, rows top-down.
    let prompt_top = o.prompt_top;
    // The sections (--list-border, --input-border, --header-border, --footer, --style): their
    // boxes drawn, and from here on the list's window is what is inside its box.
    let has_hdr = area.height >= 3 && header_line(picker, kind, width.saturating_sub(1)).is_some();
    let (sec, shapes) = sections(area, has_hdr, prompt_top, reverse);
    let sectioned = sec.list_box.is_some() || sec.input.is_some() || sec.header.is_some() || sec.footer.is_some();
    if sectioned {
        // Each section's box and label in its own colours (list-border, input-label …).
        if let (Some(b), Some(sh)) = (sec.list_box, &shapes[0]) { section_box(buf, b, sh, pal.list_border.style(), &o.list_label, pal.list_label.style(), o.list_label_pos) }
        if let (Some(b), Some(sh)) = (sec.input_box, &shapes[1]) { section_box(buf, b, sh, pal.input_border.style(), &o.input_label, pal.input_label.style(), o.input_label_pos) }
        if let (Some(b), Some(sh)) = (sec.header_box, &shapes[2]) { section_box(buf, b, sh, pal.header_border.style(), &o.header_label, pal.header_label.style(), o.header_label_pos) }
        if let (Some(b), Some(sh)) = (sec.footer_box, &shapes[3]) { section_box(buf, b, sh, pal.footer_border.style(), &o.footer_label, pal.footer_label.style(), o.footer_label_pos) }
        // The footer's lines indented as the header's (headerIndentImpl), in the footer's colour,
        // their ANSI colours read (fzf reads a footer's even without --ansi).
        let footer_indent = section_indent(&shapes[0], &shapes[3]);
        if let Some(f) = sec.footer { for (i, l) in o.footer.iter().enumerate().take(f.height as usize) { put_ansi(buf, f.x + footer_indent, f.y + i as u16, l, pal.footer.style(), f.width.saturating_sub(footer_indent) as usize); } }
    }
    let area = if sectioned { sec.list } else { area };
    picker.list_area.set(area);
    let width = area.width as usize;
    let bottom = area.y + area.height;
    let in_input = sec.input.filter(|_| sectioned);
    let ia = in_input.unwrap_or(area);
    // --info: default (its own line), inline (after the query), inline-right (right of the
    // prompt, the rule on its own line), right (its own line, the count at the right), hidden.
    let mode = o.info_mode.as_str();
    // (fzf's noSeparatorLine: inline has none; hidden and inline-right keep the rule on a line of
    // its own unless --no-separator.)
    let info_own_line = !no_separator_line();
    let (prompt_y, info_y) = if prompt_top { (area.y, if info_own_line { area.y + 1 } else { area.y }) } else { (bottom - 1, if info_own_line { bottom.saturating_sub(2) } else { bottom - 1 }) };
    // Rows come first in a short window, as in fzf: the key hints go before any row does.
    let header = if area.height >= 3 { header_line(picker, kind, width.saturating_sub(1)) } else { None };
    // --header-first: the header on the prompt's other side — above it with the prompt on top,
    // on the last line below it otherwise.
    let header_first = o.header_first && header.is_some();
    let (prompt_y, info_y) = match (header_first, prompt_top) { (true, true) => (prompt_y + 1, info_y + 1), (true, false) => (prompt_y - 1, info_y - 1), _ => (prompt_y, info_y) };
    let edge = if prompt_top { prompt_y.max(info_y) } else { prompt_y.min(info_y) };
    let header_y = match (header_first, prompt_top) { (true, true) => area.y, (true, false) => bottom - 1, _ => if header.is_some() { if prompt_top { edge + 1 } else { edge.saturating_sub(1) } } else { edge } };
    // In windows of their own: the prompt and info in the input's, the header in the header's.
    let (prompt_y, info_y) = match in_input {
        Some(i) => { let last = i.y + i.height.saturating_sub(1); if prompt_top { (i.y, if info_own_line { i.y + 1 } else { i.y }) } else { (last, if info_own_line { last.saturating_sub(1) } else { last }) } }
        None => (prompt_y, info_y),
    };
    let in_header = sec.header.filter(|_| sectioned);
    let header = match in_header { Some(h) => header_line_at(picker, (h.width as usize).saturating_sub(1), section_indent(&shapes[0], &shapes[2]) as usize), None => header };
    let header_y = in_header.map(|h| h.y).unwrap_or(header_y);
    // --no-input: the prompt and the info are drawn nowhere (the list and the header take their lines).
    let mut scratch = Buffer::empty(buf.area);
    let pbuf: &mut Buffer = if o.no_input { &mut scratch } else { &mut *buf };
    let prompt = theme::fzf().prompt_style();
    let prompt_text = theme::fzf().prompt_text.clone();
    // The prompt in its pair (bold as fzf makes it, unless --no-bold or prompt:regular); its
    // trailing blanks in the pair's colours without the attributes — parsePrompt's AttrClear, laid
    // on the characters at the blanks' byte offsets, as fzf lays it (after `❯` it misses them); a
    // tab out to the next --tabstop.
    // Its SGR codes read (a coloured --prompt, as fzf renders one): each part in its own colours
    // over the prompt's pair, the prompt's attributes kept; tabs to the next --tabstop.
    let pline = crate::preview::ansi_line(&prompt_text, o.tabstop);
    let pchars: Vec<(char, Style)> = pline.spans.iter().flat_map(|sp| sp.content.chars().map(|c| (c, sp.style)).collect::<Vec<_>>()).collect();
    let plain: String = pchars.iter().map(|c| c.0).collect();
    let blank_from = plain.trim_end_matches([' ', '\t', '\n', '\x0c', '\r']).len();
    let blank_from = if blank_from < plain.len() { pchars.iter().rposition(|(_, st)| *st != Style::default()).map(|i| i + 1).unwrap_or(blank_from) } else { blank_from };
    let mut pw = 0u16;
    for (i, (c, own)) in pchars.iter().enumerate() {
        let base = if i >= blank_from && i < plain.len() && *own == Style::default() { theme::fzfcolor::P { attr: 0, ..pal.prompt } } else { pal.prompt };
        let st = theme::fzfcolor::ansi(theme::fzfcolor::own(*own), base, pal.colored).style();
        let w = unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0);
        pbuf.set_string(ia.x + pw, prompt_y, c.to_string(), st);
        pw += w as u16;
    }
    let q_room = (ia.width as usize).saturating_sub(pw as usize + 1).max(1);
    // A query longer than the line (updatePromptOffset): its offset kept between the one that
    // shows the cursor and half the room past it, so moving the cursor moves the cursor, not the
    // text; what is before the cursor, then as much after it as fits.
    let cw = |c: &char| unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0);
    let chars: Vec<char> = picker.query.chars().collect();
    let cx = picker.qcursor.min(chars.len());
    // fzf's trimLeft: how many to drop from the left to fit in [room].
    let trim_left = |runes: &[char], room: usize| -> usize {
        let mut from = runes.len().saturating_sub(room);
        while from < runes.len() && runes[from..].iter().map(cw).sum::<usize>() > room { from += 1 }
        from
    };
    let min_off = trim_left(&chars[..cx], q_room);
    let max_off = min_off + cx.min(q_room) / 2;
    let xoff = picker.xoffset.get().min(max_off).max(min_off);
    picker.xoffset.set(xoff);
    let before_from = xoff + trim_left(&chars[xoff..cx], q_room);
    let before_w: usize = chars[before_from..cx].iter().map(cw).sum();
    let mut after_w = 0;
    let after: Vec<char> = chars[cx..].iter().take_while(|c| { after_w += cw(c); after_w <= q_room - before_w }).cloned().collect();
    let shown: String = chars[before_from..cx].iter().chain(after.iter()).collect();
    pbuf.set_stringn(ia.x + pw, prompt_y, &shown, q_room, pal.input.style());
    let mut typed_w = shown.width().min(q_room) as u16;
    // What an inline count keeps clear of: the query and a margin, or the ghost, as fzf shifts it.
    let mut shift = typed_w as i32 + 1;
    if let Some(ghost) = o.ghost.as_ref().filter(|g| picker.query.is_empty() && !g.is_empty()) {
        // --ghost: yours, cut at the edge as fzf cuts it.
        pbuf.set_stringn(ia.x + pw, prompt_y, ghost, q_room, pal.ghost.style());
        typed_w = ghost.width().min(q_room) as u16;
        shift = typed_w as i32;
    } else if picker.query.is_empty() && !picker.placeholder.is_empty() {
        // The placeholder (fzf's --ghost), whole scopes only, leaving an inline count its place.
        let room = if mode.starts_with("inline") { q_room.saturating_sub(16) } else { q_room };
        let mut text = String::new();
        for part in picker.placeholder.split("   ") { if text.width() + part.width() + 3 > room { break } if !text.is_empty() { text.push_str("   ") } text.push_str(part) }
        pbuf.set_stringn(ia.x + pw, prompt_y, &text, q_room, pal.ghost.style());
        typed_w = text.width() as u16;
        if !text.is_empty() { shift = typed_w as i32 }
    }
    let cursor = Position::new(ia.x + pw + before_w as u16, prompt_y);
    picker.prompt_at.set((prompt_y, ia.x + pw));
    let total = picker.rows.iter().filter(|r| !r.disabled).count();
    let mut count = format!("{}/{}", picker.matched_rows.len(), total);
    // A toggle-sort binding: whether it sorts (+S) or not (-S), as fzf's info says.
    if theme::fzf_opts().binds.iter().any(|(_, a)| a.split('+').any(|x| x == "toggle-sort")) { count.push_str(if o_sorts(picker) { " +S" } else { " -S" }) }
    // --track: +T.
    if picker.tracking_all() { count.push_str(" +T") } else if picker.track_current.is_some() { count.push_str(" +t") }
    // The marks, while the list takes them (change-multi's say, else the list's own).
    let limit = match picker.multi_override { Some(n) if n != usize::MAX => n, Some(_) => 0, None => theme::fzf_opts().multi_limit };
    let takes = picker.multi_override.map(|n| n > 0).unwrap_or(matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) || theme::fzf_opts().multi);
    if !picker.marked.is_empty() || takes { count.push_str(&if limit > 0 { format!(" ({}/{limit})", picker.marked.len()) } else { format!(" ({})", picker.marked.len()) }) }
    // fzf's printInfoImpl, each --info laid out as it lays it out: the count in the info pair, cut
    // with `..` when the room runs out (trimMessage); the separator's line filled with its string
    // (RepeatToFill) after a blank in its pair; the last column left blank. A list still loading
    // spins in the spinner's pair where fzf's does, and gives an info prefix that pair too.
    let (info_style, sep_style, spin_style) = (pal.info.style(), pal.separator.style(), pal.spinner.style());
    let reading = picker.busy.is_some() || matches!(kind, PickerKind::Open { .. }) && search_busy;
    // fzf's makeSpinner (ASCII under --no-unicode).
    const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const ASCII_SPINNER: [&str; 8] = ["-", "\\", "|", "/", "-", "\\", "|", "/"];
    let frames: &[&str] = if theme::fzf().unicode { &SPINNER } else { &ASCII_SPINNER };
    let spinner = frames[if reading { theme::animation_frame() % frames.len() } else { 0 }];
    let w = ia.width as i32;
    let put = |pbuf: &mut Buffer, x: i32, y: u16, s: &str, st: Style| { if x >= 0 && x < w && !s.is_empty() { pbuf.set_stringn(ia.x + x as u16, y, s, (w - x) as usize, st); } };
    let bar = |pbuf: &mut Buffer, x: i32, y: u16, n: i32| {
        if !separator_on() || n <= 0 { return }
        // A separator with ANSI colours: repeated, its colours its own over the separator's.
        if o.separator_char.contains('\x1b') {
            let vw = theme::strip_ansi(&o.separator_char).width().max(1);
            if x >= 0 && x < w { put_ansi(pbuf, ia.x + x as u16, y, &o.separator_char.repeat(n as usize / vw + 1), sep_style, (n.min(w - x)) as usize); }
            return;
        }
        put(pbuf, x, y, &repeat_to_fill(&o.separator_char, n as usize), sep_style)
    };
    // printInfoPrefix: the prefix at [pos] (what fits of it), in the prompt's pair.
    let prefix = |pbuf: &mut Buffer, pos: i32, y: u16| -> i32 {
        let room = w - pos;
        let (text, width) = if o.info_prefix.width() as i32 > room { (trim_right(&o.info_prefix, room), room) } else { (o.info_prefix.clone(), o.info_prefix.width() as i32) };
        put(pbuf, pos, y, &text, if reading { spin_style } else { prompt });
        pos + width
    };
    // --info-command: its output in place of the count (run as fzf runs it: at once, when what it
    // is told changes — $FZF_INFO, the query, the counts).
    let count = match o.info_command.as_deref() { Some(cmd) => info_command(cmd, &count, picker, total, frame.inner), None => count };
    let len = theme::strip_ansi(&count).width() as i32;
    let count_print = |pbuf: &mut Buffer, x: i32, y: u16, max: i32| -> i32 {
        let max = max.max(0) as usize;
        if x < 0 || x >= w || max == 0 { return 0 }
        if o.info_command.is_some() {
            if count.contains(['\x1b', '\t']) { return put_ansi(pbuf, ia.x + x as u16, y, &count, info_style, max) as i32 }
            let output = if count.width() > max { let ell = trim_right(&o.ellipsis, max as i32); trim_right(&count, max as i32 - ell.width() as i32) + &ell } else { count.clone() };
            put(pbuf, x, y, &output, info_style);
            output.width() as i32
        } else {
            let output = trim_message(&count, max as i32);
            put(pbuf, x, y, &output, info_style);
            output.width() as i32
        }
    };
    if w > 1 {
        match mode {
            // Hidden: no count, but the rule keeps its line (only --no-separator takes it away).
            "hidden" => bar(pbuf, 0, info_y, w - 1),
            // `> query  < 3/6 (0) ────`
            "inline" => {
                let pos = prefix(pbuf, pw as i32 + shift, info_y);
                let max = w - pos - 1;
                let printed = count_print(pbuf, pos, info_y, max);
                let (mut x, mut len) = (pos + printed, len);
                if len < max - 1 && reading { put(pbuf, x + 1, info_y, spinner, spin_style); x += 2; len += 2 }
                let fill = max - len - 1;
                if fill > 0 { put(pbuf, x, info_y, " ", sep_style); bar(pbuf, x + 1, info_y, fill) }
            }
            // The count at the right of the prompt line, a column short of the edge (the spinner
            // two before it, or the prefix just before); the rule on a line of its own.
            "inline-right" => {
                let mut pos = pw as i32 + shift;
                if o.info_prefix.is_empty() {
                    pos = pos.max(w - len - 3);
                    if pos < w { if reading { put(pbuf, pos, prompt_y, spinner, spin_style) } pos += 1 }
                    if pos < w - 1 { pos += 1 }
                } else {
                    pos = prefix(pbuf, pos.max(w - len - o.info_prefix.width() as i32 - 1), prompt_y);
                }
                count_print(pbuf, pos, prompt_y, w - pos - 1);
                bar(pbuf, 0, info_y, w - 1);
            }
            // `──────── 3/6 (0) `: the rule from the first column (the spinner after it), the count.
            "right" => {
                let max = w - 1 - if reading { 2 } else { 0 };
                let fill = w - if o.info_command.is_some() { len } else { trim_message(&count, max).len() as i32 } - 2;
                let mut x = 0;
                if reading {
                    if fill >= 2 { bar(pbuf, 0, info_y, fill - 2); x = fill - 1 }
                    put(pbuf, x, info_y, spinner, spin_style);
                    x += 2;
                } else if fill >= 0 { bar(pbuf, 0, info_y, fill); x = fill + 1 }
                count_print(pbuf, x, info_y, if o.info_command.is_some() { max - 1 } else { max });
            }
            // `⠋ 3/6 (0) ────`: the spinner's cell, a margin, the count, a blank, the rule.
            _ => {
                if reading { put(pbuf, 0, info_y, spinner, spin_style) }
                let max = w - 3;
                let printed = count_print(pbuf, 2, info_y, max);
                let fill = max - len - 1;
                if fill > 0 { let x = 2 + printed; put(pbuf, x, info_y, " ", sep_style); bar(pbuf, x + 1, info_y, fill) }
            }
        }
    }
    if let Some(flash) = picker.flash.as_ref().map(|f| f.0.clone()) {
        let text = format!(" {flash} ");
        let fx = (ia.x + ia.width).saturating_sub(text.width() as u16 + 1);
        buf.set_string(fx, info_y, &text, msg_style);
    }
    let header_y = if !o.no_input || in_header.is_some() { header_y } else if prompt_top { area.y } else { bottom.saturating_sub(1) };
    if let Some(h) = &header { let (hx, hw) = in_header.map(|r| (r.x, r.width)).unwrap_or((area.x, area.width)); buf.set_line(hx, header_y, h, hw); }
    // The list: bottom-up (default), or top-down — under the prompt (reverse) or from the top
    // with the prompt below (reverse-list).
    let (list_top, list_bottom) = if o.no_input {
        if prompt_top { (area.y + (header.is_some() && in_header.is_none()) as u16, bottom) } else { (area.y, bottom - (header.is_some() && in_header.is_none()) as u16) }
    } else if in_input.is_some() { (area.y, bottom) } else if prompt_top { (if header.is_some() && !header_first { header_y + 1 } else { edge + 1 }, bottom) } else { (area.y, if header.is_some() && !header_first { header_y } else { edge }) };
    picker.page_rows.set(list_bottom.saturating_sub(list_top).max(1) as i64);
    // The box's rows: the prompt's side through the rows' (the list's rows are added as drawn).
    let edge_rows = [prompt_y, info_y, header_y];
    picker.box_rows.set((edge_rows.iter().min().copied().unwrap_or(prompt_y), edge_rows.iter().max().copied().unwrap_or(prompt_y)));
    let list_h = list_bottom.saturating_sub(list_top) as usize;
    let n = picker.visible.len();
    if n == 0 {
        // A list with nothing in it says why; one the query emptied, or one still loading (its
        // spinner turning), is blank, as fzf's is.
        if !picker.empty.is_empty() && list_h > 0 && total == 0 && !reading { buf.set_string(area.x + 2, if reverse { list_top } else { list_bottom - 1 }, &picker.empty, Style::default().add_modifier(Modifier::DIM)); }
        picker.row_at.clear();
        return cursor;
    }
    // fzf's maxWidth: the window less the pointer and marker, and less barCol() — a column for the
    // scrollbar whenever there is one (shown or not), or for whatever is on the right edge.
    let bar_col = theme::fzf_opts().scrollbar.is_some() || right_border || preview.is_some();
    let text_w = width.saturating_sub(gutter_width() as usize + bar_col as usize);
    // A live list matches what its rows show at this width: another width, matched again.
    if picker.text_w != text_w { picker.text_w = text_w; if picker.live && !picker.query.is_empty() { picker.refilter() } }
    picker.row_at.clear();
    if picker.wrap || theme::fzf_opts().gap > 0 { fzf_wrapped(buf, picker, area, list_top, list_bottom, text_w, reverse); return cursor }
    // Scroll so the cursor row is in view (scroll = first visible index from the bottom), with
    // fzf's --scroll-off rows (3; at most half the list) kept on either side of it.
    let so = theme::fzf_opts().scroll_off.min(list_h / 2);
    if picker.cursor < picker.scroll + so { picker.scroll = picker.cursor.saturating_sub(so) }
    if picker.cursor + so >= picker.scroll + list_h { picker.scroll = (picker.cursor + so + 1).saturating_sub(list_h) }
    picker.scroll = picker.scroll.min(n.saturating_sub(list_h.max(1)));
    // The right column lines up down the list: one edge for every row, after the widest line.
    let right_edge = right_edge(picker, text_w, false);
    for slot in 0..list_h.min(n - picker.scroll) {
        let vi = picker.scroll + slot;
        let y = if reverse { list_top + slot as u16 } else { list_bottom - 1 - slot as u16 };
        picker.row_at.push((y, vi));
        fzf_row(buf, picker, vi, area.x, y, text_w, right_edge);
    }
    // Scrollbar on the right edge, like fzf's: only the thumb, in the border colour.
    // fzf's getScrollbar: the thumb's length and its start from the prompt's side, both floored.
    picker.bar.set(None);
    if let (true, Some(bar)) = (n > list_h && list_h >= 1, theme::fzf_opts().scrollbar.clone()) {
        let thumb = ((list_h * list_h) / n).max(1);
        picker.bar.set(Some((area.x + area.width - 1, list_top, list_bottom, reverse, thumb, 1)));
        let start = ((list_h - thumb) * picker.scroll.min(n - list_h) / (n - list_h)).min(list_h - thumb);
        for i in 0..thumb {
            let y = if reverse { list_top + (start + i) as u16 } else { list_bottom - 1 - (start + i) as u16 };
            if y >= list_top && y < list_bottom { buf.set_string(area.x + area.width - 1, y, &bar, theme::fzf().scrollbar_style()); }
        }
    }
    cursor
}

/// One fzf row as printItem draws it: the pointer (or the gutter), the marker cell, then the
/// text — the row's pair (normal, selected, or the current line's), matches in the match pair,
/// the parts with colours of their own merged as fzf merges --ansi text (colorOffsets).
fn fzf_row(buf: &mut Buffer, picker: &Picker, vi: usize, x: u16, y: u16, text_w: usize, right_edge: usize) {
    let (ri, hits) = &picker.visible[vi];
    let row = &picker.rows[*ri];
    let o = theme::fzf_opts();
    let pal = theme::fzf().pal;
    let (base, matched, current, marked, alt) = row_gutter(buf, picker, vi, x, y, None);
    let base_style = base.style();
    // A row with no colours of its own is fzf's item without ANSI: its hits in the match pair
    // alone (colorOffsets), none of the row's attributes on them.
    let plain = row.lead.iter().all(|s| s.content.is_empty()) && row.label_dim == 0 && row.detail.iter().all(|s| s.content.is_empty() || s.style == Style::default());
    let cell = |part: Option<Style>, on: bool| if plain && on { matched.style() } else { paint(base, matched, part, on) };
    let mut spans: Vec<Span> = Vec::new();
    for s in &row.lead { spans.push(Span::styled(s.content.clone(), cell(Some(s.style), false))) }
    let lead_w: usize = row.lead.iter().map(|s| s.content.width()).sum();
    let label_len = row.label.chars().count();
    let dim = Style::default().add_modifier(Modifier::DIM);
    let mut cells: Vec<Cell> = row.label.chars().enumerate().map(|(i, c)| (c, (i < row.label_dim).then_some(dim), hits.contains(&(i as u32)))).collect();
    let detail_len: usize = row.detail.iter().map(|s| s.content.chars().count()).sum();
    if detail_len > 0 {
        cells.push((' ', None, false));
        cells.push((' ', None, false));
        let mut at = label_len + 2;
        for s in &row.detail {
            for c in s.content.chars() { cells.push((c, Some(s.style), hits.contains(&(at as u32)))); at += 1 }
        }
    }
    let cells = expand_tabs(cells);
    let right = row.right_at(text_w);
    let narrow = right.len() != row.right.len();
    let right_w = right.width();
    let show_right = !right.is_empty() && text_w >= lead_w + right_w + 14;
    let avail = text_w.saturating_sub(lead_w + if show_right { right_w + 2 } else { 0 });
    let cells: Vec<(char, Style)> = hscroll(cells, avail, &o.ellipsis, o.hscroll, o.hscroll_off, o.keep_right).into_iter().map(|(c, part, on)| (c, cell(part, on))).collect();
    let mut run = String::new();
    let mut run_style = None::<Style>;
    for (c, st) in &cells {
        // A combining mark (a decomposed accent) stays with its letter, whatever lit it.
        if !run.is_empty() && unicode_width::UnicodeWidthChar::width(*c) == Some(0) { run.push(*c); continue }
        if run_style != Some(*st) && !run.is_empty() { spans.push(Span::styled(std::mem::take(&mut run), run_style.unwrap_or_default())) }
        run_style = Some(*st);
        run.push(*c);
    }
    if !run.is_empty() { spans.push(Span::styled(run, run_style.unwrap_or_default())) }
    let used: usize = spans.iter().map(|s| s.content.width()).sum();
    // Past the text the current row keeps bg+ only as far as the line goes (fzf; --highlight-line
    // fills the row): to the end of the right column when there is one.
    let fill = if current { base_style } else { pal.normal.style() };
    if show_right {
        let end = right_edge.clamp(used + right_w + 2, text_w);
        let pad = end.saturating_sub(used + right_w);
        spans.push(Span::styled(" ".repeat(pad), fill));
        // (Its characters where the line matched counts them: after the blanks drawn.)
        let right_at = label_len + if detail_len > 0 { 2 + detail_len } else { 0 } + pad;
        // The right column is dim text of the line's own.
        let dim = Style::default().add_modifier(Modifier::DIM);
        for (i, c) in right.chars().enumerate() {
            let on = !narrow && hits.contains(&((right_at + i) as u32));
            spans.push(Span::styled(c.to_string(), cell(Some(dim), on)));
        }
    }
    let used: usize = spans.iter().map(|s| s.content.width()).sum();
    // --highlight-line fills the rest of the current, a marked or a striped row (postTask).
    if o.highlight_line && (current || marked || alt) {
        let fill = if current { pal.current.style() } else if alt { pal.selected.with_bg(theme::fzfcolor::CA { col: base.bg, attr: pal.alt_bg.attr }).style() } else { pal.selected.style() };
        spans.push(Span::styled(" ".repeat(text_w.saturating_sub(used)), fill));
    }
    let jump_extra = (pointer_w() == 0 && picker.jumping.is_some() && vi.saturating_sub(picker.scroll) < theme::fzf_opts().jump_labels.chars().count()) as u16;
    buf.set_line(x + gutter_width() + jump_extra, y, &Line::from(spans), text_w as u16);
}

/// Where the right column lines up: after the widest line of the list — all of it, not only what
/// the query leaves, so typing does not move it (with --wrap, of the rows that fit their line).
fn right_edge(p: &Picker, text_w: usize, wrapping: bool) -> usize {
    p.rows.iter().filter(|r| !r.disabled && (!wrapping || fits_line(r, text_w)))
        .map(|r| r.lead.iter().map(|s| s.content.width()).sum::<usize>() + crate::picker::line(r).width()).max().unwrap_or(0).min(text_w)
}

/// printItem's preTask and pairs for a row: the pointer on the current line, the gutter elsewhere
/// (no column at all for --pointer=''); the marker cell — the marker on a selected row ([marker]
/// instead on a line of a row of several), else blank (bg+ on the current line; plain, the default
/// colour on the list's background, elsewhere; none for --marker=''); and the row's pairs, the
/// current line's, a selected row's or the normal ones — on --color=alt-bg every other row counted
/// from the first one shown (fzf's itemCount), unless it is marked on a selected-bg of its own; the
/// current row keeps bg+. Returns (base, matched, current, marked, alt).
fn row_gutter(buf: &mut Buffer, picker: &Picker, vi: usize, x: u16, y: u16, marker: Option<&str>) -> (theme::fzfcolor::P, theme::fzfcolor::P, bool, bool, bool) {
    let row = &picker.rows[picker.visible[vi].0];
    let current = vi == picker.cursor;
    let marked = picker.marked.contains(&row.id);
    let z = theme::fzf();
    let pal = z.pal;
    // Jump mode: each row shown its label where the pointer goes, in the pointer's colours.
    let slot = vi.saturating_sub(picker.scroll);
    let jump_label = picker.jumping.and_then(|_| theme::fzf_opts().jump_labels.chars().nth(slot));
    let pw = pointer_w().max(jump_label.is_some() as usize);
    if let (Some(l), true) = (jump_label, pw > 0) { buf.set_string(x, y, format!("{:<pw$}", l), if current { pal.current_cursor.style() } else { pal.cursor.style() }) }
    else if pw > 0 && current && picker.jumping.is_none() { buf.set_string(x, y, format!("{:<pw$}", z.pointer_char), pal.current_cursor.style()) }
    else if pw > 0 {
        // The gutter: --gutter's character, `▌`, or under --no-unicode a blank in reverse.
        let o = theme::fzf_opts();
        let (gutter, st) = if o.raw { (o.gutter_raw.as_deref().unwrap_or(if o.unicode { "▖" } else { ":" }), pal.cursor_empty_char) } else { match &o.gutter { Some(g) => (g.as_str(), pal.cursor_empty_char), None if o.unicode => ("▌", pal.cursor_empty_char), None => (" ", pal.cursor_empty) } };
        buf.set_string(x, y, format!("{:<pw$}", gutter), st.style())
    }
    let mw = marker_w();
    let marker = marker.unwrap_or(&z.marker_char);
    let plain = theme::fzfcolor::P { fg: theme::fzfcolor::Col::Default, bg: pal.normal.bg, attr: 0 };
    let (mark, mark_style) = match (current, marked) {
        (true, true) => (format!("{:<mw$}", marker), pal.current_marker.style()),
        (true, false) => (" ".repeat(mw), pal.current_selected_empty.style()),
        (false, true) => (format!("{:<mw$}", marker), pal.marker.style()),
        (false, false) => (" ".repeat(mw), plain.style()),
    };
    buf.set_string(x + pw as u16, y, mark, mark_style);
    let (base, matched) = match (current, marked) {
        (true, _) => (pal.current, pal.current_match),
        (false, true) => (pal.selected, pal.selected_match),
        (false, false) => (pal.normal, pal.matched),
    };
    let undefined = pal.alt_bg.col == theme::fzfcolor::Col::Undef;
    // (Striped in jump mode — on bg+ from the first row when there is no alt-bg — as fzf does.)
    let (alt, alt_bg) = if jump_label.is_some() {
        (if undefined { slot % 2 == 0 } else { slot % 2 == 1 }, if undefined { theme::fzfcolor::CA { col: pal.current.bg, attr: 0 } } else { pal.alt_bg })
    } else { (!(marked && pal.selected.bg != pal.normal.bg) && !undefined && slot % 2 == 1, pal.alt_bg) };
    let (base, matched) = if alt && !current { (base.with_bg(alt_bg), matched.with_bg(alt_bg)) } else { (base, matched) };
    let base = if picker.is_match(vi) { base } else { base.with_fg(pal.nomatch) };
    (base, matched, current, marked, alt)
}

/// A cell of a row's line as fzf reads it (picker::line): the title in the row's pair, the detail
/// and the glyphs in their own colours over it; the match pair where the query lit it.
fn paint(base: theme::fzfcolor::P, matched: theme::fzfcolor::P, part: Option<Style>, on: bool) -> Style {
    use theme::fzfcolor::{ansi, lit, own};
    let colored = theme::fzf().pal.colored;
    match (part, on) {
        (None, false) => base.style(),
        (Some(st), false) => ansi(own(st), base, colored).style(),
        (part, true) => lit(base, matched, part.map(own), colored).style(),
    }
}

/// A tab in a row's text as fzf draws it: blanks to the next --tabstop (the text's first column 0).
fn expand_tabs(cells: Vec<Cell>) -> Vec<Cell> {
    if !cells.iter().any(|c| c.0 == '\t') { return cells }
    let tabstop = theme::fzf_opts().tabstop.max(1);
    let mut out = Vec::with_capacity(cells.len());
    let mut col = 0;
    for c in cells {
        if c.0 == '\t' { let n = tabstop - col % tabstop; out.extend(std::iter::repeat_n((' ', c.1, c.2), n)); col += n }
        else { col += unicode_width::UnicodeWidthChar::width(c.0).unwrap_or(0); out.push(c) }
    }
    out
}

/// Whether a row's line fits hn's one-line layout at [text_w] (fzf_row: its title and detail in
/// the room its lead and right column leave, the right column shown when there is one).
fn fits_line(row: &crate::picker::Row, text_w: usize) -> bool {
    let cw = |c: char| unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
    let lead_w: usize = row.lead.iter().map(|s| s.content.width()).sum();
    let right = row.right_at(text_w);
    let right_w = right.width();
    let show_right = !right.is_empty() && text_w >= lead_w + right_w + 14;
    let avail = text_w.saturating_sub(lead_w + if show_right { right_w + 2 } else { 0 });
    let detail: usize = row.detail.iter().flat_map(|s| s.content.chars()).map(cw).sum();
    let has_detail = row.detail.iter().any(|s| !s.content.is_empty());
    let title = expand_tabs(row.label.chars().map(|c| (c, None, false)).collect()).iter().map(|c| cw(c.0)).sum::<usize>();
    title + if has_detail { 2 + detail } else { 0 } <= avail && (right.is_empty() || show_right)
}

/// A row's whole line as cells, for --wrap: the lead's glyphs, the title and the detail (lit where
/// the query matched them) and the right column, dim — picker::line after the lead.
fn line_cells(row: &crate::picker::Row, hits: &[u32]) -> Vec<Cell> {
    let mut cells: Vec<Cell> = row.lead.iter().flat_map(|s| s.content.chars().map(move |c| (c, Some(s.style), false))).collect();
    let dim = Style::default().add_modifier(Modifier::DIM);
    cells.extend(row.label.chars().enumerate().map(|(i, c)| (c, (i < row.label_dim).then_some(dim), hits.contains(&(i as u32)))));
    let mut at = row.label.chars().count();
    if row.detail.iter().any(|s| !s.content.is_empty()) {
        cells.extend([(' ', None, false), (' ', None, false)]);
        at += 2;
        for s in &row.detail { for c in s.content.chars() { cells.push((c, Some(s.style), hits.contains(&(at as u32)))); at += 1 } }
    }
    if !row.right.is_empty() {
        let dim = Style::default().add_modifier(Modifier::DIM);
        cells.extend([(' ', None, false), (' ', None, false)]);
        at += 2;
        for c in row.right.chars() { cells.push((c, Some(dim), hits.contains(&(at as u32)))); at += 1 }
    }
    expand_tabs(cells)
}

/// fzf's Chars.Lines for one line: cut where it runs past [cols] columns (a line after the first
/// [sign_w] fewer, for the wrap sign; at least one character a line), no more than [at_most] lines
/// — and whether there was more.
fn wrap_cells(cells: &[Cell], cols: usize, sign_w: usize, at_most: usize) -> (Vec<Vec<Cell>>, bool) {
    let cw = |c: char| unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) as i64;
    let (mut out, mut rest, mut signed) = (Vec::new(), cells, false);
    loop {
        let limit = cols as i64 - if signed { sign_w as i64 } else { 0 };
        let mut w = 0;
        let over = rest.iter().position(|c| { w += cw(c.0); w > limit });
        if out.len() >= at_most { return (out, true) }
        match over {
            Some(i) => { let i = i.max(1); out.push(rest[..i].to_vec()); rest = &rest[i..]; signed = true }
            None => { out.push(rest.to_vec()); return (out, false) }
        }
    }
}

/// fzf's numItemLines with --wrap: how many lines a row takes (no more than [at_most]), and
/// whether it needs more.
fn item_lines(p: &Picker, vi: usize, at_most: i64, text_w: usize) -> (usize, bool) {
    // (With --gap, its blank lines after it count too.)
    let gap = theme::fzf_opts().gap;
    if !p.wrap { return (1 + gap, (1 + gap) as i64 > at_most) }
    let (ri, hits) = &p.visible[vi];
    {
        let cache = p.line_cache.borrow();
        if cache.0 == text_w { if let Some(&(room, n)) = cache.1.get(ri) { if room <= at_most { return (n, false) } } }
    }
    let (lines, over) = if at_most <= 0 { (0, true) } else {
        let row = &p.rows[*ri];
        if fits_line(row, text_w) { (1, false) } else {
            let (l, over) = wrap_cells(&line_cells(row, hits), text_w.max(1), theme::fzf_opts().wrap_sign.width(), at_most as usize);
            (l.len(), over)
        }
    };
    if !over {
        let mut cache = p.line_cache.borrow_mut();
        if cache.0 != text_w { *cache = (text_w, Default::default()) }
        cache.1.insert(*ri, (at_most, lines + gap));
    }
    (lines + gap, over || (lines + gap) as i64 > at_most)
}

/// fzf's page-up/-down and half-page-up/-down ([direction] as move_by's: toward the far end of the
/// list is positive): a page is the list's lines less one, half a page half of them; with --wrap
/// the cursor goes a row at a time, constrain() after each, and stops before the screen would
/// scroll past the rows that were on it.
pub fn page(p: &mut Picker, direction: i64, half: bool) {
    let max_items = p.page_rows.get().max(0) as usize;
    let lines_to_move = (if half { max_items / 2 } else { max_items.saturating_sub(1) }).max(1) as i64;
    let text_w = p.wrap_width.get();
    if !(p.wrap || theme::fzf_opts().gap > 0) || text_w == 0 || p.visible.is_empty() { return p.vset(p.cursor as i64 + direction * lines_to_move, direction) }
    let n = p.visible.len();
    let (mut min_offset, mut max_offset, mut sum) = (0i64, 0i64, 0usize);
    if direction > 0 {
        max_offset = p.scroll as i64;
        while (max_offset as usize) < n {
            sum += item_lines(p, max_offset as usize, max_items as i64, text_w).0;
            if sum >= max_items { break }
            max_offset += 1;
        }
    } else {
        min_offset = p.scroll as i64;
        while min_offset >= 0 && (min_offset as usize) < n {
            sum += item_lines(p, min_offset as usize, max_items as i64, text_w).0;
            if sum >= max_items { if sum > max_items { min_offset += 1 } break }
            min_offset -= 1;
        }
    }
    for i in 0..lines_to_move {
        let (cy, offset) = (p.cursor, p.scroll);
        p.vset(cy as i64 + direction, direction);
        let q: &Picker = p;
        let next = constrain_wrapped(q, max_items, &|vi, at_most| item_lines(q, vi, at_most, text_w));
        p.scroll = next;
        if cy == p.cursor { break }
        if i > 0 && ((direction > 0 && p.scroll as i64 > max_offset) || (direction < 0 && (p.scroll as i64) < min_offset)) {
            p.vset(cy as i64, -direction);
            p.scroll = offset;
            break;
        }
    }
}

/// fzf's constrain() with rows of more than one line: the offset (the first row on the prompt's
/// side) that fits the current row, then keeps --scroll-off lines on either side of it.
fn constrain_wrapped(p: &Picker, max_lines: usize, lines: &dyn Fn(usize, i64) -> (usize, bool)) -> usize {
    let count = p.visible.len();
    let cy = p.cursor.min(count.saturating_sub(1));
    let mut offset = p.scroll.min(count);
    for _ in 0..max_lines {
        // How many rows fit on screen with the current one.
        let (mut found, mut sum) = (0usize, 0usize);
        let add = |i: usize, found: &mut usize, sum: &mut usize| -> bool {
            let (l, overflow) = lines(i, (max_lines - *sum) as i64);
            *sum += l;
            if *sum >= max_lines { if *found == 0 || !overflow { *found += 1 } return false }
            *found += 1;
            true
        };
        for i in offset..count { if !add(i, &mut found, &mut sum) { break } }
        if sum < max_lines { for i in (0..offset).rev() { if !add(i, &mut found, &mut sum) { break } } }
        let num_items = found;
        let min_offset = (cy + 1).saturating_sub(num_items);
        let max_offset = count.saturating_sub(num_items).min(cy);
        let prev = offset;
        offset = offset.min(max_offset).max(min_offset);
        let scroll_off = theme::fzf_opts().scroll_off;
        if scroll_off > 0 {
            let so = scroll_off.min(max_lines / 2) as i64;
            let mut next = offset;
            for phase in 0..2 {
                loop {
                    let before_move = next;
                    let item_lines = lines(cy, max_lines as i64).0 as i64;
                    let mut before = 0i64;
                    for i in next..cy { before += lines(i, max_lines as i64 - before - item_lines).0 as i64 }
                    let after = max_lines as i64 - (before + item_lines);
                    if before < so && after < so { break }
                    if phase == 0 && before < so { next = next.saturating_sub(1).max(min_offset) }
                    else if phase == 1 && after < so { next = (next + 1).min(max_offset) }
                    if next == before_move { break }
                }
                offset = next;
            }
        }
        if offset == prev { break }
    }
    offset
}

/// fzf --wrap (toggle-wrap, M-/): a row too long for its line goes on over the next ones, each
/// after the wrap sign (`↳ `, in the row's colours, dim), the pointer and the marker on every one
/// of them (a marked row's ╻ ┃ ╹). constrain() keeps the current row on screen with --scroll-off
/// lines around it, the rows stack from the prompt, a row cut at the far end shows the part nearest
/// the prompt in the default layout (its first lines otherwise), and the scrollbar counts
/// avgNumLines — as fzf 0.67 draws it. A row that fits keeps hn's layout, its right column lined up.
fn fzf_wrapped(buf: &mut Buffer, picker: &mut Picker, area: Rect, list_top: u16, list_bottom: u16, text_w: usize, reverse: bool) {
    let o = theme::fzf_opts();
    let max_lines = list_bottom.saturating_sub(list_top) as usize;
    let n = picker.visible.len();
    if max_lines == 0 || n == 0 { return }
    let (cols, sign_w) = (text_w.max(1), o.wrap_sign.width());
    picker.wrap_width.set(text_w);
    let p: &Picker = picker;
    let lines = |vi: usize, at_most: i64| item_lines(p, vi, at_most, text_w);
    let offset = constrain_wrapped(p, max_lines, &lines);
    // The rows from the prompt: (visible index, fzf's line — 0 nearest the prompt — and the part of
    // a wrapped row on it: its cells, whether it goes on from the line before, its marker's place).
    let maxy = max_lines - 1;
    let mut placed: Vec<(usize, usize, Option<(Vec<Cell>, bool, usize)>)> = Vec::new();
    // --gap's lines: (fzf's line, whether it is the one the gap line is drawn on).
    let mut gaps: Vec<(usize, bool)> = Vec::new();
    let gap = o.gap;
    let (mut line, mut k) = (0usize, 0usize);
    while line <= maxy && offset + k < n {
        let vi = offset + k;
        k += 1;
        let (ri, hits) = &p.visible[vi];
        let row = &p.rows[*ri];
        if !p.wrap || fits_line(row, text_w) {
            placed.push((vi, line, None));
            // printItem: the gap after the row, while there is room.
            let mut last = line;
            for i in 0..gap { if last >= maxy { break } last += 1; gaps.push((last, i == gap - 1)) }
            line = last + 1;
            continue;
        }
        let cells = line_cells(row, hits);
        let at_most = maxy - line + 1;
        let (mut parts, overflow) = wrap_cells(&cells, cols, sign_w, at_most);
        let count = parts.len();
        // In the default layout a row that is not the current one and runs past the top shows its
        // last lines.
        let top_cut = !reverse && vi != p.cursor && count == at_most && overflow;
        let skip = if top_cut { parts = wrap_cells(&cells, cols, sign_w, usize::MAX).0; parts.len() - at_most } else { 0 };
        let mut last = line;
        for (idx, part) in parts.into_iter().enumerate().skip(skip) {
            let a = idx - skip;
            if line + a > maxy { break }
            // markerSingle (0), markerTop (1), markerMiddle (2), markerBottom (3)
            let class = if count == 1 { if !overflow { 0 } else if top_cut { 3 } else { 1 } }
                else if a == 0 { if top_cut { 2 } else { 1 } }
                else if a == count - 1 { if top_cut || !overflow { 3 } else { 2 } }
                else { 2 };
            placed.push((vi, if reverse { line + a } else { line + count - 1 - a }, Some((part, idx > 0, class))));
            last = line + a;
        }
        for i in 0..gap { if last >= maxy { break } last += 1; gaps.push((last, i == gap - 1)) }
        line = last + 1;
    }
    // avgNumLines: the rows from the offset (or the last screenful), a screen's worth at most — 1
    // without --wrap (--gap's lines are not counted).
    let per_line = if !p.wrap { 1 } else {
        let from = (offset as i64).min(n as i64 - max_lines as i64 - 1).max(0) as usize;
        let counted: Vec<usize> = (from..n).take(max_lines).map(|vi| lines(vi, max_lines as i64).0).collect();
        if counted.is_empty() { 1 } else { counted.iter().sum::<usize>() / counted.len() }
    };
    let right_edge = right_edge(p, text_w, p.wrap);
    picker.scroll = offset;
    for (vi, fline, part) in placed {
        let y = if reverse { list_top + fline as u16 } else { list_bottom - 1 - fline as u16 };
        picker.row_at.push((y, vi));
        match part {
            None => fzf_row(buf, picker, vi, area.x, y, text_w, right_edge),
            Some((cells, signed, class)) => fzf_row_part(buf, picker, vi, area.x, y, text_w, &cells, signed, class),
        }
    }
    // renderGapLine: the gutter, a blank marker, and on a gap's last line the gap line across.
    let z = theme::fzf();
    let pal = z.pal;
    let gap_line = o.gap_line.clone().unwrap_or_else(|| if z.unicode { "┈".into() } else { "-".into() });
    let (pw, mw) = (pointer_w(), marker_w());
    for (fline, draw) in gaps {
        let y = if reverse { list_top + fline as u16 } else { list_bottom - 1 - fline as u16 };
        if pw > 0 {
            let (gutter, st) = match &o.gutter { Some(g) => (g.as_str(), pal.cursor_empty_char), None if o.unicode => ("▌", pal.cursor_empty_char), None => (" ", pal.cursor_empty) };
            buf.set_string(area.x, y, format!("{:<pw$}", gutter), st.style());
        }
        let width = (area.width as usize).saturating_sub(pw + mw + 1);
        if draw && !gap_line.is_empty() { buf.set_string(area.x + (pw + mw) as u16, y, repeat_to_fill(&gap_line, width), pal.gap_line.style()); }
    }
    // getScrollbar(avgNumLines, …): the thumb and its start from the prompt's side.
    let (total, h) = (n * per_line.max(1), max_lines);
    picker.bar.set(None);
    if let (true, Some(bar)) = (total > h && h >= 1, o.scrollbar.clone()) {
        let thumb = (h * h / total).max(1);
        picker.bar.set(Some((area.x + area.width - 1, list_top, list_bottom, reverse, thumb, per_line.max(1))));
        let start = if n == h { 0 } else { ((h * per_line - thumb) * offset / (total - h)).min(h - thumb) };
        for i in 0..thumb {
            let y = if reverse { list_top + (start + i) as u16 } else { list_bottom - 1 - (start + i) as u16 };
            if y >= list_top && y < list_bottom { buf.set_string(area.x + area.width - 1, y, &bar, theme::fzf().scrollbar_style()); }
        }
    }
}

/// A line of a wrapped row (printHighlighted with --wrap): the pointer and the marker for its
/// place in the row, the wrap sign when it goes on from the line before, then its cells.
#[allow(clippy::too_many_arguments)]
fn fzf_row_part(buf: &mut Buffer, picker: &Picker, vi: usize, x: u16, y: u16, text_w: usize, cells: &[Cell], signed: bool, class: usize) {
    let z = theme::fzf();
    let marker = (class > 0).then(|| z.marker_multi[class - 1].as_str());
    let (base, matched, current, marked, alt) = row_gutter(buf, picker, vi, x, y, marker);
    let mut spans: Vec<Span> = Vec::new();
    if signed {
        let mut w = 0;
        let sign: String = theme::fzf_opts().wrap_sign.chars().take_while(|c| { w += unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0); w <= text_w }).collect();
        spans.push(Span::styled(sign, base.style().add_modifier(Modifier::DIM)));
    }
    let (mut run, mut run_style) = (String::new(), None::<Style>);
    let plain = cells.iter().all(|(_, part, _)| part.is_none());
    for (c, part, on) in cells {
        if !run.is_empty() && unicode_width::UnicodeWidthChar::width(*c) == Some(0) { run.push(*c); continue }
        let st = if plain && *on { matched.style() } else { paint(base, matched, *part, *on) };
        if run_style != Some(st) && !run.is_empty() { spans.push(Span::styled(std::mem::take(&mut run), run_style.unwrap_or_default())) }
        run_style = Some(st);
        run.push(*c);
    }
    if !run.is_empty() { spans.push(Span::styled(run, run_style.unwrap_or_default())) }
    // --highlight-line fills the rest of the current, a marked or a striped row's line.
    if theme::fzf_opts().highlight_line && (current || marked || alt) {
        let pal = z.pal;
        let used: usize = spans.iter().map(|s| s.content.width()).sum();
        let fill = if current { pal.current.style() } else if alt { pal.selected.with_bg(theme::fzfcolor::CA { col: base.bg, attr: pal.alt_bg.attr }).style() } else { pal.selected.style() };
        spans.push(Span::styled(" ".repeat(text_w.saturating_sub(used)), fill));
    }
    let jump_extra = (pointer_w() == 0 && picker.jumping.is_some() && vi.saturating_sub(picker.scroll) < theme::fzf_opts().jump_labels.chars().count()) as u16;
    buf.set_line(x + gutter_width() + jump_extra, y, &Line::from(spans), text_w as u16);
}

/// fzf's trimRight: as much of [s] as fits in [limit] columns.
fn trim_right(s: &str, limit: i32) -> String {
    let mut width = 0;
    s.chars().take_while(|c| { width += unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0) as i32; width <= limit }).collect()
}

/// fzf's trimMessage: a message longer than [max] (in bytes, as fzf counts) cut to leave room for
/// two dots — or as many as there is room for.
fn trim_message(s: &str, max: i32) -> String {
    if s.len() as i32 <= max { return s.to_string() }
    trim_right(s, max - 2) + &".".repeat(max.clamp(0, 2) as usize)
}

/// fzf's util.RepeatToFill (a separator longer than the room is cut to it): the string over and
/// over, then as much of it as fits.
fn repeat_to_fill(s: &str, limit: usize) -> String {
    let length = s.width();
    if length == 0 { return String::new() }
    if length > limit { return trim_right(s, limit as i32) }
    let mut out = s.repeat(limit / length);
    let mut rest = (limit % length) as i32;
    if rest > 0 {
        for c in s.chars() {
            rest -= unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) as i32;
            if rest < 0 { break }
            out.push(c);
            if rest == 0 { break }
        }
    }
    out
}

/// fzf's hscroll (terminal.go, printHighlighted): a line wider than its room keeps its last match
/// in view with --hscroll-off columns after it, the ellipsis where it was cut on either side.
fn hscroll(cells: Vec<Cell>, room: usize, ellipsis: &str, scroll: bool, scroll_off: usize, keep_right: bool) -> Vec<Cell> {
    let cw = |c: char| unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
    let w = |c: &[Cell]| -> usize { cell_widths(c).iter().sum() };
    if w(&cells) <= room { return cells }
    // util.Truncate(ellipsis, maxWidth): as much of it as the room takes.
    let mut ew = 0;
    let ell: Vec<char> = ellipsis.chars().take_while(|c| { ew += cw(*c); ew <= room }).collect();
    let ew: usize = ell.iter().map(|c| cw(*c)).sum();
    let trim_right = |c: &[Cell], width: usize| -> Vec<Cell> {
        let mut out = Vec::new();
        let mut used = 0;
        for (x, cw) in c.iter().zip(cell_widths(c)) { if used + cw > width { break } used += cw; out.push(*x) }
        out
    };
    // --keep-right, a row the query did not light: its end in view, the ellipsis before it (trimLeft).
    if scroll && keep_right && !cells.iter().any(|c| c.2) {
        let mut from = cells.len().saturating_sub(room);
        while from < cells.len() && w(&cells[from..]) > room.saturating_sub(ew) { from += 1 }
        let mut out: Vec<Cell> = ell.iter().map(|c| (*c, None, false)).collect();
        out.extend(cells[from..].iter().cloned());
        return out;
    }
    let max_end = cells.iter().rposition(|c| c.2).map(|i| i + 1).unwrap_or(0);
    // (Less than the last match's end when the ellipsis is wider than half the room.)
    let maxe = (max_end as i64 + ((room / 2) as i64 - ew as i64).min(scroll_off as i64)).clamp(0, cells.len() as i64) as usize;
    if !scroll || w(&cells[..maxe]) <= room.saturating_sub(ew) {
        let mut out = trim_right(&cells, room.saturating_sub(ew));
        // The ellipsis in what fzf's colour offsets leave on it: cut only at the end, they stay
        // where they were, so a part of the line's own running on under it colours it; under
        // --no-hscroll they are pulled back into it, so whatever was past the cut does — a match
        // too.
        let mut runs: Vec<(usize, usize, Style)> = Vec::new();
        for (i, x) in cells.iter().enumerate() {
            let Some(st) = x.1 else { continue };
            match runs.last_mut() { Some(r) if r.1 == i && r.2 == st => r.1 = i + 1, _ => runs.push((i, i + 1, st)) }
        }
        let (n, start) = (ell.len(), out.len());
        for (k, &c) in ell.iter().enumerate() {
            let at = start + k;
            let covers = |b: usize, e: usize| if scroll { b <= at && at < e } else { b.min(room.saturating_sub(n)) <= at && at < e.min(room) };
            let part = runs.iter().rev().find(|r| covers(r.0, r.1)).map(|r| r.2);
            let on = cells.iter().enumerate().any(|(i, x)| x.2 && covers(i, i + 1));
            out.push((c, part, on));
        }
        return out;
    }
    // Scrolled: the ellipses are the row's own, nothing of the line's reaching them.
    let plain = |c: &char| (*c, None, false);
    let mut cells = cells;
    if w(&cells[maxe..]) > ew { cells.truncate(maxe); cells.extend(ell.iter().map(plain)) }
    // Trim from the left until it fits beside the leading ellipsis.
    let width = room.saturating_sub(ew);
    // fzf's trimLeft first drops len-width runes, then measures what remains. Keep that
    // initial cut even for zero-width marks: it determines the reference tool's scroll offset.
    let mut from = cells.len().saturating_sub(room);
    while from < cells.len() && w(&cells[from..]) > width { from += 1 }
    let mut out: Vec<Cell> = ell.iter().map(plain).collect();
    out.extend(cells[from..].iter().cloned());
    out
}

/// A character of a row's line: its own colours if it has them (hn's glyphs, a dim detail — an
/// --ansi part to fzf), and whether the query lit it.
type Cell = (char, Option<Style>, bool);

/// Each cell's columns as fzf counts them (uniseg, by grapheme cluster): the cluster's width on
/// its first character, none on the rest — a family emoji's ZWJ-joined people are two columns,
/// not six.
fn cell_widths(cells: &[Cell]) -> Vec<usize> {
    use unicode_segmentation::UnicodeSegmentation;
    let s: String = cells.iter().map(|c| c.0).collect();
    let mut out = Vec::with_capacity(cells.len());
    for g in s.graphemes(true) {
        out.push(unicode_width::UnicodeWidthStr::width(g));
        out.extend(std::iter::repeat_n(0, g.chars().count() - 1));
    }
    out
}

/// The pointer's cells (fzf pads every row to it) and the pointer and marker together.
fn pointer_w() -> usize { theme::fzf().pointer_char.width() }
fn marker_w() -> usize { theme::fzf().marker_char.width() }
fn gutter_width() -> u16 { (pointer_w() + marker_w()) as u16 }

/// Break a styled line into lines no wider than `width`, at spaces where it can.
fn wrap_line(line: Line<'static>, width: usize) -> Vec<Line<'static>> {
    if width == 0 || line.width() <= width { return vec![line] }
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut cur: Vec<Span<'static>> = Vec::new();
    let mut used = 0;
    for span in line.spans {
        let style = span.style;
        for word in span.content.split_inclusive(' ') {
            let w = word.width();
            if used + w > width && used > 0 { out.push(Line::from(std::mem::take(&mut cur))); used = 0 }
            let word = if w > width { clip(word, width) } else { word.to_string() };
            used += word.width();
            cur.push(Span::styled(word, style));
        }
    }
    if !cur.is_empty() { out.push(Line::from(cur)) }
    // A wrapped line does not start with the separator it broke at.
    for line in out.iter_mut().skip(1) {
        while let Some(first) = line.spans.first() {
            let t = first.content.trim();
            if t.is_empty() || t == "·" { line.spans.remove(0); } else { break }
        }
    }
    out
}

/// fzf's `--header`: the keys this list answers to, in the header colour.
fn header_line(picker: &Picker, _: &PickerKind, width: usize) -> Option<Line<'static>> { header_line_at(picker, width, gutter_width() as usize) }

/// header_line indented [indent] columns (in a header box with a left side, none: its margin
/// stands for the indent).
fn header_line_at(picker: &Picker, width: usize, indent: usize) -> Option<Line<'static>> {
    // change-header: its text in place of the hints.
    if let Some(h) = &picker.header_text { if h.is_empty() { return None } return Some(Line::from(vec![Span::raw(" ".repeat(indent)), Span::styled(clip(h, width.saturating_sub(indent)), theme::fzf().header_style())])) }
    // (No row at all when every hint's key is bound to something else and there is no heading.)
    if picker.heading.is_none() && picker.hints.iter().all(|(k, _)| crate::input::rebound(k)) { return None }
    let mut spans = vec![Span::raw(" ".repeat(indent))];
    let mut used = indent;
    // What the list is for, first (a task about to be sent).
    if let Some(h) = &picker.heading {
        let h = clip(h, width.saturating_sub(indent + 12));
        used += h.width() + 3;
        spans.push(Span::styled(h, theme::fzf().header_style().add_modifier(Modifier::BOLD)));
        if !picker.hints.is_empty() { spans.push(Span::styled(" · ", theme::fzf().border_style())) }
    }
    // (A key you bound to something else in FZF_DEFAULT_OPTS is not offered for this.)
    for (i, (k, w)) in picker.hints.iter().filter(|(k, _)| !crate::input::rebound(k)).enumerate() {
        // Whole hints only: the ones that do not fit are left out, the line ended as fzf ends a
        // long header (··).
        let piece = if i > 0 { 3 } else { 0 } + k.width() + 1 + w.width();
        if used + piece > width {
            let dots = if theme::fzf_opts().unicode { "··" } else { ".." };
            if used + 2 <= width { spans.push(Span::styled(dots, theme::fzf().header_style())) }
            break;
        }
        used += piece;
        if i > 0 { spans.push(Span::styled(" · ", theme::fzf().border_style())) }
        spans.push(Span::styled(k.to_string(), theme::fzf().header_style().add_modifier(Modifier::BOLD)));
        spans.push(Span::styled(format!(" {w}"), theme::fzf().header_style()));
    }
    Some(Line::from(spans))
}

/// A border drawn as fzf's LightWindow draws it (drawBorderAround, drawBorderHorizontal,
/// drawBorderVertical): a box's corners and lines, or its lines only, each side with a column of
/// margin inside it, in [st].
fn draw_box(buf: &mut Buffer, area: Rect, shape: &str, st: Style) {
    if area.width < 2 || area.height == 0 { return }
    let (top_c, bottom_c, left_c, right_c, tl, tr, bl, br) = border_glyphs(shape);
    let (x0, y0, x1, y1) = (area.x, area.y, area.x + area.width - 1, area.y + area.height - 1);
    let boxed = !matches!(shape, "horizontal" | "vertical" | "top" | "bottom" | "left" | "right" | "none" | "line");
    let (t, r, b, l) = shape_sides(shape);
    if boxed {
        for x in x0 + 1..x1 { buf.set_string(x, y0, top_c, st); buf.set_string(x, y1, bottom_c, st) }
        buf.set_string(x0, y0, tl, st); buf.set_string(x1, y0, tr, st); buf.set_string(x0, y1, bl, st); buf.set_string(x1, y1, br, st);
        for y in y0 + 1..y1 { buf.set_string(x0, y, format!("{left_c} "), st); buf.set_string(x1 - 1, y, format!(" {right_c}"), st) }
        return;
    }
    if t { for x in x0..=x1 { buf.set_string(x, y0, top_c, st) } }
    if b { for x in x0..=x1 { buf.set_string(x, y1, bottom_c, st) } }
    for y in y0..=y1 {
        if l { buf.set_string(x0, y, format!("{left_c} "), st) }
        if r { buf.set_string(x1 - 1, y, format!(" {right_c}"), st) }
    }
}

/// evaluateScrollOffset without placeholders: +N and -N add up from line 0 (+1 is the first), a
/// /D takes a D-th of the window off.
fn scroll_offset(expr: &str, height: usize) -> Option<usize> {
    let mut rest = expr.to_string();
    while let (Some(a), Some(b)) = (rest.find('{'), rest.find('}')) { if b < a { break } let from = if a > 0 && rest.as_bytes()[a - 1] == b'+' { a - 1 } else { a }; rest.replace_range(from..=b, "") }
    if rest.is_empty() && expr.is_empty() { return None }
    let mut base: i64 = -1;
    let chars: Vec<char> = rest.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let neg_div = chars[i] == '-' && chars.get(i + 1) == Some(&'/');
        if chars[i] == '/' || neg_div {
            let from = i + if neg_div { 2 } else { 1 };
            let d: String = chars[from..].iter().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(d) = d.parse::<i64>() { if d != 0 { base -= height as i64 / d } }
            break;
        }
        if chars[i] == '+' || chars[i] == '-' {
            let n: String = chars[i + 1..].iter().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(v) = n.parse::<i64>() { base += if chars[i] == '-' { -v } else { v } }
            i += 1 + n.len();
            continue;
        }
        i += 1;
    }
    Some(base.max(0) as usize)
}

/// A line cut where it runs past [width] columns, the rows after the first starting with the wrap
/// sign (fzf's preview with `wrap`).
fn char_wrap(line: &Line<'static>, width: usize, sign: &str) -> Vec<Line<'static>> {
    let sign_w = sign.width();
    let mut rows: Vec<Vec<Span<'static>>> = vec![Vec::new()];
    let (mut used, mut room) = (0usize, width);
    for span in &line.spans {
        for c in span.content.chars() {
            let cw = unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
            if used + cw > room && used > 0 {
                rows.push(vec![Span::styled(sign.to_string(), Style::default().add_modifier(Modifier::DIM))]);
                used = 0;
                room = width.saturating_sub(sign_w).max(1);
            }
            rows.last_mut().unwrap().push(Span::styled(c.to_string(), span.style));
            used += cw;
        }
    }
    rows.into_iter().map(Line::from).collect()
}

/// The preview window (printPreview): its box in --preview-window's border and the preview-border
/// colour, its label on the box's line where --preview-label-pos puts it (centred; hn's label is
/// the row's own unless --preview-label says), the text in preview-fg on preview-bg — hn's own
/// text wrapped at spaces, or fzf's `wrap` (the wrap sign after the cut, the lines counted as
/// they were) or `nowrap` (cut) — from where +N or follow put it; the scrollbar's column in
/// preview-scrollbar, its thumb when the text runs past, and (info) its N/M.
fn preview(buf: &mut Buffer, app: &App, kind: &PickerKind, picker: &Picker, pb: &PreviewBox) {
    let pal = theme::fzf().pal;
    let o = theme::fzf_opts();
    let pw = &pb.opts;
    let area = pb.rect;
    let w = area.width;
    for y in area.y..area.y + area.height {
        for x in area.x..area.x + w { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } }
    }
    // The window in preview-bg (its blanks in the default colour, as fzf clears them); the text in
    // preview-fg where it has no colour of its own.
    let text_fg = pal.preview.style().fg;
    buf.set_style(area, Style { fg: Some(Color::Reset), ..pal.preview.style() });
    draw_box(buf, area, &pb.shape, pal.preview_border.style());
    let inner = pb.inner;
    let (bt, br, bb, bl) = shape_sides(&pb.shape);
    let _ = (br, bl);
    // The scrollbar's column: blank in its colour until a thumb is drawn there.
    let scrollbar = o.preview_scrollbar.clone();
    if scrollbar.is_some() { for y in inner.y..inner.y + inner.height { buf.set_string(pb.bar_x, y, " ", pal.preview_scrollbar.style()) } }
    let Some(id) = picker.current_id() else { return };
    // printLabel on the box's line (a shape with one).
    let has_line = bt || bb;
    if has_line {
        let text = match &o.preview_label {
            Some(l) => l.clone(),
            None => format!(" {} ", clip(&picker.current().map(|r| r.label.clone()).unwrap_or_default(), (w as usize).saturating_sub(6))),
        };
        let len = text.width() as i64;
        if len > 0 {
            let ww = w as i64;
            let (column, at_bottom) = o.preview_label_pos;
            let col = if column == 0 { ((ww - len) / 2).max(0) } else if column < 0 { (ww + column + 1 - len).max(0) } else { (column - 1).min(ww - len) };
            let row = if pb.shape == "bottom" || at_bottom || !bt { area.y + area.height - 1 } else { area.y };
            let text = if len > ww { let ell = o.ellipsis.clone(); trim_right(&text, (ww - ell.width() as i64) as i32) + &ell } else { text };
            if col >= 0 { buf.set_stringn(area.x + col as u16, row, &text, (ww - col).max(0) as usize, pal.preview_label.style()); }
        }
    }
    // A harness that is on screen somewhere: its terminal, live.
    if matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) {
        let key = id.split('#').next().unwrap_or(&id);
        if let Some((m, a)) = key.split_once(':') {
            // Open in any of this client's sessions: its screen as that pane has it.
            if let Some((_, _, pane_id)) = app.find_pane_anywhere(m, a) {
                if let Some(pane) = app.panes.get(&pane_id) {
                    if matches!(pane.phase, Phase::Live | Phase::Watching(_)) { preview_grid(buf, pane, inner, picker.preview_scroll.get()); return }
                }
            }
        }
    }
    let (iw, height) = (inner.width as usize, inner.height as usize);
    let text = crate::preview::lines(app, kind, &id);
    let fzf_wrap = pw.wrap == Some(true);
    // fzf's preview does not wrap unless told (a buffer's text is as it is); hn's own notes about a
    // harness, a machine or a command do, where nothing says otherwise.
    let lines: Vec<Line> = match pw.wrap { None if !matches!(kind, PickerKind::Buffers) => text.into_iter().flat_map(|l| wrap_line(l, iw)).collect(), _ => text };
    let total = lines.len();
    let header = if pw.header_lines < total.min(height) { pw.header_lines } else { 0 };
    let body_height = height.saturating_sub(header);
    let first_body = pw.header_lines.min(u16::MAX as usize);
    // Explicit +N wins over hn's initial position at a conversation's latest turn. When
    // an asynchronous tail first arrives, apply it to those lines rather than the placeholder.
    let bottom_up = crate::preview::bottom_up(app, kind, &id);
    let fresh = picker.preview_fresh.replace(false);
    if fresh { *picker.preview_bottom.borrow_mut() = None }
    let new_tail = bottom_up && picker.preview_bottom.borrow().as_deref() != Some(id.as_str());
    if new_tail { *picker.preview_bottom.borrow_mut() = Some(id.clone()) }
    let auto_bottom = bottom_up && pw.scroll.is_empty();
    if fresh || new_tail {
        picker.preview_following.set(pw.follow || auto_bottom);
        if !pw.follow {
            let offset = scroll_offset(&pw.scroll, height.saturating_sub(first_body)).unwrap_or(first_body);
            picker.preview_scroll.set(offset.min(total.saturating_sub(1)).max(first_body).min(u16::MAX as usize) as u16);
        }
    }
    let reposition = picker.preview_reposition.replace(false);
    if reposition {
        let offset = scroll_offset(&pw.scroll, height.saturating_sub(first_body)).unwrap_or(first_body);
        picker.preview_scroll.set(offset.min(total.saturating_sub(1)).max(first_body).min(u16::MAX as usize) as u16);
        picker.preview_following.set(pw.follow);
    }
    // Following advances on new preview output. A change-preview-window scroll expression
    // takes effect immediately, even when follow remains enabled for future output.
    if !reposition && (fresh || new_tail || total != picker.preview_lines.get()) && (pw.follow || auto_bottom) && picker.preview_following.get() { picker.preview_scroll.set(picker.preview_scroll.get().max(total.saturating_sub(body_height).min(u16::MAX as usize) as u16)) }
    // ~N stays at the top; scrolling and paging operate on the remaining body.
    let draw_from = |offset: usize, room: usize| -> (Vec<Line<'static>>, bool) {
        let mut rows = Vec::new();
        for line in lines.iter().skip(offset) {
            let parts = if fzf_wrap { char_wrap(line, iw, &o.wrap_sign) } else { vec![line.clone()] };
            for p in parts { if rows.len() >= room { return (rows, true) } rows.push(p) }
        }
        (rows, false)
    };
    let (_, filled_at_top) = draw_from(header, body_height);
    let scrollable = height > 0 && (total > height || (fzf_wrap && filled_at_top) || picker.preview_scroll.get() as usize > first_body);
    let most = if scrollable { total.saturating_sub(1).max(first_body).min(u16::MAX as usize) as u16 } else { first_body as u16 };
    picker.preview_min.set(first_body as u16);
    picker.preview_max.set(most);
    picker.preview_lines.set(total);
    picker.preview_rows.set(inner.height);
    let offset = picker.preview_scroll.get().max(first_body as u16).min(most) as usize;
    let (mut rows, _) = draw_from(0, header);
    let (body, _) = draw_from(if header == 0 { offset.saturating_sub(first_body) } else { offset }, body_height);
    rows.extend(body);
    for (i, line) in rows.into_iter().enumerate() {
        let line = Line::from(line.spans.into_iter().map(|sp| { let st = if sp.style.fg.is_none() { Style { fg: text_fg, ..sp.style } } else { sp.style }; Span::styled(sp.content, st) }).collect::<Vec<_>>());
        buf.set_line(inner.x, inner.y + i as u16, &line, inner.width);
    }
    // The scrollbar covers only the body below fixed headers.
    picker.preview_bar.set(None);
    let body_total = total.saturating_sub(header);
    // fzf updates the scrollbar below ~N only. If an action adds fixed headers without
    // resizing the window, its existing cells above that point are retained too.
    let mut bar_cells = picker.preview_bar_cells.borrow_mut();
    if bar_cells.0 != inner || bar_cells.1.len() != height { *bar_cells = (inner, vec![false; height]) }
    for mark in bar_cells.1.iter_mut().skip(first_body) { *mark = false }
    if let (Some(_), true) = (&scrollbar, body_total > body_height && body_height > 0 && first_body < height) {
        let thumb = (body_height * body_height / body_total).max(1);
        picker.preview_bar.set(Some((pb.bar_x, inner.y + header as u16, body_height, body_total, thumb)));
        let at = offset.saturating_sub(header).min(body_total - body_height);
        let start = ((body_height - thumb) * at / (body_total - body_height)).min(body_height - thumb);
        for i in 0..thumb { bar_cells.1[header + start + i] = true }
    }
    if let Some(bar) = &scrollbar { for (row, marked) in bar_cells.1.iter().enumerate() { if *marked { buf.set_string(pb.bar_x, inner.y + row as u16, bar, pal.preview_scrollbar.style()); } } }
    // The preview offset is a quiet label; exact tmux/fzf appearance keeps its inverse style.
    let mark = format!("{}/{}", offset + 1, total);
    if scrollable && pw.info && (mark.width() as u16) < inner.width {
        buf.set_string(inner.x + inner.width - mark.width() as u16, inner.y, &mark, pal.info.style().add_modifier(if app.options.tmux_look() { Modifier::REVERSED } else { Modifier::BOLD }));
    }
}

/// A pane's terminal, drawn into a preview box: its bottom, where the work is.
fn preview_grid(buf: &mut Buffer, pane: &Pane, area: Rect, scroll: u16) {
    let content = pane.term.renderable_content();
    let colors = content.colors;
    let rows = pane.rows as i32;
    // The rows that end at the cursor (an agent's prompt), not a screen's blank bottom.
    let cursor = content.cursor.point.line.0.max(0);
    let spare = (rows - area.height as i32).max(0);
    let first = (cursor + 1 - area.height as i32 - scroll as i32).clamp(0, spare);
    for indexed in content.display_iter {
        let row = indexed.point.line.0 - first;
        let col = indexed.point.column.0 as u16;
        if row < 0 || row as u16 >= area.height || col >= area.width { continue }
        let cell = indexed.cell;
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) { continue }
        let (fg_color, dim) = map_color(cell.fg, colors, true);
        let (bg_color, _) = map_color(cell.bg, colors, false);
        let mut style = Style::default().fg(fg_color).bg(bg_color);
        if cell.flags.contains(Flags::BOLD) { style = style.add_modifier(Modifier::BOLD) }
        if cell.flags.contains(Flags::DIM) || dim { style = style.add_modifier(Modifier::DIM) }
        if cell.flags.contains(Flags::INVERSE) { style = style.add_modifier(Modifier::REVERSED) }
        if cell.flags.contains(Flags::ITALIC) { style = style.add_modifier(Modifier::ITALIC) }
        if cell.flags.intersects(Flags::ALL_UNDERLINES) { style = style.add_modifier(Modifier::UNDERLINED) }
        if cell.flags.contains(Flags::STRIKEOUT) { style = style.add_modifier(Modifier::CROSSED_OUT) }
        if let Some(t) = buf.cell_mut((area.x + col, area.y + row as u16)) { t.set_char(shown_char(cell.c)).set_style(style); }
    }
}

// ── tmux modes ───────────────────────────────────────────────────────────────

/// screen_write_preview: [pane]'s screen into [nx] × [ny] cells at (x, y) — around its cursor
/// when the cursor is shown (a third of the way in, held to the screen), else from the top left,
/// the cursor's cell reversed.
pub fn screen_preview(buf: &mut Buffer, pane: &Pane, x: u16, y: u16, nx: u16, ny: u16) {
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::index::{Column, Line};
    let grid = pane.term.grid();
    let (sx, sy) = (grid.columns() as u16, grid.screen_lines() as u16);
    let shown = pane.term.mode().contains(TermMode::SHOW_CURSOR);
    let cur = grid.cursor.point;
    let (cx, cy) = (cur.column.0 as u16, cur.line.0.max(0) as u16);
    let (px, py) = if shown {
        let mut px = if cx < nx / 3 { 0 } else { cx - nx / 3 };
        if px + nx > sx { px = if nx > sx { 0 } else { sx - nx } }
        let mut py = if cy < ny / 3 { 0 } else { cy - ny / 3 };
        if py + ny > sy { py = if ny > sy { 0 } else { sy - ny } }
        (px, py)
    } else { (0, 0) };
    let colors = pane.term.colors();
    let style_of = |cell: &alacritty_terminal::term::cell::Cell| {
        let (fg, dim) = map_color(cell.fg, colors, true);
        let (bg, _) = map_color(cell.bg, colors, false);
        let mut st = Style::default().fg(fg).bg(bg);
        if cell.flags.contains(Flags::BOLD) { st = st.add_modifier(Modifier::BOLD) }
        if cell.flags.contains(Flags::DIM) || dim { st = st.add_modifier(Modifier::DIM) }
        if cell.flags.contains(Flags::INVERSE) { st = st.add_modifier(Modifier::REVERSED) }
        if cell.flags.contains(Flags::ITALIC) { st = st.add_modifier(Modifier::ITALIC) }
        if cell.flags.intersects(Flags::ALL_UNDERLINES) { st = st.add_modifier(Modifier::UNDERLINED) }
        if cell.flags.contains(Flags::STRIKEOUT) { st = st.add_modifier(Modifier::CROSSED_OUT) }
        st
    };
    // screen_write_fast_copy: each line's cells, a wide one that would cross the edge left out.
    for j in 0..ny {
        let yy = py + j;
        if yy >= sy { break }
        let row = &grid[Line(yy as i32)];
        let mut out = 0u16;
        for xx in px..(px + nx).min(sx) {
            let cell = &row[Column(xx as usize)];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) { out += 1; continue }
            let w = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
            if xx + w > px + nx { break }
            if let Some(t) = buf.cell_mut((x + out, y + j)) { t.set_char(shown_char(cell.c)).set_style(style_of(cell)); }
            out += 1;
        }
    }
    if shown && cx >= px && cy >= py && cx < px + nx && cy < py + ny && cx < sx && cy < sy {
        let cell = &grid[Line(cy as i32)][Column(cx as usize)];
        if let Some(t) = buf.cell_mut((x + cx - px, y + cy - py)) { t.set_char(shown_char(cell.c)).set_style(style_of(cell).add_modifier(Modifier::REVERSED)); }
    }
}

/// tmux's big digits (clock-mode, display-panes): 5 wide, 5 tall, drawn as coloured blocks.
const DIGITS: [[&str; 5]; 14] = [
    ["xxxxx", "x...x", "x...x", "x...x", "xxxxx"], ["....x", "....x", "....x", "....x", "....x"],
    ["xxxxx", "....x", "xxxxx", "x....", "xxxxx"], ["xxxxx", "....x", "xxxxx", "....x", "xxxxx"],
    ["x...x", "x...x", "xxxxx", "....x", "....x"], ["xxxxx", "x....", "xxxxx", "....x", "xxxxx"],
    ["xxxxx", "x....", "xxxxx", "x...x", "xxxxx"], ["xxxxx", "....x", "....x", "....x", "....x"],
    ["xxxxx", "x...x", "xxxxx", "x...x", "xxxxx"], ["xxxxx", "x...x", "xxxxx", "....x", "xxxxx"],
    [".....", "..x..", ".....", "..x..", "....."],
    ["xxxxx", "x...x", "xxxxx", "x...x", "x...x"], ["xxxxx", "x...x", "xxxxx", "x....", "x...."],
    ["x...x", "xx.xx", "x.x.x", "x...x", "x...x"],
];

/// display-panes (C-b q), as cmd_display_panes_draw_pane draws it: each pane's index in the
/// middle of its content (below its title row), in blocks of display-panes-colour (the active
/// pane's display-panes-active-colour) — as plain digits when the pane is too small — with its
/// size (`80x24`) at the top right of its first line and, for panes 10 to 34, the letter that
/// chooses it under the digits.
fn display_panes(buf: &mut Buffer, app: &App) {
    let focus = app.focused();
    let ids = app.tab().panes();
    let tab_id = app.tab().id.clone();
    let colour = |name: &str, fallback: Color| app.options.get(name, &tab_id, None).and_then(|c| crate::tmuxconf::colour(&c)).unwrap_or(fallback);
    let (normal, active) = (colour("display-panes-colour", theme::TMUX_DISPLAY_PANES), colour("display-panes-active-colour", theme::TMUX_DISPLAY_PANES_ACTIVE));
    for (id, rect) in &app.rects {
        if !app.panes.contains_key(id) { continue }
        let pane = ids.iter().position(|p| p == id).unwrap_or(0) + app.pane_base(app.active);
        let c = app.content_of(app.tab(), *rect);
        let (xoff, yoff, sx, sy) = (c.x as i32, c.y as i32, c.width as i32, c.height as i32);
        let num = pane.to_string();
        let len = num.len() as i32;
        if sx < len { continue }
        let colour = if Some(*id) == focus { active } else { normal };
        let fg = Style::default().fg(colour);
        let size = format!("{}x{}", c.width, c.height);
        let letter = if (10..35).contains(&pane) { ((b'a' + (pane - 10) as u8) as char).to_string() } else { String::new() };
        let (mut px, mut py) = (sx / 2, sy / 2);
        let put = |buf: &mut Buffer, x: i32, y: i32, text: &str, style: Style| { if x >= 0 && y >= 0 { buf.set_string(x as u16, y as u16, text, style); } };
        if sx < len * 6 || sy < 5 {
            let llen = letter.len() as i32;
            let text = if sx >= len + llen + 1 && llen > 0 { format!("{num} {letter}") } else { num.clone() };
            let width = text.len() as i32;
            put(buf, xoff + px - width / 2, yoff + py, &text, fg);
            continue;
        }
        px -= len * 3;
        py -= 2;
        for ch in num.chars() {
            let Some(d) = ch.to_digit(10) else { continue };
            for (j, row) in DIGITS[d as usize].iter().enumerate() {
                for (i, bit) in row.chars().enumerate() {
                    if bit == 'x' { if let Some(cell) = buf.cell_mut(((xoff + px + i as i32) as u16, (yoff + py + j as i32) as u16)) { cell.set_symbol(" ").set_style(Style::default().bg(colour)); } }
                }
            }
            px += 6;
        }
        if sy <= 6 { continue }
        if sx >= size.len() as i32 { put(buf, xoff + sx - size.len() as i32, yoff, &size, fg) }
        if !letter.is_empty() { put(buf, xoff + sx / 2 + len * 3 - letter.len() as i32 - 1, yoff + py + 5, &letter, fg) }
    }
}

/// clock-mode (C-b t), as window_clock_draw_screen draws it: the pane cleared, the time
/// (clock-mode-style 12: `%l:%M AM`) in blocks of clock-mode-colour from the middle — as plain
/// text when the pane is too small for them.
fn clock(buf: &mut Buffer, app: &App, rect: Rect) {
    crate::term_out::clear_extras(rect);
    for y in rect.y..rect.y + rect.height { for x in rect.x..rect.x + rect.width { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } } }
    let tab_id = app.tab().id.clone();
    let colour = app.options.get("clock-mode-colour", &tab_id, None).and_then(|c| crate::tmuxconf::colour(&c)).unwrap_or(Color::Blue);
    let (hm, _) = local_time(crate::app::utc_offset());
    let tim = if app.options.get("clock-mode-style", &tab_id, None).as_deref() == Some("12") {
        let h: u32 = hm.get(..2).and_then(|h| h.parse().ok()).unwrap_or(0);
        format!("{:>2}:{} {}", if h % 12 == 0 { 12 } else { h % 12 }, hm.get(3..5).unwrap_or("00"), if h >= 12 { "PM" } else { "AM" })
    } else { hm };
    let (sx, sy, len) = (rect.width as i32, rect.height as i32, tim.len() as i32);
    let put = |buf: &mut Buffer, x: i32, y: i32, style: Style, text: &str| { if x >= 0 && y >= 0 && x < sx && y < sy { buf.set_string(rect.x + x as u16, rect.y + y as u16, text, style); } };
    if sx < 6 * len || sy < 6 {
        if sx >= len && sy != 0 { put(buf, sx / 2 - len / 2, sy / 2, Style::default().fg(colour), &tim) }
        return;
    }
    let (mut x, y) = (sx / 2 - 3 * len, sy / 2 - 3);
    for ch in tim.chars() {
        let idx = match ch { '0'..='9' => ch as usize - '0' as usize, ':' => 10, 'A' => 11, 'P' => 12, 'M' => 13, _ => { x += 6; continue } };
        for (j, row) in DIGITS[idx].iter().enumerate() {
            for (i, bit) in row.chars().enumerate() { if bit == 'x' { put(buf, x + i as i32, y + j as i32, Style::default().bg(colour), " ") } }
        }
        x += 6;
    }
}


fn clip(text: &str, cols: usize) -> String {
    if text.width() <= cols { return text.to_string() }
    if cols == 0 { return String::new() }
    let mut out = String::new();
    for ch in text.chars() {
        if out.width() + unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0) + 1 > cols { break }
        out.push(ch);
    }
    let mut out = out.trim_end().to_string();
    out.push('…');
    out
}




#[allow(dead_code)]
fn _unused(_: &keys::Keymap, _: PromptKind) {}

#[allow(dead_code)]
fn _ago(ms: u64) -> String { ago(ms) }


/// One of the sixteen colours by its name.
fn named16(n: u8) -> Color {
    const ALL: [Color; 16] = [Color::Black, Color::Red, Color::Green, Color::Yellow, Color::Blue, Color::Magenta, Color::Cyan, Color::Gray,
        Color::DarkGray, Color::LightRed, Color::LightGreen, Color::LightYellow, Color::LightBlue, Color::LightMagenta, Color::LightCyan, Color::White];
    ALL[(n & 15) as usize]
}

pub(crate) fn map_color(color: AColor, colors: &alacritty_terminal::term::color::Colors, fg_side: bool) -> (Color, bool) {
    match color {
        AColor::Spec(rgb) => (Color::Rgb(rgb.r, rgb.g, rgb.b), false),
        AColor::Indexed(i) => (colors[i as usize].map(|c| Color::Rgb(c.r, c.g, c.b)).unwrap_or(Color::Indexed(i)), false),
        AColor::Named(named) => {
            let index = named as usize;
            if let Some(c) = colors[index] { return (Color::Rgb(c.r, c.g, c.b), false) }
            match named {
                NamedColor::Foreground | NamedColor::BrightForeground | NamedColor::Background | NamedColor::Cursor => (Color::Reset, false),
                NamedColor::DimForeground => (Color::Reset, fg_side),
                // The sixteen by name, as the program wrote them (30–37, 90–97, as tmux writes
                // them — not 38;5;N, which an eight-colour terminal does not read).
                n if (n as usize) < 16 => (named16(n as u8), false),
                n if (n as usize) >= NamedColor::DimBlack as usize && (n as usize) <= NamedColor::DimWhite as usize => (named16((n as usize - NamedColor::DimBlack as usize) as u8), true),
                _ => (Color::Reset, false),
            }
        }
    }
}

/// The pane's terminal, cell for cell. Returns where the cursor goes when this pane has it.
fn pane_body(buf: &mut Buffer, pane: &mut Pane, area: Rect, active: bool, window: (Option<Color>, Option<Color>)) -> Option<Position> {
    crate::term_out::clear_extras(area);
    if let Some(bg) = window.1 { buf.set_style(area, Style::default().bg(bg)) }
    match &pane.phase {
        // Opening: nothing to show yet. Lost (the machine's link down), the last screen is kept, as
        // ssh and mosh keep it — below.
        Phase::Connecting(note) if pane.last_seq.is_none() => { card(buf, area, &[(note.clone(), Style::default().add_modifier(Modifier::DIM))]); return None }
        Phase::Card { title, detail, keys } => {
            let mut lines = vec![(title.clone(), Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))];
            for row in detail.lines() { lines.push((row.to_string(), Style::default())) }
            lines.push((String::new(), Style::default()));
            lines.push((keys.iter().map(|(k, w)| format!("{k} {w}")).collect::<Vec<_>>().join(" · "), Style::default().add_modifier(Modifier::DIM)));
            card(buf, area, &lines);
            return None;
        }
        _ => {}
    }
    let content = pane.term.renderable_content();
    // A far terminal taller than this tile (a watcher cannot resize it; a resize not answered
    // yet): keep its cursor in view, as a terminal does — for an agent, that is its prompt.
    let cursor_view = content.cursor.point.line.0 + content.display_offset as i32;
    let spare = (pane.rows as i32 - area.height as i32).max(0);
    let shift = if content.display_offset > 0 { 0 } else { (cursor_view - area.height as i32 + 1).clamp(0, spare) };
    let offset = content.display_offset as i32 - shift;
    // Wider than the tile (a pane under the daemon's 40 columns): likewise keep the cursor's column.
    let hspare = (pane.cols as i32 - area.width as i32).max(0);
    let hshift = (content.cursor.point.column.0 as i32 - area.width as i32 + 1).clamp(0, hspare) as u16;
    let colors = content.colors;
    let mode = content.mode;
    let cursor_point = content.cursor.point;
    for indexed in content.display_iter {
        let row = indexed.point.line.0 + offset;
        let Some(col) = (indexed.point.column.0 as u16).checked_sub(hshift) else { continue };
        if row < 0 || row as u16 >= area.height || col >= area.width { continue }
        let cell = indexed.cell;
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) { continue }
        let (mut fg_color, dim_fg) = map_color(cell.fg, colors, true);
        let (mut bg_color, _) = map_color(cell.bg, colors, false);
        if fg_color == Color::Reset { if let Some(c) = window.0 { fg_color = c } }
        if bg_color == Color::Reset { if let Some(c) = window.1 { bg_color = c } }
        let mut style = Style::default();
        let mut mods = Modifier::empty();
        if cell.flags.contains(Flags::BOLD) { mods |= Modifier::BOLD }
        if cell.flags.contains(Flags::ITALIC) { mods |= Modifier::ITALIC }
        if cell.flags.contains(Flags::BLINK) { mods |= Modifier::SLOW_BLINK }
        if cell.flags.intersects(Flags::ALL_UNDERLINES) { mods |= Modifier::UNDERLINED }
        if cell.flags.contains(Flags::DIM) || dim_fg { mods |= Modifier::DIM }
        if cell.flags.contains(Flags::STRIKEOUT) { mods |= Modifier::CROSSED_OUT }
        // Reverse video stays reverse video: the terminal swaps in its own default colours, light
        // theme or dark.
        if cell.flags.contains(Flags::INVERSE) { mods |= Modifier::REVERSED }
        style = style.fg(fg_color).bg(bg_color).add_modifier(mods);
        // The underline's own colour (58), and its style and the cell's link, written as tmux
        // writes them where the terminal reads them.
        if let Some(uc) = cell.underline_color() { style = style.underline_color(map_color(uc, colors, true).0) }
        let underline = if cell.flags.contains(Flags::DOUBLE_UNDERLINE) { 2 } else if cell.flags.contains(Flags::UNDERCURL) { 3 } else if cell.flags.contains(Flags::DOTTED_UNDERLINE) { 4 } else if cell.flags.contains(Flags::DASHED_UNDERLINE) { 5 } else { 0 };
        let link = cell.hyperlink().map(|h| std::sync::Arc::<str>::from(h.uri()));
        let overline = cell.flags.contains(Flags::OVERLINE);
        if underline != 0 || link.is_some() || overline { crate::term_out::set_extra(area.x + col, area.y + row as u16, crate::term_out::Extra { underline, link, overline }) }
        let target = buf.cell_mut((area.x + col, area.y + row as u16));
        let Some(target) = target else { continue };
        // An empty cell, or the tab `ls` aligned a column with (the grid keeps it where the tab
        // jumped from): the blank the screen shows, never the control character itself.
        if shown_char(cell.c) != cell.c {
            target.set_symbol(" ").set_style(style);
            continue;
        }
        // Concealed text stays text (SGR 8, as tmux writes it): the terminal hides it, and a
        // selection in the terminal still copies it.
        if cell.flags.contains(Flags::HIDDEN) { style = style.add_modifier(Modifier::HIDDEN) }
        match cell.zerowidth() {
            Some(extra) if !extra.is_empty() => {
                let mut s = String::with_capacity(8);
                s.push(cell.c);
                s.extend(extra.iter());
                target.set_symbol(&s).set_style(style);
            }
            _ => { target.set_char(cell.c).set_style(style); }
        }
    }
    // The link down: the last screen dimmed, and mosh's one row at the top saying so (and that
    // what you type is kept for it).
    if let Phase::Connecting(note) = &pane.phase {
        let note = if pane.queued.is_empty() { note.clone() } else { format!("{note} — what you typed goes when it is back") };
        let note = &note;
        buf.set_style(area, Style::default().add_modifier(Modifier::DIM));
        let row = Rect::new(area.x, area.y, area.width, 1);
        let notice = Style::default().fg(window.0.unwrap_or(Color::Reset)).bg(window.1.unwrap_or(Color::Reset))
            .remove_modifier(Modifier::DIM | Modifier::REVERSED).add_modifier(Modifier::BOLD);
        buf.set_style(row, notice);
        buf.set_stringn(area.x, area.y, format!("{:w$}", format!(" ! {note}"), w = area.width as usize), area.width as usize, notice);
        return None;
    }
    // Local echo, drawn over the grid: underlined until the far side confirms it.
    for (col, row, c, _) in pane.shown_predictions() {
        let row = (*row as i32 - shift).max(0) as u16;
        let Some(col) = &col.checked_sub(hshift) else { continue };
        if let Some(cell) = buf.cell_mut((area.x + col, area.y + row)) {
            if *col < area.width && row < area.height { cell.set_char(*c).set_style(Style::default().add_modifier(Modifier::UNDERLINED)); }
        }
    }
    if pane.scrolled() > 0 || !active { return None }
    if let Some((col, row, _, _)) = pane.shown_predictions().last() {
        let row = (*row as i32 - shift).max(0) as u16;
        let col = &col.saturating_sub(hshift);
        if col + 1 < area.width && row < area.height { return Some(Position::new(area.x + col + 1, area.y + row)) }
    }
    if pane.dead.is_some() || !mode.contains(TermMode::SHOW_CURSOR) || matches!(pane.phase, Phase::Watching(_)) { return None }
    let row = cursor_point.line.0 + offset;
    let col = (cursor_point.column.0 as u16).saturating_sub(hshift);
    (row >= 0 && (row as u16) < area.height && col < area.width).then(|| Position::new(area.x + col, area.y + row as u16))
}

/// A grid cell's character as it is drawn: alacritty keeps a tab in the cell a tab jumped from (so
/// copying keeps it), and an empty cell holds '\0' — both are the blank the screen shows. Drawn as
/// they are, a tab would reach the terminal and move its cursor to the next tab stop.
pub fn shown_char(c: char) -> char { if c == '\0' || c.is_control() { ' ' } else { c } }

fn card(buf: &mut Buffer, area: Rect, lines: &[(String, Style)]) {
    let top = area.y + area.height.saturating_sub(lines.len() as u16) / 2;
    for (index, (text, style)) in lines.iter().enumerate() {
        let y = top + index as u16;
        if y >= area.y + area.height { break }
        let w = (text.width() as u16).min(area.width);
        let x = area.x + area.width.saturating_sub(w) / 2;
        buf.set_stringn(x, y, text, area.width as usize, *style);
    }
}

#[cfg(test)]
mod tab_cell_tests {
    use super::*;

    #[test]
    fn a_tab_in_a_pane_is_drawn_as_the_blank_it_stands_for() {
        // `ls` aligns its columns with tabs; the pane's grid keeps the tab in the cell it jumped from.
        let mut pane = crate::pane::Pane::new(1, "m", "a", 20, 2);
        pane.phase = crate::pane::Phase::Live;
        pane.feed(b"ab\tc");
        let area = Rect::new(0, 0, 20, 2);
        let mut buf = Buffer::empty(area);
        pane_body(&mut buf, &mut pane, area, true, (None, None));
        let row: String = (0..20).map(|x| buf[(x, 0)].symbol().to_string()).collect();
        assert!(!row.contains('\t'), "a tab reached the frame: {row:?}");
        assert_eq!(&row[..9], "ab      c");
    }
}

#[cfg(test)]
mod fzf_info_tests {
    use super::{repeat_to_fill, trim_message};

    /// printInfoImpl's pieces: the count cut as trimMessage cuts it, the separator repeated to
    /// fill as RepeatToFill does.
    #[test]
    fn info_cut_and_filled_as_fzf_does() {
        assert_eq!(trim_message("0/100", 5), "0/100");
        assert_eq!(trim_message("0/100", 4), "0/..");
        assert_eq!(trim_message("0/100", 3), "0..");
        assert_eq!(trim_message("0/100", 1), ".");
        assert_eq!(trim_message("0/100", -2), "");
        assert_eq!(repeat_to_fill("-=", 5), "-=-=-");
        assert_eq!(repeat_to_fill("─", 3), "───");
        assert_eq!(repeat_to_fill("abc", 2), "ab");
    }
}

#[cfg(test)]
mod fzf_list_tests {
    use super::*;
    use crate::picker::Row;

    /// The ellipsis takes what fzf's colour offsets leave on it (printHighlighted): under
    /// --no-hscroll whatever was past the cut, a match too; cut only at the end, a part of the
    /// line's own running on under it; scrolled, nothing.
    #[test]
    fn the_ellipsis_in_what_it_covers() {
        let dim = Style::default().add_modifier(Modifier::DIM);
        let line = |lit: &[usize], part: std::ops::Range<usize>| -> Vec<Cell> { "abcdefghijklmnop".chars().enumerate().map(|(i, c)| (c, part.contains(&i).then_some(dim), lit.contains(&i))).collect() };
        let tail = |cells: Vec<Cell>| cells[8..].to_vec();
        // --no-hscroll: a match past the cut lights both dots; one on the first dot's cell, that one.
        assert_eq!(tail(hscroll(line(&[14], 0..0), 10, "··", false, 10, false)), [('·', None, true), ('·', None, true)]);
        assert_eq!(tail(hscroll(line(&[8], 0..0), 10, "··", false, 10, false)), [('·', None, true), ('·', None, false)]);
        // Cut at the end: a dim part running on under the dots dims them.
        assert_eq!(tail(hscroll(line(&[0], 5..16), 10, "··", true, 10, false)), [('·', Some(dim), false), ('·', Some(dim), false)]);
        assert_eq!(tail(hscroll(line(&[0], 5..9), 10, "··", true, 10, false)), [('·', Some(dim), false), ('·', None, false)]);
        // Scrolled to a match at the end: the dots are the row's own.
        assert_eq!(hscroll(line(&[15], 0..16), 10, "··", true, 10, false)[..2], [('·', None, false), ('·', None, false)]);
    }

    fn screen(p: &mut Picker) -> String {
        let area = Rect::new(0, 0, 40, 10);
        let mut buf = Buffer::empty(area);
        fzf(&mut buf, area, p, &PickerKind::Output { title: String::new(), lines: vec![] }, false, Style::default());
        (0..area.height).map(|y| (0..area.width).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    /// A list with nothing in it says why; one the query emptied is blank, as fzf's is, and so is
    /// one still loading (its spinner says so).
    #[test]
    fn a_list_the_query_emptied_is_blank() {
        let mut p = Picker::new("t", "");
        p.empty = "(empty)".into();
        assert!(screen(&mut p).contains("(empty)"));
        p.busy = Some("loading".into());
        assert!(!screen(&mut p).contains("(empty)"));
        p.busy = None;
        p.set_rows(vec![Row::new("a", "alpha")]);
        p.set_query("zzz");
        assert!(!screen(&mut p).contains("(empty)"));
    }

    #[test]
    fn only_loading_pickers_ask_for_animation_frames() {
        let mut p = Picker::new("t", "");
        for busy in [false, true, false] {
            theme::begin_animation_frame(true);
            p.busy = busy.then(|| "loading".into());
            screen(&mut p);
            assert_eq!(theme::needs_animation_frame(), busy);
        }
        theme::begin_animation_frame(false);
        p.busy = Some("loading".into());
        screen(&mut p);
        assert!(!theme::needs_animation_frame());
    }
}

#[cfg(test)]
mod theme_render_tests {
    use super::*;
    use crate::app::App;
    use crate::modal;

    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (150, 42));
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(crate::fleet::Machine {
            id: "local".into(), name: "studio".into(), local: true, status: "online".into(), reach: crate::fleet::Reach::Ready,
        });
        app.homes.insert("local".into(), "/home/dev".into());
        app
    }

    fn screen(app: &mut App) -> String {
        let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(150, 42)).unwrap();
        term.draw(|f| draw(f, app)).unwrap();
        let buf = term.backend().buffer().clone();
        (0..42).map(|y| (0..150).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    /// `theme` opens the settings panel over the window (not fzf's full-screen list), and a key
    /// into a section shows that section's options — which a fleet refresh leaves open.
    #[test]
    fn theme_draws_the_settings_panel_and_a_refresh_keeps_its_section() {
        let mut app = app();
        crate::input::run(&mut app, "theme");
        let s = screen(&mut app);
        assert!(s.contains("Appearance") && s.contains("Pane titles") && s.contains("Preview"), "{s}");
        crate::input::modal_key(&mut app, crossterm::event::KeyEvent::new(crossterm::event::KeyCode::Enter, crossterm::event::KeyModifiers::NONE));
        crate::input::refill(&mut app);
        let s = screen(&mut app);
        for v in ["off", "top", "bottom"] { assert!(s.contains(v), "{v} missing after a refresh:\n{s}") }
        let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!("closed") };
        assert_eq!(picker.theme_in.as_deref(), Some("status"));
        let _ = modal::theme_sections(&app);
    }

    /// The launcher with long rows — harnesses in several projects on several machines, whose
    /// right column (project, machine, age) is wider than the list — stays inside its panel, before
    /// and after `@` then ⌫; `@` lands on the machine you are on, its preview beside it.
    #[test]
    fn long_rows_stay_in_the_panel_and_at_lands_on_this_machine() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _in = rt.enter();
        let mut app = app();
        app.fleet.machines.push(crate::fleet::Machine { id: "far".into(), name: "Macbooks-MacBook-Pro-5.local".into(), local: false, status: "online".into(), reach: crate::fleet::Reach::Ready });
        for (i, (name, project, m)) in [("autonomous-harness", "autonomous-harness", "far"), ("grid-mac-lmstudio3", "autonomous-grid", "far"), ("grid-mac-ollama", "autonomous-grid", "local")].iter().enumerate() {
            let a = crate::fleet::agent_from(m, &serde_json::json!({"id": format!("a{i}"), "name": name, "engine": "claude", "state": "idle", "cwd": format!("/home/dev/{project}"), "project": {"name": project}}), None);
            app.fleet.agents.insert((m.to_string(), format!("a{i}")), a);
        }
        let outside = |app: &mut App| -> Vec<String> {
            let s = screen(app);
            let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!("closed") };
            let r = picker.screen_area.get();
            s.lines().enumerate().filter(|(y, _)| *y as u16 >= r.y && (*y as u16) < r.bottom())
                .filter_map(|(_, l)| { let left: String = l.chars().take(r.x as usize).collect(); let right: String = l.chars().skip(r.right() as usize).collect(); (!left.trim().is_empty() || !right.trim().is_empty()).then(|| l.to_string()) })
                .collect()
        };
        crate::commands::execute_bound(&mut app, "choose-tree -Zs");
        assert!(outside(&mut app).is_empty(), "{:?}", outside(&mut app));
        crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Char('@'), KeyModifiers::NONE));
        assert!(outside(&mut app).is_empty());
        {
            let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!("closed") };
            assert_eq!(picker.current_id().as_deref(), Some("local"), "on the machine you are on");
            assert!(picker.preview_area.get().is_some());
        }
        crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));
        assert!(outside(&mut app).is_empty(), "{:?}", outside(&mut app));
    }

    /// A chosen theme is the panes' too: the sixteen colours a program names take the theme's
    /// palette (red is Dracula's red), and a colour given exactly stays as it was.
    #[test]
    fn a_theme_gives_the_panes_its_sixteen_colours() {
        let t = crate::terminal_themes::TERMINAL_THEMES.iter().find(|t| t.name == "Dracula").unwrap();
        let area = Rect::new(0, 0, 3, 1);
        let mut buf = Buffer::empty(area);
        buf[(0, 0)].set_fg(Color::Red);
        buf[(1, 0)].set_fg(Color::Indexed(12)).set_bg(Color::Black);
        buf[(2, 0)].set_fg(Color::Rgb(1, 2, 3));
        theme_ansi(&mut buf, area, t);
        assert_eq!(buf[(0, 0)].fg, theme::depth_fit(rgb(t.palette[1])));
        assert_eq!((buf[(1, 0)].fg, buf[(1, 0)].bg), (theme::depth_fit(rgb(t.palette[12])), theme::depth_fit(rgb(t.palette[0]))));
        assert_eq!(buf[(2, 0)].fg, Color::Rgb(1, 2, 3));
    }

    /// The home screen follows a chosen theme: the wordmark in its accent, the screen on its
    /// background; with no theme, the terminal's own background stays.
    #[test]
    fn the_home_screen_follows_the_theme() {
        let _colours = crate::term_out::colours_lock();
        let mut app = app();
        let bg_at = |app: &mut App| {
            let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(150, 42)).unwrap();
            term.draw(|f| draw(f, app)).unwrap();
            let buf = term.backend().buffer().clone();
            (buf[(1, 1)].bg, (0..42).flat_map(|y| (0..150).map(move |x| (x, y))).find(|p| buf[*p].symbol() == "█").map(|p| buf[p].fg))
        };
        let (plain, _) = bg_at(&mut app);
        assert_eq!(plain, Color::Reset, "no theme: the terminal's own background");
        let _ = app.set_look("theme", "Adwaita Dark");
        let t = crate::terminal_themes::TERMINAL_THEMES.iter().find(|t| t.name == "Adwaita Dark").unwrap();
        let (themed, logo) = bg_at(&mut app);
        assert_eq!(themed, theme::depth_fit(Color::Rgb(t.background[0], t.background[1], t.background[2])));
        assert_eq!(logo, Some(theme::depth_fit(theme::accent())), "the wordmark in the theme's accent");
        let _ = app.set_look("theme", "");
    }

    /// C-b s opens the launcher in the panel (over the window, not full screen), with the scopes
    /// it switches between; typing `@` switches to the machines in the same place, with the
    /// row's preview beside the list; `>` to the commands.
    #[test]
    fn the_launcher_and_its_scopes_are_panels_with_previews() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        // (Switching lists asks machines for theirs, in the background.)
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _in = rt.enter();
        let mut app = app();
        crate::commands::execute_bound(&mut app, "choose-tree -Zs");
        let s = screen(&mut app);
        assert!(s.contains("Harnesses") && s.contains("> commands") && s.contains("@ machines") && s.contains("? help"), "{s}");
        let (at, kind0) = match &app.modal { Some(Modal::Picker { picker, kind }) => (picker.screen_area.get(), std::mem::discriminant(kind)), _ => panic!("no panel") };
        assert!(at.width < 150, "a panel, not the whole screen");
        crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Char('@'), KeyModifiers::NONE));
        let s = screen(&mut app);
        let Some(Modal::Picker { picker, kind }) = &app.modal else { panic!("closed") };
        assert!(matches!(kind, PickerKind::Machines) && std::mem::discriminant(kind) != kind0);
        assert_eq!(picker.screen_area.get(), at, "same place");
        assert!(s.contains("Machines") && s.contains("studio"), "{s}");
        assert!(picker.preview_area.get().is_some(), "the machine's preview beside the list");
        crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));
        crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Char('>'), KeyModifiers::NONE));
        let _ = screen(&mut app);
        let Some(Modal::Picker { kind, .. }) = &app.modal else { panic!("closed") };
        assert!(matches!(kind, PickerKind::Palette));
    }

    /// Typing in a section puts the cursor on the best match, not where the current value was;
    /// hn's own commands show the key that runs them.
    #[test]
    fn typing_goes_to_the_best_match_and_commands_show_their_keys() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let _colours = crate::term_out::colours_lock();
        let mut app = app();
        let _ = app.set_look("theme", "Aizen Dark");
        crate::input::run(&mut app, "theme");
        // (Theme is the third section: Pane titles, Focus, Theme.)
        for code in [KeyCode::Down, KeyCode::Down, KeyCode::Right] { crate::input::modal_key(&mut app, KeyEvent::new(code, KeyModifiers::NONE)) }
        {
            let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!("closed") };
            assert_eq!(picker.current_id().as_deref(), Some("theme:Aizen Dark"), "a section opens on the value in use");
        }
        for c in "adwaita".chars() { crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)) }
        let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!("closed") };
        assert_eq!(picker.current_id().as_deref(), Some("theme:Adwaita"));
        let _ = app.set_look("theme", "");
        let rows = modal::command_rows(&app);
        let key = |id: &str| rows.iter().find(|r| r.id == id).map(|r| r.right.clone()).unwrap_or_default();
        assert_eq!(key("cmd:new"), "C-b N");
        assert_eq!(key("cmd:theme"), "C-b Enter");
        assert_eq!(key("cmd:split-right"), "C-b %");
    }

    /// C-b Enter lists commands in the same panel; typing narrows it, Enter on Settings turns the
    /// panel into the settings (same place), and Esc steps back to the commands. C-b Space stays
    /// tmux's next-layout.
    #[test]
    fn enter_opens_commands_and_settings_open_in_place() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = app();
        let bound = |code: KeyCode| app.keymap.prefix_table.iter().find(|b| b.chord.code == code).map(|b| b.command.clone());
        assert_eq!(bound(KeyCode::Enter).as_deref(), Some("choose-command"));
        assert_eq!(bound(KeyCode::Char(' ')).as_deref(), Some("next-layout"));
        crate::commands::execute_bound(&mut app, "choose-command");
        let s = screen(&mut app);
        assert!(s.contains("Commands") && s.contains("New harness"), "{s}");
        let at = match &app.modal { Some(Modal::Picker { picker, .. }) => picker.screen_area.get(), _ => panic!("no panel") };
        // (A few letters are enough: the best match comes first.)
        for c in "appe".chars() { crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)) }
        let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!("closed") };
        assert_eq!(picker.current_id().as_deref(), Some("cmd:theme"), "Appearance ranks first for `appe`");
        crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let s = screen(&mut app);
        assert!(s.contains("Pane titles") && s.contains("Preview"), "{s}");
        let Some(Modal::Picker { kind, picker }) = &app.modal else { panic!("closed") };
        assert!(matches!(kind, PickerKind::Theme) && picker.from_commands);
        // (The commands a palette; Appearance, with its preview, the large panel around it.)
        let large = picker.screen_area.get();
        assert!(large.width > at.width && large.contains(at.as_position()), "{at:?} in {large:?}");
        crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        let s = screen(&mut app);
        let Some(Modal::Picker { kind, picker }) = &app.modal else { panic!("Esc closed it") };
        assert!(matches!(kind, PickerKind::Commands), "{s}");
        assert_eq!(picker.current_id().as_deref(), Some("cmd:theme"));
        assert_eq!(picker.screen_area.get(), at, "back in the palette's place");
    }

    // ── tabs ──

    /// The launcher's tab row: ↓ past the list's last row goes onto it; there ←/→ open the next
    /// tab (round from the last to the first), ↑ goes back to the list, and a key typed searches
    /// the tab chosen. The panel keeps its size from tab to tab.
    #[test]
    fn down_past_the_list_goes_onto_the_tabs_and_arrows_switch_them() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        // (A tab opened fetches what it lists, as it does when typed.)
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _in = rt.enter();
        let mut app = app();
        let key = |app: &mut App, code: KeyCode| crate::input::modal_key(app, KeyEvent::new(code, KeyModifiers::NONE));
        let now =|app: &App| match &app.modal { Some(Modal::Picker { kind, picker }) => (kind.clone(), picker.on_tabs, picker.query.clone()), _ => panic!("closed") };
        crate::input::run(&mut app, "open");
        screen(&mut app);
        let (rows, at) = match &app.modal { Some(Modal::Picker { picker, .. }) => (picker.visible.len(), picker.screen_area.get()), _ => panic!("no panel") };
        // (As many ↓ as rows and one more: past the last row, onto the tabs; another stays there.)
        for _ in 0..=rows + 1 { key(&mut app, KeyCode::Down) }
        assert!(now(&app).1, "on the tabs");
        let s = screen(&mut app);
        assert!(s.contains("← → switch") && s.contains("harnesses"), "{s}");
        key(&mut app, KeyCode::Right);
        let (kind, tabs, query) = now(&app);
        assert!(matches!(kind, PickerKind::Palette) && tabs && query == ">", "{kind:?} {query}");
        key(&mut app, KeyCode::Right); key(&mut app, KeyCode::Right);
        assert!(matches!(now(&app).0, PickerKind::Projects));
        for _ in 0..3 { key(&mut app, KeyCode::Left) }
        assert!(matches!(now(&app).0, PickerKind::Open { .. }) && now(&app).2.is_empty());
        key(&mut app, KeyCode::Left);
        assert!(matches!(now(&app).0, PickerKind::Help), "round to the last tab");
        screen(&mut app);
        assert_eq!(match &app.modal { Some(Modal::Picker { picker, .. }) => picker.screen_area.get(), _ => panic!() }, at, "the same size on every tab");
        key(&mut app, KeyCode::Right);
        key(&mut app, KeyCode::Up);
        assert!(!now(&app).1, "↑ back to the list");
        // Typed on the tabs: a search in the tab chosen.
        for _ in 0..=rows + 1 { key(&mut app, KeyCode::Down) }
        for _ in 0..3 { key(&mut app, KeyCode::Right) }
        key(&mut app, KeyCode::Char('w'));
        let (kind, tabs, query) = now(&app);
        assert!(matches!(kind, PickerKind::Projects) && !tabs && query == "#w", "{kind:?} {query}");
    }

    // ── mouse ──

    /// The mouse over a panel's list: the wheel scrolls the list and the chosen row stays chosen;
    /// the row under the mouse is the one chosen; a key brings the list back to it.
    #[test]
    fn the_wheel_scrolls_a_panel_and_the_mouse_over_a_row_chooses_it() {
        use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers, MouseEvent, MouseEventKind};
        let mut app = app();
        crate::commands::execute_bound(&mut app, "choose-command");
        screen(&mut app);
        let state = |app: &App| match &app.modal { Some(Modal::Picker { picker, .. }) => (picker.cursor, picker.scroll, picker.list_area.get(), picker.row_at.clone()), _ => panic!("closed") };
        let (cursor, scroll, list, _) = state(&app);
        let mouse = |app: &mut App, kind: MouseEventKind, row: u16| crate::input::handle(app, Event::Mouse(MouseEvent { kind, column: list.x + 4, row, modifiers: KeyModifiers::NONE }));
        assert!(app.wants_motion(), "a panel asks for the mouse's moves");
        for _ in 0..3 { mouse(&mut app, MouseEventKind::ScrollDown, list.y + 2) }
        screen(&mut app);
        let (now, scrolled, _, rows) = state(&app);
        assert_eq!(now, cursor, "the wheel does not choose");
        assert!(scrolled > scroll, "the list scrolled: {scroll} → {scrolled}");
        // Over a row: that row is chosen, and the list stays where the wheel left it.
        let (y, vi) = rows[3];
        mouse(&mut app, MouseEventKind::Moved, y);
        screen(&mut app);
        let (now, still, _, _) = state(&app);
        assert_eq!((now, still), (vi, scrolled), "the row under the mouse, the list where it was");
        // A key: the list follows the cursor again.
        for _ in 0..40 { crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)) }
        screen(&mut app);
        assert_eq!(state(&app).1, 0, "back at the top with the cursor");
    }

    /// One click on a panel's row runs it (the mouse over it chose it already): "tmux commands…"
    /// opens tmux's, grouped, in the same panel; Esc comes back to hn's, on that row.
    #[test]
    fn one_click_runs_a_row_and_tmux_commands_open_behind_their_row() {
        use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
        let mut app = app();
        crate::commands::execute_bound(&mut app, "choose-command");
        screen(&mut app);
        let picker = |app: &App| match &app.modal { Some(Modal::Picker { kind, picker }) => (kind.clone(), picker.theme_in.clone(), picker.current_id(), picker.row_at.clone(), picker.list_area.get()), _ => panic!("closed") };
        // To the row, by keys (it may be below the fold), then one click on it.
        for c in "tmux".chars() { crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)) }
        screen(&mut app);
        let (_, _, at, rows, list) = picker(&app);
        assert_eq!(at.as_deref(), Some("cmd:tmux-commands"), "the row first for `tmux`");
        let y = rows.iter().find(|(_, vi)| match &app.modal { Some(Modal::Picker { picker, .. }) => picker.rows[picker.visible[*vi].0].id == "cmd:tmux-commands", _ => false }).unwrap().0;
        crate::input::handle(&mut app, Event::Mouse(MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: list.x + 4, row: y, modifiers: KeyModifiers::NONE }));
        let s = screen(&mut app);
        let (kind, inside, _, _, _) = picker(&app);
        assert!(matches!(kind, PickerKind::Commands) && inside.as_deref() == Some("tmux"), "one click opened it");
        assert!(s.contains("tmux commands") && s.contains("tmux · Windows") && !s.contains("New harness"), "{s}");
        crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        let (kind, inside, at, _, _) = picker(&app);
        assert!(matches!(kind, PickerKind::Commands) && inside.is_none() && at.as_deref() == Some("cmd:tmux-commands"), "Esc back to hn's, on its row");
    }

    /// A harness moved onto a model: the model list closes, the status line says it.
    #[test]
    fn a_model_switched_closes_the_model_list() {
        let mut app = app();
        crate::input::run(&mut app, "models");
        assert!(matches!(app.modal, Some(Modal::Picker { kind: PickerKind::Models, .. })));
        crate::models::on_retarget(&mut app, "qwen3-coder", false, Ok(serde_json::json!({})));
        assert!(app.modal.is_none(), "closed");
        assert!(app.toast.as_ref().is_some_and(|t| format!("{t:?}").contains("qwen3-coder")), "{:?}", app.toast);
    }

    // ── keys ──

    /// A plain-key prefix (`` ` ``, Enter) is the prefix over the panes, and only there: in a list
    /// or a line being typed, the key is the list's (typed into the search, Enter chooses). A prefix
    /// with a modifier works over the lists, as before.
    #[test]
    fn a_plain_key_prefix_leaves_the_lists_their_keys() {
        use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
        let mut app = app();
        app.keymap.prefix = crate::keys::parse("`").unwrap();
        let key = |app: &mut App, code: KeyCode, mods: KeyModifiers| crate::input::handle(app, Event::Key(KeyEvent::new(code, mods)));
        key(&mut app, KeyCode::Char('`'), KeyModifiers::NONE);
        assert!(app.prefix, "over the panes, ` is the prefix");
        app.prefix = false;
        crate::commands::execute_bound(&mut app, "choose-command");
        key(&mut app, KeyCode::Char('`'), KeyModifiers::NONE);
        let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!("closed") };
        assert!(!app.prefix && picker.query == "`", "in a list, ` is typed: {:?}", picker.query);
        // A prefix with a modifier still works over a list.
        app.keymap.prefix = crate::keys::parse("C-a").unwrap();
        key(&mut app, KeyCode::Char('a'), KeyModifiers::CONTROL);
        assert!(app.prefix, "C-a over a list is the prefix");
    }

    /// Keybinds from the command list: its own panel in the same place — no preview, the
    /// prefix first and fixed — where Enter on a command waits for its key, a key in use is
    /// replaced on its second press, and Esc steps back to the commands.
    #[test]
    fn keybinds_open_from_commands_change_a_key_and_esc_goes_back() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = app();
        // (As the client takes a key: a key being waited for goes there first.)
        let key = |app: &mut App, code: KeyCode| {
            let k = KeyEvent::new(code, KeyModifiers::NONE);
            if app.capturing.is_some() { crate::settings::captured(app, k) } else { crate::input::modal_key(app, k) }
        };
        let said = |app: &App| match &app.modal { Some(Modal::Picker { picker, .. }) => picker.flash.as_ref().map(|f| f.0.clone()).unwrap_or_default(), _ => panic!("closed") };
        crate::commands::execute_bound(&mut app, "choose-command");
        screen(&mut app);
        let at = match &app.modal { Some(Modal::Picker { picker, .. }) => picker.screen_area.get(), _ => panic!("no panel") };
        for c in "keyb".chars() { key(&mut app, KeyCode::Char(c)) }
        let Some(Modal::Picker { picker, .. }) = &app.modal else { panic!("closed") };
        assert_eq!(picker.current_id().as_deref(), Some("cmd:keybinds"));
        key(&mut app, KeyCode::Enter);
        let s = screen(&mut app);
        let Some(Modal::Picker { kind, picker }) = &app.modal else { panic!("closed") };
        assert!(matches!(kind, PickerKind::Keybinds) && picker.from_commands);
        assert_eq!(picker.screen_area.get(), at, "the panel stayed where it was");
        assert!(s.contains("Keybinds") && s.contains("Prefix") && s.contains("Second prefix") && s.contains("Split right") && s.contains("Navigation"), "{s}");
        assert!(!s.contains("Preview") && !s.contains("Appearance"), "{s}");
        // The prefix: Enter waits for the new one; Esc leaves it.
        assert_eq!(picker.current_id().as_deref(), Some("prefix"));
        key(&mut app, KeyCode::Enter);
        assert!(app.capturing.is_some() && said(&app).starts_with("Prefix: press"), "{}", said(&app));
        key(&mut app, KeyCode::Esc);
        assert!(app.capturing.is_none() && said(&app) == "Unchanged", "{}", said(&app));
        // Split right onto n (Next swarm's): named first, replaced on the second press.
        if let Some(Modal::Picker { picker, .. }) = &mut app.modal { let i = crate::modal::KEYBINDS.iter().position(|k| k.0 == "Split right").unwrap(); picker.select(&format!("key:{i}")) }
        key(&mut app, KeyCode::Enter);
        assert_eq!(said(&app), "Split right: press a key · Esc cancels");
        key(&mut app, KeyCode::Char('n'));
        assert_eq!(said(&app), "C-b n is Next swarm — n again to replace · Esc to keep");
        key(&mut app, KeyCode::Char('n'));
        assert!(said(&app).starts_with("Split right: C-b n"), "{}", said(&app));
        let s = screen(&mut app);
        assert!(s.lines().any(|l| l.contains("Split right") && l.contains("C-b n")), "the row shows its key now:\n{s}");
        // Esc: back to the commands, the cursor on Keybinds.
        key(&mut app, KeyCode::Esc);
        let Some(Modal::Picker { kind, picker }) = &app.modal else { panic!("Esc closed it") };
        assert!(matches!(kind, PickerKind::Commands));
        assert_eq!(picker.current_id().as_deref(), Some("cmd:keybinds"));
        // Alt-k on a command in the list: the same — a key in use is named first.
        if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.select("cmd:split-down") }
        crate::input::modal_key(&mut app, KeyEvent::new(KeyCode::Char('k'), KeyModifiers::ALT));
        assert!(app.capturing.is_some());
        key(&mut app, KeyCode::Char('n'));
        assert!(said(&app).starts_with("C-b n is Split right — n again"), "{}", said(&app));
        key(&mut app, KeyCode::Esc);
        assert_eq!(said(&app), "Unchanged");
        assert_eq!(app.keymap.prefix_command(&crate::keys::parse("n").unwrap()).map(|b| b.command.as_str()), Some("split-window -h"));
        // Opened by name (not from the list), Esc closes it.
        app.modal = None;
        crate::input::run(&mut app, "keybinds");
        assert!(matches!(&app.modal, Some(Modal::Picker { kind: PickerKind::Keybinds, picker }) if !picker.from_commands));
        key(&mut app, KeyCode::Esc);
        assert!(app.modal.is_none());
    }
}

#[cfg(test)]
mod which_key_tests {
    use super::*;
    use crate::app::App;

    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (150, 42));
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(crate::fleet::Machine {
            id: "local".into(), name: "studio".into(), local: true, status: "online".into(), reach: crate::fleet::Reach::Ready,
        });
        app.homes.insert("local".into(), "/home/dev".into());
        app
    }

    /// The shortcut box (the prefix hint) must not panic and must draw on the themed pane surface,
    /// so it matches hn's chrome instead of floating in the terminal's default colours.
    #[test]
    fn shortcut_box_uses_the_themed_surface() {
        let _colours = crate::term_out::colours_lock();
        let mut app = app();
        app.prefix = true;
        app.prefix_at = Some(std::time::Instant::now() - std::time::Duration::from_secs(10));
        for w in [16, 40, 80, 150] {
            for h in [4, 10, 24] {
                let area = Rect::new(0, 0, w, h);
                let mut buf = Buffer::empty(area);
                which_key(&mut buf, &app, area);
                // Its panel cells take the pane surface colour.
                let surface = theme::pane_palette().surface;
                let mut any = false;
                for y in area.y..area.y + area.height { for x in area.x..area.x + area.width { if buf[(x, y)].style().bg == Some(surface) { any = true } } }
                assert!(any, "the shortcut box should draw on the themed pane surface ({w}x{h})");
            }
        }
    }
}
