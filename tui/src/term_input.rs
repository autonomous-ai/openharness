//! One reader for keyboard input and asynchronous capability replies. Input uses the
//! pinned Crossterm decoder, so negotiation cannot consume keys, paste or mouse events.
use crossterm::event::{Event, KeyboardEnhancementFlags};
use std::time::{Duration, Instant};

#[path = "term_input_parse.rs"]
mod parse;

#[allow(dead_code)]
#[derive(Debug, PartialEq)]
enum InternalEvent { Event(Event), CursorPosition(u16, u16), KeyboardEnhancementFlags(KeyboardEnhancementFlags), PrimaryDeviceAttributes }

#[derive(Debug, PartialEq)]
enum Item { Input(Event), Terminal(Option<String>), Foreground(Option<String>), Background(Option<String>), Palette(u8, Option<String>) }

const ESCAPE_DELAY: Duration = Duration::from_millis(50);

#[derive(Default)]
struct Decoder { pending: Vec<u8> }
impl Decoder {
    /// Only an ambiguous Escape/Alt-P prefix can produce input without another
    /// byte. Other partial sequences and an idle reader wait for the fd itself.
    fn poll_timeout(&self, since_read: Duration) -> libc::c_int {
        if self.pending.is_empty() || self.pending.len() >= 4 || !b"\x1bP>|".starts_with(&self.pending) { return -1 }
        ESCAPE_DELAY.saturating_sub(since_read).as_nanos().div_ceil(1_000_000) as libc::c_int
    }

