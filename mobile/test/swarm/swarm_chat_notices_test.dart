import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/swarm/swarm_chat_notify.dart';
import 'package:harness_mobile/swarm/swarm_notices.dart' show SwarmTold;
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_fixture.dart';

/// The phone's notices follow each chat's setting as the desktop's do
/// (#2453): All new messages tells of each new message in a chat the person
/// is not looking at; Mentions only and Muted tell of none. A notice names
/// the project only (lock screen, Lead 10-27).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Notices notices;
  late _Backend backend;

  setUp(() {
    notices = _Notices();
    backend = _Backend();
  });

  Future<SwarmSession> start({
    bool disposeAtEnd = true,
    SwarmTold? told,
    DateTime Function()? now,
  }) async {
    final session = SwarmSession(
      accountId: me,
      request: backend.fake.request,
      notices: notices,
      readMarks: MemoryKeyValueStore(),
      told: told,
      now: now,
    );
    if (disposeAtEnd) addTearDown(session.dispose);
    await session.inbox.refresh();
    await settle();
    return session;
  }

  /// The next read of the list and its Swarm.
  Future<void> poll(SwarmSession session) async {
    await session.inbox.refresh();
    await settle();
  }

  List<String> told() => [for (final n in notices.shown) n.key];
  const g1Notice = 'chat:$tab:g1';

  test('All new messages: each new message in the chat is told, one notice '
      'for the chat that the next replaces, naming the project only', () async {
    backend.settings = {'g1': 'all'};
    final session = await start();
    expect(told(), isEmpty, reason: 'the first look is not news');

    backend.move('g1', 4);
    await poll(session);
    expect(told(), [g1Notice]);
    final notice = notices.shown.single;
    expect(notice.title, 'New messages');
    expect(notice.subtitle, 'Mobile');
    expect(notice.body, 'Open Harness to read them.');
    expect(notice.target.conversationId, 'g1');
    expect(
      '${notice.title} ${notice.subtitle} ${notice.body}',
      isNot(contains('Fix login')),
      reason: 'the chat is named in the app only',
    );

    backend.move('g1', 5);
    await poll(session);
    expect(told(), [g1Notice, g1Notice]);
    // Sounds once until the person looks: the next one only replaces it (task #3248).
    expect([for (final n in notices.shown) n.quiet], [false, true]);

    // Read again with nothing new: nothing told again.
    backend.version++;
    await poll(session);
    expect(told(), hasLength(2));
  });

  test('Mentions only and Muted tell of no new message', () async {
    backend.settings = {'g1': 'mentions', 'g2': 'muted'};
    final session = await start();

    backend
      ..move('g1', 4)
      ..move('g2', 4);
    await poll(session);

    expect(told(), isEmpty);
  });

  test(
    'a chat nobody set tells no new message: Mentions only is the default, '
    'All new messages only when the person turns it on (task #3607)',
    () async {
      backend.settings = {};
      final session = await start();

      backend
        ..move('g1', 4)
        ..move('g2', 4);
      await poll(session);

      expect(told(), isEmpty);
    },
  );

  test('chosen on this phone, it tells at once: before any read carries the '
      'setting', () async {
    final session = await start();
    backend.fake.routes['/api/super-tabs/$tab/conversations/g1/'
        'notifications'] = (_) =>
        Completer<Object?>().future;
    unawaited(session.inbox.reader(tab)!.setNotify('g1', SwarmNotify.all));

    backend.move('g1', 4);
    await poll(session);
    expect(told(), [g1Notice]);
  });

  test('nothing is told while a Swarm screen is up', () async {
    backend.settings = {'g1': 'all'};
    final session = await start();
    session.enter();

    backend.move('g1', 4);
    await poll(session);
    expect(told(), isEmpty);
  });

  test('a message already read on the phone is not news', () async {
    backend.settings = {'g1': 'all'};
    final session = await start();
    session.inbox.reader(tab)!.readMarks!.markRead('g1', 4);

    backend.move('g1', 4);
    await poll(session);
    expect(told(), isEmpty);
  });

  test('its notice goes once the chat is read, or the Swarm can no longer be '
      'read', () async {
    backend.settings = {'g1': 'all', 'g2': 'all'};
    final session = await start();
    backend
      ..move('g1', 4)
      ..move('g2', 4);
    await poll(session);
    expect(told(), [g1Notice, 'chat:$tab:g2']);

    session.inbox.reader(tab)!.readMarks!.markRead('g1', 4);
    backend.version++;
    await poll(session);
    expect(notices.cancelled, [g1Notice]);

    backend.gone = true;
    await poll(session);
    expect(notices.cancelled, [g1Notice, 'chat:$tab:g2']);
  });

  test('read, the chat\'s next message sounds again (task #3248)', () async {
    backend.settings = {'g1': 'all'};
    final session = await start();
    backend.move('g1', 4);
    await poll(session);
    backend.move('g1', 5);
    await poll(session);
    session.inbox.reader(tab)!.readMarks!.markRead('g1', 5);
    backend.version++;
    await poll(session);
    expect(notices.cancelled, [g1Notice]);

    backend.move('g1', 6);
    await poll(session);
    expect([for (final n in notices.shown) n.quiet], [false, true, false]);
  });

  test('an agent\'s 1:1 chat tells of its agent\'s words in Mentions only, in '
      'its push\'s words; never of the person\'s own, never muted (anh Dee, '
      '#3811)', () async {
    backend
      ..agentChat('ac')
      ..agentChat('muted')
      ..settings = {'muted': 'muted'};
    final session = await start();

    backend
      ..move('ac', 4)
      ..move('muted', 4)
      ..move('g1', 4);
    await poll(session);
    expect(told(), ['chat:$tab:ac']);
    final notice = notices.shown.single;
    expect(notice.title, 'Nova wrote to you');
    expect(notice.subtitle, '');
    expect(notice.body, 'Open Harness to read it.');
    expect(notice.target.conversationId, 'ac');
    expect(notice.quiet, isFalse);

    // The person's own words in the chat are not news.
    session.inbox.reader(tab)!.readMarks!.markRead('ac', 4);
    backend.personSequences['ac'] = 5;
    backend.move('ac', 5);
    await poll(session);
    expect(told(), ['chat:$tab:ac']);
  });

  test('an agent\'s chat sounds once in five minutes, read or not, as its '
      'push does (Tony, 2026-11-10); then it sounds again', () async {
    var at = DateTime(2026, 11, 10, 15);
    backend.agentChat('ac');
    final session = await start(now: () => at);
    final marks = session.inbox.reader(tab)!.readMarks!;

    backend.move('ac', 4);
    await poll(session);
    marks.markRead('ac', 4);
    backend.version++;
    await poll(session);
    expect(notices.cancelled, ['chat:$tab:ac'], reason: 'read: it goes');

    at = at.add(const Duration(minutes: 4, seconds: 59));
    backend.move('ac', 5);
    await poll(session);
    marks.markRead('ac', 5);
    backend.version++;
    await poll(session);

    at = at.add(const Duration(seconds: 1));
    backend.move('ac', 6);
    await poll(session);
    expect([for (final n in notices.shown) n.quiet], [false, true, false]);
  });

  test('a push of an agent\'s chat left in the notification centre goes once '
      'the chat is read; while it shows, the chat\'s next words only replace '
      'it (anh Dee\'s finding 14)', () async {
    final pushes = SwarmTold();
    backend.agentChat('ac');
    final session = await start(told: pushes);
    // The app came back with the chat's push in the notification centre.
    pushes.pushesShown(['chat:$tab:ac']);

    backend.move('ac', 4);
    await poll(session);
    expect([for (final n in notices.shown) n.quiet], [true]);

    session.inbox.reader(tab)!.readMarks!.markRead('ac', 4);
    backend.version++;
    await poll(session);
    expect(notices.cancelled, ['chat:$tab:ac']);
    expect(pushes.pushed('chat:$tab:ac'), isFalse);
  });

  test('a push of an agent\'s chat goes once the chat is read elsewhere, with '
      'nothing new written', () async {
    final pushes = SwarmTold();
    backend.agentChat('ac');
    final session = await start(told: pushes);
    pushes.pushesShown(['chat:$tab:ac']);

    session.inbox.reader(tab)!.readMarks!.markRead('ac', 3);
    backend.version++;
    await poll(session);
    expect(notices.shown, isEmpty);
    expect(notices.cancelled, ['chat:$tab:ac']);
  });

  test('signed out or Swarm turned off: every chat notice goes', () async {
    backend.settings = {'g1': 'all'};
    final session = await start(disposeAtEnd: false);
    backend.move('g1', 4);
    await poll(session);
    expect(told(), [g1Notice]);

    session.dispose();
    expect(notices.cancelled, contains(g1Notice));
  });

  test('a Swarm read again from nothing starts over: what it holds then is '
      'not news', () async {
    backend.settings = {'g1': 'all'};
    final session = await start();

    backend
      ..reload = true
      ..move('g1', 4);
    await poll(session);
    expect(told(), isEmpty);
  });
}

