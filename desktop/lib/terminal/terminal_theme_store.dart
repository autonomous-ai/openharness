import 'package:flutter/foundation.dart';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';

/// A colour scheme the terminal is allowed to draw itself in.
///
/// Separate from [HarnessPalette] on purpose. The app's palette dresses the
/// window — sidebar, tabs, dialogs — and until this existed the terminal's
/// ground was simply borrowed from it, so the only way to sit an agent on a
/// different colour was to repaint the whole app. That is one value answering
/// two questions: "what colour is Harness" and "what colour is the screen a
/// remote program is drawing into". They are not the same question, and the
/// font settings beside this one already answer the second independently.
///
/// Deliberately a closed enum rather than free colour fields: sixteen ANSI
/// slots plus foreground, background, cursor and selection is a surface no
/// preferences pane can make legible, and a half-chosen ramp renders TUIs
/// unreadable in ways the user cannot attribute to what they changed. Adding a
/// scheme later is one value here and one `const` in `terminal_theme.dart`.
enum TerminalThemeChoice {
  /// Today's behaviour, and still the default: ground and cursor follow the
  /// palette chosen in Customize OpenHarness ▸ Appearance, ANSI ramp from `darkTerminalTheme`.
  matchApp('Match app appearance', 'Matches your app palette'),

  /// ⚠️ Named for the PALETTE, not for the distribution that popularised it.
  /// These sixteen colours are the Tango Desktop Project's, which GNOME
  /// Terminal ships as its built-in `Tango` scheme. Calling it "Ubuntu" would
  /// name a downstream of it and leave nothing to call the scheme itself when a
  /// second one arrives.
  ///
  /// The one thing here that is NOT Tango is the ground: `#300A24` is Ubuntu's
  /// own aubergine, set as a custom text colour over the Tango palette. Tango's
  /// own dark is `#2E3436` — kept below as `black`, where it belongs.
  tango('Tango', "GNOME Terminal's palette on Ubuntu's aubergine ground");

  const TerminalThemeChoice(this.label, this.detail);

  /// What the picker row says.
  final String label;

  /// The second line under it — what changes, in the user's terms.
  final String detail;

  /// What a fresh install opens with, and what a reset returns to.
  static const fallback = matchApp;
}

/// The user's chosen terminal colour scheme, remembered across launches.
///
/// A [ValueNotifier] singleton over [HarnessFileStore], loaded by
/// `loadPersistedSettings()` before the first frame — see that function's doc
/// for why a store that loads late is worse than one that never persisted.
///
/// Unlike [TerminalFontStore] the value here is the *choice*, not a resolved
/// theme: a resolved [TerminalTheme] depends on the app palette too (for
/// [TerminalThemeChoice.matchApp]), and caching that pairing belongs with the
/// colours in `terminal_theme.dart` rather than in the thing that remembers a
/// preference.
class TerminalThemeStore extends ValueNotifier<TerminalThemeChoice> {
  TerminalThemeStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared,
      super(TerminalThemeChoice.fallback);

  static const _key = 'terminal_theme';

  final LocalKeyValueStore _storage;

  /// Read the saved choice, if there is one. Failure — or a scheme name from a
  /// build that had one this one does not — is silent and lands on the default.
  /// An unreadable state file is not a reason to refuse to start.
  /// Uses the same batch-read API as [TerminalFontStore] and
  /// [AppearancePrefsStore]. Each load observes its own current snapshot.
  Future<void> load() async {
    try {
      final saved = await _storage.readMany([_key]);
      value =
          TerminalThemeChoice.values
              .where((choice) => choice.name == saved[_key])
              .firstOrNull ??
          TerminalThemeChoice.fallback;
    } catch (_) {
      value = TerminalThemeChoice.fallback;
    }
  }

  Future<void> set(TerminalThemeChoice choice) async {
    if (choice == value) return;
    value = choice;
    try {
      await _storage.write(_key, choice.name);
    } catch (_) {
      // Kept in memory for this run; see load()'s doc.
    }
  }

  Future<void> reset() => set(TerminalThemeChoice.fallback);

  /// Whether the current pick *is* the default — so a Reset control can say it
  /// has nothing to do.
  bool get isDefault => value == TerminalThemeChoice.fallback;
}

/// The one instance the app reads. Lives here rather than beside `main()` for
/// the same reason [terminalFontStore] does: the terminal panel and the
/// Settings pane must not reach into the entrypoint for it.
final terminalThemeStore = TerminalThemeStore();
