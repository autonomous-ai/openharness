//! Stream connections: one pane's output as binary frames, with snapshots, input and
//! backpressure.
//!
//! A stream connection subscribes to one pane (`Subscribe`), then receives every output the pane
//! produces after that as `Output [seq][bytes]`. `Snapshot` answers the screen, the history and
//! the metadata with the `seq` of the last output they contain; the client drops later frames
//! whose `seq` is not above it. The texts are capture-pane's (`Pane::snapshot`): `capture` and
//! `history` one line per row (`-p -e -N`), and for `"history":"conversation"` also
//! `historyJoined` (`-p -e -J`) and `lastContinues`, as `tmuxStream.ts` reads them from tmux.
//!
//! Replies: `Subscribe`, `Input`, `Paste` and `Resize` are each answered by one `Ack`
//! (`{"for":<kind>,"ok":bool,"reason"?}`), in the order they came; a `Subscribe` or `Resize` ack
//! that is `ok` also says whether the pane's size changed (`"resized":bool`: a read-only
//! subscriber, or a size the pane already has, changes nothing and the child gets no SIGWINCH); `Snapshot` by its
//! `SnapshotReply` (by `id`); `Pause` and `Resume` by nothing. Refusals name the reason:
//! `not_subscribed`, `already_subscribed`, `read_only`, `no_pane`, `exited` (input to a held pane
//! whose process ended), `bad_request`.
//!
//! Cuts: every output whose `seq` is above a `SnapshotReply`'s comes after that reply on the
//! stream (outputs at or below it may come on either side, as the dispatcher may lag; the client
//! drops those after the reply).
//!
//! Resizes are ordered against outputs by the `Resize` ack (`{"for":4,"ok":true,"seq":S,"resized":R}`): it is
//! sent once the grid has the new size, and `S` is the last output drawn at the old size. Outputs
//! above `S` come after the ack and were drawn at the new size; a snapshot asked for after the ack
//! has it. (A resize does not take a sequence number.)
//!
//! Threads and locks:
//! - the connection's reader thread reads frames and answers them in order. A snapshot is taken
//!   on it (`Pane::snapshot`, under the screen lock alone), after its reply's place in the queue
//!   is held (`Subscriber::push_reply_cut`); a resize likewise;
//! - a writer thread per connection owns the write half and drains the subscriber's queue. No
//!   lock is held while it writes;
//! - the dispatcher (`Panes::event`) queues each output for the pane's subscribers. It never
//!   waits: a subscriber with more than `QUEUE_LIMIT` bytes of output queued (paused or not) is
//!   sent `Closed {"reason":"overflow"}` and dropped. The pane and its other subscribers go on;
//! - lock order: the registry, then the table (to subscribe), then one subscriber's queue. The
//!   pane's screen lock is never held with any of them; the pane's reader thread holds only it,
//!   and sends its outputs after releasing it.
//!
//! Ends: `Closed {"reason":"exited"}` when the pane's process exits and the pane is not held (a
//! held pane keeps its streams; a respawn continues them), `{"reason":"killed"}` at `kill`, held
//! or not. Both come after the output queued before them, even to a paused subscriber. The host
//! ends the connection after any `Closed`.

use std::collections::{HashMap, VecDeque};
use std::io::{self, BufReader, Write};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use alacritty_terminal::term::TermMode;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::pane::Pane;
use crate::panes::{OpError, Panes};
use crate::protocol::{Kind, MAX_FRAME, read_frame, write_frame};
use crate::transport::Connection;

/// Output bytes (with their sequence numbers) queued for one subscriber, at most.
pub const QUEUE_LIMIT: usize = 4 * 1024 * 1024;
/// Replies queued for one subscriber, at most; past it, its reader waits for the writer.
const MAX_REPLIES: usize = 64;
/// How long a dropped subscriber has to read its `Closed` before the connection is shut.
const CLOSE_GRACE: Duration = Duration::from_secs(5);
/// History lines a snapshot includes when the request names none.
const DEFAULT_HISTORY: u32 = 500;
const DEFAULT_CONVERSATION_HISTORY: u32 = 2000;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

