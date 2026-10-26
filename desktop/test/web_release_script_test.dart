import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

const _lucide = 'packages/lucide_icons_flutter';
const _used = '$_lucide/Lucide400';
const _unusedLucide = [
  '$_lucide/Lucide',
  '$_lucide/Lucide100',
  '$_lucide/Lucide200',
  '$_lucide/Lucide300',
  '$_lucide/Lucide500',
  '$_lucide/Lucide600',
];
const _others = ['MaterialIcons', 'Roboto Mono'];

String _assetOf(String family) => switch (family) {
  '$_lucide/Lucide' => '$_lucide/assets/lucide.ttf',
  final f when f.startsWith('$_lucide/Lucide') =>
    '$_lucide/assets/build_font/LucideVariable-w${f.substring(f.length - 3)}.ttf',
  _ => 'fonts/${family.replaceAll(' ', '-')}.ttf',
};

/// The page `flutter build web` writes, cut down to what the script edits.
const _index =
    '<!DOCTYPE html><html><head><base href="/harness-web/"></head>'
    '<body><script>/* flutter_bootstrap */</script></body></html>';

/// Stands in for `flutter build web`: writes the fonts a real build lists for
/// this app into the `--output` directory the script passes.
String _fakeFlutter(List<String> families) {
  final manifest = jsonEncode([
    for (final family in families)
      {
        'family': family,
        'fonts': [
          {'asset': _assetOf(family)},
        ],
      },
  ]);
  final assets = families.map((family) => '"${_assetOf(family)}"').join(' ');
  return '''#!/usr/bin/env bash
set -euo pipefail
for arg in "\$@"; do
  case "\$arg" in --output=*) out="\${arg#--output=}" ;; esac
done
mkdir -p "\$out/assets"
printf '%s' '$manifest' > "\$out/assets/FontManifest.json"
printf '%s' '$_index' > "\$out/index.html"
for asset in $assets; do
  mkdir -p "\$out/assets/\$(dirname "\$asset")"
  echo font > "\$out/assets/\$asset"
done
''';
}

Future<void> _git(Directory repo, List<String> args) async {
  final result = await Process.run('git', [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    ...args,
  ], workingDirectory: repo.path);
  expect(result.exitCode, 0, reason: '${result.stderr}');
}

/// Runs the real `scripts/build-web-release.sh` in a throwaway git checkout
/// whose `flutter` writes [families].
Future<ProcessResult> _release(Directory repo, List<String> families) async {
  Directory(p.join(repo.path, 'scripts')).createSync();
  File('scripts/build-web-release.sh')
      .copySync(p.join(repo.path, 'scripts', 'build-web-release.sh'));
  final flutter = File(p.join(repo.path, 'fake-flutter.sh'))
    ..writeAsStringSync(_fakeFlutter(families));
  await Process.run('chmod', ['+x', flutter.path]);
  await _git(repo, ['init', '-q']);
  await _git(repo, ['add', '.']);
  await _git(repo, ['commit', '-q', '-m', 'fixture']);
  return Process.run(
    'bash',
    ['scripts/build-web-release.sh', '1.2.3'],
    workingDirectory: repo.path,
    environment: {'FLUTTER_BIN': flutter.path},
  );
}

List<String> _manifestFamilies(Directory repo) {
  final manifest = File(
    p.join(repo.path, 'build/web-release/assets/FontManifest.json'),
  );
  return [
    for (final entry in jsonDecode(manifest.readAsStringSync()) as List)
      (entry as Map<String, dynamic>)['family'] as String,
  ];
}

String _builtIndex(Directory repo) =>
    File(p.join(repo.path, 'build/web-release/index.html')).readAsStringSync();

String _preload(String asset) =>
    '<link rel="preload" href="assets/$asset" as="fetch" crossorigin>';

bool _shipped(Directory repo, String family) =>
    File(p.join(repo.path, 'build/web-release/assets', _assetOf(family)))
        .existsSync();

void main() {
  late Directory repo;
  setUp(() => repo = Directory.systemTemp.createTempSync('web-release-'));
  tearDown(() => repo.deleteSync(recursive: true));

  final skip = Platform.isWindows ? 'needs bash and python3' : null;

  test('the web release drops the Lucide weights the app never uses', () async {
    final result = await _release(repo, [..._others, ..._unusedLucide, _used]);

    expect(result.exitCode, 0, reason: '${result.stderr}');
    expect(_manifestFamilies(repo), [..._others, _used]);
    for (final family in _unusedLucide) {
      expect(_shipped(repo, family), isFalse, reason: family);
    }
    for (final family in [..._others, _used]) {
      expect(_shipped(repo, family), isTrue, reason: family);
    }
  }, skip: skip);

  test('the archive carries only the fonts the manifest lists', () async {
    await _release(repo, [..._others, ..._unusedLucide, _used]);

    final listing = await Process.run('tar', [
      '-tzf',
      p.join(repo.path, 'build/web-dist/harness-web-1.2.3.tar.gz'),
    ]);
    final files = (listing.stdout as String).split('\n');
    expect(files, contains('assets/${_assetOf(_used)}'));
    expect(
      files.where((file) => file.contains('LucideVariable-w100')),
      isEmpty,
    );
    expect(files.where((file) => file.endsWith('lucide.ttf')), isEmpty);
  }, skip: skip);

  test(
    'the page fetches the fonts it ships beside the app, not after it',
    () async {
      final result = await _release(repo, [
        ..._others,
        ..._unusedLucide,
        _used,
      ]);

      expect(result.exitCode, 0, reason: '${result.stderr}');
      final index = _builtIndex(repo);
      final head = index.substring(0, index.indexOf('</head>'));
      expect(head, contains(_preload('FontManifest.json')));
      for (final family in [..._others, _used]) {
        expect(head, contains(_preload(_assetOf(family))), reason: family);
      }
      for (final family in _unusedLucide) {
        expect(index, isNot(contains(_assetOf(family))), reason: family);
      }
    },
    skip: skip,
  );

  test(
    'a build with no Lucide 400 font fails instead of shipping blind',
    () async {
      final result = await _release(repo, [..._others, ..._unusedLucide]);

      expect(result.exitCode, isNot(0));
      expect('${result.stderr}', contains(_used));
    },
    skip: skip,
  );
}
