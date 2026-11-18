//! Where Harness keeps the account's files: `<home>/.harness`. It has two roots, data (what the person installed or
//! made) and state (what Harness can rebuild), which are one folder today. The CLI's and Desktop's modules name what
//! goes under each; the PTY host needs the roots alone. Every home `.harness` in this crate is built here: the guard
//! in the tests below fails on one built by hand.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const HARNESS_DIR: &str = ".harness";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Root {
    Data,
    State,
}

/// `%USERPROFILE%`, then `HOME` (off Windows, for the tests); none when unset or empty.
pub fn home(env: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    env("USERPROFILE").or_else(|| env("HOME")).filter(|home| !home.is_empty()).map(PathBuf::from)
}

/// Both roots are the home's `.harness` until Harness keeps state apart from data.
pub fn harness_root(home: &Path, root: Root) -> PathBuf {
    match root {
        Root::Data | Root::State => home.join(HARNESS_DIR),
    }
}

/// The distinct roots, the data root first: today one.
pub fn harness_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots = vec![harness_root(home, Root::Data), harness_root(home, Root::State)];
    roots.dedup();
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn the_home_is_the_profile_then_home() {
        let both = |key: &str| match key {
            "USERPROFILE" => Some(OsString::from("P")),
            "HOME" => Some(OsString::from("H")),
            _ => None,
        };
        assert_eq!(home(both), Some(PathBuf::from("P")));
        assert_eq!(home(|key: &str| (key == "HOME").then(|| OsString::from("H"))), Some(PathBuf::from("H")));
        assert_eq!(home(|_| None), None);
        assert_eq!(home(|_| Some(OsString::new())), None);
    }

    #[test]
    fn both_roots_are_the_homes_harness_and_the_roots_are_one() {
        let home = Path::new("P");
        assert_eq!(harness_root(home, Root::Data), PathBuf::from("P").join(".harness"));
        assert_eq!(harness_root(home, Root::State), PathBuf::from("P").join(".harness"));
        assert_eq!(harness_roots(home), vec![PathBuf::from("P").join(".harness")]);
    }

    /// The words that make a `".harness` join a home's: the line or one of the two above names one.
    const HOME_WORDS: [&str; 4] = ["HOME", "USERPROFILE", "home", "profile"];
    /// A home's `.harness` written out in one piece.
    const INLINE: [&str; 4] = ["$HOME/.harness", "~/.harness", r"%USERPROFILE%\.harness", "{home}/.harness"];

    fn word_char(c: char) -> bool {
        c.is_alphanumeric() || c == '_'
    }

    fn has_word(line: &str, word: &str) -> bool {
        line.match_indices(word).any(|(at, _)| {
            !line[..at].chars().next_back().is_some_and(word_char)
                && !line[at + word.len()..].chars().next().is_some_and(word_char)
        })
    }

    /// The line without its `//` comment. A `//` inside a string (`"harness://open"`) is code.
    fn without_comment(line: &str) -> &str {
        let (mut quoted, mut escaped) = (false, false);
        for (at, c) in line.char_indices() {
            match c {
                _ if escaped => escaped = false,
                '\\' if quoted => escaped = true,
                '"' => quoted = !quoted,
                '/' if !quoted && line[at + 1..].starts_with('/') => return &line[..at],
                _ => {}
            }
        }
        line
    }

    /// Each line of a source as the guard reads it: comments and every test module blanked, so line numbers hold.
    fn code_lines(text: &str) -> Vec<&str> {
        let mut code = Vec::new();
        let mut lines = text.lines();
        let mut test_only = false;
        while let Some(line) = lines.next() {
            let trimmed = line.trim_start();
            if test_only && trimmed.starts_with("mod ") && trimmed.ends_with('{') {
                let close = format!("{}}}", &line[..line.len() - trimmed.len()]);
                code.push("");
                for line in lines.by_ref() {
                    code.push("");
                    if line.trim_end() == close {
                        break;
                    }
                }
                test_only = false;
                continue;
            }
            test_only = trimmed.starts_with("#[cfg(test)]")
                || trimmed.starts_with("#[cfg(all(test,")
                || (test_only && trimmed.starts_with("#["));
            code.push(without_comment(line));
        }
        code
    }

    fn joins_a_home(code: &[&str], at: usize) -> bool {
        let line = code[at];
        let joined = line
            .match_indices("\".harness")
            .any(|(i, m)| matches!(line[i + m.len()..].chars().next(), Some('"' | '/' | '\\')));
        joined && code[at.saturating_sub(2)..=at].iter().any(|line| HOME_WORDS.iter().any(|word| has_word(line, word)))
    }

    fn writes_a_home(line: &str) -> bool {
        INLINE.iter().any(|shape| {
            line.match_indices(shape).any(|(at, _)| {
                !line[at + shape.len()..].chars().next().is_some_and(|c| word_char(c) || c == '-')
            })
        })
    }

    /// The line numbers, from 1, where a source builds a home's `.harness` by hand.
    fn hits(text: &str) -> Vec<usize> {
        let code = code_lines(text);
        (0..code.len()).filter(|&at| joins_a_home(&code, at) || writes_a_home(code[at])).map(|at| at + 1).collect()
    }

    fn sources(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, found);
            } else if path.extension().is_some_and(|ext| ext == "rs") && !path.ends_with("harness_home.rs") {
                found.push(path);
            }
        }
    }

    #[test]
    fn the_guard_finds_each_shape_in_a_planted_line() {
        let planted = [
            r#"let root = PathBuf::from(home).join(".harness");"#,
            r#"let cli = profile.join(".harness/cli");"#,
            r#"let bin = PathBuf::from(var_os("USERPROFILE")?).join(".harness\\bin");"#,
            "let base = var_os(\"HOME\")?;\nlet base = PathBuf::from(base);\nlet root = base.join(\".harness\");",
            r#"let pair = ("harness://open", home.join(".harness"));"#,
            r#"let script = "$HOME/.harness/bin";"#,
            r#"let tilde = "~/.harness";"#,
            r#"let windows = r"%USERPROFILE%\.harness";"#,
            r#"let text = format!("{home}/.harness/cli");"#,
            r#"let root = std::env::home_dir().unwrap().join(".harness");"#,
            r#"let root = paths.home_dir()?.join(".harness");"#,
            r#"let bin = "%USERPROFILE%\\.harness\\bin";"#,
            r#"let cli = format!("{}/.harness/cli", home.display());"#,
            r#"let cli = format!("{}\\.harness", profile.display());"#,
            r#"let q = '"'; let url = "https://x"; let root = home.join(".harness");"#,
        ];
        for text in planted {
            assert_eq!(hits(text), vec![text.lines().count()], "{text}");
        }
        // A test module that never ends fails, and the lines after it are read.
        assert_eq!(hits("#[cfg(test)]\nmod t {\n    fn f() {}\nlet root = home.join(\".harness\");"), [2, 4]);
    }

    #[test]
    fn the_guard_reads_a_harness_home_rs_below_src() {
        let dir = std::env::temp_dir().join(format!("harness-home-guard-{}", std::process::id()));
        fs::create_dir_all(dir.join("x")).unwrap();
        fs::write(dir.join("x").join("harness_home.rs"), "").unwrap();
        let mut files = Vec::new();
        sources(&dir, &mut files);
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(files, [dir.join("x").join("harness_home.rs")]);
    }

    #[test]
    fn the_guard_ignores_comments_test_modules_a_projects_folder_and_harness_names() {
        let ignored = [
            r#"// let root = home.join(".harness");"#,
            r#"let open = "harness://open"; // home.join(".harness")"#,
            "#[cfg(test)]\nmod tests {\n    fn root() { home.join(\".harness\"); }\n}",
            "#[cfg(all(test, windows))]\n#[allow(dead_code)]\nmod tests {\n    const ROOT: &str = \"~/.harness\";\n}",
            r#"let handoff = project.join(format!(".harness/handoff/{}", id));"#,
            r#"let lock = home.join(".harness-lock");"#,
            r#"let lock = "~/.harness-lock";"#,
            "#[cfg(test)]\n// why\npub(crate) mod t {\n    const C: char = '}';\n    fn f() { home.join(\".harness\"); }\n}",
        ];
        for text in ignored {
            assert_eq!(hits(text), Vec::<usize>::new(), "{text}");
        }
    }

    #[test]
    fn src_holds_none() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&src, &mut files);
        files.sort();
        let mut found = Vec::new();
        for file in files {
            let text = fs::read_to_string(&file).unwrap();
            let name = file.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
            for line in hits(&text) {
                found.push(format!("{name}:{line}: {}", text.lines().nth(line - 1).unwrap().trim()));
            }
        }
        assert!(found.is_empty(), "build these through crate::harness_home:\n{}", found.join("\n"));
    }
}
