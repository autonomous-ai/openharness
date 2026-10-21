//! Keys as an xterm sends them to the program in a pane, and tmux key names (`send-keys Enter`,
//! `C-c`, `M-Left`) to those bytes. hn's panes and the PTY host's `key` op share this table.

/// A key, without its modifiers. `F(13..=28)` are the keypad keys (KP/ … KP.), after F12, as
/// tmux orders them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Enter,
    Tab,
    BackTab,
    Backspace,
    Esc,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    Delete,
    F(u8),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
}

impl Mods {
    fn none(self) -> bool {
        !(self.shift || self.alt || self.ctrl)
    }
}

/// The pane's terminal modes the bytes depend on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modes {
    /// DECCKM: arrows, Home and End as `ESC O x`.
    pub app_cursor: bool,
    /// DECKPAM: keypad keys as `ESC O x`.
    pub app_keypad: bool,
}

/// tmux's keypad keys (KP/ … KP.), kept past F12 so they bind and list as tmux's do.
pub const KEYPAD: [&str; 16] = [
    "KP/", "KP*", "KP-", "KP7", "KP8", "KP9", "KP+", "KP4", "KP5", "KP6", "KP1", "KP2", "KP3",
    "KPEnter", "KP0", "KP.",
];

fn modifier_param(mods: Mods) -> u8 {
    let mut n = 1;
    if mods.shift {
        n += 1
    }
    if mods.alt {
        n += 2
    }
    if mods.ctrl {
        n += 4
    }
    n
}

/// The bytes an xterm sends for `key` with `mods`; `None` for a key it sends nothing for.
pub fn encode(key: Key, mods: Mods, modes: Modes) -> Option<Vec<u8>> {
    let Mods { shift, alt, ctrl } = mods;
    let csi = |final_byte: char, fallback_ss3: bool| -> Vec<u8> {
        if mods.none()
            || (mods
                == Mods {
                    shift: true,
                    ..Mods::default()
                }
                && final_byte == 'Z')
        {
            if fallback_ss3 && modes.app_cursor {
                format!("\x1bO{final_byte}").into_bytes()
            } else {
                format!("\x1b[{final_byte}").into_bytes()
            }
        } else {
            format!("\x1b[1;{}{final_byte}", modifier_param(mods)).into_bytes()
        }
    };
    let tilde = |code: u8| -> Vec<u8> {
        if mods.none() {
            format!("\x1b[{code}~").into_bytes()
        } else {
            format!("\x1b[{code};{}~", modifier_param(mods)).into_bytes()
        }
    };
    let with_alt = |mut bytes: Vec<u8>| -> Vec<u8> {
        if alt {
            bytes.insert(0, 0x1b)
        }
        bytes
    };
    Some(match key {
        Key::Char(c) => {
            if ctrl {
                let lower = c.to_ascii_lowercase();
                let byte = match lower {
                    'a'..='z' => lower as u8 - b'a' + 1,
                    '@' | ' ' | '2' => 0,
                    '[' | '3' => 0x1b,
                    '\\' | '4' => 0x1c,
                    ']' | '5' => 0x1d,
                    '^' | '6' => 0x1e,
                    '_' | '-' | '7' => 0x1f,
                    '8' | '?' => 0x7f,
                    '/' => 0x1f,
                    '`' => 0,
                    _ => return Some(with_alt(c.to_string().into_bytes())),
                };
                with_alt(vec![byte])
            } else {
                // S-x is X (a key tmux names M-X arrives here as M-S-x).
                let c = if shift && c.is_lowercase() {
                    c.to_uppercase().next().unwrap_or(c)
                } else {
                    c
                };
                let mut buf = [0u8; 4];
                with_alt(c.encode_utf8(&mut buf).as_bytes().to_vec())
            }
        }
        // As the desktop sends it: prompts tell a newline (⇧⏎) from the Return that submits.
        Key::Enter if shift && !alt && !ctrl => b"\x1b[13;2u".to_vec(),
        Key::Enter => with_alt(vec![b'\r']),
        // S-Tab is a Tab (tmux drops the shift without extended keys); BTab is the back tab.
        Key::Tab => with_alt(vec![b'\t']),
        Key::BackTab => b"\x1b[Z".to_vec(),
        Key::Backspace => with_alt(if ctrl { vec![0x08] } else { vec![0x7f] }),
        Key::Esc => with_alt(vec![0x1b]),
        Key::Up => csi('A', true),
        Key::Down => csi('B', true),
        Key::Right => csi('C', true),
        Key::Left => csi('D', true),
        Key::Home => csi('H', true),
        Key::End => csi('F', true),
        Key::PageUp => tilde(5),
        Key::PageDown => tilde(6),
        Key::Insert => tilde(2),
        Key::Delete => tilde(3),
        Key::F(n) => match n {
            1..=4 => {
                let f = b"PQRS"[(n - 1) as usize] as char;
                if mods.none() {
                    format!("\x1bO{f}").into_bytes()
                } else {
                    format!("\x1b[1;{}{f}", modifier_param(mods)).into_bytes()
                }
            }
            5 => tilde(15),
            6 => tilde(17),
            7 => tilde(18),
            8 => tilde(19),
            9 => tilde(20),
            10 => tilde(21),
            11 => tilde(23),
            12 => tilde(24),
            // The keypad (KP/ … KP., after F12): its characters, or ESC O x in application
            // keypad mode (tmux's input_key_defaults).
            13..=28 => {
                let i = (n - 13) as usize;
                if modes.app_keypad {
                    format!("\x1bO{}", "ojmwxyktuvqrsMpn".as_bytes()[i] as char).into_bytes()
                } else {
                    with_alt(if i == 13 {
                        vec![b'\n']
                    } else {
                        vec!["/*-789+456123\n0.".as_bytes()[i]]
                    })
                }
            }
            _ => return None,
        },
    })
}

