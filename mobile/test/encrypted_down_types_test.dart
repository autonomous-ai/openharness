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
    final code = body
        .split('\n')
        .map((line) => line.split('//').first)
        .join('\n');
    return {
      for (final match in RegExp(r"'([a-z0-9_]+)'").allMatches(code)) match[1]!,
    };
  }

  test('seals every type the CLI insists on', () {
    final core = File('../cli/src/lib/e2ee/core.ts');
    expect(
      core.existsSync(),
      isTrue,
      reason: 'run from mobile/ in the monorepo',
    );
    final cli = namesIn(
      core.readAsStringSync(),
      'ENCRYPTED_DOWN_TYPES = new Set<string>([',
      '])',
    );
    expect(cli, isNotEmpty);
    expect(
      encryptedDownTypes,
      containsAll(cli),
      reason:
          'a type the machine requires and the phone sends in the clear '
          'comes back E2EE_REQUIRED',
    );
  });

  /// ⚠️ **`ENCRYPTED_DOWN_TYPES` is NOT the machine's whole rule**, and reading
  /// it as though it were cost an afternoon: `git_project_info` is required by
  /// `encryptDownFrame` in `lib/e2ee/applicationFrames.ts`, which is that set
  /// OR several types named outright beside it. Sealing it looked wrong against
  /// the narrow list, the entry was taken back out, and the machine went on
  /// answering E2EE_REQUIRED.
  ///
  /// So the two halves are tested apart: everything the set names must be
  /// sealed (above), and anything sealed BEYOND it must be something the
  /// machine will actually unwrap (here). Sealing a type the CLI does not
  /// unwrap is the quieter fault of the two — the envelope is never opened, the
  /// payload reads back as undefined fields, and the caller waits out its
  /// timeout.
  test('seals nothing the CLI would refuse to unwrap', () {
    final frames = File('../cli/src/lib/e2ee/applicationFrames.ts');
    expect(
      frames.existsSync(),
      isTrue,
      reason: 'run from mobile/ in the monorepo',
    );
    final source = frames.readAsStringSync();
    final rule = source.substring(
      source.indexOf('encryptDownFrame'),
      source.indexOf('encryptRpcResult'),
    );
    final core = namesIn(
      File('../cli/src/lib/e2ee/core.ts').readAsStringSync(),
      'ENCRYPTED_DOWN_TYPES = new Set<string>([',
      '])',
    );
    // The types the rule names outright, beside the set it starts from.
    final named = {
      for (final match in RegExp(r"'([a-z0-9_]+)'").allMatches(rule)) match[1]!,
    };
    expect(named, contains('git_project_info'));
    expect(encryptedDownTypes.difference(core.union(named)), isEmpty);
  });
}
