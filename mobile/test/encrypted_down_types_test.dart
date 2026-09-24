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
    machineRequests = namesIn(frames, 'MACHINE_REQUESTS = new Set([');
    unwrapped = {
      ...core,
      ...machineRequests,
      ...namesIn(frames, 'FLEET_REQUESTS = new Set(['),
      ...namesIn(cli('sharing/protocol.ts'), 'SHARE_REQUEST_TYPES = new Set(['),
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
