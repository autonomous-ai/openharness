import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_chat_peeks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// A few chats' newest rows for Activity and Buddies, read only when a chat's
/// counter moved, two at a time, and never kept past the reader's access.
void main() {
  String path(String chat) =>
      '/api/super-tabs/$tab/conversations/$chat/messages';

  Map<String, dynamic> message(String id, String chat, int sequence) => {
    'id': id,
    'conversationId': chat,
    'text': 'Row $id',
    'sequence': sequence,
    'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
    'createdAt': '2026-10-29T08:00:00.000Z',
  };

  Map<String, dynamic> page(String chat, List<int> sequences) => {
    'messages': [for (final s in sequences) message('$chat-$s', chat, s)],
    'threads': [
      {
        'id': '$chat-${sequences.first}',
        'replies': 2,
        'lastSequence': sequences.last,
        'lastAt': '2026-10-29T08:05:00.000Z',
        'authors': <Object>[],
        'people': [me],
      },
    ],
    'next': null,
  };

  SwarmReader reader(FakeSwarm fake) {
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: fake.request,
    );
    addTearDown(reader.dispose);
    return reader;
  }

  SwarmChatPeeks peeks() {
    final peeks = SwarmChatPeeks();
    addTearDown(peeks.dispose);
    return peeks;
  }

  int reads(FakeSwarm fake, String chat) =>
      fake.paths.where((p) => p.startsWith(path(chat))).length;

  test('reads a chat once per counter, and again when it moves', () async {
    final fake = FakeSwarm();
    fake.routes[path('a')] = (_) => page('a', [3, 5]);
    final r = reader(fake);
    final p = peeks();

    p.want(r, 'a', counter: 5);
    await settle();
    p.want(r, 'a', counter: 5);
    await settle();

    expect(reads(fake, 'a'), 1);
    final peek = p.of(r, 'a')!;
    expect([for (final m in peek.messages) m.id], ['a-3', 'a-5']);
    expect(peek.threads['a-3']!.people, [me]);

    p.want(r, 'a', counter: 6);
    await settle();
    expect(reads(fake, 'a'), 2);
  });

  test('reads forward from a sequence when asked to', () async {
    final fake = FakeSwarm();
    fake.routes[path('b')] = (_) => page('b', [9]);
    final r = reader(fake);
    final p = peeks();

    p.want(r, 'b', counter: 9, after: 8);
    await settle();

    expect(fake.paths.single, '${path('b')}?after=8');
    expect(p.of(r, 'b')!.messages.single.id, 'b-9');
  });

  test('reads two chats at a time', () async {
    final fake = FakeSwarm();
    final gates = {
      for (final c in ['a', 'b', 'c']) c: Completer<void>(),
    };
    for (final chat in gates.keys) {
      fake.routes[path(chat)] = (_) async {
        await gates[chat]!.future;
        return page(chat, [1]);
      };
    }
    final r = reader(fake);
    final p = peeks();

    for (final chat in gates.keys) {
      p.want(r, chat, counter: 1);
    }
    await settle();
    expect(fake.paths, [path('a'), path('b')]);

    gates['a']!.complete();
    await settle();
    expect(fake.paths, [path('a'), path('b'), path('c')]);
    gates['b']!.complete();
    gates['c']!.complete();
    await settle();
    expect(p.of(r, 'c'), isNotNull);
  });

  test('an answer that comes after access ended is dropped', () async {
    final fake = FakeSwarm();
    final gate = Completer<void>();
    fake.routes[path('a')] = (_) async {
      await gate.future;
      return page('a', [1]);
    };
    final r = reader(fake);
    final p = peeks();

    p.want(r, 'a', counter: 1);
    await settle();
    r.revoke();
    gate.complete();
    await settle();

    expect(p.of(r, 'a'), isNull);
  });

  test('what was read goes when the reader reads from nothing again', () async {
    final fake = FakeSwarm();
    fake.routes[path('a')] = (_) => page('a', [1]);
    final r = reader(fake);
    final p = peeks();
    p.want(r, 'a', counter: 1);
    await settle();
    expect(p.of(r, 'a'), isNotNull);

    r.revoke();

    expect(p.of(r, 'a'), isNull, reason: 'held under an earlier generation');
  });

  test(
    'a chat the person may not read is skipped quietly, and not asked again',
    () async {
      final fake = FakeSwarm();
      fake.routes[path('a')] = (_) =>
          throw const SuperTabFailure('FORBIDDEN', 'Not yours.');
      final r = reader(fake);
      final p = peeks();

      p.want(r, 'a', counter: 1);
      await settle();
      p.want(r, 'a', counter: 1);
      await settle();

      expect(p.of(r, 'a'), isNull);
      expect(
        p.failedAt(r, 'a'),
        isFalse,
        reason: 'a refusal is no failure to report',
      );
      expect(reads(fake, 'a'), 1);
    },
  );

  test('a failed read is tried at most three times for one counter', () async {
    final fake = FakeSwarm();
    var fail = true;
    fake.routes[path('a')] = (_) => fail
        ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
        : page('a', [1]);
    final r = reader(fake);
    final p = peeks();

    for (var i = 0; i < 5; i++) {
      p.want(r, 'a', counter: 1);
      await settle();
    }
    expect(reads(fake, 'a'), 3);
    expect(p.failedAt(r, 'a'), isTrue);

    fail = false;
    p.want(r, 'a', counter: 2);
    await settle();
    expect(p.of(r, 'a'), isNotNull);
    expect(p.failedAt(r, 'a'), isFalse);
  });

  test('a page of another conversation is refused', () async {
    final fake = FakeSwarm();
    fake.routes[path('a')] = (_) => page('other', [1]);
    final r = reader(fake);
    final p = peeks();

    p.want(r, 'a', counter: 1);
    await settle();

    expect(p.of(r, 'a'), isNull);
  });

  test('forgets a reader with everything read of it', () async {
    final fake = FakeSwarm();
    fake.routes[path('a')] = (_) => page('a', [1]);
    final r = reader(fake);
    final p = peeks();
    p.want(r, 'a', counter: 1);
    await settle();

    p.forget(r);

    expect(p.of(r, 'a'), isNull);
    p.want(r, 'a', counter: 1);
    await settle();
    expect(reads(fake, 'a'), 2);
  });
}
