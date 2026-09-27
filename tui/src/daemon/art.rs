//! An individual's own plates, drawn by the harness background process (harnessd) with the same
//! shader and models as the species' (daemons/README.md "Individual art"), and asked for over its
//! Unix socket like the other `daemon_*` frames:
//!
//!   daemon_plate_get { requestId, uid, id, seed, size: 'portrait'|'reveal', version, mood }
//!   -> daemon_plate { requestId, uid, size, version, mood, frames: [{ rows, mats }], frameMs }
//!      or { requestId, error }
//!
//! hn keeps what it was given for as long as it runs. Until an individual's art arrives — and when
//! harnessd is not reachable, is reached over TCP only, or has none to give — hn draws the species
//! plate painted in the individual's colour family (plates.rs `paint_individual`). A seed of 0 is the
//! species' own look, which plates.json already holds: nothing is asked for it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::plates::{Art, Framed};
use super::zoo::Owned;
use crate::app::App;
use crate::daemon::Link;

/// How long an answer may take (harnessd renders a model's frames, a few hundred ms each size).
pub const ASK_FOR: Duration = Duration::from_secs(20);
/// A request that failed is not asked again for this long.
pub const RETRY_AFTER: Duration = Duration::from_secs(60);

/// (uid, size, version, mood).
pub type Key = (String, String, String, String);

#[derive(Clone, Debug)]
pub enum Held { Asked(Instant), Ready(Arc<Art>), Failed(Instant) }

/// What hn holds of individuals' art.
#[derive(Default)]
pub struct Gallery { pub art: HashMap<Key, Held> }

impl Gallery {
    pub fn ready(&self, key: &Key) -> Option<Arc<Art>> { match self.art.get(key) { Some(Held::Ready(a)) => Some(a.clone()), _ => None } }

    /// Whether to ask for it now: never asked, or failed long enough ago, or asked so long ago that
    /// the answer is not coming.
    fn due(&self, key: &Key, now: Instant) -> bool {
        match self.art.get(key) {
            None => true,
            Some(Held::Ready(_)) => false,
            Some(Held::Asked(at)) => now.duration_since(*at) >= ASK_FOR + Duration::from_secs(1),
            Some(Held::Failed(at)) => now.duration_since(*at) >= RETRY_AFTER,
        }
    }
}

/// Whether an individual has art of its own to ask for: a species drawn filled, and a seed that is not
/// the species' own look.
pub fn has_own(o: &Owned) -> bool {
    o.seed != 0 && super::roster::roster().shown(&o.id).map(|d| d.plate && d.traits.is_some()).unwrap_or(false)
}

pub fn key(o: &Owned, size: &str, version: &str, mood: &str) -> Key { (o.uid().to_string(), size.into(), version.into(), mood.into()) }

/// The request's payload.
pub fn ask(o: &Owned, size: &str, version: &str, mood: &str) -> Value {
    json!({ "uid": o.uid(), "id": o.id, "seed": o.seed, "size": size, "version": version, "mood": mood })
}

/// A `daemon_plate` answer as art: its frames, each with its material rows (all one width).
pub fn parse(v: &Value) -> Result<Art, String> {
    if let Some(e) = v.get("error").and_then(Value::as_str) { return Err(e.to_string()) }
    let frames: Vec<Framed> = v.get("frames").and_then(Value::as_array).ok_or("no frames")?.iter().map(|f| {
        let rows = f.get("rows").and_then(Value::as_str).ok_or("a frame without rows")?.to_string();
        // A frame without materials is the body throughout.
        let mats = f.get("mats").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| rows.split('\n').map(|r| ".".repeat(r.len())).collect::<Vec<_>>().join("\n"));
        Ok(Framed { rows, mats })
    }).collect::<Result<_, String>>()?;
    if frames.is_empty() { return Err("no frames".into()) }
    // Printable ASCII only, as every plate (the art rules): anything else is not drawn from here.
    if frames.iter().any(|f| f.rows.bytes().any(|b| b != b'\n' && !(0x20..0x7f).contains(&b))) { return Err("not printable".into()) }
    let frame_ms = v.get("frameMs").and_then(Value::as_u64).filter(|ms| *ms > 0).unwrap_or(super::plates::plates().frame_ms);
    Ok(Art { frames, frame_ms })
}

