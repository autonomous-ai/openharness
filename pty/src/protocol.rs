use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read, Write};

/// The wire protocol this host speaks, fixed at build time. Each (protocol, version) is its own
/// instance (`p<PROTOCOL>-<tag>`, `instance.rs`: its discovery file, endpoint, lock and pane ids), so a
/// host of another build starts beside a running one and the old one drains: the daemon lists, streams and controls its
/// panes, makes new ones on the new host, and shuts the old one down once it has none
/// (cli/src/lib/ptyHost/drain.ts).
///
/// - 2: the `shutdown` op.
/// - 1: the first.
pub const PROTOCOL: u32 = 2;

/// Optional protocol-2 abilities this host has, told in the hello reply and the `version` line. A host built
/// before the list sends none, which a client reads as none: protocol 2 itself never changes for these.
pub const FEATURES: &[&str] = &["seed"];
pub const MAX_FRAME: u32 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Subscribe = 1,
    Input = 2,
    Paste = 3,
    Resize = 4,
    Snapshot = 5,
    Pause = 6,
    Resume = 7,
    Output = 16,
    SnapshotReply = 17,
    Closed = 18,
    Ack = 19,
}

impl Kind {
    pub fn from_u8(v: u8) -> Option<Kind> {
        use Kind::*;
        Some(match v {
            1 => Subscribe,
            2 => Input,
            3 => Paste,
            4 => Resize,
            5 => Snapshot,
            6 => Pause,
            7 => Resume,
            16 => Output,
            17 => SnapshotReply,
            18 => Closed,
            19 => Ack,
            _ => return None,
        })
    }
}

pub fn write_frame(w: &mut impl Write, kind: Kind, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME as usize {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large"));
    }
    let mut head = [0u8; 5];
    head[0] = kind as u8;
    head[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    w.write_all(&head)?;
    w.write_all(payload)
}

/// `Ok(None)` at a clean end of stream (no bytes of a next frame). A stream
/// that ends inside a header or payload is an `UnexpectedEof` error.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<(Kind, Vec<u8>)>> {
    let mut head = [0u8; 5];
    let mut got = 0;
    while got < head.len() {
        match r.read(&mut head[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let kind = Kind::from_u8(head[0])
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "unknown frame kind"))?;
    let len = u32::from_be_bytes(head[1..].try_into().unwrap());
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)?;
    Ok(Some((kind, payload)))
}

/// A client's hello. It never carries the token: whatever listens on the endpoint reads it, and
/// that may be a process squatting on the name. Each side proves the token instead, over the
/// client's fresh `nonce`: the client with `auth` (`hello_auth`), the host with its reply's
/// `proof` (`hello_proof`). The two use different separators, so a host's proof sent back as
/// an `auth` proves nothing.
#[derive(Debug, Deserialize)]
pub struct Hello {
    /// `hello_auth(token, nonce)`.
    pub auth: String,
    /// 32 random bytes as 64 hex digits.
    pub nonce: String,
    pub protocol: u32,
    pub role: Role,
    #[serde(rename = "clientId")]
    pub client_id: String,
}

/// hex SHA-256 of the token's bytes, the separator byte, and the nonce's (hex) characters.
fn token_digest(token: &str, separator: u8, nonce: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(token.as_bytes());
    hash.update([separator]);
    hash.update(nonce.as_bytes());
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The client's `auth` for its `nonce`: SHA-256(token || 0x01 || nonce), as hex.
pub fn hello_auth(token: &str, nonce: &str) -> String {
    token_digest(token, 1, nonce)
}

/// The host's reply `proof` for a client's `nonce`: SHA-256(token || 0x00 || nonce), as hex.
pub fn hello_proof(token: &str, nonce: &str) -> String {
    token_digest(token, 0, nonce)
}

/// Whether `nonce` is what a client must send: 64 hex digits.
pub fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == 64 && nonce.bytes().all(|b| b.is_ascii_hexdigit())
}
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Control,
    Stream,
}
#[derive(Debug, Deserialize)]
pub struct HelloLine {
    pub hello: Hello,
}

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub op: Op,
}

