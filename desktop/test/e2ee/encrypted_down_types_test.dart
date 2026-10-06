import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/envelope.dart';

/// This client seals every frame the machine insists on.
///
/// ⚠️ **Read from the CLI's source, not copied into this test.** A type the CLI requires sealed and
/// this client does not fails nowhere here — the frame leaves in the clear and the machine answers
/// E2EE_REQUIRED. That is how `agent_resume` and `agent_fork` went unsealed from the web build, and
/// `git_pull_request` after them. Only a test that reads the CLI's lists notices the day they grow
/// (mobile has the same test).
///
/// The CLI's rule is `encryptDownFrame` (`cli/src/lib/e2ee/applicationFrames.ts`): the shared core's
/// `ENCRYPTED_DOWN_TYPES` plus the harness-only extensions declared beside it. Both halves are read.
void main() {
  String cli(String path) {
    final file = File('../cli/src/$path');
    if (!file.existsSync()) {
      throw StateError(
        '${file.path} missing — run from desktop/ in the monorepo',
      );
    }
    return file.readAsStringSync();
  }

  /// The quoted names in the set literal that follows [start], `//` comments stripped first — the
  /// CLI's comments quote type names too.
  Set<String> namesIn(String source, String start) {
    final from = source.indexOf(start);
    if (from < 0) throw StateError('could not find $start');
    final body = source.substring(from, source.indexOf('])', from));
    final code = body
        .split('\n')
        .map((line) => line.split('//').first)
        .join('\n');
    return {
      for (final match in RegExp(r"'([a-z0-9_]+)'").allMatches(code)) match[1]!,
    };
  }

  late Set<String> core, machineRequests, unwrapped;
  setUpAll(() {
    core = namesIn(
      cli('lib/e2ee/core.ts'),
      'ENCRYPTED_DOWN_TYPES = new Set<string>([',
    );
    final frames = cli('lib/e2ee/applicationFrames.ts');
    final relay = cli('lib/relayFrames.ts');
    // `MACHINE_REQUESTS` also spreads the owner commands in; those are read where they are declared.
    machineRequests = {
      ...namesIn(frames, 'MACHINE_REQUESTS = new Set(['),
      ...namesIn(relay, 'OWNER_COMMAND_TYPES = new Set(['),
    };
    unwrapped = {
      ...core,
      ...machineRequests,
      ...namesIn(frames, 'FLEET_REQUESTS = new Set(['),
      ...namesIn(relay, 'PAIR_REQUESTS = new Set(['),
      ...namesIn(cli('sharing/protocol.ts'), 'SHARE_REQUEST_TYPES = new Set(['),
      ...namesIn(cli('teams/wire.ts'), 'TEAM_REQUEST_TYPES = new Set(['),
      ...namesIn(cli('lib/viewerWire.ts'), 'VIEWER_DOWN_TYPES = new Set(['),
    };
  });

  test('every frame the shared core requires sealed is sealed', () {
    expect(core, isNotEmpty);
    expect(core.difference(encryptedDownTypes), isEmpty);
  });

  test('nothing is sealed that the machine would not open', () {
    expect(encryptedDownTypes.difference(unwrapped), isEmpty);
  });

  test('a machine request this client sends is sealed', () {
    expect(machineRequests, contains('git_pull_request'));
    // Any quoted use outside the list itself counts as sending it.
    final sent = <String>{};
    for (final file in Directory('lib').listSync(recursive: true)) {
      if (file is! File || !file.path.endsWith('.dart')) continue;
      if (file.path.endsWith('e2ee/envelope.dart')) continue;
      final source = file.readAsStringSync();
      for (final type in machineRequests) {
        if (source.contains("'$type'")) sent.add(type);
      }
    }
    expect(sent, contains('git_pull_request'));
    expect(sent.difference(encryptedDownTypes), isEmpty);
  });
}
