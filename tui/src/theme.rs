//! The desktop's dark palette (desktop/lib/shared/theme/app_theme.dart) as terminal colours, and the
//! engine marks the rail draws. The background stays the terminal's own: this is a terminal first.

use ratatui::style::{Color, Modifier, Style};

use crate::fleet::State;

/// fzf 0.67's colours, ported (src/tui/tui.go, src/options.go): a theme's slots as colour and
/// attributes — each maybe undefined — the base themes, --color's parsing (a scheme word
/// replaces the whole theme, `slot:…` merges into one), InitTheme (bold forced on the current
/// line, prompt, query, pointer and spinner unless --no-bold or `regular`; what inherits from
/// what; bw's reverse and underline), and the pairs a list is drawn with.
pub mod fzfcolor {
    use ratatui::style::{Color, Modifier, Style};

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum Col { Undef, Default, Idx(u8), Rgb(u8, u8, u8) }

    pub const BOLD: u32 = 1;
    pub const DIM: u32 = 1 << 1;
    pub const ITALIC: u32 = 1 << 2;
    pub const UNDERLINE: u32 = 1 << 3;
    pub const BLINK: u32 = 1 << 4;
    pub const REVERSE: u32 = 1 << 5;
    pub const STRIKE: u32 = 1 << 6;
    pub const REGULAR: u32 = 1 << 8;
    pub const BOLD_FORCE: u32 = 1 << 10;
    pub const STRIP: u32 = 1 << 12;

    /// ColorAttr: a colour and attributes (0: undefined).
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub struct CA { pub col: Col, pub attr: u32 }

    const U: CA = CA { col: Col::Undef, attr: 0 };
    const D: CA = CA { col: Col::Default, attr: 0 };
    const fn c(n: u8) -> CA { CA { col: Col::Idx(n), attr: 0 } }

    /// Attr.Merge: `regular` keeps only the bold the system forced.
    fn attr_merge(a: u32, b: u32) -> u32 { if b & REGULAR != 0 { (b & !REGULAR) | (a & BOLD_FORCE) } else { (a & !REGULAR) | b } }

    impl CA {
        fn color_defined(self) -> bool { self.col != Col::Undef }
        fn attr_defined(self) -> bool { self.attr & !BOLD_FORCE != 0 }
        fn undefined(self) -> bool { !self.color_defined() && !self.attr_defined() }
        /// ColorAttr.Merge.
        fn merge(self, o: CA) -> CA { let mut a = self; if o.col != Col::Undef { a.col = o.col } if o.attr != 0 { a.attr = attr_merge(a.attr, o.attr) } a }
    }

    /// InitTheme's o(): b's colour and attributes over a's, each where b has one.
    fn over(a: CA, b: CA) -> CA { let mut r = a; if b.col != Col::Undef { r.col = b.col } if b.attr != 0 { r.attr = b.attr } r }

    #[derive(Clone, Copy, Debug)]
    pub struct Theme {
        pub colored: bool,
        pub input: CA, pub ghost: CA, pub nomatch: CA, pub fg: CA, pub bg: CA, pub list_fg: CA, pub list_bg: CA, pub alt_bg: CA,
        pub selected_fg: CA, pub selected_bg: CA, pub selected_match: CA, pub dark_bg: CA, pub gutter: CA, pub prompt: CA,
        pub input_bg: CA, pub matched: CA, pub current: CA, pub current_match: CA, pub spinner: CA, pub info: CA,
        pub cursor: CA, pub marker: CA, pub header: CA, pub header_bg: CA, pub separator: CA, pub scrollbar: CA,
        pub border: CA, pub border_label: CA, pub list_border: CA, pub gap_line: CA,
        pub input_border: CA, pub header_border: CA, pub footer_border: CA,
        pub list_label: CA, pub input_label: CA, pub header_label: CA, pub footer_label: CA, pub footer: CA,
        pub preview_fg: CA, pub preview_bg: CA, pub preview_border: CA, pub preview_scrollbar: CA, pub preview_label: CA,
    }

    pub const NO_COLOR: Theme = Theme {
        colored: false, input: D, ghost: U, nomatch: U, fg: D, bg: D, list_fg: D, list_bg: D, alt_bg: U, selected_fg: D, selected_bg: D,
        selected_match: D, dark_bg: D, gutter: U, prompt: D, input_bg: D, matched: D, current: U, current_match: U, spinner: D,
        info: D, cursor: D, marker: D, header: D, header_bg: D, separator: D, scrollbar: D, border: U, border_label: D, list_border: D, gap_line: D, input_border: D, header_border: D, footer_border: D, list_label: D, input_label: D, header_label: D, footer_label: D, footer: D,
        preview_fg: D, preview_bg: D, preview_border: D, preview_scrollbar: D, preview_label: D,
    };
    pub const EMPTY: Theme = Theme {
        colored: true, input: U, ghost: U, nomatch: U, fg: U, bg: U, list_fg: U, list_bg: U, alt_bg: U, selected_fg: U, selected_bg: U,
        selected_match: U, dark_bg: U, gutter: U, prompt: U, input_bg: U, matched: U, current: U, current_match: U, spinner: U,
        info: U, cursor: U, marker: U, header: U, header_bg: U, separator: U, scrollbar: U, border: U, border_label: U, list_border: U, gap_line: U, input_border: U, header_border: U, footer_border: U, list_label: U, input_label: U, header_label: U, footer_label: U, footer: U,
        preview_fg: U, preview_bg: U, preview_border: U, preview_scrollbar: U, preview_label: U,
    };
    pub const DEFAULT16: Theme = Theme {
        colored: true, input: D, ghost: U, nomatch: U, fg: D, bg: D, list_fg: U, list_bg: U, alt_bg: U, selected_fg: U, selected_bg: U,
        selected_match: U, dark_bg: c(8), gutter: U, prompt: c(4), input_bg: U, matched: c(2), current: c(15), current_match: c(10),
        spinner: c(2), info: c(3), cursor: c(1), marker: c(5), header: c(6), header_bg: U, separator: U, scrollbar: U, border: U,
        border_label: D, list_border: U, gap_line: U, input_border: U, header_border: U, footer_border: U, list_label: U, input_label: U, header_label: U, footer_label: U, footer: U, preview_fg: U, preview_bg: U, preview_border: U, preview_scrollbar: U, preview_label: U,
    };
    pub const DARK256: Theme = Theme {
        colored: true, input: D, ghost: U, nomatch: U, fg: D, bg: D, list_fg: U, list_bg: U, alt_bg: U, selected_fg: U, selected_bg: U,
        selected_match: U, dark_bg: c(236), gutter: U, prompt: c(110), input_bg: U, matched: c(108), current: c(254), current_match: c(151),
        spinner: c(148), info: c(144), cursor: c(161), marker: c(168), header: c(109), header_bg: U, separator: U, scrollbar: U,
        border: c(59), border_label: c(145), list_border: U, gap_line: U, input_border: U, header_border: U, footer_border: U, list_label: U, input_label: U, header_label: U, footer_label: U, footer: U, preview_fg: U, preview_bg: U, preview_border: U, preview_scrollbar: U, preview_label: U,
    };
    pub const LIGHT256: Theme = Theme {
        colored: true, input: D, ghost: U, nomatch: U, fg: D, bg: D, list_fg: U, list_bg: U, alt_bg: U, selected_fg: U, selected_bg: U,
        selected_match: U, dark_bg: c(251), gutter: U, prompt: c(25), input_bg: U, matched: c(66), current: c(237), current_match: c(23),
        spinner: c(65), info: c(101), cursor: c(161), marker: c(168), header: c(31), header_bg: U, separator: U, scrollbar: U,
        border: c(145), border_label: c(59), list_border: U, gap_line: U, input_border: U, header_border: U, footer_border: U, list_label: U, input_label: U, header_label: U, footer_label: U, footer: U, preview_fg: U, preview_bg: U, preview_border: U, preview_scrollbar: U, preview_label: U,
    };

    /// A --color value's colour: -1, 0–255, #rrggbb, a name.
    fn colour(v: &str) -> Option<Col> {
        let named = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
        if let Some(n) = named.iter().position(|x| *x == v) { return Some(Col::Idx(n as u8)) }
        if let Some(n) = v.strip_prefix("bright-").and_then(|b| named.iter().position(|x| *x == b)) { return Some(Col::Idx(n as u8 + 8)) }
        if v == "bright-black" || v == "gray" || v == "grey" { return Some(Col::Idx(8)) }
        if v.len() == 7 && v.starts_with('#') { let n = u32::from_str_radix(&v[1..], 16).ok()?; return Some(Col::Rgb((n >> 16) as u8, (n >> 8) as u8, n as u8)) }
        match v.parse::<i32>() { Ok(-1) => Some(Col::Default), Ok(n) if (0..=255).contains(&n) => Some(Col::Idx(n as u8)), _ => None }
    }

    /// parseTheme: each word of a --color value in turn — a scheme replaces the whole theme (and
    /// is the base), `slot:colour:attr…` merges into that slot. Returns the base it named, if any.
    pub fn parse(theme: &mut Theme, spec: &str) -> Option<Theme> {
        let mut base = None;
        let lower = spec.to_lowercase();
        for word in lower.split(|c: char| c == ',' || c.is_whitespace()).map(str::trim).filter(|w| !w.is_empty()) {
            let scheme = match word { "dark" => Some(DARK256), "light" => Some(LIGHT256), "base16" | "16" => Some(DEFAULT16), "bw" | "no" => Some(NO_COLOR), _ => None };
            if let Some(s) = scheme { base = Some(s); *theme = s; continue }
            let parts: Vec<&str> = word.split(':').collect();
            if parts.len() < 2 { continue }
            let slot = match parts[0] {
                "query" | "input" | "input-fg" => &mut theme.input, "ghost" => &mut theme.ghost, "fg" => &mut theme.fg, "bg" => &mut theme.bg,
                "list-fg" => &mut theme.list_fg, "list-bg" => &mut theme.list_bg, "current-fg" | "fg+" => &mut theme.current,
                "current-bg" | "bg+" => &mut theme.dark_bg, "alt-bg" => &mut theme.alt_bg, "selected-fg" => &mut theme.selected_fg,
                "selected-bg" => &mut theme.selected_bg, "gutter" => &mut theme.gutter, "hl" => &mut theme.matched,
                "current-hl" | "hl+" => &mut theme.current_match, "selected-hl" => &mut theme.selected_match, "border" => &mut theme.border,
                "separator" => &mut theme.separator, "scrollbar" => &mut theme.scrollbar, "label" => &mut theme.border_label,
                "list-border" => &mut theme.list_border, "gap-line" => &mut theme.gap_line,
                "input-border" => &mut theme.input_border, "header-border" => &mut theme.header_border, "footer-border" => &mut theme.footer_border,
                "list-label" => &mut theme.list_label, "input-label" => &mut theme.input_label, "header-label" => &mut theme.header_label, "footer-label" => &mut theme.footer_label,
                "footer" | "footer-fg" => &mut theme.footer, "prompt" => &mut theme.prompt, "input-bg" => &mut theme.input_bg,
                "nomatch" => &mut theme.nomatch, "spinner" => &mut theme.spinner, "info" => &mut theme.info, "pointer" => &mut theme.cursor, "marker" => &mut theme.marker,
                "header" | "header-fg" => &mut theme.header, "header-bg" => &mut theme.header_bg,
                "preview-fg" => &mut theme.preview_fg, "preview-bg" => &mut theme.preview_bg, "preview-border" => &mut theme.preview_border,
                "preview-scrollbar" => &mut theme.preview_scrollbar, "preview-label" => &mut theme.preview_label,
                _ => continue,
            };
            for comp in &parts[1..] {
                match *comp {
                    "regular" => slot.attr = REGULAR,
                    "bold" | "strong" => slot.attr |= BOLD, "dim" => slot.attr |= DIM, "strip" => slot.attr |= STRIP,
                    "italic" => slot.attr |= ITALIC, "underline" => slot.attr |= UNDERLINE, "blink" => slot.attr |= BLINK,
                    "reverse" => slot.attr |= REVERSE, "strikethrough" => slot.attr |= STRIKE, "" => {}
                    other => { if let Some(col) = colour(other) { slot.col = col } }
                }
            }
        }
        base
    }

