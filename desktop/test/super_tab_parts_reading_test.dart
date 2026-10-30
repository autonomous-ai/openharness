import 'package:flutter_test/flutter_test.dart';

import 'support/memory_key_value_store.dart';

import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/super_tab_fixture.dart';

/// Desktop and the web read a Swarm once, then only what changed since
/// (docs/design/2026-10-26-swarm-state-parts.md, section 5.2).
void main() {
  late ConversationServer server;
  late List<String> reads;

  SuperTabController open() {
    reads = [];
    return SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: (method, path, {body}) {
        if (method == 'GET' && !path.contains('/messages')) reads.add(path);
        return server.request(method, path, body: body);
      },
      save: server.save,
      pollInterval: Duration.zero,
    );
  }

  setUp(() => server = ConversationServer());

  test(
    'opens with one first load, then reads changes since its cursor',
    () async {
      final c = open();
      await c.refresh();
      expect(reads, ['/api/super-tabs/tab/parts']);
      expect(c.snapshot!.conversation('offline')!.lastMessageSequence, 0);

      // Another client posts.
      server.append('From another client', conversationId: 'offline');
      await c.refresh();
      expect(reads.last, startsWith('/api/super-tabs/tab/changes?cursor='));
      expect(reads.where((p) => p.endsWith('/parts')), hasLength(1));
      expect(c.snapshot!.conversation('offline')!.lastMessageSequence, 1);
      expect(c.lastChangedAt, greaterThan(0));
    },
  );

  test(
    'each change read starts at the cursor the last read returned',
    () async {
      final c = open();
      await c.refresh();
      final first = server.parts.reads.last;
      expect(first, '/api/super-tabs/tab/parts');
      await c.refresh();
      await c.refresh();
      final cursors = [
        for (final path in reads.skip(1))
          Uri.parse(path).queryParameters['cursor'],
      ];
      expect(cursors, hasLength(2));
      // The second change read starts later than the first: the cursor moved.
      expect(cursors[0], isNot(cursors[1]));
    },
  );

  test('a reload answer reads the Swarm again in full', () async {
    final c = open();
    await c.refresh();
    server.parts.epoch++;
    (server.state['conversations'] as List).add(
      conversationFixture('private', 'Ken and the PM'),
    );
    await c.refresh();
    expect(reads, [
      '/api/super-tabs/tab/parts',
      startsWith('/api/super-tabs/tab/changes?cursor='),
      '/api/super-tabs/tab/parts',
    ]);
    expect(c.snapshot!.conversation('private'), isNotNull);
    expect(c.error, isNull);
  });

  test(
    'a refused change read reads in full; a refused first load closes the tab',
    () async {
      final c = open();
      await c.refresh();
      var refuse = 1;
      final inner = server.request;
      final closing = SuperTabController(
        tabId: 'tab',
        accountId: 'owner',
        request: (method, path, {body}) {
          if (method == 'GET' && !path.contains('/messages')) reads.add(path);
          if (path.contains('/changes') && refuse-- > 0) {
            throw const SuperTabFailure('NOT_FOUND', 'Gone.', statusCode: 404);
          }
          if (path.endsWith('/parts') && reads.length > 2) {
            throw const SuperTabFailure(
              'FORBIDDEN',
              'No access.',
              statusCode: 403,
            );
          }
          return inner(method, path, body: body);
        },
        save: server.save,
        pollInterval: Duration.zero,
      );
      reads = [];
      await closing.refresh();
      await closing.refresh();
      expect(reads, [
        '/api/super-tabs/tab/parts',
        startsWith('/api/super-tabs/tab/changes?cursor='),
        '/api/super-tabs/tab/parts',
      ]);
      expect(closing.accessRevoked, isTrue);
      expect(c.accessRevoked, isFalse);
    },
  );

  test(
    'a removed group leaves the snapshot and its local state goes',
    () async {
      final c = open();
      await c.refresh();
      c.setDraft('offline', 'An unsent note');
      c.markRead('offline');
      (server.state['conversations'] as List).removeWhere(
        (g) => (g as Map)['id'] == 'offline',
      );
      await c.refresh();
      await c.flush();
      expect(c.snapshot!.conversation('offline'), isNull);
      expect(c.draft('offline'), '');
      expect(server.saved!['drafts'], isNot(contains('offline')));
    },
  );

  test('a command is followed by one change read', () async {
    final c = open();
    await c.refresh();
    reads.clear();
    c.setDraft('lead', 'Hello');
    await c.send();
    expect(reads, [startsWith('/api/super-tabs/tab/changes?cursor=')]);
    expect(c.snapshot!.conversation('lead')!.lastMessageSequence, 1);
  });

  test('nothing reads the whole Swarm any more', () async {
    final c = open();
    await c.refresh();
    await c.refresh();
    expect(reads, isNot(contains('/api/super-tabs/tab')));
    expect(c.error, isNull);
  });

  test('a one-off read of a Swarm is one first load', () async {
    final paths = <String>[];
    final client = SuperTabClient(
      storage: MemoryKeyValueStore(),
      discoveryInterval: Duration.zero,
      transport: (method, path, {body}) {
        paths.add(path);
        return server.request(method, path, body: body);
      },
    )..bind('owner');
    final snapshot = await client.readSnapshot('tab');
    expect(paths, ['/api/super-tabs/tab/parts']);
    expect(snapshot.conversation('offline')!.title, 'Offline editing');
    client.dispose();
  });

  test(
    'an answer that does not read is not kept: the next read loads in full',
    () async {
      final c = open();
      await c.refresh();
      var broken = true;
      final inner = server.request;
      final reading = SuperTabController(
        tabId: 'tab',
        accountId: 'owner',
        request: (method, path, {body}) async {
          if (method == 'GET' && !path.contains('/messages')) reads.add(path);
          final answer = await inner(method, path, body: body);
          if (path.contains('/changes') && broken) {
            broken = false;
            return {...answer, 'cursor': null};
          }
          return answer;
        },
        save: server.save,
        pollInterval: Duration.zero,
      );
      reads = [];
      await reading.refresh();
      await reading.refresh();
      expect(reading.error, isNotNull);
      await reading.refresh();
      expect(reads, [
        '/api/super-tabs/tab/parts',
        startsWith('/api/super-tabs/tab/changes?cursor='),
        '/api/super-tabs/tab/parts',
      ]);
      expect(reading.error, isNull);
    },
  );

  test('a first load of another Swarm is not kept', () async {
    server.state['id'] = 'another';
    final c = open();
    await c.refresh();
    expect(c.snapshot, isNull);
    expect(c.error, isNotNull);
    server.state['id'] = 'tab';
    await c.refresh();
    expect(reads.last, '/api/super-tabs/tab/parts');
    expect(c.snapshot!.id, 'tab');
  });

  test('a private conversation the reader leaves is gone after the reload', () async {
    (server.state['conversations'] as List).add({
      ...conversationFixture('private', 'Ken and the PM'),
      'audience': {
        'people': [
          {'id': 'owner', 'generation': 'g1'},
        ],
      },
    });
    server.append('Just us', conversationId: 'private');
    final c = open();
    await c.refresh();
    await c.select('private');
    await c.loadMessages('private');
    expect(c.messages('private').single.text, 'Just us');
    // The audience changed: the server moves the epoch and no longer sends it.
    (server.state['conversations'] as List).removeWhere(
      (g) => (g as Map)['id'] == 'private',
    );
    server.messages.removeWhere((m) => m['conversationId'] == 'private');
    server.parts.epoch++;
    await c.refresh();
    expect(c.snapshot!.conversation('private'), isNull);
    expect(c.messages('private'), isEmpty);
    expect(c.selectedId, 'lead');
  });
}
