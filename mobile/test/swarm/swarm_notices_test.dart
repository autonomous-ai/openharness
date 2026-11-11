import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/swarm/swarm_notices.dart';

/// What the phone's Swarm notices do beyond a chat's own (swarm_chat_notices_test.dart): the app icon's count, which
/// v1-v3 set and the first read of a session takes off, and where a tap leads.
void main() {
  group("the app icon's count", () {
    test('the first Swarm read of a session takes it off, once', () {
      final notices = _Recording();
      final announcer = SwarmAnnouncer(notices, quiet: () => false);
      expect(notices.badges, isEmpty, reason: 'nothing read yet');

      announcer.swarmRead();
      announcer.swarmRead();

      expect(notices.badges, [0]);
    });

    test('a session dropped takes it off', () {
      final notices = _Recording();
      SwarmAnnouncer(notices, quiet: () => false).clear();
      expect(notices.badges, [0]);
    });
  });

  group("the app icon's count while nobody is signed in", () {
    test('goes as the app finds itself signed out, once each time', () {
      final notices = _Recording();
      final app = ValueNotifier('booting');
      swarmBadgeOffWhileSignedOut(
        app,
        signedOut: () => app.value == 'signed out',
        notices: notices,
      );
      expect(notices.badges, isEmpty, reason: 'not known yet');

      // A launch that starts signed out never makes a Swarm session, whose
      // end would have taken the last account's count off.
      app.value = 'signed out';
      expect(notices.badges, [0]);
      app.notifyListeners();
      expect(notices.badges, [0], reason: 'still signed out: once');

      app.value = 'signed in';
      expect(notices.badges, [0], reason: 'the session counts from here');

      app.value = 'signed out';
      expect(notices.badges, [0, 0]);
    });

    test('a launch already known to be signed out takes it off at once', () {
      final notices = _Recording();
      swarmBadgeOffWhileSignedOut(
        ValueNotifier(0),
        signedOut: () => true,
        notices: notices,
      );
      expect(notices.badges, [0]);
    });
  });

  group('the tap', () {
    test('a message tap retains its exact message through the OS payload', () {
      expect(decodeSwarmPayload('swarm:tab-b/g9/message/m%2F7'), (
        swarmId: 'tab-b',
        conversationId: 'g9',
        messageId: 'm/7',
        threadId: null,
      ));
    });
    test('leads to the Swarm and conversation, never read as an agent', () {
      const target = (
        swarmId: 'tab-b',
        conversationId: 'g9',
        messageId: null,
        threadId: null,
      );
      final payload = encodeSwarmPayload(target);

      expect(decodeSwarmPayload(payload), target);
      expect(decodeAgentPayload(payload), isNull);
      expect(
        decodeSwarmPayload(encodeAgentPayload((machineId: 'm', agentId: 'a'))),
        isNull,
      );
    });

    test('a damaged payload opens nothing', () {
      expect(decodeSwarmPayload('swarm:%E0%A4%A/g9'), isNull);
      expect(decodeSwarmPayload('swarm:tab-b'), isNull);
      expect(decodeSwarmPayload('swarm:/g9'), isNull);
      expect(decodeSwarmPayload('device:tab-b/g9'), isNull);
    });

    test('a notice id is stable and never an agent notice id', () {
      expect(swarmNoticeIdFor('chat:tab-b:g1'), swarmNoticeIdFor('chat:tab-b:g1'));
      expect(
        swarmNoticeIdFor('chat:tab-b:g1'),
        isNot(swarmNoticeIdFor('chat:tab-b:g2')),
      );
      expect(swarmNoticeIdFor('chat:tab-b:g1'), greaterThan(0));
    });
  });
}

class _Recording extends SilentSystemNotices {
  final shown = <SwarmNoticeMessage>[];
  final cancelled = <String>[];
  final badges = <int>[];

  @override
  Future<void> showSwarm(SwarmNoticeMessage message) async =>
      shown.add(message);

  @override
  Future<void> cancelSwarm(String key) async => cancelled.add(key);

  @override
  Future<void> setSwarmBadge(int count) async => badges.add(count);
}