    /// ColorPair: what a cell is drawn with.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub struct P { pub fg: Col, pub bg: Col, pub attr: u32 }

    impl P {
        /// ColorPair.merge: the other's attributes merged in, its colours where they are not `except`.
        fn merged(self, o: P, except: Col) -> P {
            let mut d = self;
            d.attr = attr_merge(d.attr, o.attr);
            if o.fg != except { d.fg = o.fg }
            if o.bg != except { d.bg = o.bg }
            d
        }
        pub fn merge(self, o: P) -> P { self.merged(o, Col::Undef) }
        pub fn merge_non_default(self, o: P) -> P { self.merged(o, Col::Default) }
        pub fn with_attr(self, a: u32) -> P { P { attr: attr_merge(self.attr, a), ..self } }
        /// ColorPair.WithBg: the other's colour as the background, its attributes merged in.
        pub fn with_fg(self, fg: CA) -> P { self.merge(P { fg: fg.col, bg: Col::Undef, attr: fg.attr }) }
        pub fn with_bg(self, bg: CA) -> P { self.merge(P { fg: Col::Undef, bg: bg.col, attr: bg.attr }) }
        /// HasBg: a background other than the default shows (a reverse shows its foreground).
        pub fn has_bg(self) -> bool { self.attr & REVERSE == 0 && self.bg != Col::Default || self.attr & REVERSE != 0 && self.fg != Col::Default }
        pub fn style(self) -> Style {
            let m = modifiers(self.attr);
            Style { fg: Some(color(self.fg)), bg: Some(color(self.bg)), add_modifier: m, sub_modifier: Modifier::all() - m, ..Style::default() }
        }
    }

    /// A part of a line with its own colours (hn's glyphs, a dim detail) as fzf reads an --ansi
    /// part: its colour (-1 where it has none) and attributes.
    pub fn own(st: Style) -> P {
        let col = |c: Option<Color>| match c {
            None | Some(Color::Reset) => Col::Default,
            Some(Color::Indexed(n)) => Col::Idx(n),
            Some(Color::Rgb(r, g, b)) => Col::Rgb(r, g, b),
            Some(named) => Col::Idx(match named {
                Color::Black => 0, Color::Red => 1, Color::Green => 2, Color::Yellow => 3, Color::Blue => 4, Color::Magenta => 5,
                Color::Cyan => 6, Color::Gray => 7, Color::DarkGray => 8, Color::LightRed => 9, Color::LightGreen => 10,
                Color::LightYellow => 11, Color::LightBlue => 12, Color::LightMagenta => 13, Color::LightCyan => 14, _ => 15,
            }),
        };
        let m = st.add_modifier;
        let mut attr = 0;
        for (f, a) in [(Modifier::BOLD, BOLD), (Modifier::DIM, DIM), (Modifier::ITALIC, ITALIC), (Modifier::UNDERLINED, UNDERLINE), (Modifier::SLOW_BLINK, BLINK), (Modifier::REVERSED, REVERSE), (Modifier::CROSSED_OUT, STRIKE)] { if m.contains(f) { attr |= a } }
        P { fg: col(st.fg), bg: col(st.bg), attr }
    }

    /// colorOffsets' ansiToColorPair: an own-coloured part over a base — its colour, or the
    /// base's where it has none, the base's attributes merged in; no colour at all in bw.
    pub fn ansi(own: P, base: P, colored: bool) -> P {
        if !colored { return P { fg: Col::Default, bg: Col::Default, attr: own.attr }.with_attr(base.attr) }
        if base.attr & STRIP != 0 { return base }
        P { fg: if own.fg == Col::Default { base.fg } else { own.fg }, bg: if own.bg == Col::Default { base.bg } else { own.bg }, attr: own.attr }.with_attr(base.attr)
    }

    /// A lit character: over plain text, the base with the match merged in; over an own-coloured
    /// part, that part's colour with the match's where the match has one (colorOffsets).
    pub fn lit(base: P, matched: P, part: Option<P>, colored: bool) -> P {
        let color = base.merge(matched);
        let Some(own) = part else { return color };
        let orig = ansi(own, matched, colored);
        if color.fg == Col::Default && orig.has_bg() { orig } else { orig.merge_non_default(color) }
    }

    /// The pairs a list is drawn with (initPalette) — fzf's whole palette, some for what hn does
    /// not draw yet (jump labels, list borders).
    #[derive(Clone, Copy, Debug)]
    #[allow(dead_code)]
    pub struct Palette {
        pub prompt: P, pub normal: P, pub selected: P, pub input: P, pub ghost: P, pub matched: P, pub selected_match: P,
        pub cursor: P, pub cursor_empty: P, pub cursor_empty_char: P, pub marker: P, pub current: P, pub current_match: P, pub current_cursor: P,
        pub current_cursor_empty: P, pub current_marker: P, pub current_selected_empty: P, pub spinner: P, pub info: P,
        pub separator: P, pub scrollbar: P, pub border: P, pub header: P, pub list_border: P, pub gap_line: P, pub border_label: P,
        pub preview: P, pub preview_border: P, pub preview_label: P, pub preview_scrollbar: P,
        /// The sections' own (InitTheme): their borders, their labels, the footer's text.
        pub input_border: P, pub header_border: P, pub footer_border: P,
        pub list_label: P, pub input_label: P, pub header_label: P, pub footer_label: P, pub footer: P,
        /// --color=alt-bg: every other row's background (undefined: no stripes).
        pub alt_bg: CA, pub nomatch: CA,
        /// Whether the base theme has colours (not bw / NO_COLOR).
        pub colored: bool,
    }

    fn color(col: Col) -> Color {
        match col { Col::Undef | Col::Default => Color::Reset, Col::Idx(n) => Color::Indexed(n), Col::Rgb(r, g, b) => Color::Rgb(r, g, b) }
    }

    fn modifiers(attr: u32) -> Modifier {
        let mut m = Modifier::empty();
        if attr & (BOLD | BOLD_FORCE) != 0 { m |= Modifier::BOLD }
        if attr & DIM != 0 { m |= Modifier::DIM }
        if attr & ITALIC != 0 { m |= Modifier::ITALIC }
        if attr & UNDERLINE != 0 { m |= Modifier::UNDERLINED }
        if attr & BLINK != 0 { m |= Modifier::SLOW_BLINK }
        if attr & REVERSE != 0 { m |= Modifier::REVERSED }
        if attr & STRIKE != 0 { m |= Modifier::CROSSED_OUT }
        m
    }

    /// initPalette's pair(): with a default-coloured reverse, the background is the default too.
    fn pair(fg: CA, mut bg: CA) -> P {
        if fg.col == Col::Default && fg.attr & REVERSE != 0 { bg.col = Col::Default }
        P { fg: fg.col, bg: bg.col, attr: fg.attr }
    }