/// What a pane runs once its child exits by itself (`create`'s and `respawn`'s `afterExit`): the hand-off a
/// Unix launch script makes in the pane (cli/src/lib/engineLaunch.ts `harness_after`), which on Windows has no
/// script to make it. The host records the child's status as the pane's `engineExit`, then starts `command` in
/// the same pane and grid, with the pane's environment, `env`, and `HARNESS_ENGINE_EXIT=<status>`.
#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
pub struct AfterExit {
    pub command: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    Create {
        command: Vec<String>,
        cwd: Option<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
        owner: String,
        label: Option<String>,
        hold: bool,
        #[serde(rename = "afterExit", default)]
        after_exit: Option<AfterExit>,
        /// Names this child, and the `afterExit` shell it hands the pane to, do not get from the
        /// host's own environment (case-insensitive on Windows): a grid launch's provider keys, which
        /// a Unix launch script unsets for its own launch. Per launch: the next respawn sends its own.
        /// What `env` sets is still set.
        #[serde(rename = "clearInherited", default)]
        clear_inherited: Vec<String>,
        /// Another pane's scrollback (`capture`/`history` style: SGR-only ANSI, lines separated by `\n` or
        /// `\r\n`; one break at the very end is not a row) that the new pane starts with, wholly in its history
        /// above a blank screen. Only a host that lists `seed` in `FEATURES` knows the field; an older one
        /// ignores it and the pane starts with no history, so a client sends `seed` only to a host that lists
        /// the `seed` feature.
        #[serde(default)]
        seed: Option<String>,
    },
    Kill {
        pane: String,
        #[serde(rename = "graceMs", default = "default_grace")]
        grace_ms: u64,
    },
    Inventory,
    Titles,
    PaneState { pane: String },
    PaneInfo { pane: String },
    Capture {
        pane: String,
        #[serde(rename = "historyLines")]
        history_lines: Option<u32>,
        ansi: bool,
        visible: bool,
    },
    Write { pane: String, data: String },
    Paste { pane: String, text: String, bracketed: bool },
    Key { pane: String, key: String },
    SetTitle { pane: String, title: String },
    HoldOpen { pane: String },
    ReleaseHold { pane: String },
    Respawn {
        pane: String,
        command: Vec<String>,
        cwd: Option<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        #[serde(rename = "expectedHeldToken")]
        expected_held_token: Option<String>,
        /// Names taken out of the pane's create-time environment before this child, and for every
        /// later one: tmux's `set-environment -u` on the pane's session ahead of `respawn-pane`.
        /// Never what the host itself inherited (`clearInherited`).
        #[serde(rename = "clearEnv", default)]
        clear_env: Vec<String>,
        /// `create`'s `clearInherited`, for this child and its `afterExit` shell alone, in place of
        /// the last launch's; none when absent.
        #[serde(rename = "clearInherited", default)]
        clear_inherited: Vec<String>,
        /// The new child's hand-off, in place of any the pane had (none when absent).
        #[serde(rename = "afterExit", default)]
        after_exit: Option<AfterExit>,
    },
    JobPids { pane: String },
    Processes,
    SetEngineExit { pane: String, status: i32 },
    /// Protocol 2. The host replies, then exits, but only while it has no pane at all (any
    /// owner's): with panes it answers `bad_request` and stays. From the reply on it makes no
    /// pane, so a create racing the shutdown is refused rather than lost with the host.
    Shutdown,
}
fn default_grace() -> u64 {
    2_000
}

