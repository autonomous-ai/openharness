//! hn's one way to name a folder under the account's ~/.harness. The table here holds only what hn
//! uses; the full one is in cli/src/config/harnessHome.ts and desktop/lib/core/harness_home.dart.
//! The guard below fails on a .harness path built by hand anywhere else in src.

use std::path::{Path, PathBuf};

pub const HARNESS_DIR: &str = ".harness";

/// Data is what a person would miss, state what Harness rebuilds. Both are one folder today.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Root { Data, State }

/// What hn builds through the helper: tui (Data), shell-requests (State).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    Tui,
    // Its callers are Unix only: a Windows hn has no Harness shell yet.
    #[cfg_attr(windows, allow(dead_code))]
    ShellRequests,
}

impl Entry {
    pub fn name(self) -> &'static str {
        match self {
            Entry::Tui => "tui",
            Entry::ShellRequests => "shell-requests",
        }
    }

    pub fn root(self) -> Root {
        match self {
            Entry::Tui => Root::Data,
            Entry::ShellRequests => Root::State,
        }
    }
}

/// `<home>/.harness` for either root, as the callers joined it before. An empty home (HOME unset)
/// gives today's relative `.harness`.
pub fn harness_root(home: impl AsRef<Path>, _root: Root) -> PathBuf {
    home.as_ref().join(HARNESS_DIR)
}

