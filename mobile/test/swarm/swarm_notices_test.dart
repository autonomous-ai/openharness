import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_activity_feed.dart';
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
    expect(notice.target, (
      swarmId: 'tab-b',
      conversationId: 'g9',
      messageId: null,
      decisionId: 'd1',
      threadId: null,
    ));
    keepsItsContent(notice, ['Ship it', 'Yes', 'Fix login']);
  });

  test('a tag in a thread opens that thread at the tag', () {
    final notice = swarmNotice(
      SwarmMentionNeed(
        'tab-b',
        SuperTabMention.fromJson({
          'id': 'm2',
          'projectName': 'Mobile',
          'conversationId': 'g9',
          'messageId': 'msg-2',
          'threadId': 'root-1',
          'leadName': 'River',
          'text': 'In the thread',
        }),
      ),
    );
    expect(notice.target, (
      swarmId: 'tab-b',
      conversationId: 'g9',
      messageId: 'msg-2',
      decisionId: null,
      threadId: 'root-1',
    ));
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

  // Task #3029: an agent of the reader's task at a prompt in its terminal, as
  // the backend lists it for them (superTabs/promptWaits.ts).
  SuperTabSnapshot atPrompt({bool listed = true}) => SuperTabSnapshot.fromJson(
    SuperTabParts.firstLoad(
      firstLoad(
        groups: [
          {
            ...groupData(
              'g1',
              title: 'Flash the board',
              number: 4,
              status: 'working',
            ),
            'assignment': {
              'id': 'attempt-g1',
              'agentId': 'agent-builder',
              'status': 'working',
            },
          },
        ],
        derived: {
          if (listed)
            'promptsWaiting': [
              {
                'agentId': 'agent-builder',
                'agentName': 'Nova',
                'conversationId': 'g1',
                'conversationTitle': 'Flash the board',
                'projectId': 'p1',
                'projectName': 'Mobile',
              },
            ],
        },
      ),
    ).state,
  );

  test('an agent at a prompt in the reader\'s task is a notice of its own, '
      'whoever owns the project, and goes when the read drops it', () {
    // The backend chose the reader: no partner or owner rule here.
    final waiting = swarmWaitingWork(atPrompt(), 'person-requester').single;
    expect(waiting.atPrompt, isTrue);
    expect(waiting.status, 'prompt');
    final notice = swarmNotice(SwarmWorkNeed(tab, waiting));
    expect(notice.title, 'Nova is waiting at a prompt');
    expect(notice.subtitle, 'Mobile');
    expect(notice.body, 'Open Harness to answer it.');
    expect(notice.target.conversationId, 'g1');
    keepsItsContent(notice, ['Flash the board']);
    // A key of its own: a needs_human of the same task is another notice.
    expect(SwarmWorkNeed(tab, waiting).key, contains(':prompt'));
    expect(
      swarmWaitingWork(atPrompt(listed: false), 'person-requester'),
      isEmpty,
    );
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

    // Answered on the desktop: the lock screen stops asking once two reads
    // of its Swarm in a row miss it.
    announcer.settle([mention()]);
    announcer.swarmRead('tab-b', [mention()]);
    expect(notices.cancelled, isEmpty, reason: 'one read may miss it');
    announcer.swarmRead('tab-b', [mention()]);
    expect(notices.cancelled, [decision().key]);

    // Signed out: nothing of the account stays on the lock screen.
    announcer.clear();
    expect(notices.cancelled, [decision().key, mention().key]);
  });

  test('a need missed by one read and back at the next stays up', () {
    final notices = _Recording();
    final announcer = SwarmAnnouncer(notices, quiet: (_) => false);
    announcer.announce(decision());
    for (var i = 0; i < 6; i++) {
      final needs = i.isOdd ? <SwarmNeed>[decision()] : <SwarmNeed>[];
      announcer.settle(needs);
      announcer.swarmRead('tab-b', needs);
    }
    expect(notices.cancelled, isEmpty);
  });

  test("another Swarm's reads take nothing down", () {
    final notices = _Recording();
    final announcer = SwarmAnnouncer(notices, quiet: (_) => false);
    announcer.announce(decision());
    announcer.swarmRead('tab-other', const []);
    announcer.swarmRead('tab-other', const []);
    expect(notices.cancelled, isEmpty);
  });

  test('a Swarm that can no longer be read takes its notices down at once', () {
    final notices = _Recording();
    final announcer = SwarmAnnouncer(notices, quiet: (_) => false);
    announcer.announce(decision());
    announcer.settle(const [], readable: {'tab-other'});
    expect(notices.cancelled, [decision().key]);
  });

  test('a need never shown is never taken down', () {
    final notices = _Recording();
    final announcer = SwarmAnnouncer(notices, quiet: (_) => true);
    announcer.announce(decision());

    announcer.settle(const []);

    expect(notices.cancelled, isEmpty);
  });

  group('a reply in a thread the person is in', () {
    SwarmActivityEntry reply(String id, {bool read = false}) =>
        SwarmActivityEntry.fromJson({
          'id': id,
          'kind': 'reply',
          'conversationId': 'g9',
          'messageId': 'msg-$id',
          'threadId': 'root-1',
          'actor': {'kind': 'person', 'id': 'person-mia', 'name': 'Mia'},
          'text': "sounds good, I'll ship the copy today",
          'createdAt': DateTime.utc(2026, 11, 4, 9).toIso8601String(),
          'read': read,
        });

    test('says who replied and in which project, not the reply, and opens '
        'at it', () {
      final notices = _Recording();
      SwarmAnnouncer(
        notices,
        quiet: (_) => false,
      ).announceReply(swarmId: 'tab-b', entry: reply('a1'), project: 'Mobile');

      final notice = notices.shown.single;
      expect(notice.title, 'Mia replied in a thread');
      expect(notice.subtitle, 'Mobile');
      expect(notice.body, 'Open Harness to read it.');
      // A reply only in its thread is found there: the tap opens the thread.
      expect(notice.target, (
        swarmId: 'tab-b',
        conversationId: 'g9',
        messageId: 'msg-a1',
        decisionId: null,
        threadId: 'root-1',
      ));
      keepsItsContent(notice, ['sounds good', 'ship the copy']);
    });

    test('is posted once per row, by this session or the next', () {
      final notices = _Recording();
      final told = SwarmTold();
      final announcer = SwarmAnnouncer(
        notices,
        quiet: (_) => false,
        told: told,
      );
      announcer.announceReply(
        swarmId: 'tab-b',
        entry: reply('a1'),
        project: 'M',
      );
      announcer.announceReply(
        swarmId: 'tab-b',
        entry: reply('a1'),
        project: 'M',
      );
      SwarmAnnouncer(
        notices,
        quiet: (_) => false,
        told: told,
      ).announceReply(swarmId: 'tab-b', entry: reply('a1'), project: 'M');
      expect(notices.shown, hasLength(1));

      announcer.announceReply(
        swarmId: 'tab-b',
        entry: reply('a2'),
        project: 'M',
      );
      expect(notices.shown, hasLength(2));
      expect(notices.shown[0].key, isNot(notices.shown[1].key));
    });

    test('is not posted while the person looks at the Swarm', () {
      final notices = _Recording();
      final asked = <SwarmNeed?>[];
      SwarmAnnouncer(
        notices,
        quiet: (need) {
          asked.add(need);
          return true;
        },
      ).announceReply(swarmId: 'tab-b', entry: reply('a1'), project: 'M');
      expect(notices.shown, isEmpty);
      expect(asked, [null], reason: 'asked as for a chat, with no need');
    });

    test('is taken down once its row is read or gone, by its own Swarm '
        'only', () {
      final notices = _Recording();
      final announcer = SwarmAnnouncer(notices, quiet: (_) => false);
      announcer.announceReply(
        swarmId: 'tab-b',
        entry: reply('a1'),
        project: 'M',
      );
      announcer.announceReply(
        swarmId: 'tab-b',
        entry: reply('a2'),
        project: 'M',
      );
      final [first, second] = [for (final n in notices.shown) n.key];

      announcer.repliesRead('tab-other', const []);
      announcer.repliesRead('tab-b', [reply('a1'), reply('a2')]);
      expect(notices.cancelled, isEmpty, reason: 'both still unread');

      announcer.repliesRead('tab-b', [reply('a1'), reply('a2', read: true)]);
      expect(notices.cancelled, [second]);

      announcer.repliesRead('tab-b', const []);
      expect(notices.cancelled, [second, first]);
    });

    test('goes with a Swarm that can no longer be read, and at sign-out', () {
      final notices = _Recording();
      final announcer = SwarmAnnouncer(notices, quiet: (_) => false);
      announcer.announceReply(
        swarmId: 'tab-b',
        entry: reply('a1'),
        project: 'M',
      );
      announcer.announceReply(
        swarmId: 'tab-c',
        entry: reply('a2'),
        project: 'M',
      );
      final [first, second] = [for (final n in notices.shown) n.key];

      announcer.settle(const [], readable: {'tab-c'});
      expect(notices.cancelled, [first]);

      announcer.clear();
      expect(notices.cancelled, [first, second]);
    });
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
        decisionId: null,
        threadId: null,
      ));
    });
    test('a decision tap retains its card through the OS payload', () {
      expect(decodeSwarmPayload('swarm:tab-b/g9/decision/d1'), (
        swarmId: 'tab-b',
        conversationId: 'g9',
        messageId: null,
        decisionId: 'd1',
        threadId: null,
      ));
    });

    test('leads to the Swarm and conversation, never read as an agent', () {
      const target = (
        swarmId: 'tab-b',
        conversationId: 'g9',
        messageId: null,
        decisionId: null,
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
