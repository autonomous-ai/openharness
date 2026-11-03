import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_unread_line.dart';

/// Where a chat's New messages line goes: above the first message the person
/// has not read, from someone else (Desktop's `superTabFirstUnread`).
void main() {
  const me = 'person-me';

  SuperTabMessage message(
    int sequence, {
    String author = 'agent-nova',
    String kind = 'agent',
    String? thread,
    bool alsoInChat = false,
  }) => SuperTabMessage.fromJson({
    'id': 'm$sequence',
    'conversationId': 'g1',
    'text': 'Message $sequence',
    'sequence': sequence,
    'thread': ?thread,
    'alsoInChat': alsoInChat,
    'author': {'kind': kind, 'id': author, 'name': author},
  });

  SuperTabMessage mine(int sequence, {String? thread}) =>
      message(sequence, author: me, kind: 'person', thread: thread);

  String? first(
    List<SuperTabMessage> read,
    int? mark, {
    bool older = false,
    Set<String>? hidden,
  }) => swarmFirstUnread(
    read,
    mark,
    accountId: me,
    hasOlder: older,
    drawn: hidden == null ? null : (m) => !hidden.contains(m.id),
  );

  test('is the first message past the mark', () {
    expect(first([message(1), message(2), message(3)], 1), 'm2');
  });

  test('is none when everything is read, or no mark is known', () {
    expect(first([message(1), message(2)], 2), isNull);
    expect(first([message(1), message(2)], null), isNull);
    expect(first([message(1), message(2)], 0), isNull);
    expect(first(const [], 3), isNull);
  });

  test("passes over the person's own messages, and their own newest one "
      'reads what came before it', () {
    expect(first([message(1), mine(2), message(3)], 1), 'm3');
    expect(
      first([message(1), message(2), mine(3)], 1),
      isNull,
      reason: 'writing in a chat reads it',
    );
    expect(
      first([mine(1, thread: 'm0'), message(2), mine(3, thread: 'm0')], 1),
      'm2',
      reason: 'a reply only in its thread reads the thread, not the chat',
    );
  });

  test("passes over a reply only in its thread, and an agent's message "
      "with the person's id is someone else's", () {
    expect(first([message(1), message(2, thread: 'm1'), message(3)], 1), 'm3');
    expect(
      first([message(1), message(2, thread: 'm1', alsoInChat: true)], 1),
      'm2',
      reason: 'also sent to the chat',
    );
    expect(first([message(1), message(2, author: me)], 1), 'm2');
  });

  test('is none when the mark is older than what was read and earlier '
      'messages are still unread', () {
    expect(first([message(5), message(6)], 2, older: true), isNull);
    expect(
      first([message(3), message(4)], 2, older: true),
      'm3',
      reason: 'the read reaches the mark',
    );
    expect(
      first([message(5), message(6)], 2),
      'm5',
      reason: 'nothing is older than what was read',
    );
  });

  test('passes over a message the chat does not draw, such as an answered '
      "prompt's warning in a task's chat", () {
    expect(
      first([message(1), message(2), message(3)], 1, hidden: {'m2'}),
      'm3',
    );
    expect(
      first([message(1), message(2), message(3)], 1, hidden: {'m2', 'm3'}),
      isNull,
      reason: 'nothing unread is drawn',
    );
    expect(
      first([message(1), message(2), message(3)], 1, hidden: {'m1'}),
      'm2',
      reason: 'a hidden message already read changes nothing',
    );
    expect(
      first([message(3), message(4)], 2, older: true, hidden: {'m3'}),
      'm4',
      reason: 'a hidden message still counts toward reaching the mark',
    );
  });

  test("a message the server posted in the person's name reads nothing "
      'before it (plain chat, #2294)', () {
    SuperTabMessage posted(int sequence, String kind) =>
        SuperTabMessage.fromJson({
          'id': 'm$sequence',
          'conversationId': 'g1',
          'text': "Let's build: Offline drafts",
          'sequence': sequence,
          'author': {'kind': 'person', 'id': me, 'name': me},
          'source': {'kind': kind},
        });
    for (final kind in ['task-line', 'buddy-proposal']) {
      expect(first([message(1), message(2), posted(3, kind)], 1), 'm2');
      expect(posted(3, kind).postedForAuthor, isTrue);
    }
    expect(mine(4).postedForAuthor, isFalse);
  });
}
