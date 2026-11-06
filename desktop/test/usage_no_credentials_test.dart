import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/usage_controller.dart';

void main() {
  test(
    'Desktop usage never opens CLI logins or calls vendor usage endpoints',
    () {
      // CLI reports are the only usage boundary. Keep file/process/token access
      // out of this directory so adding a provider cannot restore credential reads.
      final forbidden = RegExp(
        r"dart:io|usage_credentials|UsageCredentials|Authorization|api/oauth/usage|backend-api/wham/usage|find-generic-password|auth\.json|\.credentials\.json",
      );
      final violations = <String>[];
      for (final file in Directory('lib/usage').listSync().whereType<File>()) {
        if (file.path.endsWith('.dart') &&
            forbidden.hasMatch(file.readAsStringSync())) {
          violations.add(file.path);
        }
      }
      expect(
        violations,
        isEmpty,
        reason: 'Usage must consume CLI reports, never logins.',
      );
    },
  );

  test(
    'default Desktop usage has no local credential-backed sources',
    () async {
      final usage = UsageController(autoStart: false);
      addTearDown(usage.dispose);
      expect(usage.readings, isEmpty);
      await usage.refresh();
      expect(usage.readings, isEmpty);
    },
  );
}
