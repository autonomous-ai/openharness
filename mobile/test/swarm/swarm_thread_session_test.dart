import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_buddy_sessions.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_thread.dart';

import 'swarm_fixture.dart';
import 'swarm_session_fixture.dart';

/// New session in a thread's reply box of the person's own Buddy chat
/// (Desktop `sendThreadReply(newSession:)`, `threadSessionEnded`): a reply
/// starts a session, also in a thread whose session ended, and never goes to
/// the main chat too.
void main() {
  final live = [
    {'thread': 'm1', 'startId': 's1', 'agentId': 'agent-session', 'at': 1},
  ];

  Future<(FakeSwarm, SwarmConversation, SwarmThread)> rig({
    FakeSwarm? backend,
    List<Map<String, dynamic>>? page,
  }) async {
    final rows =
        page ??
        [
          sessionMessage('m1', 1, author: me),
          sessionMessage('m2', 2, root: 'm1', author: me),
        ];
    final fake = backend ?? sessionBackend(page: rows);
    fake.routes['$sessionMessages?thread=m1'] = (_) => {
      'messages': [
        for (final m in rows.reversed)
          if (m['thread'] == 'm1') m,
      ],
      'next': null,
    };
    final reader = await sessionReader(fake);
    addTearDown(reader.dispose);
    final chat = SwarmConversation(reader, sessionChat);
    addTearDown(chat.dispose);
    await chat.load();
    final thread = SwarmThread(chat, 'm1');
    addTearDown(thread.dispose);
    await thread.load();
    return (fake, chat, thread);
  }

  Map<String, dynamic> sent(FakeSwarm fake) =>
      fake.commands.lastWhere((c) => c['type'] == 'message.send');

  test('a reply with New session starts a session and never also goes to the '
      'chat', () async {
    final (fake, _, thread) = await rig();
    expect(thread.offersSessions, isTrue);
    thread
      ..newSession = true
      ..alsoSend = true
      ..draft = 'Look into this';
    expect(await thread.send(), isTrue);
    expect(sent(fake)['newSession'], isTrue);
    expect(sent(fake)['replyTo'], 'm1');
    expect(sent(fake).containsKey('alsoSend'), isFalse);
    // Taken: the next reply is a plain one.
    expect(thread.newSession, isFalse);
  });

  test('a plain reply sends neither', () async {
    final (fake, _, thread) = await rig();
    thread.draft = 'Just a reply';
    expect(await thread.send(), isTrue);
    expect(sent(fake).containsKey('newSession'), isFalse);
  });

  test('a thread whose session ended starts a new one on reply: locked on, '
      'and the ended line says why', () async {
    final (fake, _, thread) = await rig(
      page: [
        sessionMessage('m1', 1, author: me),
        sessionMessage('m2', 2, root: 'm1', session: true),
        sessionMessage(
          'm3',
          3,
          root: 'm1',
          session: true,
          source: {'kind': 'buddy-session-ended', 'reason': 'idle'},
        ),
      ],
    );
    expect(thread.session, isNull);
    expect(thread.sessionLocked, isTrue);
    expect(thread.newSession, isTrue);
    expect(thread.sessionEndedRow!.sessionEndReason, 'idle');
    thread.draft = 'Carry on';
    expect(await thread.send(), isTrue);
    expect(sent(fake)['newSession'], isTrue);
  });

  test('a thread that never had a session is not locked', () async {
    final (_, _, thread) = await rig(
      page: [sessionMessage('m1', 1, author: me)],
    );
    expect(thread.sessionLocked, isFalse);
    expect(thread.sessionEndedRow, isNull);
    expect(thread.newSession, isFalse);
  });

  test('a live session answers its thread; End session ends it once', () async {
    final (fake, _, thread) = await rig(
      backend: sessionBackend(sessions: live),
    );
    expect(thread.session!.agentId, 'agent-session');
    expect(thread.sessionLocked, isFalse);
    final first = thread.endSession();
    final second = thread.endSession();
    expect(thread.endingSession, isTrue);
    expect(await first, isTrue);
    expect(await second, isFalse);
    expect(
      fake.commands.where((c) => c['type'] == 'buddy.sessionEnd'),
      hasLength(1),
    );
    expect(thread.endingSession, isFalse);
  });

  test('a blocked chat says why and sends a plain reply', () async {
    final (fake, _, thread) = await rig(
      backend: sessionBackend(
        engine: 'codex',
        page: [sessionMessage('m1', 1, author: me)],
      ),
      page: [sessionMessage('m1', 1, author: me)],
    );
    expect(thread.sessionBlocked, 'Sessions need a Claude Code Buddy');
    thread
      ..newSession = true
      ..draft = 'Hi';
    expect(thread.newSession, isFalse);
    expect(await thread.send(), isTrue);
    expect(sent(fake).containsKey('newSession'), isFalse);
  });

  test('no New session where the server takes none for a reply', () async {
    final (_, _, thread) = await rig(
      backend: sessionBackend(
        threadSessions: false,
        page: [sessionMessage('m1', 1, author: me)],
      ),
      page: [sessionMessage('m1', 1, author: me)],
    );
    expect(thread.offersSessions, isFalse);
  });

  test('a server that does not know newSession gives the reply back', () async {
    final fake = sessionBackend(page: [sessionMessage('m1', 1, author: me)]);
    fake.routes[sessionCommands] = (_) => throw const SuperTabFailure(
      'VALIDATION_ERROR',
      "command: Unrecognized key: 'newSession'",
      statusCode: 400,
    );
    final (_, _, thread) = await rig(
      backend: fake,
      page: [sessionMessage('m1', 1, author: me)],
    );
    thread
      ..newSession = true
      ..draft = 'Start one';
    expect(await thread.send(), isFalse);
    expect(thread.draft, 'Start one');
    expect(thread.error, swarmSessionsUnavailable);
    expect(thread.offersSessions, isFalse);
  });

  group(
    'a thread a session answers now (Desktop offersAlsoSend, _offersSession)',
    () {
      final liveRows = [
        sessionMessage('m1', 1, author: me),
        sessionMessage('m2', 2, root: 'm1', author: me, session: true),
        sessionMessage('m3', 3, root: 'm1', session: true),
      ];
      final live = [
        {'thread': 'm1', 'startId': 's1', 'agentId': 'agent-session', 'at': 1},
      ];

      test('offers neither New session nor Also send, and sends a plain reply '
          'to the session', () async {
        final (fake, _, thread) = await rig(
          backend: sessionBackend(sessions: live, page: liveRows),
          page: liveRows,
        );
        expect(thread.session, isNotNull);
        expect(thread.offersSessions, isFalse);
        expect(thread.offersAlsoSend, isFalse);
        thread
          ..newSession = true
          ..alsoSend = true
          ..draft = 'Next step';
        expect(thread.newSession, isFalse);
        expect(await thread.send(), isTrue);
        expect(sent(fake).containsKey('newSession'), isFalse);
        expect(sent(fake).containsKey('alsoSend'), isFalse);
      });

      test('Also send is offered in a plain thread, not for a reply that '
          'starts a session', () async {
        final (_, _, thread) = await rig();
        expect(thread.offersAlsoSend, isTrue);
        thread.newSession = true;
        expect(thread.offersAlsoSend, isFalse);
      });

      test('its status line stays after a server refusal, while New session '
          'is not offered', () async {
        final (_, chat, thread) = await rig(
          backend: sessionBackend(sessions: live, page: liveRows),
          page: liveRows,
        );
        swarmSessionsRefused(chat.reader);
        expect(thread.session, isNotNull);
      });

      test('a refused End session says why in the thread', () async {
        final fake = sessionBackend(sessions: live, page: liveRows);
        fake.routes[sessionCommands] = (_) => throw const SuperTabFailure(
          'FORBIDDEN',
          'The session could not be ended.',
          statusCode: 403,
        );
        final (_, _, thread) = await rig(backend: fake, page: liveRows);
        expect(await thread.endSession(), isFalse);
        expect(thread.error, 'The session could not be ended.');
        expect(thread.endingSession, isFalse);
      });
    },
  );

  group('@ where a session hears the thread (Desktop thread `_tagChoices`, '
      '`sendThreadReply`)', () {
    test('a plain thread offers the chat\'s Buddy; a reply that starts a '
        'session offers no agent', () async {
      final (_, chat, thread) = await rig();
      expect([for (final a in thread.mentionable) a.id], ['agent-wren']);

      thread.newSession = true;

      expect(thread.newSession, isTrue);
      expect(thread.mentionable, isEmpty);
      expect(chat.mentionable, isNotEmpty, reason: 'the chat still offers it');
    });

    test('a thread a session answers offers no agent', () async {
      final rows = [
        sessionMessage('m1', 1, author: me),
        sessionMessage('m2', 2, root: 'm1', session: true),
      ];
      final (_, _, thread) = await rig(
        backend: sessionBackend(sessions: live, page: rows),
        page: rows,
      );
      expect(thread.session, isNotNull);
      expect(thread.mentionable, isEmpty);
    });

    test('an agent named before New session was chosen holds the reply back '
        'and says why, as the desktop does; unnamed, it goes', () async {
      final (fake, _, thread) = await rig();
      thread.mention('agent-wren');
      thread
        ..draft = '${thread.draft}look'
        ..newSession = true;

      expect(await thread.send(), isFalse);

      expect(
        thread.error,
        "Only this thread's session hears a reply here. Remove the agent's "
        'mention.',
      );
      expect(fake.commands.where((c) => c['type'] == 'message.send'), isEmpty);
      expect(thread.draft, '@Wren look', reason: 'nothing left the box');

      thread.draft = 'look';
      expect(await thread.send(), isTrue);
      expect(sent(fake)['recipientIds'], isEmpty);
      expect(sent(fake)['newSession'], isTrue);
    });
  });
}
