import 'dart:io' show Platform;

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
/// Android has a list of its own, the two faces it ships under the names its
/// `fonts.xml` gives them (see `androidTerminalFontFamily`). It ships none of
/// the Apple faces or the Linux ones, and while it was offered the Linux list
/// every pick drew the same Droid Sans Mono.
///
/// Every value exists on every platform. A `state.json` written on a Mac and
/// carried to a Linux box still loads, and the Settings dropdown keeps showing
/// whatever is actually selected (see `_FamilyDropdown`). Android is the
/// exception — see [TerminalFontStore.load].
enum TerminalFontChoice {
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
  ]),

  droidSansMono(
    'Droid Sans Mono',
    androidTerminalFontFamily,
    androidTerminalFontFallback,
  ),
  // A typewriter face with a smaller repertoire than Droid Sans Mono, which
  // covers what it lacks before the system's own fallback has to.
  cutiveMono('Cutive Mono', 'serif-monospace', [androidTerminalFontFamily]);

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
  static const _androidChoices = [droidSansMono, cutiveMono];

  /// The faces worth offering on [host].
  ///
  /// Windows falls in with Linux deliberately rather than with macOS: its
  /// runner is unexercised (see CLAUDE.md), and of the two lists the Linux one
  /// at least ends every fallback at the generic `monospace`, which Windows
  /// does resolve.
  static List<TerminalFontChoice> availableOn(TerminalFontHost host) =>
      switch (host) {
        TerminalFontHost.apple => _macChoices,
        TerminalFontHost.android => _androidChoices,
        TerminalFontHost.other => _linuxChoices,
      };

  /// What a fresh install on [host] opens with, and what `reset()` returns to.
  static TerminalFontChoice defaultOn(TerminalFontHost host) => switch (host) {
    TerminalFontHost.apple => sfMono,
    TerminalFontHost.android => droidSansMono,
    TerminalFontHost.other => dejaVuSansMono,
  };

  /// The faces worth offering on the host this build is running on.
  static List<TerminalFontChoice> get available =>
      availableOn(TerminalFontHost.current);
}

/// Which set of fonts the OS under the app ships — what decides the terminal's
/// [TerminalFontChoice.availableOn] list and its default.
///
/// Read from `dart:io` rather than `defaultTargetPlatform`, as [hasAppleFonts]
/// is: the question is which fonts are installed, not which platform the
/// widgets imitate, and a test overriding the latter runs on the same fonts.
enum TerminalFontHost {
  /// macOS and iOS — see [hasAppleFonts].
  apple,
  android,

  /// Linux, and Windows with it — see [TerminalFontChoice.availableOn].
  other;

  static TerminalFontHost get current => hasAppleFonts
      ? apple
      : Platform.isAndroid
      ? android
      : other;
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
  /// [host] is the OS whose fonts this store picks among — the running one
  /// unless a test names another.
  TerminalFontStore({LocalKeyValueStore? storage, TerminalFontHost? host})
    : _storage = storage ?? HarnessFileStore.shared,
      _host = host ?? TerminalFontHost.current,
      super(
        _styleFor(
          TerminalFontChoice.defaultOn(host ?? TerminalFontHost.current),
          terminalFontSize,
        ),
      );

  static const _familyKey = 'terminal_font_family';
  static const _sizeKey = 'terminal_font_size';

  /// The bounds the size is held inside — public because the Settings stepper
  /// has to *show* them: a + that stays lit at 22pt is a control that answers a
  /// click by doing nothing.
  static const minSize = 9.0;
  static const maxSize = 22.0;
  static const _step = 1.0;

  final LocalKeyValueStore _storage;
  final TerminalFontHost _host;

  /// What a fresh install opens with on this store's host, and what [reset]
  /// returns to.
  TerminalFontChoice get defaultChoice => TerminalFontChoice.defaultOn(_host);

  static final _cache = <(TerminalFontChoice, double), TerminalStyle>{};
  static TerminalStyle _styleFor(TerminalFontChoice choice, double size) =>
      _cache.putIfAbsent(
        (choice, size),
        () => TerminalStyle(
          fontSize: size,
          fontFamily: choice.fontFamily,
          fontFamilyFallback: choice.fontFamilyFallback,
          symbolFontFamily: isNerdFontFamily(choice.fontFamily)
              ? null
              : terminalIconFontFamily,
        ),
      );

  TerminalFontChoice get family => TerminalFontChoice.values.firstWhere(
    (choice) => choice.fontFamily == value.fontFamily,
    orElse: () => defaultChoice,
  );

  double get size => value.fontSize;

  /// Read the saved choice, if there is one. Failure (or a stale/unknown
  /// family name from an older build) is silent and lands on the default —
  /// an unreadable state file is not a reason to refuse to start.
  ///
  /// ⚠️ **On Android a face Android does not ship lands on the default too.**
  /// Before it had a list of its own the phone offered Android the Linux one,
  /// so a pick saved then names a face no Android phone has — drawn as Droid
  /// Sans Mono while Settings named DejaVu or Ubuntu. Elsewhere every value
  /// still loads, for the reason given on [TerminalFontChoice].
  Future<void> load() async {
    try {
      final saved = await _storage.readMany([_familyKey, _sizeKey]);
      final savedFamily = saved[_familyKey];
      final savedSize = saved[_sizeKey];
      final choice = TerminalFontChoice.values
          .where((c) => c.name == savedFamily)
          .where(_loads)
          .firstOrNull;
      final size = savedSize == null ? null : double.tryParse(savedSize);
      value = _styleFor(
        choice ?? defaultChoice,
        _clamp(size ?? terminalFontSize),
      );
    } catch (_) {
      value = _styleFor(defaultChoice, terminalFontSize);
    }
  }

  /// Whether a saved [choice] is taken as it is — see [load].
  bool _loads(TerminalFontChoice choice) =>
      _host != TerminalFontHost.android ||
      TerminalFontChoice.availableOn(_host).contains(choice);

  Future<void> setFamily(TerminalFontChoice choice) => _set(choice, size);

  Future<void> increaseSize() => _set(family, size + _step);
  Future<void> decreaseSize() => _set(family, size - _step);
  Future<void> setSize(double size) => _set(family, size);

  Future<void> reset() => _set(defaultChoice, terminalFontSize);

  /// Whether the current pick *is* the default — what [reset] would leave the
  /// store at, so a Reset control can say it has nothing to do.
  bool get isDefault => family == defaultChoice && size == terminalFontSize;

  double _clamp(double size) => size.clamp(minSize, maxSize);

  Future<void> _set(TerminalFontChoice choice, double size) async {
    final next = _styleFor(choice, _clamp(size));
    if (next == value) return;
    value = next;
    try {
      await _storage.write(_familyKey, choice.name);
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
