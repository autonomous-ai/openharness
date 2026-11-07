import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';
import 'package:harness_mobile/notify/agent_announcer.dart';
import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/done_notice.dart';
import 'package:harness_mobile/notify/system_notices.dart';

/// Task #3607 (Tony, 2026-11-06): an agent finishing a turn is badge only. The
/// agent is marked unread; nothing rings, nothing is posted to the
/// notification centre. A question, or an approval, still rings.
class _RecordingNotices implements SystemNotices {
  final shown = <AgentNoticeMessage>[];

  @override
  final opened = ValueNotifier<AgentRef?>(null);

  @override
  final openedDevice = ValueNotifier<String?>(null);

  @override
  Future<bool?> requestPermission() async => null;

  @override
  Future<void> show(AgentNoticeMessage message) async => shown.add(message);

  @override
  Future<void> cancel(AgentRef agent) async {}

  @override
  Future<void> showAccountNotice({
    required String key,
    required String title,
    required String body,
  }) async {}
}

void main() {
  const ref = (machineId: 'm', agentId: 'a');
  const agent = (ref: ref, name: 'Fix login', machine: 'MacBook');

  TurnEnd end({NoticeTier? tier, String? reply = 'Fixed the login screen.'}) =>
      (
        aborted: false,
        replay: false,
        subagent: false,
        reply: reply,
        tier: tier,
      );

  group('what a finished turn is worth', () {
    test('a mark and nothing louder, at every tier the daemon gives', () {
      for (final tier in [null, NoticeTier.alert, NoticeTier.list]) {
        for (final inFront in [true, false]) {
          final notice = decideDoneNotice(
            end(tier: tier),
            inFront: inFront,
            watching: false,
          );
          expect(notice, AgentNotice.filed, reason: '$tier front=$inFront');
          expect(notice.marks, isTrue);
          expect(notice.chimes, isFalse);
          expect(notice.alerts, isFalse);
        }
      }
    });

    test('nothing at all for the agent the person is looking at', () {
      for (final tier in [null, NoticeTier.alert, NoticeTier.list]) {
        expect(
          decideDoneNotice(end(tier: tier), inFront: true, watching: true),
          AgentNotice.none,
        );
      }
    });

    test('silent, and a turn that is not news, stay nothing', () {
      expect(
        decideDoneNotice(
          end(tier: NoticeTier.silent),
          inFront: false,
          watching: false,
        ),
        AgentNotice.none,
      );
      expect(
        decideDoneNotice(end(reply: null), inFront: false, watching: false),
        AgentNotice.none,
      );
    });
  });

  group('the announcer', () {
    late _RecordingNotices system;
    late int chimes;
    late bool front;
    late AgentAnnouncer announcer;

    setUp(() {
      system = _RecordingNotices();
      chimes = 0;
      front = false;
      announcer = AgentAnnouncer(
        system: system,
        chime: () async => chimes++,
        inFront: () => front,
        questionGrace: Duration.zero,
      );
      addTearDown(announcer.dispose);
    });

    test('a finished turn away marks the agent and rings nothing', () {
      announcer.turnEnded(agent, end(), watching: () => false);

      expect(announcer.unread.contains(ref), isTrue);
      expect(system.shown, isEmpty);
      expect(chimes, 0);
    });

    test('a finished turn with the app on another agent: a mark, no chime', () {
      front = true;
      announcer.turnEnded(agent, end(), watching: () => false);

      expect(announcer.unread.contains(ref), isTrue);
      expect(system.shown, isEmpty);
      expect(chimes, 0);
    });

    test('a finished turn of the agent on screen: nothing at all', () {
      front = true;
      announcer.turnEnded(agent, end(), watching: () => true);

      expect(announcer.unread.count, 0);
      expect(system.shown, isEmpty);
      expect(chimes, 0);
    });

    test('a question after a finished turn still posts', () {
      announcer.turnEnded(agent, end(), watching: () => false);
      announcer.questionAsked(
        agent,
        requestId: 'r1',
        prompt: 'Approve Bash command: rm -rf dist',
        watching: () => false,
      );

      expect([for (final n in system.shown) n.kind], [NoticeKind.question]);
    });
  });
}
