import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/envelope.dart';

/// The quoted type names in the CLI source [path] from [start] to the first
/// [end] after it — a `new Set([...])` literal, or a one-line constant.
///
/// The CLI's comments quote type names too: `//` comments are stripped first.
Set<String> _cliTypes(String path, String start, {String end = '])'}) {
  final file = File('../cli/src/$path');
  if (!file.existsSync()) {
    throw StateError('${file.path} missing — run from desktop/ in the monorepo');
  }
  final source = file.readAsStringSync();
  final from = source.indexOf(start);
  if (from < 0) throw StateError('"$start" is gone from ${file.path}');
  final code = source
      .substring(from, source.indexOf(end, from))
      .split('\n')
      .map((line) => line.split('//').first)
      .join('\n');
  final names = {
    for (final m in RegExp(r"'([a-z0-9_]+)'").allMatches(code)) m[1]!,
  };
  if (names.isEmpty) throw StateError('no types read after "$start"');
  return names;
}

/// This client seals every frame the machine insists on.
///
/// ⚠️ **Read from the CLI's source, not copied into this test.** A type the CLI requires sealed and
/// this client does not fails nowhere here — the frame leaves in the clear and the machine answers
/// E2EE_REQUIRED. That is how `agent_resume` and `agent_fork` went unsealed from the web build, and
/// then `git_pull_request`, which only the machine's full rule names: `encryptDownFrame` in
/// applicationFrames.ts is core.ts's set OR the request sets beside it, so all of them are read.
void main() {
  test('every frame the machine requires sealed is sealed', () {
    const frames = 'lib/e2ee/applicationFrames.ts';
    final rule = {
      ..._cliTypes(
        'lib/e2ee/core.ts',
        'ENCRYPTED_DOWN_TYPES = new Set<string>([',
      ),
      ..._cliTypes(frames, 'const MACHINE_REQUESTS'),
      ..._cliTypes(frames, 'export const OWNER_COMMAND_TYPES'),
      ..._cliTypes(frames, 'const FLEET_REQUESTS'),
      ..._cliTypes(frames, 'export const PAIR_REQUESTS'),
      ..._cliTypes(frames, 'export const PLATE_REQUEST', end: '\n'),
      ..._cliTypes('sharing/protocol.ts', 'export const SHARE_REQUEST_TYPES'),
      ..._cliTypes('teams/wire.ts', 'export const TEAM_REQUEST_TYPES'),
      ..._cliTypes('lib/viewerWire.ts', 'export const VIEWER_DOWN_TYPES'),
    };

    expect(rule.difference(encryptedDownTypes), isEmpty);
  });

  test('the rule read is the one the machine applies', () {
    // A new set joined to encryptDownFrame would go unread above: fail until
    // it is added there too.
    final rule = File(
      '../cli/src/lib/e2ee/applicationFrames.ts',
    ).readAsStringSync();
    final from = rule.indexOf('export const encryptDownFrame');
    final body = rule.substring(from, rule.indexOf('\nexport ', from + 1));
    final named = RegExp(r'\b([A-Z][A-Z_]+)\b').allMatches(body).map((m) => m[1]);
    expect(named.toSet(), {
      'MACHINE_REQUESTS',
      'FLEET_REQUESTS',
      'SHARE_REQUEST_TYPES',
      'VIEWER_DOWN_TYPES',
      'PAIR_REQUESTS',
      'PLATE_REQUEST',
      'TEAM_REQUEST_TYPES',
    });
    expect(body, contains('isEncryptedDownType(type)'));
  });
}
