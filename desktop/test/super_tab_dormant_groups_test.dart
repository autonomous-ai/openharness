import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/super_tab_fixture.dart';

/// Archived and finished groups leave the active set: they are not in a first
/// load or in changes, and are read on demand
/// (docs/design/2026-10-26-swarm-state-parts.md, sections 4.5 and 5.2).
void main() {
  late ConversationServer server;
  late List<String> reads;

  Map<String, dynamic> group(String id) =>
      (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((g) => g['id'] == id);

  SuperTabController open({Map<String, dynamic>? initial}) {
    reads = [];
    return SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      initial: initial ?? const {},
      request: (method, path, {body}) {
        if (method == 'GET' && path.contains('/groups')) reads.add(path);
        return server.request(method, path, body: body);
      },
      save: server.save,
      pollInterval: Duration.zero,
    );
  }

  setUp(() {
    server = ConversationServer();
    (server.state['conversations'] as List)
      ..add({...conversationFixture('old', 'Old work'), 'archived': true})
      ..add({
        ...conversationFixture('finished', 'Finished work'),
        'dormant': true,
      });
  });

  test('a first load has only active groups; expanding the project reads the others', () async {
    final c = open();
    await c.refresh();
    expect(c.snapshot!.conversation('old'), isNull);
    expect(c.dormantLoaded('lead'), isFalse);
    c.toggleProject('lead');
    await c.loadDormant('lead');
    expect(reads, ['/api/super-tabs/tab/groups?dormant=1&projectId=lead']);
    expect(c.dormantLoaded('lead'), isTrue);
    final old = c.snapshot!.conversation('old')!;
    expect(old.archived, isTrue);
    expect(old.closed, isTrue);
    final finished = c.snapshot!.conversation('finished')!;
    expect(finished.archived, isFalse);
    expect(finished.closed, isTrue);
    expect(c.snapshot!.conversation('offline')!.closed, isFalse);
    // Read once: collapsing and expanding again reads nothing more.
    c
      ..toggleProject('lead')
      ..toggleProject('lead');
    await c.loadDormant('lead');
    expect(reads, hasLength(1));
  });

  test('an earlier page of closed groups is read on demand', () async {
    server.parts.dormantPage = 1;
    final c = open();
    await c.refresh();
    c.toggleProject('lead');
    await c.loadDormant('lead');
    expect(c.hasEarlierDormant('lead'), isTrue);
    final first = c.snapshot!.conversations.where((g) => g.closed).length;
    expect(first, 1);
    await c.loadDormant('lead', earlier: true);
    expect(reads.last, contains('&before='));
    expect(c.hasEarlierDormant('lead'), isFalse);
    expect(c.snapshot!.conversations.where((g) => g.closed), hasLength(2));
  });

  test(
    'a group archived elsewhere moves to the closed groups with its new data',
    () async {
      final c = open();
      await c.refresh();
      group('offline')['archived'] = true;
      await c.refresh();
      expect(reads, ['/api/super-tabs/tab/groups/offline']);
      final offline = c.snapshot!.conversation('offline')!;
      expect(offline.archived, isTrue);
      expect(offline.closed, isTrue);
      // Reopened: it comes back with the active groups.
      group('offline')['archived'] = false;
      await c.refresh();
      expect(c.snapshot!.conversation('offline')!.closed, isFalse);
    },
  );

  test('a saved selection of a closed group opens it by id', () async {
    final c = open(
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'old'},
    );
    await c.refresh();
    expect(c.selectedId, 'old');
    expect(c.selected!.archived, isTrue);
    expect(reads, contains('/api/super-tabs/tab/groups/old'));
  });

  test('a saved selection of a deleted group falls back to the Lead', () async {
    final c = open(
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'gone'},
    );
    await c.refresh();
    expect(c.selectedId, 'lead');
  });

  test('selecting a closed group not read yet reads it by id', () async {
    final c = open();
    await c.refresh();
    await c.select('finished');
    expect(c.selectedId, 'finished');
    expect(reads, contains('/api/super-tabs/tab/groups/finished'));
    expect(await c.select('gone'), isFalse);
    expect(c.selectedId, 'finished');
  });

  test('late loadGroup does not override a newer select', () async {
    final hold = Completer<void>();
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: (method, path, {body}) async {
        if (path.endsWith('/groups/finished')) await hold.future;
        return server.request(method, path, body: body);
      },
      save: server.save,
      pollInterval: Duration.zero,
    );
    await c.refresh();
    final slow = c.select('finished');
    // The reader moves on while the closed group is still being read.
    expect(await c.select('offline'), isTrue);
    hold.complete();
    expect(await slow, isFalse);
    expect(c.selectedId, 'offline');
  });

  test(
    'read marks and drafts of a closed group survive opening again',
    () async {
      group('finished')['dormant'] = false;
      group('finished')['lastMessageSequence'] = 4;
      final first = open();
      await first.refresh();
      first.setDraft('finished', 'A last note');
      server.append('Done', conversationId: 'finished');
      await first.refresh();
      await first.loadMessages('finished');
      first.markRead('finished');
      group('finished')['dormant'] = true;
      await first.refresh();
      await first.flush();
      first.dispose();

      final again = open(initial: server.saved);
      await again.refresh();
      await again.flush();
      expect(again.draft('finished'), 'A last note');
      again.toggleProject('lead');
      await again.loadDormant('lead');
      expect(again.unread(again.snapshot!.conversation('finished')!), isFalse);
    },
  );

  test('a reload while closed groups are being read reads them again for the new parts', () async {
    Completer<void>? hold;
    reads = [];
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: (method, path, {body}) async {
        if (method == 'GET' && path.contains('/groups')) {
          reads.add(path);
          if (hold case final wait?) await wait.future;
        }
        return server.request(method, path, body: body);
      },
      save: server.save,
      pollInterval: Duration.zero,
    );
    await c.refresh();
    hold = Completer<void>();
    c.toggleProject('lead');
    final stale = c.loadDormant('lead');
    // Who may see what changed meanwhile: the next read loads in full.
    server.parts.epoch++;
    await c.refresh();
    final waiting = hold;
    hold = null;
    waiting.complete();
    await stale;
    // The reload asked for them again by itself: nothing else asks.
    await pumpEventQueue();
    expect(reads.where((p) => p.contains('dormant=1')), hasLength(2));
    expect(c.dormantLoaded('lead'), isTrue);
    expect(c.snapshot!.conversation('old')!.closed, isTrue);
  });

  test('a failed fetch of a closed group still applies the rest of the change read', () async {
    (server.state['conversations'] as List).add(
      conversationFixture('doomed', 'Deleted soon'),
    );
    var failGroup = false;
    reads = [];
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: (method, path, {body}) async {
        if (method == 'GET' && path.contains('/groups')) {
          reads.add(path);
          if (failGroup && path.endsWith('/groups/offline')) {
            failGroup = false;
            throw StateError('Connection lost');
          }
        }
        return server.request(method, path, body: body);
      },
      save: server.save,
      pollInterval: Duration.zero,
    );
    await c.refresh();
    expect(c.snapshot!.conversation('doomed'), isNotNull);
    // One change read: a group archived, another deleted. Fetching the
    // archived one fails.
    group('offline')['archived'] = true;
    (server.state['conversations'] as List).removeWhere(
      (g) => (g as Map)['id'] == 'doomed',
    );
    failGroup = true;
    await c.refresh();
    expect(c.snapshot!.conversation('doomed'), isNull);
    expect(c.snapshot!.conversation('offline')!.closed, isTrue);
    // The next poll changes nothing more, and still gets it right.
    await c.refresh();
    expect(c.snapshot!.conversation('doomed'), isNull);
    expect(c.snapshot!.conversation('offline')!.archived, isTrue);
    expect(reads.where((p) => p.endsWith('/groups/offline')), hasLength(2));
  });
}
