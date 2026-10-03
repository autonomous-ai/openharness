import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/daemons/individual_art.dart';
import 'package:harness_mobile/daemons/plates.dart';
import 'package:harness_mobile/daemons/zoo.dart';

void main() {
  const individual = ZooDaemon(
    id: 'tim',
    uid: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    seed: 13,
    hatchedAt: '',
    egg: 'first',
  );
  Map<String, dynamic> answer({String uid = 'aaaaaaaaaaaaaaaaaaaaaaaa'}) => {
    'uid': uid,
    'size': 'portrait',
    'version': '0.1',
    'mood': 'idle',
    'frames': [
      {'rows': ' o ', 'mats': ' . '},
    ],
    'frameMs': 170,
  };

  test('deduplicates requests and uses the returned material cells', () async {
    var calls = 0;
    final response = Completer<Map<String, dynamic>?>();
    final art = IndividualArt(
      request: (payload) {
        calls++;
        expect(payload, containsPair('uid', individual.uid));
        expect(payload, containsPair('seed', 13));
        return response.future;
      },
    );
    addTearDown(art.dispose);
    expect(art.frames(individual, PlateSize.portrait, '0.1'), isNull);
    expect(art.frames(individual, PlateSize.portrait, '0.1'), isNull);
    expect(calls, 1);
    response.complete(answer());
    await pumpEventQueue();
    expect(art.frames(individual, PlateSize.portrait, '0.1')!.single.rows, [
      ' o ',
    ]);
    expect(calls, 1);
  });

  test(
    'drops malformed or mismatched responses and retries after the cooldown',
    () async {
      var now = DateTime.utc(2026, 9, 27);
      var reply = answer(uid: 'bbbbbbbbbbbbbbbbbbbbbbbb');
      var calls = 0;
      final art = IndividualArt(
        now: () => now,
        request: (_) async {
          calls++;
          return reply;
        },
      );
      addTearDown(art.dispose);
      art.prefetch(individual, PlateSize.portrait, '0.1');
      await pumpEventQueue();
      expect(art.frames(individual, PlateSize.portrait, '0.1'), isNull);
      expect(calls, 1);
      now = now.add(IndividualArt.retryAfter);
      reply = {
        ...answer(),
        'frames': [
          {'rows': 'abc', 'mats': '.'},
        ],
      };
      art.prefetch(individual, PlateSize.portrait, '0.1');
      await pumpEventQueue();
      expect(art.frames(individual, PlateSize.portrait, '0.1'), isNull);
      now = now.add(IndividualArt.retryAfter);
      reply = answer();
      art.prefetch(individual, PlateSize.portrait, '0.1');
      await pumpEventQueue();
      expect(art.frames(individual, PlateSize.portrait, '0.1'), isNotNull);
      expect(calls, 3);
    },
  );

  test(
    'reset discards a former account request without removing its replacement',
    () async {
      final replies = <Completer<Map<String, dynamic>?>>[];
      final art = IndividualArt(
        request: (_) {
          final response = Completer<Map<String, dynamic>?>();
          replies.add(response);
          return response.future;
        },
      );
      addTearDown(art.dispose);
      art.prefetch(individual, PlateSize.portrait, '0.1');
      art.reset();
      art.prefetch(individual, PlateSize.portrait, '0.1');
      replies.first.complete(answer());
      await pumpEventQueue();
      expect(art.frames(individual, PlateSize.portrait, '0.1'), isNull);
      expect(replies, hasLength(2));
      replies.last.complete(answer());
      await pumpEventQueue();
      expect(art.frames(individual, PlateSize.portrait, '0.1'), isNotNull);
    },
  );
}
