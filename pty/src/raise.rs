//! `raise` and `open-link` (cli.rs): how a tap on the dial brings an app forward on Windows
//! (cli/src/cable/hosts/windowsRaise.ts calls them).

#[cfg(test)]
mod tests {
    use super::*;

    const SHOWN: Candidate = Candidate {
        visible: true,
        owned: false,
        tool: false,
    };
    const HIDDEN: Candidate = Candidate {
        visible: false,
        ..SHOWN
    };
    const OWNED: Candidate = Candidate {
        owned: true,
        ..SHOWN
    };
    const TOOL: Candidate = Candidate {
        tool: true,
        ..SHOWN
    };

    /// This file's code without its tests, which name the calls they look for.
    fn code() -> &'static str {
        include_str!("raise.rs")
            .split_once("#[cfg(test)]\nmod tests")
            .unwrap()
            .0
    }

    #[test]
    fn pick_skips_hidden_owned_and_tool_windows_and_takes_the_first_left() {
        assert_eq!(pick(&[HIDDEN, OWNED, TOOL, SHOWN, SHOWN]), Some(3));
        assert_eq!(pick(&[SHOWN, HIDDEN]), Some(0));
    }

    #[test]
    fn pick_finds_none_when_no_window_qualifies() {
        assert_eq!(pick(&[HIDDEN, OWNED, TOOL]), None);
        assert_eq!(pick(&[]), None);
    }

    /// Windows' foreground rules are kept: no input injected, no thread input joined, no lock
    /// timeout changed, no rights handed out (spec, Decided 4).
    #[test]
    fn the_window_code_uses_only_the_documented_calls() {
        for call in [
            "AttachThreadInput",
            "SendInput",
            "keybd_event",
            "SystemParametersInfo",
            "AllowSetForegroundWindow",
        ] {
            assert!(!code().contains(call), "{call}");
        }
    }

    /// A scheme with no handler must open nothing and show no "pick an app" window.
    #[test]
    fn the_link_code_asks_for_no_ui() {
        assert!(code().contains("SEE_MASK_FLAG_NO_UI"));
    }
}
