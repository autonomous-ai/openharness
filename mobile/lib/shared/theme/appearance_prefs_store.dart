import 'package:flutter/foundation.dart';

import '../../core/harness_file_store.dart';
import '../../core/local_key_value_store.dart';
import 'app_theme.dart';
import 'color_palette.dart';

/// Light or dark, as Settings opened from Swarm offers it: System, Dark or Light.
///
/// Beside [HarnessPalette], not instead of it. App colors (the terminal's Settings) still picks an
/// exact palette, and a palette carries its own brightness; Theme only says which side of it to
/// wear — see [AppearancePrefs.paletteFor].
enum AppThemeMode {
  /// This phone's own light or dark, followed as it changes.
  system('System'),
  dark('Dark'),
  light('Light');

  const AppThemeMode(this.label);

  /// What the control says.
  final String label;

  /// The saved name read back; anything else — a build that had a mode this one does not — is
  /// null, which is "the palette decides", as before Theme existed.
  static AppThemeMode? fromId(String? id) =>
      values.where((mode) => mode.name == id).firstOrNull;
}

/// The app's coordinated palette and UI typography on this computer.
///
/// This does not change the terminal's type. The terminal renders a grid a remote
/// program draws into, so it keeps its own face and its own size in
/// [TerminalFontStore], reached from Settings ▸ Terminal — and the app's UI
/// scale is fenced out of it (see the note at `textScaler` in
/// `terminal_panel.dart`).
@immutable
class AppearancePrefs {
  const AppearancePrefs({
    this.uiFamily,
    this.uiSize = uiSizeDefault,
    this.palette = HarnessPalette.graphite,
    this.themeMode,
  });

  /// The palette chosen in App colors — or, before any was, the shipped one.
  final HarnessPalette palette;

  /// Settings ▸ Appearance ▸ Theme, as Swarm's Settings offers it. Null — the default, and what
  /// App colors sets — means [palette] decides on its own, light or dark, as it always has. So
  /// nobody's app changes until they choose here.
  final AppThemeMode? themeMode;

  /// The palette each side falls back to when [palette] is on the other: the phone's two themes,
  /// as Swarm's pages are drawn and reviewed in.
  static const darkPalette = HarnessPalette.graphite;
  static const lightPalette = HarnessPalette.paper;

  /// The palette the app wears on a phone whose own appearance is [platform].
  ///
  /// [palette] itself while it is on the side [themeMode] asks for — so a Midnight chosen in App
  /// colors stays Midnight under Dark, and comes back after a trip to Light — and the shipped
  /// palette of that side when it is not.
  HarnessPalette paletteFor(Brightness platform) => _side(switch (themeMode) {
    null => palette.brightness,
    AppThemeMode.system => platform,
    AppThemeMode.dark => Brightness.dark,
    AppThemeMode.light => Brightness.light,
  });

  /// The palette a terminal's page wears: the dark side whenever Theme is chosen, whatever the app
  /// wears around it — a terminal is read as a terminal. Left to App colors ([themeMode] null),
  /// the terminal wears [palette], light or dark, as before.
  HarnessPalette get terminalPalette =>
      themeMode == null ? palette : _side(Brightness.dark);

  /// What Theme's control shows chosen: [themeMode], or the side [palette] is on while App colors
  /// decides — which is exactly what Dark or Light would draw.
  AppThemeMode get shownThemeMode =>
      themeMode ?? (palette.isDark ? AppThemeMode.dark : AppThemeMode.light);

  HarnessPalette _side(Brightness side) => palette.brightness == side
      ? palette
      : (side == Brightness.dark ? darkPalette : lightPalette);

  /// The face the app's chrome is set in. `null` means the system font, which is
  /// what [AppFont.sans] falls back to.
  ///
  /// Never the empty string. CoreText resolves `''` to nothing at all and the
  /// text simply disappears, so "use the system font" is represented by the
  /// absence of a value at every layer — here, and as a deleted key on disk.
  final String? uiFamily;

  /// The base size everything else is measured against, in logical pixels.
  final double uiSize;

  /// The size the app was drawn at. [AppFont.uiScale] is this over that, so at
  /// 14 the scale is exactly 1 and every control keeps the geometry the design
  /// system specifies.
  static const double uiSizeDefault = AppFont.uiSizeDefault;