enum Frame {
    Output {
        seq: u64,
        bytes: Arc<[u8]>,
    },
    Reply(Kind, Vec<u8>),
    /// A reply's place, held while its payload is made (`push_reply_cut`): the writer waits here.
    Pending,
}

fn output_len(bytes: &[u8]) -> usize {
    8 + bytes.len()
}

#[derive(Default)]
struct Queue {
    frames: VecDeque<Frame>,
    /// Payload bytes of the queued outputs.
    output_bytes: usize,
    replies: usize,
    paused: bool,
    /// A `Closed` is queued: nothing more is, and a pause no longer holds output back.
    closing: bool,
    /// The connection is gone: the writer stops and nothing more is queued.
    ended: bool,
}

/// What became of an output offered to a subscriber.
#[derive(Debug, PartialEq, Eq)]
enum Push {
    Queued,
    /// Over the limit: the queue now holds only `Closed {"reason":"overflow"}`.
    Overflow,
    /// The subscriber is closing or gone.
    Gone,
}

/// One stream connection's subscription: its queue, shared by the reader thread (replies), the
/// dispatcher (outputs) and the writer thread.
pub struct Subscriber {
    queue: Mutex<Queue>,
    /// Wakes the writer when there is something to send, and the reader when replies have room.
    changed: Condvar,
    /// Shuts the connection down (both directions, every handle).
    shutdown: Box<dyn Fn() + Send + Sync>,
}

fn closed_payload(reason: &str) -> Vec<u8> {
    json!({ "reason": reason }).to_string().into_bytes()
}

impl Subscriber {
    fn new(shutdown: Box<dyn Fn() + Send + Sync>) -> Subscriber {
        Subscriber {
            queue: Mutex::new(Queue::default()),
            changed: Condvar::new(),
            shutdown,
        }
    }

    fn push_output(&self, seq: u64, bytes: Arc<[u8]>) -> Push {
        let mut q = lock(&self.queue);
        if q.closing || q.ended {
            return Push::Gone;
        }
        let len = output_len(&bytes);
        let push = if q.output_bytes + len > QUEUE_LIMIT {
            q.frames.clear();
            q.output_bytes = 0;
            q.replies = 1;
            q.frames
                .push_back(Frame::Reply(Kind::Closed, closed_payload("overflow")));
            q.closing = true;
            Push::Overflow
        } else {
            q.output_bytes += len;
            q.frames.push_back(Frame::Output { seq, bytes });
            Push::Queued
        };
        self.changed.notify_all();
        push
    }

    /// Queue a reply now, whatever is queued.
    fn push_reply_now(&self, kind: Kind, payload: Vec<u8>) {
        let mut q = lock(&self.queue);
        if q.closing || q.ended {
            return;
        }
        q.replies += 1;
        q.frames.push_back(Frame::Reply(kind, payload));
        self.changed.notify_all();
    }

