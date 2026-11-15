//! The tabs of Terminal, iTerm2 and Ghostty on macOS, through three fixed scripts run in this process by
//! `NSAppleScript`: macOS asks the person once to let Harness Device control each app, and the daemon sends no event.
//! A tty reaches a script only as a handler's parameter, after the tty check, and never as script text.

use crate::tabs::{Selected, TabApp, TabError, TabScripts, tab_error, tty_ok};
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::AnyObject;
use objc2::{AnyThread, ClassType, msg_send};
use objc2_app_kit::NSRunningApplication;
use objc2_foundation::{
    NSAppleEventDescriptor, NSAppleScript, NSAppleScriptErrorNumber, NSDictionary, NSNumber, NSString,
};
use std::sync::OnceLock;
use std::sync::mpsc::{self, Sender};
use std::thread;

// Each app's terms are written by their codes (from its scripting dictionary) and the app is named only at run time,
// so a source compiles on a Mac without that app, compiling sends no event, and an app whose dictionary lacks a term
// answers an error number instead of failing to compile. Every event is inside a 2 s timeout (tabs::CALL_TIMEOUT).
// Each handler that tells its app first asks AppleScript, with no event, whether it runs: `tell application id`
// launches one that does not, and it may have quit since the runner asked.
// With no visible window `selected_tty` answers the empty string; each select answers whether a tab held `t`.

const TERMINAL: &str = r#"
-- Terminal: «class cwin» window, «property pvis» visible, «property pidx» index, «property tcnt» selected tab,
-- «class ttab» tab, «property ttty» tty.
property app_id : "com.apple.Terminal"

on selected_tty()
	if not (running of application id app_id) then return ""
	with timeout of 2 seconds
		tell application id app_id
			repeat with w in (every «class cwin» whose «property pvis» is true)
				return «property ttty» of «property tcnt» of w
			end repeat
		end tell
	end timeout
	return ""
end selected_tty

on select_tty(t, in_front)
	if not (running of application id app_id) then return false
	with timeout of 2 seconds
		tell application id app_id
			repeat with w in (every «class cwin» whose «property pvis» is true)
				set held to every «class ttab» of w whose «property ttty» is t
				if held is not {} then
					set «property tcnt» of w to item 1 of held
					if in_front then set «property pidx» of w to 1
					return true
				end if
			end repeat
		end tell
	end timeout
	return false
end select_tty

on focus_tty(t)
	return select_tty(t, true)
end focus_tty
"#;

const ITERM: &str = r#"
-- iTerm2: «class cwin» window, «property pvis» visible, «property Crwn» current window, «property Wcsn» current
-- session, «class Trmt» tab, «class Trms» session, «property Stty» tty, «event Itrmslct» select.
property app_id : "com.googlecode.iterm2"

on selected_tty()
	if not (running of application id app_id) then return ""
	with timeout of 2 seconds
		tell application id app_id
			set shown to every «class cwin» whose «property pvis» is true
			if shown is {} then return ""
			return «property Stty» of «property Wcsn» of «property Crwn»
		end tell
	end timeout
end selected_tty

on select_tty(t, in_front)
	if not (running of application id app_id) then return false
	with timeout of 2 seconds
		tell application id app_id
			repeat with w in (every «class cwin» whose «property pvis» is true)
				repeat with k in (every «class Trmt» of w)
					set held to every «class Trms» of k whose «property Stty» is t
					if held is not {} then
						«event Itrmslct» k
						«event Itrmslct» (item 1 of held)
						if in_front then «event Itrmslct» w
						return true
					end if
				end repeat
			end repeat
		end tell
	end timeout
	return false
end select_tty

on focus_tty(t)
	return select_tty(t, true)
end focus_tty
"#;

// Ghostty's `select tab` may bring Ghostty forward, so a swipe selects only while it is in front.
const GHOSTTY: &str = r#"
-- Ghostty: «class Gwnd» window, «property GFWn» front window, «property GWsT» selected tab, «class Gtab» tab,
-- «property GTfT» focused terminal, «class Gtrm» terminal, «property Gtty» tty, «event GhstSlTb» select tab.
property app_id : "com.mitchellh.ghostty"