/// A key in tmux's spelling (`Enter`, `C-c`, `M-Left`, `S-Up`, `^D`, `Space`, `PPage`, `KP5`, `a`):
/// modifiers in either case, a key's name in any case.
pub fn parse(name: &str) -> Option<(Key, Mods)> {
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Some((Key::Char(c), Mods::default()));
    }
    let mut mods = Mods::default();
    let mut rest = name;
    // ^x: C-x.
    if let Some(r) = rest.strip_prefix('^')
        && !r.is_empty()
    {
        mods.ctrl = true;
        rest = r;
    }
    loop {
        let b = rest.as_bytes();
        if b.len() > 2 && b[1] == b'-' {
            match b[0].to_ascii_uppercase() {
                b'C' => mods.ctrl = true,
                b'M' => mods.alt = true,
                b'S' => mods.shift = true,
                _ => return None,
            }
            rest = &rest[2..];
            continue;
        }
        break;
    }
    let mut chars = rest.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return ((c as u32) >= 0x20).then_some((Key::Char(c), mods));
    }
    let lower = rest.to_ascii_lowercase();
    let key = match lower.as_str() {
        "space" => Key::Char(' '),
        "enter" => Key::Enter,
        "tab" => Key::Tab,
        "btab" => Key::BackTab,
        "escape" => Key::Esc,
        "bspace" => Key::Backspace,
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "ppage" | "pageup" | "pgup" => Key::PageUp,
        "npage" | "pagedown" | "pgdn" => Key::PageDown,
        "home" => Key::Home,
        "end" => Key::End,
        "dc" | "delete" => Key::Delete,
        "ic" | "insert" => Key::Insert,
        f if f.len() > 1
            && f.starts_with('f')
            && !f[1..].starts_with('0')
            && matches!(f[1..].parse::<u8>(), Ok(1..=12)) =>
        {
            Key::F(f[1..].parse().ok()?)
        }
        k => Key::F(13 + KEYPAD.iter().position(|p| p.eq_ignore_ascii_case(k))? as u8),
    };
    Some((key, mods))
}