    /// InitTheme, then initPalette: the theme finished over its base, as the pairs to draw with.
    pub fn init(theme: Theme, base: Theme, bold: bool) -> Palette {
        let mut t = theme;
        if bold {
            let boldify = |c: CA| if c.attr & REGULAR == 0 { CA { attr: c.attr | BOLD_FORCE, ..c } } else { c };
            t.current = boldify(t.current);
            t.current_match = boldify(t.current_match);
            t.prompt = boldify(t.prompt);
            t.input = boldify(t.input);
            t.cursor = boldify(t.cursor);
            t.spinner = boldify(t.spinner);
        }
        t.input = over(base.input, t.input);
        t.fg = over(base.fg, t.fg);
        t.bg = over(base.bg, t.bg);
        t.dark_bg = over(base.dark_bg, t.dark_bg);
        t.prompt = over(base.prompt, t.prompt);
        let mut matched = t.matched;
        if !base.colored && matched.undefined() { matched.attr = UNDERLINE }
        t.matched = over(base.matched, matched);
        let mut current = t.current;
        if !base.colored && current.undefined() { current.attr |= REVERSE }
        t.current = t.fg.merge(over(base.current, current));
        let mut current_match = t.current_match;
        if !base.colored && current_match.undefined() { current_match.attr |= REVERSE | UNDERLINE }
        t.current_match = over(base.current_match, current_match);
        t.spinner = over(base.spinner, t.spinner);
        t.info = over(base.info, t.info);
        t.cursor = over(base.cursor, t.cursor);
        t.marker = over(base.marker, t.marker);
        t.header = over(base.header, t.header);
        let mut border = t.border;
        if base.border.undefined() && border.undefined() { border.attr = DIM }
        t.border = over(base.border, border);
        t.border_label = over(base.border_label, t.border_label);
        t.list_fg = over(t.fg, t.list_fg);
        t.list_bg = over(t.bg, t.list_bg);
        t.selected_fg = over(t.list_fg, t.selected_fg);
        t.selected_bg = over(t.list_bg, t.selected_bg);
        t.selected_match = over(t.matched, t.selected_match);
        if t.nomatch.undefined() { t.nomatch.attr = DIM }
        let mut ghost = t.ghost;
        if ghost.undefined() { ghost.attr = DIM } else if ghost.color_defined() && !ghost.attr_defined() { ghost.attr = REGULAR }
        t.ghost = over(t.input, ghost);
        let mut gutter = t.gutter;
        if !base.colored && gutter.undefined() { gutter.attr = DIM }
        t.gutter = over(t.dark_bg, gutter);
        // (Whether the scrollbar and the preview border were given, before they inherit.)
        let (scrollbar_defined, preview_border_defined) = (!t.scrollbar.undefined(), !t.preview_border.undefined());
        t.preview_fg = over(t.fg, t.preview_fg);
        t.preview_bg = over(t.bg, t.preview_bg);
        t.preview_label = over(t.border_label, t.preview_label);
        t.preview_border = over(t.border, t.preview_border);
        t.list_border = over(t.border, t.list_border);
        t.gap_line = over(t.list_border, t.gap_line);
        t.input_border = over(t.border, t.input_border);
        t.header_border = over(t.border, t.header_border);
        t.footer_border = over(t.border, t.footer_border);
        t.list_label = over(t.border_label, t.list_label);
        t.input_label = over(t.border_label, t.input_label);
        t.header_label = over(t.border_label, t.header_label);
        t.footer_label = over(t.border_label, t.footer_label);
        t.footer = over(t.header, t.footer);
        t.separator = over(t.list_border, t.separator);
        t.scrollbar = over(t.list_border, t.scrollbar);
        t.preview_scrollbar = if scrollbar_defined && !preview_border_defined { over(t.scrollbar, t.preview_scrollbar) } else { over(t.preview_border, t.preview_scrollbar) };
        // No input window of its own: the input's background is the list's.
        t.input_bg = over(t.bg, t.list_bg);
        t.header_bg = over(t.bg, t.list_bg);
        let blank = CA { attr: REGULAR, ..t.list_fg };
        Palette {
            prompt: pair(t.prompt, t.input_bg), normal: pair(t.list_fg, t.list_bg), selected: pair(t.selected_fg, t.selected_bg),
            input: pair(t.input, t.input_bg), ghost: pair(t.ghost, t.input_bg), matched: pair(t.matched, t.list_bg),
            selected_match: pair(t.selected_match, t.selected_bg), cursor: pair(t.cursor, t.gutter),
            cursor_empty: pair(blank, t.gutter), cursor_empty_char: pair(t.gutter, t.list_bg),
            marker: if t.selected_bg.col != t.list_bg.col { pair(t.marker, t.selected_bg) } else { pair(t.marker, t.list_bg) },
            current: pair(t.current, t.dark_bg), current_match: pair(t.current_match, t.dark_bg), current_cursor: pair(t.cursor, t.dark_bg),
            current_cursor_empty: pair(blank, t.dark_bg), current_marker: pair(t.marker, t.dark_bg), current_selected_empty: pair(blank, t.dark_bg),
            spinner: pair(t.spinner, t.input_bg), info: pair(t.info, t.input_bg), separator: pair(t.separator, t.input_bg),
            scrollbar: pair(t.scrollbar, t.list_bg), border: pair(t.border, t.bg), header: pair(t.header, t.header_bg),
            list_border: pair(t.list_border, t.list_bg), gap_line: pair(t.gap_line, t.list_bg), border_label: pair(t.border_label, t.bg),
            preview: pair(t.preview_fg, t.preview_bg), preview_border: pair(t.preview_border, t.preview_bg),
            preview_label: pair(t.preview_label, t.preview_bg), preview_scrollbar: pair(t.preview_scrollbar, t.preview_bg), alt_bg: t.alt_bg, nomatch: t.nomatch, colored: base.colored,
            input_border: pair(t.input_border, t.bg), header_border: pair(t.header_border, t.bg), footer_border: pair(t.footer_border, t.bg),
            list_label: pair(t.list_label, t.bg), input_label: pair(t.input_label, t.bg), header_label: pair(t.header_label, t.bg), footer_label: pair(t.footer_label, t.bg),
            footer: pair(t.footer, t.header_bg),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn pal(specs: &[&str], bold: bool) -> Palette {
            let mut t = EMPTY;
            let mut base = DARK256;
            for s in specs { if let Some(b) = parse(&mut t, s) { base = b } }
            init(t, base, bold)
        }

        #[test]
        fn fzf_defaults_and_overrides() {
            let s = |p: P| p.style();
            let p = pal(&[], true);
            assert_eq!(s(p.current).fg, Some(Color::Indexed(254)));
            assert_eq!(s(p.current).bg, Some(Color::Indexed(236)));
            assert!(s(p.current).add_modifier.contains(Modifier::BOLD));
            assert_eq!(s(p.spinner).fg, Some(Color::Indexed(148)));
            assert!(s(p.spinner).add_modifier.contains(Modifier::BOLD));
            assert!(!s(p.matched).add_modifier.contains(Modifier::BOLD));
            // --no-bold, and `regular` on a slot, take fzf's bold away.
            assert!(!s(pal(&[], false).current).add_modifier.contains(Modifier::BOLD));
            assert!(!s(pal(&["fg+:regular"], true).current).add_modifier.contains(Modifier::BOLD));
            assert!(!s(pal(&["pointer:regular"], true).current_cursor).add_modifier.contains(Modifier::BOLD));
            // A scheme after a slot starts again from the scheme: hl:1,light is light's hl (66).
            assert_eq!(s(pal(&["hl:1,light"], true).matched).fg, Some(Color::Indexed(66)));
            assert_eq!(s(pal(&["light,hl:1"], true).matched).fg, Some(Color::Indexed(1)));
            // border, separator and scrollbar are separate slots.
            let p = pal(&["border:red,separator:green,scrollbar:blue"], true);
            assert_eq!((s(p.border).fg, s(p.separator).fg, s(p.scrollbar).fg), (Some(Color::Indexed(1)), Some(Color::Indexed(2)), Some(Color::Indexed(4))));
            // On the current line an own-coloured part keeps its colour, gains fg+'s bold and bg+;
            // a match in dim text stays dim (colorOffsets).
            let yellow = own(Style::default().fg(Color::Indexed(3)));
            assert_eq!(ansi(yellow, p.current, true), P { fg: Col::Idx(3), bg: Col::Idx(236), attr: BOLD_FORCE });
            let dim = own(Style::default().add_modifier(Modifier::DIM));
            assert_eq!(lit(p.normal, p.matched, Some(dim), true), P { fg: Col::Idx(108), bg: Col::Default, attr: DIM });
        }

        /// --color=alt-bg: the stripe's colour as the row's background, its attributes merged in.
        #[test]
        fn alt_bg_stripes() {
            let p = pal(&["alt-bg:237:underline"], true);
            assert_eq!(p.normal.with_bg(p.alt_bg), P { fg: Col::Default, bg: Col::Idx(237), attr: UNDERLINE });
            assert_eq!(pal(&[], true).alt_bg.col, Col::Undef, "no stripes unless asked");
        }

        #[test]
        fn bw_lights_only_the_current_row() {
            let p = pal(&["bw"], true);
            assert!(p.matched.style().add_modifier.is_empty(), "bw: no light on other rows");
            assert!(p.current_match.style().add_modifier.contains(Modifier::UNDERLINED | Modifier::REVERSED));
            assert!(p.current.style().add_modifier.contains(Modifier::REVERSED | Modifier::BOLD));
            assert!(p.cursor_empty_char.style().add_modifier.contains(Modifier::DIM), "bw's gutter is dim");
        }
    }
}


/// Readable accent for hn controls. ANSI blue can be nearly black in terminal themes.
/// Keep engine branding and explicitly configured tmux colors separate from chrome.
/// A `[look]` accent (`@hn-accent`, a chosen theme's) wins; with none, the terminal's own palette
/// gives it (its colours 1-7, as it answered OSC 4), so the chrome is in the terminal's theme; a
/// terminal that did not answer, hn's teal.
pub fn accent() -> Color {
    if let Some(hex) = crate::term_out::accent_override() {
        if let Some(c) = crate::tmuxconf::colour(&hex) { return c }
    }
    if let Some([r, g, b]) = crate::term_out::native_accent() { return Color::Rgb(r, g, b) }
    if palette().2 { Color::Rgb(0, 100, 120) } else { Color::Rgb(95, 215, 230) }
}

/// The signature colour of a terminal theme, as `#rrggbb` for `@hn-accent`: the palette slot (1-7)
/// that contrasts most with the theme's background while staying saturated. So choosing a theme in
/// `hn theme` tints hn's chrome with it, even though the terminal keeps drawing the background and
/// foreground.
pub fn theme_accent_hex(name: &str) -> Option<String> {
    use crate::terminal_themes::TERMINAL_THEMES;
    TERMINAL_THEMES.iter().find(|t| t.name == name).map(|t| {
        let c = theme_accent_rgb(t);
        format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
    })
}

/// The vivid color of a theme: see [`theme_accent_hex`].
pub fn theme_accent_rgb(t: &crate::terminal_themes::TerminalTheme) -> [u8; 3] {
    let colours: Vec<(usize, [u8; 3])> = (1..=7).map(|i| (i, t.palette[i])).collect();
    accent_of(t.background, &colours)
}

/// The accent a palette gives on [bg]: of its colours 1-7 ([colours], by number), the one that
/// stands out most from the background while staying a colour — for a bundled theme, and for the
/// terminal's own palette when no theme is chosen.
pub fn accent_of(bg: [u8; 3], colours: &[(usize, [u8; 3])]) -> [u8; 3] {
    let lum = |c: [u8; 3]| 0.299 * c[0] as f64 + 0.587 * c[1] as f64 + 0.114 * c[2] as f64;
    let chroma = |c: [u8; 3]| {
        let mx = c[0].max(c[1]).max(c[2]) as f64;
        let mn = c[0].min(c[1]).min(c[2]) as f64;
        if mx == 0.0 { 0.0 } else { (mx - mn) / mx }
    };
    let bg_lum = lum(bg);
    // (Colour 7 is the palette's white: never an accent, or a dark theme's focused border is just
    // its text colour. The rest: as far from the background as it is vivid, both 0 to 1.)
    let hues: Vec<[u8; 3]> = colours.iter().filter(|(i, _)| (1..=6).contains(i)).map(|(_, c)| *c).collect();
    let mut best = colours.iter().find(|(i, _)| *i == 6).or(colours.first()).map(|(_, c)| *c).unwrap_or([95, 215, 230]);
    let mut best_score = f64::MIN;
    for p in &hues {
        let score = (lum(*p) - bg_lum).abs() / 255.0 + chroma(*p);
        if score > best_score { best_score = score; best = *p; }
    }
    best
}
// Semantic status colors use the terminal palette. SOFT and MUTED represent emphasis;
// `fg` applies it to the theme's foreground.
pub const ACCENT_SOFT: Color = Color::Cyan;
pub const ONLINE: Color = Color::Green;
pub const WARN: Color = Color::Yellow;
pub const ATTENTION: Color = Color::Yellow;
pub const DANGER: Color = Color::Red;
pub const TEAL: Color = Color::Cyan;
pub const MUTED: Color = Color::Indexed(8);
pub const SOFT: Color = Color::Indexed(7);
pub const TEXT: Color = Color::Reset;

/// hn's chrome from the terminal's OSC 10/11 answer: `(background, foreground, is_light)`.
/// Every piece of hn's chrome — the status bar, the message line, the pane borders — takes its
/// colours from this one palette, so none of it disagrees with the theme. The foreground is made
/// readable on the background; a deterministic dark default holds until the terminal answers.
pub fn palette() -> (Color, Color, bool) {
    let (bg, fg) = crate::term_out::terminal_colours()
        .unwrap_or_else(|| ("#201f26".to_string(), "#f5f5f5".to_string()));
    let light = crate::term_out::terminal_is_light().unwrap_or(false);
    let bg = crate::tmuxconf::colour(&bg).unwrap_or(Color::Reset);
    let fg = crate::tmuxconf::colour(&fg).unwrap_or(Color::Reset);
    (bg, fg, light)
}

/// Surface colors derived from the terminal theme, with a stable fallback before OSC replies.
#[derive(Clone, Copy, Debug)]
pub struct PanePalette {
    /// The terminal's (or theme's) own background: hn's chrome — the panel, the side bar — sits
    /// on it, as the panes do; `surface` is the focused pane's fill, lifted off it.
    pub background: Color,
    pub surface: Color, pub inactive_surface: Color,
    pub foreground: Color, pub inactive_foreground: Color, pub muted: Color,
    pub active_foreground: Color,
    pub border: Color, pub active_border: Color,
    pub status: Color, pub status_foreground: Color,
}

pub fn pane_palette() -> PanePalette {
    let native = crate::term_out::terminal_colours().and_then(|(bg, fg)|
        Some((crate::tmuxconf::colour(&bg)?, crate::tmuxconf::colour(&fg)?)));
    pane_palette_for(native)
}

/// The surfaces the terminal's own colours make, whatever theme is chosen.
pub fn native_pane_palette() -> PanePalette {
    let native = crate::term_out::native_terminal_colours().and_then(|(bg, fg)|
        Some((crate::tmuxconf::colour(&bg)?, crate::tmuxconf::colour(&fg)?)));
    pane_palette_for(native)
}

/// The surfaces a theme's own background and foreground make — what choosing it would draw.
pub fn pane_palette_of(bg: [u8; 3], fg: [u8; 3]) -> PanePalette {
    pane_palette_for(Some((Color::Rgb(bg[0], bg[1], bg[2]), Color::Rgb(fg[0], fg[1], fg[2]))))
}

fn pane_palette_for(native: Option<(Color, Color)>) -> PanePalette {
    let (bg, foreground) = native.unwrap_or((Color::Rgb(28, 31, 36), Color::Rgb(220, 225, 231)));
    let Color::Rgb(r, g, b) = bg else { unreachable!("terminal background is RGB") };
    let light = 299 * r as u32 + 587 * g as u32 + 114 * b as u32 > 128_000;
    let mix = |a: Color, b: Color, amount: u16| {
        let (Color::Rgb(ar, ag, ab), Color::Rgb(br, bg, bb)) = (a, b) else { return a };
        let c = |a: u8, b: u8| ((a as u16 * (100 - amount) + b as u16 * amount) / 100) as u8;
        Color::Rgb(c(ar, br), c(ag, bg), c(ab, bb))
    };
    let green = if light { Color::Rgb(58, 102, 48) } else { Color::Rgb(133, 181, 105) };
    let inactive_surface = if light { mix(bg, foreground, 8) } else { Color::Rgb(64, 64, 64) };
    // Panes sit directly on the native terminal background. Lift the focused fill
    // just enough to distinguish its edge while retaining the terminal's theme.
    let surface = mix(bg, foreground, if light { 4 } else { 10 });
    let surface = if surface == inactive_surface { mix(bg, foreground, if light { 2 } else { 6 }) } else { surface };
    PanePalette {
        background: bg,
        surface,
        inactive_surface,
        foreground, inactive_foreground: mix(foreground, bg, 9),
        muted: mix(foreground, bg, 30),
        border: mix(inactive_surface, foreground, 20),
        active_border: if light { Color::Rgb(70, 86, 103) } else { Color::Rgb(226, 230, 235) },
        active_foreground: if light { Color::Rgb(74, 89, 105) } else { Color::Rgb(192, 200, 210) },
        // A familiar green anchor, subdued enough that the working pane keeps the attention.
        status: mix(bg, green, if light { 18 } else { 28 }),
        status_foreground: if light { Color::Rgb(35, 62, 29) } else { Color::Rgb(196, 216, 183) },
    }
}

/// fzf's colours — its dark256 default, or what `--color=light|16|bw` in `$FZF_DEFAULT_OPTS` asks
/// for (and bw under NO_COLOR), so a list here looks like fzf does on this terminal.
#[derive(Clone)]
pub struct Fzf { pub reverse: bool, pub unicode: bool, pub pointer_char: String, pub marker_char: String, pub marker_multi: [String; 3], pub prompt_text: String, pub bg_plus: Color, pub hl: Color, pub prompt: Color, pub bw: bool, pub pal: fzfcolor::Palette }

impl Fzf {
    /// The border (and --border's glyphs) and the scrollbar: each its own slot.
    pub fn border_style(&self) -> Style { self.pal.border.style() }
    pub fn scrollbar_style(&self) -> Style { self.pal.scrollbar.style() }
    pub fn prompt_style(&self) -> Style { self.pal.prompt.style() }
    pub fn header_style(&self) -> Style { self.pal.header.style() }
}

/// FZF_DEFAULT_OPTS_FILE's options, then FZF_DEFAULT_OPTS's, each split as fzf splits it (one
/// fzf would refuse — a quote left open — gives none).
pub fn default_opts() -> Vec<String> {
    let file = std::env::var("FZF_DEFAULT_OPTS_FILE").ok().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let mut words = shell_words(&file).unwrap_or_default();
    words.extend(shell_words(&std::env::var("FZF_DEFAULT_OPTS").unwrap_or_default()).unwrap_or_default());
    words
}

/// A --color slot's value: `-1`, 0–255, #rrggbb, a name (bright-* too), and attributes, in any
/// order — the last colour wins, the attributes add up (`regular` clears them).
pub fn fzf_spec(v: &str) -> (Option<Color>, Modifier) {
    let (mut colour, mut attrs) = (None, Modifier::empty());
    for c in v.split(':') {
        match c {
            "regular" => attrs = Modifier::empty(),
            "bold" | "strong" => attrs |= Modifier::BOLD, "dim" => attrs |= Modifier::DIM, "italic" => attrs |= Modifier::ITALIC,
            "underline" => attrs |= Modifier::UNDERLINED, "blink" => attrs |= Modifier::SLOW_BLINK, "reverse" => attrs |= Modifier::REVERSED,
            "strikethrough" => attrs |= Modifier::CROSSED_OUT, "strip" | "" => {}
            other => { if let Some(c) = fzf_colour(other) { colour = Some(c) } }
        }
    }
    (colour, attrs)
}

/// What a list's change-* actions made of the look and the options (change-prompt, change-ghost,
/// hide-input …): in force until the next list opens (fzf starts from its options each time).
static FZF_LIVE: std::sync::atomic::AtomicPtr<Fzf> = std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());
static OPTS_LIVE: std::sync::atomic::AtomicPtr<FzfOpts> = std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

