//! What the menu refreshes on each tick where the system tells the app nothing.

use crate::types::Event;

/// What a click on the tray icon tells: the menu is opening.
pub fn menu_opened(now: u64, desktop_installed: bool) -> Event {
    Event::MenuOpened { now, desktop_installed }
}

/// What the timer tells. Linux's tray gives no click (its menu opens by itself), so each tick also tells what a click
/// would, behind the same throttles; `desktop_installed` is read there only.
pub fn tick(os: &str, now: u64, desktop_running: bool, desktop_installed: &dyn Fn() -> bool) -> Vec<Event> {
    let mut events = vec![Event::Tick { now, desktop_running }];
    if os == "linux" {
        events.push(menu_opened(now, desktop_installed()));
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn linux_refreshes_from_the_tick_and_no_other_os_does() {
        let asked = Cell::new(0);
        let installed = || {
            asked.set(asked.get() + 1);
            true
        };
        let ticked = Event::Tick { now: 7, desktop_running: true };

        assert_eq!(tick("linux", 7, true, &installed), [ticked.clone(), menu_opened(7, true)]);
        assert_eq!(asked.get(), 1);
        // A click tells the others when the menu opens: their tick reads nothing more.
        for os in ["macos", "windows"] {
            assert_eq!(tick(os, 7, true, &installed), std::slice::from_ref(&ticked), "{os}");
        }
        assert_eq!(asked.get(), 1);
        assert_eq!(menu_opened(9, false), Event::MenuOpened { now: 9, desktop_installed: false });
    }
}
