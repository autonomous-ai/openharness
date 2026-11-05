import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:path/path.dart' as p;

import '../../core/harness_file_store.dart';
import '../../core/local_key_value_store.dart';
import 'color_palette.dart';
import 'custom_background.dart';
import 'harness_background.dart';
import 'prompt_style.dart';

/// How panes sit together: apart as rounded cards, or square and touching.
enum PaneStyle {
  comfortable('Comfortable'),
  compact('Compact');

  const PaneStyle(this.label);
  final String label;
}

/// What fades in a pane that isn't active.
enum PaneFade {
  off('Off'),
  surface('Surface'),
  content('Content'),
  surfaceAndContent('Surface & Content');

  const PaneFade(this.label);
  final String label;

  bool get fadesSurface => this == surface || this == surfaceAndContent;
  bool get fadesContent => this == content || this == surfaceAndContent;
}

/// How panes look and behave on this computer.
@immutable
class PanePrefs {
  const PanePrefs({
    this.style = PaneStyle.comfortable,
    this.fade = PaneFade.surfaceAndContent,
    this.highlightActive = true,
    this.autobalanceSplits = true,
    this.focusFollowsMouse = false,
  });

  final PaneStyle style;
  final PaneFade fade;
  final bool highlightActive;
  final bool autobalanceSplits;
  final bool focusFollowsMouse;

  PanePrefs copyWith({
    PaneStyle? style,
    PaneFade? fade,
    bool? highlightActive,
    bool? autobalanceSplits,
    bool? focusFollowsMouse,
  }) => PanePrefs(
    style: style ?? this.style,
    fade: fade ?? this.fade,
    highlightActive: highlightActive ?? this.highlightActive,
    autobalanceSplits: autobalanceSplits ?? this.autobalanceSplits,
    focusFollowsMouse: focusFollowsMouse ?? this.focusFollowsMouse,
  );

  Map<String, Object> toJson() => {
    'style': style.name,
    'fade': fade.name,
    'highlightActive': highlightActive,
    'autobalanceSplits': autobalanceSplits,
    'focusFollowsMouse': focusFollowsMouse,
  };

  /// Read tolerantly, each field alone: a value this build doesn't know is that
  /// field's default. Before this was saved there was only the shade switch, so
  /// with nothing saved, a [legacyShade] someone set keeps what it drew: the
  /// Surface fade, or none. Null means they never touched it: the defaults.
  static PanePrefs read(String? raw, {required bool? legacyShade}) {
    final legacy = switch (legacyShade) {
      null => const PanePrefs(),
      true => const PanePrefs(fade: PaneFade.surface),
      false => const PanePrefs(fade: PaneFade.off),
    };
    if (raw == null) return legacy;
    try {
      if (jsonDecode(raw) case final Map<String, dynamic> json) {
        T named<T extends Enum>(List<T> values, Object? name, T fallback) =>
            values.where((value) => value.name == name).firstOrNull ?? fallback;
        bool flag(String key, bool fallback) => switch (json[key]) {
          final bool saved => saved,
          _ => fallback,
        };
        return PanePrefs(
          style: named(PaneStyle.values, json['style'], legacy.style),
          fade: named(PaneFade.values, json['fade'], legacy.fade),
          highlightActive: flag('highlightActive', legacy.highlightActive),
          autobalanceSplits: flag(
            'autobalanceSplits',
            legacy.autobalanceSplits,
          ),
          focusFollowsMouse: flag(
            'focusFollowsMouse',
            legacy.focusFollowsMouse,
          ),
        );
      }
    } on FormatException {
      // A hand-edited file lands on the defaults, as everything here does.
    }
    return legacy;
  }

  @override
  bool operator ==(Object other) =>
      other is PanePrefs &&
      other.style == style &&
      other.fade == fade &&
      other.highlightActive == highlightActive &&
      other.autobalanceSplits == autobalanceSplits &&
      other.focusFollowsMouse == focusFollowsMouse;

  @override
  int get hashCode => Object.hash(
    style,
    fade,
    highlightActive,
    autobalanceSplits,
    focusFollowsMouse,
  );
}

/// Light, Dark, or whatever the computer's own setting is (task #3006).
enum AppearanceMode {
  light('Light'),
  dark('Dark'),
  system('Match macOS');

  const AppearanceMode(this.label);
  final String label;

