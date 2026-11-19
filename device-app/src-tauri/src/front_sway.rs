//! The app in front on sway: the IPC socket tells each window change. No timer, no permission.
//!
//! Spoken on the socket itself, not through `swaymsg`: one fixed protocol, and no program to run.

use crate::front::Stop;
use crate::front_x11::exe_name;
use serde_json::Value;
use std::io::{self, Read, Write};
use std::path::Path;
#[cfg(target_os = "linux")]
use {
    crate::front::{FrontSource, Source, on_thread},
    crate::types::Log,
    std::os::unix::net::UnixStream,
    std::sync::Arc,
};

/// What sway sends is read whole before it is parsed: past this a message is refused, not allocated. A tree with
/// thousands of windows is a few MB.
pub const PAYLOAD_MAX: usize = 16 * 1024 * 1024;

const MAGIC: &[u8; 6] = b"i3-ipc";
const SUBSCRIBE: u32 = 2;
const GET_TREE: u32 = 4;
const WINDOW_EVENT: u32 = 0x8000_0003;

/// The exe name of the process whose window is focused: once at start, then on each focus change.
#[cfg(target_os = "linux")]
pub struct SwayFront {
    pub log: Arc<dyn Log>,
}

#[cfg(target_os = "linux")]
impl FrontSource for SwayFront {
    fn start(&self, changed: Box<dyn Fn(String) + Send + Sync>) {
        on_thread(self.log.clone(), Source::Sway, move || {
            let Some(socket) = std::env::var_os("SWAYSOCK") else { return Stop::NotFollowed };
            let Ok(stream) = UnixStream::connect(socket) else { return Stop::NotFollowed };
            follow(stream, Path::new("/proc"), &*changed)
        });
    }
}

/// One i3-ipc message: the magic, the payload's length and the message's kind in native byte order, the payload.
pub fn message(kind: u32, payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len()).expect("a payload under 4 GiB");
    [MAGIC.as_slice(), &length.to_ne_bytes(), &kind.to_ne_bytes(), payload].concat()
}

