import '../core/apple_fonts.dart';

import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import 'terminal_typography.dart';

/// A monospace font the terminal is allowed to render in.
///
/// Deliberately a closed, curated set rather than free text or a native font
/// picker: the vendored renderer measures cell width by laying out ten `'m'`
/// glyphs and dividing by 10 (`TerminalPainter._measureCharSize`), a hard
/// monospace assumption. A proportional font would misalign every column a
/// remote TUI draws regardless of how correctly resize is handled. Nothing here
/// needs Flutter to enumerate installed fonts (it can't) or risk a silent
/// substitution — every face named is one the OS it is offered on ships.
///
/// Which is why the list is per-platform ([available]). The first four are
/// stock macOS and resolve to nothing on Linux: fontconfig answers `Menlo` and
/// `.AppleSystemUIFontMonospaced` with the proportional Noto Sans, so all four
/// rendered the same broken grid there. The rest are the Ubuntu/Debian faces —
/// `Ubuntu Sans Mono` is the 25.04-and-later family and `Ubuntu Mono` the older
/// one, so both are listed rather than guessing the release.
///
/// Every value exists on every platform. A `state.json` written on a Mac and
/// carried to a Linux box still loads, and the Settings dropdown keeps showing
/// whatever is actually selected (see `_FamilyDropdown`).
enum TerminalFontChoice {
  robotoMono('Roboto Mono', webTerminalFontFamily, []),
  sfMono('SF Mono', macTerminalFontFamily, macTerminalFontFallback),
  menlo('Menlo', 'Menlo', ['Monaco', 'Courier New', 'monospace']),
  monaco('Monaco', 'Monaco', ['Menlo', 'Courier New', 'monospace']),
  courierNew('Courier New', 'Courier New', ['Menlo', 'Monaco', 'monospace']),

  dejaVuSansMono(
    'DejaVu Sans Mono',
    linuxTerminalFontFamily,
    linuxTerminalFontFallback,
  ),
  ubuntuSansMono('Ubuntu Sans Mono', 'Ubuntu Sans Mono', [
    'Ubuntu Mono',
    'DejaVu Sans Mono',
    'Noto Sans Mono',
    'monospace',
  ]),
  ubuntuMono('Ubuntu Mono', 'Ubuntu Mono', [
    'Ubuntu Sans Mono',
    'DejaVu Sans Mono',
    'monospace',
  ]),
  liberationMono('Liberation Mono', 'Liberation Mono', [
    'DejaVu Sans Mono',
    'Noto Sans Mono',
    'monospace',
  ]),
  notoSansMono('Noto Sans Mono', 'Noto Sans Mono', [
    'DejaVu Sans Mono',
    'Liberation Mono',
    'monospace',
  ]);

  const TerminalFontChoice(
    this.label,
    this.fontFamily,
    this.fontFamilyFallback,
  );

  final String label;
  final String fontFamily;
  final List<String> fontFamilyFallback;

  static const _macChoices = [sfMono, menlo, monaco, courierNew];
  static const _linuxChoices = [
    dejaVuSansMono,
    ubuntuSansMono,
    ubuntuMono,
    liberationMono,
    notoSansMono,
  ];

  /// The faces worth offering on the host this build is running on.
  ///
  /// Windows falls in with Linux deliberately rather than with macOS: its
  /// runner is unexercised (see CLAUDE.md), and of the two lists the Linux one
  /// at least ends every fallback at the generic `monospace`, which Windows
  /// does resolve.
  static List<TerminalFontChoice> get available => kIsWeb
      ? const [robotoMono]
      : (hasAppleFonts ? _macChoices : _linuxChoices);

  /// What a fresh install opens with, and what `reset()` returns to.
  static TerminalFontChoice get defaultForPlatform =>
      kIsWeb ? robotoMono : (hasAppleFonts ? sfMono : dejaVuSansMono);
}

/// What the terminal is drawn in: one of the [TerminalFontChoice] presets, or any family installed on
/// this computer (`installed_fonts.dart`).
///
/// The presets stay because they carry what a bare family name cannot: SF Mono is reached through
/// a CoreText alias, and each has a fallback chain chosen for its platform. An installed family gets
/// the platform's default chain behind it, so a glyph it lacks — a Vietnamese tone mark, a box
/// drawing — still comes from a monospaced face.
sealed class TerminalFontSelection {
  const TerminalFontSelection();

  String get fontFamily;
  List<String> get fontFamilyFallback;
  String get label;

  /// How the choice is saved: a preset by its enum name (what every older build wrote), an
  /// installed family as `font:<family>`.
  String get storageKey;

  static const _installedPrefix = 'font:';

  /// The selection a saved [storageKey] names, or null when it names nothing this build knows.
  static TerminalFontSelection? fromStorage(String? saved) {
    if (saved == null || saved.isEmpty) return null;
    if (saved.startsWith(_installedPrefix)) {
      final family = saved.substring(_installedPrefix.length).trim();
      if (family.isEmpty || kIsWeb) return null;
      return InstalledFontFamily(family);
    }
    final preset = TerminalFontChoice.values
        .where(
          (c) =>
              c.name == saved &&
              (!kIsWeb || c == TerminalFontChoice.robotoMono),
        )
        .firstOrNull;
    return preset == null ? null : PresetFont(preset);
  }
}

final class PresetFont extends TerminalFontSelection {
  const PresetFont(this.choice);

  final TerminalFontChoice choice;

  @override
  String get fontFamily => choice.fontFamily;
  @override
  List<String> get fontFamilyFallback => choice.fontFamilyFallback;
  @override
  String get label => choice.label;
  @override
  String get storageKey => choice.name;

