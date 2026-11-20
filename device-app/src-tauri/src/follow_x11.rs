//! The ChatGPT follow on Linux X11: property changes on the root (`_NET_ACTIVE_WINDOW`) and on the active window
//! say when the title changed, and the title is the window's `_NET_WM_NAME`, else its `WM_NAME`.

use crate::follow::{AxTrust, CHATGPT_PROGRAM, ChatgptWindow, FollowSwitch, Heard, program_installed, runs_program};
use crate::front_x11::property32;
use std::error::Error;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::sync::{Arc, Mutex};
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xproto::{Atom, AtomEnum, ChangeWindowAttributesAux, ConnectionExt as _, EventMask, Window};
use x11rb::rust_connection::RustConnection;

/// The bytes of a title property read. A title the watch keeps (TITLE_MAX UTF-16 units) is at most 768 bytes of
/// UTF-8; one cut here is over TITLE_MAX units, or not UTF-8, either way the empty title, as it would be whole.
const TITLE_BYTES: u32 = 1024;

/// The window whose properties the observer is told of: ChatGPT's active window, and only while it is.
#[derive(Default)]
pub struct ActiveMask(Option<u32>);

impl ActiveMask {
    /// The window to stop hearing and the one to start hearing, when the active window is now `active`.
    pub fn moved(&mut self, active: Option<u32>) -> (Option<u32>, Option<u32>) {
        if active == self.0 {
            return (None, None);
        }
        (std::mem::replace(&mut self.0, active), active)
    }
}

/// Whether a change of property `atom` changes the title: `WM_NAME` is the title only without `_NET_WM_NAME`.
pub fn reads(atom: u32, has_net_name: bool, net_name: u32, wm_name: u32) -> bool {
    atom == net_name || (atom == wm_name && !has_net_name)
}

/// How `WM_NAME`'s bytes are encoded, by the property's type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WmNameType {
    /// `UTF8_STRING`.
    Utf8,
    /// `STRING`, which X defines as Latin-1.
    Latin1,
    /// `COMPOUND_TEXT` or any other: not decoded.
    Other,
}

/// The title: `_NET_WM_NAME` as UTF-8 when the window has it, else `WM_NAME` by its type.
pub fn title(net_name: Option<&[u8]>, wm_name: Option<(WmNameType, &[u8])>) -> Option<String> {
    if let Some(bytes) = net_name {
        return String::from_utf8(bytes.to_vec()).ok();
    }
    match wm_name? {
        (WmNameType::Utf8, bytes) => String::from_utf8(bytes.to_vec()).ok(),
        (WmNameType::Latin1, bytes) => Some(bytes.iter().map(|&byte| char::from(byte)).collect()),
        (WmNameType::Other, _) => None,
    }
}

/// The X11 door: the active window's title on a connection of its own, and Harness's switch for the permission.
pub struct X11Follow {
    /// The session's DISPLAY.
    display: String,
    switch: Arc<FollowSwitch>,
}

impl X11Follow {
    pub fn new(display: String, switch: Arc<FollowSwitch>) -> X11Follow {
        X11Follow { display, switch }
    }

    /// Observes on a thread of its own, with `chatgpt` telling ChatGPT's pid apart.
    fn observe_with(
        &self,
        chatgpt: impl Fn(u32) -> bool + Send + 'static,
        heard: Box<dyn Fn(Heard) + Send + Sync>,
    ) -> Box<dyn Send> {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let held = shared.clone();
        let display = self.display.clone();
        let heard: Arc<dyn Fn(Heard) + Send + Sync> = Arc::from(heard);
        let told = heard.clone();
        // Connecting can wait on a remote display: never on the runner's follow thread.
        let spawned = std::thread::Builder::new().name("chatgpt-observer".into()).spawn(move || {
            let Ok((conn, root, atoms)) = connect(&display) else { return told(Heard::NoObserver) };
            let conn = Arc::new(conn);
            {
                let mut shared = held.lock().unwrap();
                if shared.stopped {
                    return;
                }
                shared.conn = Some(conn.clone());
            }
            let observer = Observer { conn: &conn, root, atoms, chatgpt: &chatgpt, heard: &*told };
            observer.follow();
        });
        if spawned.is_err() {
            heard(Heard::NoObserver);
        }
        Box::new(Observation(shared))
    }
}

impl ChatgptWindow for X11Follow {
    fn installed(&self) -> bool {
        program_installed(Path::new(CHATGPT_PROGRAM))
    }

