import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/envelope.dart';

/// This client seals every frame the machine insists on.
///
/// ⚠️ **Read from the CLI's source, not copied into this test.** A type the CLI requires sealed and
/// this client does not fails nowhere here — the frame leaves in the clear and the machine answers
/// E2EE_REQUIRED. That is how `agent_resume` and `agent_fork` went unsealed from the web build.
/// Only a test that reads the CLI's list notices the day it grows (mobile has the same test).
void main() {
  test('every frame the shared core requires sealed is sealed', () {
    final file = File('../cli/src/lib/e2ee/core.ts');
    if (!file.existsSync()) {
      throw StateError(
        '${file.path} missing — run from desktop/ in the monorepo',
      );
    }
    final source = file.readAsStringSync();
    const start = 'ENCRYPTED_DOWN_TYPES = new Set<string>([';
    final from = source.indexOf(start);
    expect(from, greaterThanOrEqualTo(0));
    // The CLI's comments quote type names too: strip `//` comments before reading the names.
    final code = source
        .substring(from, source.indexOf('])', from))
        .split('\n')
        .map((line) => line.split('//').first)
        .join('\n');
    final core = {
      for (final m in RegExp(r"'([a-z0-9_]+)'").allMatches(code)) m[1]!,
    };
    expect(core, isNotEmpty);
    expect(core.difference(encryptedDownTypes), isEmpty);
  });
}
