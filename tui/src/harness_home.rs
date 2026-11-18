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

    /// A hit the guard keeps on purpose: its file, the text it matched, and why. Each excuses exactly one hit.
    const ALLOWED: &[(&str, &str, &str)] = &[
        ("shell_integration.sh", "$HOME/.harness", "sourced by a shell, which cannot call the helper"),
        ("daemon.rs", "\".harness/cli/data\"", "joined in one piece its Windows text is today's …\\.harness/cli/data; PR 2 moves it"),
    ];

    // The guard: no home `.harness` path built by hand in src but this file. Each Rust crate's harness_home.rs holds
    // this same text from here on, and rustfmt leaves it so in each; only its ALLOWED above differs.

    /// Words that make a `".harness"` or a `}/.harness` a home's: on its line or one of the two above.
    const HOME_WORDS: [&str; 5] = ["HOME", "USERPROFILE", "home", "profile", "home_dir"];
    /// A home's `.harness` written out whole.
    const INLINE: [&str; 4] = [
        "$HOME/.harness",
        "~/.harness",
        // Source text doubles a backslash in a plain string, not in a raw one.
        r"%USERPROFILE%\.harness",
        r"%USERPROFILE%\\.harness",
    ];
    /// A `.harness` after a placeholder, as in `format!("{}/.harness", …)` or `${HOME}/.harness`.
    const PLACED: [&str; 3] = ["}/.harness", r"}\.harness", r"}\\.harness"];
    const NO_END: &str = "a test module whose braces never close";

    #[derive(Debug, PartialEq)]
    struct Hit {
        file: String,
        line: usize,
        text: String,
    }

    impl Hit {
        fn new(file: &str, line: usize, text: &str) -> Hit {
            let (file, text) = (file.to_string(), text.to_string());
            Hit { file, line, text }
        }
    }

    impl std::fmt::Display for Hit {
        fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            write!(f, "{}:{}: {}", self.file, self.line, self.text)
        }
    }

    /// One line as the guard reads it: its code without comments, and the braces it opens less those it closes.
    #[derive(Default)]
    struct Line {
        code: String,
        braces: i32,
    }

    fn word_char(c: char) -> bool {
        c.is_alphanumeric() || c == '_'
    }

    /// The source's lines without comments, so line numbers hold. Strings and char literals are code, and a string
    /// may span lines; a `//` outside them (a `#` starting a word in a shell script) starts a comment.
    fn code_lines(text: &str, shell: bool) -> Vec<Line> {
        let mut lines = vec![Line::default()];
        // What ends the string the scan is in, and whether a backslash escapes in it.
        let mut string: Option<(String, bool)> = None;
        let mut at = 0;
        while let Some(c) = text[at..].chars().next() {
            let rest = &text[at..];
            let before = text[..at].chars().next_back();
            let word_start = !before.is_some_and(word_char);
            let comment = match shell {
                true => c == '#' && before.is_none_or(char::is_whitespace),
                false => rest.starts_with("//"),
            };
            let raw = raw_string(rest).filter(|_| !shell && word_start);
            let mut len = c.len_utf8();
            let line = lines.last_mut().unwrap();
            if c == '\n' {
                lines.push(Line::default());
            } else if let Some((end, escapes)) = &string {
                if *escapes && c == '\\' {
                    len = escape(rest);
                } else if rest.starts_with(end.as_str()) {
                    len = end.len();
                    string = None;
                }
                line.code.push_str(&rest[..len]);
            } else if comment {
                len = rest.find('\n').unwrap_or(rest.len());
            } else {
                if c == '"' || shell && c == '\'' {
                    string = Some((c.to_string(), c == '"'));
                } else if shell && c == '\\' {
                    len = escape(rest);
                } else if let Some((open, end)) = raw {
                    len = open;
                    string = Some((end, false));
                } else if !shell && c == '\'' {
                    len = char_literal(rest).unwrap_or(len);
                } else if c == '{' {
                    line.braces += 1;
                } else if c == '}' {
                    line.braces -= 1;
                }
                line.code.push_str(&rest[..len]);
            }
            at += len;
        }
        lines
    }

    /// At a backslash: its length with the char it escapes, which a line end is not.
    fn escape(rest: &str) -> usize {
        let next = rest[1..].chars().next().filter(|&c| c != '\n');
        1 + next.map_or(0, char::len_utf8)
    }

    /// At a raw string (`r"`, `r#"`, `br"`): how long its opening is, and what closes it.
    fn raw_string(rest: &str) -> Option<(usize, String)> {
        let after = rest.strip_prefix("br").or_else(|| rest.strip_prefix('r'))?;
        let hashes = after.len() - after.trim_start_matches('#').len();
        let open = rest.len() - after.len() + hashes + 1;
        let close = format!("\"{}", "#".repeat(hashes));
        after[hashes..].starts_with('"').then_some((open, close))
    }

    /// At a `'`: the length of the char literal it opens (`'"'`, `'\''`), or none for a lifetime.
    fn char_literal(rest: &str) -> Option<usize> {
        if rest[1..].starts_with('\\') {
            return rest.get(3..)?.find('\'').map(|close| close + 4);
        }
        let c = rest[1..].chars().next()?;
        let close = 1 + c.len_utf8();
        (c != '\'' && rest[close..].starts_with('\'')).then_some(close + 1)
    }

    /// Blanks each test-only module (`#[cfg(test)]`, `#[cfg(all(test, …))]`) and its attributes. One whose braces
    /// never close is a hit at its `mod` line, and the lines after it stay.
    fn blank_test_modules(file: &str, lines: &mut [Line]) -> Option<Hit> {
        let mut attribute = None;
        let mut index = 0;
        while index < lines.len() {
            let code = lines[index].code.trim();
            let item = code.trim_start_matches("pub(crate) ");
            let item = item.trim_start_matches("pub ");
            let test = item.starts_with("#[cfg(test)]") || item.starts_with("#[cfg(all(test,");
            if test {
                attribute.get_or_insert(index);
            } else if !(item.is_empty() || item.starts_with("#["))
                && let Some(start) = attribute.take()
                && item.starts_with("mod ")
            {
                let mut depth = lines[index].braces;
                let mut end = index;
                while depth > 0 {
                    end += 1;
                    let Some(line) = lines.get(end) else {
                        return Some(Hit::new(file, index + 1, NO_END));
                    };
                    depth += line.braces;
                }
                for line in &mut lines[start..=end] {
                    line.code.clear();
                }
                index = end;
            }
            index += 1;
        }
        None
    }

    fn has_word(line: &str, word: &str) -> bool {
        line.match_indices(word).any(|(at, _)| {
            let before = line[..at].chars().next_back();
            let after = line[at + word.len()..].chars().next();
            !before.is_some_and(word_char) && !after.is_some_and(word_char)
        })
    }

    fn names_a_home(line: &Line) -> bool {
        HOME_WORDS.iter().any(|word| has_word(&line.code, word))
    }

    /// Where each shape starts on the line, but as the start of `.harness-<name>`.
    fn whole<'a>(line: &'a str, shapes: &'a [&str]) -> impl Iterator<Item = (usize, &'a str)> {
        shapes.iter().flat_map(move |shape| {
            line.match_indices(shape).filter(move |(at, _)| {
                let after = &line[at + shape.len()..];
                !after.starts_with(|c: char| word_char(c) || c == '-')
            })
        })
    }

    /// Each hand-built home `.harness` path in one source.
    fn hits(file: &str, text: &str) -> Vec<Hit> {
        let mut lines = code_lines(text, file.ends_with(".sh"));
        let mut found: Vec<Hit> = blank_test_modules(file, &mut lines).into_iter().collect();
        for (index, line) in lines.iter().enumerate() {
            let code = line.code.as_str();
            let near = &lines[index.saturating_sub(2)..=index];
            let homed = near.iter().any(names_a_home);
            let mut texts: Vec<&str> = whole(code, &INLINE).map(|(_, shape)| shape).collect();
            if homed {
                // A string that starts with `.harness` and goes on as a path: `".harness"`, `".harness/…"`.
                for (at, quote) in code.match_indices("\".harness") {
                    let rest = &code[at + quote.len()..];
                    let close = rest.find('"').map_or(rest.len(), |close| close + 1);
                    if rest.starts_with(['"', '/', '\\']) {
                        texts.push(&code[at..at + quote.len() + close]);
                    }
                }
                for (at, shape) in whole(code, &PLACED) {
                    let open = code[..at].rfind('{').unwrap_or(at);
                    texts.push(&code[open..at + shape.len()]);
                }
            }
            for text in texts {
                found.push(Hit::new(file, index + 1, text));
            }
        }
        found
    }

    /// Whether the guard reads a file, by its name relative to src: every Rust and shell source but this one.
    fn scanned(name: &str) -> bool {
        name != "harness_home.rs" && (name.ends_with(".rs") || name.ends_with(".sh"))
    }

    /// Every hit in src.
    fn scan_src() -> Vec<Hit> {
        fn walk(folder: &Path, src: &Path, found: &mut Vec<Hit>) {
            let entries = std::fs::read_dir(folder).unwrap();
            let mut paths: Vec<PathBuf> = entries.map(|entry| entry.unwrap().path()).collect();
            paths.sort();
            for path in paths {
                let name = path.strip_prefix(src).unwrap().to_string_lossy();
                let name = name.replace('\\', "/");
                if path.is_dir() {
                    walk(&path, src, found);
                } else if scanned(&name) {
                    found.extend(hits(&name, &std::fs::read_to_string(&path).unwrap()));
                }
            }
        }
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found = Vec::new();
        walk(&src, &src, &mut found);
        found
    }

    fn excuses(entry: &(&str, &str, &str), hit: &Hit) -> bool {
        hit.file == entry.0 && hit.text == entry.1
    }

    /// What fails the guard: each hit no entry excuses, and each entry that excuses other than one hit.
    fn unexcused(found: &[Hit], allowed: &[(&str, &str, &str)]) -> Vec<String> {
        let mut left = Vec::new();
        for hit in found {
            if !allowed.iter().any(|entry| excuses(entry, hit)) {
                left.push(hit.to_string());
            }
        }
        for entry in allowed {
            let (file, text, why) = entry;
            let count = found.iter().filter(|hit| excuses(entry, hit)).count();
            if count != 1 {
                left.push(format!("{file}: {text} ({why}) excuses {count} hits"));
            }
        }
        left
    }

    #[test]
    fn the_guard_finds_each_shape_in_a_planted_line() {
        let joined = [
            r#"let root = PathBuf::from(home).join(".harness");"#,
            r#"let root = std::env::home_dir().unwrap().join(".harness");"#,
            r#"let root = paths.home_dir()?.join(".harness");"#,
            r#"let pair = ("harness://open", home.join(".harness"));"#,
            r#"let q = '"'; let url = "https://x"; let root = home.join(".harness");"#,
        ];
        for text in joined {
            let found = hits("a.rs", text);
            assert_eq!(found, [Hit::new("a.rs", 1, r#"".harness""#)], "{text}");
        }
        let planted = [
            r#"let cli = profile.join(".harness/cli");"#,
            r#"let bin = PathBuf::from(var_os("USERPROFILE")?).join(".harness\\bin");"#,
            r#"let script = "$HOME/.harness/bin";"#,
            r#"let tilde = "~/.harness";"#,
            r#"let windows = r"%USERPROFILE%\.harness";"#,
            r#"let bin = "%USERPROFILE%\\.harness\\bin";"#,
            r#"let text = format!("{home}/.harness/cli");"#,
            r#"let cli = format!("{}/.harness/cli", home.display());"#,
            r#"let cli = format!("{}\\.harness", profile.display());"#,
        ];
        let matched = [
            r#"".harness/cli""#,
            r#"".harness\\bin""#,
            "$HOME/.harness",
            "~/.harness",
            r"%USERPROFILE%\.harness",
            r"%USERPROFILE%\\.harness",
            "{home}/.harness",
            "{}/.harness",
            r"{}\\.harness",
        ];
        for (text, matched) in planted.into_iter().zip(matched) {
            assert_eq!(hits("a.rs", text), [Hit::new("a.rs", 1, matched)], "{text}");
        }
        let shell = hits("a.sh", r#"dir="${HOME}/.harness/tui" # ~/.harness"#);
        assert_eq!(shell, [Hit::new("a.sh", 1, "{HOME}/.harness")]);
    }

    #[test]
    fn the_guard_reads_the_lines_around_and_after_a_test_module() {
        let near = [
            r#"let base = var_os("HOME")?;"#,
            "let base = PathBuf::from(base);",
            r#"let root = base.join(".harness");"#,
        ];
        let found = hits("a.rs", &near.join("\n"));
        assert_eq!(found, [Hit::new("a.rs", 3, r#"".harness""#)]);
        // Braces in a char and a raw string do not end the module early.
        let after = [
            "#[cfg(test)]",
            "mod t {",
            "    const C: char = '{';",
            r#"    const S: &str = r"{";"#,
            "}",
            r#"let root = home.join(".harness");"#,
        ];
        let found = hits("a.rs", &after.join("\n"));
        assert_eq!(found, [Hit::new("a.rs", 6, r#"".harness""#)]);
        // A test module that never ends fails, and the lines after it are read.
        let open = "#[cfg(test)]\nmod t {\n    fn f() {}\nlet root = home.join(\".harness\");";
        let found = hits("a.rs", open);
        let root = Hit::new("a.rs", 4, r#"".harness""#);
        assert_eq!(found, [Hit::new("a.rs", 2, NO_END), root]);
    }

    #[test]
    fn the_guard_ignores_comments_test_modules_a_projects_folder_and_harness_names() {
        let ignored = [
            r#"// let root = home.join(".harness");"#,
            r#"/// `~/.harness` holds the CLI."#,
            r#"let open = "harness://open"; // home.join(".harness")"#,
            "#[cfg(test)]\nmod tests {\n    fn root() {\n        home.join(\".harness\");\n    }\n}",
            "#[cfg(test)]\nmod testing;",
            "#[cfg(all(test, unix))]\n#[allow(dead_code)]\nmod t {\n    const R: &str = \"~/.harness\";\n}",
            "#[cfg(test)]\n// why\npub(crate) mod t {\n    const C: char = '}';\n    const R: &str = \"~/.harness\";\n}",
            r#"let handoff = project.join(format!(".harness/handoff/{}", id));"#,
            r#"let handoff = format!("{root}/.harness/handoff");"#,
            r#"let lock = home.join(".harness-lock");"#,
            r#"let lock = "~/.harness-lock";"#,
            r#"let tmux = format!("{}/.harness-tmux", home.display());"#,
        ];
        for text in ignored {
            assert_eq!(hits("a.rs", text), Vec::<Hit>::new(), "{text}");
        }
        let shell = "# see $HOME/.harness\necho hi  # ~/.harness\necho '#' \"a # b\"";
        assert_eq!(hits("a.sh", shell), Vec::<Hit>::new());
    }

    #[test]
    fn the_guard_reads_every_source_but_this_one() {
        assert!(scanned("a.rs") && scanned("x/a.sh") && scanned("x/harness_home.rs"));
        assert!(!scanned("harness_home.rs") && !scanned("a.md"));
    }

    #[test]
    fn an_allowlist_entry_excuses_exactly_one_hit() {
        let entry = [("a.rs", r#"".harness""#, "why")];
        let root = || Hit::new("a.rs", 1, r#"".harness""#);
        assert_eq!(unexcused(&[root()], &entry), Vec::<String>::new());
        assert_eq!(unexcused(&[root()], &[]), [r#"a.rs:1: ".harness""#]);
        let twice = unexcused(&[root(), Hit::new("a.rs", 2, r#"".harness""#)], &entry);
        assert_eq!(twice, [r#"a.rs: ".harness" (why) excuses 2 hits"#]);
        let none = unexcused(&[], &entry);
        assert_eq!(none, [r#"a.rs: ".harness" (why) excuses 0 hits"#]);
    }

    #[test]
    fn src_holds_none_but_the_allowlisted() {
        let left = unexcused(&scan_src(), ALLOWED);
        let left = left.join("\n");
        assert!(left.is_empty(), "build these through harness_home:\n{left}");
    }
}