on selected_tty()
	if not (running of application id app_id) then return ""
	with timeout of 2 seconds
		tell application id app_id
			-- A window, tab or terminal that is not there is no tab: only reading the tty itself may say Ghostty has none.
			try
				set k to «property GTfT» of «property GWsT» of «property GFWn»
			on error number n
				if n is -1728 then return ""
				error number n
			end try
			if k is missing value then return ""
			return «property Gtty» of k
		end tell
	end timeout
end selected_tty

on select_tty(t, in_front)
	if not (running of application id app_id) then return false
	if not in_front then return false
	with timeout of 2 seconds
		tell application id app_id
			repeat with w in (every «class Gwnd»)
				repeat with k in (every «class Gtab» of w)
					set held to every «class Gtrm» of k whose «property Gtty» is t
					if held is not {} then
						«event GhstSlTb» k
						return true
					end if
				end repeat
			end repeat
		end tell
	end timeout
	return false
end select_tty

on focus_tty(t)
	return select_tty(t, true)
end focus_tty
"#;

/// Harness Device's own table: the app a line names picks one of these, and nothing of the line reaches its text.
fn source(app: TabApp) -> &'static str {
    match app {
        TabApp::Terminal => TERMINAL,
        TabApp::Iterm => ITERM,
        TabApp::Ghostty => GHOSTTY,
    }
}

/// AppleScript's general error (errOSAGeneralError), for a failure that carries no number: the script thread gone.
const GENERAL_ERROR: i64 = -2700;

const fn code(four: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*four)
}

/// The Apple Event that calls a script's handler (kASAppleScriptSuite, kASSubroutineEvent), its keywords for the
/// handler's name and its parameters (keyASSubroutineName, keyDirectObject), and Carbon's "any" ids.
const SUITE: u32 = code(b"ascr");
const SUBROUTINE: u32 = code(b"psbr");
const HANDLER_NAME: u32 = code(b"snam");
const PARAMETERS: u32 = code(b"----");
const AUTO_RETURN_ID: i16 = -1;
const ANY_TRANSACTION: i32 = 0;

/// A handler's parameter. It becomes a descriptor on the script thread, after the tty check.
enum Arg {
    Text(String),
    Flag(bool),
}

/// Each source compiled, kept by the script thread: an `NSAppleScript` never leaves it.
type Compiled = Vec<(&'static str, Retained<NSAppleScript>)>;
type Job = Box<dyn FnOnce(&mut Compiled) + Send>;

/// Runs `job` on the one thread that holds every `NSAppleScript` of this process, and waits for its answer; None when
/// that thread is gone. AppleScript run on two threads at once mixes their calls up (a handler is not found, -1708).
/// On a thread of its own, a call the consent prompt holds for minutes holds neither AppKit's main thread nor anything
/// else.
fn on_script_thread<T: Send + 'static>(job: impl FnOnce(&mut Compiled) -> T + Send + 'static) -> Option<T> {
    static JOBS: OnceLock<Sender<Job>> = OnceLock::new();
    let jobs = JOBS.get_or_init(|| {
        let (jobs, todo) = mpsc::channel::<Job>();
        // A thread that does not start drops `todo`: every call then fails, and the failed polls are counted.
        let _ = thread::Builder::new().name("tabs".into()).spawn(move || {
            let mut compiled = Compiled::new();
            for job in todo {
                autoreleasepool(|_| job(&mut compiled));
            }
        });
        jobs
    });
    let (answer, answered) = mpsc::sync_channel(1);
    jobs.send(Box::new(move |compiled: &mut Compiled| {
        let _ = answer.send(job(compiled));
    }))
    .ok()?;
    answered.recv().ok()
}

/// Calls `handler` of `source` with `args`; `read` turns the answer into a value on the script thread. An error is
/// AppleScript's number for it.
fn call<T: Send + 'static>(
    source: &'static str,
    handler: &'static str,
    args: Vec<Arg>,
    read: fn(&NSAppleEventDescriptor) -> T,
) -> Result<T, i64> {
    on_script_thread(move |compiled| run(compiled, source, handler, &args).map(|answer| read(&answer)))
        .unwrap_or(Err(GENERAL_ERROR))
}