/// What `tmux send-keys <name>` writes to a pane; `None` for a name that is not a key.
pub fn bytes_for(name: &str, app_cursor: bool) -> Option<Vec<u8>> {
    let (key, mods) = parse(name)?;
    encode(
        key,
        mods,
        Modes {
            app_cursor,
            app_keypad: false,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: false,
    };
    const CTRL: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: true,
    };
    const ALT: Mods = Mods {
        shift: false,
        alt: true,
        ctrl: false,
    };

    fn plain(key: Key) -> Vec<u8> {
        encode(key, NONE, Modes::default()).unwrap()
    }

    #[test]
    fn arrows_follow_cursor_mode() {
        assert_eq!(plain(Key::Up), b"\x1b[A");
        let app = Modes {
            app_cursor: true,
            app_keypad: false,
        };
        assert_eq!(encode(Key::Up, NONE, app).unwrap(), b"\x1bOA");
        assert_eq!(
            encode(Key::Left, CTRL, Modes::default()).unwrap(),
            b"\x1b[1;5D"
        );
    }

    #[test]
    fn control_and_alt() {
        assert_eq!(
            encode(Key::Char('c'), CTRL, Modes::default()).unwrap(),
            vec![3]
        );
        assert_eq!(
            encode(Key::Char('b'), ALT, Modes::default()).unwrap(),
            b"\x1bb"
        );
        assert_eq!(plain(Key::Enter), b"\r");
        assert_eq!(
            encode(Key::Char('/'), CTRL, Modes::default()).unwrap(),
            vec![0x1f]
        );
    }

    #[test]
    fn keypad_follows_keypad_mode() {
        assert_eq!(plain(Key::F(13 + 4)), b"8");
        let app = Modes {
            app_cursor: false,
            app_keypad: true,
        };
        assert_eq!(encode(Key::F(13 + 4), NONE, app).unwrap(), b"\x1bOx");
    }

    #[test]
    fn tmux_names_the_daemon_sends() {
        // TMUX_KEYS in cli/src/lib/tmuxBackend.ts.
        let cases: &[(&str, &[u8])] = &[
            ("Enter", b"\r"),
            ("Escape", b"\x1b"),
            ("Tab", b"\t"),
            ("BTab", b"\x1b[Z"),
            ("Up", b"\x1b[A"),
            ("Down", b"\x1b[B"),
            ("Left", b"\x1b[D"),
            ("Right", b"\x1b[C"),
            ("Home", b"\x1b[H"),
            ("End", b"\x1b[F"),
            ("BSpace", b"\x7f"),
            ("DC", b"\x1b[3~"),
            ("PPage", b"\x1b[5~"),
            ("NPage", b"\x1b[6~"),
            ("C-c", b"\x03"),
            ("C-d", b"\x04"),
            ("C-u", b"\x15"),
            ("C-w", b"\x17"),
            ("Space", b" "),
            ("0", b"0"),
            ("9", b"9"),
        ];
        for (name, bytes) in cases {
            assert_eq!(bytes_for(name, false).as_deref(), Some(*bytes), "{name}");
        }
    }

    #[test]
    fn names_with_modifiers_and_cursor_mode() {
        assert_eq!(bytes_for("Up", true).unwrap(), b"\x1bOA");
        assert_eq!(bytes_for("M-Left", false).unwrap(), b"\x1b[1;3D");
        assert_eq!(bytes_for("S-Up", false).unwrap(), b"\x1b[1;2A");
        assert_eq!(bytes_for("^D", false).unwrap(), b"\x04");
        assert_eq!(bytes_for("c-a", false).unwrap(), b"\x01");
        assert_eq!(bytes_for("M-x", false).unwrap(), b"\x1bx");
        assert_eq!(bytes_for("F1", false).unwrap(), b"\x1bOP");
        assert_eq!(bytes_for("F12", false).unwrap(), b"\x1b[24~");
        assert_eq!(bytes_for("KP5", false).unwrap(), b"5");
        assert_eq!(bytes_for("enter", false).unwrap(), b"\r");
        assert_eq!(bytes_for("é", false).unwrap(), "é".as_bytes());
        assert_eq!(bytes_for("-", false).unwrap(), b"-");
    }

    #[test]
    fn unknown_names_are_none() {
        for name in ["", "Nope", "F13", "F0", "X-a", "C-", "hello"] {
            assert_eq!(bytes_for(name, false), None, "{name}");
        }
    }
}