/// An individual's art at a size, version and mood: what hn holds, or None while it is asked for
/// (the answer draws again) — and asked for when it is due and harnessd's socket is there.
pub fn get(app: &mut App, o: &Owned, size: &str, version: &str, mood: &str) -> Option<Arc<Art>> {
    if !has_own(o) { return None }
    let key = key(o, size, version, mood);
    if let Some(a) = app.daemons.gallery.ready(&key) { return Some(a) }
    let now = Instant::now();
    if !app.daemons.gallery.due(&key, now) { return None }
    let link = app.link(&app.fleet.local_id).filter(Link::over_socket)?;
    app.daemons.gallery.art.insert(key.clone(), Held::Asked(now));
    let payload = ask(o, size, version, mood);
    app.spawn(async move { link.request("daemon_plate_get", payload, ASK_FOR).await }, move |app, r| {
        let held = match r.map_err(|e| e.to_string()).and_then(|(_, v)| parse(&v)) {
            Ok(art) => Held::Ready(Arc::new(art)),
            Err(_) => Held::Failed(Instant::now()),
        };
        app.daemons.gallery.art.insert(key, held);
        super::brain::wake(app, 0);
    });
    None
}

/// From a shell (`hn card`): one individual's art straight from harnessd's socket, or None (it is
/// not there, is reached over TCP only, or did not answer in time).
pub async fn fetch(port: u16, o: &Owned, size: &str, version: &str, mood: &str) -> Option<Art> {
    if !has_own(o) || super::socket::present(port).is_none() { return None }
    let status = crate::daemon::http_json(port, "GET", "/api/status", None).await.ok()?;
    let machine = status.get("machineId").and_then(Value::as_str)?.to_string();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let link = Link::spawn(port, &machine, 0, tx);
    let connected = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(ev) = rx.recv().await {
            if let crate::event::Event::Machine { event, .. } = ev {
                match event { crate::event::MachineEvent::Connected => return true, crate::event::MachineEvent::Failed(_) | crate::event::MachineEvent::Closed(_) => return false, _ => {} }
            }
        }
        false
    }).await.unwrap_or(false);
    if !connected || !link.over_socket() { return None }
    let (_, v) = link.request("daemon_plate_get", ask(o, size, version, mood), Duration::from_secs(10)).await.ok()?;
    parse(&v).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_daemon_plate_answer() {
        let art = parse(&json!({ "requestId": "r", "uid": "u", "size": "portrait", "version": "0.1", "mood": "idle", "frameMs": 170,
            "frames": [{ "rows": " .#\n@x ", "mats": ".m.\na.." }, { "rows": " .#\n@x " }] })).unwrap();
        assert_eq!((art.frames.len(), art.frame_ms), (2, 170));
        assert_eq!(art.frames[0].mats(), vec![".m.", "a.."]);
        assert_eq!(art.frames[1].mats(), vec!["...", "..."], "no materials: the body throughout");
        assert_eq!(art.frame(3).unwrap().rows, " .#\n@x ");
        assert_eq!(parse(&json!({ "requestId": "r", "error": "NO_PLATE" })), Err("NO_PLATE".into()));
        assert!(parse(&json!({ "frames": [] })).is_err() && parse(&json!({ "frames": [{ "rows": "\u{1b}[31m" }] })).is_err());
    }

    #[test]
    fn only_an_individual_with_a_look_of_its_own_is_asked_for() {
        let o = |id: &str, seed: u64| Owned { uid: "u1".into(), id: id.into(), seed, ..Default::default() };
        assert!(has_own(&o("tim", 826)));
        // Seed 0 is the species' own look; line art (and a drop on hold) has no plate.
        assert!(!has_own(&o("tim", 0)) && !has_own(&o("vim", 5)) && !has_own(&o("nobody", 5)));
        assert_eq!(ask(&o("tim", 826), "reveal", "0.1", "idle"), json!({ "uid": "u1", "id": "tim", "seed": 826, "size": "reveal", "version": "0.1", "mood": "idle" }));
        let mut g = Gallery::default();
        let k = key(&o("tim", 826), "portrait", "0.1", "idle");
        let now = Instant::now();
        assert!(g.due(&k, now));
        g.art.insert(k.clone(), Held::Asked(now));
        assert!(!g.due(&k, now) && g.ready(&k).is_none());
        g.art.insert(k.clone(), Held::Failed(now));
        assert!(!g.due(&k, now) && g.due(&k, now + RETRY_AFTER));
    }
}