    fn push(&mut self, bytes: &[u8], more: bool) -> Vec<Item> {
        let mut out = Vec::new();
        for b in bytes {
            self.pending.push(*b);
            let p = &self.pending;
            // XDA: DCS > | name ST. Hold only this prefix; ordinary Alt-P remains a key.
            if b"\x1bP>|".starts_with(p) { continue }
            if p.starts_with(b"\x1bP>|") && p.len() < 4096 {
                let end = if p.ends_with(b"\x1b\\") { Some(p.len() - 2) } else if p.ends_with(b"\x07") { Some(p.len() - 1) } else { None };
                if let Some(end) = end { out.push(Item::Terminal(Some(String::from_utf8_lossy(&p[4..end]).into_owned()))); self.pending.clear(); }
                continue;
            }
            // OSC 10 default-foreground answer from `ask_terminal`, `\x1b]10;rgb:…\x07` (or
            // `#rrggbb`). Same hold-till-terminator rule, so a colour reply is never a key and
            // interleaved typeahead stays typeahead. The colour body is the one OSC 11 uses.
            if b"\x1b]10;".starts_with(p) { continue }
            if p.starts_with(b"\x1b]10;") && p.len() < 4096 {
                let end = if p.ends_with(b"\x1b\\") { Some(p.len() - 2) } else if p.ends_with(b"\x07") { Some(p.len() - 1) } else { None };
                if let Some(end) = end { out.push(Item::Foreground(parse_osc11(&String::from_utf8_lossy(&p[5..end])))); self.pending.clear(); }
                continue;
            }
            // OSC 11 default-background answer from `ask_terminal`, `\x1b]11;rgb:…\x07`
            // (or `#rrggbb`). Same hold-till-terminator rule as XDA, so a query reply never
            // becomes a key, and interleaved typeahead stays typeahead.
            if b"\x1b]11;".starts_with(p) { continue }
            if p.starts_with(b"\x1b]11;") && p.len() < 4096 {
                let end = if p.ends_with(b"\x1b\\") { Some(p.len() - 2) } else if p.ends_with(b"\x07") { Some(p.len() - 1) } else { None };
                if let Some(end) = end { out.push(Item::Background(parse_osc11(&String::from_utf8_lossy(&p[5..end])))); self.pending.clear(); }
                continue;
            }
            // OSC 4 palette answer from `ask_terminal`, `\x1b]4;N;rgb:…\x07`: one of the terminal's
            // own sixteen colours, from which hn's accent is picked when no theme is chosen. The
            // same hold-till-terminator rule as OSC 10/11.
            if b"\x1b]4;".starts_with(p) { continue }
            if p.starts_with(b"\x1b]4;") && p.len() < 4096 {
                let end = if p.ends_with(b"\x1b\\") { Some(p.len() - 2) } else if p.ends_with(b"\x07") { Some(p.len() - 1) } else { None };
                if let Some(end) = end {
                    let body = String::from_utf8_lossy(&p[4..end]).into_owned();
                    if let Some((n, colour)) = body.split_once(';').and_then(|(n, c)| Some((n.parse::<u8>().ok()?, c))) { out.push(Item::Palette(n, parse_osc11(colour))) }
                    self.pending.clear();
                }
                continue;
            }
            // If the apparent XDA prefix turned out to be Alt-P, replay through the exact
            // byte decoder rather than letting its first event discard the following bytes.
            if p.starts_with(b"\x1bP") {
                let bytes = std::mem::take(&mut self.pending);
                for (i, b) in bytes.iter().enumerate() { self.pending.push(*b); self.parse(i + 1 < bytes.len(), &mut out); }
            } else { self.parse(true, &mut out); }
        }
        // Match Crossterm's read boundary: a short read ends a standalone Escape.
        // Waiting for an idle timer here folds a following prefix into an Alt key.
        if !more { out.extend(self.escape()); }
        out
    }
    fn parse(&mut self, more: bool, out: &mut Vec<Item>) {
        match parse::parse_event(&self.pending, more) {
            Ok(Some(InternalEvent::Event(event))) => { out.push(Item::Input(event)); self.pending.clear(); }
            Ok(Some(InternalEvent::PrimaryDeviceAttributes)) => { out.push(Item::Terminal(None)); self.pending.clear(); }
            Ok(Some(_)) | Err(_) => self.pending.clear(),
            Ok(None) => {},
        }
    }
    fn escape(&mut self) -> Vec<Item> {
        let mut out = Vec::new();
        if self.pending == b"\x1b" { self.parse(false, &mut out); }
        else if self.pending.len() < 4 && b"\x1bP>|".starts_with(&self.pending) {
            // A lone Alt-P is also a possible query prefix; give it the same escape delay.
            let bytes = std::mem::take(&mut self.pending);
            for (i, b) in bytes.iter().enumerate() { self.pending.push(*b); self.parse(i + 1 < bytes.len(), &mut out); }
        }
        out
    }
}

/// The `#rrggbb` from an OSC 11 answer body: `rgb:RRRR/GGGG/BBBB` (an Alacritty- or xterm-style
/// request joined into a short string as a 24-bit colour) or `#rrggbb`. None when it is a string
/// a 24-bit answer cannot be (a terminal answers `rgb:0000/0000/0000` only for unset).
fn parse_osc11(body: &str) -> Option<String> {
    let body = body.trim();
    if let Some(hex) = body.strip_prefix('#') {
        if hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            let mut h = String::with_capacity(7);
            h.push('#');
            for c in hex.bytes() { h.push((c as char).to_ascii_lowercase()); }
            return Some(h);
        }
        return None;
    }
    if let Some(rgb) = body.strip_prefix("rgb:") {
        let parts: Vec<&str> = rgb.split('/').collect();
        if parts.len() == 3 {
            let conv = |s: &str| -> Option<u8> {
                if !(1..=4).contains(&s.len()) || !s.bytes().all(|b| b.is_ascii_hexdigit()) { return None }
                let v = u32::from_str_radix(s, 16).ok()?;
                let max = (1u32 << (4 * s.len())) - 1;
                Some(((v * 255) / max) as u8)
            };
            let (r, g, b) = (conv(parts[0])?, conv(parts[1])?, conv(parts[2])?);
            return Some(format!("#{:02x}{:02x}{:02x}", r, g, b));
        }
        // `rgb:RRGGBB` (six digits, as some terminals answer) or `rgb:RRRR`-style in one token.
        if let Some(hex) = parts.first().filter(|s| s.len() == 6 && s.bytes().all(|b| b.is_ascii_hexdigit())) {
            return Some(format!("#{}", hex.to_lowercase()));
        }
    }
    None
}

