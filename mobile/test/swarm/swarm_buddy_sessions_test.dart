import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_buddy_sessions.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';

import 'swarm_fixture.dart';
import 'swarm_session_fixture.dart';

/// When the phone offers New session and when it says it cannot, as Desktop's
/// `offersChatSessions`, `offersThreadSessions` and `threadSessionBlocked`
/// decide (spec 2026-10-30-buddy-thread-sessions).
void main() {
  Future<(SwarmReader, SuperTabConversation)> rig(
    FakeSwarm fake,
  ) async {
    final reader = await sessionReader(fake);
    addTearDown(reader.dispose);
    return (reader, reader.snapshot!.conversation(sessionChat)!);
  }

  group('why a session cannot start (Desktop threadSessionBlocked)', () {
    test('nothing in the way: null', () async {
      final (reader, chat) = await rig(sessionBackend());
      expect(swarmSessionBlocked(reader, chat), isNull);
    });

    test('a paused Swarm', () async {
      final (reader, chat) = await rig(sessionBackend(paused: true));
      expect(
        swarmSessionBlocked(reader, chat),
        'New work is paused in this Swarm',
      );
    });

    test('no Buddy running, or its machine down', () async {
      var (reader, chat) = await rig(sessionBackend(buddy: false));
      expect(swarmSessionBlocked(reader, chat), 'Start your Buddy first');
      (reader, chat) = await rig(
        sessionBackend(downSince: '2026-11-02T01:00:00.000Z'),
      );
      expect(swarmSessionBlocked(reader, chat), 'Start your Buddy first');
    });

    test('a Buddy that is not Claude Code', () async {
      final (reader, chat) = await rig(sessionBackend(engine: 'codex'));
      expect(
        swarmSessionBlocked(reader, chat),
        'Sessions need a Claude Code Buddy',
      );
    });

    test('a machine whose report lacks buddySessions names the machine', () async {
      final (reader, chat) = await rig(
        sessionBackend(machine: sessionMachine(capabilities: const [])),
      );
      expect(
        swarmSessionBlocked(reader, chat),
        'Update Harness on Tonys-MacBook-Pro to start sessions',
      );
    });

    test('an older host, whose report has no capabilities list', () async {
      final (reader, chat) = await rig(
        sessionBackend(machine: sessionMachine(capabilities: null)),
      );
      expect(
        swarmSessionBlocked(reader, chat),
        'Update Harness on Tonys-MacBook-Pro to start sessions',
      );
    });
  });

  group('where New session is offered', () {
    test('the chat composer needs sessionsFromChat and a Buddy', () async {
      var (reader, chat) = await rig(sessionBackend());
      expect(swarmOffersChatSessions(reader, chat), isTrue);
      (reader, chat) = await rig(sessionBackend(sessionsFromChat: false));
      expect(swarmOffersChatSessions(reader, chat), isFalse);
      (reader, chat) = await rig(sessionBackend(buddy: false));
      expect(swarmOffersChatSessions(reader, chat), isFalse);
    });

    test('a thread reply needs threadSessions; a thread that had a session '
        'offers it with no Buddy running', () async {
      var (reader, chat) = await rig(sessionBackend());
      expect(
        swarmOffersThreadSessions(reader, chat, hadSession: false),
        isTrue,
      );
      (reader, chat) = await rig(sessionBackend(threadSessions: false));
      expect(
        swarmOffersThreadSessions(reader, chat, hadSession: true),
        isFalse,
      );
      (reader, chat) = await rig(sessionBackend(buddy: false));
      expect(
        swarmOffersThreadSessions(reader, chat, hadSession: false),
        isFalse,
      );
      expect(
        swarmOffersThreadSessions(reader, chat, hadSession: true),
        isTrue,
      );
    });

    test('never in an older Buddy chat or someone else\'s', () async {
      final fake = sessionBackend();
      final reader = await sessionReader(fake);
      addTearDown(reader.dispose);
      // The Swarm's lead chat is neither.
      final lead = reader.snapshot!.conversation(leadChat)!;
      expect(swarmOffersChatSessions(reader, lead), isFalse);
      expect(
        swarmOffersThreadSessions(reader, lead, hadSession: true),
        isFalse,
      );
    });
  });

  test('why a session ended, as its thread says it', () {
    expect(swarmSessionEndedWords('idle'), 'Session ended: idle for 30 minutes');
    expect(swarmSessionEndedWords('ended'), 'Session ended: you ended it');
    expect(
      swarmSessionEndedWords('stopped'),
      'Session ended: it stopped unexpectedly',
    );
    expect(swarmSessionEndedWords('failed'), 'Session ended: it couldn\'t start');
    expect(
      swarmSessionEndedWords('removed'),
      'Session ended: its Buddy was removed or replaced',
    );
    expect(
      swarmSessionEndedWords('maintenance'),
      'Session ended: Harness was updated',
    );
    expect(swarmSessionEndedWords(null), 'Session ended');
    expect(swarmSessionEndedWords('other'), 'Session ended');
  });
}

