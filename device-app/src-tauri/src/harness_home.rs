//! Harness's folders under the person's home, built in one place. The CLI's `config/harnessHome.ts` holds the whole
//! table; this crate declares only the entries it uses. A test below fails on a home `.harness` path built elsewhere.

use std::path::{Path, PathBuf};

const HARNESS_DIR: &str = ".harness";

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

/// Both roots are `<home>/.harness` today.
pub fn harness_root(home: &Path, root: Root) -> PathBuf {
    match root {
        Root::Data | Root::State => home.join(HARNESS_DIR),
    }
}

/// `<home>/.harness/<entry>`.
pub fn harness_path(home: &Path, entry: Entry) -> PathBuf {
    harness_root(home, entry.root()).join(entry.name())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A home word: the guard reads `.harness` joined near one as a hand-built home path.
    const HOME_WORDS: [&str; 4] = ["HOME", "USERPROFILE", "home", "profile"];
    /// The paths written out whole. Source text doubles the backslash in a plain string, not in a raw one.
    const INLINE: [&str; 5] =
        ["$HOME/.harness", "~/.harness", "%USERPROFILE%\\.harness", "%USERPROFILE%\\\\.harness", "{home}/.harness"];

    /// Each hand-built home `.harness` path in one source file, as `<file>:<line>: <matched text>`.
    fn hits(file: &str, text: &str) -> Vec<String> {
        let shell = file.ends_with(".sh");
        let lines: Vec<&str> = without_test_modules(text).into_iter().map(|line| code(line, shell)).collect();
        let mut found = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            let homed = lines[index.saturating_sub(2)..=index]
                .iter()
                .any(|near| HOME_WORDS.iter().any(|word| has_word(near, word)));
            let joined = joins(line).filter(|_| homed);
            found.extend(joined.chain(inline(line)).map(|matched| format!("{file}:{}: {matched}", index + 1)));
        }
        found
    }

    /// The lines, with each `#[cfg(test)]` module blanked so the line numbers stay. A module ends at the first `}` with
    /// its own indent: the sources are rustfmt's, and a brace count would misread raw strings.
    fn without_test_modules(text: &str) -> Vec<&str> {
        let mut lines: Vec<&str> = text.lines().collect();
        let mut index = 0;
        while index < lines.len() {
            if lines[index].trim() != "#[cfg(test)]" {
                index += 1;
                continue;
            }
            let mut end = index + 1;
            while lines.get(end).is_some_and(|line| line.trim_start().starts_with("#[")) {
                end += 1;
            }
            let Some(item) = lines.get(end) else { break };
            if !item.trim_start().trim_start_matches("pub ").starts_with("mod ") {
                index += 1;
                continue;
            }
            if !item.trim_end().ends_with(';') {
                let close = format!("{}}}", &item[..item.len() - item.trim_start().len()]);
                while lines.get(end).is_some_and(|line| line.trim_end() != close) {
                    end += 1;
                }
            }
            let end = end.min(lines.len() - 1);
            lines[index..=end].fill("");
            index = end + 1;
        }
        lines
    }

    /// The line without its comment: `//` outside a string, or `#` starting a word in a shell script.
    fn code(line: &str, shell: bool) -> &str {
        if shell {
            let start = line
                .char_indices()
                .find(|&(at, c)| c == '#' && line[..at].chars().next_back().is_none_or(char::is_whitespace));
            return start.map_or(line, |(at, _)| &line[..at]);
        }
        let (mut quoted, mut escaped) = (false, false);
        for (at, c) in line.char_indices() {
            if escaped {
                escaped = false;
            } else if quoted && c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = !quoted;
            } else if !quoted && line[at..].starts_with("//") {
                return &line[..at];
            }
        }
        line
    }

    fn has_word(line: &str, word: &str) -> bool {
        line.match_indices(word).any(|(at, _)| {
            let before = line[..at].chars().next_back();
            let after = line[at + word.len()..].chars().next();
            !before.is_some_and(identifier) && !after.is_some_and(identifier)
        })
    }

    fn identifier(c: char) -> bool {
        c.is_alphanumeric() || c == '_'
    }

    /// Each string that starts with `.harness` and goes on as a path: `".harness"`, `".harness/…"`, `".harness\…"`.
    fn joins(line: &str) -> impl Iterator<Item = &str> {
        line.match_indices("\".harness").filter_map(move |(at, quote)| {
            let rest = &line[at + quote.len()..];
            let close = rest.find('"').map_or(rest.len(), |close| close + 1);
            rest.starts_with(['"', '/', '\\']).then(|| &line[at..at + quote.len() + close])
        })
    }

    /// Each whole path, but `.harness-<name>`.
    fn inline(line: &str) -> impl Iterator<Item = &str> {
        INLINE.into_iter().flat_map(move |shape| {
            line.match_indices(shape)
                .filter(move |(at, _)| !line[at + shape.len()..].starts_with(|c: char| identifier(c) || c == '-'))
                .map(|(_, matched)| matched)
        })
    }

    fn sources(folder: &Path, found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, found);
            } else if path.extension().is_some_and(|ext| ext == "rs" || ext == "sh") {
                found.push(path);
            }
        }
    }

    #[test]
    fn every_entry_is_under_the_homes_harness() {
        let home = Path::new("/h");
        assert_eq!(harness_path(home, Entry::Cli), PathBuf::from("/h").join(".harness").join("cli"));
        assert_eq!(harness_path(home, Entry::Runtime), PathBuf::from("/h").join(".harness").join("runtime"));
        assert_eq!((Entry::Cli.root(), Entry::Runtime.root()), (Root::Data, Root::State));
    }

    #[test]
    fn both_roots_are_one_folder() {
        let home = Path::new("/h");
        assert_eq!(harness_root(home, Root::Data), PathBuf::from("/h").join(".harness"));
        assert_eq!(harness_root(home, Root::State), PathBuf::from("/h").join(".harness"));
    }

    #[test]
    fn the_guard_finds_each_shape_in_a_planted_line() {
        let planted = r#"let dir = home.join(".harness");
let base = PathBuf::from(var("HOME").unwrap_or_default())
    .join("x")
    .join(".harness/shell-requests");
let root = profile.join(".harness\\cli");
let a = "$HOME/.harness/cli";
let b = "~/.harness";
let c = "%USERPROFILE%\\.harness";
let d = format!("{home}/.harness/cli");"#;
        assert_eq!(
            hits("planted.rs", planted),
            [
                r#"planted.rs:1: ".harness""#,
                r#"planted.rs:4: ".harness/shell-requests""#,
                r#"planted.rs:5: ".harness\\cli""#,
                "planted.rs:6: $HOME/.harness",
                "planted.rs:7: ~/.harness",
                r"planted.rs:8: %USERPROFILE%\\.harness",
                "planted.rs:9: {home}/.harness",
            ]
        );
        assert_eq!(hits("planted.sh", r#"dir="$HOME/.harness/tui""#), ["planted.sh:1: $HOME/.harness"]);
    }

    #[test]
    fn the_guard_ignores_comments_test_modules_a_projects_folder_and_harness_names() {
        let ignored = [
            r#"// let dir = home.join(".harness");"#,
            r#"/// `~/.harness` holds the CLI."#,
            r#"let url = "https://x"; // home.join(".harness")"#,
            "#[cfg(test)]\nmod tests {\n    fn f() {\n        home.join(\".harness\");\n    }\n}",
            "#[cfg(test)]\nmod testing;",
            r#"let handoff = project.join(format!(".harness/handoff/{}", id));"#,
            r#"let lock = home.join(".harness-lock");"#,
            r#"let lock = "~/.harness-lock";"#,
        ];
        for text in ignored {
            assert_eq!(hits("ignored.rs", text), Vec::<String>::new(), "{text}");
        }
        assert_eq!(hits("ignored.sh", "# see $HOME/.harness"), Vec::<String>::new());
    }

    #[test]
    fn src_holds_none() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&src, &mut files);
        files.sort();
        let found: Vec<String> = files
            .iter()
            .filter(|file| **file != src.join("harness_home.rs"))
            .flat_map(|file| {
                let name = file.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
                hits(&name, &fs::read_to_string(file).unwrap())
            })
            .collect();
        assert_eq!(found, Vec::<String>::new(), "build these through harness_path");
    }
}
