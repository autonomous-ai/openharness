import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

import 'swarm_fixture.dart';

/// Chat threads (#2132), read as the desktop's model reads them
/// (desktop_parity_test): a chat's newest message in its main stream, a
/// message's thread, and a page's thread summaries. The phone has no thread
/// view yet, so a reply only in its thread stays in the chat, but unread
/// follows the desktop's main-stream rule (PM, 10-29).
void main() {
  Map<String, dynamic> chat({required int last, int? main}) => {
    ...groupData('g1', title: 'Fix login', lastMessageSequence: last),
    'lastMainSequence': ?main,
  };

  Map<String, dynamic> message(
    String id,
    int sequence, {
    String? thread,
    Object? alsoInChat,
  }) => {
    'id': id,
    'conversationId': 'g1',
    'text': 'hello',
    'sequence': sequence,
    'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Builder'},
    'thread': ?thread,
    'alsoInChat': ?alsoInChat,
  };

  group('unread counts from the main stream', () {
    /// What a chat read through [read] shows, as the desktop's
    /// `SuperTabController.unread` counts it.
    bool unread(Map<String, dynamic> row, {required int read}) =>
        SuperTabConversation.fromJson(row).mainSequence > read;

    test('a reply only in its thread leaves a read chat read', () {
      final group = SuperTabConversation.fromJson(chat(last: 11, main: 10));

      expect(group.lastMessageSequence, 11);
      expect(group.lastMainSequence, 10);
      expect(group.mainSequence, 10);
      expect(unread(chat(last: 11, main: 10), read: 10), isFalse);
    });

    test('a message in the main stream, or a reply also sent to it, makes '
        'it unread', () {
      // A new top-level message, then a thread reply also sent to the chat:
      // the server moves the main stream for both (backend parts/commit.ts).
      expect(unread(chat(last: 12, main: 12), read: 10), isTrue);
      expect(unread(chat(last: 13, main: 13), read: 12), isTrue);
    });

    test('a backend before threads, or a chat with no message since, '
        'counts every message', () {
      final group = SuperTabConversation.fromJson(chat(last: 7));

      expect(group.lastMainSequence, isNull);
      expect(group.mainSequence, 7);
      expect(unread(chat(last: 7), read: 6), isTrue);
      expect(unread(chat(last: 7), read: 7), isFalse);
    });
  });

  group('a message knows its thread', () {
    test('a top-level message roots its own thread and is in the chat', () {
      final m = SuperTabMessage.fromJson(message('m1', 1, thread: 'm1'));

      expect(m.thread, 'm1');
      expect(m.threadReply, isFalse);
      expect(m.inMainStream, isTrue);
    });

    test('a reply only in its thread is out of the main stream', () {
      final m = SuperTabMessage.fromJson(message('m2', 2, thread: 'm1'));

      expect(m.thread, 'm1');
      expect(m.alsoInChat, isFalse);
      expect(m.threadReply, isTrue);
      expect(m.inMainStream, isFalse);
    });

    test('a reply also sent to the chat is in both', () {
      final m = SuperTabMessage.fromJson(
        message('m3', 3, thread: 'm1', alsoInChat: true),
      );

      expect(m.alsoInChat, isTrue);
      expect(m.threadReply, isTrue);
      expect(m.inMainStream, isTrue);
    });

    test('a message from before threads, or an odd value, is in the chat', () {
      final before = SuperTabMessage.fromJson(message('m4', 4));
      expect(before.thread, isNull);
      expect(before.alsoInChat, isFalse);
      expect(before.threadReply, isFalse);
      expect(before.inMainStream, isTrue);

      for (final odd in ['true', 1]) {
        final m = SuperTabMessage.fromJson(
          message('m5', 5, thread: 'm1', alsoInChat: odd),
        );
        expect(m.alsoInChat, isFalse, reason: '$odd');
        expect(m.inMainStream, isFalse, reason: '$odd');
      }
    });
  });

  group("a page's thread summary", () {
    test('reads its replies, newest reply, authors and people', () {
      final thread = SuperTabThread.fromJson({
        'id': 'm1',
        'replies': 3,
        'lastSequence': 9,
        'lastAt': '2026-10-29T08:00:00.000Z',
        'authors': [
          {'kind': 'agent', 'id': 'agent-builder', 'displayName': 'Builder'},
          {'kind': 'person', 'id': me, 'name': 'me'},
        ],
        'people': [me, 'ken', 7],
      });

      expect(thread.id, 'm1');
      expect(thread.replies, 3);
      expect(thread.lastSequence, 9);
      expect(thread.lastAt, DateTime.utc(2026, 10, 29, 8));
      expect([for (final a in thread.authors) a['id']], ['agent-builder', me]);
      expect(thread.people, [me, 'ken']);
    });

    test('with no authors, people or date, has none', () {
      final thread = SuperTabThread.fromJson({
        'id': 'm1',
        'replies': 1,
        'lastSequence': 2,
      });

      expect(thread.lastAt, isNull);
      expect(thread.authors, isEmpty);
      expect(thread.people, isEmpty);
    });
  });
}