/// The look changed for this list (the one before stays: a reference to it may be held).
pub fn fzf_change(f: impl FnOnce(&mut Fzf)) {
    let mut c = fzf().clone();
    f(&mut c);
    FZF_LIVE.store(Box::into_raw(Box::new(c)), std::sync::atomic::Ordering::Release);
}

/// The options changed for this list.
pub fn opts_change(f: impl FnOnce(&mut FzfOpts)) {
    let mut c = fzf_opts().clone();
    f(&mut c);
    // (No list or preview in hn draws a scrollbar, whatever a list asks: see fzf_opts_base.)
    (c.scrollbar, c.preview_scrollbar) = (None, None);
    OPTS_LIVE.store(Box::into_raw(Box::new(c)), std::sync::atomic::Ordering::Release);
}

/// A new list: the look and options as FZF_DEFAULT_OPTS has them.
pub fn fzf_reset() {
    FZF_LIVE.store(std::ptr::null_mut(), std::sync::atomic::Ordering::Release);
    OPTS_LIVE.store(std::ptr::null_mut(), std::sync::atomic::Ordering::Release);
}

pub fn fzf() -> &'static Fzf {
    let live = FZF_LIVE.load(std::sync::atomic::Ordering::Acquire);
    // SAFETY: set only from a leaked Box, never freed.
    if !live.is_null() { return unsafe { &*live } }
    fzf_base()
}

fn fzf_base() -> &'static Fzf {
    static FZF: std::sync::OnceLock<Fzf> = std::sync::OnceLock::new();
    FZF.get_or_init(|| {
        use fzfcolor::*;
        let opts = default_opts();
        // fzf's defaultOptions: NO_COLOR starts from bw; then each option in turn.
        let (mut theme, mut base) = if no_color() { (NO_COLOR, Some(NO_COLOR)) } else { (EMPTY, None) };
        let (mut bold, mut reverse, mut pointer, mut marker, mut prompt, mut multi, mut unicode) = (true, false, None, None, None, None::<String>, true);
        let mut black = false;
        let mut i = 0;
        while i < opts.len() {
            let w = &opts[i];
            let (flag, value) = match w.split_once('=') { Some((f, v)) => (f.to_string(), Some(v.to_string())), None => (w.clone(), None) };
            let mut take = || value.clone().or_else(|| { i += 1; opts.get(i).cloned() });
            match flag.as_str() {
                "--color" => { match take() { Some(v) if !v.is_empty() => { if let Some(b) = parse(&mut theme, &v) { base = Some(b) } } _ => theme = EMPTY } }
                // applyPreset's gutter: the terminal's own colour under minimal, the theme's otherwise.
                "--style" => { if let Some(v) = take() {
                    use fzfcolor::{CA, Col};
                    match v.split(':').next().unwrap_or("").to_lowercase().as_str() { "minimal" => theme.gutter = CA { col: Col::Default, attr: 0 }, "default" | "full" => theme.gutter = CA { col: Col::Undef, attr: 0 }, _ => {} }
                } }
                "+c" | "--no-color" => { theme = NO_COLOR; base = Some(NO_COLOR) }
                "+2" | "--no-256" => theme = DEFAULT16,
                "--black" => black = true, "--no-black" => black = false,
                "--bold" => bold = true, "--no-bold" => bold = false,
                "--layout" => { if let Some(v) = take() { reverse = v == "reverse" || v == "reverse-list" } }
                "--reverse-list" => reverse = true,
                "--reverse" => reverse = true,
                "--pointer" => pointer = take(),
                "--marker" => marker = take(),
                "--marker-multi-line" => multi = take(),
                "--unicode" => unicode = true, "--no-unicode" => unicode = false,
                "--prompt" => prompt = take(),
                _ => {}
            }
            i += 1;
        }
        // No base named: the renderer's own — 256 colours, or the 16 on a terminal without them.
        // The terminal's own background (when it answered) chooses light over dark, so a light
        // terminal gets the light palette rather than the stock dark one.
        let base = base.unwrap_or_else(|| {
            if let Some(light) = crate::term_out::terminal_is_light() {
                return if light { LIGHT256 } else { DARK256 };
            }
            if depth() < 256 { DEFAULT16 } else { DARK256 }
        });
        if black { theme.bg.col = Col::Idx(0) }
        let pal = init(theme, base, bold);
        let fg = |p: P| p.style().fg.unwrap_or(Color::Reset);
        // --no-unicode: fzf's ASCII pointer and markers.
        let marker_char = marker.unwrap_or_else(|| if unicode { "┃" } else { ">" }.into());
        Fzf {
            reverse,
            unicode,
            pointer_char: pointer.unwrap_or_else(|| if unicode { "▌" } else { ">" }.into()),
            marker_multi: marker_multi(multi.as_deref(), &marker_char, unicode),
            marker_char,
            // (Its first line only, as fzf's firstLine keeps it.)
            prompt_text: prompt.map(|p| p.split('\n').next().unwrap_or("").to_string()).unwrap_or_else(|| "> ".into()),
            bg_plus: pal.current.style().bg.unwrap_or(Color::Reset), hl: fg(pal.matched), prompt: fg(pal.prompt), bw: !pal.colored, pal,
        }
    })
}

/// --marker-multi-line (a marked row of several lines: its first, middle and last lines' markers),
/// as fzf's parseMarkerMultiLine splits it (three of width 1 or 2); none when --marker is ''; the
/// three padded to --marker's width when they are narrower.
fn marker_multi(spec: Option<&str>, marker: &str, unicode: bool) -> [String; 3] {
    use unicode_width::UnicodeWidthStr;
    let parsed = spec.map(|s| {
        let total = s.width();
        if total != 3 && total != 6 { return [String::new(), String::new(), String::new()] }
        let (mut out, mut idx, mut left) = ([String::new(), String::new(), String::new()], 0, total / 3);
        for c in s.chars() {
            if idx == 3 { break }
            left = left.saturating_sub(unicode_width::UnicodeWidthChar::width(c).unwrap_or(0));
            out[idx].push(c);
            if left == 0 { idx += 1; left = total / 3 }
        }
        out
    });
    let mut multi = match parsed {
        Some(m) => m,
        None if marker.is_empty() => Default::default(),
        None if unicode => ["╻".into(), "┃".into(), "╹".into()],
        None => [".".into(), "|".into(), "'".into()],
    };
    let diff = marker.width() as i64 - multi[0].width() as i64;
    if diff > 0 && !multi[0].is_empty() { for m in multi.iter_mut() { m.push_str(&" ".repeat(diff as usize)) } }
    multi
}

/// A --margin, --padding or --height size: cells, or a percentage of the screen.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Size { pub size: f64, pub percent: bool }

/// --height: its size, `-` (the screen less it), `~` (no taller than its items need).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Height { pub size: Size, pub inverse: bool, pub auto: bool }

/// fzf's parseSize: N or N%.
fn parse_size(s: &str) -> Option<Size> {
    let (n, percent) = match s.strip_suffix('%') { Some(n) => (n, true), None => (s, false) };
    n.trim().parse::<f64>().ok().filter(|v| *v >= 0.0).map(|size| Size { size, percent })
}

/// parseHeight: `~` adaptive, `-` inverse; none for fzf's full screen (0, or 100% not adaptive).
fn parse_height(s: &str) -> Option<Height> {
    let (auto, s) = match s.strip_prefix('~') { Some(r) => (true, r), None => (false, s) };
    let (inverse, s) = match s.strip_prefix('-') { Some(r) if !auto => (true, r), _ => (false, s) };
    let size = parse_size(s)?;
    if !auto && (size.size == 0.0 || size.percent && size.size == 100.0) && !inverse { return None }
    Some(Height { size, inverse, auto })
}

/// parseMargin: T | TB,RL | T,RL,B | T,R,B,L.
fn parse_margin(s: &str) -> Option<[Size; 4]> {
    let v: Vec<Size> = s.split(',').map(parse_size).collect::<Option<_>>()?;
    match v.len() { 1 => Some([v[0]; 4]), 2 => Some([v[0], v[1], v[0], v[1]]), 3 => Some([v[0], v[1], v[2], v[1]]), 4 => Some([v[0], v[1], v[2], v[3]]), _ => None }
}