  /// What the third choice is called on this computer: the Mac's own name for
  /// it there, the plain one elsewhere.
  String labelFor(TargetPlatform platform) =>
      this == system && platform != TargetPlatform.macOS
      ? 'Match system'
      : label;

  static AppearanceMode? byId(String? id) =>
      values.where((mode) => mode.name == id).firstOrNull;
}

/// Palette, background, and prompt preferences on this computer.
/// Legacy UI font fields remain readable for older builds; current typography
/// is controlled only by TerminalFontStore.
@immutable
class AppearancePrefs {
  const AppearancePrefs({
    this.uiFamily,
    this.uiSize = uiSizeDefault,
    this.palette = HarnessPalette.graphite,
    this.mode = AppearanceMode.dark,
    this.lightPalette = defaultLightPalette,
    this.darkPalette = defaultDarkPalette,
    this.background = HarnessBackground.plain,
    this.custom = const CustomBackground(),
    this.paneOpacity = paneOpacityDefault,
    this.panes = const PanePrefs(),
    this.autoRenameTabs = false,
    this.prompt = const PromptPrefs(),
  });

  final PromptPrefs prompt;

  /// The palette the app is wearing now: [lightPalette] or [darkPalette], as
  /// [mode] and (in Match macOS) the computer's setting decide. Everything
  /// that colors the app reads this one.
  final HarnessPalette palette;
  final AppearanceMode mode;

  /// The themes Light and Dark use, each chosen on its own.
  final HarnessPalette lightPalette, darkPalette;
  static const defaultLightPalette = HarnessPalette.cloud;
  static const defaultDarkPalette = HarnessPalette.graphite;

  /// The palette [mode] shows when the computer is [system].
  HarnessPalette resolve(Brightness system) => switch (mode) {
    AppearanceMode.light => lightPalette,
    AppearanceMode.dark => darkPalette,
    AppearanceMode.system =>
      system == Brightness.dark ? darkPalette : lightPalette,
  };
  final HarnessBackground background;

  /// Kept while a built-in background is showing, so switching back is one
  /// click.
  final CustomBackground custom;

  /// How solid the panes are while the background shows through them.
  final double paneOpacity;
  static const double paneOpacityDefault = 0.5;
  static const double paneOpacityMin = 0;

  final PanePrefs panes;

  /// Whether panes outside the current focus fade at all.
  bool get shadeInactivePanes => panes.fade != PaneFade.off;

  /// Whether a tab without a custom name asks its machine's daemon for one
  /// (`window_name`) and shows it instead of the voted label. Off, no request
  /// is made and every label is the one it always was.
  final bool autoRenameTabs;

  /// Whether a running harness tab paints the background at all: Blank has
  /// nothing to show through.
  bool get showsBackground => background != HarnessBackground.plain;

  /// The opacity panes paint their own fill at; 1 unless the background is
  /// showing behind them.
  double get effectivePaneOpacity => showsBackground ? paneOpacity : 1;

  /// Legacy fields, retained for settings compatibility with older builds.
  final String? uiFamily;
  final double uiSize;
  static const double uiSizeDefault = 14;

  static const double uiSizeMin = 11;
  static const double uiSizeMax = 19;

  /// [uiFamily] is nullable and `copyWith` cannot express "unset" with
  /// `?? this.x`, so going back to the system font needs its own flag. Without
  /// one, choosing System silently does nothing.
  AppearancePrefs copyWith({
    String? uiFamily,
    double? uiSize,
    HarnessPalette? palette,
    AppearanceMode? mode,
    HarnessPalette? lightPalette,
    HarnessPalette? darkPalette,
    HarnessBackground? background,
    CustomBackground? custom,
    double? paneOpacity,
    bool? shadeInactivePanes,
    PanePrefs? panes,
    bool? autoRenameTabs,
    PromptPrefs? prompt,
    bool clearUiFamily = false,
  }) => AppearancePrefs(
    uiFamily: clearUiFamily ? null : (uiFamily ?? this.uiFamily),
    uiSize: uiSize ?? this.uiSize,
    palette: palette ?? this.palette,
    mode: mode ?? this.mode,
    lightPalette: lightPalette ?? this.lightPalette,
    darkPalette: darkPalette ?? this.darkPalette,
    background: background ?? this.background,
    custom: custom ?? this.custom,
    paneOpacity: paneOpacity ?? this.paneOpacity,
    panes: switch (shadeInactivePanes) {
      null => panes ?? this.panes,
      true => (panes ?? this.panes).copyWith(fade: PaneFade.surface),
      false => (panes ?? this.panes).copyWith(fade: PaneFade.off),
    },
    autoRenameTabs: autoRenameTabs ?? this.autoRenameTabs,
    prompt: prompt ?? this.prompt,
  );

