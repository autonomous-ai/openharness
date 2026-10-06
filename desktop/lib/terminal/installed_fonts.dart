import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

import '../core/runtime_platform.dart';
import '../core/test_run.dart';

/// One font family installed on this computer, for the terminal font picker.
class InstalledFont {
  const InstalledFont(this.family, {required this.monospace});

  final String family;

  /// Every glyph the same width — a face the terminal grid can be drawn in without columns drifting.
  final bool monospace;

  @override
  bool operator ==(Object other) =>
      other is InstalledFont &&
      other.family == family &&
      other.monospace == monospace;

  @override
  int get hashCode => Object.hash(family, monospace);

  @override
  String toString() => 'InstalledFont($family, monospace: $monospace)';
}

/// Reads the installed families from the OS. Swapped out in tests.
typedef FontLister = Future<List<InstalledFont>> Function();

/// The font families installed on this computer, monospaced first, then by name.
///
/// Asked once and kept: the answer only changes when somebody installs a font, and the picker is
/// the only reader. A failure answers an empty list — the picker still has its presets — and is
/// not cached, so the next open asks again.
///
/// - macOS: `NSFontManager` over `harness/fonts` (`macos/Runner/MainFlutterWindow.swift`), which
///   also says which families are monospaced. (`system_profiler`, what Orca uses, takes ~10s and
///   cannot.)
/// - Linux: `fc-list : family spacing`, where `spacing=100` is monospaced.
/// - Web and anything else: nothing — the browser build draws only the font it bundles.
Future<List<InstalledFont>> listInstalledFonts() {
  final cached = _cached;
  if (cached != null) return cached;
  final load = _load();
  _cached = load;
  // An empty answer (a failure, or nothing to ask) is not remembered: the next open asks again.
  unawaited(
    load.then((fonts) {
      if (fonts.isEmpty && identical(_cached, load)) _cached = null;
    }),
  );
  return load;
}

Future<List<InstalledFont>>? _cached;

/// Replaces how fonts are read, and forgets what was read. Tests only.
FontLister? debugFontLister;
void debugResetInstalledFonts() => _cached = null;

Future<List<InstalledFont>> _load() async {
  try {
    // Under `flutter test` the OS is never asked — no channel handler answers there, and a test
    // that wants fonts says which with [debugFontLister].
    final lister =
        debugFontLister ??
        (kUnderTest
            ? null
            : RuntimePlatform.isMacOS
            ? _listMacFonts
            : RuntimePlatform.isLinux
            ? _listLinuxFonts
            : null);
    if (lister == null) return const [];
    return sortInstalledFonts(
      await lister().timeout(const Duration(seconds: 10)),
    );
  } catch (_) {
    return const [];
  }
}

const _channel = MethodChannel('harness/fonts');

Future<List<InstalledFont>> _listMacFonts() async {
  final raw = await _channel.invokeListMethod<Object?>('listFonts') ?? const [];
  return [
    for (final entry in raw)
      if (entry is Map && entry['family'] is String)
        InstalledFont(
          entry['family'] as String,
          monospace: entry['mono'] == true,
        ),
  ];
}

Future<List<InstalledFont>> _listLinuxFonts() async {
  final result = await Process.run('fc-list', [
    ':',
    'family',
    'spacing',
  ]).timeout(const Duration(seconds: 5));
  if (result.exitCode != 0) return const [];
  return parseFcList(result.stdout as String);
}

/// Reads `fc-list : family spacing` output: one line per face, e.g.
/// `DejaVu Sans Mono:spacing=100` or `Noto Sans,Noto Sans Display:` (no spacing ⇒ proportional).
/// A face listing several names is filed under its first. A family is monospaced when any of its
/// faces is `spacing=100`; dual-width (`90`, CJK) and charcell (`110`) are not.
List<InstalledFont> parseFcList(String output) {
  final monospace = <String, bool>{};
  for (final line in output.split('\n')) {
    final trimmed = line.trim();
    if (trimmed.isEmpty) continue;
    final colon = trimmed.indexOf(':');
    final names = colon < 0 ? trimmed : trimmed.substring(0, colon);
    final family = names.split(',').first.trim();
    if (family.isEmpty || family.startsWith('.')) continue;
    final isMono =
        colon >= 0 && trimmed.substring(colon).contains('spacing=100');
    monospace[family] = (monospace[family] ?? false) || isMono;
  }
  return [
    for (final entry in monospace.entries)
      InstalledFont(entry.key, monospace: entry.value),
  ];
}

/// One entry per family (monospaced wins), monospaced families first, each half by name.
List<InstalledFont> sortInstalledFonts(Iterable<InstalledFont> fonts) {
  final byFamily = <String, bool>{};
  for (final font in fonts) {
    final family = font.family.trim();
    if (family.isEmpty || family.startsWith('.')) continue;
    byFamily[family] = (byFamily[family] ?? false) || font.monospace;
  }
  final sorted = [
    for (final entry in byFamily.entries)
      InstalledFont(entry.key, monospace: entry.value),
  ];
  sorted.sort((a, b) {
    if (a.monospace != b.monospace) return a.monospace ? -1 : 1;
    return a.family.toLowerCase().compareTo(b.family.toLowerCase());
  });
  return sorted;
}
