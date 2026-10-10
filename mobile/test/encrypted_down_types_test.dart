import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/e2ee/envelope.dart';

/// The phone seals exactly the frames the machine insists on.
///
/// ⚠️ **Read from the CLI's source, not copied into this test.** A type the CLI requires sealed and
/// the phone does not fails nowhere on the phone — the frame leaves in the clear and the machine
/// answers E2EE_REQUIRED, which is how `agent_resume` and `git_project_info` both shipped broken.
/// Only a test that reads the CLI's lists notices the day they grow.
///
/// The CLI's rule is `encryptDownFrame` (`cli/src/lib/e2ee/applicationFrames.ts`): the shared core's
/// `ENCRYPTED_DOWN_TYPES` plus the harness-only extensions declared beside it. Both halves are read.
void main() {
  String cli(String path) {
    final file = File('../cli/src/$path');
    if (!file.existsSync()) {
      throw StateError(
        '${file.path} missing — run from mobile/ in the monorepo',
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

  /// Pair-brain frames the phone sends that a CLI may not list in
  /// `PAIR_REQUESTS` yet: the individual-art request, which the harnessd side
  /// adds (daemons/README.md, "Individual art"). Tolerated only while missing
  /// there; once the CLI lists it, it is checked like any other.
  const awaitingCli = {'pair_plate_get'};

  late Set<String> core, machineRequests, pairRequests, unwrapped;
  setUpAll(() {
    core = namesIn(cli('lib/e2ee/core.ts'), 'ENCRYPTED_DOWN_TYPES');
    final frames = cli('lib/e2ee/applicationFrames.ts');
    final relay = cli('lib/relayFrames.ts');
    machineRequests = {
      ...namesIn(frames, 'MACHINE_REQUESTS'),
      ...namesIn(cli('lib/shellProtocol.ts'), 'SHELL_REQUESTS'),
      ...namesIn(relay, 'ROUTE_COMMAND_TYPES'),
    };
    pairRequests = namesIn(relay, 'PAIR_REQUESTS');
    unwrapped = {
      ...pairRequests,
      ...core,
      ...machineRequests,
      ...namesIn(frames, 'FLEET_REQUESTS'),
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
    expect(
      encryptedDownTypes.difference(unwrapped).difference(awaitingCli),
      isEmpty,
    );
  });

  test('a pair frame the phone sends is sealed', () {
    expect(pairRequests, isNotEmpty);
    for (final type in awaitingCli) {
      expect(encryptedDownTypes, contains(type));
      expect(type, startsWith('pair_'));
    }
  });

  test('a machine request the phone sends is sealed', () {
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
    expect(sent.difference(encryptedDownTypes), isEmpty);
  });
}
