//! tmux's paste buffers (paste.c): automatic ones (a copy, capture-pane) named buffer0,
//! buffer1… in the order they are made and never renamed, and named ones (set-buffer -b,
//! load-buffer -b); all walked newest first; buffer-limit automatic ones at most.

#[derive(Clone, Debug, PartialEq)]
pub struct Buffer {
    pub name: String,
    pub data: String,
    pub automatic: bool,
    /// When it was made or last set: the walk's order (higher is newer).
    pub order: u64,
    /// Seconds since the epoch (#{buffer_created}).
    pub created: i64,
}

#[derive(Default, Clone, Debug)]
pub struct Paste { list: Vec<Buffer>, next_index: u64, next_order: u64 }

fn now() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) }

impl Paste {
    /// paste_walk: every buffer, newest first.
    pub fn walk(&self) -> impl Iterator<Item = &Buffer> {
        let mut v: Vec<&Buffer> = self.list.iter().collect();
        v.sort_by(|a, b| b.order.cmp(&a.order));
        v.into_iter()
    }


    /// paste_get_top: the newest automatic buffer (what paste-buffer pastes without -b).
    pub fn top(&self) -> Option<&Buffer> { self.walk().find(|b| b.automatic) }

    pub fn get(&self, name: &str) -> Option<&Buffer> { if name.is_empty() { None } else { self.list.iter().find(|b| b.name == name) } }

    pub fn free(&mut self, name: &str) { self.list.retain(|b| b.name != name) }

    /// paste_add: a new automatic buffer (nothing for empty text); past buffer-limit, the oldest
    /// automatic ones go.
    pub fn add(&mut self, data: String, limit: usize) {
        if data.is_empty() { return }
        loop {
            let automatic = self.list.iter().filter(|b| b.automatic).count();
            if automatic < limit.max(1) { break }
            let Some(oldest) = self.list.iter().filter(|b| b.automatic).min_by_key(|b| b.order).map(|b| b.name.clone()) else { break };
            self.free(&oldest);
        }
        let name = loop {
            let n = format!("buffer{}", self.next_index);
            self.next_index += 1;
            if self.get(&n).is_none() { break n }
        };
        let order = self.next_order;
        self.next_order += 1;
        self.list.push(Buffer { name, data, automatic: true, order, created: now() });
    }

    /// paste_set: a named buffer set (replacing one of that name), or an automatic one without a
    /// name; empty text changes nothing.
    pub fn set(&mut self, data: String, name: Option<&str>, limit: usize) -> Result<(), String> {
        if data.is_empty() { return Ok(()) }
        let Some(name) = name else { self.add(data, limit); return Ok(()) };
        if name.is_empty() { return Err("empty buffer name".into()) }
        self.free(name);
        let order = self.next_order;
        self.next_order += 1;
        self.list.push(Buffer { name: name.to_string(), data, automatic: false, order, created: now() });
        Ok(())
    }

    /// paste_replace: new data, the buffer otherwise as it was (append-selection).
    pub fn replace(&mut self, name: &str, data: String) { if let Some(b) = self.list.iter_mut().find(|b| b.name == name) { b.data = data } }

    /// paste_rename: a buffer given a new name (one there already is freed); it is named now.
    pub fn rename(&mut self, old: &str, new: &str) -> Result<(), String> {
        if old.is_empty() { return Err("no buffer".into()) }
        if new.is_empty() { return Err("new name is empty".into()) }
        if self.get(old).is_none() { return Err(format!("no buffer {old}")) }
        if old != new { self.free(new) }
        if let Some(b) = self.list.iter_mut().find(|b| b.name == old) { b.name = new.to_string(); b.automatic = false }
        Ok(())
    }
}

/// paste_make_sample: the first 200 characters, escaped as vis(3) does (`\n`, `\t`, octal), with
/// `...` when there is more.
pub fn sample(b: &Buffer) -> String {
    let chars: Vec<char> = b.data.chars().collect();
    let head: String = chars.iter().take(200).collect();
    let mut out = String::new();
    let all: Vec<char> = head.chars().collect();
    for (i, &c) in all.iter().enumerate() {
        match c {
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\\' => out.push_str("\\\\"),
            '\x07' => out.push_str("\\a"),
            '\x08' => out.push_str("\\b"),
            '\x0b' => out.push_str("\\v"),
            '\x0c' => out.push_str("\\f"),
            '\0' => out.push_str(if all.get(i + 1).map(|n| ('0'..='7').contains(n)).unwrap_or(false) { "\\000" } else { "\\0" }),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\{:03o}", c as u32)),
            c => out.push(c),
        }
    }
    if chars.len() > 200 || out.chars().count() > 200 {
        out = out.chars().take(200).collect();
        out.push_str("...");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_order_as_tmux() {
        let mut p = Paste::default();
        p.add("one".into(), 50);
        p.add("two".into(), 50);
        p.set("mine".into(), Some("m"), 50).unwrap();
        let names: Vec<&str> = p.walk().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["m", "buffer1", "buffer0"]);
        assert_eq!(p.top().unwrap().name, "buffer1");
        p.free("buffer1");
        p.add("three".into(), 50);
        assert_eq!(p.top().unwrap().name, "buffer2", "names are never reused");
        p.add("four".into(), 2);
        assert_eq!(p.walk().filter(|b| b.automatic).count(), 2, "buffer-limit");
        assert!(p.get("buffer0").is_none());
        assert_eq!(p.rename("nosuch", "x").unwrap_err(), "no buffer nosuch");
        assert_eq!(sample(&Buffer { name: "b".into(), data: "multi\nline".into(), automatic: true, order: 0, created: 0 }), "multi\\nline");
    }
}
