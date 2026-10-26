import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

/// The one Lucide weight the web release ships (scripts/build-web-release.sh
/// drops the other fonts). An icon in any other weight draws on Desktop and a
/// blank square on the web, so no Lucide icon under lib/ may use one.
const _shippedWeightSuffix = '400';

final _lucideIcon = RegExp(r'\bLucideIcons\.(\w+)');

/// `file: LucideIcons.name` for every Lucide icon under [lib] that is not in the
/// shipped weight, and how many Lucide icons were looked at.
({List<String> offenders, int checked}) _scan(Directory lib) {
  final offenders = <String>[];
  var checked = 0;
  for (final file in lib.listSync(recursive: true).whereType<File>()) {
    if (!file.path.endsWith('.dart')) continue;
    for (final match in _lucideIcon.allMatches(file.readAsStringSync())) {
      checked++;
      final name = match.group(1)!;
      if (name.endsWith(_shippedWeightSuffix)) continue;
      offenders.add(
        '${p.relative(file.path, from: lib.path)}: LucideIcons.$name',
      );
    }
  }
  return (offenders: offenders, checked: checked);
}

void main() {
  test('every Lucide icon under lib is the weight the web release ships', () {
    final scan = _scan(Directory('lib'));

    expect(
      scan.checked,
      greaterThan(0),
      reason: 'found no Lucide icons: wrong folder?',
    );
    expect(
      scan.offenders,
      isEmpty,
      reason:
          'The web release ships only Lucide weight $_shippedWeightSuffix '
          '(scripts/build-web-release.sh). Use a ...$_shippedWeightSuffix icon, or '
          'keep the font in the web release too.',
    );
  });

  test('the scan names a Lucide icon in another weight, in any file', () {
    final lib = Directory.systemTemp.createTempSync('lucide-weight-');
    addTearDown(() => lib.deleteSync(recursive: true));
    Directory(p.join(lib.path, 'ui')).createSync();
    File(p.join(lib.path, 'icons.dart')).writeAsStringSync('''
const ok = LucideIcons.bell400;
const plain = LucideIcons.bell;
''');
    File(p.join(lib.path, 'ui', 'button.dart')).writeAsStringSync('''
Widget build() => Icon(LucideIcons.arrowUp500);
final other = Icon(LucideIcons.arrowDown400);
''');
    File(p.join(lib.path, 'notes.txt'))
        .writeAsStringSync('LucideIcons.bell100');

    final scan = _scan(lib);

    expect(scan.checked, 4);
    expect(
      scan.offenders,
      unorderedEquals([
        'icons.dart: LucideIcons.bell',
        '${p.join('ui', 'button.dart')}: LucideIcons.arrowUp500',
      ]),
    );
  });
}
