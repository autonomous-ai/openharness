import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/companions/coding_memory_connection.dart';
import 'package:harness/companions/coding_memory_library.dart';

import 'support/coding_memory_fixture.dart';

void main() {
  late MemoryFixture transport;
  late CodingMemoryLibrary library;
  setUp(() {
    transport = MemoryFixture();
    library = CodingMemoryLibrary(transport);
  });
  tearDown(() => library.dispose());

  test(
    'inspection filters and pagination never claim owner or agent authority',
    () async {
      transport.cursor = 'synthetic-cursor';
      await library.refresh(filter: 'project');
      expect(library.available, isTrue);
      expect(library.items, hasLength(1));
      await library.refresh(more: true);
      expect(transport.calls.last, {
        'action': 'list',
        'query': {
          'scope': 'project',
          'limit': 20,
          'cursor': 'synthetic-cursor',
        },
      });
      expect(
        transport.calls.any(
          (p) =>
              p.containsKey('owner') ||
              p.containsKey('agentId') ||
              p.containsKey('token'),
        ),
        isFalse,
      );
    },
  );

  test('account invalidation discards an in-flight page and already rendered content', () async {
    await library.refresh();
    final pending = Completer<Map<String, dynamic>>();
    transport.handle = (p) async =>
        p['action'] == 'list' ? pending.future : transport.respond(p);
    final loading = library.refresh();
    await Future<void>.delayed(Duration.zero);
    transport.invalidate();
    expect(library.items, isEmpty);
    expect(library.status, isNull);
    pending.complete(transport.respond({'action': 'list'}));
    await loading;
    expect(library.items, isEmpty);
    expect(library.error, contains('account changed'));
  });

  test('a changed page snapshot does not leave old private or deleted rows visible', () async {
    transport.cursor = 'old';
    await library.refresh();
    transport.handle = (p) async => p['action'] == 'list'
        ? {'ok': false, 'error': 'PAGE_CHANGED'}
        : transport.respond(p);
    await library.refresh(more: true);
    expect(library.items, isEmpty);
    expect(library.nextCursor, isNull);
    expect(library.error, contains('changed'));
  });

  test('application sends only the one-use capability and never retries a lost result', () async {
    final preview = await library.preview({
      'kind': 'forget',
      'id': 'synthetic-memory',
      'revision': 1,
    });
    transport.refuseApply = 'TIMEOUT';
    await expectLater(
      library.apply(preview),
      throwsA(isA<CodingMemoryFailure>()),
    );
    expect(transport.calls.last, {'action': 'apply', 'capability': 'a' * 32});
    final count = transport.calls.length;
    await expectLater(
      library.apply(preview),
      throwsA(isA<CodingMemoryFailure>()),
    );
    expect(transport.calls.length, count);
  });

  test(
    'reconnect and expiry require a new preview before any mutation',
    () async {
      final preview = await library.preview({
        'kind': 'forget',
        'id': 'synthetic-memory',
        'revision': 1,
      });
      transport.reconnect();
      await expectLater(
        library.apply(preview),
        throwsA(isA<CodingMemoryFailure>()),
      );
      final expired = CodingMemoryPreview(
        'b' * 32,
        {},
        transport.epoch,
        Duration.zero,
      );
      await expectLater(
        library.apply(expired),
        throwsA(isA<CodingMemoryFailure>()),
      );
      expect(transport.calls.where((c) => c['action'] == 'apply'), isEmpty);
    },
  );

  test(
    'forget drops the old page before a failed refresh can restore it',
    () async {
      await library.refresh();
      final preview = await library.preview({
        'kind': 'forget',
        'id': 'synthetic-memory',
        'revision': 1,
      });
      await library.apply(preview);
      expect(library.items, isEmpty);
      transport.handle = (_) async =>
          throw const CodingMemoryFailure('TIMEOUT');
      await library.refresh();
      expect(library.items, isEmpty);
    },
  );

  test(
    'a service without coding memory stays on the existing library',
    () async {
      transport.handle = (_) async => {'ok': false, 'error': 'UNSUPPORTED'};
      await library.refresh();
      expect(library.available, isFalse);
      expect(transport.calls, [
        {'action': 'status'},
      ]);
    },
  );
}