/// parseLabelPosition: a column (negative from the right, 0 the centre) and top or bottom.
fn parse_label_pos(s: &str) -> (i64, bool) {
    let (mut column, mut bottom) = (0, false);
    for token in s.to_lowercase().split(':') {
        match token { "center" => column = 0, "bottom" => bottom = true, "top" => bottom = false, n => { if let Ok(c) = n.parse() { column = c } } }
    }
    (column, bottom)
}

/// --preview-window: where the preview goes and how big (right, 50%), its border (rounded; `line`
/// is the side facing the list), wrap (hn wraps its own text unless told `nowrap`), hidden, follow,
/// info (its N/M), the starting scroll (+N[-/D]), and an alternative below a size (<N(…)).
#[derive(Clone, Debug, PartialEq)]
pub struct PreviewWindow {
    pub position: char, pub size: Size, pub border: String, pub wrap: Option<bool>, pub hidden: bool, pub follow: bool,
    pub info: bool, pub scroll: String, pub header_lines: usize, pub threshold: usize, pub alternative: Option<Box<PreviewWindow>>,
}

impl Default for PreviewWindow {
    fn default() -> Self {
        PreviewWindow { position: 'r', size: Size { size: 50.0, percent: true }, border: "rounded".into(), wrap: None, hidden: false, follow: false, info: true, scroll: String::new(), header_lines: 0, threshold: 0, alternative: None }
    }
}

impl PreviewWindow {
    /// previewOpts.Border: `line` as the side facing the list.
    pub fn shape(&self) -> &str {
        if self.border != "line" { return &self.border }
        match self.position { 'u' => "bottom", 'd' => "top", 'l' => "right", _ => "left" }
    }
}

/// parsePreviewWindow: its tokens (split at , and :) over [pw]; `<N(…)` an alternative under N.
pub fn parse_preview_window(pw: &mut PreviewWindow, input: &str) {
    let mut alternative: Option<String> = None;
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && (chars[i] == ',' || chars[i] == ':') { i += 1 }
        if i >= chars.len() { break }
        if chars[i] == '<' {
            let rest: String = chars[i + 1..].iter().collect();
            if let Some((n, tail)) = rest.split_once('(') {
                if let (Ok(threshold), Some((alt, _))) = (n.parse::<usize>(), tail.split_once(')')) {
                    pw.threshold = threshold;
                    alternative = Some(alt.to_string());
                    i += 1 + n.len() + 1 + alt.len() + 1;
                    continue;
                }
            }
        }
        let start = i;
        while i < chars.len() && chars[i] != ',' && chars[i] != ':' { i += 1 }
        let token: String = chars[start..i].iter().collect();
        match token.as_str() {
            "default" => *pw = PreviewWindow::default(),
            "hidden" => pw.hidden = true, "nohidden" => pw.hidden = false,
            "wrap" => pw.wrap = Some(true), "nowrap" => pw.wrap = Some(false),
            "up" | "top" => pw.position = 'u', "down" | "bottom" => pw.position = 'd', "left" => pw.position = 'l', "right" => pw.position = 'r',
            "rounded" | "border" | "border-rounded" => pw.border = "rounded".into(),
            "border-line" => pw.border = "line".into(),
            "sharp" | "border-sharp" => pw.border = "sharp".into(),
            "border-bold" => pw.border = "bold".into(), "border-block" => pw.border = "block".into(),
            "border-thinblock" => pw.border = "thinblock".into(), "border-double" => pw.border = "double".into(),
            "noborder" | "border-none" => pw.border = "none".into(),
            "border-horizontal" => pw.border = "horizontal".into(), "border-vertical" => pw.border = "vertical".into(),
            "border-up" | "border-top" => pw.border = "top".into(), "border-down" | "border-bottom" => pw.border = "bottom".into(),
            "border-left" => pw.border = "left".into(), "border-right" => pw.border = "right".into(),
            "follow" => pw.follow = true, "nofollow" => pw.follow = false,
            "info" => pw.info = true, "noinfo" => pw.info = false,
            t if !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()) || t.ends_with('%') && t[..t.len() - 1].chars().all(|c| c.is_ascii_digit()) && t.len() > 1 => { if let Some(s) = parse_size(t) { pw.size = s } }
            t if t.starts_with('~') => { if let Ok(n) = t[1..].parse() { pw.header_lines = n } }
            t if t.starts_with('+') || t.starts_with('-') || t.starts_with('/') => pw.scroll = t.to_string(),
            _ => {}
        }
    }
    if let Some(alt) = alternative {
        let mut a = pw.clone();
        a.hidden = false;
        a.alternative = None;
        parse_preview_window(&mut a, &alt);
        pw.alternative = Some(Box::new(a));
    }
}

/// A label's text without its ANSI colours.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' { if chars.peek() == Some(&'[') { chars.next(); for d in chars.by_ref() { if d.is_ascii_alphabetic() { break } } } continue }
        out.push(c);
    }
    out
}

/// The rest of FZF_DEFAULT_OPTS that shapes a list: --cycle, --exact, -i/+i, --no-separator,
/// --ellipsis, fg:/bg: colours, and --bind key:action pairs.
#[derive(Clone)]
pub struct FzfOpts { pub info_mode: String, pub prompt_top: bool, pub header_first: bool, pub border: Option<String>, pub no_sort: bool, pub tac: bool, pub tiebreak: Vec<crate::fzf::Tiebreak>, pub selected_bg: Option<Color>, pub info_prefix: String, pub separator_char: String, pub scrollbar: Option<String>, pub preview_scrollbar: Option<String>, pub cycle: bool, pub exact: bool, pub case: Option<bool>, pub separator: bool, pub ellipsis: String, pub fg: Option<Color>, pub bg: Option<Color>, pub list_bg: Option<Color>, pub binds: Vec<(String, String)>, pub hscroll: bool, pub hscroll_off: usize, pub highlight_line: bool, pub scroll_off: usize, pub tabstop: usize, pub wrap: bool, pub wrap_sign: String, pub height: Option<Height>, pub min_height: i64, pub margin: [Size; 4], pub padding: [Size; 4], pub border_label: String, pub border_label_pos: (i64, bool), pub unicode: bool, pub gutter: Option<String>, pub keep_right: bool, pub gap: usize, pub gap_line: Option<String>, pub preview_window: PreviewWindow, pub preview_label: Option<String>, pub preview_label_pos: (i64, bool), pub literal: bool, pub multi_limit: usize, pub multi: bool, pub preview_window_set: bool,
    /// Each --preview-window as written, in order (a list with a look of its own lays them over it).
    pub preview_window_specs: Vec<String>,
    /// --ghost: what an empty query shows (else the list's own placeholder); --track.
    pub ghost: Option<String>, pub track: bool,
    /// The sections' borders (--list-border, --input-border, --header-border, --footer-border; None:
    /// not set), --footer's lines, and each section's label (--list-label …).
    pub list_border: Option<String>, pub input_border: Option<String>, pub header_border: Option<String>, pub footer_border: Option<String>,
    pub footer: Vec<String>, pub list_label: String, pub input_label: String, pub header_label: String, pub footer_label: String,
    /// --separator given (fzf's opts.Separator not nil): an input border leaves the rule out otherwise.
    pub separator_set: bool,
    /// --no-input: no prompt, no info, no query.
    pub no_input: bool,
    /// --info-command: what the info line says (its output; $FZF_INFO the count it replaces).
    pub info_command: Option<String>,
    /// --algo=v1.
    pub algo_v1: bool,
    /// +x / --no-extended: no search syntax.
    pub no_extended: bool,
    /// --history=FILE and --history-size: the queries C-p and C-n go back through.
    pub history: Option<String>, pub history_size: usize,
    /// --jump-labels: the characters jump mode puts on the rows.
    pub jump_labels: String,
    /// --no-mouse: the list takes no mouse.
    pub no_mouse: bool,
    /// Raw mode keeps nonmatching rows in input order, in the nomatch style.
    pub raw: bool, pub gutter_raw: Option<String>,
    /// Each section label uses the same column and bottom-edge rules as --border-label-pos.
    pub list_label_pos: (i64, bool), pub input_label_pos: (i64, bool), pub header_label_pos: (i64, bool), pub footer_label_pos: (i64, bool) }

pub fn fzf_opts() -> &'static FzfOpts {
    let live = OPTS_LIVE.load(std::sync::atomic::Ordering::Acquire);
    // SAFETY: set only from a leaked Box, never freed.
    if !live.is_null() { return unsafe { &*live } }
    fzf_opts_base()
}

