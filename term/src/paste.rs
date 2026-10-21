//! What a paste writes to a pane, as `tmux paste-buffer [-p]` writes it.

/// What a bracketed paste may carry into a pane: the text as written, with every control
/// character but tab and newline made visible, so that nothing in it acts as a keystroke.
///
/// A port of `neutralizePasteControls` (cli/src/lib/pasteText.ts), which explains why: a message
/// carrying `ESC [201~` would otherwise end its own paste and have the rest typed. In tmux 3.7c's
/// form: caret notation, `^[` for ESC, `^?` for DEL. A carriage return, alone or before a newline,
/// is one newline. The 8-bit C1 controls are shown as the ESC and letter a terminal may read them
/// as (U+009B is `^[[`).
pub fn neutralize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let code = c as u32;
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\t' | '\n' => out.push(c),
            '\x7f' => out.push_str("^?"),
            _ if code < 0x20 => {
                out.push('^');
                out.push(char::from(code as u8 + 0x40));
            }
            _ if (0x80..=0x9f).contains(&code) => {
                out.push_str("^[");
                out.push(char::from((code - 0x40) as u8));
            }
            _ => out.push(c),
        }
    }
    out
}

/// The bytes `tmux paste-buffer` writes for `text`: each newline as a carriage return (the
/// default separator), and with `bracketed` (`-p`) the text neutralized and, when the program
/// asked for bracketed paste (`bracketed_paste_mode`), between `ESC [200~` and `ESC [201~`.
pub fn bytes(text: &str, bracketed: bool, bracketed_paste_mode: bool) -> Vec<u8> {
    let text = if bracketed {
        neutralize(text)
    } else {
        text.to_owned()
    };
    let body = text.replace('\n', "\r");
    if bracketed && bracketed_paste_mode {
        let mut out = Vec::with_capacity(body.len() + 12);
        out.extend_from_slice(b"\x1b[200~");
        out.extend_from_slice(body.as_bytes());
        out.extend_from_slice(b"\x1b[201~");
        out
    } else {
        body.into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ESC: &str = "\x1b";

    // The cases of cli/src/lib/pasteText.spec.ts.

    #[test]
    fn shows_the_pastes_own_markers_as_text() {
        // The message that made the engine run `!exit` on tmux 3.2a and 3.3a (e2e/content.e2e.ts).
        assert_eq!(
            neutralize(&format!("hello{ESC}[201~\r!exit\r")),
            "hello^[[201~\n!exit\n"
        );
        assert_eq!(
            neutralize(&format!("{ESC}[200~typed?{ESC}[201~")),
            "^[[200~typed?^[[201~"
        );
        assert_eq!(
            neutralize(&format!("before{ESC}[2J{ESC}[Hafter")),
            "before^[[2J^[[Hafter"
        );
    }

    #[test]
    fn makes_every_control_but_tab_and_newline_visible() {
        for code in 0u8..0x20 {
            if code == 0x09 || code == 0x0a || code == 0x0d {
                continue;
            }
            assert_eq!(
                neutralize(&format!("a{}b", code as char)),
                format!("a^{}b", (code + 0x40) as char),
                "0x{code:x}"
            );
        }
        assert_eq!(neutralize("a\x7fb"), "a^?b");
        assert_eq!(neutralize("a\tb\nc"), "a\tb\nc");
    }

    #[test]
    fn a_carriage_return_alone_or_before_a_newline_is_one_line_break() {
        assert_eq!(
            neutralize("one\r\ntwo\rthree\nfour"),
            "one\ntwo\nthree\nfour"
        );
    }

    #[test]
    fn an_8_bit_control_shows_as_esc_and_a_letter() {
        assert_eq!(neutralize("\u{009b}31mred"), "^[[31mred");
        assert_eq!(neutralize("\u{009d}0;title\u{0007}"), "^[]0;title^G");
    }

    #[test]
    fn leaves_text_as_people_write_it() {
        for text in [
            "a family 👨‍👩‍👧‍👦 and a flag 🇻🇳, joined",
            "שלום עולם and مرحبا بالعالم, right to left",
            "tabs\tbetween\twords and `backticks` $(echo not run) ; | & > <",
            "combining: é ä and a zero-width\u{200b}space",
            "a caret and a bracket typed by hand: ^[ is two characters",
        ] {
            assert_eq!(neutralize(text), text);
        }
    }

    #[test]
    fn changes_nothing_the_second_time() {
        let once = neutralize(&format!("x{ESC}[201~\r\n\u{009b}y\x00"));
        assert_eq!(neutralize(&once), once);
    }

    #[test]
    fn bytes_bracket_only_when_the_program_asked() {
        assert_eq!(bytes("a\nb", true, true), b"\x1b[200~a\rb\x1b[201~");
        assert_eq!(bytes("a\nb", true, false), b"a\rb");
        assert_eq!(
            bytes(&format!("x{ESC}[201~y"), true, true),
            b"\x1b[200~x^[[201~y\x1b[201~"
        );
        // Unbracketed: typed as given, newlines as carriage returns.
        assert_eq!(bytes(&format!("x{ESC}y\n"), false, true), b"x\x1by\r");
    }
}