    fn observe(&self, heard: Box<dyn Fn(Heard) + Send + Sync>) -> Option<Box<dyn Send>> {
        let chatgpt = |pid| runs_program(Path::new("/proc"), pid, Path::new(CHATGPT_PROGRAM));
        Some(self.observe_with(chatgpt, heard))
    }
}

impl AxTrust for X11Follow {
    fn trusted(&self) -> bool {
        self.switch.on()
    }

    fn prompt(&self) {}

    fn start(&self, changed: Box<dyn Fn() + Send + Sync>) {
        self.switch.start(changed);
    }

    fn switch(&self, on: bool) {
        self.switch.set(on);
    }
}

/// What the observer's thread and its observation share.
#[derive(Default)]
struct Shared {
    stopped: bool,
    conn: Option<Arc<RustConnection>>,
}

/// An observation: dropped, it shuts its connection's socket down, which wakes the thread's wait for an event and
/// ends the thread, and returns at once.
struct Observation(Arc<Mutex<Shared>>);

impl Drop for Observation {
    fn drop(&mut self) {
        let mut shared = self.0.lock().unwrap();
        shared.stopped = true;
        if let Some(conn) = &shared.conn {
            // SAFETY: the connection, held here, keeps its socket open; shutdown only ends its traffic.
            unsafe { libc::shutdown(conn.stream().as_raw_fd(), libc::SHUT_RDWR) };
        }
    }
}

/// The atoms the observer reads.
#[derive(Clone, Copy)]
struct Atoms {
    active: Atom,
    pid: Atom,
    net_name: Atom,
    utf8: Atom,
}

/// A connection to `display` told each change of the root window's properties, with the root and the atoms.
fn connect(display: &str) -> Result<(RustConnection, Window, Atoms), Box<dyn Error>> {
    let (conn, screen) = x11rb::connect(Some(display))?;
    let root = conn.setup().roots[screen].root;
    let mut atoms = [x11rb::NONE; 4];
    let names = [b"_NET_ACTIVE_WINDOW".as_slice(), b"_NET_WM_PID", b"_NET_WM_NAME", b"UTF8_STRING"];
    for (atom, name) in atoms.iter_mut().zip(names) {
        *atom = conn.intern_atom(false, name)?.reply()?.atom;
    }
    let [active, pid, net_name, utf8] = atoms;
    // Asked for before the first read, so a change between the two is not missed.
    let mask = ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE);
    conn.change_window_attributes(root, &mask)?.check()?;
    Ok((conn, root, Atoms { active, pid, net_name, utf8 }))
}

/// The observer's thread: the active window, while it is ChatGPT's, and its title.
struct Observer<'a> {
    conn: &'a RustConnection,
    root: Window,
    atoms: Atoms,
    chatgpt: &'a dyn Fn(u32) -> bool,
    heard: &'a dyn Fn(Heard),
}