  /// ⚠️ Not a matter of taste. A control here is a fixed-height box built for a
  /// 13pt label — [AppControl.height] 32, [AppControl.heightField] 36 — and past
  /// roughly ±35% the label stops fitting the box it sits in.
  static const double uiSizeMin = 11;
  static const double uiSizeMax = 19;

  /// [uiFamily] is nullable and `copyWith` cannot express "unset" with
  /// `?? this.x`, so going back to the system font needs its own flag. Without
  /// one, choosing System silently does nothing.
  ///
  /// [themeMode] is nullable for the same reason, and [clearThemeMode] is its flag.
  AppearancePrefs copyWith({
    String? uiFamily,
    double? uiSize,
    HarnessPalette? palette,
    AppThemeMode? themeMode,
    bool clearUiFamily = false,
    bool clearThemeMode = false,
  }) => AppearancePrefs(
    uiFamily: clearUiFamily ? null : (uiFamily ?? this.uiFamily),
    uiSize: uiSize ?? this.uiSize,
    palette: palette ?? this.palette,
    themeMode: clearThemeMode ? null : (themeMode ?? this.themeMode),
  );

  @override
  bool operator ==(Object other) =>
      other is AppearancePrefs &&
      other.uiFamily == uiFamily &&
      other.uiSize == uiSize &&
      other.palette == palette &&
      other.themeMode == themeMode;

  @override
  int get hashCode => Object.hash(uiFamily, uiSize, palette, themeMode);
}

/// The user's appearance choices, remembered across launches.
///
/// Same shape as [TerminalFontStore]: a [ValueNotifier]
/// singleton over [HarnessFileStore], loaded once by `loadPersistedSettings()`
/// before the first frame. Not a Riverpod provider — `MaterialApp` is built
/// above every provider scope in this app, and these values have to resolve
/// before there is a scope at all.
class AppearancePrefsStore extends ValueNotifier<AppearancePrefs> {
  AppearancePrefsStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared,
      super(const AppearancePrefs());

  static const _familyKey = 'app_ui_font_family';
  static const _sizeKey = 'app_ui_font_size';
  static const _paletteKey = 'app_color_palette';
  static const _themeModeKey = 'app_theme_mode';

  /// The palette and the theme mode on their way to disk — one write loop for the two, because
  /// App colors moves both at once (see [setPalette]).
  Future<void>? _paletteSave;

  final LocalKeyValueStore _storage;

  /// Read the saved choices, if there are any.
  ///
  /// Tolerant by design: a missing, truncated or hand-edited file lands on the
  /// defaults rather than throwing. Someone who opened `state.json` in an editor
  /// should get a plain-looking app, not an app that refuses to start.
  Future<void> load() async {
    try {
      final saved = await _storage.readMany([
        _familyKey,
        _sizeKey,
        _paletteKey,
        _themeModeKey,
      ]);
      value = AppearancePrefs(
        uiFamily: _familyFrom(saved[_familyKey]),
        uiSize: _sizeFrom(saved[_sizeKey]),
        palette: HarnessPalette.fromId(saved[_paletteKey]),
        themeMode: AppThemeMode.fromId(saved[_themeModeKey]),
      );
    } catch (_) {
      value = const AppearancePrefs();
    }
  }

  /// Preview now, persist in order. Rapid choices coalesce while storage is
  /// busy so an older write cannot replace the user's final selection.
  ///
  /// App colors names an exact palette, so it hands light and dark back to the palette too: a
  /// Theme left on System would otherwise answer a tap on Midnight, on a light phone, with Paper.
  Future<void> setPalette(HarnessPalette palette) {
    if (value.palette == palette && value.themeMode == null) {
      return _paletteSave ?? Future.value();
    }
    value = value.copyWith(palette: palette, clearThemeMode: true);
    return _paletteSave ??= _savePalette();
  }

  /// Theme's System, Dark or Light. The palette stays as App colors left it — see
  /// [AppearancePrefs.paletteFor] — and persists in the same ordered loop as [setPalette].
  Future<void> setThemeMode(AppThemeMode mode) {
    if (value.themeMode == mode) return _paletteSave ?? Future.value();
    value = value.copyWith(themeMode: mode);
    return _paletteSave ??= _savePalette();
  }

