//! Harness's folders under the person's home, built in one place. The CLI's `config/harnessHome.ts` holds the whole
//! table; this crate declares only the entries it uses. A test below fails on a home `.harness` path built elsewhere.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

const HARNESS_DIR: &str = ".harness";
/// Each root's name under its XDG base on Linux.
const XDG_DIR: &str = "harness";

/// What the person made or set (data), and what can be built again (state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Root {
    Data,
    State,
}

/// What the app builds through the helper: the installed CLI (data) and its node runtime (state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    Cli,
    Runtime,
}

impl Entry {
    pub fn name(self) -> &'static str {
        match self {
            Entry::Cli => "cli",
            Entry::Runtime => "runtime",
        }
    }

    pub fn root(self) -> Root {
        match self {
            Entry::Cli => Root::Data,
            Entry::Runtime => Root::State,
        }
    }
}

/// What the rule reads: whether it runs (Linux), the environment, and whether a folder is there.
pub struct Look<'a> {
    pub linux: bool,
    pub env: &'a dyn Fn(&str) -> Option<OsString>,
    pub exists: &'a dyn Fn(&Path) -> bool,
}

/// Both roots, from one look: two entries a caller pairs never come from two layouts, even while Harness's folder
/// moves.
pub struct Roots {
    data: PathBuf,
    state: PathBuf,
}

impl Roots {
    pub fn root(&self, root: Root) -> &Path {
        match root {
            Root::Data => &self.data,
            Root::State => &self.state,
        }
    }

    /// The entry's folder under its root.
    pub fn path(&self, entry: Entry) -> PathBuf {
        self.root(entry.root()).join(entry.name())
    }
}

/// On Linux: the XDG roots once the data root exists, else `<home>/.harness` while that exists (not moved yet), else
/// the XDG roots. The data root alone decides, so the bridge left at `~/.harness` never flips a moved machine back.
/// Elsewhere both roots are `<home>/.harness`. A caller looks again at each lookup, so a move during the app's life is
/// followed.
pub fn harness_roots_with(home: &Path, look: &Look) -> Roots {
    let legacy = home.join(HARNESS_DIR);
    if !look.linux {
        return Roots { data: legacy.clone(), state: legacy };
    }
    let data = xdg_root(home, "XDG_DATA_HOME", "share", look);
    if !(look.exists)(&data) && (look.exists)(&legacy) {
        return Roots { data: legacy.clone(), state: legacy };
    }
    Roots { data, state: xdg_root(home, "XDG_STATE_HOME", "state", look) }
}

/// `$<var>/harness` when the variable is an absolute path, else `<home>/.local/<fallback>/harness`.
fn xdg_root(home: &Path, var: &str, fallback: &str, look: &Look) -> PathBuf {
    let base = (look.env)(var).map(PathBuf::from).filter(|base| base.is_absolute());
    base.unwrap_or_else(|| home.join(".local").join(fallback)).join(XDG_DIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/h";

    fn path(parts: &[&str]) -> PathBuf {
        parts.iter().fold(PathBuf::from(HOME), |path, part| path.join(part))
    }

    /// Both roots on Linux, with these variables set and these folders there.
    fn roots(vars: &[(&str, &str)], there: &[PathBuf]) -> (PathBuf, PathBuf) {
        let env = |name: &str| vars.iter().find(|(key, _)| *key == name).map(|(_, value)| OsString::from(value));
        let exists = |path: &Path| there.iter().any(|folder| folder == path);
        let look = Look { linux: true, env: &env, exists: &exists };
        let roots = harness_roots_with(Path::new(HOME), &look);
        (roots.root(Root::Data).to_path_buf(), roots.root(Root::State).to_path_buf())
    }

    fn xdg() -> (PathBuf, PathBuf) {
        (path(&[".local", "share", "harness"]), path(&[".local", "state", "harness"]))
    }

    #[test]
    fn fresh_linux_is_xdg() {
        assert_eq!(roots(&[], &[]), xdg());
    }

    #[test]
    fn legacy_linux_is_dot_harness() {
        let legacy = path(&[".harness"]);
        assert_eq!(roots(&[], &[path(&[".harness"])]), (legacy.clone(), legacy));
    }

    #[test]
    fn the_data_root_wins_over_a_bridge() {
        assert_eq!(roots(&[], &[path(&[".harness"]), xdg().0]), xdg());
    }

    #[test]
    fn an_unset_empty_or_relative_variable_is_ignored() {
        let empty = [("XDG_DATA_HOME", ""), ("XDG_STATE_HOME", "")];
        let relative = [("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state")];
        assert_eq!(roots(&empty, &[]), xdg());
        assert_eq!(roots(&relative, &[]), xdg());
    }

    #[test]
    fn a_custom_absolute_variable_is_used() {
        let vars = [("XDG_DATA_HOME", "/d"), ("XDG_STATE_HOME", "/s")];
        let custom = (PathBuf::from("/d").join("harness"), PathBuf::from("/s").join("harness"));
        assert_eq!(roots(&vars, &[]), custom);
        // The custom data root, not the default one, is what wins over a `~/.harness`.
        assert_eq!(roots(&vars, &[path(&[".harness"]), custom.0.clone()]), custom);
        let legacy = path(&[".harness"]);
        assert_eq!(roots(&vars, &[legacy.clone(), xdg().0]), (legacy.clone(), legacy));
    }

    #[test]
    fn a_variable_with_a_trailing_slash_names_the_same_folder() {
        // As text: a PathBuf compares by its parts, so it would let `/d//harness` pass.
        let (data, state) = roots(&[("XDG_DATA_HOME", "/d/"), ("XDG_STATE_HOME", "/s/")], &[]);
        assert_eq!((data.to_str().unwrap(), state.to_str().unwrap()), ("/d/harness", "/s/harness"));
    }

    #[test]
    fn off_linux_the_rule_is_not_run() {
        let env = |_: &str| -> Option<OsString> { panic!("read the environment") };
        let exists = |_: &Path| -> bool { panic!("looked for a folder") };
        let look = Look { linux: false, env: &env, exists: &exists };
        let roots = harness_roots_with(Path::new(HOME), &look);
        let legacy = path(&[".harness"]);
        assert_eq!(roots.root(Root::Data), legacy);
        assert_eq!(roots.root(Root::State), legacy);
        assert_eq!(roots.path(Entry::Cli), legacy.join("cli"));
        assert_eq!(roots.path(Entry::Runtime), legacy.join("runtime"));
    }

    #[test]
    fn the_cli_is_in_data_and_the_runtime_in_state() {
        let env = |_: &str| None;
        let exists = |_: &Path| false;
        let look = Look { linux: true, env: &env, exists: &exists };
        let roots = harness_roots_with(Path::new(HOME), &look);
        let (data, state) = xdg();
        assert_eq!(roots.path(Entry::Cli), data.join("cli"));
        assert_eq!(roots.path(Entry::Runtime), state.join("runtime"));
    }

    /// A hit the guard keeps on purpose: its file, the text it matched, and why. Each excuses exactly one hit.
    const ALLOWED: &[(&str, &str, &str)] = &[];

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