/// `<home>/.harness/<entry>`: `home.join(".harness").join(name)`.
pub fn harness_path(home: impl AsRef<Path>, entry: Entry) -> PathBuf {
    harness_root(home, entry.root()).join(entry.name())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_is_under_the_homes_harness() {
        assert_eq!(harness_path("/h", Entry::Tui), PathBuf::from("/h").join(".harness").join("tui"));
        assert_eq!(harness_path("/h", Entry::ShellRequests), PathBuf::from("/h").join(".harness").join("shell-requests"));
        assert_eq!(Entry::Tui.root(), Root::Data);
        assert_eq!(Entry::ShellRequests.root(), Root::State);
    }

    #[test]
    fn both_roots_are_one_folder() {
        assert_eq!(harness_root("/h", Root::Data), harness_root("/h", Root::State));
        assert_eq!(harness_root("/h", Root::Data), PathBuf::from("/h").join(".harness"));
    }

    #[test]
    fn the_same_paths_as_before() {
        assert_eq!(harness_path("/h", Entry::ShellRequests), PathBuf::from("/h").join(".harness/shell-requests"));
    }

    #[test]
    fn an_empty_home() {
        // HOME unset: callers read "" and get today's relative .harness/…
        assert_eq!(harness_path("", Entry::Tui), PathBuf::from("").join(".harness").join("tui"));
    }

    // ── the guard: no hand-built home .harness path outside this file ──

    /// A file the guard skips, or one literal in it, and why.
    const ALLOWED: &[(&str, Option<&str>, &str)] = &[
        ("shell_integration.sh", None, "sourced by a shell, which cannot call the helper"),
        ("daemon.rs", Some("\".harness/cli/data\""), "joined in one piece its Windows text is today's …\\.harness/cli/data; PR 2 moves it"),
    ];

    const HOME_WORDS: &[&str] = &["HOME", "USERPROFILE", "home", "profile"];
    const INLINE: &[&str] = &["$HOME/.harness", "~/.harness", "%USERPROFILE%\\.harness", "%USERPROFILE%\\\\.harness", "{home}/.harness"];

    #[derive(Debug, PartialEq)]
    struct Hit { file: String, line: usize, text: String }

    impl std::fmt::Display for Hit {
        fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { write!(f, "{}:{}: {}", self.file, self.line, self.text) }
    }

    fn allowed(hit: &Hit) -> bool {
        ALLOWED.iter().any(|(file, text, _)| hit.file == *file && text.is_none_or(|t| t == hit.text))
    }

    /// One line without its comment, and the braces it opens less those it closes, strings and chars aside.
    fn strip(line: &str, shell: bool) -> (String, i32) {
        let chars: Vec<char> = line.chars().collect();
        let (mut code, mut braces, mut quote, mut i) = (String::new(), 0, None::<char>, 0);
        while i < chars.len() {
            let c = chars[i];
            if let Some(q) = quote {
                code.push(c);
                if c == '\\' && !shell && i + 1 < chars.len() { code.push(chars[i + 1]); i += 1 } else if c == q { quote = None }
            } else if !shell && c == '/' && chars.get(i + 1) == Some(&'/') {
                break;
            } else if shell && c == '#' && (i == 0 || chars[i - 1].is_whitespace()) {
                break;
            } else if c == '"' || (shell && c == '\'') {
                quote = Some(c);
                code.push(c);
            } else if c == '\'' {
                // A char literal ('x', '\n', '{') holds no brace; a lifetime has no closing quote.
                let end = if chars.get(i + 1) == Some(&'\\') { chars[i + 2..].iter().position(|&d| d == '\'').map(|p| i + 2 + p) }
                    else if chars.get(i + 2) == Some(&'\'') { Some(i + 2) } else { None };
                let end = end.unwrap_or(i);
                code.extend(&chars[i..=end]);
                i = end;
            } else {
                if c == '{' { braces += 1 } else if c == '}' { braces -= 1 }
                code.push(c);
            }
            i += 1;
        }
        (code, braces)
    }

    /// The file's lines as the guard reads them: comments and `#[cfg(test)]` modules blanked, so line numbers hold.
    fn code_lines(text: &str, shell: bool) -> Vec<String> {
        let (mut out, mut test_attr, mut depth) = (Vec::new(), false, 0);
        for line in text.lines() {
            let (code, braces) = strip(line, shell);
            if depth > 0 {
                depth += braces;
                out.push(String::new());
                continue;
            }
            let trimmed = code.trim();
            let item = match trimmed.strip_prefix("#[cfg(test)]") {
                Some(rest) => { test_attr = true; rest.trim() }
                None => trimmed,
            };
            if test_attr {
                let unpub = item.strip_prefix("pub(crate) ").or_else(|| item.strip_prefix("pub ")).unwrap_or(item);
                if unpub.starts_with("mod ") && item.contains('{') {
                    test_attr = false;
                    depth = braces;
                    out.push(String::new());
                    continue;
                }
                if !(item.is_empty() || item.starts_with("#[")) { test_attr = false }
            }
            out.push(code);
        }
        out
    }

    fn whole_word(line: &str, word: &str) -> bool {
        let is_word = |c: char| c.is_alphanumeric() || c == '_';
        line.match_indices(word).any(|(at, _)| {
            !line[..at].chars().next_back().is_some_and(is_word) && !line[at + word.len()..].chars().next().is_some_and(is_word)
        })
    }

    /// Every hand-built home .harness path in one file's text.
    fn hits(file: &str, text: &str) -> Vec<Hit> {
        let lines = code_lines(text, file.ends_with(".sh"));
        let mut found = Vec::new();
        for (n, line) in lines.iter().enumerate() {
            let near_home = lines[n.saturating_sub(2)..=n].iter().any(|l| HOME_WORDS.iter().any(|w| whole_word(l, w)));
            for (at, _) in line.match_indices("\".harness") {
                let rest = &line[at + 1..];
                if !near_home || !rest[".harness".len()..].starts_with(['"', '/', '\\']) { continue }
                let end = rest.find('"').map_or(line.len(), |q| at + 1 + q + 1);
                found.push(Hit { file: file.into(), line: n + 1, text: line[at..end].into() });
            }
            for pattern in INLINE {
                for (at, _) in line.match_indices(pattern) {
                    let next = line[at + pattern.len()..].chars().next();
                    if next.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '-') { continue }
                    found.push(Hit { file: file.into(), line: n + 1, text: (*pattern).into() });
                }
            }
        }
        found
    }

    /// Every hit in `src` but this file, named relative to `src`.
    fn scan_src() -> Vec<Hit> {
        fn walk(dir: &std::path::Path, rel: &str, found: &mut Vec<Hit>) {
            for entry in std::fs::read_dir(dir).unwrap().map(Result::unwrap) {
                let name = entry.file_name().into_string().unwrap();
                let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                if entry.file_type().unwrap().is_dir() { walk(&entry.path(), &path, found); continue }
                if path == "harness_home.rs" || !(name.ends_with(".rs") || name.ends_with(".sh")) { continue }
                found.extend(hits(&path, &std::fs::read_to_string(entry.path()).unwrap()));
            }
        }
        let mut found = Vec::new();
        walk(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src"), "", &mut found);
        found
    }

    #[test]
    fn the_guard_finds_each_shape_in_a_planted_line() {
        let planted = [
            ("let p = PathBuf::from(var(\"HOME\")?).join(\".harness/x\");", "\".harness/x\""),
            ("let p = profile.join(\".harness\");", "\".harness\""),
            ("let p = PathBuf::from(var(\"USERPROFILE\")?).join(\".harness\\\\pty\");", "\".harness\\\\pty\""),
            ("let s = \"$HOME/.harness/tui\";", "$HOME/.harness"),
            ("let s = \"~/.harness\";", "~/.harness"),
            ("let s = \"%USERPROFILE%\\\\.harness\";", "%USERPROFILE%\\\\.harness"),
            ("let s = format!(\"{home}/.harness/s\");", "{home}/.harness"),
            ("_hn_dir=\"$HOME/.harness/x\"", "$HOME/.harness"),
        ];
        for (line, text) in planted {
            assert_eq!(hits("a.rs", line), vec![Hit { file: "a.rs".into(), line: 1, text: text.into() }], "{line}");
        }
        // The home two lines above, and code after a test module.
        let text = "let home = h();\nlet x = 1;\nlet p = x.join(\".harness\");\n#[cfg(test)]\nmod t {\n    let c = '{';\n}\nlet q = home.join(\".harness/y\");";
        let lines: Vec<usize> = hits("a.rs", text).iter().map(|h| h.line).collect();
        assert_eq!(lines, [3, 8]);
    }

    #[test]
    fn the_guard_ignores_comments_test_modules_a_projects_folder_and_harness_names() {
        let rust = [
            "// ~/.harness/tui, from HOME: home.join(\".harness\")",
            "/// HOME.join(\".harness\")",
            "let u = \"https://x\"; // home.join(\".harness\")",
            "#[cfg(test)]",
            "mod tests {",
            "    fn f() { let p = home.join(\".harness\"); }",
            "}",
            "format!(\".harness/handoff/{}-{change}.md\", safe)",
            "let p = folder.join(\".harness\");",
            "let p = home.join(\".harness-tmux\");",
            "let s = \"~/.harness-name\";",
        ];
        assert_eq!(hits("a.rs", &rust.join("\n")), vec![]);
        assert_eq!(hits("a.sh", "# $HOME/.harness/x\necho hi  # ~/.harness"), vec![]);
    }

    #[test]
    fn src_holds_none_but_the_allowlisted() {
        let left: Vec<String> = scan_src().iter().filter(|h| !allowed(h)).map(Hit::to_string).collect();
        assert!(left.is_empty(), "build these through harness_home::harness_path:\n{}", left.join("\n"));
    }

    #[test]
    fn every_allowlist_entry_still_matches_a_hit() {
        let found = scan_src();
        for (file, text, why) in ALLOWED {
            assert!(found.iter().any(|h| h.file == *file && text.is_none_or(|t| t == h.text)), "{file} ({why}) no longer holds its hit");
        }
    }
}
