import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_chat_peeks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// A few chats' newest rows for Activity and Buddies, read only when a chat's
/// counter moved, two at a time, and never kept past the reader's access.
void main() {
  /// The list that wants the chats read, as Activity or Buddies would.
  final screen = Object();

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

    p.want(r, 'a', counter: 5, owner: screen);
    await settle();
    p.want(r, 'a', counter: 5, owner: screen);
    await settle();

    expect(reads(fake, 'a'), 1);
    final peek = p.of(r, 'a')!;
    expect([for (final m in peek.messages) m.id], ['a-3', 'a-5']);
    expect(peek.threads['a-3']!.people, [me]);

    p.want(r, 'a', counter: 6, owner: screen);
    await settle();
    expect(reads(fake, 'a'), 2);
  });

  test('reads forward from a sequence when asked to', () async {
    final fake = FakeSwarm();
    fake.routes[path('b')] = (_) => page('b', [9]);
    final r = reader(fake);
    final p = peeks();

    p.want(r, 'b', counter: 9, after: 8, owner: screen);
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
      p.want(r, chat, counter: 1, owner: screen);
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

    p.want(r, 'a', counter: 1, owner: screen);
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
    p.want(r, 'a', counter: 1, owner: screen);
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

      p.want(r, 'a', counter: 1, owner: screen);
      await settle();
      p.want(r, 'a', counter: 1, owner: screen);
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
      p.want(r, 'a', counter: 1, owner: screen);
      await settle();
    }
    expect(reads(fake, 'a'), 3);
    expect(p.failedAt(r, 'a'), isTrue);

    fail = false;
    p.want(r, 'a', counter: 2, owner: screen);
    await settle();
    expect(p.of(r, 'a'), isNotNull);
    expect(p.failedAt(r, 'a'), isFalse);
  });

  test('a page of another conversation is refused', () async {
    final fake = FakeSwarm();
    fake.routes[path('a')] = (_) => page('other', [1]);
    final r = reader(fake);
    final p = peeks();

    p.want(r, 'a', counter: 1, owner: screen);
    await settle();

    expect(p.of(r, 'a'), isNull);
  });

  test('keeps only what the listed readers hold: a reader off the list, '
      'revoked or reading from nothing again takes its rows with it', () async {
    final fake = FakeSwarm();
    fake.routes[path('a')] = (_) => page('a', [1]);
    fake.routes[path('b')] = (_) => page('b', [1]);
    final kept = reader(fake), gone = reader(fake), revoked = reader(fake);
    final p = peeks();
    for (final r in [kept, gone, revoked]) {
      p.want(r, 'a', counter: 1, owner: screen);
      p.want(r, 'b', counter: 1, owner: screen);
    }
    await settle();
    expect(p.held, 6);

    revoked.revoke();
    p.keepOnly([kept, revoked]);

    expect(p.held, 2, reason: "only the listed, readable reader's rows");
    expect(p.of(kept, 'a'), isNotNull);
    expect(p.of(gone, 'a'), isNull);
    p.want(gone, 'a', counter: 1, owner: screen);
    await settle();
    expect(reads(fake, 'a'), 4, reason: 'read again from nothing');
  });

  test('an answer for a reader taken off the list is dropped', () async {
    final fake = FakeSwarm();
    final gate = Completer<void>();
    fake.routes[path('a')] = (_) async {
      await gate.future;
      return page('a', [1]);
    };
    final r = reader(fake);
    final p = peeks();
    var told = 0;
    p.addListener(() => told++);

    p.want(r, 'a', counter: 1, owner: screen);
    await settle();
    p.keepOnly(const []);
    gate.complete();
    await settle();

    expect(p.held, 0);
    expect(p.of(r, 'a'), isNull);
    expect(told, 0);
  });

  test('says while a chat is being read, and not once it answers', () async {
    final fake = FakeSwarm();
    final gate = Completer<void>();
    fake.routes[path('a')] = (_) async {
      await gate.future;
      return page('a', [1]);
    };
    final r = reader(fake);
    final p = peeks();

    p.want(r, 'a', counter: 1, owner: screen);
    await settle();
    expect(p.busyAt(r, 'a'), isTrue);

    gate.complete();
    await settle();
    expect(p.busyAt(r, 'a'), isFalse);
  });

  test('Try again reads a chat that failed, past its tries', () async {
    final fake = FakeSwarm();
    fake.routes[path('a')] = (_) =>
        throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
    final r = reader(fake);
    final p = peeks();
    for (var i = 0; i < 3; i++) {
      p.want(r, 'a', counter: 1, owner: screen);
      await settle();
    }
    expect(reads(fake, 'a'), 3);

    fake.routes[path('a')] = (_) => page('a', [1]);
    p.retry(r, 'a', owner: screen);
    await settle();

    expect(reads(fake, 'a'), 4);
    expect(p.of(r, 'a'), isNotNull);
    expect(p.failedAt(r, 'a'), isFalse);
  });

  test('Try again leaves a chat that did not fail alone', () async {
    final fake = FakeSwarm();
    fake.routes[path('a')] = (_) => page('a', [1]);
    final r = reader(fake);
    final p = peeks();
    p.want(r, 'a', counter: 1, owner: screen);
    await settle();

    p.retry(r, 'a', owner: screen);
    await settle();

    expect(reads(fake, 'a'), 1);
  });

  /// Routes [chats] to pages that answer one at a time, as each call's gate
  /// in the returned lists (per chat, in call order) completes.
  Map<String, List<Completer<void>>> gated(FakeSwarm fake, List<String> chats) {
    final gates = {for (final chat in chats) chat: <Completer<void>>[]};
    for (final chat in chats) {
      fake.routes[path(chat)] = (_) async {
        final gate = Completer<void>();
        gates[chat]!.add(gate);
        await gate.future;
        return page(chat, [gates[chat]!.length]);
      };
    }
    return gates;
  }

  group('a list that leaves', () {
    test('takes back what it still waits for: what is being read finishes, '
        'nothing more starts, and on its return only what is still needed '
        'is read', () async {
      final fake = FakeSwarm();
      final gates = gated(fake, ['a', 'b', 'c']);
      final r = reader(fake);
      final p = peeks();
      for (final chat in ['a', 'b', 'c']) {
        p.want(r, chat, counter: 1, owner: screen);
      }
      await settle();
      expect(fake.paths, [path('a'), path('b')]);

      p.withdraw(screen);
      gates['a']!.single.complete();
      gates['b']!.single.complete();
      await settle();

      expect(fake.paths, [path('a'), path('b')], reason: 'no third read');
      expect(p.of(r, 'a'), isNotNull, reason: 'a read in flight finishes');
      expect(p.busyAt(r, 'c'), isFalse);

      for (final chat in ['a', 'b', 'c']) {
        p.want(r, chat, counter: 1, owner: screen);
      }
      await settle();
      expect(fake.paths, [path('a'), path('b'), path('c')]);
      gates['c']!.single.complete();
      await settle();
      expect(p.of(r, 'c'), isNotNull);
    });

    test("leaves another list's reads alone, and a chat both want", () async {
      final fake = FakeSwarm();
      final gates = gated(fake, ['a', 'b', 'c', 'd']);
      final r = reader(fake);
      final p = peeks();
      final other = Object();
      p.want(r, 'a', counter: 1, owner: screen);
      p.want(r, 'b', counter: 1, owner: screen);
      p.want(r, 'c', counter: 1, owner: screen);
      p.want(r, 'c', counter: 1, owner: other);
      p.want(r, 'd', counter: 1, owner: screen);
      await settle();

      p.withdraw(screen);
      gates['a']!.single.complete();
      gates['b']!.single.complete();
      await settle();

      expect(fake.paths, [path('a'), path('b'), path('c')]);
      expect(p.busyAt(r, 'd'), isFalse);
    });

    test('a chat that left the queue unread keeps no claim of the list that '
        'wanted it then, once that list leaves', () async {
      final fake = FakeSwarm();
      final gates = gated(fake, ['a', 'x', 'y']);
      final r = reader(fake);
      final p = peeks();
      final other = Object(), stays = Object();
      p.want(r, 'a', counter: 1, owner: screen);
      p.want(r, 'x', counter: 1, owner: stays);
      await settle();
      // a waits for counter 2, then is wanted at 1 again, which is being read.
      p.want(r, 'a', counter: 2, owner: screen);
      p.want(r, 'a', counter: 1, owner: screen);
      p.want(r, 'y', counter: 1, owner: stays);
      gates['a']!.single.complete();
      await settle();
      expect(fake.paths, [path('a'), path('x'), path('y')]);
      p.withdraw(screen);

      p.want(r, 'a', counter: 3, owner: other);
      p.withdraw(other);
      gates['x']!.single.complete();
      gates['y']!.single.complete();
      await settle();

      expect(reads(fake, 'a'), 1, reason: 'no list on screen wants it');
    });
  });

  group('one read per chat', () {
    test('a waiting chat whose counter moves again and again is read once, '
        'at its latest counter, even when both slots free together', () async {
      final fake = FakeSwarm();
      final gates = gated(fake, ['a', 'b', 'c']);
      final r = reader(fake);
      final p = peeks();
      p.want(r, 'a', counter: 1, owner: screen);
      p.want(r, 'b', counter: 1, owner: screen);
      for (final counter in [1, 2, 3]) {
        p.want(r, 'c', counter: counter, after: counter - 1, owner: screen);
      }
      await settle();

      gates['a']!.single.complete();
      gates['b']!.single.complete();
      await settle();

      expect(
        [
          for (final call in fake.paths)
            if (call.startsWith(path('c'))) call,
        ],
        ['${path('c')}?after=2'],
      );
    });

    test('a counter that moves while its chat is being read: the next read '
        'waits for that one, the older answer leaves it busy, and the newer '
        'one is what shows', () async {
      final fake = FakeSwarm();
      final gates = gated(fake, ['a']);
      final r = reader(fake);
      final p = peeks();
      p.want(r, 'a', counter: 1, owner: screen);
      await settle();

      p.want(r, 'a', counter: 2, owner: screen);
      await settle();
      expect(reads(fake, 'a'), 1, reason: 'never two reads of one chat');

      gates['a']![0].complete();
      await settle();
      expect(reads(fake, 'a'), 2, reason: 'then one at the new counter');
      expect(p.busyAt(r, 'a'), isTrue, reason: 'the newer read is on its way');
      expect(p.of(r, 'a')!.messages.single.id, 'a-1');

      gates['a']![1].complete();
      await settle();
      expect(p.busyAt(r, 'a'), isFalse);
      expect(p.of(r, 'a')!.messages.single.id, 'a-2');
      p.want(r, 'a', counter: 2, owner: screen);
      await settle();
      expect(reads(fake, 'a'), 2, reason: 'read at its latest counter');
    });
  });
}