/// The fixed scripts, run on the script thread.
pub struct MacTabs {
    /// Always `source`, but in tests, which stand a script that answers with no event in for an app's.
    source: fn(TabApp) -> &'static str,
}

impl Default for MacTabs {
    fn default() -> MacTabs {
        MacTabs { source }
    }
}

impl MacTabs {
    /// A swipe's or a tap's select. A tty that fails the check is refused before any descriptor is made.
    fn select(&self, app: TabApp, handler: &'static str, tty: &str, front: Option<bool>) -> Result<Selected, TabError> {
        if !tty_ok(tty) {
            return Err(TabError::Failed);
        }
        let mut args = vec![Arg::Text(tty.to_string())];
        args.extend(front.map(Arg::Flag));
        let held = call((self.source)(app), handler, args, flag).map_err(|code| tab_error(app, code))?;
        Ok(if held { Selected::Done } else { Selected::NoTab })
    }
}

impl TabScripts for MacTabs {
    fn running(&self, app: TabApp) -> bool {
        runs(app.bundle())
    }

    fn selected_tty(&self, app: TabApp) -> Result<Option<String>, TabError> {
        let tty = call((self.source)(app), "selected_tty", Vec::new(), text).map_err(|code| tab_error(app, code))?;
        Ok(Some(tty).filter(|tty| !tty.is_empty()))
    }

    fn select_tty(&self, app: TabApp, tty: &str, frontmost: bool) -> Result<Selected, TabError> {
        self.select(app, "select_tty", tty, Some(frontmost))
    }

    fn focus_tty(&self, app: TabApp, tty: &str) -> Result<Selected, TabError> {
        self.select(app, "focus_tty", tty, None)
    }
}

/// From LaunchServices: asking the app would be an Apple Event, which launches an app that does not run.
fn runs(bundle: &str) -> bool {
    autoreleasepool(|_| {
        !NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle)).is_empty()
    })
}

/// On the script thread: compiles `source` at its first call, then calls `handler`.
fn run(
    compiled: &mut Compiled,
    source: &'static str,
    handler: &str,
    args: &[Arg],
) -> Result<Retained<NSAppleEventDescriptor>, i64> {
    let at = match compiled.iter().position(|(known, _)| *known == source) {
        Some(at) => at,
        None => {
            compiled.push((source, compile(source)?));
            compiled.len() - 1
        }
    };
    let event = handler_call(handler, args);
    let mut error: Option<Retained<NSDictionary<NSString, AnyObject>>> = None;
    // SAFETY: the event is a whole handler call and `error` is the dictionary NSAppleScript writes. objc2-foundation's
    // binding says the answer is never nil, which it is on an error, so the message is sent with an Option.
    let answer: Option<Retained<NSAppleEventDescriptor>> =
        unsafe { msg_send![&*compiled[at].1, executeAppleEvent: &*event, error: &mut error] };
    answer.ok_or_else(|| error_number(error.as_deref()))
}

fn compile(source: &str) -> Result<Retained<NSAppleScript>, i64> {
    let script =
        NSAppleScript::initWithSource(NSAppleScript::alloc(), &NSString::from_str(source)).ok_or(GENERAL_ERROR)?;
    let mut error = None;
    // SAFETY: `error` is the dictionary NSAppleScript writes.
    if unsafe { script.compileAndReturnError(Some(&mut error)) } {
        Ok(script)
    } else {
        Err(error_number(error.as_deref()))
    }
}

