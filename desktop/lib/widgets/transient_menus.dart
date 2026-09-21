/// Menus the app draws in an [Overlay] rather than as a modal route.
///
/// An overlay menu dismisses itself when a pointer goes down somewhere else in the Flutter view —
/// that much it can see. What it CANNOT see is a click on native chrome: the window's AppKit tab
/// strip and menu bar are not part of Flutter's hit testing, so switching tabs from the titlebar
/// left a menu floating over the tab it no longer belonged to.
///
/// So the native side says so. Every entry point that learns "the titlebar was used" calls
/// [dismissTransientMenus], the same way it already closes the search field.
library;

/// Close callbacks for every overlay menu currently on screen.
final List<void Function()> _open = <void Function()>[];

/// Register [close] while a menu is showing. The returned callback deregisters it.
void Function() registerTransientMenu(void Function() close) {
  _open.add(close);
  return () => _open.remove(close);
}

/// Close every overlay menu. Safe to call when none are open.
void dismissTransientMenus() {
  // Over a COPY: each close deregisters itself, which would otherwise mutate the list being walked.
  for (final close in List<void Function()>.of(_open)) {
    close();
  }
}
