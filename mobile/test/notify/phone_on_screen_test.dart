import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../agent_pager_fixture.dart';
import '../desk_fixture.dart';

/// The agent the phone is SHOWING is the one it is watching — whatever the
/// grid's focus says. The two come apart on a phone: the pager puts an agent
/// on screen before (or without) a pane for it being focused.
void main() {
  /// What the shell hands [AgentHome] when a row or a notice is tapped.
  late ValueNotifier<({String machineId, String agentId})?> request;

  Future<AppNotifier> pumpHome(WidgetTester tester) async {
    final app = await deskApp(
      PagerConn(),
      // No stream opens, so no pane is ever focused: the pager alone knows
      // which agent is on screen — exactly the gap this is about.
      opensTerminals: false,
      tabs: [
        deskTab('t1', 'Greet user', ['a', 'b']),
      ],
    );
    addTearDown(app.dispose);
    request = ValueNotifier<({String machineId, String agentId})?>(null);
    addTearDown(request.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: PhoneShellScope(
          onMachineLinked: (_) {},
          onOpenAgent: (machineId, agentId) =>
              request.value = (machineId: machineId, agentId: agentId),
          child: AgentHome(notifier: app, openAgent: request),
        ),
      ),
    );
    await tester.pump();
    return app;
  }

  Future<void> turn(AppNotifier app, String agentId) async {
    for (final (type, payload) in [
      ('turn_started', {'userMessage': 'hi'}),
      ('text_delta', {'content': 'Hello!'}),
      ('turn_ended', <String, dynamic>{}),
    ]) {
      await app.handleEventForTest('m', {
        'type': type,
        'agentId': agentId,
        'payload': payload,
      });
    }
  }

  /// Lets the turn's own timers run out, so the test ends with none pending.
  Future<void> settleTimers(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 30));
  }

  bool unread(AppNotifier app, String agentId) =>
      app.agentNotices.unread.contains((machineId: 'm', agentId: agentId));

  testWidgets('the agent on screen finishing is never marked', (tester) async {
    final app = await pumpHome(tester);
    final shown = tester.widget<AgentSwipeHost>(find.byType(AgentSwipeHost));
    expect(shown.agentId, 'a');

    await turn(app, 'a');
    await tester.pump();

    expect(unread(app, 'a'), isFalse);
    await settleTimers(tester);
  });

  testWidgets('an agent finishing off screen is still marked', (tester) async {
    final app = await pumpHome(tester);

    await turn(app, 'b');
    await tester.pump();

    expect(unread(app, 'b'), isTrue);
    await settleTimers(tester);
  });

  testWidgets('opening the agent that finished takes its mark down', (
    tester,
  ) async {
    // The screenshot: "Greet user" finished while another agent was on screen,
    // then was opened from the tabs panel — and kept its dot beside the ✓.
    final app = await pumpHome(tester);
    await turn(app, 'b');
    expect(unread(app, 'b'), isTrue);

    request.value = (machineId: 'm', agentId: 'b');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(
      tester.widget<AgentSwipeHost>(find.byType(AgentSwipeHost)).agentId,
      'b',
    );
    expect(unread(app, 'b'), isFalse);
    await settleTimers(tester);
  });
}