enum Got { Closed, Nothing, Bytes(usize) }

/// The terminal's bytes, or nothing within a wait of so many milliseconds (negative: as long as it takes).
#[cfg(unix)]
struct Source { _tty: Option<std::fs::File>, fd: i32 }

#[cfg(unix)]
impl Source {
    fn open() -> Option<Source> {
        use std::os::fd::AsRawFd;
        let tty = if std::io::IsTerminal::is_terminal(&std::io::stdin()) { None } else { std::fs::OpenOptions::new().read(true).write(true).open("/dev/tty").ok() };
        let fd = tty.as_ref().map(AsRawFd::as_raw_fd).unwrap_or_else(|| std::io::stdin().as_raw_fd());
        Some(Source { _tty: tty, fd })
    }

    fn next(&mut self, buf: &mut [u8], timeout: i32) -> Got {
        loop {
            let mut pfd = libc::pollfd { fd: self.fd, events: libc::POLLIN, revents: 0 };
            let n = unsafe { libc::poll(&mut pfd, 1, timeout) };
            if n < 0 { if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted { continue } return Got::Closed }
            if n == 0 { return Got::Nothing }
            let n = unsafe { libc::read(self.fd, buf.as_mut_ptr().cast(), buf.len()) };
            return if n <= 0 { Got::Closed } else { Got::Bytes(n as usize) };
        }
    }
}

/// A Windows console's input as the same bytes: asked for as VT sequences (ENABLE_VIRTUAL_TERMINAL_INPUT), which it hands over
/// as UTF-16 through ReadConsoleW. ReadFile gives no non-ASCII at all on older consoles. Other records in its queue (a focus
/// change, a key's release, a resize, which main.rs looks for) would hold a read up with nothing to return, so they go first.
#[cfg(windows)]
struct Source { handle: windows_sys::Win32::Foundation::HANDLE, _console: Option<std::fs::File>, high: Option<u16> }

// SAFETY: a console handle, used by this reader thread alone.
#[cfg(windows)]
unsafe impl Send for Source {}

#[cfg(windows)]
impl Source {
    fn open() -> Option<Source> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Console::{ENABLE_EXTENDED_FLAGS, ENABLE_VIRTUAL_TERMINAL_INPUT, SetConsoleMode};
        let (handle, console) = if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            (std::io::stdin().as_raw_handle(), None)
        } else {
            let file = std::fs::OpenOptions::new().read(true).write(true).open("CONIN$").ok()?;
            (file.as_raw_handle(), Some(file))
        };
        // Line, echo and Ctrl-C processing off, as enable_raw_mode left them; quick edit off, so a click is the program's.
        // SAFETY: a console handle held for as long as this value.
        if unsafe { SetConsoleMode(handle as _, ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_EXTENDED_FLAGS) } == 0 { return None }
        Some(Source { handle: handle as _, _console: console, high: None })
    }

    fn next(&mut self, buf: &mut [u8], timeout: i32) -> Got {
        use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Console::{INPUT_RECORD, KEY_EVENT, PeekConsoleInputW, ReadConsoleInputW, ReadConsoleW};
        use windows_sys::Win32::System::Threading::{INFINITE, WaitForSingleObject};
        let wait = if timeout < 0 { INFINITE } else { timeout as u32 };
        let mut units = [0u16; 2048];
        // SAFETY: every buffer is as long as said, and the handle lives as long as self.
        unsafe {
            loop {
                match WaitForSingleObject(self.handle, wait) {
                    WAIT_OBJECT_0 => {}
                    WAIT_TIMEOUT => return Got::Nothing,
                    _ => return Got::Closed,
                }
                let mut record: INPUT_RECORD = std::mem::zeroed();
                let mut count = 0u32;
                if PeekConsoleInputW(self.handle, &mut record, 1, &mut count) == 0 { return Got::Closed }
                if count == 0 { continue }
                let key = u32::from(record.EventType) == KEY_EVENT && record.Event.KeyEvent.bKeyDown != 0;
                if !key {
                    if ReadConsoleInputW(self.handle, &mut record, 1, &mut count) == 0 { return Got::Closed }
                    continue
                }
                let mut read = 0u32;
                // A third of the bytes: each unit is at most three in UTF-8.
                let room = (units.len()).min(buf.len() / 3) as u32;
                if ReadConsoleW(self.handle, units.as_mut_ptr().cast(), room, &mut read, std::ptr::null()) == 0 { return Got::Closed }
                if read == 0 { continue }
                let written = utf16_to_utf8(&mut self.high, &units[..read as usize], buf);
                if written > 0 { return Got::Bytes(written) }
            }
        }
    }
}

