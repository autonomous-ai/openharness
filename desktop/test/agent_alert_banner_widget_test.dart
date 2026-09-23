// The banner as a CONTROL: that a click reaches it at all, and what the click does.
//
// This file exists because the first version was unclickable and looked correct — an
// `IgnorePointer` around the stack with `ignoring: false` on each banner, which reads like
// "the column is transparent, the banners are not" and is not how that widget works.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/agent_alert_banners.dart';

class _Memory implements LocalKeyValueStore {
  final values = <String, String?>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

const _machine = Machine(
  machineId: 'm1',
  authMode: MachineAuthMode.remote,
  name: 'MacBook-Pro.local',
);

void main() {
  late AppNotifier app;

  setUp(() {
    final screen = ScreenAlertStore(storage: _Memory())..value = true;
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      agentAlerts: AgentAlerts(store: screen),
    );
    app.machines = [_machine];
    app.machineStates['m1'] = MachineState(_machine)
      ..agents = [
        const Agent(id: 'a1', name: 'Respond to greeting', engine: 'codex'),
      ];
  });

  tearDown(() => app.dispose());

  Future<void> show(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Stack(children: [AgentAlertBanners(notifier: app)]),
        ),
      ),
    );
    app.agentAlerts.post(
      AgentAlert(
        machineId: 'm1',
        agentId: 'a1',
        title: 'Respond to greeting',
        kind: AlertKind.done,
        at: DateTime.now(),
      ),
    );
    await tester.pump();
  }

  testWidgets('a banner appears, named after the agent', (tester) async {
    await show(tester);
    expect(find.byKey(const Key('agent-alert-banner')), findsOneWidget);
    expect(find.text('Respond to greeting'), findsOneWidget);
    expect(find.text('Finished'), findsOneWidget);
    // A standing banner holds its sweep timer, and the binding checks for pending timers at the
    // END OF THE BODY — before any tearDown, registered or top-level. The other tests here leave
    // nothing standing because clicking and dismissing both empty the stack.
    app.agentAlerts.clear();
  });

  testWidgets('clicking it opens that agent — which also proves it is reachable', (tester) async {
    // `tester.tap` dispatches a real pointer through hit testing, so an ancestor refusing the hit
    // test fails this rather than needing an assertion of its own. That is what the first version
    // did, and it left a banner perfectly visible and perfectly dead.
    await show(tester);
    expect(app.panes, isEmpty);

    await tester.tap(find.byKey(const Key('agent-alert-banner')));
    await tester.pumpAndSettle();

    // The agent now has a pane, and it is the focused one.
    expect(app.panes, isNotEmpty);
    final pane = app.panes.firstWhere(
      (p) => p.machineId == 'm1' && p.agentId == 'a1',
    );
    expect(app.focusedPane?.id, pane.id);
  });

  testWidgets('clicking it takes the banner down', (tester) async {
    await show(tester);
    await tester.tap(find.byKey(const Key('agent-alert-banner')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('agent-alert-banner')), findsNothing);
  });

  testWidgets('dismissing takes it down WITHOUT opening anything', (tester) async {
    // A notice you can only answer by following it would make every stray banner a navigation.
    await show(tester);
    await tester.tap(find.byKey(const Key('agent-alert-dismiss')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('agent-alert-banner')), findsNothing);
    expect(app.panes, isEmpty);
  });
}

