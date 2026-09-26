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
        pub input: CA, pub ghost: CA, pub fg: CA, pub bg: CA, pub list_fg: CA, pub list_bg: CA, pub alt_bg: CA,
        pub selected_fg: CA, pub selected_bg: CA, pub selected_match: CA, pub dark_bg: CA, pub gutter: CA, pub prompt: CA,
        pub input_bg: CA, pub matched: CA, pub current: CA, pub current_match: CA, pub spinner: CA, pub info: CA,
        pub cursor: CA, pub marker: CA, pub header: CA, pub header_bg: CA, pub separator: CA, pub scrollbar: CA,
        pub border: CA, pub border_label: CA, pub list_border: CA,
    }

    pub const NO_COLOR: Theme = Theme {
        colored: false, input: D, ghost: U, fg: D, bg: D, list_fg: D, list_bg: D, alt_bg: U, selected_fg: D, selected_bg: D,
        selected_match: D, dark_bg: D, gutter: U, prompt: D, input_bg: D, matched: D, current: U, current_match: U, spinner: D,
        info: D, cursor: D, marker: D, header: D, header_bg: D, separator: D, scrollbar: D, border: U, border_label: D, list_border: D,
    };
    pub const EMPTY: Theme = Theme {
        colored: true, input: U, ghost: U, fg: U, bg: U, list_fg: U, list_bg: U, alt_bg: U, selected_fg: U, selected_bg: U,
        selected_match: U, dark_bg: U, gutter: U, prompt: U, input_bg: U, matched: U, current: U, current_match: U, spinner: U,
        info: U, cursor: U, marker: U, header: U, header_bg: U, separator: U, scrollbar: U, border: U, border_label: U, list_border: U,
    };
    pub const DEFAULT16: Theme = Theme {
        colored: true, input: D, ghost: U, fg: D, bg: D, list_fg: U, list_bg: U, alt_bg: U, selected_fg: U, selected_bg: U,
        selected_match: U, dark_bg: c(8), gutter: U, prompt: c(4), input_bg: U, matched: c(2), current: c(15), current_match: c(10),
        spinner: c(2), info: c(3), cursor: c(1), marker: c(5), header: c(6), header_bg: U, separator: U, scrollbar: U, border: U,
        border_label: D, list_border: U,
    };
    pub const DARK256: Theme = Theme {
        colored: true, input: D, ghost: U, fg: D, bg: D, list_fg: U, list_bg: U, alt_bg: U, selected_fg: U, selected_bg: U,
        selected_match: U, dark_bg: c(236), gutter: U, prompt: c(110), input_bg: U, matched: c(108), current: c(254), current_match: c(151),
        spinner: c(148), info: c(144), cursor: c(161), marker: c(168), header: c(109), header_bg: U, separator: U, scrollbar: U,
        border: c(59), border_label: c(145), list_border: U,
    };
    pub const LIGHT256: Theme = Theme {
        colored: true, input: D, ghost: U, fg: D, bg: D, list_fg: U, list_bg: U, alt_bg: U, selected_fg: U, selected_bg: U,
        selected_match: U, dark_bg: c(251), gutter: U, prompt: c(25), input_bg: U, matched: c(66), current: c(237), current_match: c(23),
        spinner: c(65), info: c(101), cursor: c(161), marker: c(168), header: c(31), header_bg: U, separator: U, scrollbar: U,
        border: c(145), border_label: c(59), list_border: U,
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
                "list-border" => &mut theme.list_border, "prompt" => &mut theme.prompt, "input-bg" => &mut theme.input_bg,
                "spinner" => &mut theme.spinner, "info" => &mut theme.info, "pointer" => &mut theme.cursor, "marker" => &mut theme.marker,
                "header" | "header-fg" => &mut theme.header, "header-bg" => &mut theme.header_bg,
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
        pub cursor: P, pub cursor_empty_char: P, pub marker: P, pub current: P, pub current_match: P, pub current_cursor: P,
        pub current_cursor_empty: P, pub current_marker: P, pub current_selected_empty: P, pub spinner: P, pub info: P,
        pub separator: P, pub scrollbar: P, pub border: P, pub header: P, pub list_border: P,
        /// --color=alt-bg: every other row's background (undefined: no stripes).
        pub alt_bg: CA,
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
        let mut ghost = t.ghost;
        if ghost.undefined() { ghost.attr = DIM } else if ghost.color_defined() && !ghost.attr_defined() { ghost.attr = REGULAR }
        t.ghost = over(t.input, ghost);
        let mut gutter = t.gutter;
        if !base.colored && gutter.undefined() { gutter.attr = DIM }
        t.gutter = over(t.dark_bg, gutter);
        t.list_border = over(t.border, t.list_border);
        t.separator = over(t.list_border, t.separator);
        t.scrollbar = over(t.list_border, t.scrollbar);
        // No input window of its own: the input's background is the list's.
        t.input_bg = over(t.bg, t.list_bg);
        t.header_bg = over(t.bg, t.list_bg);
        let blank = CA { attr: REGULAR, ..t.list_fg };
        Palette {
            prompt: pair(t.prompt, t.input_bg), normal: pair(t.list_fg, t.list_bg), selected: pair(t.selected_fg, t.selected_bg),
            input: pair(t.input, t.input_bg), ghost: pair(t.ghost, t.input_bg), matched: pair(t.matched, t.list_bg),
            selected_match: pair(t.selected_match, t.selected_bg), cursor: pair(t.cursor, t.gutter),
            cursor_empty_char: pair(t.gutter, t.list_bg),
            marker: if t.selected_bg.col != t.list_bg.col { pair(t.marker, t.selected_bg) } else { pair(t.marker, t.list_bg) },
            current: pair(t.current, t.dark_bg), current_match: pair(t.current_match, t.dark_bg), current_cursor: pair(t.cursor, t.dark_bg),
            current_cursor_empty: pair(blank, t.dark_bg), current_marker: pair(t.marker, t.dark_bg), current_selected_empty: pair(blank, t.dark_bg),
            spinner: pair(t.spinner, t.input_bg), info: pair(t.info, t.input_bg), separator: pair(t.separator, t.input_bg),
            scrollbar: pair(t.scrollbar, t.list_bg), border: pair(t.border, t.bg), header: pair(t.header, t.header_bg),
            list_border: pair(t.list_border, t.list_bg), alt_bg: t.alt_bg, colored: base.colored,
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


// Hn's own chrome speaks the 16 ANSI colours, as tmux's does: the terminal's theme decides what
// they look like, so it reads on dark, light and Solarized alike. SOFT and MUTED are not colours
// but emphasis (the terminal's dim), `fg` turns them into that.
pub const ACCENT: Color = Color::Blue;
pub const ACCENT_SOFT: Color = Color::Cyan;
pub const ONLINE: Color = Color::Green;
pub const WARN: Color = Color::Yellow;
pub const ATTENTION: Color = Color::Yellow;
pub const DANGER: Color = Color::Red;
pub const TEAL: Color = Color::Cyan;
pub const MUTED: Color = Color::Indexed(8);
pub const SOFT: Color = Color::Indexed(7);
pub const TEXT: Color = Color::Reset;

/// fzf's colours — its dark256 default, or what `--color=light|16|bw` in `$FZF_DEFAULT_OPTS` asks
/// for (and bw under NO_COLOR), so a list here looks like fzf does on this terminal.
pub struct Fzf { pub reverse: bool, pub pointer_char: String, pub marker_char: String, pub prompt_text: String, pub bg_plus: Color, pub hl: Color, pub prompt: Color, pub bw: bool, pub pal: fzfcolor::Palette }

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

pub fn fzf() -> &'static Fzf {
    static FZF: std::sync::OnceLock<Fzf> = std::sync::OnceLock::new();
    FZF.get_or_init(|| {
        use fzfcolor::*;
        let opts = default_opts();
        // fzf's defaultOptions: NO_COLOR starts from bw; then each option in turn.
        let (mut theme, mut base) = if no_color() { (NO_COLOR, Some(NO_COLOR)) } else { (EMPTY, None) };
        let (mut bold, mut reverse, mut pointer, mut marker, mut prompt) = (true, false, None, None, None);
        let mut i = 0;
        while i < opts.len() {
            let w = &opts[i];
            let (flag, value) = match w.split_once('=') { Some((f, v)) => (f.to_string(), Some(v.to_string())), None => (w.clone(), None) };
            let mut take = || value.clone().or_else(|| { i += 1; opts.get(i).cloned() });
            match flag.as_str() {
                "--color" => { match take() { Some(v) if !v.is_empty() => { if let Some(b) = parse(&mut theme, &v) { base = Some(b) } } _ => theme = EMPTY } }
                "+c" | "--no-color" => { theme = NO_COLOR; base = Some(NO_COLOR) }
                "+2" | "--no-256" => theme = DEFAULT16,
                "--bold" => bold = true, "--no-bold" => bold = false,
                "--layout" => { if let Some(v) = take() { reverse = v == "reverse" || v == "reverse-list" } }
                "--reverse-list" => reverse = true,
                "--reverse" => reverse = true,
                "--pointer" => pointer = take(),
                "--marker" => marker = take(),
                "--prompt" => prompt = take(),
                _ => {}
            }
            i += 1;
        }
        // No base named: the renderer's own — 256 colours, or the 16 on a terminal without them.
        let base = base.unwrap_or(if depth() < 256 { DEFAULT16 } else { DARK256 });
        let pal = init(theme, base, bold);
        let fg = |p: P| p.style().fg.unwrap_or(Color::Reset);
        Fzf {
            reverse,
            pointer_char: pointer.unwrap_or_else(|| "▌".into()),
            marker_char: marker.unwrap_or_else(|| "┃".into()),
            // (Its first line only, as fzf's firstLine keeps it.)
            prompt_text: prompt.map(|p| p.split('\n').next().unwrap_or("").to_string()).unwrap_or_else(|| "> ".into()),
            bg_plus: pal.current.style().bg.unwrap_or(Color::Reset), hl: fg(pal.matched), prompt: fg(pal.prompt), bw: !pal.colored, pal,
        }
    })
}

/// The rest of FZF_DEFAULT_OPTS that shapes a list: --cycle, --exact, -i/+i, --no-separator,
/// --ellipsis, fg:/bg: colours, and --bind key:action pairs.
pub struct FzfOpts { pub info_mode: String, pub prompt_top: bool, pub header_first: bool, pub border: Option<String>, pub no_sort: bool, pub tac: bool, pub tiebreak: Vec<crate::fzf::Tiebreak>, pub selected_bg: Option<Color>, pub info_prefix: String, pub separator_char: String, pub scrollbar: Option<String>, pub cycle: bool, pub exact: bool, pub case: Option<bool>, pub separator: bool, pub ellipsis: String, pub fg: Option<Color>, pub bg: Option<Color>, pub list_bg: Option<Color>, pub binds: Vec<(String, String)>, pub hscroll: bool, pub hscroll_off: usize, pub highlight_line: bool, pub scroll_off: usize, pub tabstop: usize }

pub fn fzf_opts() -> &'static FzfOpts {
    static OPTS: std::sync::OnceLock<FzfOpts> = std::sync::OnceLock::new();
    OPTS.get_or_init(|| {
        let opts = default_opts();
        let mut o = FzfOpts { info_mode: "default".into(), prompt_top: false, header_first: false, border: None, no_sort: false, tac: false, tiebreak: vec![crate::fzf::Tiebreak::Length], selected_bg: None, info_prefix: String::new(), separator_char: "─".into(), scrollbar: Some("│".into()), cycle: false, exact: false, case: None, separator: true, ellipsis: "··".into(), fg: None, bg: None, list_bg: None, binds: Vec::new(), hscroll: true, hscroll_off: 10, highlight_line: false, scroll_off: 3, tabstop: 8 };
        let mut i = 0;
        while i < opts.len() {
            let w = &opts[i];
            let (flag, value) = match w.split_once('=') { Some((f, v)) => (f.to_string(), Some(v.to_string())), None => (w.clone(), None) };
            let mut take = || value.clone().or_else(|| { i += 1; opts.get(i).cloned() });
            match flag.as_str() {
                "--cycle" => o.cycle = true, "--no-cycle" => o.cycle = false,
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
                "--border" => o.border = Some(value.clone().unwrap_or_else(|| "rounded".into())),
                "--no-border" => o.border = None,
                "--no-sort" | "+s" => o.no_sort = true,
                "--tac" => o.tac = true,
                // --tiebreak=length,begin,…: after the score, in that order (index: the input's).
                "--tiebreak" => {
                    if let Some(v) = take() {
                        use crate::fzf::Tiebreak::*;
                        o.tiebreak = v.split(',').filter_map(|c| match c.trim().to_lowercase().as_str() { "length" => Some(Length), "chunk" => Some(Chunk), "pathname" => Some(Pathname), "begin" => Some(Begin), "end" => Some(End), _ => None }).collect();
                    }
                }
                "--separator" => { if let Some(v) = take() { o.separator_char = v; o.separator = !o.separator_char.is_empty() } }
                "--scrollbar" => { if let Some(v) = take() { o.scrollbar = v.chars().next().map(|c| c.to_string()) } }
                "--no-scrollbar" => o.scrollbar = None,
                "-e" | "--exact" => o.exact = true, "--no-exact" => o.exact = false,
                "-i" | "--ignore-case" => o.case = Some(false), "+i" | "--no-ignore-case" => o.case = Some(true), "--smart-case" => o.case = None,
                "--no-separator" => o.separator = false,
                "--ellipsis" => { if let Some(v) = take() { o.ellipsis = v } }
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
                        let (mut depth, mut start) = (0, 0);
                        let mut parts = Vec::new();
                        for (i, c) in v.char_indices() { match c { '(' | '[' | '{' => depth += 1, ')' | ']' | '}' => depth -= 1, ',' if depth == 0 => { parts.push(&v[start..i]); start = i + 1 } _ => {} } }
                        parts.push(&v[start..]);
                        // fzf's other names for a key, as the one it reports.
                        let alias = |k: &str| -> String {
                            // (alt-J and alt-j stay two keys: only the names change.)
                            let k = k.replace("return", "enter");
                            match k.as_str() {
                                "page-up" => "pgup".into(), "page-down" => "pgdn".into(), "backspace" | "bs" => "bspace".into(),
                                "alt-bspace" | "alt-backspace" => "alt-bs".into(), "delete" => "del".into(), "shift-tab" => "btab".into(),
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
        if no_color() { o.fg = None; o.bg = None }
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

// tmux's default colours.
pub const TMUX_STATUS_BG: Color = Color::Green;
pub const TMUX_STATUS_FG: Color = Color::Black;
pub const TMUX_MESSAGE_BG: Color = Color::Yellow;
pub const TMUX_MESSAGE_FG: Color = Color::Black;
pub const TMUX_ACTIVE_BORDER: Color = Color::Green;
pub const TMUX_DISPLAY_PANES: Color = Color::Blue;
pub const TMUX_DISPLAY_PANES_ACTIVE: Color = Color::Red;

pub fn fg(color: Color) -> Style {
    match color {
        MUTED | SOFT => Style::default().add_modifier(Modifier::DIM),
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
        "commandcode" => ("⌘", ACCENT),
        "muse" => ("♪", ATTENTION),
        "agy" => ("◈", Color::Rgb(0x42, 0x85, 0xF4)),
        "terminal" => ("❯", SOFT),
        _ => ("●", SOFT),
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
/// the lists), in Orca's set: a spinner working, `?` needs you, `✓` done and not looked at yet, `·`
/// idle, `✗` failed; hn adds `◌` starting, `‖` paused and `○` offline. [tick] turns the spinner.
pub fn state_mark(state: State, tick: u64) -> (&'static str, &'static str, Color) {
    let (dot, word, color) = state_mark_raw(state, tick);
    (dot, word, if color == MUTED { color } else { paint(color) })
}

fn state_mark_raw(state: State, tick: u64) -> (&'static str, &'static str, Color) {
    match state {
        State::NeedsInput => ("?", "needs you", ATTENTION),
        State::Working => (spinner(tick), "working", ACCENT_SOFT),
        State::Done => ("✓", "done", ONLINE),
        State::Ready => ("·", "idle", MUTED),
        State::Starting => ("◌", "starting", WARN),
        State::Failed => ("✗", "failed", DANGER),
        State::Paused => ("‖", "paused", MUTED),
        State::Offline => ("○", "offline", MUTED),
    }
}

/// The most urgent of several states (a window's panes): needs you, failed, done, working,
/// starting, idle, paused, offline.
pub fn most_urgent(states: impl Iterator<Item = State>) -> Option<State> {
    let rank = |s: &State| match s { State::NeedsInput => 0, State::Failed => 1, State::Done => 2, State::Working => 3, State::Starting => 4, State::Ready => 5, State::Paused => 6, State::Offline => 7 };
    states.min_by_key(rank)
}

/// A spinner frame for things in motion (working dots, connecting cards).
pub fn spinner(tick: u64) -> &'static str {
    // fzf's frames, in its order.
    const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    FRAMES[(tick as usize) % FRAMES.len()]
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
}
