//! Mouse-created tabs retain the quiet welcome page, with a composer above the
//! same recent sessions. All controls use the existing form and launch receipt.
use super::*;
use crate::input::HomeRow;
use ratatui::{style::Color, widgets::{Block, BorderType, Paragraph, Widget}};

struct Chip { field: Field, text: String, x: u16, width: u16 }
fn settings(form: &Form, width: u16) -> Vec<Chip> {
    let mut chips = Vec::new();
    let fields = form.fields();
    for field in [Field::Model, Field::Approvals, Field::Profile, Field::Worktree, Field::Branch] {
        if !fields.contains(&field) { continue }
        let (_, value) = form.describe(field);
        let text = match field {
            Field::Worktree => format!("{} Worktree", if form.worktree() { "[x]" } else { "[ ]" }),
            Field::Branch if form.blocked(field).is_some() => value,
            Field::Branch => format!("From {value} ▾"),
            Field::Model => format!("{value} ▾"),
            Field::Profile if form.draft.profile.is_none() => "Default account ▾".into(),
            _ => format!("{value} ▾"),
        };
        let w = (text.width() as u16).min(width).min(26);
        chips.push(Chip { field, text, x: 0, width: w });
    }
    // Keep settings on one row. Long values shorten before the Git group moves;
    // the full value remains available in its picker.
    let gap = 3;
    let budget = width.saturating_sub(gap * chips.len().saturating_sub(1) as u16);
    while chips.iter().map(|c| c.width).sum::<u16>() > budget {
        let Some(chip) = chips.iter_mut()
            .filter(|c| c.field != Field::Worktree && c.width > 6)
            .max_by_key(|c| c.width) else { break };
        chip.width -= 1;
    }
    for chip in &mut chips {
        chip.text = crate::format::clip_middle(&chip.text, chip.width as usize);
    }
    let split = chips.iter().position(|c| matches!(c.field, Field::Worktree | Field::Branch)).unwrap_or(chips.len());
    let (left, right) = chips.split_at_mut(split);
    let mut x = 0;
    for chip in left.iter_mut() {
        chip.x = x;
        x += chip.width + gap;
    }
    if !right.is_empty() {
        let right_width = right.iter().map(|c| c.width).sum::<u16>() + gap * (right.len() as u16 - 1);
        x = width.saturating_sub(right_width);
        for chip in right.iter_mut() {
            chip.x = x;
            x += chip.width + gap;
        }
    }
    chips
}

fn control(buf: &mut Buffer, form: &mut Form, rect: Rect, field: Field, text: &str, base: Style, accent: Style) {
    let active = form.focus == field;
    let style = if active { accent } else { base };
    view::put(buf, rect.x, rect.y, rect.width, text, style);
    form.hits.push((rect, field));
}

