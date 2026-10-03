import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/agent_announcer.dart';
import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/system_notices.dart';

/// The announcer as the app builds it — with its own answer to "is the app in
/// front", read off the binding, rather than the one the other tests inject.
///
/// That answer decides between a mark and a lock-screen notice, so it is
/// pinned against the real lifecycle states a phone passes through.
void main() {
  const ref = (machineId: 'm', agentId: 'a');
  const agent = (ref: ref, name: 'Fix login', machine: 'MacBook');
  const news = (
    aborted: false,
    replay: false,
    subagent: false,
    reply: 'Fixed the login screen.',
  );

  // First, and deliberately before any `testWidgets`: with no binding at all
  // `WidgetsBinding.instance` throws rather than answering null, and plain
  // `test()`s drive the notifier exactly like that.
  test('with no binding at all, unknown counts as in front', () {
    final announcer = AgentAnnouncer(system: SilentSystemNotices());
    addTearDown(announcer.dispose);
    expect(announcer.inFront, isTrue);
  });

  testWidgets('in front while resumed; a pocketed phone gets the notice', (
    tester,
  ) async {
    final system = _Recording();
    final announcer = AgentAnnouncer(system: system);
    addTearDown(announcer.dispose);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    expect(announcer.inFront, isTrue);
    // In front, elsewhere: the haptic tap and a mark — the default chime must
    // never throw, even where no platform answers it.
    expect(
      announcer.turnEnded(agent, news, watching: () => false),
      AgentNotice.mark,
    );
    expect(system.shown, isEmpty);

    for (final state in [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    expect(announcer.inFront, isFalse);
    expect(
      announcer.turnEnded(agent, news, watching: () => true),
      AgentNotice.alert,
    );
    expect(system.shown.single.body, 'Fixed the login screen.');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  });
}

class _Recording extends SilentSystemNotices {
  final shown = <AgentNoticeMessage>[];

  @override
  Future<void> show(AgentNoticeMessage message) async => shown.add(message);
}