/// UTF-16 units into UTF-8, keeping a high surrogate that ended the last read for the next.
#[cfg(any(windows, test))]
fn utf16_to_utf8(high: &mut Option<u16>, units: &[u16], out: &mut [u8]) -> usize {
    let mut all: Vec<u16> = Vec::with_capacity(units.len() + 1);
    all.extend(high.take());
    all.extend_from_slice(units);
    if all.last().is_some_and(|unit| (0xD800..0xDC00).contains(unit)) { *high = all.pop(); }
    let mut at = 0;
    for decoded in char::decode_utf16(all) {
        let c = decoded.unwrap_or(char::REPLACEMENT_CHARACTER);
        if at + c.len_utf8() > out.len() { break }
        at += c.encode_utf8(&mut out[at..]).len();
    }
    at
}

/// Blocking reader thread. The initial queries never delay drawing or shell startup;
/// terminal replies can arrive after ordinary input and do not become keystrokes.
pub fn read(keys: tokio::sync::mpsc::UnboundedSender<crate::event::Event>) {
    let Some(mut source) = Source::open() else { return };
    let mut decoder = Decoder::default();
    let mut last = Instant::now();
    let mut buf = [0u8; 8192];
    loop {
        let items = match source.next(&mut buf, decoder.poll_timeout(last.elapsed())) {
            Got::Closed => break,
            Got::Nothing => if last.elapsed() >= ESCAPE_DELAY { decoder.escape() } else { Vec::new() },
            Got::Bytes(n) => {
                last = Instant::now();
                decoder.push(&buf[..n], n == buf.len())
            }
        };
        for item in items {
            let event = match item {
                Item::Input(event) => crate::event::Event::Input(event),
                Item::Terminal(name) => {
                    if !crate::term_out::terminal_answer(name) { continue }
                    crate::event::Event::Apply(Box::new(|app| app.redraw_all = true))
                }
                Item::Foreground(fg) => {
                    crate::term_out::set_terminal_colours(None, fg);
                    crate::event::Event::Apply(Box::new(|app| { app.push_theme(); app.redraw_all = true; }))
                }
                Item::Background(bg) => {
                    crate::term_out::set_terminal_colours(bg, None);
                    crate::event::Event::Apply(Box::new(|app| { app.push_theme(); app.redraw_all = true; }))
                }
                Item::Palette(n, colour) => {
                    crate::term_out::set_palette_colour(n, colour);
                    crate::event::Event::Apply(Box::new(|app| app.redraw_all = true))
                }
            };
            if keys.send(event).is_err() { return }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    #[test]
    fn idle_and_finished_input_have_no_poll_deadline() {
        let mut decoder = Decoder::default();
        assert_eq!(decoder.poll_timeout(Duration::ZERO), -1);
        let input = decoder.push("hello 🐯".as_bytes(), false);
        assert_eq!(input.len(), 7);
        assert_eq!(decoder.poll_timeout(Duration::from_secs(1)), -1);
        assert_eq!(decoder.push(b"\x1b", false), vec![Item::Input(Event::Key(KeyCode::Esc.into()))]);
        assert_eq!(decoder.poll_timeout(Duration::ZERO), -1);
    }

    #[test]
    fn ambiguous_prefixes_keep_one_fifty_ms_deadline_after_full_reads() {
        for prefix in [b"\x1b".as_slice(), b"\x1bP", b"\x1bP>"] {
            let mut decoder = Decoder::default();
            assert!(decoder.push(prefix, true).is_empty());
            assert_eq!(decoder.poll_timeout(Duration::ZERO), 50);
            assert_eq!(decoder.poll_timeout(Duration::from_millis(37)), 13);
            assert_eq!(decoder.poll_timeout(Duration::from_micros(49_999)), 1);
            assert_eq!(decoder.poll_timeout(Duration::from_millis(50)), 0);
            assert_eq!(decoder.poll_timeout(Duration::from_secs(1)), 0);
            assert!(!decoder.escape().is_empty(), "{prefix:?}");
            assert_eq!(decoder.poll_timeout(Duration::ZERO), -1);
        }
    }

    #[test]
    fn partial_text_paste_and_terminal_replies_wait_for_more_bytes() {
        let cases: Vec<(&[u8], &[u8], Item)> = vec![
            (b"\xc3", b"\xa9", Item::Input(Event::Key(KeyCode::Char('é').into()))),
            (b"\x1b[", b"A", Item::Input(Event::Key(KeyCode::Up.into()))),
            (b"\x1b[200~first", b" second\x1b[201~", Item::Input(Event::Paste("first second".into()))),
            (b"\x1bP>|Terminal", b"\x1b\\", Item::Terminal(Some("Terminal".into()))),
            (b"\x1b]11;rgb:ffff/", b"0000/0000\x07", Item::Background(Some("#ff0000".into()))),
        ];
        for (prefix, suffix, expected) in cases {
            let mut decoder = Decoder::default();
            assert!(decoder.push(prefix, false).is_empty());
            assert_eq!(decoder.poll_timeout(Duration::from_secs(60)), -1, "{prefix:?}");
            assert_eq!(decoder.push(suffix, false), vec![expected]);
            assert_eq!(decoder.poll_timeout(Duration::ZERO), -1);
        }
    }

    #[test]
    fn query_replies_do_not_consume_interleaved_typeahead() {
        let mut decoder = Decoder::default();
        let mut items = Vec::new();
        for b in b"printf hello\r\x1bP>|tmux 3.5a\x1b\\\x1b[?1;2cWORLD" { items.extend(decoder.push(&[*b], true)); }
        let names: Vec<_> = items.iter().filter_map(|i| if let Item::Terminal(n) = i { Some(n.clone()) } else { None }).collect();
        assert_eq!(names, vec![Some("tmux 3.5a".into()), None]);
        let text: String = items.iter().filter_map(|i| match i { Item::Input(Event::Key(k)) => match k.code { KeyCode::Char(c) => Some(c), KeyCode::Enter => Some('\r'), _ => None }, _ => None }).collect();
        assert_eq!(text, "printf hello\rWORLD");
    }
    #[test]
    fn escape_at_a_read_boundary_does_not_take_the_next_prefix() {
        let mut decoder = Decoder::default();
        assert_eq!(decoder.push(b"\x1b", false), vec![Item::Input(Event::Key(KeyCode::Esc.into()))]);
        assert_eq!(decoder.push(b"\x02@", false), vec![
            Item::Input(Event::Key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL))),
            Item::Input(Event::Key(KeyCode::Char('@').into())),
        ]);
        // Bytes from one terminal write still form Alt keys and CSI sequences.
        assert_eq!(decoder.push(b"\x1bp", false), vec![Item::Input(Event::Key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::ALT)))]);
        assert!(decoder.push(b"\x1b[", false).is_empty());
        assert_eq!(decoder.push(b"A", false), vec![Item::Input(Event::Key(KeyCode::Up.into()))]);
    }
    #[test]
    fn split_utf8_paste_and_modified_keys_use_the_input_decoder() {
        let mut decoder = Decoder::default();
        let mut items = Vec::new();
        let bytes = "é\x1b[1;5D\x1b[200~paste\n\x1b[?1;2c\x1b[201~\x1bPz";
        for b in bytes.bytes() { items.extend(decoder.push(&[b], true)); }
        assert_eq!(items, vec![Item::Input(Event::Key(KeyCode::Char('é').into())), Item::Input(Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL))), Item::Input(Event::Paste("paste\n\x1b[?1;2c".into())), Item::Input(Event::Key(KeyEvent::new(KeyCode::Char('P'), KeyModifiers::SHIFT | KeyModifiers::ALT))), Item::Input(Event::Key(KeyCode::Char('z').into()))]);
        assert!(decoder.push(b"\x1b", true).is_empty());
        assert_eq!(decoder.escape(), vec![Item::Input(Event::Key(KeyCode::Esc.into()))]);
        assert!(decoder.push(b"\x1bP", true).is_empty());
        assert_eq!(decoder.escape(), vec![Item::Input(Event::Key(KeyEvent::new(KeyCode::Char('P'), KeyModifiers::SHIFT | KeyModifiers::ALT)))]);
    }
    #[test]
    fn osc10_foreground_answer_becomes_theme_and_spares_typeahead() {
        let mut decoder = Decoder::default();
        let mut items = Vec::new();
        for b in b"ls\r\x1b]10;rgb:ffff/0000/0000\x07echo done" { items.extend(decoder.push(&[*b], true)); }
        let fgs: Vec<_> = items.iter().filter_map(|i| if let Item::Foreground(n) = i { Some(n.clone()) } else { None }).collect();
        assert_eq!(fgs, vec![Some("#ff0000".into())]);
        let text: String = items.iter().filter_map(|i| match i { Item::Input(Event::Key(k)) => match k.code { KeyCode::Char(c) => Some(c), KeyCode::Enter => Some('\r'), _ => None }, _ => None }).collect();
        assert_eq!(text, "ls\recho done");
    }
    #[test]
    fn osc11_background_answers_become_theme_and_spare_typeahead() {
        let mut decoder = Decoder::default();
        let mut items = Vec::new();
        for b in b"ls\r\x1b]11;rgb:ffff/ffff/ffff\x07echo done" { items.extend(decoder.push(&[*b], true)); }
        let bgs: Vec<_> = items.iter().filter_map(|i| if let Item::Background(n) = i { Some(n.clone()) } else { None }).collect();
        assert_eq!(bgs, vec![Some("#ffffff".into())]);
        let text: String = items.iter().filter_map(|i| match i { Item::Input(Event::Key(k)) => match k.code { KeyCode::Char(c) => Some(c), KeyCode::Enter => Some('\r'), _ => None }, _ => None }).collect();
        assert_eq!(text, "ls\recho done");
    }
    #[test]
    fn osc11_parses_slash_hex_and_hash_forms() {
        assert_eq!(parse_osc11("rgb:ffff/0000/ffff"), Some("#ff00ff".into()));
        assert_eq!(parse_osc11("rgb:00ff00"), Some("#00ff00".into()));
        assert_eq!(parse_osc11("#1a1A1a"), Some("#1a1a1a".into()));
        assert_eq!(parse_osc11("rgb:0000/0000/0000"), Some("#000000".into())); // a terminal's black
        assert_eq!(parse_osc11("garbage"), None);
        for bad in ["rgb:/00/00", "rgb:ffffffff/00/00", "rgb:10000/00/00", "rgb:+1/00/00", "rgb:zz/00/00"] {
            assert_eq!(parse_osc11(bad), None, "{bad}");
        }
    }
}