pub(super) fn draw(buf: &mut Buffer, app: &App, body: Rect, form: &mut Form) -> Option<Position> {
    form.hits.clear(); form.task_area = Rect::default(); form.child_area = Rect::default();
    crate::settings::fill(buf, body, Style::default());
    let chrome = crate::settings::chrome();
    let plain = chrome.base.bg(Color::Reset);
    let muted = chrome.muted.bg(Color::Reset);
    let accent = chrome.accent.bg(Color::Reset);
    let width = body.width.saturating_sub(8).min(80);
    let available_height = body.height.saturating_sub(if body.height >= 30 { 4 } else { 2 });
    let comfortable = available_height >= 28;
    let section_gap = if available_height >= 36 { 3 } else if comfortable { 2 } else { 1 };
    let task_height = if comfortable { 6 } else { 5 };
    let chips = settings(form, width);
    let settings_h = 1;
    // Keep each section compact, with breathing room only between sections.
    // Reserve nine history rows so discovering sessions does not move the form.
    let height = available_height.min(1 + task_height + settings_h + 2 * section_gap + 12);
    let rect = Rect::new(body.x + (body.width - width) / 2, body.y + (body.height - height) / 2, width, height);
    form.area = rect;
    let (x, mut y) = (rect.x, rect.y);
    let connected = app.fleet.visible_machines().filter(|m| m.usable()).count();

    let gap = 2;
    let agent = format!("[ {} ▾ ]", form.draft.what.label);
    let agent_w = (agent.width() as u16).min(26).min(width / 3);
    control(buf, form, Rect::new(x, y, agent_w, 1), Field::Agent, &agent, plain, accent);
    let machine = if app.fleet.machine(&form.draft.machine).is_some_and(|m| m.local) {
        if cfg!(target_os = "macos") { "This Mac" } else { "This Computer" }
    } else { &form.machine_label };
    let machine = format!("[ {machine} ▾ ]");
    let machine_w = (machine.width() as u16).min(24).min(width / 3);
    control(buf, form, Rect::new(x + agent_w + gap, y, machine_w, 1), Field::Machine, &machine, plain, accent);
    let project_x = x + agent_w + machine_w + gap * 2;
    let project = format!("[ {} ▾ ]", form.project_name());
    control(buf, form, Rect::new(project_x, y, rect.right() - project_x, 1), Field::Project, &project, plain, accent);
    let controls_y = y;
    y += 1;

    let task_box = Rect::new(x, y, width, task_height);
    Block::bordered().border_type(BorderType::Rounded)
        .style(chrome.base).border_style(if form.focus == Field::Task { accent } else { muted })
        .render(task_box, buf);
    form.task_area = Rect::new(x + 3, y + 1, width - 6, task_box.height - 3);
    // An agent that takes no task says so where the task goes, as the form page does.
    let cursor = if let Some(blocked) = form.blocked(Field::Task) {
        Paragraph::new(ratatui::text::Line::styled(blocked, chrome.muted)).render(form.task_area, buf);
        None
    } else {
        form.task_editor.draw(buf, form.task_area, &form.draft.task,
            form.focus == Field::Task && !form.child_active && !form.starting && form.attempt.is_none(), chrome.base, chrome.muted)
    };
    let action = if form.starting || form.attempt.is_some() { form.describe(Field::Create).0 } else { "New Harness".into() };
    let button = format!("[ {action} ]");
    let button_w = (button.width() as u16).min(width - 6);
    control(buf, form, Rect::new(task_box.right() - button_w - 3, task_box.bottom() - 2, button_w, 1),
        Field::Create, &button, chrome.base.add_modifier(Modifier::BOLD), chrome.accent);
    // The whole editor, including its border and padding, focuses Task. The
    // Create hit was registered first, so its button still starts explicitly.
    form.hits.push((task_box, Field::Task));
    y = task_box.bottom();

    for chip in chips {
        let style = if form.blocked(chip.field).is_some() { muted } else { plain };
        control(buf, form, Rect::new(x + chip.x, y, chip.width, 1), chip.field, &chip.text, style, accent);
    }
    let chips_y = y;
    y += settings_h;
    let live_error = task::error(&form.draft.what.engine, &form.draft.task);
    // (While a chooser is dropped down its error is in it, in place of its keys: not twice.)
    let dropped = form.child.is_some() && form.child_active;
    let error = if form.error.is_empty() || dropped { live_error.as_deref().unwrap_or("") } else { &form.error };
    let footer_y = rect.bottom() - 1;
    let recent_bottom = footer_y.saturating_sub(section_gap);
    let latest_heading_y = recent_bottom.saturating_sub(2);
    if !error.is_empty() {
        // Recovery text takes priority over recent rows, keeping All reachable.
        let room = latest_heading_y.saturating_sub(y + section_gap);
        for line in view::error_lines(error, width as usize).into_iter().take(room as usize) {
            view::put(buf, x, y, width, &line, plain.patch(theme::fg(theme::DANGER))); y += 1;
        }
    }
    y = (y + section_gap).min(latest_heading_y);
    view::put(buf, x, y, width.saturating_sub(6), &form.recent_status, muted);
    control(buf, form, Rect::new(rect.right() - 3, y, 3, 1), Field::Browse, "All", muted, accent);
    y += 2;
    let room = recent_bottom.saturating_sub(y) as usize;
    let selected = if let Field::Recent(i) = form.focus { i } else { 0 };
    let start = selected.saturating_sub(room.saturating_sub(1));
    let (_, theme_fg, _) = theme::palette();
    for i in start..form.recent.len().min(start + room) {
        let active = form.focus == Field::Recent(i);
        let row_style = if active { chrome.selected } else { Style::default() };
        if active { crate::settings::fill(buf, Rect::new(x, y, width, 1), row_style); }
        let tint = |color| if color == theme::MUTED || color == theme::SOFT {
            row_style.fg(theme::paint(theme_fg)).add_modifier(Modifier::DIM)
        } else { row_style.fg(theme::paint(color)) };
        let (title, detail, machine, age, mark, mark_color, engine) = match &form.recent[i] {
            HomeRow::Harness(machine, id) => {
                let Some(a) = app.fleet.agent(machine, id) else { continue };
                let (mark, _, color) = theme::state_mark(app.fleet.state_of(a), app.tick);
                let detail = a.question.as_ref().map(|q| (q.prompt.clone(), theme::ATTENTION))
                    .unwrap_or_else(|| (if a.project.is_empty() { a.cwd.clone() } else { a.project.clone() }, theme::MUTED));
                (a.name.clone(), detail, app.fleet.machine_name(machine), crate::fleet::ago(a.recency()), mark, color, a.engine.clone())
            }
            HomeRow::External(s) => {
                let folder = s.cwd.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
                let (mark, _, color) = theme::state_mark(crate::fleet::State::Paused, app.tick);
                (if s.title.is_empty() { folder.clone() } else { s.title.clone() }, (folder, theme::MUTED),
                    app.fleet.machine_name(&s.machine), crate::fleet::ago(s.last_at), mark, color, s.engine.clone())
            }
        };
        view::put(buf, x, y, 1, &(i + 1).to_string(), tint(theme::accent()));
        view::put(buf, x + 2, y, 1, mark, tint(mark_color));
        let (engine_mark, engine_color) = theme::engine_mark(&engine);
        view::put(buf, x + 4, y, 1, engine_mark, tint(engine_color));
        // Production's compact row: a fixed title column, project/folder next,
        // machine and age at the right. A longer machine never shifts the project.
        let right = if width < 56 { String::new() } else if connected > 1 && width >= 70 {
            format!("{machine}  {age}")
        } else { age };
        let right_w = (right.width() as u16).min(width.saturating_sub(38));
        let title_w = if width < 56 { width.saturating_sub(10).min(28) } else { 28 };
        let detail_w = width.saturating_sub(title_w + right_w + 12);
        let title = crate::format::clip_middle(&title, title_w as usize);
        view::put(buf, x + 6, y, title_w, &title, row_style.fg(theme::paint(theme_fg)).add_modifier(Modifier::BOLD));
        view::put(buf, x + 8 + title_w, y, detail_w, &detail.0, tint(detail.1));
        view::put(buf, rect.right() - right_w, y, right_w, &right, tint(theme::MUTED));
        form.hits.push((Rect::new(x, y, width, 1), Field::Recent(i)));
        y += 1;
    }
    control(buf, form, Rect::new(x, footer_y, 12, 1), Field::Terminal, "New Terminal", muted, accent);

    // An entered chooser drops down under the settings row, the task box above it still in view;
    // where too few rows are left it covers the page from the controls down.
    if let Some(c) = form.child.as_ref().filter(|_| form.child_active) {
        let child = view::dropdown(c, x, chips_y + 1, width.min(60), body.bottom()).unwrap_or_else(||
            Rect::new(x, controls_y, width, body.bottom().saturating_sub(controls_y).min(22)));
        return view::draw_child(buf, child, form);
    }
    cursor
}
