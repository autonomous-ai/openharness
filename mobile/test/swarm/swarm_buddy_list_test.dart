import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/swarm/swarm_buddy_list.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_buddies_fixture.dart';
import 'swarm_fixture.dart';

/// Buddies (Tony's prototype C2): one row per project of every Swarm, with
/// the person's own Buddy there, how it stands and the last message of their
/// Buddy chat, read from that message on and only while Buddies is on screen.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<SwarmSession> start(FakeSwarm fake) async {
    final session = SwarmSession(
      accountId: me,
      request: fake.request,
      notices: SilentSystemNotices(),
      readMarks: MemoryKeyValueStore(),
    );
    addTearDown(session.dispose);
    await session.inbox.refresh();
    await settle();
    return session;
  }

  List<String> reads(FakeSwarm fake) => [
    for (final path in fake.paths)
      if (path.contains('/messages')) path,
  ];

  SwarmBuddyRow row(SwarmBuddyList list, String projectId, {String? swarm}) =>
      list.rows.singleWhere(
        (row) =>
            row.project.id == projectId &&
            (swarm == null || row.swarmId == swarm),
      );

  test(
    'one row per project, newest first; one with no Buddy chat last',
    () async {
      final session = await start(buddiesBackend());
      final list = session.buddyList..watch();
      await settle();

      expect(
        [for (final row in list.rows) row.project.name],
        ['Mobile', 'Web', 'Docs'],
      );
      expect(row(list, project).chat?.id, buddiesMobileChat);
      expect(row(list, buddiesDocs).chat, isNull);
    },
  );

  test('reads nothing until Buddies is on screen, then each of the '
      "person's Buddy chats from its last message on, once", () async {
    final fake = buddiesBackend();
    final session = await start(fake);
    final list = session.buddyList;
    expect(reads(fake), isEmpty);

    list.watch();
    await settle();
    expect(reads(fake)..sort(), [
      '${buddiesChatPath(buddiesMobileChat)}?after=6',
      '${buddiesChatPath(buddiesWebChat)}?after=3',
    ], reason: "never someone else's Buddy chat, nor a project chat");

    list.unwatch();
    list.watch();
    await settle();
    expect(reads(fake), hasLength(2), reason: 'nothing moved: nothing read');
  });

  test("each row's last message, its Buddy's name and how it stands", () async {
    final session = await start(buddiesBackend());
    final list = session.buddyList..watch();
    await settle();
    final reader = session.inbox.reader(tab)!;

    final mobile = row(list, project);
    expect(mobile.last?.text, 'Done: the build is up.');
    expect(swarmBuddyLine(mobile, reader), 'Done: the build is up.');
    expect((mobile.name, mobile.note), ('Wren', null), reason: 'it runs');

    final web = row(list, buddiesWeb);
    expect(swarmBuddyLine(web, reader), 'You: Is 0.9 out yet?');
    expect((web.name, web.note), ('Kite', 'offline'));

    final docs = row(list, buddiesDocs);
    expect(swarmBuddyLine(docs, reader), 'No Buddy yet');
    expect((docs.name, docs.note), ('Buddy', 'not started'));
  });

  test('a chat past its read mark is unread; the badge counts those', () async {
    final session = await start(buddiesBackend());
    final list = session.buddyList..watch();
    await settle();

    expect(row(list, project).unread, isTrue);
    expect(row(list, buddiesWeb).unread, isFalse);
    expect(row(list, buddiesDocs).unread, isFalse);
    expect(list.badge, 1);
  });

  test('a new message in the chat is read again; a reply only in a thread '
      'is not', () async {
    final fake = buddiesBackend();
    final session = await start(fake);
    final list = session.buddyList..watch();
    await settle();
    expect(reads(fake), hasLength(2));

    var version = 30;
    Future<void> move(int sequence, int main) async {
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c${version++}',
        derived: const {
          'readMarks': {buddiesMobileChat: 5, buddiesWebChat: 4},
        },
        groups: [
          part(buddiesMobileChat, version, {
            ...buddyChatData(
              buddiesMobileChat,
              agentIds: ['agent-wren'],
              lastMessageSequence: sequence,
            ),
            'lastMainSequence': main,
          }),
        ],
      );
      await session.inbox.refresh();
      await settle();
    }

    await move(8, 7);
    expect(reads(fake), hasLength(2), reason: 'a thread reply moved it');

    fake.routes[buddiesChatPath(buddiesMobileChat)] = (_) => {
      'messages': [buddiesMessage(buddiesMobileChat, 9, text: 'Next one')],
      'threads': <Object>[],
      'next': null,
    };
    await move(9, 9);
    expect(reads(fake).last, '${buddiesChatPath(buddiesMobileChat)}?after=8');
    expect(row(list, project).last?.text, 'Next one');
  });

  test('the last message is the newest in the chat itself, not a reply in '
      'a thread', () async {
    final fake = buddiesBackend(mobileSequence: 9, mobileMainSequence: 8);
    fake.routes[buddiesChatPath(buddiesMobileChat)] = (_) => {
      'messages': [
        buddiesMessage(buddiesMobileChat, 8, text: 'In the chat'),
        buddiesMessage(
          buddiesMobileChat,
          9,
          text: 'In a thread',
          thread: '$buddiesMobileChat-8',
        ),
      ],
      'threads': <Object>[],
      'next': null,
    };
    final session = await start(fake);
    final list = session.buddyList..watch();
    await settle();

    expect(row(list, project).last?.text, 'In the chat');
  });

  test('access lost while Buddies is open: its rows go, and an answer still '
      'on its way is dropped', () async {
    final fake = buddiesBackend();
    final gate = Completer<void>();
    final answer = fake.routes[buddiesChatPath(buddiesMobileChat)]!;
    fake.routes[buddiesChatPath(buddiesMobileChat)] = (body) async {
      await gate.future;
      return answer(body);
    };
    final session = await start(fake);
    final list = session.buddyList..watch();
    await settle();
    expect(row(list, buddiesWeb).last, isNotNull);

    session.inbox.reader(tab)!.revoke();
    gate.complete();
    await settle();

    expect(list.rows, isEmpty);
    expect(list.badge, 0);
    expect(session.peeks.held, 0, reason: 'nothing of it left in memory');
  });

  test('the same Buddy id and chat id in two Swarms: each row reads and '
      'names its own', () async {
    final fake = buddiesBackend();
    const other = 'tab-2';
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me, 'lastChangedAt': 2},
        {'id': other, 'name': 'Other', 'ownerId': me, 'lastChangedAt': 1},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$other/parts'] = (_) =>
        buddiesLoad(swarmId: other, swarmName: 'Other', wren: 'Pip');
    fake.routes['/api/super-tabs/$other/changes'] = (_) =>
        changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$other/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$other/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[buddiesChatPath(buddiesMobileChat, swarmId: other)] = (_) => {
      'messages': [
        buddiesMessage(buddiesMobileChat, 7, text: 'From the other Swarm'),
      ],
      'threads': <Object>[],
      'next': null,
    };
    final session = await start(fake);
    final list = session.buddyList..watch();
    await settle();

    final mine = row(list, project, swarm: tab);
    final theirs = row(list, project, swarm: other);
    expect((mine.name, mine.last?.text), ('Wren', 'Done: the build is up.'));
    expect((theirs.name, theirs.last?.text), ('Pip', 'From the other Swarm'));
    expect(mine.key, isNot(theirs.key));
  });

  test('a chat that fails to read says so, is tried a few times, and Try '
      'again reads it once more; never stuck reading', () async {
    final fake = buddiesBackend();
    var fail = true;
    final answer = fake.routes[buddiesChatPath(buddiesMobileChat)]!;
    fake.routes[buddiesChatPath(buddiesMobileChat)] = (body) => fail
        ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
        : answer(body);
    final session = await start(fake);
    final list = session.buddyList..watch();
    await settle();
    // Shown again and again, at the same counter.
    for (var i = 0; i < 4; i++) {
      list
        ..unwatch()
        ..watch();
      await settle();
    }

    int mobileReads() =>
        reads(fake)
            .where((p) => p.startsWith(buddiesChatPath(buddiesMobileChat)))
            .length;
    expect(mobileReads(), 3);
    expect(list.unreadChats, isTrue);
    expect(list.reading, isFalse);
    expect(row(list, project).last, isNull);

    fail = false;
    list.retry();
    await settle();
    expect(mobileReads(), 4);
    expect(list.unreadChats, isFalse);
    expect(row(list, project).last?.text, 'Done: the build is up.');
  });

  test(
    'a Buddy chat the person may no longer read is skipped quietly',
    () async {
      final fake = buddiesBackend();
      fake.routes[buddiesChatPath(buddiesMobileChat)] = (_) =>
          throw const SuperTabFailure('FORBIDDEN', 'Not yours.');
      final session = await start(fake);
      final list = session.buddyList..watch();
      await settle();

      expect(list.unreadChats, isFalse);
      expect(row(list, project).last, isNull);
      expect(row(list, buddiesWeb).last, isNotNull);
    },
  );

  test('says it is reading while a chat is read for the first time', () async {
    final fake = buddiesBackend();
    final gate = Completer<void>();
    final answer = fake.routes[buddiesChatPath(buddiesMobileChat)]!;
    fake.routes[buddiesChatPath(buddiesMobileChat)] = (body) async {
      await gate.future;
      return answer(body);
    };
    final session = await start(fake);
    final list = session.buddyList..watch();
    await settle();
    expect(list.reading, isTrue);

    gate.complete();
    await settle();
    expect(list.reading, isFalse);
  });
}
