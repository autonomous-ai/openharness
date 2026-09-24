/// Every `assets/…` path this app names in code is a file that exists.
///
/// Flutter resolves an asset at RUNTIME: a path that no longer matches a file
/// throws where it is drawn, which is a screen nobody may open until a user
/// does. The Store's own suite already loads its covers, editorial art and
/// project shots through `precacheImage`, and the wallpaper suite loads the
/// gallery — this covers the rest, the one-off images each named from a single
/// widget, where a rename has nothing else to fail against.
///
/// Written when 42 opaque PNGs became JPEGs to take 40 MB off the download: the
/// risk of that change was never the format, it was a path left spelled `.png`
/// (owner, 2026-09-23).
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// `'assets/…'` inside a Dart string LITERAL — the quotes are part of the
/// pattern on purpose. A comment may name another repository's `assets/logo.png`
/// to say where a mark came from, and that file was never meant to be here.
///
/// Interpolated paths (the wallpapers build theirs from an enum) cannot be seen
/// from here and are covered by the suites that load them.
final _assetLiteral = RegExp(r'''['"](assets/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)['"]''');

void main() {
  test('every asset path named in lib/ resolves to a file', () {
    final missing = <String>[];
    var checked = 0;
    for (final file in Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))) {
      final source = file.readAsStringSync();
      for (final match in _assetLiteral.allMatches(source)) {
        final path = match.group(1)!;
        checked++;
        if (!File(path).existsSync()) missing.add('$path  (${file.path})');
      }
    }
    expect(checked, greaterThan(50), reason: 'the scan found almost nothing — '
        'the pattern probably stopped matching how paths are written');
    expect(missing, isEmpty, reason: 'named in code, absent on disk:\n'
        '${missing.join('\n')}');
  });

  test('every bundled asset is named by code, or is a licence beside one', () {
    // The other direction: a file shipped in the bundle that nothing draws is
    // weight in every download. Three things are accounted for without a code
    // literal naming them, and each is a real way an asset is reached:
    //
    //  * attribution — a LICENSE or NOTICE carried for artwork, and
    //    `sources.json`, which is what names those licences;
    //  * a whole FOLDER a widget builds paths into
    //    (`'assets/model-icons/${_brands[family]}.png'`) — the literal names
    //    the directory and nothing more, so that is as far as this can see;
    //  * a SOURCE beside what is drawn — `models.svg` next to the `models.png`
    //    a mark actually loads. Shipping the vector is deliberate.
    final source = Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))
        .map((f) => f.readAsStringSync())
        .join('\n');
    final manifest = File('assets/store/covers/sources.json').readAsStringSync();

    bool named(String name) => source.contains(name) || manifest.contains(name);
    bool attribution(String name) =>
        name.startsWith('LICENSE') ||
        name.endsWith('.LICENSE') ||
        name.startsWith('NOTICE') ||
        name == 'sources.json';

    final orphans = <String>[];
    for (final file in Directory('assets')
        .listSync(recursive: true)
        .whereType<File>()) {
      final path = file.path;
      final name = path.split('/').last;
      final dir = path.substring(0, path.length - name.length);
      if (attribution(name) || named(name)) continue;
      // A folder code builds paths into. `assets/` itself is excluded: every
      // path in the app starts with it, so it would account for everything.
      if (dir != 'assets/' && source.contains(dir)) continue;
      final stem = name.split('.').first;
      final siblings = Directory(dir)
          .listSync()
          .whereType<File>()
          .map((f) => f.path.split('/').last)
          .where((s) => s != name && s.split('.').first == stem);
      if (siblings.any(named)) continue;
      orphans.add(path);
    }

    // Not `isEmpty`: these three went dead upstream when the machine-setup and
    // picker screens were rewritten (#278, #282) and are somebody else's to
    // remove — 16 KB between them. Pinned rather than skipped so the day one
    // is drawn again, or a fourth joins them, this test says so.
    expect(orphans..sort(), [
      'assets/harnesses.png',
      'assets/harnesses.svg',
      'assets/machines.svg',
    ], reason: 'bundled but never drawn');
  });
}