fn fzf_opts_base() -> &'static FzfOpts {
    static OPTS: std::sync::OnceLock<FzfOpts> = std::sync::OnceLock::new();
    OPTS.get_or_init(|| {
        let opts = default_opts();
        let mut o = FzfOpts { info_mode: "default".into(), prompt_top: false, header_first: false, border: None, no_sort: false, tac: false, tiebreak: vec![crate::fzf::Tiebreak::Length], selected_bg: None, info_prefix: String::new(), separator_char: "─".into(), scrollbar: Some("│".into()), preview_scrollbar: Some("│".into()), cycle: false, exact: false, case: None, separator: true, ellipsis: "··".into(), fg: None, bg: None, list_bg: None, binds: Vec::new(), hscroll: true, hscroll_off: 10, highlight_line: false, scroll_off: 3, tabstop: 8, wrap: false, wrap_sign: "↳ ".into(), height: None, min_height: -10, margin: [Size::default(); 4], padding: [Size::default(); 4], border_label: String::new(), border_label_pos: (0, false), unicode: true, gutter: None, keep_right: false, gap: 0, gap_line: None, preview_window: PreviewWindow::default(), preview_label: None, preview_label_pos: (0, false), literal: false, multi_limit: 0, multi: false, preview_window_set: false, preview_window_specs: Vec::new(), ghost: None, track: false, list_border: None, input_border: None, header_border: None, footer_border: None, footer: Vec::new(), list_label: String::new(), input_label: String::new(), header_label: String::new(), footer_label: String::new(), separator_set: false, no_input: false, info_command: None, algo_v1: false, no_extended: false, history: None, history_size: 1000, jump_labels: "asdfghjklqwertyuiopzxcvbnm1234567890ASDFGHJKLQWERTYUIOPZXCVBNM`~;:,<.>/?'\"!@#$%^&*()[{]}-_=+".into(), no_mouse: false, raw: false, gutter_raw: None, list_label_pos: (0, false), input_label_pos: (0, false), header_label_pos: (0, false), footer_label_pos: (0, false) };
        let (mut sep_set, mut bar_set, mut ell_set, mut sign_set) = (false, false, false, false);
        let mut i = 0;
        while i < opts.len() {
            let w = &opts[i];
            let (flag, value) = match w.split_once('=') { Some((f, v)) => (f.to_string(), Some(v.to_string())), None => (w.clone(), None) };
            let mut take = || value.clone().or_else(|| { i += 1; opts.get(i).cloned() });
            match flag.as_str() {
                "--raw" => o.raw = true, "--no-raw" => o.raw = false,
                "--gutter-raw" => { if let Some(v) = take() { if unicode_width::UnicodeWidthStr::width(v.as_str()) == 1 { o.gutter_raw = Some(v) } } }
                "--cycle" => o.cycle = true, "--no-cycle" => o.cycle = false,
                // --multi[=N]: at most N marked (the info then says (1/N)).
                // (fzf's optional number: --multi=2, --multi 2, -m 2, -m2.)
                "--no-multi" | "+m" => { o.multi = false; o.multi_limit = 0 }
                "--multi" | "-m" => {
                    o.multi = true;
                    o.multi_limit = match value.as_deref() {
                        Some(v) => v.parse().unwrap_or(0),
                        None => match opts.get(i + 1).and_then(|n| n.parse::<usize>().ok()) { Some(n) => { i += 1; n } None => 0 },
                    }
                }
                m if m.starts_with("-m") && m.len() > 2 && m[2..].chars().all(|c| c.is_ascii_digit()) => { o.multi = true; o.multi_limit = m[2..].parse().unwrap_or(0) }
                "--hscroll" => o.hscroll = true, "--no-hscroll" => o.hscroll = false,
                "--hscroll-off" => { if let Some(v) = take() { o.hscroll_off = v.parse().unwrap_or(10) } }
                "--highlight-line" => o.highlight_line = true, "--no-highlight-line" => o.highlight_line = false,
                "--scroll-off" => { if let Some(v) = take() { o.scroll_off = v.parse().unwrap_or(3) } }
                "--tabstop" => { if let Some(v) = take() { o.tabstop = v.parse().ok().filter(|n| *n >= 1).unwrap_or(o.tabstop) } }
                // parseInfoStyle: inline's prefix " < " unless it names one (inline[-right]:PREFIX).
                "--inline-info" => { o.info_mode = "inline".into(); o.info_prefix = " < ".into() }
                "--no-inline-info" => o.info_mode = "default".into(),
                "--no-info" => o.info_mode = "hidden".into(),
                "--info" => {
                    if let Some(v) = take() {
                        let style = match v.as_str() {
                            "default" | "right" | "inline-right" | "hidden" => Some((v.clone(), String::new())),
                            "inline" => Some((v.clone(), " < ".into())),
                            _ => v.split_once(':').filter(|(m, _)| matches!(*m, "inline" | "inline-right")).map(|(m, p)| (m.to_string(), p.replace('\n', " "))),
                        };
                        if let Some((mode, prefix)) = style { o.info_mode = mode; o.info_prefix = prefix }
                    }
                }
                "--layout" => { if let Some(v) = take() { o.prompt_top = v == "reverse" } }
                "--reverse" => o.prompt_top = true,
                "--header-first" => o.header_first = true,
                // (Its style is optional: the next word when it is not an option, as optionalNextString takes it.)
                "--border" => {
                    let next = value.clone().or_else(|| opts.get(i + 1).filter(|w| !w.starts_with('-') && !w.starts_with('+')).cloned().inspect(|_| i += 1));
                    o.border = Some(next.unwrap_or_else(|| "rounded".into()))
                }
                "--no-border" => o.border = None,
                // The sections' borders: a shape (rounded when none is given), or none.
                "--list-border" | "--input-border" | "--header-border" | "--footer-border" => {
                    let next = value.clone().or_else(|| opts.get(i + 1).filter(|w| !w.starts_with('-') && !w.starts_with('+')).cloned().inspect(|_| i += 1));
                    let shape = Some(next.unwrap_or_else(|| "rounded".into()));
                    match flag.as_str() { "--list-border" => o.list_border = shape, "--input-border" => o.input_border = shape, "--header-border" => o.header_border = shape, _ => o.footer_border = shape }
                }
                // The preview's border (--preview-border[=STYLE], its --preview-window border-STYLE):
                // kept in order with the --preview-window specs, the later one winning.
                "--preview-border" => {
                    let next = value.clone().or_else(|| opts.get(i + 1).filter(|w| !w.starts_with('-') && !w.starts_with('+')).cloned().inspect(|_| i += 1));
                    let shape = next.unwrap_or_else(|| "rounded".into());
                    parse_preview_window(&mut o.preview_window, &format!("border-{shape}"));
                    o.preview_window_specs.push(format!("border-{shape}"));
                }
                "--no-preview-border" => { o.preview_window.border = "none".into(); o.preview_window_specs.push("border-none".into()) }
                "--no-list-border" => o.list_border = None, "--no-input-border" => o.input_border = None,
                "--no-header-border" => o.header_border = None, "--no-footer-border" => o.footer_border = None,
                "--footer" => { if let Some(v) = take() { o.footer = v.split('\n').map(str::to_string).collect() } }
                "--no-footer" => o.footer.clear(),
                "--no-input" => o.no_input = true, "--input" => o.no_input = false,
                "--info-command" => { if let Some(v) = take() { o.info_command = Some(v).filter(|v| !v.is_empty()) } }
                "--no-info-command" => o.info_command = None,
                "--algo" => { if let Some(v) = take() { o.algo_v1 = v == "v1" } }
                "+x" | "--no-extended" => o.no_extended = true, "-x" | "--extended" => o.no_extended = false,
                "--history" => { if let Some(v) = take() { o.history = Some(v).filter(|v| !v.is_empty()) } }
                "--no-history" => o.history = None,
                "--history-size" => { if let Some(v) = take() { o.history_size = v.parse().unwrap_or(1000).max(1) } }
                "--jump-labels" => { if let Some(v) = take() { if !v.is_empty() { o.jump_labels = v } } }
                "--no-mouse" => o.no_mouse = true, "--mouse" => o.no_mouse = false,
                "--list-label-pos" => { if let Some(v) = take() { o.list_label_pos = parse_label_pos(&v) } }
                "--input-label-pos" => { if let Some(v) = take() { o.input_label_pos = parse_label_pos(&v) } }
                "--header-label-pos" => { if let Some(v) = take() { o.header_label_pos = parse_label_pos(&v) } }
                "--footer-label-pos" => { if let Some(v) = take() { o.footer_label_pos = parse_label_pos(&v) } }
                "--list-label" => { if let Some(v) = take() { o.list_label = v.split('\n').next().unwrap_or("").to_string() } }
                "--input-label" => { if let Some(v) = take() { o.input_label = v.split('\n').next().unwrap_or("").to_string() } }
                "--header-label" => { if let Some(v) = take() { o.header_label = v.split('\n').next().unwrap_or("").to_string() } }
                "--footer-label" => { if let Some(v) = take() { o.footer_label = v.split('\n').next().unwrap_or("").to_string() } }
                // applyPreset: default, minimal, full[:BORDER_STYLE].
                "--style" => {
                    if let Some(v) = take() {
                        let (name, shape) = v.split_once(':').map(|(n, s)| (n.to_lowercase(), Some(s.to_string()))).unwrap_or((v.to_lowercase(), None));
                        let reset_separator = |o: &mut FzfOpts, sep_set: &mut bool| { o.separator = true; o.separator_char = "─".into(); o.separator_set = false; *sep_set = false };
                        match name.as_str() {
                            "default" => {
                                (o.list_border, o.input_border, o.header_border, o.footer_border) = (None, None, None, None);
                                o.preview_window.border = "rounded".into(); o.info_mode = "default".into();
                                o.preview_window_specs.push("border-rounded".into());
                                reset_separator(&mut o, &mut sep_set);
                                o.scrollbar = Some("│".into()); o.preview_scrollbar = Some("│".into()); bar_set = false;
                                o.highlight_line = false;
                            }
                            "minimal" => {
                                (o.list_border, o.input_border, o.header_border, o.footer_border) = (None, None, None, Some("line".into()));
                                o.preview_window.border = "line".into(); o.info_mode = "default".into();
                                o.preview_window_specs.push("border-line".into());
                                o.separator = false; o.separator_char = String::new(); o.separator_set = true; sep_set = true;
                                o.scrollbar = None; o.preview_scrollbar = None; bar_set = true;
                                o.highlight_line = false;
                            }
                            "full" => {
                                let shape = shape.filter(|s| !s.is_empty()).unwrap_or_else(|| "rounded".into());
                                if shape != "line" { o.list_border = Some(shape.clone()) }
                                (o.input_border, o.header_border, o.footer_border) = (Some(shape.clone()), Some(shape.clone()), Some(shape.clone()));
                                o.preview_window.border = shape.clone();
                                o.preview_window_specs.push(format!("border-{shape}"));
                                if shape == "line" { o.border = Some("line".into()) }
                                o.info_mode = "inline-right".into();
                                reset_separator(&mut o, &mut sep_set);
                                o.scrollbar = Some("│".into()); o.preview_scrollbar = Some("│".into()); bar_set = false;
                                o.highlight_line = true;
                            }
                            _ => {}
                        }
                    }
                }
                // --height=[~][-]HEIGHT[%] (100% or 0: the whole screen), --min-height=N[+].
                "--height" => { if let Some(v) = take() { o.height = parse_height(&v) } }
                "--no-height" => o.height = None,
                "--min-height" => { if let Some(v) = take() { let auto = v.ends_with('+'); if let Ok(n) = v.trim_end_matches('+').parse::<i64>() { o.min_height = if auto { -n } else { n } } } }
                "--margin" => { if let Some(v) = take() { if let Some(m) = parse_margin(&v) { o.margin = m } } }
                "--no-margin" => o.margin = [Size::default(); 4],
                "--padding" => { if let Some(v) = take() { if let Some(m) = parse_margin(&v) { o.padding = m } } }
                "--no-padding" => o.padding = [Size::default(); 4],
                // Its first line, the ANSI colours in it aside.
                // (Its colours kept: drawn as fzf draws an ANSI label.)
                "--border-label" => { if let Some(v) = take() { o.border_label = v.split('\n').next().unwrap_or("").to_string() } }
                "--no-border-label" => o.border_label.clear(),
                "--border-label-pos" => { if let Some(v) = take() { o.border_label_pos = parse_label_pos(&v) } }
                "--no-sort" | "+s" => o.no_sort = true,
                "--tac" => o.tac = true,
                "--ghost" => o.ghost = take().map(|g| g.split('\n').next().unwrap_or("").to_string()),
                "--track" => o.track = true,
                "--no-track" => o.track = false,
                // --tiebreak=length,begin,…: after the score, in that order (index: the input's).
                "--tiebreak" => {
                    if let Some(v) = take() {
                        use crate::fzf::Tiebreak::*;
                        o.tiebreak = v.split(',').filter_map(|c| match c.trim().to_lowercase().as_str() { "length" => Some(Length), "chunk" => Some(Chunk), "pathname" => Some(Pathname), "begin" => Some(Begin), "end" => Some(End), _ => None }).collect();
                    }
                }
                "--separator" => { if let Some(v) = take() { o.separator_char = v; o.separator = !o.separator_char.is_empty(); sep_set = true; o.separator_set = true } }
                "--unicode" => o.unicode = true, "--no-unicode" => o.unicode = false,
                "--keep-right" => o.keep_right = true, "--no-keep-right" => o.keep_right = false,
                // --gap[=N] (1 alone), --gap-line[=STR] (┈ alone, - under --no-unicode).
                "--gap" => {
                    let next = value.clone().or_else(|| opts.get(i + 1).filter(|w| w.parse::<usize>().is_ok()).cloned().inspect(|_| i += 1));
                    o.gap = next.and_then(|v| v.parse().ok()).unwrap_or(1)
                }
                "--no-gap" => o.gap = 0,
                "--gap-line" => { o.gap_line = value.clone().or_else(|| opts.get(i + 1).filter(|w| !w.starts_with('-') && !w.starts_with('+')).cloned().inspect(|_| i += 1)) }
                "--no-gap-line" => o.gap_line = Some(String::new()),
                // Each --preview-window over the one before, as fzf reads them.
                // --literal: no accent folding; --scheme: fzf's scoring for paths or history, with its tiebreak.
                "--literal" => o.literal = true, "--no-literal" => o.literal = false,
                "--scheme" => {
                    if let Some(v) = take() {
                        let v = v.to_lowercase();
                        crate::fzf::set_scheme(&v);
                        // (Its tiebreak, until a --tiebreak after it says otherwise.)
                        use crate::fzf::Tiebreak::*;
                        o.tiebreak = match v.as_str() { "path" => vec![Pathname, Length], "history" => vec![], _ => vec![Length] };
                    }
                }
                "--preview-window" => { if let Some(v) = take() { parse_preview_window(&mut o.preview_window, &v); o.preview_window_set = true; o.preview_window_specs.push(v) } }
                "--preview-label" => { if let Some(v) = take() { o.preview_label = Some(strip_ansi(v.split('\n').next().unwrap_or(""))) } }
                "--no-preview-label" => o.preview_label = Some(String::new()),
                "--preview-label-pos" => { if let Some(v) = take() { o.preview_label_pos = parse_label_pos(&v) } }
                // --gutter=CHAR: the gutter's character (a blank in reverse under --no-unicode).
                "--gutter" => { if let Some(v) = take() { o.gutter = Some(v) } }
                // --scrollbar=CHAR1[CHAR2]: the list's, and the preview's (CHAR1 when there is no CHAR2).
                "--scrollbar" => { if let Some(v) = take() { o.scrollbar = v.chars().next().map(|c| c.to_string()); o.preview_scrollbar = v.chars().nth(1).map(|c| c.to_string()).or(o.scrollbar.clone()); bar_set = true } }
                "--no-scrollbar" => { o.scrollbar = None; o.preview_scrollbar = None }
                "-e" | "--exact" => o.exact = true, "--no-exact" => o.exact = false,
                "-i" | "--ignore-case" => o.case = Some(false), "+i" | "--no-ignore-case" => o.case = Some(true), "--smart-case" => o.case = None,
                "--no-separator" => o.separator = false,
                "--ellipsis" => { if let Some(v) = take() { o.ellipsis = v; ell_set = true } }
                "--wrap" => o.wrap = true, "--no-wrap" => o.wrap = false,
                "--wrap-sign" => { if let Some(v) = take() { o.wrap_sign = v; sign_set = true } }
                "--color" => {
                    if let Some(v) = take() {
                        for (slot, c) in v.split(',').filter_map(|p| p.split_once(':')) {
                            match slot { "fg" | "list-fg" => o.fg = fzf_spec(c).0, "bg" => o.bg = fzf_spec(c).0, "list-bg" => o.list_bg = fzf_spec(c).0, "selected-bg" => o.selected_bg = fzf_spec(c).0, _ => {} }
                        }
                    }
                }
                "--bind" => {
                    if let Some(v) = take() {
                        // Commas inside an action's (…) belong to it.
                        // (Only an action's brackets count: `ctrl-]` is a key's name.)
                        let (mut depth, mut start, mut action) = (0, 0, false);
                        let mut parts = Vec::new();
                        for (i, c) in v.char_indices() { match c {
                            ':' => action = true,
                            '(' | '[' | '{' if action => depth += 1,
                            ')' | ']' | '}' if action => depth -= 1,
                            ',' if depth == 0 && action => { parts.push(&v[start..i]); start = i + 1; action = false }
                            _ => {}
                        } }
                        parts.push(&v[start..]);
                        // fzf's other names for a key, as the one it reports.
                        let alias = |k: &str| -> String {
                            // (alt-J and alt-j stay two keys: only the names change.)
                            let k = k.replace("return", "enter");
                            match k.as_str() {
                                "page-up" => "pgup".into(), "page-down" => "pgdn".into(), "backspace" | "bs" => "bspace".into(),
                                "alt-bspace" | "alt-backspace" => "alt-bs".into(), "delete" => "del".into(), "shift-tab" => "btab".into(),
                                // The control characters fzf names by the key they are.
                                "ctrl-m" => "enter".into(), "ctrl-i" => "tab".into(), "ctrl-_" => "ctrl-/".into(),
                                _ => k,
                            }
                        };
                        for pair in parts { if let Some((k, a)) = pair.split_once(':') { o.binds.push((alias(k), a.to_string())) } }
                    }
                }
                _ => {}
            }
            i += 1;
        }
        // --no-unicode: fzf's ASCII separator, scrollbar, ellipsis and wrap sign, where none was given.
        if !o.unicode {
            if !sep_set && o.separator { o.separator_char = "-".into() }
            if !bar_set && o.scrollbar.is_some() { o.scrollbar = Some("|".into()); o.preview_scrollbar = Some("|".into()) }
            if !ell_set { o.ellipsis = "..".into() }
            if !sign_set { o.wrap_sign = "> ".into() }
        }
        if no_color() { o.fg = None; o.bg = None }
        // No list or preview in hn draws a scrollbar, whatever FZF_DEFAULT_OPTS says: they follow
        // the cursor, and the wheel and the keys scroll them.
        (o.scrollbar, o.preview_scrollbar) = (None, None);
        o
    })
}

