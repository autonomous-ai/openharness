//! tmux's format_draw (format-draw.c) and style_parse (style.c), ported: an expanded format
//! drawn into a line of cells — its text split by `#[align=…]` into left, centre, right and
//! absolute-centre, `#[list=on]` the window list with its `<` `>` markers and `list=focus` (the
//! current window kept in view when the list is cut), `#[range=…]` the ranges a click finds,
//! `#[fill=…]`, `#[push-default]` / `#[pop-default]` — laid out and trimmed as tmux does.

use ratatui::style::{Color, Modifier, Style};
use unicode_width::UnicodeWidthChar;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Align { Default, Left, Centre, Right, AbsoluteCentre }

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum List { Off, On, Focus, LeftMarker, RightMarker }

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum RangeKind { None, Left, Right, Pane(u64), Window(u64), Session(u64), User(String) }

/// A range a click lands in, in the drawn line's columns [start, end).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Range { pub kind: RangeKind, pub start: u16, pub end: u16 }

#[derive(Clone, Debug)]
enum DefaultType { Base, Push, Pop }

/// tmux's struct style: a cell's look, and what the drawing does with what follows.
#[derive(Clone, Debug)]
struct Sy { gc: Style, align: Align, list: List, range: RangeKind, fill: Option<Color>, ignore: bool, default: DefaultType }

impl Sy {
    fn new(gc: Style) -> Sy { Sy { gc, align: Align::Default, list: List::Off, range: RangeKind::None, fill: None, ignore: false, default: DefaultType::Base } }
}

/// attributes_fromstring's names.
fn attribute(name: &str) -> Option<Modifier> {
    Some(match name.to_ascii_lowercase().as_str() {
        "bright" | "bold" => Modifier::BOLD,
        "dim" => Modifier::DIM,
        "underscore" | "double-underscore" | "curly-underscore" | "dotted-underscore" | "dashed-underscore" => Modifier::UNDERLINED,
        "blink" => Modifier::SLOW_BLINK,
        "reverse" => Modifier::REVERSED,
        "hidden" => Modifier::HIDDEN,
        "italics" => Modifier::ITALIC,
        "strikethrough" => Modifier::CROSSED_OUT,
        "overline" | "acs" => Modifier::empty(),
        _ => return None,
    })
}

