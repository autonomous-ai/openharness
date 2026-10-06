//! The desktop's observed model label contract. Metadata is scoped to an agent and engine;
//! absent or stale metadata must not invent a model or an effort.
use std::sync::OnceLock;
use regex::Regex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Details { pub name: String, pub effort: String }

fn decode(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.bytes();
    while let Some(b) = input.next() {
        bytes.push(if b == b'%' {
            let high = (input.next()? as char).to_digit(16)?;
            let low = (input.next()? as char).to_digit(16)?;
            (high * 16 + low) as u8
        } else { b });
    }
    String::from_utf8(bytes).ok()
}

fn title(value: &str) -> String {
    let mut chars = value.chars();
    chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

pub fn details(value: &str, agent: &str, engine: &str) -> Option<Details> {
    if value.encode_utf16().count() > 1024 { return None }
    static WIRE: OnceLock<Regex> = OnceLock::new();
    static CLAUDE: OnceLock<Regex> = OnceLock::new();
    static GPT: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    let found = WIRE.get_or_init(|| Regex::new(r"(?i)^runtime-v1:([^:]+):([a-z0-9_-]+):([^@]+)@([a-z0-9_-]+)$").unwrap()).captures(value)?;
    if !found[2].eq_ignore_ascii_case(engine) || decode(&found[1])? != agent { return None }
    let mut name = decode(&found[3])?.trim().to_string();
    if engine.eq_ignore_ascii_case("opencode") {
        if let Some(path) = PATH.get_or_init(|| Regex::new(r" {3,}(?:/|~/|[A-Za-z]:[\\/])").unwrap()).find(&name) {
            name.truncate(path.start());
        }
    }
    if name.is_empty() || name == "<synthetic>" || name.encode_utf16().count() > 256 || name.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') { return None }
    if let Some(c) = CLAUDE.get_or_init(|| Regex::new(r"(?i)^(?:claude-)?(fable|opus|sonnet|haiku)(?:-(\d+(?:[-.]\d{1,2})*))?(\[1m\])?$").unwrap()).captures(&name) {
        name = format!("{}{}{}", title(&c[1].to_lowercase()), c.get(2).map(|v| format!(" {}", v.as_str().replace('-', "."))).unwrap_or_default(), c.get(3).map(|s| s.as_str()).unwrap_or(""));
    } else if let Some(c) = GPT.get_or_init(|| Regex::new(r"(?i)^gpt-(\d+(?:\.\d+)*)(?:-(astra|sol|terra|luna|codex))?$").unwrap()).captures(&name) {
        name = format!("GPT-{}{}", &c[1], c.get(2).map(|s| format!(" {}", title(&s.as_str().to_lowercase()))).unwrap_or_default());
    }
    Some(Details { name, effort: found[4].to_lowercase() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_desktop_and_never_infer_versions() {
        for (engine, raw, want) in [
            ("codex", "gpt-6-astra", "GPT-6 Astra"), ("codex", "gpt-5.6-sol", "GPT-5.6 Sol"), ("codex", "gpt-5.6", "GPT-5.6"),
            ("claude", "fable", "Fable"), ("claude", "opus", "Opus"), ("claude", "claude-opus-5", "Opus 5"),
            ("claude", "claude-sonnet-4-6%5B1m%5D", "Sonnet 4.6[1m]"),
            ("claude", "claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"), ("opencode", "provider%2FModel-Next", "provider/Model-Next"),
        ] {
            let parsed = details(&format!("runtime-v1:a%3A1:{engine}:{raw}@HIGH"), "a:1", engine).unwrap();
            assert_eq!(parsed, Details { name: want.into(), effort: "high".into() });
        }
        assert_eq!(details("runtime-v1:a:opencode:Model%20%20%20%20%2Fprivate%2Fwork@auto", "a", "opencode").unwrap().name, "Model");
        assert_eq!(details("runtime-v1:a:opencode:Model%20%20%20C%3A%5Cwork@auto", "a", "opencode").unwrap().name, "Model");
        assert_eq!(details("runtime-v1:a:opencode:provider%2FModel+Next@auto", "a", "opencode").unwrap().name, "provider/Model+Next");
    }

    #[test]
    fn malformed_or_foreign_metadata_has_no_label() {
        for value in ["", "gpt-6-astra", "runtime-v2:a:codex:gpt-6-astra@high", "runtime-v1:a:claude:opus@high", "runtime-v1:other:codex:model@high",
            "runtime-v1:%ZZ:codex:model@high", "runtime-v1:a:codex:%ZZ@high", "runtime-v1:a:codex:%FF@high", "runtime-v1:a:codex:%C0%80@high",
            "runtime-v1:a:codex:%20@high", "runtime-v1:a:codex:%3Csynthetic%3E@high", "runtime-v1:a:codex:model%0Aname@high"] {
            assert!(details(value, "a", "codex").is_none(), "{value}");
        }
        for raw in ["x".repeat(257), "x".repeat(1025)] { assert!(details(&format!("runtime-v1:a:codex:{raw}@high"), "a", "codex").is_none()); }
    }
}
