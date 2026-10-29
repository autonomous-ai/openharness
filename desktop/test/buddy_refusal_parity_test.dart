import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/buddies.dart' show kBuddyEngineRefusals;

/// The words beside a disabled Codex in Add a Buddy are the server's own
/// refusal (security re-check of #2087). The backend holds the same pair to
/// this file (backend superTabs/buddies.test.ts), so a change on either side
/// fails until it is carried to the other.
void main() {
  test('Desktop\'s Codex Buddy refusal is the server\'s', () {
    final commands = File('../backend/src/superTabs/commands.ts');
    if (!commands.existsSync()) {
      throw StateError(
        '${commands.path} missing: run from desktop/ in the monorepo',
      );
    }
    final server = RegExp(r"export const CODEX_BUDDY_REFUSAL = '([^']*)'")
        .firstMatch(commands.readAsStringSync())
        ?.group(1);
    expect(server, isNotNull, reason: 'the backend names its refusal');
    expect(kBuddyEngineRefusals['codex'], server);
  });
}
