import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_read_marks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_threads.dart';

import 'swarm_fixture.dart';

/// The phone's one Threads row and page over the Swarms Home shows: each
/// Swarm's followed threads put together.
void main() {
  Map<String, dynamic> row(
    String chat,
    String root, {
    int unread = 0,
    String at = '2026-11-01T01:00:00.000Z',
  }) => {
    'conversationId': chat,
    'rootId': root,
    'root': {
      'id': root,
      'sequence': 1,
      'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
      'text': 'root $root',
      'createdAt': '2026-11-01T00:00:00.000Z',
    },
    'lastReplyAt': at,
    'lastReplySequence': 3,
    'unreadReplies': unread,
    'replies': 2,
    'follow': null,
  };

  /// One Swarm [id] listing chat [chat], whose threads route answers
  /// [answer].
  ({FakeSwarm swarm, SwarmReader reader, SwarmThreads threads}) swarmOf(
    String id,
    String chat,
    FutureOr<Object?> Function() answer,
  ) {
    final swarm = FakeSwarm();
    final path = '/api/super-tabs/$id';
    swarm.routes['$path/parts'] = (_) => firstLoad(
      tabId: id,
      groups: [groupData(chat, title: 'Chat $chat', lastMessageSequence: 3)],
      derived: {
        'readMarks': {chat: 1},
      },
    );
    swarm.routes['$path/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes['$path/threads'] = (_) => answer();
    swarm.routes['$path/conversations/'] = (_) => {'ok': true};
    final reader = SwarmReader(
      tabId: id,
      accountId: me,
      request: swarm.request,
    );
    final marks = SwarmReadMarks(reader, store: null);
    reader.readMarks = marks;
    final threads = SwarmThreads(reader);
    addTearDown(() {
      threads.dispose();
      marks.dispose();
      reader.dispose();
    });
    return (swarm: swarm, reader: reader, threads: threads);
  }

  /// The page over [sources], every one of them shown unless [shown] says.
  ({SwarmThreadsMerge merge, ValueNotifier<int> changed}) mergeOf(
    Map<String, SwarmThreads> sources, {
    List<String>? shown,
  }) {
    final changed = ValueNotifier(0);
    final merge = SwarmThreadsMerge(
      source: (id) => sources[id],
      swarms: () => [
        for (final id in shown ?? sources.keys.toList())
          (id: id, name: 'Swarm $id'),
      ],
      changed: changed,
    );
    merge.addListener(() {});
    addTearDown(merge.dispose);
    return (merge: merge, changed: changed);
  }

  test('puts the Swarms\' threads together, new first, newest reply first, '
      'each naming its Swarm', () async {
    final a = swarmOf(
      's1',
      'g1',
      () => {
        'unread': [row('g1', 'a1', unread: 1, at: '2026-11-01T01:00:00.000Z')],
        'read': [row('g1', 'a2', at: '2026-11-01T05:00:00.000Z')],
      },
    );
    final b = swarmOf(
      's2',
      'h1',
      () => {
        'unread': [row('h1', 'b1', unread: 2, at: '2026-11-01T03:00:00.000Z')],
        'read': [row('h1', 'b2', at: '2026-11-01T04:00:00.000Z')],
      },
    );
    await a.reader.refresh();
    await b.reader.refresh();

    final m = mergeOf({'s1': a.threads, 's2': b.threads}).merge;
    await settle();

    expect(m.manySwarms, isTrue);
    expect(m.loaded, isTrue);
    expect(m.unread, isTrue);
    expect([for (final e in m.fresh) e.thread.key], ['h1/b1', 'g1/a1']);
    expect([for (final e in m.rest) e.thread.key], ['g1/a2', 'h1/b2']);
    expect(m.fresh.first.swarmName, 'Swarm s2');
    expect(m.chat(m.fresh.first)?.title, 'Chat h1');
  });

  test('a Swarm that leaves Home leaves the page at once', () async {
    final a = swarmOf(
      's1',
      'g1',
      () => {
        'unread': [row('g1', 'a1', unread: 1)],
        'read': [],
      },
    );
    final b = swarmOf(
      's2',
      'h1',
      () => {
        'unread': [row('h1', 'b1', unread: 1)],
        'read': [],
      },
    );
    await a.reader.refresh();
    await b.reader.refresh();
    final sources = {'s1': a.threads, 's2': b.threads};
    final r = mergeOf(sources);
    r.merge.opened();
    await settle();
    expect(r.merge.fresh, hasLength(2));

    var told = 0;
    r.merge.addListener(() => told++);
    sources.remove('s2');
    r.changed.value++;

    expect([for (final e in r.merge.fresh) e.swarmId], ['s1']);
    expect(r.merge.manySwarms, isFalse);
    told = 0;
    b.reader.revoke();
    expect(told, 0, reason: 'let go: its changes no longer reach the page');

    // Dropped from the inbox: its threads are disposed before the page hears.
    final c = swarmOf('s3', 'k1', () => {'unread': [], 'read': []});
    await c.reader.refresh();
    sources['s3'] = c.threads;
    r.changed.value++;
    await settle();
    c.threads.dispose();
    sources.remove('s3');
    r.changed.value++;
    expect([for (final e in r.merge.fresh) e.swarmId], ['s1']);
    r.merge.closed();
  });

  test('a Swarm that cannot be read says so, never Loading, and Retry reads '
      'it again', () async {
    var fail = true;
    final a = swarmOf(
      's1',
      'g1',
      () => {
        'unread': [row('g1', 'a1', unread: 1)],
        'read': [],
      },
    );
    final b = swarmOf(
      's2',
      'h1',
      () => fail
          ? throw const SuperTabFailure('BUSY', 'Busy', statusCode: 500)
          : {
              'unread': [row('h1', 'b1', unread: 1)],
              'read': [],
            },
    );
    await a.reader.refresh();
    await b.reader.refresh();
    final m = mergeOf({'s1': a.threads, 's2': b.threads}).merge;
    await settle();

    expect(m.loaded, isTrue);
    expect(m.error, isNotNull);
    expect([for (final e in m.fresh) e.thread.key], ['g1/a1']);

    fail = false;
    m.retry();
    await settle();

    expect(m.error, isNull);
    expect(m.fresh, hasLength(2));
  });

  test('opening reads the first new threads\' replies, each in its own '
      'Swarm, and only while open', () async {
    final a = swarmOf(
      's1',
      'g1',
      () => {
        'unread': [
          for (var i = 0; i < 12; i++)
            row('g1', 'a$i', unread: 1, at: '2026-11-01T0${i % 10}:00:00.000Z'),
        ],
        'read': [],
      },
    );
    final b = swarmOf(
      's2',
      'h1',
      () => {
        'unread': [row('h1', 'b1', unread: 1, at: '2026-11-01T09:30:00.000Z')],
        'read': [],
      },
    );
    for (final s in [a, b]) {
      s.swarm.routes['/api/super-tabs/${s.reader.tabId}/conversations/'] = (
        _,
      ) => {'messages': <Object>[]};
    }
    await a.reader.refresh();
    await b.reader.refresh();
    final m = mergeOf({'s1': a.threads, 's2': b.threads}).merge;
    await settle();

    m.showReplies();
    await settle();
    expect(
      [...a.swarm.paths, ...b.swarm.paths].where((p) => p.contains('?thread=')),
      isEmpty,
      reason: 'not open',
    );

    m.opened();
    await settle();
    m.showReplies();
    await settle();

    List<String> asked(FakeSwarm s) =>
        s.paths.where((p) => p.contains('?thread=')).toList();
    expect(asked(b.swarm), [
      '/api/super-tabs/s2/conversations/h1/messages?thread=b1',
    ]);
    expect(asked(a.swarm), hasLength(SwarmThreadsMerge.showingReplies - 1));
    expect(
      b.swarm.paths,
      contains('/api/super-tabs/s2/conversations/h1/threads/b1/read'),
    );
    expect(
      a.swarm.paths.where((p) => p.contains('/s2/') || p.contains('h1')),
      isEmpty,
      reason: 'never asked of the other Swarm',
    );
    m.closed();
  });

  test(
    'access lost in one Swarm while the page is open takes only its rows',
    () async {
      final a = swarmOf(
        's1',
        'g1',
        () => {
          'unread': [row('g1', 'a1', unread: 1)],
          'read': [],
        },
      );
      final b = swarmOf(
        's2',
        'h1',
        () => {
          'unread': [row('h1', 'b1', unread: 1)],
          'read': [],
        },
      );
      await a.reader.refresh();
      await b.reader.refresh();
      final m = mergeOf({'s1': a.threads, 's2': b.threads}).merge;
      m.opened();
      await settle();

      b.reader.revoke();

      expect([for (final e in m.fresh) e.swarmId], ['s1']);
      expect(m.unread, isTrue);
      m.closed();
    },
  );

  test('Follow and Unfollow go to the thread\'s own Swarm', () async {
    final a = swarmOf(
      's1',
      'g1',
      () => {
        'unread': [],
        'read': [row('g1', 'a1')],
      },
    );
    final b = swarmOf(
      's2',
      'h1',
      () => {
        'unread': [],
        'read': [row('h1', 'b1')],
      },
    );
    await a.reader.refresh();
    await b.reader.refresh();
    final m = mergeOf({'s1': a.threads, 's2': b.threads}).merge;
    await settle();

    final entry = m.rest.firstWhere((e) => e.swarmId == 's2');
    expect(m.followOffered(entry), isTrue);
    expect(await m.setFollow(entry, false), isTrue);

    expect(
      b.swarm.calls.where((c) => c.path.endsWith('/follow')).single.path,
      '/api/super-tabs/s2/conversations/h1/threads/b1/follow',
    );
    expect(a.swarm.paths.where((p) => p.endsWith('/follow')), isEmpty);
  });
}