  @override
  bool operator ==(Object other) =>
      other is PresetFont && other.choice == choice;
  @override
  int get hashCode => choice.hashCode;
}

final class InstalledFontFamily extends TerminalFontSelection {
  const InstalledFontFamily(this.family);

  final String family;

  @override
  String get fontFamily => family;

  /// The platform default first (on a Mac, SF Mono through its alias), then its own chain.
  @override
  List<String> get fontFamilyFallback => [
    terminalFontFamily,
    ...terminalFontFallback,
  ];
  @override
  String get label => family;
  @override
  String get storageKey => '${TerminalFontSelection._installedPrefix}$family';

  @override
  bool operator ==(Object other) =>
      other is InstalledFontFamily && other.family == family;
  @override
  int get hashCode => family.hashCode;
}

/// The user's chosen terminal typography (family + size), remembered across
/// launches.
///
/// A [ValueNotifier] singleton backed by [HarnessFileStore], loaded once in
/// `main()` before `runApp`.
///
/// The notifier's value IS the memoized [TerminalStyle], not a raw font/size
/// pair: [TerminalStyle] has no `==`/`hashCode` override, and the vendored
/// renderer's own setters (`RenderTerminal.textStyle`, `TerminalPainter
/// .textStyle`) short-circuit on `==`/identity before doing any work. A fresh
/// `TerminalStyle(...)` built on every widget rebuild would look like "the
/// font changed" every time and spuriously re-layout (and re-resize) the
/// terminal on every unrelated rebuild. [_styleFor] guarantees the same
/// (family, size) always returns the identical object, so both the renderer's
/// guard and [ValueNotifier]'s own "don't notify on a no-op set" work for
/// free.
class TerminalFontStore extends ValueNotifier<TerminalStyle> {
  TerminalFontStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared,
      super(_styleFor(_defaultSelection, terminalFontSize));

  static TerminalFontSelection get _defaultSelection =>
      PresetFont(TerminalFontChoice.defaultForPlatform);

  TerminalFontSelection _selection = _defaultSelection;

  static const _familyKey = 'terminal_font_family';
  static const _sizeKey = 'terminal_font_size';

  /// The bounds the size is held inside — public because the Settings stepper
  /// has to *show* them: a + that stays lit at 22pt is a control that answers a
  /// click by doing nothing.
  static const minSize = 9.0;
  static const maxSize = 22.0;
  static const _step = 1.0;

  final LocalKeyValueStore _storage;

  static final _cache = <(TerminalFontSelection, double), TerminalStyle>{};
  static TerminalStyle _styleFor(
    TerminalFontSelection selection,
    double size,
  ) => _cache.putIfAbsent(
    (selection, size),
    () => TerminalStyle(
      fontSize: size,
      fontFamily: selection.fontFamily,
      fontFamilyFallback: selection.fontFamilyFallback,
    ),
  );

  /// What the terminal is drawn in now — a preset or an installed family.
  TerminalFontSelection get selection => _selection;

  /// The preset in use, or null while an installed family is.
  TerminalFontChoice? get family => switch (_selection) {
    PresetFont(:final choice) => choice,
    InstalledFontFamily() => null,
  };

  double get size => value.fontSize;

  /// Read the saved choice, if there is one. Failure (or a stale/unknown
  /// family name from an older build) is silent and lands on the default —
  /// an unreadable state file is not a reason to refuse to start.
  Future<void> load() async {
    try {
      final saved = await _storage.readMany([_familyKey, _sizeKey]);
      final savedSize = saved[_sizeKey];
      // An installed family is not checked for still being installed: that would hold up start-up
      // on a font scan, and a family that has gone renders through its fallback chain anyway.
      _selection =
          TerminalFontSelection.fromStorage(saved[_familyKey]) ??
          _defaultSelection;
      final size = savedSize == null ? null : double.tryParse(savedSize);
      value = _styleFor(_selection, _clamp(size ?? terminalFontSize));
    } catch (_) {
      _selection = _defaultSelection;
      value = _styleFor(_selection, terminalFontSize);
    }
  }

  Future<void> setFamily(TerminalFontChoice choice) =>
      _set(PresetFont(choice), size);

  /// Draw the terminal in [selection] — a preset or a family installed here.
  Future<void> setSelection(TerminalFontSelection selection) =>
      _set(selection, size);

  Future<void> increaseSize() => _set(_selection, size + _step);
  Future<void> decreaseSize() => _set(_selection, size - _step);
  Future<void> setSize(double size) => _set(_selection, size);

  Future<void> reset() => _set(_defaultSelection, terminalFontSize);

  /// Whether the current pick *is* the default — what [reset] would leave the
  /// store at, so a Reset control can say it has nothing to do.
  bool get isDefault =>
      _selection == _defaultSelection && size == terminalFontSize;

  double _clamp(double size) => size.clamp(minSize, maxSize);

  Future<void> _set(TerminalFontSelection selection, double size) async {
    final next = _styleFor(selection, _clamp(size));
    _selection = selection;
    if (next == value) return;
    value = next;
    try {
      await _storage.write(_familyKey, selection.storageKey);
      await _storage.write(_sizeKey, next.fontSize.toString());
    } catch (_) {
      // Kept in memory for this run; see load()'s doc.
    }
  }
}

/// The one instance the app reads. Lives here rather than beside `main()`: the
/// widgets that read and write this (the terminal panel, the composer, the Settings
/// dialog, the account menu) must not have to reach into `main.dart` for it.
final terminalFontStore = TerminalFontStore();