/// style_parse: `#[…]`'s words over a style (base: what `default` and `fg=default` go back to).
/// False, and the style untouched, for one tmux would refuse.
fn style_parse(sy: &mut Sy, base: Style, spec: &str) -> bool {
    let saved = sy.clone();
    let colour = |v: &str| -> Option<Option<Color>> { if v.eq_ignore_ascii_case("default") { Some(None) } else { crate::tmuxconf::colour(v).map(Some) } };
    for w in spec.split([' ', ',', '\n']).filter(|w| !w.is_empty()) {
        let l = w.to_ascii_lowercase();
        let ok = match l.as_str() {
            "default" => { sy.gc = base; true }
            "ignore" => { sy.ignore = true; true }
            "noignore" => { sy.ignore = false; true }
            "push-default" => { sy.default = DefaultType::Push; true }
            "pop-default" => { sy.default = DefaultType::Pop; true }
            "set-default" => true,
            "nolist" => { sy.list = List::Off; true }
            "norange" => { sy.range = RangeKind::None; true }
            "noalign" => { sy.align = Align::Default; true }
            "none" => { sy.gc = Style { add_modifier: Modifier::empty(), sub_modifier: Modifier::all(), ..sy.gc }; true }
            _ if l.starts_with("list=") => match &l[5..] {
                "on" => { sy.list = List::On; true }
                "focus" => { sy.list = List::Focus; true }
                "left-marker" => { sy.list = List::LeftMarker; true }
                "right-marker" => { sy.list = List::RightMarker; true }
                _ => false,
            },
            _ if l.len() > 6 && l.starts_with("range=") => {
                let (kind, arg) = match w[6..].split_once('|') { Some((k, a)) => (k.to_ascii_lowercase(), Some(a)), None => (w[6..].to_ascii_lowercase(), None) };
                match (kind.as_str(), arg) {
                    (_, Some("")) => false,
                    ("left", None) => { sy.range = RangeKind::Left; true }
                    ("right", None) => { sy.range = RangeKind::Right; true }
                    ("pane", Some(a)) => match a.strip_prefix('%').and_then(|n| n.parse().ok()) { Some(n) => { sy.range = RangeKind::Pane(n); true } None => false },
                    ("window", Some(a)) => match a.parse() { Ok(n) => { sy.range = RangeKind::Window(n); true } Err(_) => false },
                    ("session", Some(a)) => match a.strip_prefix('$').and_then(|n| n.parse().ok()) { Some(n) => { sy.range = RangeKind::Session(n); true } None => false },
                    ("user", Some(a)) => { sy.range = RangeKind::User(a.chars().take(15).collect()); true }
                    _ => false,
                }
            }
            _ if l.len() > 6 && l.starts_with("align=") => match &l[6..] {
                "left" => { sy.align = Align::Left; true }
                "centre" => { sy.align = Align::Centre; true }
                "right" => { sy.align = Align::Right; true }
                "absolute-centre" => { sy.align = Align::AbsoluteCentre; true }
                _ => false,
            },
            _ if l.len() > 5 && l.starts_with("fill=") => match colour(&w[5..]) { Some(c) => { sy.fill = Some(c.unwrap_or(Color::Reset)); true } None => false },
            _ if l.len() > 3 && &l[1..3] == "g=" && (l.starts_with('f') || l.starts_with('b')) => match colour(&w[3..]) {
                Some(c) => {
                    if l.starts_with('f') { sy.gc.fg = c.or(base.fg) } else { sy.gc.bg = c.or(base.bg) }
                    true
                }
                None => false,
            },
            _ if l.len() > 3 && l.starts_with("us=") => colour(&w[3..]).is_some(),
            _ if l.len() > 6 && (l.starts_with("width=") || l.starts_with("pad=")) => true,
            _ if l.len() > 2 && l.starts_with("no") && attribute(&l[2..]).is_some() => { let m = attribute(&l[2..]).unwrap(); sy.gc = sy.gc.remove_modifier(m); true }
            _ => match attribute(&l) { Some(m) => { sy.gc = sy.gc.add_modifier(m); true } None => false },
        };
        if !ok { *sy = saved; return false }
    }
    true
}

/// A look as `#[…]` writes it (fg=…,bg=…,bold …): for a format variable that carries its own.
pub fn style_text(st: Style) -> String {
    let name = |c: Color| -> String {
        match c {
            Color::Reset => "default".into(), Color::Black => "black".into(), Color::Red => "red".into(), Color::Green => "green".into(), Color::Yellow => "yellow".into(),
            Color::Blue => "blue".into(), Color::Magenta => "magenta".into(), Color::Cyan => "cyan".into(), Color::Gray => "white".into(), Color::DarkGray => "brightblack".into(),
            Color::LightRed => "brightred".into(), Color::LightGreen => "brightgreen".into(), Color::LightYellow => "brightyellow".into(), Color::LightBlue => "brightblue".into(),
            Color::LightMagenta => "brightmagenta".into(), Color::LightCyan => "brightcyan".into(), Color::White => "brightwhite".into(),
            Color::Indexed(n) => format!("colour{n}"), Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        }
    };
    let mut parts = Vec::new();
    if let Some(c) = st.fg { parts.push(format!("fg={}", name(c))) }
    if let Some(c) = st.bg { parts.push(format!("bg={}", name(c))) }
    for (m, n) in [(Modifier::BOLD, "bold"), (Modifier::DIM, "dim"), (Modifier::ITALIC, "italics"), (Modifier::UNDERLINED, "underscore"), (Modifier::REVERSED, "reverse")] {
        if st.add_modifier.contains(m) { parts.push(n.into()) }
    }
    parts.join(",")
}

/// Whether tmux's style_parse takes a style (set-option's check of a *-style option).
/// A style option's value over a base (style_parse; one that does not parse leaves the base).
pub fn style_over(spec: &str, base: Style) -> Style {
    let mut sy = Sy::new(base);
    if style_parse(&mut sy, base, spec) { sy.gc } else { base }
}

pub fn valid_style(spec: &str) -> bool { let mut sy = Sy::new(Style::default()); style_parse(&mut sy, Style::default(), spec) }

