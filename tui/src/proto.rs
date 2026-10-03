//! The daemon's loopback terminal framing — `HTRL`, the plain twin of the E2EE `HTRM` envelope.
//! Mirrors `cli/src/lib/terminalBinary.ts` (`encodeTerminalLocal` / `decodeTerminalLocal`); keep the
//! two in step.
//!
//! ```text
//! header (12): "HTRL" | version=1 | kind | flags (bit0 = zlib) | 0 | payload length u32 BE
//! payload:     streamId (16 raw uuid bytes) | seq u64 BE | [cols u16 BE | rows u16 BE  — keyframe only] | bytes
//! ```

use uuid::Uuid;

pub const MAGIC: &[u8; 4] = b"HTRL";
pub const VERSION: u8 = 1;
pub const FLAG_ZLIB: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Input = 1,
    Output = 2,
    Keyframe = 3,
    Sync = 4,
    Paste = 5,
}

impl Kind {
    fn from(byte: u8) -> Option<Kind> {
        Some(match byte {
            1 => Kind::Input,
            2 => Kind::Output,
            3 => Kind::Keyframe,
            4 => Kind::Sync,
            5 => Kind::Paste,
            _ => return None,
        })
    }
}

#[derive(Debug)]
pub struct Frame {
    pub kind: Kind,
    pub stream: Uuid,
    pub seq: u64,
    pub bytes: Vec<u8>,
    pub compressed: bool,
    /// The far pane's size, on a keyframe.
    pub size: Option<(u16, u16)>,
}

pub fn encode(kind: Kind, stream: Uuid, seq: u64, bytes: &[u8]) -> Vec<u8> {
    let payload_len = 24 + bytes.len();
    let mut out = Vec::with_capacity(12 + payload_len);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.push(kind as u8);
    out.push(0);
    out.push(0);
    out.extend_from_slice(&(payload_len as u32).to_be_bytes());
    out.extend_from_slice(stream.as_bytes());
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(bytes);
    out
}

pub fn decode(raw: &[u8]) -> Option<Frame> {
    if raw.len() < 12 || &raw[0..4] != MAGIC || raw[4] != VERSION || raw[7] != 0 {
        return None;
    }
    let kind = Kind::from(raw[5])?;
    let flags = raw[6];
    let len = u32::from_be_bytes(raw[8..12].try_into().ok()?) as usize;
    if raw.len() != 12 + len {
        return None;
    }
    let payload = &raw[12..];
    let meta = if kind == Kind::Keyframe { 28 } else { 24 };
    if payload.len() < meta {
        return None;
    }
    let stream = Uuid::from_slice(&payload[0..16]).ok()?;
    let seq = u64::from_be_bytes(payload[16..24].try_into().ok()?);
    let size = (kind == Kind::Keyframe).then(|| (u16::from_be_bytes([payload[24], payload[25]]), u16::from_be_bytes([payload[26], payload[27]])));
    Some(Frame { kind, stream, seq, bytes: payload[meta..].to_vec(), compressed: flags & FLAG_ZLIB != 0, size })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_input() {
        let id = Uuid::new_v4();
        let raw = encode(Kind::Input, id, 7, b"hi");
        let frame = decode(&raw).unwrap();
        assert_eq!(frame.kind, Kind::Input);
        assert_eq!(frame.stream, id);
        assert_eq!(frame.seq, 7);
        assert_eq!(frame.bytes, b"hi");
    }

    #[test]
    fn keyframe_skips_size() {
        let id = Uuid::new_v4();
        let mut raw = encode(Kind::Output, id, 1, &[0, 80, 0, 24, b'x']);
        raw[5] = Kind::Keyframe as u8;
        let frame = decode(&raw).unwrap();
        assert_eq!(frame.bytes, b"x");
    }
}