/// The event that calls `handler` with `args` as its positional parameters.
fn handler_call(handler: &str, args: &[Arg]) -> Retained<NSAppleEventDescriptor> {
    let parameters = NSAppleEventDescriptor::listDescriptor();
    for (at, arg) in (1..).zip(args) {
        let item = match arg {
            Arg::Text(text) => NSAppleEventDescriptor::descriptorWithString(&NSString::from_str(text)),
            Arg::Flag(flag) => NSAppleEventDescriptor::descriptorWithBoolean(u8::from(*flag)),
        };
        parameters.insertDescriptor_atIndex(&item, at);
    }
    let target = NSAppleEventDescriptor::currentProcessDescriptor();
    let name = NSAppleEventDescriptor::descriptorWithString(&NSString::from_str(handler));
    // SAFETY: Foundation's selectors with their own argument types (FourCharCode is u32, AEReturnID i16 and
    // AETransactionID i32); objc2-foundation offers them only with a crate this app does not take.
    unsafe {
        let event: Retained<NSAppleEventDescriptor> = msg_send![
            NSAppleEventDescriptor::class(),
            appleEventWithEventClass: SUITE,
            eventID: SUBROUTINE,
            targetDescriptor: &*target,
            returnID: AUTO_RETURN_ID,
            transactionID: ANY_TRANSACTION
        ];
        let () = msg_send![&*event, setParamDescriptor: &*name, forKeyword: HANDLER_NAME];
        let () = msg_send![&*event, setParamDescriptor: &*parameters, forKeyword: PARAMETERS];
        event
    }
}

fn error_number(error: Option<&NSDictionary<NSString, AnyObject>>) -> i64 {
    // SAFETY: a Foundation constant, set before any code runs.
    let key = unsafe { NSAppleScriptErrorNumber };
    error
        .and_then(|error| error.objectForKey(key))
        .and_then(|number| number.downcast::<NSNumber>().ok())
        .map_or(GENERAL_ERROR, |number| number.as_i64())
}

/// A tty, or the empty string with no window.
fn text(answer: &NSAppleEventDescriptor) -> String {
    answer.stringValue().map(|text| text.to_string()).unwrap_or_default()
}

