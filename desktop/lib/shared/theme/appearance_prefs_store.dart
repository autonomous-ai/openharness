import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import '../../core/harness_file_store.dart';
import '../../core/local_key_value_store.dart';
import 'color_palette.dart';
import 'custom_background.dart';
import 'harness_background.dart';
import 'prompt_style.dart';

/// Palette, background, and prompt preferences on this computer.
/// Legacy UI font fields remain readable for older builds; current typography
/// is controlled only by TerminalFontStore.
@immutable
class AppearancePrefs {
  const AppearancePrefs({
    this.uiFamily,
    this.uiSize = uiSizeDefault,
    this.palette = HarnessPalette.graphite,
    this.background = HarnessBackground.plain,
    this.custom = const CustomBackground(),
    this.paneOpacity = paneOpacityDefault,
    this.shadeInactivePanes = false,
    this.prompt = const PromptPrefs(),
  });

  final PromptPrefs prompt;
  final HarnessPalette palette;
  final HarnessBackground background;

  /// Kept while a built-in background is showing, so switching back is one
  /// click.
  final CustomBackground custom;

  /// How solid the panes are while the background shows through them.
  final double paneOpacity;
  static const double paneOpacityDefault = 0.5;
  static const double paneOpacityMin = 0;

  /// Whether panes outside the current focus receive a neutral-gray veil.
  final bool shadeInactivePanes;

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
    HarnessBackground? background,
    CustomBackground? custom,
    double? paneOpacity,
    bool? shadeInactivePanes,
    PromptPrefs? prompt,
    bool clearUiFamily = false,
  }) => AppearancePrefs(
    uiFamily: clearUiFamily ? null : (uiFamily ?? this.uiFamily),
    uiSize: uiSize ?? this.uiSize,
    palette: palette ?? this.palette,
    background: background ?? this.background,
    custom: custom ?? this.custom,
    paneOpacity: paneOpacity ?? this.paneOpacity,
    shadeInactivePanes: shadeInactivePanes ?? this.shadeInactivePanes,
    prompt: prompt ?? this.prompt,
  );

  @override
  bool operator ==(Object other) =>
      other is AppearancePrefs &&
      other.uiFamily == uiFamily &&
      other.uiSize == uiSize &&
      other.palette == palette &&
      other.background == background &&
      other.custom == custom &&
      other.paneOpacity == paneOpacity &&
      other.shadeInactivePanes == shadeInactivePanes &&
      other.prompt == prompt;

  @override
  int get hashCode => Object.hash(
    uiFamily,
    uiSize,
    palette,
    background,
    custom,
    paneOpacity,
    shadeInactivePanes,
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
class AppearancePrefsStore extends ValueNotifier<AppearancePrefs> {
  AppearancePrefsStore({
    LocalKeyValueStore? storage,
    this._backgroundsDirectory,
  }) : _storage = storage ?? HarnessFileStore.shared,
       super(const AppearancePrefs());

  static const _familyKey = 'app_ui_font_family';
  static const _sizeKey = 'app_ui_font_size';
  static const _paletteKey = 'app_color_palette';
  static const _backgroundKey = 'harness_start_background';
  static const _customKey = 'harness_custom_background';
  // Named for the retired on/off choice; it now holds only pane opacity.
  static const _paneOpacityKey = 'harness_background_behind_harnesses';
  static const _shadeInactivePanesKey = 'harness_shade_inactive_panes';
  static const _promptKey = 'workspace_prompt_v1';
  Future<void>? _promptSave;
  Future<void>? _paletteSave;
  Future<void>? _backgroundSave;
  Future<void>? _customSave;
  Future<void>? _paneOpacitySave;
  Future<void>? _shadeInactivePanesSave;

  final LocalKeyValueStore _storage;
  final Directory? _backgroundsDirectory;

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
        _backgroundKey,
        _customKey,
        _paneOpacityKey,
        _shadeInactivePanesKey,
        _promptKey,
      ]);
      final custom = _customFrom(saved[_customKey]);
      final background = HarnessBackground.fromId(saved[_backgroundKey]);
      value = AppearancePrefs(
        uiFamily: _familyFrom(saved[_familyKey]),
        uiSize: _sizeFrom(saved[_sizeKey]),
        palette: HarnessPalette.fromId(saved[_paletteKey]),
        // Custom with no image to show is Blank, not an empty selection.
        background:
            background == HarnessBackground.custom && custom.image == null
            ? HarnessBackground.plain
            : background,
        custom: custom,
        paneOpacity: _paneOpacityFrom(saved[_paneOpacityKey]),
        shadeInactivePanes: saved[_shadeInactivePanesKey] == 'true',
        prompt: _promptFrom(saved[_promptKey]),
      );
    } catch (_) {
      value = const AppearancePrefs();
    }
  }

  /// Preview now, persist in order. Rapid choices coalesce while storage is
  /// busy so an older write cannot replace the user's final selection.
  Future<void> setPalette(HarnessPalette palette) {
    if (value.palette == palette) return _paletteSave ?? Future.value();
    value = value.copyWith(palette: palette);
    return _paletteSave ??= _savePalette();
  }

  Future<void> _savePalette() async {
    try {
      while (true) {
        final id = value.palette.name;
        await _storage.write(_paletteKey, id);
        if (value.palette.name == id) break;
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
      return _shadeInactivePanesSave ?? Future.value();
    }
    value = value.copyWith(shadeInactivePanes: enabled);
    return _shadeInactivePanesSave ??= _saveShadeInactivePanes();
  }

  Future<void> _saveShadeInactivePanes() async {
    try {
      while (true) {
        final enabled = value.shadeInactivePanes;
        await _storage.write(_shadeInactivePanesKey, enabled.toString());
        if (value.shadeInactivePanes == enabled) break;
      }
    } catch (_) {
      // Keep the choice for this run if storage is unavailable.
    } finally {
      _shadeInactivePanesSave = null;
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
    await _paletteSave;
    await _backgroundSave;
    await _customSave;
    await _paneOpacitySave;
    await _shadeInactivePanesSave;
    await _promptSave;
    try {
      await _storage.delete(_familyKey);
      await _storage.delete(_sizeKey);
      await _storage.delete(_paletteKey);
      await _storage.delete(_backgroundKey);
      await _storage.delete(_customKey);
      await _storage.delete(_paneOpacityKey);
      await _storage.delete(_shadeInactivePanesKey);
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