/// The next message's kind and payload. Another magic, or a payload over PAYLOAD_MAX, is refused.
pub fn read_message(stream: &mut impl Read) -> io::Result<(u32, Vec<u8>)> {
    let mut header = [0; 14];
    stream.read_exact(&mut header)?;
    let (magic, rest) = header.split_at(MAGIC.len());
    let (length, kind) = rest.split_at(4);
    let length = u32::from_ne_bytes(length.try_into().unwrap()) as usize;
    if magic != MAGIC || length > PAYLOAD_MAX {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut payload = vec![0; length];
    stream.read_exact(&mut payload)?;
    Ok((u32::from_ne_bytes(kind.try_into().unwrap()), payload))
}

/// The pid of the tree's focused node, walked through tiled and floating nodes alike. None when that node has no
/// process (an empty workspace, a split).
pub fn focused_pid(tree: &[u8]) -> Option<u32> {
    let tree: Value = serde_json::from_slice(tree).ok()?;
    // A stack, not recursion: the tree's depth is sway's, not ours.
    let mut nodes = vec![&tree];
    while let Some(node) = nodes.pop() {
        if node["focused"] == true {
            return pid(node);
        }
        for key in ["nodes", "floating_nodes"] {
            nodes.extend(node[key].as_array().into_iter().flatten());
        }
    }
    None
}

/// For a window event: None unless focus moved; then the pid of the container it moved to, None when it has none.
pub fn focus_pid(event: &[u8]) -> Option<Option<u32>> {
    let event: Value = serde_json::from_slice(event).ok()?;
    (event["change"] == "focus").then(|| pid(&event["container"]))
}

fn pid(node: &Value) -> Option<u32> {
    node["pid"].as_u64().and_then(|pid| u32::try_from(pid).ok()).filter(|&pid| pid > 0)
}

/// Tells the app in front now, then on each focus change, until the socket ends.
pub fn follow(mut stream: impl Read + Write, proc_root: &Path, changed: &dyn Fn(String)) -> Stop {
    let tell = |pid: Option<u32>| changed(pid.and_then(|pid| exe_name(proc_root, pid)).unwrap_or_default());
    // Subscribed before the tree is asked for, so a change between the two is not missed.
    let subscribed = stream.write_all(&message(SUBSCRIBE, br#"["window"]"#)).and_then(|()| read_message(&mut stream));
    let Ok((SUBSCRIBE, answer)) = subscribed else { return Stop::NotFollowed };
    if !serde_json::from_slice::<Value>(&answer).is_ok_and(|answer| answer["success"] == true) {
        return Stop::NotFollowed;
    }
    if stream.write_all(&message(GET_TREE, b"")).is_err() {
        return Stop::Ended;
    }
    // Told in the order sway sent them: an event ahead of the tree is older than the tree.
    loop {
        match read_message(&mut stream) {
            Err(_) => return Stop::Ended,
            Ok((GET_TREE, tree)) => tell(focused_pid(&tree)),
            Ok((WINDOW_EVENT, event)) => {
                if let Some(pid) = focus_pid(&event) {
                    tell(pid);
                }
            }
            Ok(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixStream;

    /// sway's tree, as `swaymsg -t get_tree` prints it, cut to the fields read: foot (pid 101) and Code (pid 202) side
    /// by side, Code focused.
    const TREE_CODE: &str = r#"{"id":1,"type":"root","name":"root","focused":false,"nodes":[
        {"id":2147483647,"type":"output","name":"__i3","focused":false,"nodes":[],"floating_nodes":[]},
        {"id":3,"type":"output","name":"HEADLESS-1","focused":false,"floating_nodes":[],"nodes":[
            {"id":4,"type":"workspace","name":"1","focused":false,"floating_nodes":[],"nodes":[
                {"id":5,"type":"con","name":"~","app_id":"foot","pid":101,"focused":false,"nodes":[],"floating_nodes":[]},
                {"id":6,"type":"con","name":"main.rs - Visual Studio Code","app_id":"code","pid":202,"focused":true,
                 "nodes":[],"floating_nodes":[]}]}]}],"floating_nodes":[]}"#;

    /// The same outputs, foot focused.
    const TREE_FOOT: &str = r#"{"id":1,"type":"root","name":"root","focused":false,"floating_nodes":[],"nodes":[
        {"id":3,"type":"output","name":"HEADLESS-1","focused":false,"floating_nodes":[],"nodes":[
            {"id":4,"type":"workspace","name":"1","focused":false,"floating_nodes":[],"nodes":[
                {"id":5,"type":"con","name":"~","app_id":"foot","pid":101,"focused":true,"nodes":[],"floating_nodes":[]},
                {"id":6,"type":"con","name":"main.rs - Visual Studio Code","app_id":"code","pid":202,"focused":false,
                 "nodes":[],"floating_nodes":[]}]}]}]}"#;

    /// foot tiled, Code floating above it and focused.
    const TREE_FLOATING: &str = r#"{"id":1,"type":"root","name":"root","focused":false,"floating_nodes":[],"nodes":[
        {"id":3,"type":"output","name":"HEADLESS-1","focused":false,"floating_nodes":[],"nodes":[
            {"id":4,"type":"workspace","name":"1","focused":false,
             "nodes":[{"id":5,"type":"con","app_id":"foot","pid":101,"focused":false,"nodes":[],"floating_nodes":[]}],
             "floating_nodes":[{"id":6,"type":"floating_con","app_id":"code","pid":202,"focused":true,"nodes":[],
                                "floating_nodes":[]}]}]}]}"#;

    /// A window event of sway's: `change` and the container it is about.
    fn event(change: &str, container: &str) -> String {
        format!(r#"{{"change":"{change}","container":{container}}}"#)
    }

    const CODE: &str = r#"{"id":6,"type":"con","name":"lib.rs - Visual Studio Code","app_id":"code","pid":202,
        "focused":true,"nodes":[],"floating_nodes":[]}"#;
    /// A split container: it has no process of its own.
    const SPLIT: &str = r#"{"id":7,"type":"con","name":null,"layout":"splith","focused":true,"nodes":[],
        "floating_nodes":[]}"#;
    /// A window whose process is gone (or is another person's).
    const GONE: &str =
        r#"{"id":8,"type":"con","app_id":"foot","pid":999,"focused":true,"nodes":[],"floating_nodes":[]}"#;

    /// A `/proc` with foot as pid 101 and Code as pid 202.
    fn proc_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        for (pid, exe) in [(101, "/usr/bin/foot"), (202, "/usr/share/code/code")] {
            fs::create_dir(root.path().join(pid.to_string())).unwrap();
            symlink(exe, root.path().join(pid.to_string()).join("exe")).unwrap();
        }
        root
    }

    /// `follow` against a sway the script plays; what it told, and why it stopped. The script's end closes sway's side.
    fn run(proc_root: &Path, script: impl FnOnce(&mut UnixStream) + Send + 'static) -> (Vec<String>, Stop) {
        let (ours, mut sway) = UnixStream::pair().unwrap();
        let peer = std::thread::spawn(move || script(&mut sway));
        let told = RefCell::new(Vec::new());
        let stop = follow(ours, proc_root, &|value| told.borrow_mut().push(value));
        peer.join().unwrap();
        (told.into_inner(), stop)
    }

    fn send(sway: &mut UnixStream, kind: u32, payload: &str) {
        sway.write_all(&message(kind, payload.as_bytes())).unwrap();
    }

    fn expect(sway: &mut UnixStream, kind: u32, payload: &str) {
        let (got, body) = read_message(sway).unwrap();
        assert_eq!((got, String::from_utf8(body).unwrap()), (kind, payload.to_string()));
    }

    /// sway takes the subscription, then is asked for the tree.
    fn subscribed(sway: &mut UnixStream) {
        expect(sway, SUBSCRIBE, r#"["window"]"#);
        send(sway, SUBSCRIBE, r#"{"success":true}"#);
        expect(sway, GET_TREE, "");
    }

    #[test]
    fn the_first_value_is_the_trees_focused_node() {
        let root = proc_root();
        let (told, stop) = run(root.path(), |sway| {
            subscribed(sway);
            send(sway, GET_TREE, TREE_CODE);
        });
        assert_eq!(told, ["code"]);
        assert_eq!(stop, Stop::Ended);
    }

    #[test]
    fn a_focus_event_tells_the_new_app_and_a_title_change_tells_nothing() {
        let root = proc_root();
        let (told, stop) = run(root.path(), |sway| {
            subscribed(sway);
            send(sway, GET_TREE, TREE_FOOT);
            send(sway, WINDOW_EVENT, &event("title", CODE));
            send(sway, WINDOW_EVENT, &event("focus", CODE));
        });
        assert_eq!(told, ["foot", "code"]);
        assert_eq!(stop, Stop::Ended);
    }

    #[test]
    fn an_event_that_arrives_before_the_tree_is_not_lost() {
        let root = proc_root();
        // Subscribed first, so focus moving to Code before the tree is read reaches the socket ahead of the tree.
        let (told, stop) = run(root.path(), |sway| {
            subscribed(sway);
            send(sway, WINDOW_EVENT, &event("focus", CODE));
            send(sway, GET_TREE, TREE_CODE);
        });
        assert_eq!(told, ["code", "code"]);
        assert_eq!(stop, Stop::Ended);
    }

    #[test]
    fn a_focus_with_no_pid_is_the_empty_value() {
        let root = proc_root();
        let (told, _) = run(root.path(), |sway| {
            subscribed(sway);
            send(sway, GET_TREE, TREE_FOOT);
            send(sway, WINDOW_EVENT, &event("focus", SPLIT));
            send(sway, WINDOW_EVENT, &event("focus", CODE));
            send(sway, WINDOW_EVENT, &event("focus", GONE));
        });
        assert_eq!(told, ["foot", "", "code", ""]);
    }

    #[test]
    fn a_refused_subscribe_is_not_followed() {
        let root = proc_root();
        let (told, stop) = run(root.path(), |sway| {
            expect(sway, SUBSCRIBE, r#"["window"]"#);
            send(sway, SUBSCRIBE, r#"{"success":false}"#);
        });
        assert_eq!((told, stop), (vec![], Stop::NotFollowed));
        // A sway that closes before it answers.
        let (told, stop) = run(root.path(), |_| {});
        assert_eq!((told, stop), (vec![], Stop::NotFollowed));
    }

    #[test]
    fn a_payload_over_the_cap_or_another_magic_ends_it() {
        let root = proc_root();
        // A tree padded with JSON's own spaces to one byte over the cap: read whole, it would name Code.
        let mut over = TREE_CODE.as_bytes().to_vec();
        over.resize(PAYLOAD_MAX + 1, b' ');
        let (told, stop) = run(root.path(), move |sway| {
            subscribed(sway);
            // Refused once its header is read: the rest cannot be written to a side that has closed.
            let _ = sway.write_all(&message(GET_TREE, &over));
        });
        assert_eq!((told, stop), (vec![], Stop::Ended));

        let (told, stop) = run(root.path(), |sway| {
            subscribed(sway);
            let mut other = message(GET_TREE, TREE_CODE.as_bytes());
            other[..6].copy_from_slice(b"i3-ipx");
            let _ = sway.write_all(&other);
        });
        assert_eq!((told, stop), (vec![], Stop::Ended));
    }

    #[test]
    fn the_tree_is_walked_through_floating_nodes() {
        let root = proc_root();
        let (told, _) = run(root.path(), |sway| {
            subscribed(sway);
            send(sway, GET_TREE, TREE_FLOATING);
        });
        assert_eq!(told, ["code"]);
    }
}