#[derive(Debug, Serialize)]
pub struct Failure<'a> {
    pub id: u64,
    pub ok: bool,
    pub code: &'a str,
    pub reason: String,
}
impl<'a> Failure<'a> {
    pub fn new(id: u64, code: &'a str, reason: impl Into<String>) -> Self {
        Failure { id, ok: false, code, reason: reason.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, Kind::Output, &[0, 0, 0, 0, 0, 0, 0, 7, b'h', b'i']).unwrap();
        let (kind, payload) = read_frame(&mut buf.as_slice()).unwrap().unwrap();
        assert_eq!(kind, Kind::Output);
        assert_eq!(&payload[8..], b"hi");
    }
    #[test]
    fn rejects_oversize_frame() {
        let mut buf = vec![16u8];
        buf.extend_from_slice(&(MAX_FRAME + 1).to_be_bytes());
        assert!(read_frame(&mut buf.as_slice()).is_err());
    }
    #[test]
    fn parses_create_request() {
        let r: Request = serde_json::from_str(r#"{"id":1,"op":"create","command":["sh"],"cols":80,"rows":24,"owner":"o","hold":true}"#).unwrap();
        assert!(matches!(r.op, Op::Create { ref command, cols: 80, rows: 24, hold: true, after_exit: None, .. } if command == &vec!["sh".to_string()]));
        let r: Request = serde_json::from_str(r#"{"id":1,"op":"create","command":["codex"],"cols":80,"rows":24,"owner":"o","hold":true,"afterExit":{"command":["pwsh.exe","-NoLogo"]}}"#).unwrap();
        assert!(matches!(r.op, Op::Create { after_exit: Some(AfterExit { ref command, ref env }), .. }
            if command == &vec!["pwsh.exe".to_string(), "-NoLogo".to_string()] && env.is_empty()));
    }
    #[test]
    fn clean_eof_is_none_and_truncation_is_error() {
        assert!(read_frame(&mut [].as_slice()).unwrap().is_none());
        assert!(read_frame(&mut [16u8, 0].as_slice()).is_err());
        assert!(read_frame(&mut [16u8, 0, 0, 0, 3, 1].as_slice()).is_err());
    }
    #[test]
    fn unknown_kind_is_error() {
        assert!(read_frame(&mut [99u8, 0, 0, 0, 0].as_slice()).is_err());
    }
    #[test]
    fn kind_roundtrips_through_u8() {
        for v in 0..=255u8 {
            if let Some(k) = Kind::from_u8(v) {
                assert_eq!(k as u8, v);
            }
        }
        assert_eq!(Kind::from_u8(16), Some(Kind::Output));
        assert_eq!(Kind::from_u8(8), None);
    }
    #[test]
    fn parses_hello_with_current_protocol() {
        let line = format!(
            r#"{{"hello":{{"auth":"a","nonce":"n","protocol":{PROTOCOL},"role":"stream","clientId":"c"}}}}"#
        );
        let h: HelloLine = serde_json::from_str(&line).unwrap();
        assert_eq!((h.hello.auth.as_str(), h.hello.nonce.as_str()), ("a", "n"));
        // A hello with the token in it and no auth is not one.
        let old = format!(
            r#"{{"hello":{{"token":"t","protocol":{PROTOCOL},"role":"stream","clientId":"c"}}}}"#
        );
        assert!(serde_json::from_str::<HelloLine>(&old).is_err());
        assert_eq!(h.hello.protocol, PROTOCOL);
        assert_eq!(h.hello.role, Role::Stream);
        assert_eq!(h.hello.client_id, "c");
    }
    #[test]
    fn the_hello_auth_and_proof_are_sha256_of_token_separator_nonce() {
        use sha2::{Digest, Sha256};
        let nonce = "ab".repeat(32);
        let hex = |bytes: &[u8]| -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() };
        let proof = hex(&Sha256::digest(format!("tok\0{nonce}").as_bytes()));
        let auth = hex(&Sha256::digest(format!("tok\u{1}{nonce}").as_bytes()));
        assert_eq!(hello_proof("tok", &nonce), proof);
        assert_eq!(hello_auth("tok", &nonce), auth);
        assert_ne!(proof, auth);
        assert_ne!(hello_proof("tok2", &nonce), proof);
        // The vectors protocol.spec.ts checks too.
        assert_eq!(
            proof,
            "b981c336c08b0e9e5d9798d723e2a76ad73ae2162afc266c976d28689a8a4d5d"
        );
        assert_eq!(
            auth,
            "a495f777a3d1a2e8fc2c5db3af651dfa5ea3b5d1813fd62f83934c1571f5628d"
        );
        assert!(valid_nonce(&nonce));
        assert!(!valid_nonce("ab"));
        assert!(!valid_nonce(&"zz".repeat(32)));
    }
    #[test]
    fn kill_defaults_grace() {
        let r: Request = serde_json::from_str(r#"{"id":2,"op":"kill","pane":"%3"}"#).unwrap();
        assert!(matches!(r.op, Op::Kill { grace_ms: 2000, .. }));
        let r: Request = serde_json::from_str(r#"{"id":4,"op":"holdOpen","pane":"%3"}"#).unwrap();
        assert!(matches!(r.op, Op::HoldOpen { ref pane } if pane == "%3"));
    }
    #[test]
    fn parses_every_op() {
        let ops = [
            r#"{"op":"inventory"}"#, r#"{"op":"titles"}"#, r#"{"op":"processes"}"#,
            r#"{"op":"paneState","pane":"%1"}"#, r#"{"op":"paneInfo","pane":"%1"}"#,
            r#"{"op":"capture","pane":"%1","ansi":true,"visible":false,"historyLines":5}"#,
            r#"{"op":"write","pane":"%1","data":"aA=="}"#,
            r#"{"op":"paste","pane":"%1","text":"x","bracketed":true}"#,
            r#"{"op":"key","pane":"%1","key":"C-c"}"#,
            r#"{"op":"setTitle","pane":"%1","title":"t"}"#,
            r#"{"op":"releaseHold","pane":"%1"}"#,
            r#"{"op":"respawn","pane":"%1","command":["sh"],"expectedHeldToken":"u"}"#,
            r#"{"op":"respawn","pane":"%1","command":["sh"],"afterExit":{"command":["pwsh.exe"],"env":{"A":"b"}}}"#,
            r#"{"op":"jobPids","pane":"%1"}"#,
            r#"{"op":"setEngineExit","pane":"%1","status":-1}"#,
            r#"{"op":"shutdown"}"#,
        ];
        for (i, o) in ops.iter().enumerate() {
            let json = format!(r#"{{"id":{i},{}"#, &o[1..]);
            serde_json::from_str::<Request>(&json).unwrap_or_else(|e| panic!("{json}: {e}"));
        }
    }
    #[test]
    fn failure_serializes_as_wire_shape() {
        let v = serde_json::to_value(Failure::new(9, "no_pane", "gone")).unwrap();
        assert_eq!(v, serde_json::json!({"id":9,"ok":false,"code":"no_pane","reason":"gone"}));
    }
}
