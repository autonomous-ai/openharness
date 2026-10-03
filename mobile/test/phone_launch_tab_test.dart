import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/welcome/pick_up_page.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';
import 'voice_fakes.dart';

/// Which agent a launch opens when the account has desk tabs.
///
/// Focus holds ONE agent — there is no sideways swipe any more (see
/// `docs/plans/2026-09-26-001-mobile-zero-questions.md`) — so the pager is
/// handed no `neighbours`, and the tabs decide only where a launch lands.
void main() {
  /// The home screen as the shell mounts it: an agent picked anywhere else —
  /// the tabs panel included — arrives through [AgentHome.openAgent], and the
  /// shell is what carries it there.
  Future<AppNotifier> pumpHome(
    WidgetTester tester, {
    required List<DeskTab> tabs,
    MemoryKeyValueStore? storage,
  }) async {
    final app = await deskApp(
      PagerConn(),
      // Nothing here is about the terminals themselves — see [deskApp].
      opensTerminals: false,
      tabs: tabs,
      storage: storage,
    );
    addTearDown(app.dispose);
    final request = ValueNotifier<({String machineId, String agentId})?>(null);
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

  AgentSwipeHost pager(WidgetTester tester) =>
      tester.widget<AgentSwipeHost>(find.byType(AgentSwipeHost));

  group('with nothing of last time to reopen, a launch opens a tab', () {
    testWidgets('the one the phone was last in, on its first agent', (
      tester,
    ) async {
      await pumpHome(
        tester,
        storage: MemoryKeyValueStore()..values['phone_last_tab_v1'] = 't2',
        tabs: [
          deskTab('t1', 'Desktop', ['a']),
          deskTab('t2', 'Docker', ['d', 'c']),
        ],
      );

      expect(pager(tester).agentId, 'd');
      expect(pager(tester).neighbours, isNull);
      // A fixture with storage persists what it loads; its write timers run out before teardown.
      await tester.pump(const Duration(seconds: 11));
    });

    testWidgets('and so does one whose last agent is gone', (tester) async {
      await pumpHome(
        tester,
        storage: MemoryKeyValueStore()
          ..values['phone_last_agent_v1'] = jsonEncode({
            'machineId': 'm',
            'agentId': 'deleted',
          })
          ..values['phone_last_tab_v1'] = 't2',
        tabs: [
          deskTab('t1', 'Desktop', ['a', 'b']),
          deskTab('t2', 'Docker', ['c', 'd']),
        ],
      );

      expect(pager(tester).agentId, 'c');
      // A fixture with storage persists what it loads; its write timers run out before teardown.
      await tester.pump(const Duration(seconds: 11));
    });

    testWidgets(
      'or, with nothing remembered at all, the sessions to pick from',
      (tester) async {
        await pumpHome(
          tester,
          tabs: [
            deskTab('t1', 'Empty', ['gone']),
            deskTab('t2', 'Docker', ['c', 'd']),
          ],
        );

        // A new phone opens on "Pick up where you left off", not on a session guessed for it.
        expect(find.byType(PickUpPage), findsOneWidget);
        expect(find.byType(AgentSwipeHost), findsNothing);
        // Its list reaches the machines as Find does (`reachAllMachines`): let the timers run out.
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 30));
      },
    );
  });
}
