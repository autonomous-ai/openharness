import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/e2ee/envelope.dart';

/// The phone seals exactly the frames the machine insists on.
///
/// ⚠️ **Read from the CLI's source, not copied into this test.** A type the CLI adds to
/// `ENCRYPTED_DOWN_TYPES` and the phone does not fails nowhere on the phone — the frame leaves in the
/// clear and the machine answers E2EE_REQUIRED, which is how `agent_resume` shipped broken. Only a
/// test that reads the CLI's list notices the day it grows.
void main() {
  /// The quoted names in a set literal, with `//` comments stripped first — the CLI's comments quote
  /// type names too.
  Set<String> namesIn(String source, String start, String end) {
    final from = source.indexOf(start);
    expect(from, isNonNegative, reason: 'could not find $start');
    final body = source.substring(from, source.indexOf(end, from));
    final code = body.split('\n').map((line) => line.split('//').first).join('\n');
    return {
      for (final match in RegExp(r"'([a-z0-9_]+)'").allMatches(code)) match[1]!,
    };
  }

  test('matches the CLI\'s ENCRYPTED_DOWN_TYPES', () {
    final core = File('../cli/src/lib/e2ee/core.ts');
    expect(core.existsSync(), isTrue, reason: 'run from mobile/ in the monorepo');
    final cli = namesIn(
      core.readAsStringSync(),
      'ENCRYPTED_DOWN_TYPES = new Set<string>([',
      '])',
    );
    expect(cli, isNotEmpty);
    expect(encryptedDownTypes, cli);
  });
}
