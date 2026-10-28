import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_asks.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_notices.dart';
import 'package:harness_mobile/swarm/waiting_work.dart';

import 'swarm_fixture.dart';

/// What the phone's notices say about the Swarm: a decision asked of the
/// person, a Lead's tag, work waiting on them — and where a tap leads.
///
/// A notice can be read on a locked phone, so it says only who asks and in
/// which project; what they ask is read in the app (Lead, 2026-10-27).
void main() {
  SwarmDecisionNeed decision() => SwarmDecisionNeed(
    'tab-b',
    SuperTabDecision.fromJson({
      'id': 'd1',
      'projectName': 'Mobile',
      'conversationId': 'g9',
      'conversationTitle': 'Fix login',
      'askerName': 'River',
      'question': 'Ship it behind a flag?',
      'options': ['Yes', 'No'],
    }),
  );

  SwarmMentionNeed mention() => SwarmMentionNeed(
    'tab-b',
    SuperTabMention.fromJson({
      'id': 'm1',
      'projectName': 'Mobile',
      'conversationId': 'g9',
      'conversationTitle': 'Fix login',
      'messageId': 'msg-1',
      'leadName': 'River',
      'text': 'Can you check the copy?',
    }),
  );

  SwarmWorkNeed work(String status, {String? result}) {
    final snapshot = SuperTabSnapshot.fromJson(
      SuperTabParts.firstLoad(
        firstLoad(
          groups: [
            {
              ...groupData('g1', title: 'Sync', number: 4, status: status),
              'assignment': {
                'id': 'attempt-g1',
                'agentId': 'agent-builder',
                'status': status,
                'result': result,
              },
            },
          ],
        ),
      ).state,
    );
    return SwarmWorkNeed(tab, swarmWaitingWork(snapshot, me).single);
  }

  /// Nothing the notice shows: what was asked, or where.
  void keepsItsContent(SwarmNoticeMessage notice, List<String> private) {
    for (final text in private) {
      for (final line in [notice.title, notice.subtitle, notice.body]) {
        expect(line, isNot(contains(text)), reason: '"$text" in "$line"');
      }
    }
  }

  test('a decision says who asks and in which project, not the question', () {
    final notice = swarmNotice(decision());

    expect(notice.title, 'River asks you');
    expect(notice.subtitle, 'Mobile');
    expect(notice.body, 'Open Harness to answer.');
    expect(notice.target, (swarmId: 'tab-b', conversationId: 'g9'));
    keepsItsContent(notice, ['Ship it', 'Yes', 'Fix login']);
  });

  test("a tag says who tagged, not the Lead's words", () {
    final notice = swarmNotice(mention());

    expect(notice.title, 'River tagged you');
    expect(notice.subtitle, 'Mobile');
    expect(notice.body, 'Open Harness to read it.');
    keepsItsContent(notice, ['check the copy', 'Fix login']);
  });

  test("waiting work says who waits, not the worker's words", () {
    final needs = swarmNotice(work('needs_human', result: 'Which name?'));
    expect(needs.title, 'Nova needs you');
    expect(needs.subtitle, 'Mobile');
    expect(needs.body, 'Open Harness to answer.');
    keepsItsContent(needs, ['Which name', 'Sync']);

    final stuck = swarmNotice(work('blocked', result: 'No access to the repo'));
    expect(stuck.title, 'Nova is stuck');
    expect(stuck.body, 'Open Harness to see why.');
    keepsItsContent(stuck, ['No access', 'Sync']);
  });

  test('each need is its own notice, and the same need replaces itself', () {
    expect(swarmNotice(decision()).key, swarmNotice(decision()).key);
    expect(swarmNotice(decision()).key, isNot(swarmNotice(mention()).key));
  });

  test('nothing is posted while the Swarm is on screen', () {
    final notices = _Recording();
    var onScreen = true;
    final announcer = SwarmAnnouncer(notices, quiet: (_) => onScreen);

    announcer.announce(decision());
    expect(notices.shown, isEmpty);

    onScreen = false;
    announcer.announce(decision());
    expect(notices.shown.single.title, 'River asks you');
  });

  test('a notice is taken down once its need is gone, and only then', () {
    final notices = _Recording();
    final announcer = SwarmAnnouncer(notices, quiet: (_) => false);
    announcer.announce(decision());
    announcer.announce(mention());

    announcer.settle([decision(), mention()]);
    expect(notices.cancelled, isEmpty);

    // Answered on the desktop: the lock screen must stop asking.
    announcer.settle([mention()]);
    expect(notices.cancelled, [decision().key]);

    // Signed out: nothing of the account stays on the lock screen.
    announcer.clear();
    expect(notices.cancelled, [decision().key, mention().key]);
  });

  test('a need never shown is never taken down', () {
    final notices = _Recording();
    final announcer = SwarmAnnouncer(notices, quiet: (_) => true);
    announcer.announce(decision());

    announcer.settle(const []);

    expect(notices.cancelled, isEmpty);
  });

  group("the app icon's count", () {
    test('is the number of needs each read, as the drawer counts them', () {
      final notices = _Recording();
      final announcer = SwarmAnnouncer(notices, quiet: (_) => false);

      announcer.settle([decision(), mention(), work('needs_human')]);
      expect(notices.badges, [3]);

      // Answered on the desktop.
      announcer.settle([mention(), work('needs_human')]);
      expect(notices.badges, [3, 2]);
    });

    test('is set on the first read even with nothing waiting', () {
      // What an earlier run left on the icon goes.
      final notices = _Recording();
      SwarmAnnouncer(notices, quiet: (_) => false).settle(const []);
      expect(notices.badges, [0]);
    });

    test('is not set again while it stays the same', () {
      final notices = _Recording();
      final announcer = SwarmAnnouncer(notices, quiet: (_) => false);

      announcer.settle([decision()]);
      announcer.settle([mention()]);

      expect(notices.badges, [1]);
    });

    test('counts while a Swarm screen is up, where no notice is posted', () {
      final notices = _Recording();
      final announcer = SwarmAnnouncer(notices, quiet: (_) => true);

      announcer.settle([decision(), mention()]);

      expect(notices.badges, [2]);
    });

    test('clears when the account signs out', () {
      final notices = _Recording();
      final announcer = SwarmAnnouncer(notices, quiet: (_) => false);
      announcer.settle([decision()]);

      announcer.clear();

      expect(notices.badges, [1, 0]);
    });
  });

  group('the tap', () {
    test('leads to the Swarm and conversation, never read as an agent', () {
      const target = (swarmId: 'tab-b', conversationId: 'g9');
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
      expect(swarmNoticeIdFor('decision:d1'), swarmNoticeIdFor('decision:d1'));
      expect(
        swarmNoticeIdFor('decision:d1'),
        isNot(swarmNoticeIdFor('decision:d2')),
      );
      expect(swarmNoticeIdFor('decision:d1'), greaterThan(0));
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
