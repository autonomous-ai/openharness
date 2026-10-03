import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/companions/coding_memory_library.dart';
import 'package:harness/companions/coding_memory_notebooks.dart';

import 'support/coding_memory_fixture.dart';

void main() {
  late MemoryFixture connection;
  late CodingMemoryLibrary library;
  late CodingMemoryNotebooks notebooks;
  final summary = {'id': 'notebook:storage', 'title': 'Storage'};
  final detail = {
    'ok': true,
    'summary': summary,
    'explanation': {
      'statements': [
        {'text': 'This project stores local data in SQLite.'},
      ],
    },
  };
  Map<String, dynamic> reply(Map<String, dynamic> payload) =>
      switch (payload['action']) {
        'notebooks' => {
          'ok': true,
          'items': [summary],
          'nextCursor': null,
        },
        'notebook' => detail,
        _ => connection.respond(payload),
      };

  setUp(() async {
    connection = MemoryFixture()..handle = (payload) async => reply(payload);
    library = CodingMemoryLibrary(connection);
    await library.refresh();
    notebooks = CodingMemoryNotebooks(library);
  });
  tearDown(() {
    notebooks.dispose();
    library.dispose();
  });

  test('browses index and exact page, returning to the existing index without writes', () async {
    await notebooks.refresh();
    expect(notebooks.items, [summary]);
    expect(notebooks.page, isNull);
    await notebooks.open('notebook:storage');
    expect(notebooks.page, detail);
    final requests = connection.calls.length;
    notebooks.back();
    expect(notebooks.page, isNull);
    expect(notebooks.items, [summary]);
    expect(connection.calls.length, requests);
    expect(connection.calls.map((call) => call['action']), [
      'status',
      'list',
      'notebooks',
      'notebook',
    ]);
  });

  test('a late page read cannot reopen a page after Back', () async {
    await notebooks.refresh();
    final hold = Completer<Map<String, dynamic>>();
    connection.handle = (payload) => payload['action'] == 'notebook'
        ? hold.future
        : Future.value(reply(payload));
    final opening = notebooks.open('notebook:storage');
    notebooks.back();
    hold.complete(detail);
    await opening;
    expect(notebooks.selectedId, isNull);
    expect(notebooks.page, isNull);
    expect(notebooks.items, [summary]);
  });

  test('account invalidation clears loaded text and selection, including a pending reply', () async {
    await notebooks.refresh();
    await notebooks.open('notebook:storage');
    final hold = Completer<Map<String, dynamic>>();
    connection.handle = (_) => hold.future;
    final reading = notebooks.refresh();
    connection.invalidate();
    expect(notebooks.page, isNull);
    expect(notebooks.items, isEmpty);
    expect(notebooks.selectedId, isNull);
    hold.complete(detail);
    await reading;
    expect(notebooks.page, isNull);
  });

  test('a corrected library clears old explanation before its replacement read completes', () async {
    await notebooks.refresh();
    await notebooks.open('notebook:storage');
    final hold = Completer<Map<String, dynamic>>();
    connection.record = syntheticMemory(revision: 2);
    connection.handle = (payload) => payload['action'] == 'notebook'
        ? hold.future
        : Future.value(reply(payload));
    await library.refresh();
    expect(notebooks.page, isNull);
    expect(notebooks.busy, isTrue);
    hold.complete({'ok': false, 'error': 'NOT_FOUND'});
    await Future<void>.delayed(Duration.zero);
    expect(notebooks.page, isNull);
    expect(notebooks.error, contains('no longer available'));
  });

  test('ordinary library refresh discovers a page finished by the background learner', () async {
    connection.handle = (payload) async => payload['action'] == 'notebook'
        ? {...detail, 'explanation': null}
        : reply(payload);
    await notebooks.open('notebook:storage');
    expect(notebooks.page?['explanation'], isNull);
    connection.handle = (payload) async => reply(payload);
    await library.refresh();
    await Future<void>.delayed(Duration.zero);
    expect(notebooks.page?['explanation'], detail['explanation']);
  });

  test('refuses a differently identified page and supports an older service without notebooks', () async {
    connection.handle = (_) async => {
      ...detail,
      'summary': {'id': 'wrong'},
    };
    await notebooks.open('notebook:storage');
    expect(notebooks.page, isNull);
    expect(notebooks.error, contains('changed'));
    connection.handle = (_) async => {'ok': false, 'error': 'UNSUPPORTED'};
    await notebooks.refresh();
    expect(notebooks.available, isFalse);
    expect(notebooks.error, isNull);
    expect(notebooks.page, isNull);
  });

  test('more source memories stay bound to their notebook and discard a stale cursor', () async {
    final first = syntheticNotebook(syntheticMemory(project: true));
    (first['summary'] as Map)['id'] = 'notebook:storage';
    (first['memories'] as Map)['nextCursor'] = 'page-two';
    connection.handle = (p) async =>
        p['action'] == 'notebook' ? first : reply(p);
    await notebooks.open('notebook:storage');
    connection.handle = (p) async => p['action'] == 'list'
        ? {
            'ok': true,
            'items': [
              {'id': 'third-memory', 'claim': 'A later investigation.'},
            ],
            'nextCursor': 'page-three',
          }
        : reply(p);
    await notebooks.moreMemories();
    expect(connection.calls.last, {
      'action': 'list',
      'query': {
        'topicId': 'notebook:storage',
        'cursor': 'page-two',
        'limit': 20,
      },
    });
    expect((notebooks.page!['memories'] as Map)['items'], hasLength(3));
    connection.handle = (_) async => {'ok': false, 'error': 'PAGE_CHANGED'};
    await notebooks.moreMemories();
    expect(notebooks.page, isNull);
    expect(notebooks.error, contains('changed'));
  });

  test(
    'Back discards a pending source page without reopening the notebook',
    () async {
      final first = syntheticNotebook(syntheticMemory(project: true));
      (first['summary'] as Map)['id'] = 'notebook:storage';
      (first['memories'] as Map)['nextCursor'] = 'page-two';
      connection.handle = (p) async =>
          p['action'] == 'notebook' ? first : reply(p);
      await notebooks.refresh();
      await notebooks.open('notebook:storage');
      final hold = Completer<Map<String, dynamic>>();
      connection.handle = (_) => hold.future;
      final paging = notebooks.moreMemories();
      notebooks.back();
      hold.complete({
        'ok': true,
        'items': [
          {'id': 'late'},
        ],
        'nextCursor': null,
      });
      await paging;
      expect(notebooks.page, isNull);
      expect(notebooks.selectedId, isNull);
      expect(notebooks.items, [summary]);
    },
  );
}
