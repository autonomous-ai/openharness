import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/swarm/swarm_chat_notify.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_fixture.dart';

/// The phone's notices follow each chat's setting as the desktop's do
/// (#2453): All new messages tells of each new message in a chat the person
/// is not looking at; Mentions only and Muted tell of none, and a tag is
/// told whatever the chat's setting, as on the desktop. A notice names the
/// project only (lock screen, Lead 10-27).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Notices notices;
  late _Backend backend;

  setUp(() {
    notices = _Notices();
    backend = _Backend();
  });

  Future<SwarmSession> start({bool disposeAtEnd = true}) async {
    final session = SwarmSession(
      accountId: me,
      request: backend.fake.request,
      notices: notices,
      readMarks: MemoryKeyValueStore(),
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

  test('Mentions only and Muted tell of no new message; a tag is told in '
      'either, as on the desktop', () async {
    backend.settings = {'g2': 'muted'};
    final session = await start();

    backend
      ..move('g1', 4)
      ..move('g2', 4)
      ..mention('t1', 'g2');
    await poll(session);

    expect(told(), ['mention:t1']);
  });

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
  final mentions = <Map<String, dynamic>>[];
  var version = 2;
  var reload = false;

  /// The account no longer reads the Swarm: off the list.
  var gone = false;

  List<Map<String, dynamic>> get groups => [
    for (final MapEntry(:key, :value) in sequences.entries)
      groupData(
        key,
        title: key == 'g1' ? 'Fix login' : 'Ship it',
        lastMessageSequence: value,
      ),
  ];

  Map<String, dynamic> get derived => {
    'mentionsWaiting': mentions.length,
    'chatSettings': settings,
  };

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
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': mentions,
    };
  }

  void move(String id, int sequence) {
    sequences[id] = sequence;
    version++;
  }

  void mention(String id, String conversationId) => mentions.add({
    'id': id,
    'conversationId': conversationId,
    'messageId': 'm-$id',
    'projectId': project,
    'projectName': 'Mobile',
    'leadName': 'River',
  });
}