/// A section's cells: a character, its look, its width.
type Screen = Vec<(String, Style, u16)>;

fn width(s: &Screen) -> u16 { s.iter().map(|c| c.2).sum() }

/// The cells of a section from column `start` for `width` columns.
fn columns(s: &Screen, start: u16, width: u16) -> Vec<(String, Style, u16)> {
    let (mut out, mut x) = (Vec::new(), 0u16);
    for c in s {
        if x >= start + width { break }
        if x >= start && x + c.2 <= start + width { out.push(c.clone()) }
        x += c.2;
    }
    out
}

/// Where the drawing puts things: the line, and the ranges of each section.
struct Out { line: Vec<(String, Style)>, ranges: Vec<Range> }

/// format_draw_put: `width` columns of a section from `start`, at `offset`; its ranges moved.
fn put(out: &mut Out, s: &Screen, ranges: &[(usize, Range)], which: usize, offset: u16, start: u16, width: u16) {
    let mut x = offset;
    for (ch, st, w) in columns(s, start, width) {
        if (x as usize) < out.line.len() { out.line[x as usize] = (ch, st) }
        for k in 1..w { if ((x + k) as usize) < out.line.len() { out.line[(x + k) as usize] = (String::new(), st) } }
        x += w;
    }
    for (i, r) in ranges {
        if *i != which { continue }
        if r.end <= start || r.start >= start + width { continue }
        let (s0, e0) = (r.start.max(start), r.end.min(start + width));
        if s0 == e0 { continue }
        out.ranges.push(Range { kind: r.kind.clone(), start: s0 - start + offset, end: e0 - start + offset });
    }
}

const LEFT: usize = 0;
const CENTRE: usize = 1;
const RIGHT: usize = 2;
const ABS: usize = 3;
const LIST: usize = 4;
const LIST_LEFT: usize = 5;
const LIST_RIGHT: usize = 6;
const AFTER: usize = 7;

/// format_draw_put_list: the list whole when it fits, else cut around its focus, with the
/// markers where it was cut.
fn put_list(out: &mut Out, s: &[Screen; 8], ranges: &[(usize, Range)], mut offset: u16, mut w: u16, focus: (i32, i32)) {
    let list_w = width(&s[LIST]);
    if w >= list_w { return put(out, &s[LIST], ranges, LIST, offset, 0, w) }
    let centre = focus.0 + (focus.1 - focus.0) / 2;
    let mut start = if centre < (w / 2) as i32 { 0 } else { (centre - (w / 2) as i32) as u16 };
    if start + w > list_w { start = list_w - w }
    let (lw, rw) = (width(&s[LIST_LEFT]), width(&s[LIST_RIGHT]));
    if start != 0 && w > lw {
        put(out, &s[LIST_LEFT], ranges, LIST_LEFT, offset, 0, lw);
        offset += lw;
        start += lw;
        w -= lw;
    }
    if start + w < list_w && w > rw {
        put(out, &s[LIST_RIGHT], ranges, LIST_RIGHT, offset + w - rw, 0, rw);
        w -= rw;
    }
    put(out, &s[LIST], ranges, LIST, offset, start, w)
}

/// format_draw_none: left, right and centre, the centre giving way first.
fn draw_none(out: &mut Out, avail: u16, s: &[Screen; 8], ranges: &[(usize, Range)]) {
    let (mut wl, mut wc, mut wr, mut wa) = (width(&s[LEFT]), width(&s[CENTRE]), width(&s[RIGHT]), width(&s[ABS]));
    while wl + wc + wr > avail { if wc > 0 { wc -= 1 } else if wr > 0 { wr -= 1 } else { wl -= 1 } }
    put(out, &s[LEFT], ranges, LEFT, 0, 0, wl);
    put(out, &s[RIGHT], ranges, RIGHT, avail - wr, width(&s[RIGHT]) - wr, wr);
    put(out, &s[CENTRE], ranges, CENTRE, wl + ((avail - wr) - wl) / 2 - wc / 2, width(&s[CENTRE]) / 2 - wc / 2, wc);
    if wa > avail { wa = avail }
    put(out, &s[ABS], ranges, ABS, (avail - wa) / 2, 0, wa);
}

