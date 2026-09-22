import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/harness_file_store.dart';
import '../../core/local_key_value_store.dart';
import 'color_palette.dart';
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
    this.prompt = const PromptPrefs(),
  });

  final PromptPrefs prompt;
  final HarnessPalette palette;
  final HarnessBackground background;

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
    PromptPrefs? prompt,
    bool clearUiFamily = false,
  }) => AppearancePrefs(
    uiFamily: clearUiFamily ? null : (uiFamily ?? this.uiFamily),
    uiSize: uiSize ?? this.uiSize,
    palette: palette ?? this.palette,
    background: background ?? this.background,
    prompt: prompt ?? this.prompt,
  );

  @override
  bool operator ==(Object other) =>
      other is AppearancePrefs &&
      other.uiFamily == uiFamily &&
      other.uiSize == uiSize &&
      other.palette == palette &&
      other.background == background &&
      other.prompt == prompt;

  @override
  int get hashCode =>
      Object.hash(uiFamily, uiSize, palette, background, prompt);
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
  static const _backgroundKey = 'harness_start_background';
  static const _promptKey = 'workspace_prompt_v1';
  Future<void>? _promptSave;
  Future<void>? _paletteSave;
  Future<void>? _backgroundSave;

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
        _backgroundKey,
        _promptKey,
      ]);
      value = AppearancePrefs(
        uiFamily: _familyFrom(saved[_familyKey]),
        uiSize: _sizeFrom(saved[_sizeKey]),
        palette: HarnessPalette.fromId(saved[_paletteKey]),
        background: HarnessBackground.fromId(saved[_backgroundKey]),
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
    await _promptSave;
    try {
      await _storage.delete(_familyKey);
      await _storage.delete(_sizeKey);
      await _storage.delete(_paletteKey);
      await _storage.delete(_backgroundKey);
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
