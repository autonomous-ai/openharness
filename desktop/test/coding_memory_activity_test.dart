import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/companions/coding_memory_activity.dart';
import 'package:harness/companions/coding_memory_library.dart';

import 'support/coding_memory_fixture.dart';

void main() {
  late MemoryFixture connection;
  late CodingMemoryLibrary library;
  late CodingMemoryActivity activity;
  setUp(() async {
    connection = MemoryFixture()..recalls.add(syntheticRecall());
    library = CodingMemoryLibrary(connection);
    await library.refresh();
    activity = CodingMemoryActivity(library);
  });
  tearDown(() {
    activity.dispose();
    library.dispose();
  });

  test(
    'reads current session selections and replaces them with an empty result',
    () async {
      await activity.refresh();
      expect(activity.items, hasLength(1));
      expect(connection.calls.last, {'action': 'activity', 'query': {}});
      connection.handle = (p) async => p['action'] == 'activity'
          ? syntheticActivity(connection.record, empty: true)
          : connection.respond(p);
      await library.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(activity.items, isEmpty);
      expect(activity.selection?['selectedCount'], 0);
      expect(
        connection.calls.any((p) => ['preview', 'apply'].contains(p['action'])),
        isFalse,
      );
    },
  );

  test(
    'changing session discards a late reply without switching back',
    () async {
      final pending = Completer<Map<String, dynamic>>();
      connection.handle = (p) => (p['query'] as Map?)?['agentId'] == 'second'
          ? Future.value(
              syntheticActivity(
                connection.record,
                agentId: 'second',
                empty: true,
              ),
            )
          : pending.future;
      final old = activity.refresh();
      await activity.select('second');
      pending.complete(syntheticActivity(connection.record));
      await old;
      expect(activity.selectedAgentId, 'second');
      expect(activity.items, isEmpty);
    },
  );

  test(
    'account change removes selected content and rejects an in-flight reply',
    () async {
      await activity.refresh();
      final pending = Completer<Map<String, dynamic>>();
      connection.handle = (_) => pending.future;
      final read = activity.refresh();
      connection.invalidate();
      expect(activity.items, isEmpty);
      expect(activity.sessions, isEmpty);
      expect(activity.selectedAgentId, isNull);
      pending.complete(syntheticActivity(connection.record));
      await read;
      expect(activity.items, isEmpty);
    },
  );

  test('a corrected library clears the old selected version before the next read completes', () async {
    await activity.refresh();
    final pending = Completer<Map<String, dynamic>>();
    connection.record = syntheticMemory(revision: 2);
    connection.handle = (p) => p['action'] == 'activity'
        ? pending.future
        : Future.value(connection.respond(p));
    await library.refresh();
    expect(activity.items, isEmpty);
    pending.complete(syntheticActivity(connection.record, empty: true));
    await Future<void>.delayed(Duration.zero);
    expect(activity.items, isEmpty);
  });

  test(
    'rates the exact selected revision once and rereads saved feedback',
    () async {
      await activity.refresh();
      await activity.rate(activity.items.single, 'helpful');
      expect(connection.previewed, {
        'kind': 'feedback',
        'id': 'synthetic-memory',
        'revision': 1,
        'receiptId': 'synthetic-receipt',
        'value': 'helpful',
        'expected': 0,
      });
      expect(
        connection.calls.where((p) => p['action'] == 'apply'),
        hasLength(1),
      );
      expect(
        ((activity.items.single['recall'] as Map)['feedback'] as Map)['value'],
        'helpful',
      );
      await activity.rate(activity.items.single, null);
      expect(
        ((activity.items.single['recall'] as Map)['feedback'] as Map)['value'],
        isNull,
      );
    },
  );

  test(
    'uncertain feedback never retries the write and exposes a refresh path',
    () async {
      await activity.refresh();
      connection.refuseApply = 'TIMEOUT';
      await activity.rate(activity.items.single, 'helpful');
      expect(
        connection.calls.where((p) => p['action'] == 'apply'),
        hasLength(1),
      );
      expect(activity.error, contains('refresh to check'));
      expect(activity.items, isEmpty);
      await activity.refresh();
      expect(
        connection.calls.where((p) => p['action'] == 'apply'),
        hasLength(1),
      );
    },
  );

  test(
    'does not apply a prepared rating after the owner library changes',
    () async {
      await activity.refresh();
      final pending = Completer<Map<String, dynamic>>();
      connection.handle = (p) => p['action'] == 'preview'
          ? pending.future
          : Future.value(connection.respond(p));
      final rating = activity.rate(activity.items.single, 'helpful');
      connection.record = syntheticMemory(revision: 2);
      await library.refresh();
      pending.complete(
        connection.respond({
          'action': 'preview',
          'command': {'kind': 'feedback', 'expected': 0, 'value': 'helpful'},
        }),
      );
      await rating;
      expect(connection.calls.where((p) => p['action'] == 'apply'), isEmpty);
      expect(activity.writing, isFalse);
    },
  );

  test('handles older services and refuses a response for a different selected session', () async {
    connection.handle = (_) async => {'ok': false, 'error': 'INVALID_INPUT'};
    await activity.refresh();
    expect(activity.available, isFalse);
    connection.handle = (_) async => syntheticActivity(connection.record);
    await activity.select('another-session');
    expect(activity.items, isEmpty);
    expect(activity.error, contains('changed'));
  });
}