/// fzf's colour values: 0-255, #rrggbb, a name, -1 (the default).
fn fzf_colour(v: &str) -> Option<Color> {
    let v = v.split(':').next().unwrap_or(v);
    if v == "-1" { return Some(Color::Reset) }
    let named = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
    if let Some(n) = named.iter().position(|c| *c == v) { return Some(Color::Indexed(n as u8)) }
    if let Some(n) = v.strip_prefix("bright-").and_then(|b| named.iter().position(|c| *c == b)) { return Some(Color::Indexed(n as u8 + 8)) }
    if v == "gray" || v == "grey" { return Some(Color::Indexed(8)) }
    if let Ok(n) = v.parse::<u8>() { return Some(Color::Indexed(n)) }
    if let Some(hex) = v.strip_prefix('#') { let n = u32::from_str_radix(hex, 16).ok()?; return Some(Color::Rgb((n >> 16) as u8, (n >> 8) as u8, n as u8)) }
    crate::tmuxconf::colour(v)
}

/// Options split into words as fzf splits them (junegunn/go-shellwords with comments on): blanks
/// between words, '…' and "…" quoting, a backslash taking the next character (`\t` and `\n` a tab
/// and a newline), `#` at a word's start a comment to the end of its line; an unquoted ; & | < >
/// ends the options there. None where fzf stops with "invalid command line string".
fn shell_words(line: &str) -> Option<Vec<String>> {
    #[derive(PartialEq)]
    enum Got { No, Single, Quoted }
    let (mut args, mut buf, mut got) = (Vec::new(), String::new(), Got::No);
    let (mut escaped, mut dq, mut sq, mut bq, mut dollar, mut comment) = (false, false, false, false, false, false);
    for r in line.chars() {
        if comment { if r == '\n' { comment = false } continue }
        if escaped {
            buf.push(match r { 't' => '\t', 'n' => '\n', r => r });
            escaped = false;
            got = Got::Single;
            continue;
        }
        if r == '\\' { if sq { buf.push(r) } else { escaped = true } continue }
        if matches!(r, ' ' | '\t' | '\r' | '\n') {
            if sq || dq || bq || dollar { buf.push(r) } else if got != Got::No { args.push(std::mem::take(&mut buf)); got = Got::No }
            continue;
        }
        match r {
            '`' if !sq && !dq && !dollar => bq = !bq,
            ')' if !sq && !dq && !bq => dollar = !dollar,
            '(' if !sq && !dq && !bq => { if !dollar && buf.ends_with('$') { dollar = true; buf.push(r); continue } return None }
            '"' if !sq && !dollar => { if dq { got = Got::Quoted } dq = !dq; continue }
            '\'' if !dq && !dollar => { if sq { got = Got::Quoted } sq = !sq; continue }
            ';' | '&' | '|' | '<' | '>' if !(sq || dq || bq || dollar) => {
                // (`2>`: the descriptor is no word.)
                if r == '>' && buf.starts_with(|c: char| c.is_ascii_digit()) { got = Got::No }
                break;
            }
            '#' if buf.is_empty() && !sq && !dq => { comment = true; continue }
            _ => {}
        }
        got = Got::Single;
        buf.push(r);
    }
    if got != Got::No { args.push(buf) }
    if escaped || sq || dq || bq || dollar { return None }
    Some(args)
}

// tmux's default colours (the status line's, messages' and borders' are its options' defaults).
pub const TMUX_DISPLAY_PANES: Color = Color::Blue;
pub const TMUX_DISPLAY_PANES_ACTIVE: Color = Color::Red;

pub fn fg(color: Color) -> Style {
    match color {
        MUTED | SOFT if no_color() => Style::default().add_modifier(Modifier::DIM),
        // MUTED/SOFT are emphasis (the theme's dim), so they dim the theme's own readable text —
        // not the terminal's raw default foreground, which can disagree with the theme (the mixed
        // colour source that made hn's chrome read teal on some terminals).
        MUTED | SOFT => {
            let (_, fg, _) = palette();
            Style::default().fg(depth_fit(fg)).add_modifier(Modifier::DIM)
        }
        _ if no_color() => Style::default(),
        c => Style::default().fg(depth_fit(c)),
    }
}

/// NO_COLOR (no-color.org): hn's own chrome keeps its bold and dim, drops its colours. (The panes
/// are other programs' screens and keep theirs.)
pub fn no_color() -> bool { std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()) }

/// How many colours the terminal has: 16777216 with COLORTERM=truecolor|24bit, 256 with a
/// *256color TERM, else 16.
pub fn depth() -> u32 {
    static DEPTH: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *DEPTH.get_or_init(|| {
        let ct = std::env::var("COLORTERM").unwrap_or_default();
        let term = std::env::var("TERM").unwrap_or_default();
        if ct == "truecolor" || ct == "24bit" { 1 << 24 } else if term.contains("256") || term.contains("kitty") || term.contains("ghostty") || term.contains("wezterm") || term.contains("alacritty") || term.contains("tmux") { 256 } else if term.is_empty() { 256 } else { 16 }
    })
}

/// A brand colour (the engine marks) brought down to what the terminal has.
pub fn depth_fit(c: Color) -> Color {
    match c {
        Color::Rgb(r, g, b) if depth() < (1 << 24) => {
            if depth() >= 256 {
                let q = |v: u8| ((v as u16 * 5 + 127) / 255) as u8;
                Color::Indexed(16 + 36 * q(r) + 6 * q(g) + q(b))
            } else {
                // The nearest of the 8 base colours.
                let bit = |v: u8| v > 110;
                match (bit(r), bit(g), bit(b)) {
                    (false, false, false) => Color::DarkGray, (true, false, false) => Color::Red, (false, true, false) => Color::Green, (true, true, false) => Color::Yellow,
                    (false, false, true) => Color::Blue, (true, false, true) => Color::Magenta, (false, true, true) => Color::Cyan, (true, true, true) => Color::Reset,
                }
            }
        }
        Color::Indexed(n) if n > 15 && depth() < 256 => Color::Reset,
        c => c,
    }
}
pub fn bold(color: Color) -> Style { fg(color).add_modifier(Modifier::BOLD) }

pub fn engine_mark(engine: &str) -> (&'static str, Color) {
    let (mark, color) = engine_mark_raw(engine);
    (mark, paint(color))
}

/// A colour as this terminal can show it: none under NO_COLOR, the nearest it has otherwise.
pub fn paint(c: Color) -> Color { if no_color() { Color::Reset } else { depth_fit(c) } }

fn engine_mark_raw(engine: &str) -> (&'static str, Color) {
    match engine {
        "claude" => ("✳", Color::Rgb(0xD9, 0x77, 0x57)),
        "codex" => ("◎", Color::Rgb(0x10, 0xA3, 0x7F)),
        "cursor" => ("▲", TEXT),
        "opencode" => ("▣", Color::Rgb(0xF5, 0xA7, 0x42)),
        "pi" => ("π", ACCENT_SOFT),
        "hermes" => ("☿", Color::Rgb(0xC7, 0x92, 0xEA)),
        "amp" => ("ϟ", DANGER),
        "kilo" => ("K", Color::Rgb(0xF7, 0xDF, 0x1E)),
        "grok" => ("X", TEXT),
        "devin" => ("◆", TEAL),
        "copilot" => ("◉", Color::Rgb(0x8B, 0x94, 0x9E)),
        "commandcode" => ("⌘", Color::Blue),
        "muse" => ("♪", ATTENTION),
        "agy" => ("◈", Color::Rgb(0x42, 0x85, 0xF4)),
        "terminal" => ("❯", SOFT),
        _ => ("▸", SOFT),
    }
}

/// A machine at a glance, in the harnesses' marks (no round ones): `✓` this computer or
/// connected, a spinner connecting, `?` waiting to be linked, `✗` an error, `·` online but not
/// connected (soft) or offline (muted).
pub fn machine_mark(reach: &crate::fleet::Reach, online: bool, tick: u64) -> (&'static str, Color) {
    use crate::fleet::Reach;
    match reach {
        Reach::Ready => ("✓", paint(ONLINE)),
        Reach::Connecting => (spinner(tick), paint(WARN)),
        Reach::NeedsLink => ("?", paint(ATTENTION)),
        Reach::Error(_) => ("✗", paint(DANGER)),
        _ if online => ("·", paint(SOFT)),
        _ => ("·", MUTED),
    }
}