    /// The queue, once it has room for a reply (the reader thread's: a client that asks without
    /// reading is no longer read).
    fn room(&self) -> MutexGuard<'_, Queue> {
        let mut q = lock(&self.queue);
        while q.replies >= MAX_REPLIES && !q.closing && !q.ended {
            q = self.changed.wait(q).unwrap_or_else(|e| e.into_inner());
        }
        q
    }

    /// Queue a reply once there is room for it.
    fn push_reply(&self, kind: Kind, payload: Vec<u8>) {
        drop(self.room());
        self.push_reply_now(kind, payload);
    }

    /// Queue a reply cut against the outputs: its place is taken first, then `make` reads the
    /// pane (outside the queue lock) and makes the payload. Every output queued before the place
    /// was produced before `make` read the pane; every output produced after that is queued after
    /// the place (and, as the dispatcher may lag, some produced before it as well). The writer
    /// holds at the place until the payload is in it.
    fn push_reply_cut(&self, kind: Kind, make: impl FnOnce() -> Vec<u8>) {
        let mut q = self.room();
        if q.closing || q.ended {
            return;
        }
        q.replies += 1;
        q.frames.push_back(Frame::Pending);
        drop(q);
        let payload = make();
        let mut q = lock(&self.queue);
        // Gone if the queue was emptied meanwhile (overflow, or the connection ended).
        if let Some(i) = q.frames.iter().position(|f| matches!(f, Frame::Pending)) {
            q.frames[i] = Frame::Reply(kind, payload);
            self.changed.notify_all();
        }
    }

    /// Queue `Closed {reason}` after what is queued.
    fn close(&self, reason: &str) {
        let mut q = lock(&self.queue);
        if q.closing || q.ended {
            return;
        }
        q.replies += 1;
        q.frames
            .push_back(Frame::Reply(Kind::Closed, closed_payload(reason)));
        q.closing = true;
        self.changed.notify_all();
    }

    fn set_paused(&self, paused: bool) {
        lock(&self.queue).paused = paused;
        self.changed.notify_all();
    }

    /// The connection is gone: the writer stops, whatever is queued.
    fn end(&self) {
        let mut q = lock(&self.queue);
        q.ended = true;
        q.frames.clear();
        q.output_bytes = 0;
        q.replies = 0;
        self.changed.notify_all();
    }

    /// The writer's next frame: the first queued, or while paused the first reply (output
    /// waits; replies do not). It waits at a reply still being made. `None` once the connection
    /// is gone.
    fn next(&self) -> Option<Frame> {
        let mut q = lock(&self.queue);
        loop {
            if q.ended {
                return None;
            }
            let at = if q.paused && !q.closing {
                q.frames
                    .iter()
                    .position(|f| !matches!(f, Frame::Output { .. }))
            } else if q.frames.is_empty() {
                None
            } else {
                Some(0)
            };
            let ready = at.filter(|&i| !matches!(q.frames[i], Frame::Pending));
            if let Some(frame) = ready.and_then(|i| q.frames.remove(i)) {
                match &frame {
                    Frame::Output { bytes, .. } => q.output_bytes -= output_len(bytes),
                    Frame::Reply(..) | Frame::Pending => q.replies -= 1,
                }
                self.changed.notify_all();
                return Some(frame);
            }
            q = self.changed.wait(q).unwrap_or_else(|e| e.into_inner());
        }
    }
}

/// Every pane's subscribers.
#[derive(Default)]
pub struct Registry {
    panes: Mutex<HashMap<String, Vec<Weak<Subscriber>>>>,
}

pub(crate) type Subscriptions<'a> = MutexGuard<'a, HashMap<String, Vec<Weak<Subscriber>>>>;

impl Registry {
    /// The registry's lock, to add a subscriber while the pane is known to exist.
    pub(crate) fn lock(&self) -> Subscriptions<'_> {
        lock(&self.panes)
    }

    /// Queue one output for each of `pane`'s subscribers. Never waits on a subscriber: one over
    /// its limit is told `overflow` and dropped.
    pub fn deliver(&self, pane: &str, seq: u64, bytes: &Arc<[u8]>) {
        let mut panes = lock(&self.panes);
        let Some(subs) = panes.get_mut(pane) else {
            return;
        };
        subs.retain(|weak| {
            let Some(sub) = weak.upgrade() else {
                return false;
            };
            match sub.push_output(seq, bytes.clone()) {
                Push::Queued => true,
                Push::Overflow => {
                    log::warn!(
                        "stream subscriber of {pane} fell {QUEUE_LIMIT} bytes behind: dropped"
                    );
                    shut_later(weak.clone());
                    false
                }
                Push::Gone => false,
            }
        });
        if subs.is_empty() {
            panes.remove(pane);
        }
    }

    /// Send `Closed {reason}` to every subscriber of `pane`, and forget them.
    pub fn close(&self, pane: &str, reason: &str) {
        let subs = lock(&self.panes).remove(pane).unwrap_or_default();
        for sub in subs.iter().filter_map(Weak::upgrade) {
            sub.close(reason);
        }
    }

    fn remove(&self, pane: &str, sub: &Arc<Subscriber>) {
        let mut panes = lock(&self.panes);
        if let Some(subs) = panes.get_mut(pane) {
            subs.retain(|w| w.strong_count() > 0 && !std::ptr::eq(w.as_ptr(), Arc::as_ptr(sub)));
            if subs.is_empty() {
                panes.remove(pane);
            }
        }
    }
}