/// Where a list's text goes when nothing of the list is left to draw (it joins that section).
fn fold_after(s: &mut [Screen; 8], into: usize, wa: u16) {
    let after = columns(&s[AFTER], 0, wa);
    s[into].extend(after);
}

/// format_draw_left, _centre, _right and _absolute_centre: where the list sits decides what
/// gives way first and where each part goes.
fn draw_list(out: &mut Out, avail: u16, s: &mut [Screen; 8], ranges: &[(usize, Range)], align: Align, focus: (i32, i32)) {
    let (mut wl, mut wc, mut wr, mut wa) = (width(&s[LEFT]), width(&s[CENTRE]), width(&s[RIGHT]), width(&s[ABS]));
    let (mut wli, mut waf) = (width(&s[LIST]), width(&s[AFTER]));
    let list_w = width(&s[LIST]);
    match align {
        Align::AbsoluteCentre => {
            while wl + wc + wr > avail { if wc > 0 { wc -= 1 } else if wr > 0 { wr -= 1 } else { wl -= 1 } }
            while wli + waf + wa > avail { if wli > 0 { wli -= 1 } else if waf > 0 { waf -= 1 } else { wa -= 1 } }
            put(out, &s[LEFT], ranges, LEFT, 0, 0, wl);
            put(out, &s[RIGHT], ranges, RIGHT, avail - wr, width(&s[RIGHT]) - wr, wr);
            let middle = wl + ((avail - wr) - wl) / 2;
            put(out, &s[CENTRE], ranges, CENTRE, middle - wc, 0, wc);
            let focus = if focus.0 == -1 || focus.1 == -1 { ((list_w / 2) as i32, (list_w / 2) as i32) } else { focus };
            let mut off = (avail - wli - wa) / 2;
            put(out, &s[ABS], ranges, ABS, off, 0, wa);
            off += wa;
            put_list(out, s, ranges, off, wli, focus);
            off += wli;
            put(out, &s[AFTER], ranges, AFTER, off, 0, waf);
            return;
        }
        Align::Centre => {
            while wl + wc + wr + wli + waf > avail { if wli > 0 { wli -= 1 } else if waf > 0 { waf -= 1 } else if wc > 0 { wc -= 1 } else if wr > 0 { wr -= 1 } else { wl -= 1 } }
        }
        _ => {
            while wl + wc + wr + wli + waf > avail { if wc > 0 { wc -= 1 } else if wli > 0 { wli -= 1 } else if wr > 0 { wr -= 1 } else if waf > 0 { waf -= 1 } else { wl -= 1 } }
        }
    }
    if wli == 0 {
        let into = match align { Align::Left => LEFT, Align::Centre => CENTRE, _ => RIGHT };
        fold_after(s, into, waf);
        return draw_none(out, avail, s, ranges);
    }
    put(out, &s[LEFT], ranges, LEFT, 0, 0, wl);
    match align {
        Align::Left => {
            put(out, &s[RIGHT], ranges, RIGHT, avail - wr, width(&s[RIGHT]) - wr, wr);
            put(out, &s[AFTER], ranges, AFTER, wl + wli, 0, waf);
            let from = wl + wli + waf;
            put(out, &s[CENTRE], ranges, CENTRE, from + ((avail - wr) - from) / 2 - wc / 2, width(&s[CENTRE]) / 2 - wc / 2, wc);
            let focus = if focus.0 == -1 || focus.1 == -1 { (0, 0) } else { focus };
            put_list(out, s, ranges, wl, wli, focus);
        }
        Align::Centre => {
            put(out, &s[RIGHT], ranges, RIGHT, avail - wr, width(&s[RIGHT]) - wr, wr);
            let middle = wl + ((avail - wr) - wl) / 2;
            put(out, &s[CENTRE], ranges, CENTRE, middle - wli / 2 - wc, 0, wc);
            put(out, &s[AFTER], ranges, AFTER, middle - wli / 2 + wli, 0, waf);
            let focus = if focus.0 == -1 || focus.1 == -1 { ((list_w / 2) as i32, (list_w / 2) as i32) } else { focus };
            put_list(out, s, ranges, middle - wli / 2, wli, focus);
        }
        _ => {
            put(out, &s[AFTER], ranges, AFTER, avail - waf, width(&s[AFTER]) - waf, waf);
            put(out, &s[RIGHT], ranges, RIGHT, avail - wr - wli - waf, 0, wr);
            let to = avail - wr - wli - waf;
            put(out, &s[CENTRE], ranges, CENTRE, wl + (to - wl) / 2 - wc / 2, width(&s[CENTRE]) / 2 - wc / 2, wc);
            let focus = if focus.0 == -1 || focus.1 == -1 { (0, 0) } else { focus };
            put_list(out, s, ranges, avail - wli - waf, wli, focus);
        }
    }
    if wa > avail { wa = avail }
    put(out, &s[ABS], ranges, ABS, (avail - wa) / 2, 0, wa);
}

