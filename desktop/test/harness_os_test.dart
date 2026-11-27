import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/harness_os/harness_os.dart';

import 'support/memory_key_value_store.dart';

void main() {
  group('HarnessOs', () {
    late List<Map<String, dynamic>> asked;
    late Map<String, dynamic> Function() reply;
    late MemoryKeyValueStore storage;

    HarnessOs build() => HarnessOs(
      storage: storage,
      request: (id, payload, {timeout = const Duration(seconds: 25)}) async {
        asked.add({'id': id, ...payload});
        return reply();
      },
    );

    setUp(() {
      asked = [];
      storage = MemoryKeyValueStore();
      reply = () => {
        'harnessOs': true,
        'hotspot': 'Harness-AB12',
        'encrypted': true,
        'wifi': {'ssid': 'Home'},
        'features': ['password', 'ssh'],
        'update': {
          'available': true,
          'parts': {
            'os': {
              'running': '0.1.8.r1.gabc-1',
              'next': '0.1.9.r2.gdef-1',
              'available': true,
            },
            'hn': {'available': false},
            'cli': {'available': false},
          },
        },
      };
    });

    test(
      'reads what the status says, and asks again only when stale or forced',
      () async {
        final os = build();
        await os.refresh('m1');
        expect(os.runsHarnessOs('m1'), isTrue);
        expect(os.feature('m1', 'ssh'), isTrue);
        expect(os.feature('m1', 'github'), isFalse);
        expect(os.wifi('m1'), 'Home');
        expect(os.updateAvailable('m1'), isTrue);
        expect(os.newRelease('m1'), isTrue);
        expect(os.updateRestarts('m1'), isTrue);
        await os.refresh('m1');
        expect(asked, hasLength(1));
        await os.refresh('m1', force: true);
        expect(asked, hasLength(2));
        expect(asked.last, {'id': 'm1', 'action': 'status'});
      },
    );

    test('a later build of the same release is no new release', () async {
      reply = () => {
        'harnessOs': true,
        'update': {
          'available': true,
          'parts': {
            'os': {
              'running': '0.1.8.r1.gabc-1',
              'next': '0.1.8.r9.g999-1',
              'available': true,
            },
          },
        },
      };
      final os = build();
      await os.refresh('m1');
      expect(os.newRelease('m1'), isFalse);
      expect(os.updateAvailable('m1'), isFalse);
      expect(os.updateRestarts('m1'), isFalse);
    });

    test(
      'an unreachable computer is asked again at once, and keeps nothing',
      () async {
        reply = () => {'error': 'UNAVAILABLE'};
        final os = build();
        await os.refresh('m1');
        await os.refresh('m1');
        expect(asked, hasLength(2));
        expect(os.runsHarnessOs('m1'), isFalse);
      },
    );

    test('remembers each hotspot and disk between launches, until signed out from here', () async {
      final os = build();
      await os.refresh('m1');
      expect(jsonDecode(storage.values[HarnessOs.storageKey]!), {
        'm1': {'hotspot': 'Harness-AB12', 'encrypted': true},
      });

      final next = build();
      await next.load();
      expect(next.encrypted('m1'), isTrue);
      expect(next.hotspot('m1'), 'Harness-AB12');
      expect(next.runsHarnessOs('m1'), isFalse);

      next.forget('m1');
      expect(next.encrypted('m1'), isFalse);
      expect(jsonDecode(storage.values[HarnessOs.storageKey]!), isEmpty);
    });

    test(
      'a new account asks every status again and keeps the computers seen',
      () async {
        final os = build();
        await os.refresh('m1');
        os.resetStatus();
        expect(os.runsHarnessOs('m1'), isFalse);
        expect(os.encrypted('m1'), isTrue);
        await os.refresh('m1');
        expect(asked, hasLength(2));
      },
    );
  });
}