/// A dropped subscriber that does not read its `Closed` within `CLOSE_GRACE` has its connection
/// shut, which ends its writer.
fn shut_later(sub: Weak<Subscriber>) {
    let spawned = std::thread::Builder::new()
        .name("pty-stream-close".into())
        .spawn({
            let sub = sub.clone();
            move || {
                std::thread::sleep(CLOSE_GRACE);
                if let Some(sub) = sub.upgrade() {
                    (sub.shutdown)();
                }
            }
        });
    if spawned.is_err()
        && let Some(sub) = sub.upgrade()
    {
        (sub.shutdown)();
    }
}

fn write_output(w: &mut impl Write, seq: u64, bytes: &[u8]) -> io::Result<()> {
    let len = output_len(bytes);
    let mut frame = Vec::with_capacity(5 + len);
    frame.push(Kind::Output as u8);
    frame.extend_from_slice(&(len as u32).to_be_bytes());
    frame.extend_from_slice(&seq.to_be_bytes());
    frame.extend_from_slice(bytes);
    w.write_all(&frame)
}

fn write_loop<C: Connection>(sub: Arc<Subscriber>, mut conn: C) {
    while let Some(frame) = sub.next() {
        let (written, last) = match &frame {
            Frame::Output { seq, bytes } => (write_output(&mut conn, *seq, bytes), false),
            Frame::Reply(kind, payload) => (
                write_frame(&mut conn, *kind, payload),
                *kind == Kind::Closed,
            ),
            Frame::Pending => continue,
        };
        if written.is_err() || last {
            break;
        }
    }
    sub.end();
    conn.shutdown();
}

#[derive(Deserialize)]
struct SubscribeRequest {
    pane: String,
    cols: u16,
    rows: u16,
    #[serde(rename = "readOnly", default)]
    read_only: bool,
}

#[derive(Deserialize)]
struct ResizeRequest {
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
struct SnapshotRequest {
    id: u64,
    #[serde(default)]
    history: Option<String>,
    #[serde(rename = "historyLines", default)]
    history_lines: Option<u32>,
}

/// What a snapshot request asks for.
struct SnapshotTarget {
    id: u64,
    pane: Arc<Pane>,
    lines: u32,
    conversation: bool,
}

/// One stream connection's state, on its reader thread.
struct Session<'a> {
    panes: &'a Panes,
    sub: &'a Arc<Subscriber>,
    /// The pane subscribed to.
    pane: Option<String>,
    read_only: bool,
}

fn ack(kind: Kind, outcome: Result<(), &str>) -> Vec<u8> {
    let v = match outcome {
        Ok(()) => json!({"for": kind as u8, "ok": true}),
        Err(reason) => json!({"for": kind as u8, "ok": false, "reason": reason}),
    };
    v.to_string().into_bytes()
}

/// A `Subscribe` or `Resize` ack: whether the pane's size changed, and for a resize the last
/// output drawn at the old size.
fn sized_ack(kind: Kind, seq: Option<u64>, resized: bool) -> Vec<u8> {
    let mut v = json!({"for": kind as u8, "ok": true, "resized": resized});
    if let Some(seq) = seq {
        v["seq"] = json!(seq);
    }
    v.to_string().into_bytes()
}

