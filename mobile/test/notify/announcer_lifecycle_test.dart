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
    tier: null,
  );

  // First, and deliberately before any `testWidgets`: with no binding at all
  // `WidgetsBinding.instance` throws rather than answering null, and plain
  // `test()`s drive the notifier exactly like that.
  test('with no binding at all, unknown counts as in front', () {
    final announcer = AgentAnnouncer(system: SilentSystemNotices());
    addTearDown(announcer.dispose);
    expect(announcer.inFront, isTrue);
  });

  testWidgets('in front while resumed; an agent not on screen gets the notice, in front or pocketed', (
    tester,
  ) async {
    final system = _Recording();
    final announcer = AgentAnnouncer(system: system);
    addTearDown(announcer.dispose);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    expect(announcer.inFront, isTrue);
    // In front, elsewhere: the haptic tap, a mark and the OS's banner over the
    // app — the default chime must never throw, even where no platform answers it.
    expect(
      announcer.turnEnded(agent, news, watching: () => false),
      AgentNotice.alert,
    );
    expect(system.shown, hasLength(1));

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
    expect(system.shown, hasLength(2));
    expect(system.shown.last.body, 'Fixed the login screen.');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  });

  testWidgets('a question waiting out its grace is told the moment the app is hidden', (
    tester,
  ) async {
    final system = _Recording();
    final announcer = AgentAnnouncer(system: system);
    addTearDown(announcer.dispose);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    expect(
      announcer.questionAsked(
        agent,
        requestId: 'q1',
        prompt: 'Approve Bash command: npm test',
        watching: () => false,
      ),
      AgentNotice.filed,
    );
    expect(system.shown, isEmpty, reason: 'in front, it waits out its grace');

    // Locking the phone: iOS suspends the app within seconds, and the wait's
    // timer with it — so it goes now, and loud.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    expect(system.shown, isEmpty, reason: 'inactive is not away');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    expect(system.shown, hasLength(1));
    expect(system.shown.single.quiet, isFalse);
    expect(system.shown.single.body, 'Approve Bash command: npm test');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    expect(system.shown, hasLength(1), reason: 'told once');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  });

  testWidgets('going away after the announcer is disposed tells nothing, and throws nothing', (
    tester,
  ) async {
    final system = _Recording();
    final announcer = AgentAnnouncer(system: system);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    announcer.questionAsked(
      agent,
      requestId: 'q1',
      prompt: 'Approve Bash command: npm test',
      watching: () => false,
    );
    announcer.dispose();
    // Its wait went with it, and so did its ear: going away tells of nothing.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    expect(system.shown, isEmpty);
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