  Future<void> _savePalette() async {
    try {
      while (true) {
        final id = value.palette.name;
        final mode = value.themeMode?.name;
        await _storage.write(_paletteKey, id);
        if (mode == null) {
          // Deleted, not written as '': absent IS "the palette decides".
          await _storage.delete(_themeModeKey);
        } else {
          await _storage.write(_themeModeKey, mode);
        }
        if (value.palette.name == id && value.themeMode?.name == mode) break;
      }
    } catch (_) {
      // The chosen palette remains usable for this run if storage fails.
    } finally {
      _paletteSave = null;
    }
  }

  /// Choose a face, or pass `null` for the system font.
  Future<void> setUiFamily(String? family) async {
    final next = _familyFrom(family);
    if (next == value.uiFamily) return;
    value = value.copyWith(uiFamily: next, clearUiFamily: next == null);
    try {
      if (next == null) {
        // Deleted, not written as ''. See [AppearancePrefs.uiFamily].
        await _storage.delete(_familyKey);
      } else {
        await _storage.write(_familyKey, next);
      }
    } catch (_) {
      // Kept for this run; a failed write costs the choice at next launch.
    }
  }

  /// Set the base size. Values outside the range snap to the nearest end rather
  /// than being rejected, so a caller never has to pre-validate.
  Future<void> setUiSize(double size) async {
    final next = _clampSize(size);
    if (next == value.uiSize) return;
    // The notifier moves first and the write is awaited after, so the window
    // repaints on the click rather than on the disk.
    value = value.copyWith(uiSize: next);
    try {
      await _storage.write(_sizeKey, next.toString());
    } catch (_) {
      // See above.
    }
  }

  /// Back to the shipped defaults.
  Future<void> reset() async {
    value = const AppearancePrefs();
    await _paletteSave;
    try {
      await _storage.delete(_familyKey);
      await _storage.delete(_sizeKey);
      await _storage.delete(_paletteKey);
      await _storage.delete(_themeModeKey);
    } catch (_) {
      // See above.
    }
  }

  /// ⚠️ Empty and blank strings become `null`, not a family name. CoreText
  /// resolves `''` to no face at all, and the app renders no text — a failure
  /// with no error attached to it.
  static String? _familyFrom(String? raw) {
    final trimmed = raw?.trim();
    return (trimmed == null || trimmed.isEmpty) ? null : trimmed;
  }

  static double _sizeFrom(String? raw) {
    final parsed = double.tryParse(raw ?? '');
    return parsed == null ? AppearancePrefs.uiSizeDefault : _clampSize(parsed);
  }

  /// ⚠️ The `isFinite` guard has to come BEFORE the clamp, not after.
  /// `double.tryParse('NaN')` succeeds, and `double.nan.clamp(11, 19)` returns
  /// 19 — so a hand-edited file saying `NaN` would silently pin the whole app at
  /// maximum size instead of falling back to the default.
  static double _clampSize(double size) => !size.isFinite
      ? AppearancePrefs.uiSizeDefault
      : size.clamp(AppearancePrefs.uiSizeMin, AppearancePrefs.uiSizeMax);
}

/// Puts [prefs]' palettes on [AppTheme] for a phone whose own appearance is [platform], and returns
/// the app's: [AppearancePrefs.paletteFor] as the app's, and [AppearancePrefs.terminalPalette] as a
/// terminal page's when it differs. What the app does before it builds its theme — see
/// `AppearanceBuilder`.
HarnessPalette applyAppearance(
  AppearancePrefs prefs, {
  required Brightness platform,
}) {
  final app = prefs.paletteFor(platform);
  final terminal = prefs.terminalPalette;
  AppTheme.palette.value = app;
  AppTheme.terminalPaletteOverride.value = terminal == app ? null : terminal;
  return app;
}

/// The one instance the app reads.
///
/// Here rather than beside `main()` for the same reason `terminalFontStore` is:
/// the widgets that change these values would otherwise have to reach up into
/// the app entrypoint, dragging `runApp` and every screen into anything that
/// renders them — tests included.
final appearancePrefsStore = AppearancePrefsStore();
