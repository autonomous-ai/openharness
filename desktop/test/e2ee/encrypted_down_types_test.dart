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

  /// Quoted names in a declared set/array literal, including typed declarations.
  /// Comments also quote frame names, so exclude them from the contract.
  Set<String> namesIn(String source, String name) {
    final code = source
        .split('\n')
        .map((line) => line.split('//').first)
        .join('\n');
    final declaration = RegExp(
      r'\b' +
          RegExp.escape(name) +
          r'(?:\s*:[^=]+)?\s*=\s*(?:new Set(?:<[^>]+>)?\(\s*)?\[([\s\S]*?)\]',
    ).firstMatch(code);
    if (declaration == null) throw StateError('could not find $name literal');
    return {
      for (final match in RegExp(r"'([a-z0-9_]+)'").allMatches(declaration[1]!))
        match[1]!,
    };
  }

  /// `PLATE_REQUEST` is one type, not a set: `encryptDownFrame` compares it with `===`.
  String plateRequest(String relay) {
    final match = RegExp(r"export const PLATE_REQUEST = '([a-z0-9_]+)'")
        .firstMatch(relay);
    if (match == null) throw StateError('could not find PLATE_REQUEST');
    return match[1]!;
  }

  late Set<String> core, machineRequests, unwrapped;
  setUpAll(() {
    core = namesIn(cli('lib/e2ee/core.ts'), 'ENCRYPTED_DOWN_TYPES');
    final frames = cli('lib/e2ee/applicationFrames.ts');
    final relay = cli('lib/relayFrames.ts');
    // `MACHINE_REQUESTS` also spreads the owner commands in; those are read where they are declared.
    machineRequests = {
      ...namesIn(frames, 'MACHINE_REQUESTS'),
      ...namesIn(cli('lib/shellProtocol.ts'), 'SHELL_REQUESTS'),
      ...namesIn(relay, 'OWNER_COMMAND_TYPES'),
      ...namesIn(relay, 'ROUTE_COMMAND_TYPES'),
    };
    unwrapped = {
      ...core,
      ...machineRequests,
      ...namesIn(frames, 'FLEET_REQUESTS'),
      ...namesIn(relay, 'PAIR_REQUESTS'),
      plateRequest(relay),
      ...namesIn(cli('sharing/protocol.ts'), 'SHARE_REQUEST_TYPES'),
      ...namesIn(cli('teams/wire.ts'), 'TEAM_REQUEST_TYPES'),
      ...namesIn(cli('lib/viewerFrames.ts'), 'VIEWER_DOWN_TYPES'),
    };
  });

  test('every frame the shared core requires sealed is sealed', () {
    expect(core, isNotEmpty);
    expect(core.difference(encryptedDownTypes), isEmpty);
  });

  test('nothing is sealed that the machine would not open', () {
    expect(encryptedDownTypes.difference(unwrapped), isEmpty);
  });

  test('the rule read is the one the machine applies', () {
    // A new set joined to encryptDownFrame would go unread above: fail until
    // it is added there too.
    final rule = cli('lib/e2ee/applicationFrames.ts');
    final from = rule.indexOf('export const encryptDownFrame');
    final body = rule.substring(from, rule.indexOf('\nexport ', from + 1));
    final named = RegExp(r'\b([A-Z][A-Z_]+)\b')
        .allMatches(body)
        .map((m) => m[1]);
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
