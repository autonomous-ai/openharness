import '../shared/theme/appearance_prefs_store.dart';
import '../stats/harness_stats.dart';
import '../terminal/terminal_font_store.dart';
import '../terminal/terminal_theme_store.dart';
import '../notify/alert_sounds.dart';

/// Every preference that has to be in place BEFORE the first frame.
///
/// Extracted from `main()` so it can be tested. A store that is never loaded still passes every one
/// of its own tests — it round-trips through disk perfectly — and silently forgets the user's
/// choice at the next launch. Nothing else in the suite would notice, because the only thing wrong
/// is a missing call in the entrypoint. This is that call, in a place a test can reach.
///
/// They are awaited before `runApp` rather than loaded lazily: reading them after the first frame
/// would paint the defaults and then snap to the saved values, which reads as a flicker on every
/// launch.
///
/// The parameters exist for tests; the app passes nothing and gets the singletons the widgets read.
Future<void> loadPersistedSettings({
  TerminalFontStore? terminalFont,
  TerminalThemeStore? terminalTheme,
  AppearancePrefsStore? appearance,
  HarnessStats? stats,
  AlertSoundStore? alertSounds,
}) async {
  // Independent stores may load together, but all must finish before runApp.
  // Font and appearance share a serialized file store; each reads its related
  // preferences as one snapshot. Stats uses a separate file and can overlap.
  await Future.wait([
    (terminalFont ?? terminalFontStore).load(),
    // Beside the font, and for the same reason: loading the scheme after the
    // first frame paints every pane on the default ground and then snaps it to
    // the saved one, which reads as a flash of the wrong colour at every launch.
    (terminalTheme ?? terminalThemeStore).load(),
    // Every control box uses these values. A late load would move the whole
    // window's geometry after its first frame, as well as changing its palette.
    (appearance ?? appearancePrefsStore).load(),
    // Counters begin moving with the first agent event. Loading them later
    // could overwrite a new event with the old count from disk.
    (stats ?? harnessStats).load(),
    // Before the first agent event, not after: the setting decides whether that event makes a
    // noise, and a late read would let one through on the default while the person had it off.
    (alertSounds ?? alertSoundStore).load(),
  ]);
}
