import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

/// A `.harness` path segment that starts a string literal.
final _segment = RegExp(r'''(['"])\.harness(?:[\\/][^'"\n]*)?\1''');

/// A home, on the literal's line or one of the two lines above it: [_segment] is a hit only with one.
final _home = RegExp(
  r'homeDir\(|maybeHomeDir\(|userHome\(|\b_?home\b|\bHOME\b|\bUSERPROFILE\b',
);

/// `.harness` straight after home text in one literal: $home/.harness, ${x}.harness, $sep.harness,
/// ~/.harness, %USERPROFILE%\.harness.
final _inline = RegExp(
  r'(?:\$[A-Za-z_]\w*|\}|~|%USERPROFILE%)[\\/]*\.harness(?![\w-])',
);

/// A line comment: `//` or `///` at the start of a line or after whitespace.
final _lineComment = RegExp(r'(?:^|\s)//');

/// Setup copy a person reads names the folder as they would type it.
const _copy = {
  'bootstrap/environment_provisioner.dart',
  'widgets/environment_setup_screen.dart',
};

typedef _Hit = ({String file, int line, String text});

String _printed(_Hit hit) => '${hit.file}:${hit.line}: ${hit.text}';

bool _allowed(_Hit hit) =>
    _copy.contains(hit.file) &&
    (hit.text.startsWith('~') || hit.text.startsWith('%USERPROFILE%'));

/// [source]'s lines with comments blanked, so a hit keeps its line number.
List<String> _code(String source) {
  final lines = <String>[];
  var inBlock = false;
  for (final line in const LineSplitter().convert(source)) {
    if (!inBlock && line.trimLeft().startsWith('/*')) inBlock = true;
    if (inBlock) {
      lines.add('');
      if (line.contains('*/')) inBlock = false;
      continue;
    }
    final comment = _lineComment.firstMatch(line);
    lines.add(comment == null ? line : line.substring(0, comment.start));
  }
  return lines;
}

/// Every home `.harness` path built by hand in [source], named by [file].
List<_Hit> _scan(String file, String source) {
  final lines = _code(source);
  return [
    for (var i = 0; i < lines.length; i++) ...[
      if (lines.sublist(max(0, i - 2), i + 1).any(_home.hasMatch))
        for (final match in _segment.allMatches(lines[i]))
          (file: file, line: i + 1, text: match[0]!),
      for (final match in _inline.allMatches(lines[i]))
        (file: file, line: i + 1, text: match[0]!),
    ],
  ];
}

/// Every Dart source under lib/ but the module, as (path relative to lib/ with forward slashes, text).
List<(String, String)> _libSources() => [
  for (final file
      in Directory('lib')
          .listSync(recursive: true)
          .whereType<File>()
          .where((f) => f.path.endsWith('.dart')))
    (
      p.split(p.relative(file.path, from: 'lib')).join('/'),
      file.readAsStringSync(),
    ),
].where((source) => source.$1 != 'core/harness_home.dart').toList();

void main() {
  group('no hand-built home .harness path outside core/harness_home.dart', () {
    late final List<_Hit> hits = [
      for (final (file, source) in _libSources()) ..._scan(file, source),
    ];

    test('finds each shape in a planted line', () {
      const planted = [
        "final root = p.join(home, '.harness');",
        "final root = homeDir(environment: environment);\n"
            "final windows = Platform.isWindows;\n"
            "final harness = p.join(root, '.harness',",
        r"final run = '$home/.harness/run';",
        r"final root = '$home${Platform.pathSeparator}.harness';",
        r"final auth = '$home$sep.harness${sep}auth';",
        r"const copy = r'%USERPROFILE%\.harness';",
      ];
      for (final source in planted) {
        expect(_scan('planted.dart', source), hasLength(1), reason: source);
      }
    });

    test("ignores comments, a project's folder and .harness-<name> files", () {
      const planted = [
        '/// ~/.harness/logs',
        "final home = homeDir();\n/* p.join(home, '.harness')\n */",
        "final target = File(p.join(workspace.path, '.harness', 'design.json'));",
        "const agentHandoffDir = '.harness/handoff';",
        "final staging = await Directory(parent).createTemp('.harness-clone-');",
        r"final label = '${task.harness} · done';",
      ];
      for (final source in planted) {
        expect(_scan('planted.dart', source), isEmpty, reason: source);
      }
    });

    test('lib/ holds none but the allowlisted copy', () {
      expect(
        _libSources().length,
        greaterThan(500),
        reason: 'the scan found almost nothing; run it from desktop/',
      );
      final left = hits.where((hit) => !_allowed(hit)).map(_printed).toList();
      expect(
        left,
        isEmpty,
        reason:
            'build the path with HarnessHome (lib/core/harness_home.dart):\n'
            '${left.join('\n')}',
      );
    });

    test('every allowlist entry still matches a hit', () {
      final stale = {
        for (final file in _copy)
          if (!hits.any((hit) => hit.file == file && _allowed(hit))) file,
      };
      expect(stale, isEmpty);
    });
  });
}
