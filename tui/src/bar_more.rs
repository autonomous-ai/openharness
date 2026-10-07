//! The status bar down a side, its footer: what tmux's status line shows on its right (the
//! subscription left, the harnesses' counts, the daemon, where you are, the time), which has no
//! line of its own while the bar stands in for it.
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;

use crate::app::App;
use crate::theme;

/// The footer's lines, each one thing: the daemon when it is down, the subscription left, the
/// harnesses' counts on one line. (Where you are — the machine, which names the session too — is
/// the bar's own heading, and the folder each pane's title: not said again.)
const LINES: [&str; 3] = [
    "#{?daemon_down,#[fg=red#,bold]daemon down#[default],}",
    "#{?usage_remaining,#{usage_remaining_icons},}",
    "#{?fleet,#{s/ /  /:fleet},}",
];

fn items(app: &App) -> Vec<String> {
    LINES.iter().map(|fmt| crate::format::expand(app, fmt, app.active, app.focused(), true).trim().to_string()).filter(|s| !plain(s).is_empty()).collect()
}

/// An item's words without its `#[…]` styles.
fn plain(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(at) = rest.find("#[") {
        out.push_str(&rest[..at]);
        rest = rest[at..].find(']').map(|end| &rest[at + end + 1..]).unwrap_or("");
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// The rows the footer takes at the bottom of the bar: a rule, then one row an item (at most
/// six, and never more than a third of the bar).
pub fn footer_height(app: &App, width: u16) -> u16 {
    let _ = width;
    let n = items(app).len().min(6) as u16;
    if n == 0 { 0 } else { (n + 1).min(app.size.1 / 3) }
}

/// Draw the footer in [r]: a rule over it, then status-right's items, each in its own styles.
pub fn footer(buf: &mut Buffer, app: &App, r: Rect) {
    if r.height == 0 || r.width < 4 { return }
    let pal = theme::pane_palette();
    let base = Style::default().fg(theme::paint(pal.muted)).bg(theme::depth_fit(pal.background));
    for x in r.x..r.right() { if let Some(c) = buf.cell_mut((x, r.y)) { c.set_symbol("─").set_style(Style::default().fg(theme::paint(pal.border)).bg(base.bg.unwrap_or_default())); } }
    for (row, item) in items(app).iter().take(r.height.saturating_sub(1) as usize).enumerate() {
        let y = r.y + 1 + row as u16;
        for x in r.x..r.right() { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); c.set_style(base); } }
        let cells = crate::draw::format_draw_over(item, base, r.width.saturating_sub(2));
        for (i, cell) in cells.into_iter().enumerate() {
            if let Some((ch, cs)) = cell { if let Some(c) = buf.cell_mut((r.x + 1 + i as u16, y)) { c.set_symbol(if ch.is_empty() { " " } else { &ch }); c.set_style(cs); } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (120, 36));
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "local".into(), name: "studio".into(), local: true, status: "online".into(), reach: crate::fleet::Reach::Ready });
        app
    }

    /// The footer says one thing a line and nothing twice: the daemon when down (bold) — no machine,
    /// session, path or time (the bar's heading has the machine, which names the session).
    #[test]
    fn the_footer_says_one_thing_a_line() {
        let mut app = app();
        app.daemon_down = true;
        let lines = items(&app);
        assert!(lines[0].contains("daemon down"), "{lines:?}");
        assert!(!lines.iter().any(|l| l.len() == 5 && l.as_bytes()[2] == b':'), "no time: {lines:?}");
        assert!(!lines.iter().any(|l| l.contains("studio")), "no machine again: {lines:?}");
        let h = footer_height(&app, 26);
        assert_eq!(h, lines.len() as u16 + 1);
        let r = Rect::new(0, 30, 26, h);
        let mut buf = Buffer::empty(Rect::new(0, 0, 26, 36));
        footer(&mut buf, &app, r);
        let row = |y: u16| (0..26).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>();
        assert!(row(30).starts_with("──"));
        assert!(row(31).contains("daemon down") && buf[(1, 31)].style().add_modifier.contains(ratatui::style::Modifier::BOLD));
    }
}
