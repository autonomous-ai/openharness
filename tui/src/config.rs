//! `~/.config/harness/tui.toml` — the person's own keys and a few switches.
//!
//! ```toml
//! prefix = "ctrl+a"              # instead of ctrl+space
//! desk = "read"                  # sync | read | off   (as HARNESS_TUI_DESK)
//! predict = "off"                # auto | always | off (as HARNESS_TUI_PREDICT)
//! notify = false                 # OS notifications through the terminal
//!
//! [keys]
//! "alt+h" = "none"               # give ⌥h back to the pane (vim, readline…)
//! "alt+x" = "close-pane"
//! "super+k" = "palette"
//! ```
//!
//! A key names modifiers (`ctrl` `alt` `shift` `super`, joined by `+`) and one key: a character,
//! or `enter` `tab` `esc` `space` `backspace` `left` `right` `up` `down` `pageup` `pagedown`
//! `home` `end` `f1`…`f12`. A command is anything ⌥P's `>` lists by id (see `harness tui --keys`),
//! or `none` to leave the chord to the pane. Environment variables win over the file.

use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chord { pub code: KeyCode, pub mods: KeyModifiers }

impl Chord {
    /// One spelling per key: letters lower-case with SHIFT as a modifier; a shifted symbol (`{`,
    /// `?`) is its own character, without SHIFT.
    pub fn normal(code: KeyCode, mods: KeyModifiers) -> Chord {
        let mods = mods.intersection(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SHIFT | KeyModifiers::SUPER);
        match code {
            KeyCode::Char(c) if c.is_alphabetic() && c.is_uppercase() => Chord { code: KeyCode::Char(c.to_ascii_lowercase()), mods: mods | KeyModifiers::SHIFT },
            KeyCode::Char(c) if !c.is_alphabetic() => Chord { code: KeyCode::Char(c), mods: mods - KeyModifiers::SHIFT },
            other => Chord { code: other, mods },
        }
    }

    pub fn of(key: &KeyEvent) -> Chord { Chord::normal(key.code, key.modifiers) }

    pub fn parse(text: &str) -> Result<Chord, String> {
        let text = text.trim().to_lowercase();
        let parts: Vec<&str> = if text.ends_with("++") { let mut p: Vec<&str> = text[..text.len() - 2].split('+').collect(); p.push("+"); p } else { text.split('+').collect() };
        let (key, mods) = parts.split_last().ok_or_else(|| format!("empty key {text:?}"))?;
        let mut m = KeyModifiers::NONE;
        for part in mods {
            m |= match *part {
                "ctrl" | "control" | "c" => KeyModifiers::CONTROL,
                "alt" | "opt" | "option" | "meta" | "m" => KeyModifiers::ALT,
                "shift" | "s" => KeyModifiers::SHIFT,
                "super" | "cmd" | "command" | "d" => KeyModifiers::SUPER,
                other => return Err(format!("unknown modifier {other:?} in {text:?}")),
            };
        }
        let code = match *key {
            "enter" | "return" => KeyCode::Enter,
            "tab" => KeyCode::Tab,
            "esc" | "escape" => KeyCode::Esc,
            "space" => KeyCode::Char(' '),
            "backspace" => KeyCode::Backspace,
            "left" => KeyCode::Left, "right" => KeyCode::Right, "up" => KeyCode::Up, "down" => KeyCode::Down,
            "pageup" => KeyCode::PageUp, "pagedown" => KeyCode::PageDown, "home" => KeyCode::Home, "end" => KeyCode::End,
            k if k.len() > 1 && k.starts_with('f') && k[1..].parse::<u8>().is_ok() => KeyCode::F(k[1..].parse().unwrap()),
            k if k.chars().count() == 1 => KeyCode::Char(k.chars().next().unwrap()),
            other => return Err(format!("unknown key {other:?} in {text:?}")),
        };
        Ok(Chord::normal(code, m))
    }
}

pub struct Config {
    pub prefix: Chord,
    /// Whether the file named a prefix (else tmux's, or ~/.tmux.conf's, stands).
    pub prefix_set: bool,
    pub keys: Vec<(Chord, Option<String>)>,
    pub problems: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config { prefix: Chord::normal(KeyCode::Char('b'), KeyModifiers::CONTROL), prefix_set: false, keys: Vec::new(), problems: Vec::new() }
    }
}

pub fn path() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME").ok().filter(|s| !s.is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config"));
    base.join("harness").join("tui.toml")
}

/// Read the file and fold its switches into the environment (the environment wins).
pub fn load() -> Config {
    let mut config = Config::default();
    let Ok(text) = std::fs::read_to_string(path()) else { return config };
    let value: toml::Value = match text.parse() {
        Ok(v) => v,
        Err(error) => { config.problems.push(format!("tui.toml: {}", error.to_string().lines().next().unwrap_or(""))); return config }
    };
    // SAFETY: called from `main` before the async runtime (or any other thread) exists.
    let setenv = |name: &str, value: &str| { if std::env::var(name).is_err() { unsafe { std::env::set_var(name, value) } } };
    if let Some(p) = value.get("prefix").and_then(|v| v.as_str()) {
        match crate::keys::parse(p) { Ok(c) => { config.prefix = c; config.prefix_set = true } Err(e) => config.problems.push(format!("tui.toml prefix: {e}")) }
    }
    if let Some(d) = value.get("desk").and_then(|v| v.as_str()) { setenv("HARNESS_TUI_DESK", d) }
    if let Some(p) = value.get("predict").and_then(|v| v.as_str()) { setenv("HARNESS_TUI_PREDICT", p) }
    if let Some(false) = value.get("notify").and_then(|v| v.as_bool()) { setenv("HARNESS_TUI_NOTIFY", "off") }
    if let Some(keys) = value.get("keys").and_then(|v| v.as_table()) {
        for (chord, command) in keys {
            let Some(command) = command.as_str() else { config.problems.push(format!("tui.toml keys.{chord}: expected a command name")); continue };
            match crate::keys::parse(chord) {
                Ok(c) => config.keys.push((c, if command == "none" { None } else { Some(command.to_string()) })),
                Err(e) => config.problems.push(format!("tui.toml keys: {e}")),
            }
        }
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_normalises() {
        assert_eq!(Chord::parse("alt+shift+p").unwrap(), Chord::normal(KeyCode::Char('P'), KeyModifiers::ALT));
        assert_eq!(Chord::parse("ctrl+space").unwrap(), Chord::normal(KeyCode::Char(' '), KeyModifiers::CONTROL));
        assert_eq!(Chord::parse("alt+{").unwrap(), Chord::normal(KeyCode::Char('{'), KeyModifiers::ALT | KeyModifiers::SHIFT));
        assert_eq!(Chord::parse("super+enter").unwrap().code, KeyCode::Enter);
        assert_eq!(Chord::parse("alt++").unwrap().code, KeyCode::Char('+'));
        assert!(Chord::parse("hyper+x").is_err());
    }
}
