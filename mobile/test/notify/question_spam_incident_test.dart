import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';
import 'package:harness_mobile/notify/agent_announcer.dart';
import 'package:harness_mobile/notify/system_notices.dart';

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

/// The 11-05 incident (Tony, task #3198), through the announcer's calls only:
/// a phone in front buzzed "Agent needs you" over and over for a Team machine's
/// agent, whose approvals were each answered at its desk within seconds, and
/// whose dialog flickered off its pane and back with the same id.
void main() {
  const ref = (machineId: 'm', agentId: 'a');
  const agent = (
    ref: ref,
    name: 'TestPine',
    machine: 'Elvis-MacBook-Pro.local',
  );

  test('approvals answered at the desk within seconds never buzz a phone in front', () {
    fakeAsync((async) {
      final system = _RecordingNotices();
      var buzzes = 0;
      final announcer = AgentAnnouncer(
        system: system,
        chime: () async => buzzes++,
        inFront: () => true,
      );
      for (var i = 0; i < 10; i++) {
        announcer.questionAsked(
          agent,
          requestId: 'approval-$i',
          prompt:
              'Approve Bash command: Rerun Desktop scenario and related tests',
          watching: () => false,
        );
        async.elapse(const Duration(seconds: 2));
        announcer.questionClosed(ref, requestId: 'approval-$i');
        async.elapse(const Duration(seconds: 1));
      }
      async.elapse(const Duration(minutes: 1));

      expect(buzzes, 0);
      announcer.dispose();
    });
  });

  test('one dialog flickering off the pane and back buzzes a phone in front once', () {
    fakeAsync((async) {
      final system = _RecordingNotices();
      var buzzes = 0;
      final announcer = AgentAnnouncer(
        system: system,
        chime: () async => buzzes++,
        inFront: () => true,
      );
      for (var flicker = 0; flicker < 6; flicker++) {
        announcer.questionAsked(
          agent,
          requestId: 'approval-1',
          prompt:
              'Approve Bash command: Rerun Desktop scenario and related tests',
          watching: () => false,
        );
        async.elapse(const Duration(seconds: 3));
        // The daemon misses the dialog twice and closes it, then reads it
        // again and announces it with the same id.
        announcer.questionClosed(ref, requestId: 'approval-1');
        async.elapse(const Duration(seconds: 1));
      }
      announcer.questionAsked(
        agent,
        requestId: 'approval-1',
        prompt:
            'Approve Bash command: Rerun Desktop scenario and related tests',
        watching: () => false,
      );
      async.elapse(const Duration(minutes: 1));

      // Still open: the person is told, once.
      expect(buzzes, 1);
      announcer.dispose();
    });
  });
}