pub fn engine_label(engine: &str) -> &str {
    match engine {
        "claude" => "Claude Code", "codex" => "Codex", "cursor" => "Cursor", "opencode" => "OpenCode", "pi" => "Pi",
        "hermes" => "Hermes", "amp" => "Amp", "kilo" => "Kilo", "grok" => "Grok", "devin" => "Devin", "copilot" => "Copilot",
        "commandcode" => "Command Code", "muse" => "Muse", "agy" => "Antigravity", "terminal" => "Terminal",
        other => other,
    }
}

/// A harness's state at a glance, the same everywhere hn shows one (pane titles, the window list,
/// the lists, the side bar), in Orca's set: a spinner working (and starting, in its own colour),
/// `?` needs you, `✓` done and not looked at yet, `·` idle, `✗` failed; hn adds `‖` paused and a
/// muted `·` offline — no round marks. [tick] turns the spinner.
pub fn state_mark(state: State, tick: u64) -> (&'static str, &'static str, Color) {
    let (dot, word, color) = state_mark_raw(state, tick);
    (dot, word, if color == MUTED { color } else { paint(color) })
}

fn state_mark_raw(state: State, tick: u64) -> (&'static str, &'static str, Color) {
    match state {
        State::NeedsInput => ("?", "needs you", ATTENTION),
        State::Working => (spinner(tick), "working", ACCENT_SOFT),
        State::Done => ("✓", "done", ONLINE),
        State::Unknown => ("◌", "status unavailable", MUTED),
        State::Ready => ("·", "idle", MUTED),
        State::Starting => (spinner(tick), "starting", WARN),
        State::Failed => ("✗", "failed", DANGER),
        State::Paused => ("‖", "paused", MUTED),
        State::Offline => ("·", "offline", MUTED),
    }
}

/// The most urgent of several states (a window's panes): needs you, failed, done, working,
/// starting, idle, paused, offline.
pub fn most_urgent(states: impl Iterator<Item = State>) -> Option<State> {
    let rank = |s: &State| match s { State::NeedsInput => 0, State::Failed => 1, State::Done => 2, State::Working => 3, State::Starting => 4, State::Unknown => 5, State::Ready => 6, State::Paused => 7, State::Offline => 8 };
    states.min_by_key(rank)
}

thread_local! {
    static ANIMATIONS: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
    static ANIMATION_USED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
pub fn begin_animation_frame(on: bool) {
    ANIMATIONS.with(|a| a.set(on));
    ANIMATION_USED.with(|a| a.set(false));
}
pub fn animations() -> bool { ANIMATIONS.with(|a| a.get()) }
pub fn needs_animation_frame() -> bool { ANIMATION_USED.with(|a| a.get()) }

/// Reading an animated frame records demand for the next one. Static screens
/// and reduced-motion indicators do not keep an animation timer running.
pub fn animation_frame() -> usize {
    if !animations() { return 0 }
    ANIMATION_USED.with(|a| a.set(true));
    (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() / 100).unwrap_or(0)) as usize
}

/// A spinner frame for things in motion (working dots, connecting cards).
pub fn spinner(_tick: u64) -> &'static str {
    // fzf's frames, in its order.
    const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    FRAMES[animation_frame() % FRAMES.len()]
}

#[cfg(test)]
mod animation_tests {
    #[test]
    fn only_moving_content_requests_animation_and_each_frame_starts_fresh() {
        use super::*;
        begin_animation_frame(true);
        state_mark(State::Ready, 0);
        state_mark(State::NeedsInput, 0);
        assert!(!needs_animation_frame());
        state_mark(State::Working, 0);
        assert!(needs_animation_frame());
        begin_animation_frame(true);
        assert!(!needs_animation_frame());
        animation_frame(); // the picker's ASCII and Unicode loading frames
        assert!(needs_animation_frame());
        begin_animation_frame(false);
        assert_eq!(spinner(0), "⠋");
        assert_eq!(animation_frame(), 0);
        assert!(!needs_animation_frame());
    }
}

#[cfg(test)]
mod opts_tests {
    use super::shell_words;

    /// FZF_DEFAULT_OPTS and its file as fzf 0.67 splits them (go-shellwords, comments on).
    #[test]
    fn options_split_as_fzf_splits_them() {
        let w = |s: &str| shell_words(s).unwrap();
        // `#` at a word's start is a comment to the end of its line; in a word or quotes, itself.
        assert_eq!(w("# --reverse\n--prompt='#> '   # a comment\n--marker=# --pointer=@#"), ["--prompt=#> ", "--marker=#", "--pointer=@#"]);
        assert_eq!(w("--prompt=\\#\\  # escaped"), ["--prompt=# "]);
        // \t and \n are a tab and a newline; in single quotes a backslash is itself; '' is a word.
        assert_eq!(w(r#"--prompt=a\tb --header="x y" --x='a\tb' ''"#), ["--prompt=a\tb", "--header=x y", "--x=a\\tb", ""]);
        // An unquoted ; & | < > ends the options.
        assert_eq!(w("--cycle ; --reverse"), ["--cycle"]);
        assert_eq!(w("--prompt=> x"), ["--prompt="]);
        // What fzf refuses: a quote left open, a ( that is not $(.
        assert_eq!(shell_words("--prompt='open"), None);
        assert_eq!(shell_words("--bind=a:execute(ls)"), None);
    }

    /// --height, --margin/--padding and --border-label-pos as fzf 0.67 parses them.
    #[test]
    fn layout_options_parse_as_fzf_parses_them() {
        use super::{parse_height, parse_label_pos, parse_margin, Height, Size};
        let s = |size: f64, percent: bool| Size { size, percent };
        assert_eq!(parse_height("40%"), Some(Height { size: s(40.0, true), inverse: false, auto: false }));
        assert_eq!(parse_height("~20"), Some(Height { size: s(20.0, false), inverse: false, auto: true }));
        assert_eq!(parse_height("-5"), Some(Height { size: s(5.0, false), inverse: true, auto: false }));
        // The whole screen: no height of its own.
        assert_eq!(parse_height("100%"), None);
        assert_eq!(parse_height("0"), None);
        assert_eq!(parse_margin("1,3"), Some([s(1.0, false), s(3.0, false), s(1.0, false), s(3.0, false)]));
        assert_eq!(parse_margin("1,10%,2"), Some([s(1.0, false), s(10.0, true), s(2.0, false), s(10.0, true)]));
        assert_eq!(parse_margin("1,x"), None);
        assert_eq!(parse_label_pos("3:bottom"), (3, true));
        assert_eq!(parse_label_pos("-2"), (-2, false));
        assert_eq!(parse_label_pos("bottom"), (0, true));
    }
}

#[cfg(test)]
mod palette_tests {
    #[test]
    fn pane_surfaces_remain_distinct_on_dark_and_light_terminals() {
        for (bg, fg) in [(Color::Rgb(0, 0, 0), Color::Rgb(245, 245, 245)),
                         (Color::Rgb(247, 247, 247), Color::Rgb(26, 26, 26))] {
            let p = super::pane_palette_for(Some((bg, fg)));
            assert_ne!(p.surface, p.inactive_surface);
            assert_ne!(p.surface, bg);
            assert_ne!(p.border, p.active_border);
            assert_eq!(p.foreground, fg);
            let luminance = |c: Color| { let Color::Rgb(r, g, b) = c else { panic!("RGB palette") };
                299 * r as i32 + 587 * g as i32 + 114 * b as i32 };
            assert!((luminance(p.surface) - luminance(p.foreground)).abs() > 180_000);
            assert!((luminance(p.inactive_surface) - luminance(p.inactive_foreground)).abs() > 150_000);
            assert!((luminance(p.status) - luminance(p.status_foreground)).abs() > 120_000);
        }
        let fallback = super::pane_palette_for(None);
        assert_eq!(fallback.surface, Color::Rgb(47, 50, 55));
        assert_eq!(fallback.inactive_surface, Color::Rgb(64, 64, 64));
    }

    use super::palette;
    use ratatui::style::Color;

    /// The schema: a dark terminal answers a dark background and a light text; the palette must
    /// keep them, mark the terminal dark, and the readable text must come back as the light one.
    /// A light terminal inverts both. This is the invariant every piece of chrome uses, so none
    /// of it disagrees with the theme.
    #[test]
    fn palette_follows_the_terminal_answer() {
        crate::term_out::set_terminal_colours(Some("#201f26".into()), Some("#f5f5f5".into()));
        let (bg, fg, light) = palette();
        assert_eq!(bg, Color::Rgb(0x20, 0x1f, 0x26), "dark bg must map to the terminal's rgb");
        assert_eq!(fg, Color::Rgb(0xf5, 0xf5, 0xf5), "the readable text on dark is light");
        assert!(!light, "a dark background must not read as light");

        // MUTED/SOFT are emphasis, so they must dim the theme's readable text (the palette fg), never
        // dip into the terminal's raw default foreground — the mixed colour source that made hn's
        // chrome read as teal on some terminals while the status bar was light.
        for c in [super::MUTED, super::SOFT] {
            let s = super::fg(c);
            let expected = (!super::no_color()).then(|| super::depth_fit(fg));
            assert_eq!(s.fg, expected, "{c:?} follows the theme and NO_COLOR");
            assert!(s.add_modifier.contains(ratatui::style::Modifier::DIM), "{c:?} stays emphasis (dim)");
        }

        // A light terminal, in the same thread.
        crate::term_out::set_terminal_colours(Some("#f7f7f7".into()), Some("#1a1a1a".into()));
        let (bg, fg, light) = palette();
        assert_eq!(bg, Color::Rgb(0xf7, 0xf7, 0xf7));
        assert_eq!(fg, Color::Rgb(0x1a, 0x1a, 0x1a));
        assert!(light, "a light background reads as light");
    }
}

#[cfg(test)]
mod accent_theme_tests {
    use super::*  ;
    use crate::term_out;

    #[test]
    fn accent_honours_the_look_override_and_falls_back() {
        let _colours = term_out::colours_lock();
        term_out::set_accent_override(Some("#123456".into()));
        assert_eq!(accent(), Color::Rgb(0x12, 0x34, 0x56));
        term_out::set_accent_override(Some("#0f0".into()));
        assert_eq!(accent(), Color::Rgb(0, 0xff, 0));
        // A blank override falls back to the derived chrome teal, not the last override.
        term_out::set_accent_override(None);
        let c = accent();
        assert_ne!(c, Color::Rgb(0x12, 0x34, 0x56));
        assert_ne!(c, Color::Rgb(0, 0xff, 0));
    }

    #[test]
    fn theme_accent_hex_is_stable_and_theme_specific() {
        assert_eq!(theme_accent_hex("definitely-not-a-theme"), None);
        let a = theme_accent_hex("Atom One Dark").expect("known theme has an accent");
        assert!(a.len() == 7 && a.starts_with('#'));
        let b = theme_accent_hex("Gruvbox Dark").expect("known theme has an accent");
        assert_ne!(a, b);
        // A colour, never the theme's white or its text: Dracula's focused border is not #f8f8f2.
        for name in ["Dracula", "Atom One Dark", "Gruvbox Dark", "Adwaita", "Nord"] {
            let Some(t) = crate::terminal_themes::TERMINAL_THEMES.iter().find(|t| t.name == name) else { continue };
            let c = theme_accent_rgb(t);
            assert_ne!(c, t.foreground, "{name}");
            assert_ne!(c, t.palette[7], "{name}");
            let (mx, mn) = (c.iter().max().copied().unwrap_or(0) as f64, c.iter().min().copied().unwrap_or(0) as f64);
            assert!(mx > 0.0 && (mx - mn) / mx > 0.25, "{name}: {c:?} is a colour");
        }
    }
}