class _Notices extends SilentSystemNotices {
  final shown = <SwarmNoticeMessage>[];
  final cancelled = <String>[];

  @override
  Future<void> showSwarm(SwarmNoticeMessage message) async =>
      shown.add(message);

  @override
  Future<void> cancelSwarm(String key) async => cancelled.add(key);
}

/// Swarm [tab] with work g1 and g2 in Mobile; each [move] moves one on and
/// the Swarm's last change with it, so the next poll reads it.
class _Backend {
  final fake = FakeSwarm();
  var settings = <String, String>{};
  final sequences = <String, int>{'g1': 3, 'g2': 3};

  /// The person's 1:1 chats with Nova (agent-builder), by [agentChat]; and
  /// in each, the newest message that is the person's own.
  final agentChats = <String>{};
  final personSequences = <String, int>{};
  var version = 2;
  var reload = false;

  /// The account no longer reads the Swarm: off the list.
  var gone = false;

  List<Map<String, dynamic>> get groups => [
    for (final MapEntry(:key, :value) in sequences.entries)
      agentChats.contains(key)
          ? groupData(
              key,
              title: 'Nova',
              kind: 'agent-chat',
              agentIds: ['agent-builder'],
              audience: [me],
              lastMessageSequence: value,
              lastPersonSequence: personSequences[key],
            )
          : groupData(
              key,
              title: key == 'g1' ? 'Fix login' : 'Ship it',
              lastMessageSequence: value,
            ),
  ];

  Map<String, dynamic> get derived => {'chatSettings': settings};

  _Backend() {
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        if (!gone)
          {
            'id': tab,
            'name': 'Phone Swarm',
            'ownerId': me,
            'lastChangedAt': version,
          },
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) {
      reload = false;
      return firstLoad(
        groups: groups,
        derived: derived,
        lastChangedAt: version,
      );
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => reload
        ? {'reload': true}
        : changes(
            cursor: 'c$version',
            derived: derived,
            lastChangedAt: version,
            groups: [
              for (final g in groups) part(g['id'] as String, version, g),
            ],
          );
  }

  void move(String id, int sequence) {
    sequences[id] = sequence;
    version++;
  }

  /// Chat [id] is the person's 1:1 chat with Nova, its newest message 3.
  /// The first load numbers each group's part by its place ([firstLoad]):
  /// the change reads after it start past them.
  void agentChat(String id) {
    agentChats.add(id);
    sequences[id] = 3;
    version = 2 + sequences.length;
  }
}