/// format_draw: an expanded format as `avail` cells over `base` (the status line's style), and
/// the ranges in it. A `#[…]` tmux would refuse is skipped; a `#[` never closed ends the drawing.
pub fn format_draw(expanded: &str, base: Style, avail: u16) -> (Vec<(String, Style)>, Vec<Range>) { format_draw_on(expanded, base, avail, " ") }

/// format_draw onto what is there already: None where it writes nothing (the menu's title
/// over its border).
pub fn format_draw_over(expanded: &str, base: Style, avail: u16) -> Vec<Option<(String, Style)>> {
    const GAP: &str = "\u{1}";
    format_draw_on(expanded, base, avail, GAP).0.into_iter().map(|c| (c.0 != GAP).then_some(c)).collect()
}

/// format_width: the columns a format's text takes — its #[…] styles none, ## one.
pub fn format_width(expanded: &str) -> usize {
    let b: Vec<char> = expanded.chars().collect();
    let (mut i, mut width) = (0, 0);
    while i < b.len() {
        if b[i] != '#' {
            if (b[i] as u32) > 0x1f && b[i] != '\x7f' { width += unicode_width::UnicodeWidthChar::width(b[i]).unwrap_or(0) }
            i += 1;
            continue;
        }
        // format_leading_hashes: a run of #s, halved; an odd run before [ is a style.
        let mut n = 0;
        while b.get(i + n) == Some(&'#') { n += 1 }
        if b.get(i + n) != Some(&'[') { width += if n % 2 == 0 { n / 2 } else { n / 2 + 1 }; i += n; continue }
        width += n / 2;
        if n % 2 == 0 { i += n; continue }
        i += n - 1;
        match b.get(i + 2..).and_then(|rest| rest.iter().position(|c| *c == ']')) { Some(p) => i += 2 + p + 1, None => return 0 }
    }
    width
}

