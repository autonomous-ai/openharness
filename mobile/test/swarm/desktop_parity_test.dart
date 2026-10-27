import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The Swarm models the phone carries as copies of the desktop's
/// (`../desktop/lib/super_tabs`): phone path → desktop path. The phone is a
/// standalone package (README), so it cannot import them.
///
/// ⚠️ A fix made to one side only fails nowhere else: a field the backend adds
/// would parse on a computer and be dropped on the phone. Here a drift fails
/// until the change is carried across — or, if the two are meant to differ now,
/// until the file leaves this list on purpose.
const _copies = {
  'lib/swarm/model.dart': 'lib/super_tabs/model.dart',
  'lib/swarm/parts.dart': 'lib/super_tabs/parts.dart',
};

void main() {
  for (final MapEntry(key: phone, value: desktop) in _copies.entries) {
    test("$phone matches the desktop's $desktop", () {
      final source = File('../desktop/$desktop');
      if (!source.existsSync()) {
        throw StateError(
          '${source.path} missing — run from mobile/ in the monorepo',
        );
      }
      final copy = File(phone);
      expect(copy.existsSync(), isTrue, reason: '$phone is missing');
      expect(
        copy.readAsStringSync(),
        source.readAsStringSync(),
        reason:
            'carry the change to both copies (or drop the pair from '
            'test/swarm/desktop_parity_test.dart if they are meant to differ)',
      );
    });
  }
}