/// The stream reason for an op's failure to find a pane that takes input.
fn reason(err: OpError) -> &'static str {
    if err.code == "no_pane" {
        "no_pane"
    } else {
        "exited"
    }
}

/// A snapshot reply that fits a frame.
fn snapshot_reply(id: u64, snap: crate::pane::Snapshot) -> Vec<u8> {
    snapshot_reply_within(id, snap, MAX_FRAME as usize)
}

/// A conversation's joined history goes first (the client then uses the plain one, as it does
/// when tmux's cannot be re-wrapped); then the oldest plain history lines.
fn snapshot_reply_within(id: u64, snap: crate::pane::Snapshot, max: usize) -> Vec<u8> {
    let mut history = snap.history;
    let mut conversation = snap.conversation;
    loop {
        let mut reply = json!({
            "id": id,
            "ok": true,
            "seq": snap.seq,
            "capture": snap.capture,
            "history": history,
            "meta": snap.meta,
        });
        if let Some(c) = &conversation {
            reply["historyJoined"] = json!(c.joined);
            reply["lastContinues"] = json!(c.last_continues);
        }
        let payload = reply.to_string().into_bytes();
        if payload.len() <= max || (history.is_empty() && conversation.is_none()) {
            return payload;
        }
        if conversation.take().is_some() {
            continue;
        }
        // JSON escapes at most sextuple a byte; drop at least the excess, at a line's end (a
        // newline byte is always a character's end).
        let excess = (payload.len() - max).div_ceil(6).min(history.len());
        let cut = history.as_bytes()[excess..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| excess + i + 1)
            .unwrap_or(history.len());
        history.drain(..cut);
    }
}

