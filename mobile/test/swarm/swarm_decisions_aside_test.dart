import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_home_prefs.dart';

import '../voice_fakes.dart';

// Tony's phone list, task 26: Not now stays on this phone, as on Desktop's computer.
void main() {
  Future<SwarmHomePrefs> open(MemoryKeyValueStore store) async {
    final prefs = SwarmHomePrefs(accountId: 'me', store: store);
    addTearDown(prefs.dispose);
    await pumpEventQueue();
    return prefs;
  }

  test(
    'a decision set aside stays so after a restart, and comes back when shown',
    () async {
      final store = MemoryKeyValueStore();
      final first = await open(store);
      first.setDecisionsAside('swarm', ['d1', 'd2'], aside: true);
      await pumpEventQueue();

      final second = await open(store);
      expect(second.decisionAside('swarm', 'd1'), isTrue);
      expect(
        second.decisionAside('swarm', 'd3'),
        isFalse,
        reason: 'asked later',
      );
      expect(second.decisionAside('other', 'd1'), isFalse);

      second.setDecisionsAside('swarm', ['d1'], aside: false);
      await pumpEventQueue();
      final third = await open(store);
      expect(third.decisionAside('swarm', 'd1'), isFalse);
      expect(third.decisionAside('swarm', 'd2'), isTrue);
    },
  );

  test('one answered is forgotten, a Swarm lost takes its own, and the oldest '
      'go past the limit', () async {
    final prefs = await open(MemoryKeyValueStore());
    prefs.setDecisionsAside('swarm', ['d1', 'd2'], aside: true);
    prefs.forgetDecisionsAside('swarm', ['d1']);
    expect(prefs.decisionAside('swarm', 'd1'), isFalse);
    expect(prefs.decisionAside('swarm', 'd2'), isTrue);

    prefs.keepOnly({'other'});
    expect(prefs.decisionAside('swarm', 'd2'), isFalse);

    prefs.keepOnly({'swarm'});
    prefs.setDecisionsAside('swarm', [
      for (var i = 0; i <= SwarmHomePrefs.keptAside; i++) 'n$i',
    ], aside: true);
    expect(prefs.decisionAside('swarm', 'n0'), isFalse);
    expect(
      prefs.decisionAside('swarm', 'n${SwarmHomePrefs.keptAside}'),
      isTrue,
    );
  });
}