impl Observer<'_> {
    /// The title now, then at each change, until the connection ends.
    fn follow(&self) {
        let mut mask = ActiveMask::default();
        let mut window = self.active_changed(&mut mask);
        let mut has_net_name = self.read(window);
        loop {
            match self.conn.wait_for_event() {
                Err(_) => return,
                Ok(Event::PropertyNotify(event)) if event.window == self.root && event.atom == self.atoms.active => {
                    window = self.active_changed(&mut mask);
                    has_net_name = self.read(window);
                }
                Ok(Event::PropertyNotify(event))
                    if Some(event.window) == window
                        && reads(event.atom, has_net_name, self.atoms.net_name, AtomEnum::WM_NAME.into()) =>
                {
                    has_net_name = self.read(window);
                }
                Ok(_) => {}
            }
        }
    }

    /// The active window when it is ChatGPT's, its properties heard from now on; another window is no title.
    fn active_changed(&self, mask: &mut ActiveMask) -> Option<Window> {
        let (conn, atoms) = (self.conn, self.atoms);
        let active = property32(conn, self.root, atoms.active, AtomEnum::WINDOW, 1)
            .first()
            .copied()
            .filter(|&w| w != x11rb::NONE);
        let pid = active.and_then(|window| property32(conn, window, atoms.pid, AtomEnum::CARDINAL, 1).first().copied());
        let window = active.filter(|_| pid.is_some_and(self.chatgpt));
        let (unselect, select) = mask.moved(window);
        // A window gone answers an error, and is heard no more: neither is worth a word.
        for (window, events) in [(unselect, EventMask::NO_EVENT), (select, EventMask::PROPERTY_CHANGE)] {
            if let Some(window) = window {
                let mask = ChangeWindowAttributesAux::new().event_mask(events);
                if let Ok(cookie) = conn.change_window_attributes(window, &mask) {
                    cookie.ignore_error();
                }
            }
        }
        // Sent before the title is read, so a change between the two is not missed.
        let _ = conn.flush();
        window
    }

    /// Tells `window`'s title, none without a window, and whether it has `_NET_WM_NAME`.
    fn read(&self, window: Option<Window>) -> bool {
        let Some(window) = window else {
            (self.heard)(Heard::Title(None));
            return false;
        };
        let net_name = self.text(window, self.atoms.net_name);
        let wm_name = net_name.is_none().then(|| self.text(window, AtomEnum::WM_NAME.into())).flatten();
        let kind = |kind: Atom| match kind {
            kind if kind == self.atoms.utf8 => WmNameType::Utf8,
            kind if kind == u32::from(AtomEnum::STRING) => WmNameType::Latin1,
            _ => WmNameType::Other,
        };
        let wm_name = wm_name.as_ref().map(|(type_, bytes)| (kind(*type_), bytes.as_slice()));
        (self.heard)(Heard::Title(title(net_name.as_ref().map(|(_, bytes)| bytes.as_slice()), wm_name)));
        net_name.is_some()
    }

    /// A window's text property, its type and up to TITLE_BYTES of it: none when it is unset or the window is gone.
    fn text(&self, window: Window, property: Atom) -> Option<(Atom, Vec<u8>)> {
        let cookie = self.conn.get_property(false, window, property, AtomEnum::ANY, 0, TITLE_BYTES / 4).ok()?;
        let reply = cookie.reply().ok()?;
        (reply.type_ != x11rb::NONE).then_some((reply.type_, reply.value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAIT: std::time::Duration = std::time::Duration::from_secs(5);
    const NET_NAME: u32 = 300;
    const WM_NAME: u32 = 39;

    #[test]
    fn the_mask_moves_with_the_active_window() {
        let mut mask = ActiveMask::default();
        assert_eq!(mask.moved(Some(7)), (None, Some(7)));
        assert_eq!(mask.moved(Some(8)), (Some(7), Some(8)));
        assert_eq!(mask.moved(Some(8)), (None, None));
        assert_eq!(mask.moved(None), (Some(8), None));
        assert_eq!(mask.moved(None), (None, None));
    }

    #[test]
    fn net_wm_name_is_always_read_and_wm_name_only_without_it() {
        assert!(reads(NET_NAME, true, NET_NAME, WM_NAME));
        assert!(reads(NET_NAME, false, NET_NAME, WM_NAME));
        assert!(reads(WM_NAME, false, NET_NAME, WM_NAME));
        assert!(!reads(WM_NAME, true, NET_NAME, WM_NAME));
        // `_NET_WM_PID`, `WM_CLASS`, `_NET_WM_STATE`: never the title.
        for other in [301, 67, 302] {
            assert!(!reads(other, false, NET_NAME, WM_NAME), "{other}");
        }
    }

    #[test]
    fn the_title_is_net_wm_name_as_utf8_first_else_wm_name_by_its_type() {
        let wm = |kind, bytes: &'static [u8]| Some((kind, bytes));
        assert_eq!(
            title(Some("Fix login ✓".as_bytes()), wm(WmNameType::Latin1, b"Other")).as_deref(),
            Some("Fix login ✓")
        );
        assert_eq!(title(None, wm(WmNameType::Utf8, "Plan the trip ✓".as_bytes())).as_deref(), Some("Plan the trip ✓"));
        assert_eq!(title(None, wm(WmNameType::Latin1, b"Caf\xe9")).as_deref(), Some("Café"));
        // COMPOUND_TEXT and any other type: no title.
        assert_eq!(title(None, wm(WmNameType::Other, b"Fix login")), None);
        assert_eq!(title(None, None), None);
        // The window has `_NET_WM_NAME`: its bytes are the title or none, never WM_NAME's.
        assert_eq!(title(Some(b"Caf\xe9"), wm(WmNameType::Utf8, b"Fix login")), None);
        assert_eq!(title(None, wm(WmNameType::Utf8, b"Caf\xe9")), None);
    }

    #[test]
    fn a_display_with_no_server_is_no_observer_once() {
        let (tell, told) = std::sync::mpsc::channel();
        // A socket no server listens on: no TCP is tried for a `unix:` display.
        let door = X11Follow::new("unix:59000".into(), FollowSwitch::new(true));
        let _observation = door.observe_with(
            |_| true,
            Box::new(move |heard| {
                let _ = tell.send(heard);
            }),
        );
        assert_eq!(told.recv_timeout(WAIT), Ok(Heard::NoObserver));
        assert_eq!(told.recv_timeout(WAIT), Err(std::sync::mpsc::RecvTimeoutError::Disconnected));
    }

    #[test]
    fn the_permission_is_the_switch() {
        let door = X11Follow::new(":0".into(), FollowSwitch::new(false));
        let told = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = told.clone();
        door.start(Box::new(move || {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        assert!(!door.trusted());
        door.switch(true);
        assert!(door.trusted());
        assert_eq!(told.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// Under Xvfb, with no window manager: the test sets the root's `_NET_ACTIVE_WINDOW` itself. Its name holds no
    /// `x11_live`: PR CI's `--ignored x11_live` filter is front_x11's test alone.
    #[test]
    #[ignore = "needs an X server on DISPLAY"]
    fn follow_x11_xvfb() {
        use x11rb::protocol::xproto::{CreateWindowAux, PropMode, WindowClass};
        use x11rb::wrapper::ConnectionExt as _;

        let display = std::env::var("DISPLAY").expect("an X server on DISPLAY");
        let (conn, screen) = x11rb::connect(Some(&display)).unwrap();
        let root = conn.setup().roots[screen].root;
        let [active, wm_pid, net_name, utf8] =
            [b"_NET_ACTIVE_WINDOW".as_slice(), b"_NET_WM_PID", b"_NET_WM_NAME", b"UTF8_STRING"]
                .map(|name| conn.intern_atom(false, name).unwrap().reply().unwrap().atom);
        let window = |pid: u32| {
            let window = conn.generate_id().unwrap();
            let aux = CreateWindowAux::new();
            conn.create_window(0, window, root, 0, 0, 1, 1, 0, WindowClass::INPUT_OUTPUT, 0, &aux)
                .unwrap()
                .check()
                .unwrap();
            conn.change_property32(PropMode::REPLACE, window, wm_pid, AtomEnum::CARDINAL, &[pid])
                .unwrap()
                .check()
                .unwrap();
            window
        };
        // Each change is made once the server has it, so the observer is told of each in order.
        let activate = |window: Window| {
            conn.change_property32(PropMode::REPLACE, root, active, AtomEnum::WINDOW, &[window])
                .unwrap()
                .check()
                .unwrap()
        };
        let set = |window: Window, property: Atom, kind: Atom, value: &[u8]| {
            conn.change_property8(PropMode::REPLACE, window, property, kind, value).unwrap().check().unwrap()
        };
        let chatgpt = window(std::process::id());
        // pid 1 is never this test.
        let other = window(1);
        activate(chatgpt);

        let (tell, told) = std::sync::mpsc::channel();
        let own = std::process::id();
        let door = X11Follow::new(display, FollowSwitch::new(true));
        let observation = door.observe_with(
            move |pid| pid == own,
            Box::new(move |heard| {
                let _ = tell.send(heard);
            }),
        );
        let next = || told.recv_timeout(WAIT).expect("a title within 5 s");
        let titled = |title: &str| Heard::Title(Some(title.into()));
        // The window has no title yet; each read below waits for the one before, so none is skipped.
        assert_eq!(next(), Heard::Title(None));
        set(chatgpt, net_name, utf8, b"Fix login");
        assert_eq!(next(), titled("Fix login"));
        set(chatgpt, net_name, utf8, b"Plan the trip");
        assert_eq!(next(), titled("Plan the trip"));
        // WM_NAME is not the title while `_NET_WM_NAME` is: no read, so the next heard is the delete's.
        set(chatgpt, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into(), b"Caf\xe9");
        conn.delete_property(chatgpt, net_name).unwrap().check().unwrap();
        assert_eq!(next(), titled("Café"));
        set(chatgpt, AtomEnum::WM_NAME.into(), utf8, "Fix login ✓".as_bytes());
        assert_eq!(next(), titled("Fix login ✓"));
        // Another program's window in front is no title, and ChatGPT retitled behind it is not heard.
        set(other, net_name, utf8, b"Other");
        activate(other);
        assert_eq!(next(), Heard::Title(None));
        set(chatgpt, AtomEnum::WM_NAME.into(), utf8, b"Behind");
        set(other, net_name, utf8, b"Other again");
        activate(chatgpt);
        assert_eq!(next(), titled("Behind"));
        // Dropped, the observation ends its thread, which lets go of `heard`.
        drop(observation);
        assert_eq!(told.recv_timeout(WAIT), Err(std::sync::mpsc::RecvTimeoutError::Disconnected));
    }
}