impl Session<'_> {
    fn handle(&mut self, kind: Kind, payload: Vec<u8>) {
        match kind {
            Kind::Subscribe => {
                let outcome = self.subscribe(&payload);
                if let Err(reason) = outcome {
                    self.sub.push_reply(Kind::Ack, ack(kind, Err(reason)));
                }
            }
            Kind::Input => {
                let outcome = self.writable().and_then(|pane| {
                    pane.write(&payload).map_err(|_| "exited")?;
                    Ok(())
                });
                self.sub.push_reply(Kind::Ack, ack(kind, outcome));
            }
            Kind::Paste => {
                let outcome = self.writable().and_then(|pane| {
                    let text = std::str::from_utf8(&payload).map_err(|_| "bad_request")?;
                    let mode_on = pane.mode().contains(TermMode::BRACKETED_PASTE);
                    let bytes = harness_term::paste::bytes(text, true, mode_on);
                    pane.write(&bytes).map_err(|_| "exited")?;
                    Ok(())
                });
                self.sub.push_reply(Kind::Ack, ack(kind, outcome));
            }
            Kind::Resize => {
                let target = self.resizable().and_then(|pane| {
                    let req: ResizeRequest =
                        serde_json::from_slice(&payload).map_err(|_| "bad_request")?;
                    Ok((pane, req))
                });
                match target {
                    // Cut: every output after the ack whose seq is above the ack's was drawn at
                    // the new size.
                    Ok((pane, req)) => self.sub.push_reply_cut(Kind::Ack, || {
                        let (seq, resized) = pane.resize(req.cols, req.rows);
                        sized_ack(kind, Some(seq), resized)
                    }),
                    Err(reason) => self.sub.push_reply(Kind::Ack, ack(kind, Err(reason))),
                }
            }
            Kind::Snapshot => match self.snapshot_target(&payload) {
                // Cut: every output after the reply whose seq is above the reply's is new to it.
                Ok(t) => self.sub.push_reply_cut(Kind::SnapshotReply, || {
                    snapshot_reply(t.id, t.pane.snapshot(t.lines, t.conversation))
                }),
                Err((id, reason)) => self.sub.push_reply(
                    Kind::SnapshotReply,
                    json!({"id": id, "ok": false, "reason": reason})
                        .to_string()
                        .into_bytes(),
                ),
            },
            Kind::Pause => self.sub.set_paused(true),
            Kind::Resume => self.sub.set_paused(false),
            Kind::Output | Kind::SnapshotReply | Kind::Closed | Kind::Ack => {
                self.sub
                    .push_reply(Kind::Ack, ack(kind, Err("bad_request")));
            }
        }
    }

    /// Subscribe, resizing the pane to the subscriber unless it is read-only. The `Ack` is queued
    /// before the first output.
    fn subscribe(&mut self, payload: &[u8]) -> Result<(), &'static str> {
        if self.pane.is_some() {
            return Err("already_subscribed");
        }
        let req: SubscribeRequest = serde_json::from_slice(payload).map_err(|_| "bad_request")?;
        let pane = self.panes.pane(&req.pane).map_err(|_| "no_pane")?;
        let resized = !req.read_only && pane.resize(req.cols, req.rows).1;
        let sub = self.sub;
        let added = self.panes.subscribe(&req.pane, sub, || {
            sub.push_reply_now(Kind::Ack, sized_ack(Kind::Subscribe, None, resized))
        });
        if !added {
            return Err("no_pane");
        }
        self.pane = Some(req.pane);
        self.read_only = req.read_only;
        Ok(())
    }

    fn subscribed(&self) -> Result<&str, &'static str> {
        let pane = self.pane.as_deref().ok_or("not_subscribed")?;
        if self.read_only {
            return Err("read_only");
        }
        Ok(pane)
    }

    /// The pane, for input: subscribed, not read-only, and running.
    fn writable(&self) -> Result<Arc<Pane>, &'static str> {
        self.panes.live_pane(self.subscribed()?).map_err(reason)
    }

    /// The pane, for a resize: subscribed and not read-only.
    fn resizable(&self) -> Result<Arc<Pane>, &'static str> {
        self.panes.pane(self.subscribed()?).map_err(reason)
    }

    /// A snapshot request's id, pane, history depth and whether it is a conversation's; or its
    /// id and why it is refused.
    fn snapshot_target(&self, payload: &[u8]) -> Result<SnapshotTarget, (u64, &'static str)> {
        let req: SnapshotRequest = serde_json::from_slice(payload).map_err(|_| {
            let id = serde_json::from_slice::<Value>(payload)
                .ok()
                .and_then(|v| v.get("id").and_then(Value::as_u64))
                .unwrap_or(0);
            (id, "bad_request")
        })?;
        let pane = self.pane.as_deref().ok_or((req.id, "not_subscribed"))?;
        let pane = self.panes.pane(pane).map_err(|_| (req.id, "no_pane"))?;
        let lines = match req.history.as_deref() {
            None | Some("none") => 0,
            Some("conversation") => req.history_lines.unwrap_or(DEFAULT_CONVERSATION_HISTORY),
            Some(_) => req.history_lines.unwrap_or(DEFAULT_HISTORY),
        };
        let conversation = req.history.as_deref() == Some("conversation");
        Ok(SnapshotTarget {
            id: req.id,
            pane,
            lines,
            conversation,
        })
    }
}

