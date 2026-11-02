import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_buddy_sessions.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';
import 'swarm_session_fixture.dart';

/// New session in the Buddy chat's composer (Desktop `send(newSession:,
/// sessionProjectId:)`): All projects sends no project and reads every
/// project; one project sends it. And End session.
void main() {
  Future<(FakeSwarm, SwarmReader, SwarmConversation)> rig({
    FakeSwarm? backend,
  }) async {
    final fake = backend ?? sessionBackend();
    final reader = await sessionReader(fake);
    addTearDown(reader.dispose);
    final chat = SwarmConversation(reader, sessionChat);
    addTearDown(chat.dispose);
    await chat.load();
    return (fake, reader, chat);
  }

  Map<String, dynamic> sent(FakeSwarm fake) =>
      fake.commands.lastWhere((c) => c['type'] == 'message.send');

  test('New session over All projects sends newSession and no project', () async {
    final (fake, _, chat) = await rig();
    expect(chat.offersSessions, isTrue);
    chat.newSession = true;
    chat.draft = 'Fix the flaky login test';
    expect(await chat.send(), isTrue);
    final command = sent(fake);
    expect(command['newSession'], isTrue);
    expect(command.containsKey('sessionProjectId'), isFalse);
    expect(command['text'], 'Fix the flaky login test');
    // Taken: the next message is a plain one.
    expect(chat.newSession, isFalse);
  });

  test('New session over one project sends that project', () async {
    final (fake, _, chat) = await rig();
    chat
      ..newSession = true
      ..sessionProjectId = webProject
      ..draft = 'Ship the web fix';
    expect(await chat.send(), isTrue);
    expect(sent(fake)['newSession'], isTrue);
    expect(sent(fake)['sessionProjectId'], webProject);
    expect(chat.sessionProjectId, isNull);
  });

  test('a project the person lost is no longer chosen', () async {
    final (fake, _, chat) = await rig();
    chat
      ..newSession = true
      ..sessionProjectId = 'project-gone'
      ..draft = 'Anything';
    expect(chat.sessionProjectId, isNull);
    expect(await chat.send(), isTrue);
    expect(sent(fake)['newSession'], isTrue);
    expect(sent(fake).containsKey('sessionProjectId'), isFalse);
  });

  test('with New session off, a message is plain', () async {
    final (fake, _, chat) = await rig();
    chat.draft = 'Just a question';
    expect(await chat.send(), isTrue);
    expect(sent(fake).containsKey('newSession'), isFalse);
    expect(sent(fake).containsKey('sessionProjectId'), isFalse);
  });

  test('a chat that cannot start a session sends a plain message', () async {
    final (fake, _, chat) = await rig(
      backend: sessionBackend(engine: 'codex'),
    );
    expect(chat.offersSessions, isTrue);
    expect(chat.sessionBlocked, 'Sessions need a Claude Code Buddy');
    chat
      ..newSession = true
      ..draft = 'Hello';
    expect(chat.newSession, isFalse);
    expect(await chat.send(), isTrue);
    expect(sent(fake).containsKey('newSession'), isFalse);
  });

  test('no New session where the server does not take it', () async {
    final (_, _, chat) = await rig(
      backend: sessionBackend(sessionsFromChat: false),
    );
    expect(chat.offersSessions, isFalse);
  });

  test('a server that does not know newSession gives the text back and says '
      'so', () async {
    final fake = sessionBackend();
    fake.routes[sessionCommands] = (_) => throw const SuperTabFailure(
      'VALIDATION_ERROR',
      "command: Unrecognized key: 'newSession'",
      statusCode: 400,
    );
    final (_, reader, chat) = await rig(backend: fake);
    chat
      ..newSession = true
      ..draft = 'Start one';
    expect(await chat.send(), isFalse);
    expect(chat.draft, 'Start one');
    expect(chat.error, swarmSessionsUnavailable);
    // Not offered for a while after.
    expect(chat.offersSessions, isFalse);
    expect(reader.snapshot, isNotNull);
  });

  group('End session', () {
    final live = [
      {'thread': 'm1', 'startId': 's1', 'agentId': 'agent-session', 'at': 1},
    ];

    test('sends one buddy.sessionEnd for the thread, however often it is '
        'pressed', () async {
      final fake = sessionBackend(sessions: live);
      final gate = Completer<void>();
      fake.routes[sessionCommands] = (_) async {
        await gate.future;
        return {'result': <String, dynamic>{}};
      };
      final (_, _, chat) = await rig(backend: fake);
      final first = chat.endSession('m1');
      final second = chat.endSession('m1');
      gate.complete();
      expect(await first, isTrue);
      expect(await second, isFalse);
      final ends = [
        for (final c in fake.commands)
          if (c['type'] == 'buddy.sessionEnd') c,
      ];
      expect(ends, hasLength(1));
      expect(ends.single, {
        'type': 'buddy.sessionEnd',
        'conversationId': sessionChat,
        'thread': 'm1',
        'reason': 'ended',
      });
    });

    test('nothing for a thread with no live session', () async {
      final (fake, _, chat) = await rig(
        backend: sessionBackend(sessions: live),
      );
      expect(await chat.endSession('other'), isFalse);
      expect(
        fake.commands.where((c) => c['type'] == 'buddy.sessionEnd'),
        isEmpty,
      );
    });
  });
}