fn format_draw_on(expanded: &str, base: Style, avail: u16, blank: &str) -> (Vec<(String, Style)>, Vec<Range>) {
    let mut s: [Screen; 8] = Default::default();
    let mut current_default = base;
    let mut sy = Sy::new(base);
    let (mut current, mut map) = (LEFT, [LEFT, LEFT, CENTRE, RIGHT, ABS]);
    let (mut focus_start, mut focus_end) = (-1i32, -1i32);
    let mut list_state = -1;
    let mut list_align = Align::Default;
    let mut fill: Option<Color> = None;
    let mut ranges: Vec<(usize, Range)> = Vec::new();
    let mut open: Option<(usize, Range)> = None;
    let b: Vec<char> = expanded.chars().collect();
    let align_index = |a: Align| match a { Align::Default => 0, Align::Left => 1, Align::Centre => 2, Align::Right => 3, Align::AbsoluteCentre => 4 };
    let mut i = 0;
    let mut broken = false;
    while i < b.len() {
        // Runs of #: halved, and a style when an odd run is before `[`.
        if b[i] == '#' && b.get(i + 1) != Some(&'[') && i + 1 < b.len() {
            let mut n = 1;
            while b.get(i + n) == Some(&'#') { n += 1 }
            let even = n % 2 == 0;
            if b.get(i + n) != Some(&'[') {
                i += n;
                let k = if even { n / 2 } else { n / 2 + 1 };
                for _ in 0..k { s[current].push(("#".into(), sy.gc, 1)) }
                continue;
            }
            if even { i += n + 1 } else { i += n - 1 }
            if sy.ignore { continue }
            for _ in 0..n / 2 { s[current].push(("#".into(), sy.gc, 1)) }
            if even { s[current].push(("[".into(), sy.gc, 1)) }
            continue;
        }
        if b[i] != '#' || b.get(i + 1) != Some(&'[') || sy.ignore {
            let c = b[i];
            i += 1;
            if (c as u32) < 0x20 || c == '\u{7f}' { continue }
            let w = UnicodeWidthChar::width(c).unwrap_or(0) as u16;
            s[current].push((c.to_string(), sy.gc, w));
            continue;
        }
        // A style: to its closing `]`.
        let rest: String = b[i + 2..].iter().collect();
        let Some(end) = crate::format::skip_to(&rest, ']') else { broken = true; break };
        let spec: String = rest.chars().take(end).collect();
        let saved = sy.clone();
        i += 2 + end + 1;
        if !style_parse(&mut sy, current_default, &spec) { continue }
        if let Some(f) = sy.fill { fill = Some(f) }
        match sy.default {
            DefaultType::Push => { current_default = saved.gc; sy.default = DefaultType::Base }
            DefaultType::Pop => { current_default = base; sy.default = DefaultType::Base }
            DefaultType::Base => {}
        }
        match sy.list {
            List::On => {
                if list_state != 0 { open = None; list_state = 0; list_align = sy.align }
                if focus_start != -1 && focus_end == -1 { focus_end = width(&s[LIST]) as i32 }
                current = LIST;
            }
            List::Focus => { if list_state == 0 && focus_start == -1 { focus_start = width(&s[LIST]) as i32 } }
            List::Off => {
                if list_state == 0 {
                    open = None;
                    if focus_start != -1 && focus_end == -1 { focus_end = width(&s[LIST]) as i32 }
                    map[align_index(list_align)] = AFTER;
                    if list_align == Align::Left { map[0] = AFTER }
                    list_state = 1;
                }
                current = map[align_index(sy.align)];
            }
            List::LeftMarker | List::RightMarker => {
                let which = if sy.list == List::LeftMarker { LIST_LEFT } else { LIST_RIGHT };
                if list_state == 0 && width(&s[which]) == 0 {
                    open = None;
                    if focus_start != -1 && focus_end == -1 { focus_start = -1; focus_end = -1 }
                    current = which;
                }
            }
        }
        // A range ends where the style's range changes; a new one starts.
        if let Some((w, r)) = &open {
            if r.kind != sy.range {
                let here = width(&s[current]);
                if here != r.start { ranges.push((*w, Range { kind: r.kind.clone(), start: r.start, end: here + 1 })) }
                open = None;
            }
        }
        if open.is_none() && sy.range != RangeKind::None { open = Some((current, Range { kind: sy.range.clone(), start: width(&s[current]), end: 0 })) }
    }
    let mut out = Out { line: vec![(blank.to_string(), base); avail as usize], ranges: Vec::new() };
    if broken { return (out.line, Vec::new()) }
    if let Some(f) = fill { for c in out.line.iter_mut() { *c = (" ".into(), Style::default().bg(f)) } }
    if list_align == Align::Default { draw_none(&mut out, avail, &s, &ranges) }
    else { draw_list(&mut out, avail, &mut s, &ranges, list_align, (focus_start, focus_end)) }
    (out.line, out.ranges)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(line: &[(String, Style)]) -> String { line.iter().map(|c| c.0.as_str()).collect() }

    #[test]
    fn sections_and_lists_as_tmux() {
        let base = Style::default();
        let (l, _) = format_draw("#[align=left]L#[align=right]R#[align=centre]C", base, 11);
        assert_eq!(text(&l), "L    C    R");
        // The list keeps its focus in view, with markers where it was cut.
        let list = "#[list=on align=left]#[list=left-marker]<#[list=right-marker]>#[list=on]aaaa bbbb #[list=focus]CCCC#[list=on] dddd";
        let (l, _) = format_draw(list, base, 10);
        assert_eq!(text(&l), "<b CCCC d>");
        let (l, r) = format_draw("#[range=window|3]x#[norange]y", base, 3);
        assert_eq!(text(&l), "xy ");
        assert_eq!(r, vec![Range { kind: RangeKind::Window(3), start: 0, end: 2 }]);
    }
}
