import 'package:flutter_test/flutter_test.dart';

import 'swarm_state_test.dart' show createApp;

/// WS roadmap Phase 2a: the server's `swarm_changed` (backend
/// lib/swarmClientPushes.ts) reaches a computer's windows only through its own
/// daemon (CLI backendSocket.ts). Another machine's connection could forge it,
/// and the word that the server pushes would quiet this window's Swarm polls.
void main() {
  test(
    'takes the server\'s word that it pushes from this computer\'s daemon only',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      app.superTabs.bind('owner');
      await app.handleEventForTest('m', {
        'type': 'swarm_changed',
        'payload': <String, dynamic>{},
      });
      expect(app.superTabs.pushing, isFalse);
      app.stateOf('m')!.localOnly = true;
      await app.handleEventForTest('m', {
        'type': 'swarm_changed',
        'payload': <String, dynamic>{},
      });
      expect(app.superTabs.pushing, isTrue);
    },
  );
}
