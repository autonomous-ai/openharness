import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Files the web build carries as copies of the phone's (`../mobile`, a
/// standalone package by design): desktop path → mobile path.
///
/// ⚠️ A fix made to one side only fails nowhere else. That is how the web's
/// E2EE went months without the phone's one-welcome and rekey-replay fixes.
/// Here a drift fails until the change is carried across — or, if the two are
/// meant to differ now, until the file leaves this list on purpose.
///
/// Left on purpose (2026-10-14): the P2P plugin and policy, the relay codec and
/// the E2EE session. The phone changed them for its own launch and network:
/// the channel starts on the first terminal with no open wait, a dropped
/// channel is redialled within seconds, and the hello, the welcome and a large
/// frame are worked on a background isolate. The web keeps its copies.
const _copies = {
  'lib/web/p2p/terminal_p2p_link.dart': 'lib/p2p/terminal_p2p_link.dart',
  'lib/ws/terminal_transport_plugin.dart':
      'lib/ws/terminal_transport_plugin.dart',
};

/// The phone's package name is the only difference a copy is allowed.
String _asDesktop(String mobileSource) =>
    mobileSource.replaceAll('package:harness_mobile/', 'package:harness/');

void main() {
  for (final MapEntry(key: desktop, value: mobile) in _copies.entries) {
    test('$desktop matches the phone\'s $mobile', () {
      final phone = File('../mobile/$mobile');
      if (!phone.existsSync()) {
        throw StateError('${phone.path} missing — run from desktop/ in the monorepo');
      }
      expect(
        File(desktop).readAsStringSync(),
        _asDesktop(phone.readAsStringSync()),
        reason: 'carry the change to both copies (or drop the pair from '
            'test/p2p/mobile_parity_test.dart if they are meant to differ)',
      );
    });
  }
}
