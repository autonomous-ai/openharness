//! What the menu refreshes on each tick where the system tells the app nothing.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Event;
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
            assert_eq!(tick(os, 7, true, &installed), [ticked.clone()], "{os}");
        }
        assert_eq!(asked.get(), 1);
        assert_eq!(menu_opened(9, false), Event::MenuOpened { now: 9, desktop_installed: false });
    }
}