/// Whether a tab held the tty.
fn flag(answer: &NSAppleEventDescriptor) -> bool {
    answer.booleanValue() != 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tabs::{CALL_TIMEOUT, NO_TTY};
    use std::process::Command;
    use std::time::Duration;

    const T: TabApp = TabApp::Terminal;
    const TTY: &str = "/dev/ttys023";
    const APPS: [TabApp; 3] = [TabApp::Terminal, TabApp::Iterm, TabApp::Ghostty];

    /// Answers its parameter, and talks to no app.
    const ECHO: &str = "on echo(t)\n\treturn t\nend echo";

    /// Stands in for Terminal's script, with no event: a tty, the select's front flag back, and whether focus got the
    /// tty it names.
    const ANSWERS: &str = r#"
on selected_tty()
	return "/dev/ttys023"
end selected_tty

on select_tty(t, in_front)
	return in_front
end select_tty

on focus_tty(t)
	return t is "/dev/ttys023"
end focus_tty
"#;

    /// Stands in for iTerm2's: no window, a select denied, and a focus that found a terminal with no tty (tabs::NO_TTY).
    const REFUSES: &str = r#"
on selected_tty()
	return ""
end selected_tty

on select_tty(t, in_front)
	error number -1743
end select_tty

on focus_tty(t)
	error number 1001
end focus_tty
"#;

    /// Stands in for Ghostty's: a terminal that closed between two events, which is no such object or a failed handler.
    const VANISHED: &str = r#"
on selected_tty()
	error number -1728
end selected_tty

on select_tty(t, in_front)
	error number -10000
end select_tty

on focus_tty(t)
	error number -1728
end focus_tty
"#;

    /// Stands in for an app's script in the tty check's test alone: no other test compiles it.
    const SENT: &str =
        "on select_tty(t, in_front)\n\treturn true\nend select_tty\n\non focus_tty(t)\n\treturn true\nend focus_tty";

    /// The text of each script the thread holds for `source`. The thread is the process's own, so tests that run at the
    /// same time each look only at a source of their own.
    fn compiled(source: &'static str) -> Vec<String> {
        on_script_thread(move |compiled| {
            compiled
                .iter()
                .filter(|(known, _)| *known == source)
                .map(|(_, script)| script.source().map(|text| text.to_string()).unwrap_or_default())
                .collect()
        })
        .unwrap()
    }

    #[test]
    fn a_handler_gets_its_parameter_as_a_descriptor() {
        assert_eq!(call(ECHO, "echo", vec![Arg::Text(TTY.into())], text), Ok(TTY.to_string()));
        assert_eq!(call(ECHO, "echo", vec![Arg::Text("/dev/ttys9".into())], text), Ok("/dev/ttys9".to_string()));
        // Compiled once, at its first call, and neither tty is in what was compiled.
        let sources = compiled(ECHO);
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert!(sources[0].contains("on echo(t)"), "{}", sources[0]);
        assert!(!sources[0].contains("/dev/ttys"), "{}", sources[0]);
    }

    #[test]
    fn the_fixed_sources_hold_no_tty_and_read_nothing_but_ttys_and_selection() {
        for app in APPS {
            let text = source(app).to_lowercase();
            assert!(!text.contains("/dev/ttys"), "{app:?}");
            for word in
                ["activate", "name of", "title", "contents", "history", "working directory", "do script", "keystroke"]
            {
                assert!(!text.contains(word), "{app:?}: {word}");
            }
            // A term written by its code is read by its code: each is a window, a tab, a session or terminal, its tty
            // or what is selected.
            let allowed: &[&str] = match app {
                TabApp::Terminal => {
                    &["class cwin", "property pvis", "property pidx", "property tcnt", "class ttab", "property ttty"]
                }
                TabApp::Iterm => &[
                    "class cwin",
                    "property pvis",
                    "property Crwn",
                    "property Wcsn",
                    "class Trmt",
                    "class Trms",
                    "property Stty",
                    "event Itrmslct",
                ],
                TabApp::Ghostty => &[
                    "class Gwnd",
                    "property GFWn",
                    "property GWsT",
                    "class Gtab",
                    "property GTfT",
                    "class Gtrm",
                    "property Gtty",
                    "event GhstSlTb",
                ],
            };
            let terms: Vec<&str> =
                source(app).split('«').skip(1).map(|rest| rest.split('»').next().unwrap_or_default()).collect();
            assert!(!terms.is_empty(), "{app:?}");
            for term in terms {
                assert!(allowed.contains(&term), "{app:?}: «{term}»");
            }
        }
    }

    #[test]
    fn every_source_compiles() {
        // With every term a code and the app named only at run time, compiling reads no dictionary and sends no event:
        // it passes on a Mac without iTerm2 or Ghostty. On the script thread, as every compile is.
        for app in APPS {
            assert_eq!(on_script_thread(move |_| compile(source(app)).err()), Some(None), "{app:?}");
        }
    }

    #[test]
    fn every_source_has_the_three_handlers() {
        for app in APPS {
            for handler in ["on selected_tty()", "on select_tty(", "on focus_tty("] {
                let count = source(app).lines().filter(|line| line.trim_start().starts_with(handler)).count();
                assert_eq!(count, 1, "{app:?}: {handler}");
            }
        }
    }

    #[test]
    fn every_handler_that_tells_its_app_first_checks_that_it_runs() {
        // `tell application id` launches an app that is not running, and the app may have quit since the runner asked.
        for app in APPS {
            let handlers: Vec<&str> = source(app).split("\non ").skip(1).collect();
            assert_eq!(handlers.len(), 3, "{app:?}");
            for handler in handlers {
                if !handler.contains("tell application") {
                    // It sends no event of its own: it calls one that checks.
                    assert!(!handler.contains('«'), "{app:?}: {handler}");
                    continue;
                }
                let answer = if handler.starts_with("selected_tty()") { r#""""# } else { "false" };
                let first = handler.lines().nth(1).unwrap_or_default().trim();
                assert_eq!(first, format!("if not (running of application id app_id) then return {answer}"), "{app:?}");
            }
        }
    }

    #[test]
    fn each_source_tells_only_its_own_app_within_the_call_timeout() {
        assert_eq!(CALL_TIMEOUT, Duration::from_secs(2));
        for app in APPS {
            let text = source(app);
            assert_eq!(text.matches("property app_id").count(), 1, "{app:?}");
            assert!(text.contains(&format!("property app_id : \"{}\"", app.bundle())), "{app:?}");
            let tells = text.matches("tell application").count();
            assert!(tells > 0, "{app:?}");
            assert_eq!(text.matches("tell application id app_id").count(), tells, "{app:?}");
            assert_eq!(text.matches("with timeout of 2 seconds").count(), tells, "{app:?}");
        }
    }

    #[test]
    fn ghostty_says_it_has_no_tty_only_for_a_terminal_still_there() {
        // A tty read fails the same way when its terminal or tab closed between two events: only one still there
        // means this Ghostty has no tty.
        let no_tty = format!("error number {NO_TTY}");
        for app in [T, TabApp::Iterm] {
            assert!(!source(app).contains(&no_tty), "{app:?}");
        }
        let lines: Vec<&str> = GHOSTTY.lines().map(str::trim).collect();
        let said: Vec<usize> = (0..lines.len()).filter(|&at| lines[at].contains(&no_tty)).collect();
        // selected_tty's read and select_tty's.
        assert_eq!(said.len(), 2, "{GHOSTTY}");
        for at in said {
            assert_eq!(lines[at - 1], "if n is not in {-1728, -10000} then error number n", "{GHOSTTY}");
            assert_eq!(lines[at], format!("if exists k then {no_tty}"), "{GHOSTTY}");
            assert!(lines[at - 3..at - 1].iter().any(|line| line.contains("«property Gtty» of k")), "{GHOSTTY}");
        }
    }

    #[test]
    fn a_tty_that_fails_the_check_is_never_sent() {
        let tabs = MacTabs { source: |_| SENT };
        for bad in ["/dev/ttys023; rm", "/dev/ttys023\n", "/dev/pts/3", "/dev/ttys12345", ""] {
            assert_eq!(tabs.select_tty(T, bad, true), Err(TabError::Failed), "{bad:?}");
            assert_eq!(tabs.focus_tty(T, bad), Err(TabError::Failed), "{bad:?}");
        }
        // No call reached the script thread: its script was not even compiled.
        assert!(compiled(SENT).is_empty());
        // The same calls with a tty that passes are sent.
        assert_eq!(tabs.select_tty(T, TTY, true), Ok(Selected::Done));
        assert_eq!(tabs.focus_tty(T, TTY), Ok(Selected::Done));
        assert_eq!(compiled(SENT).len(), 1);
    }

    #[test]
    fn answers_and_error_numbers_read_as_the_tab_rules_say() {
        let tabs = MacTabs {
            source: |app| match app {
                TabApp::Terminal => ANSWERS,
                TabApp::Iterm => REFUSES,
                TabApp::Ghostty => VANISHED,
            },
        };
        assert_eq!(tabs.selected_tty(T), Ok(Some(TTY.to_string())));
        // The empty string is no window.
        assert_eq!(tabs.selected_tty(TabApp::Iterm), Ok(None));
        // The front flag reaches the handler as its second parameter.
        assert_eq!(tabs.select_tty(T, TTY, true), Ok(Selected::Done));
        assert_eq!(tabs.select_tty(T, TTY, false), Ok(Selected::NoTab));
        assert_eq!(tabs.focus_tty(T, TTY), Ok(Selected::Done));
        assert_eq!(tabs.focus_tty(T, "/dev/ttys024"), Ok(Selected::NoTab));
        // An error's number goes through tab_error.
        assert_eq!(tabs.select_tty(TabApp::Iterm, TTY, true), Err(TabError::Denied));
        assert!(REFUSES.contains(&format!("error number {NO_TTY}")));
        assert_eq!(tabs.focus_tty(TabApp::Iterm, TTY), Err(TabError::NoTty));
        // An object that went away between two events is a failed call, not a Ghostty with no tty.
        assert_eq!(tabs.selected_tty(TabApp::Ghostty), Err(TabError::Failed));
        assert_eq!(tabs.select_tty(TabApp::Ghostty, TTY, true), Err(TabError::Failed));
        assert_eq!(tabs.focus_tty(TabApp::Ghostty, TTY), Err(TabError::Failed));
        // Each source was compiled once.
        assert_eq!((compiled(ANSWERS).len(), compiled(REFUSES).len(), compiled(VANISHED).len()), (1, 1, 1));
    }

    #[test]
    fn an_app_that_is_not_running_reads_as_not_running() {
        assert!(!runs("ai.autonomous.harness.no-such-app"));
        // LaunchServices does answer: the Dock runs in every session a person is logged in to.
        assert!(runs("com.apple.dock"));
    }

    /// The test's own script, which only it runs: it opens and closes Terminal windows of its own, by id.
    const SCRATCH: &str = r#"
on open_window()
	tell application id "com.apple.Terminal"
		set known to id of every window
		do script ""
		repeat with w in (every window)
			if known does not contain (id of w) then return (id of w) as text
		end repeat
	end tell
	return ""
end open_window

on tty_of(w)
	tell application id "com.apple.Terminal" to return tty of selected tab of window id (w as integer)
end tty_of

on raise_window(w)
	tell application id "com.apple.Terminal" to set index of window id (w as integer) to 1
end raise_window

on close_window(w)
	tell application id "com.apple.Terminal" to close window id (w as integer)
end close_window
"#;

    /// The windows the test opened, closed by id when it ends, passed or failed: no other window is touched.
    #[derive(Default)]
    struct Scratch {
        ids: Vec<String>,
    }

    impl Scratch {
        /// A new window's id and its tab's tty.
        fn open(&mut self) -> (String, String) {
            let id = call(SCRATCH, "open_window", Vec::new(), text).unwrap();
            assert!(!id.is_empty(), "no new Terminal window");
            self.ids.push(id.clone());
            let tty = self.tty_of(&id);
            assert!(tty_ok(&tty), "{tty}");
            (id, tty)
        }

        fn tty_of(&self, id: &str) -> String {
            call(SCRATCH, "tty_of", vec![Arg::Text(id.into())], text).unwrap()
        }

        /// Raises the window inside Terminal, as `set index` does: Terminal itself stays where it is.
        fn raise(&self, id: &str) {
            call(SCRATCH, "raise_window", vec![Arg::Text(id.into())], text).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            for id in &self.ids {
                // Never a panic here: a drop that panics while a failed assertion unwinds aborts the test.
                let _ = call(SCRATCH, "close_window", vec![Arg::Text(id.clone())], text);
            }
        }
    }

    /// The app in front, from LaunchServices: AppKit's own answer is not fresh in a process with no run loop.
    fn front_bundle() -> String {
        let front = Command::new("/usr/bin/lsappinfo").arg("front").output().unwrap();
        let front = String::from_utf8(front.stdout).unwrap();
        let info =
            Command::new("/usr/bin/lsappinfo").args(["info", "-only", "bundleid", front.trim()]).output().unwrap();
        String::from_utf8(info.stdout).unwrap().trim().to_string()
    }

    #[test]
    #[ignore = "scripts two Terminal windows of its own: Verification, check 2, on a Mac by hand"]
    fn scratch_terminal_windows() {
        let tabs = MacTabs::default();
        assert!(tabs.running(T), "Terminal must be running: the test opens its windows there and launches nothing");
        let mut scratch = Scratch::default();
        let (first, first_tty) = scratch.open();
        let (second, second_tty) = scratch.open();
        let front = front_bundle();
        assert!(
            !front.contains("\"com.apple.Terminal\""),
            "put another app in front, so the test can see Terminal stay behind it: {front}"
        );

        // Terminal is in the back: a swipe selects the tab and raises nothing.
        assert_eq!(tabs.select_tty(T, &second_tty, false), Ok(Selected::Done));
        assert_eq!(scratch.tty_of(&second), second_tty);
        assert_eq!(tabs.select_tty(T, "/dev/ttys9999", false), Ok(Selected::NoTab));
        assert_eq!(tabs.focus_tty(T, "/dev/ttys9999"), Ok(Selected::NoTab));

        scratch.raise(&first);
        assert_eq!(tabs.selected_tty(T), Ok(Some(first_tty)));
        // A tap raises the window that holds the tty, inside Terminal.
        assert_eq!(tabs.focus_tty(T, &second_tty), Ok(Selected::Done));
        assert_eq!(tabs.selected_tty(T), Ok(Some(second_tty)));

        assert_eq!(front_bundle(), front, "Terminal came forward");
    }
}