  @override
  bool operator ==(Object other) =>
      other is AppearancePrefs &&
      other.uiFamily == uiFamily &&
      other.uiSize == uiSize &&
      other.palette == palette &&
      other.mode == mode &&
      other.lightPalette == lightPalette &&
      other.darkPalette == darkPalette &&
      other.background == background &&
      other.custom == custom &&
      other.paneOpacity == paneOpacity &&
      other.panes == panes &&
      other.autoRenameTabs == autoRenameTabs &&
      other.prompt == prompt;

  @override
  int get hashCode => Object.hash(
    uiFamily,
    uiSize,
    palette,
    mode,
    lightPalette,
    darkPalette,
    background,
    custom,
    paneOpacity,
    panes,
    autoRenameTabs,
    prompt,
  );
}

/// The user's appearance choices, remembered across launches.
///
/// Same shape as [TerminalFontStore]: a [ValueNotifier]
/// singleton over [HarnessFileStore], loaded once by `loadPersistedSettings()`
/// before the first frame. Not a Riverpod provider — `MaterialApp` is built
/// above every provider scope in this app, and these values have to resolve
/// before there is a scope at all.
class AppearancePrefsStore extends ValueNotifier<AppearancePrefs>
    with WidgetsBindingObserver {
  AppearancePrefsStore({
    LocalKeyValueStore? storage,
    this._backgroundsDirectory,
  }) : _storage = storage ?? HarnessFileStore.shared,
       super(const AppearancePrefs());

  static const _familyKey = 'app_ui_font_family';
  static const _sizeKey = 'app_ui_font_size';
  // Holds the palette on screen at the last choice, which is all an older
  // build reads.
  static const _paletteKey = 'app_color_palette';
  static const _modeKey = 'app_theme_mode';
  static const _lightPaletteKey = 'app_light_palette';
  static const _darkPaletteKey = 'app_dark_palette';
  static const _backgroundKey = 'harness_start_background';
  static const _customKey = 'harness_custom_background';
  // Named for the retired on/off choice; it now holds only pane opacity.
  static const _paneOpacityKey = 'harness_background_behind_harnesses';
  // Still written: an older build reads it for its one shade switch.
  static const _shadeInactivePanesKey = 'harness_shade_inactive_panes';
  static const _panesKey = 'harness_panes_v1';
  static const _autoRenameTabsKey = 'harness_auto_rename_tabs';
  static const _promptKey = 'workspace_prompt_v1';
  Future<void>? _promptSave;
  Future<void>? _paletteSave;
  Future<void>? _backgroundSave;
  Future<void>? _customSave;
  Future<void>? _paneOpacitySave;
  Future<void>? _panesSave;
  Future<void>? _autoRenameTabsSave;

  final LocalKeyValueStore _storage;
  final Directory? _backgroundsDirectory;

  /// The computer's own light or dark setting, which Match macOS shows.
  Brightness _system = _platformBrightness();
  bool _following = false;
  bool _disposed = false;

  static Brightness _platformBrightness() {
    try {
      return WidgetsBinding.instance.platformDispatcher.platformBrightness;
    } catch (_) {
      // No binding yet (a plain unit test, or before `ensureInitialized`).
      return PlatformDispatcher.instance.platformBrightness;
    }
  }

  /// Follow the computer's light/dark setting from now on: in Match macOS a
  /// change there repaints the app at once. The engine reports the system
  /// setting itself, not the window's appearance the app sets from its
  /// palette, so the two never chase each other. Call once the binding exists.
  void followSystemBrightness() {
    if (_following || _disposed) return;
    _following = true;
    WidgetsBinding.instance.addObserver(this);
    _systemChanged(_platformBrightness());
  }

  @override
  void didChangePlatformBrightness() => _systemChanged(_platformBrightness());

  void _systemChanged(Brightness system) {
    if (_disposed) return;
    _system = system;
    final shown = value.resolve(system);
    if (shown != value.palette) value = value.copyWith(palette: shown);
  }

  @override
  void dispose() {
    _disposed = true;
    if (_following) WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Harness's copies of custom backgrounds, beside `state.json`. Resolved on
  /// first use: the browser build has no such folder and never asks for it.
  Directory get backgroundsDirectory =>
      _backgroundsDirectory ??
      Directory(p.join(HarnessFileStore.defaultDirectoryPath(), 'backgrounds'));

  /// The copy the custom background shows, or `null` when there is none.
  File? get customBackgroundFile => switch (value.custom.image) {
    final name? => File(p.join(backgroundsDirectory.path, name)),
    null => null,
  };

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
        _modeKey,
        _lightPaletteKey,
        _darkPaletteKey,
        _backgroundKey,
        _customKey,
        _paneOpacityKey,
        _shadeInactivePanesKey,
        _panesKey,
        _autoRenameTabsKey,
        _promptKey,
      ]);
      final custom = _customFrom(saved[_customKey]);
      final background = HarnessBackground.fromId(saved[_backgroundKey]);
      // A save from before the switch has only the palette: its brightness
      // is the mode, and it fills that slot.
      final shown = HarnessPalette.fromId(saved[_paletteKey]);
      HarnessPalette slot(String key, Brightness brightness) {
        final chosen = HarnessPalette.byId(saved[key]);
        if (chosen?.brightness == brightness) return chosen!;
        if (shown.brightness == brightness) return shown;
        return brightness == Brightness.light
            ? AppearancePrefs.defaultLightPalette
            : AppearancePrefs.defaultDarkPalette;
      }

      final themes = AppearancePrefs(
        mode:
            AppearanceMode.byId(saved[_modeKey]) ??
            (shown.isDark ? AppearanceMode.dark : AppearanceMode.light),
        lightPalette: slot(_lightPaletteKey, Brightness.light),
        darkPalette: slot(_darkPaletteKey, Brightness.dark),
      );
      value = AppearancePrefs(
        uiFamily: _familyFrom(saved[_familyKey]),
        uiSize: _sizeFrom(saved[_sizeKey]),
        palette: themes.resolve(_system),
        mode: themes.mode,
        lightPalette: themes.lightPalette,
        darkPalette: themes.darkPalette,
        // Custom with no image to show is Blank, not an empty selection.
        background:
            background == HarnessBackground.custom && custom.image == null
            ? HarnessBackground.plain
            : background,
        custom: custom,
        paneOpacity: _paneOpacityFrom(saved[_paneOpacityKey]),
        panes: PanePrefs.read(
          saved[_panesKey],
          legacyShade: switch (saved[_shadeInactivePanesKey]) {
            'true' => true,
            'false' => false,
            _ => null,
          },
        ),
        autoRenameTabs: saved[_autoRenameTabsKey] == 'true',
        prompt: _promptFrom(saved[_promptKey]),
      );
    } catch (_) {
      value = const AppearancePrefs();
    }
  }

  /// Preview now, persist in order. Rapid choices coalesce while storage is
  /// busy so an older write cannot replace the user's final selection.
  ///
  /// A palette fills the slot of its own brightness. In Light or Dark, one of
  /// the other brightness also moves the mode, so the click shows; in Match
  /// macOS the computer still decides which slot shows.
  Future<void> setPalette(HarnessPalette palette) {
    final mode = switch (value.mode) {
      AppearanceMode.system => AppearanceMode.system,
      _ => palette.isDark ? AppearanceMode.dark : AppearanceMode.light,
    };
    return _setThemes(
      value.copyWith(
        mode: mode,
        lightPalette: palette.isDark ? null : palette,
        darkPalette: palette.isDark ? palette : null,
      ),
    );
  }

  /// Light, Dark or Match macOS.
  Future<void> setMode(AppearanceMode mode) =>
      _setThemes(value.copyWith(mode: mode));

  Future<void> _setThemes(AppearancePrefs next) {
    next = next.copyWith(palette: next.resolve(_system));
    if (next == value) return _paletteSave ?? Future.value();
    value = next;
    return _paletteSave ??= _savePalette();
  }

  Future<void> _savePalette() async {
    try {
      while (true) {
        final saving = value;
        await _storage.write(_paletteKey, saving.palette.name);
        await _storage.write(_modeKey, saving.mode.name);
        await _storage.write(_lightPaletteKey, saving.lightPalette.name);
        await _storage.write(_darkPaletteKey, saving.darkPalette.name);
        if (value.palette == saving.palette &&
            value.mode == saving.mode &&
            value.lightPalette == saving.lightPalette &&
            value.darkPalette == saving.darkPalette) {
          break;
        }
      }
    } catch (_) {
      // The chosen palette remains usable for this run if storage fails.
    } finally {
      _paletteSave = null;
    }
  }

  Future<void> setBackground(HarnessBackground background) {
    if (value.background == background) {
      return _backgroundSave ?? Future.value();
    }
    value = value.copyWith(background: background);
    return _backgroundSave ??= _saveBackground();
  }

  Future<void> _saveBackground() async {
    try {
      while (true) {
        final id = value.background.name;
        await _storage.write(_backgroundKey, id);
        if (value.background.name == id) break;
      }
    } catch (_) {
      // Keep the selected background for this run if storage is unavailable.
    } finally {
      _backgroundSave = null;
    }
  }

  /// Dim and fit changes; the image itself changes only through
  /// [chooseCustomBackground] and [removeCustomBackground].
  Future<void> setCustomBackground({double? dim, BackgroundFit? fit}) =>
      _setCustom(value.custom.copyWith(dim: dim, fit: fit));

  /// Copies the image at [path] into Harness and shows it. Returns a line to
  /// show the person when the file is refused; the current background stays.
  Future<String?> chooseCustomBackground(String path) async {
    final directory = backgroundsDirectory;
    final String name;
    try {
      name = await importCustomBackground(path, directory);
    } on CustomBackgroundError catch (error) {
      return error.message;
    }
    await Future.wait([
      _setCustom(value.custom.copyWith(image: name)),
      setBackground(HarnessBackground.custom),
    ]);
    // Only once the new name is saved, so a crash in between never leaves the
    // preferences pointing at a deleted file.
    await pruneCustomBackgrounds(directory, keep: name);
    return null;
  }

  /// Forgets the custom image and deletes Harness's copy. Blank takes over if
  /// it was showing.
  Future<void> removeCustomBackground() async {
    await Future.wait([
      if (value.background == HarnessBackground.custom)
        setBackground(HarnessBackground.plain),
      _setCustom(value.custom.copyWith(clearImage: true)),
    ]);
    await pruneCustomBackgrounds(backgroundsDirectory);
  }

  Future<void> _setCustom(CustomBackground custom) {
    if (value.custom == custom) return _customSave ?? Future.value();
    value = value.copyWith(custom: custom);
    return _customSave ??= _saveCustom();
  }

  Future<void> _saveCustom() async {
    try {
      while (true) {
        final custom = value.custom;
        await _storage.write(_customKey, jsonEncode(custom.toJson()));
        if (value.custom == custom) break;
      }
    } catch (_) {
      // Keep the custom background for this run if storage is unavailable.
    } finally {
      _customSave = null;
    }
  }

  /// Pane opacity, clamped to [AppearancePrefs.paneOpacityMin]…1 rather than
  /// rejected.
  Future<void> setPaneOpacity(double opacity) {
    final next = value.copyWith(paneOpacity: _clampOpacity(opacity));
    if (next == value) return _paneOpacitySave ?? Future.value();
    value = next;
    return _paneOpacitySave ??= _savePaneOpacity();
  }

  Future<void> _savePaneOpacity() async {
    try {
      while (true) {
        final opacity = value.paneOpacity;
        await _storage.write(_paneOpacityKey, jsonEncode({'opacity': opacity}));
        if (value.paneOpacity == opacity) break;
      }
    } catch (_) {
      // Keep the choice for this run if storage is unavailable.
    } finally {
      _paneOpacitySave = null;
    }
  }

  /// Apply immediately and serialize writes so the final choice survives.
  Future<void> setShadeInactivePanes(bool enabled) {
    if (value.shadeInactivePanes == enabled) {
      return _panesSave ?? Future.value();
    }
    return setPanes(
      value.panes.copyWith(
        fade: enabled ? const PanePrefs().fade : PaneFade.off,
      ),
    );
  }

  /// Same ordering as [setShadeInactivePanes].
  Future<void> setPanes(PanePrefs panes) {
    if (value.panes == panes) return _panesSave ?? Future.value();
    value = value.copyWith(panes: panes);
    return _panesSave ??= _savePanes();
  }

  Future<void> _savePanes() async {
    try {
      while (true) {
        final panes = value.panes;
        await _storage.write(_panesKey, jsonEncode(panes.toJson()));
        await _storage.write(
          _shadeInactivePanesKey,
          (panes.fade != PaneFade.off).toString(),
        );
        if (value.panes == panes) break;
      }
    } catch (_) {
      // Keep the choice for this run if storage is unavailable.
    } finally {
      _panesSave = null;
    }
  }

  /// Same ordering as [setShadeInactivePanes].
  Future<void> setAutoRenameTabs(bool enabled) {
    if (value.autoRenameTabs == enabled) {
      return _autoRenameTabsSave ?? Future.value();
    }
    value = value.copyWith(autoRenameTabs: enabled);
    return _autoRenameTabsSave ??= _saveAutoRenameTabs();
  }

  Future<void> _saveAutoRenameTabs() async {
    try {
      while (true) {
        final enabled = value.autoRenameTabs;
        await _storage.write(_autoRenameTabsKey, enabled.toString());
        if (value.autoRenameTabs == enabled) break;
      }
    } catch (_) {
      // Keep the choice for this run if storage is unavailable.
    } finally {
      _autoRenameTabsSave = null;
    }
  }

  /// Older builds also saved an `on` flag here; it is ignored.
  static double _paneOpacityFrom(String? raw) {
    try {
      final json = raw == null ? null : jsonDecode(raw);
      final opacity = json is Map ? json['opacity'] : null;
      return opacity is num
          ? _clampOpacity(opacity.toDouble())
          : AppearancePrefs.paneOpacityDefault;
    } catch (_) {
      return AppearancePrefs.paneOpacityDefault;
    }
  }

  static double _clampOpacity(double opacity) => opacity.isFinite
      ? opacity.clamp(AppearancePrefs.paneOpacityMin, 1.0)
      : AppearancePrefs.paneOpacityDefault;

  static CustomBackground _customFrom(String? raw) {
    try {
      return CustomBackground.fromJson(raw == null ? null : jsonDecode(raw));
    } catch (_) {
      return const CustomBackground();
    }
  }

  static PromptPrefs _promptFrom(String? raw) {
    try {
      return PromptPrefs.fromJson(raw == null ? null : jsonDecode(raw));
    } catch (_) {
      return const PromptPrefs();
    }
  }

  Future<void> setPrompt(PromptPrefs prompt) {
    if (value.prompt == prompt) return _promptSave ?? Future.value();
    value = value.copyWith(prompt: prompt);
    return _promptSave ??= _savePrompt();
  }

  Future<void> _savePrompt() async {
    try {
      while (true) {
        final prefs = value.prompt;
        await _storage.write(_promptKey, jsonEncode(prefs.toJson()));
        if (value.prompt == prefs) break;
      }
    } catch (_) {
      // Keep the preview usable for this run if storage is unavailable.
    } finally {
      _promptSave = null;
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
    _systemChanged(_system);
    await _paletteSave;
    await _backgroundSave;
    await _customSave;
    await _paneOpacitySave;
    await _panesSave;
    await _autoRenameTabsSave;
    await _promptSave;
    try {
      await _storage.delete(_familyKey);
      await _storage.delete(_sizeKey);
      await _storage.delete(_paletteKey);
      await _storage.delete(_modeKey);
      await _storage.delete(_lightPaletteKey);
      await _storage.delete(_darkPaletteKey);
      await _storage.delete(_backgroundKey);
      await _storage.delete(_customKey);
      await _storage.delete(_paneOpacityKey);
      await _storage.delete(_shadeInactivePanesKey);
      await _storage.delete(_panesKey);
      await _storage.delete(_autoRenameTabsKey);
      await _storage.delete(_promptKey);
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

/// The one instance the app reads.
///
/// Here rather than beside `main()` for the same reason `terminalFontStore` is:
/// the widgets that change these values would otherwise have to reach up into
/// the app entrypoint, dragging `runApp` and every screen into anything that
/// renders them — tests included.
final appearancePrefsStore = AppearancePrefsStore();