/// Serve a stream connection after its hello: frames in on this thread, frames out on a writer
/// thread. `reader` holds what was read past the hello line.
pub(crate) fn serve<C: Connection>(
    mut reader: BufReader<C>,
    conn: C,
    panes: &Panes,
) -> io::Result<()> {
    let closer = Mutex::new(conn.try_clone()?);
    let sub = Arc::new(Subscriber::new(Box::new(move || lock(&closer).shutdown())));
    let writer = sub.clone();
    std::thread::Builder::new()
        .name("pty-stream-writer".into())
        .spawn(move || write_loop(writer, conn))?;
    let mut session = Session {
        panes,
        sub: &sub,
        pane: None,
        read_only: false,
    };
    let ended = (|| {
        while let Some((kind, payload)) = read_frame(&mut reader)? {
            session.handle(kind, payload);
        }
        Ok(())
    })();
    if let Some(pane) = &session.pane {
        panes.streams.remove(pane, &sub);
    }
    sub.end();
    ended
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn sub() -> (Arc<Subscriber>, Arc<AtomicBool>) {
        let shut = Arc::new(AtomicBool::new(false));
        let s = shut.clone();
        (
            Arc::new(Subscriber::new(Box::new(move || {
                s.store(true, Ordering::SeqCst)
            }))),
            shut,
        )
    }

    fn bytes(n: usize) -> Arc<[u8]> {
        Arc::from(vec![b'x'; n])
    }

    fn drain(s: &Subscriber) -> Vec<String> {
        let mut out = Vec::new();
        loop {
            let q = lock(&s.queue);
            let empty = q.frames.is_empty() || (q.paused && !q.closing && q.replies == 0);
            drop(q);
            if empty {
                return out;
            }
            out.push(match s.next().unwrap() {
                Frame::Output { seq, .. } => format!("out {seq}"),
                Frame::Reply(kind, payload) => {
                    format!("{kind:?} {}", String::from_utf8(payload).unwrap())
                }
                Frame::Pending => unreachable!(),
            });
        }
    }

    #[test]
    fn the_limit_counts_queued_output_and_overflow_leaves_only_closed() {
        let (s, _) = sub();
        let chunk = 64 * 1024;
        let fits = QUEUE_LIMIT / output_len(&bytes(chunk));
        for seq in 1..=fits as u64 {
            assert_eq!(s.push_output(seq, bytes(chunk)), Push::Queued);
        }
        assert_eq!(s.push_output(999, bytes(chunk)), Push::Overflow);
        assert_eq!(s.push_output(1000, bytes(1)), Push::Gone);
        assert_eq!(drain(&s), [r#"Closed {"reason":"overflow"}"#]);
    }

    #[test]
    fn a_paused_subscriber_counts_toward_the_limit_and_gets_replies_only() {
        let (s, _) = sub();
        s.set_paused(true);
        s.push_output(1, bytes(10));
        s.push_reply_now(Kind::Ack, b"{}".to_vec());
        s.push_output(2, bytes(10));
        assert_eq!(drain(&s), ["Ack {}"]);
        assert_eq!(lock(&s.queue).output_bytes, 36);
        s.set_paused(false);
        assert_eq!(drain(&s), ["out 1", "out 2"]);
        s.set_paused(true);
        assert_eq!(s.push_output(3, bytes(QUEUE_LIMIT)), Push::Overflow);
    }

    #[test]
    fn a_cut_reply_comes_before_every_output_queued_after_it_is_taken() {
        let (s, _) = sub();
        s.push_output(1, bytes(3));
        s.push_reply_cut(Kind::SnapshotReply, || {
            // The dispatcher queues output while the pane is read and the payload made.
            assert_eq!(s.push_output(2, bytes(3)), Push::Queued);
            br#"{"seq":1}"#.to_vec()
        });
        assert_eq!(drain(&s), ["out 1", r#"SnapshotReply {"seq":1}"#, "out 2"]);
        // While paused, a cut reply still goes ahead of output.
        s.set_paused(true);
        s.push_output(3, bytes(3));
        s.push_reply_cut(Kind::Ack, || b"{}".to_vec());
        assert_eq!(drain(&s), ["Ack {}"]);
    }

    #[test]
    fn closed_follows_queued_output_even_when_paused() {
        let (s, _) = sub();
        s.set_paused(true);
        s.push_output(1, bytes(3));
        s.close("exited");
        s.close("killed");
        assert_eq!(s.push_output(2, bytes(3)), Push::Gone);
        assert_eq!(drain(&s), ["out 1", r#"Closed {"reason":"exited"}"#]);
    }

    #[test]
    fn one_overflowing_subscriber_leaves_the_others_alone() {
        let registry = Registry::default();
        let (slow, _) = sub();
        let (fast, _) = sub();
        registry
            .lock()
            .entry("%1".into())
            .or_default()
            .extend([Arc::downgrade(&slow), Arc::downgrade(&fast)]);
        let chunk = bytes(1024 * 1024);
        for seq in 1..=8 {
            registry.deliver("%1", seq, &chunk);
            // The fast one reads.
            assert_eq!(drain(&fast), [format!("out {seq}")]);
        }
        assert_eq!(
            drain(&slow).last().unwrap(),
            r#"Closed {"reason":"overflow"}"#
        );
        assert_eq!(registry.lock()["%1"].len(), 1);
        registry.close("%1", "killed");
        assert_eq!(drain(&fast), [r#"Closed {"reason":"killed"}"#]);
        assert!(registry.lock().is_empty());
    }

    #[test]
    fn replies_wait_for_room() {
        let (s, _) = sub();
        for _ in 0..MAX_REPLIES {
            s.push_reply(Kind::Ack, b"{}".to_vec());
        }
        let t = std::thread::spawn({
            let s = s.clone();
            move || s.push_reply(Kind::Ack, b"{}".to_vec())
        });
        std::thread::sleep(Duration::from_millis(100));
        assert!(!t.is_finished());
        s.next().unwrap();
        t.join().unwrap();
        assert_eq!(lock(&s.queue).replies, MAX_REPLIES);
        s.end();
        assert!(s.next().is_none());
    }

    #[test]
    fn a_snapshot_too_large_for_a_frame_loses_its_oldest_history() {
        let line = "\u{1b}[31mé".repeat(10) + "\n";
        let snap = crate::pane::Snapshot {
            seq: 7,
            capture: "screen".into(),
            history: format!("first\n{}last\n", line.repeat(200)),
            conversation: Some(crate::pane::Conversation {
                joined: "joined\n".into(),
                last_continues: true,
            }),
            meta: crate::pane::PaneMeta {
                cols: 80,
                rows: 24,
                alternate_on: false,
                cursor_x: 0,
                cursor_y: 0,
                cursor_visible: true,
                mouse_standard: false,
                mouse_button: false,
                mouse_all: false,
                mouse_utf8: false,
                mouse_sgr: false,
            },
        };
        let payload = snapshot_reply_within(3, snap.clone(), 4096);
        assert!(payload.len() <= 4096, "{}", payload.len());
        assert!(payload.len() > 3000, "{}", payload.len());
        let v: Value = serde_json::from_slice(&payload).unwrap();
        let history = v["history"].as_str().unwrap();
        assert!(!history.starts_with("first") && history.ends_with("last\n"));
        assert!(history.starts_with('\u{1b}'));
        // The joined form went first.
        assert!(v.get("historyJoined").is_none() && v.get("lastContinues").is_none());
        assert_eq!(
            (v["seq"].clone(), v["capture"].clone()),
            (json!(7), json!("screen"))
        );
        // One that fits is whole.
        let whole: Value = serde_json::from_slice(&snapshot_reply(3, snap.clone())).unwrap();
        assert_eq!(whole["history"], json!(snap.history));
        assert_eq!(whole["historyJoined"], json!("joined\n"));
        assert_eq!(whole["lastContinues"], json!(true));
        assert_eq!(whole["meta"]["alternate_on"], json!(false));
        // Only a conversation's carries the joined form.
        let plain = crate::pane::Snapshot {
            conversation: None,
            ..snap
        };
        let plain: Value = serde_json::from_slice(&snapshot_reply(3, plain)).unwrap();
        assert!(plain.get("historyJoined").is_none() && plain.get("lastContinues").is_none());
    }
}
