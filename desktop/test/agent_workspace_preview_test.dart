// OpenClaw's workspace on a plain harness (OpenClaw engine spec, decision 10): its tools run in
// OpenClaw's own workspace, not the pane's folder, so the harness's details say where, beside the
// folder. Clicked through as a person does: open the harness search, find it, read its preview.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';

import 'support/open_harness.dart';
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp;

void main() {
  Agent agent(String id, String name, {String? workspace}) => Agent(
    id: id,
    sessionId: 'session-$id',
    name: name,
    engine: workspace == null ? 'claude' : 'openclaw',
    workspace: workspace,
    terminalAvailable: true,
    project: AgentProject(name: 'ochello', cwd: '/work/ochello'),
  );

  testWidgets('a harness shows its engine workspace beside its folder', (
    tester,
  ) async {
    final app = createApp();
    final machine = app.machineStates['m']!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    machine.agents = [
      agent('a0', 'Gateway check', workspace: '/home/dee/.openclaw/workspace'),
      agent('a1', 'Checkout retries'),
    ];
    await mount(tester, app);
    await openHarnessPicker(tester);
    final field = find.byKey(const ValueKey('swarm-search-input'));
    await tester.enterText(field, 'Gateway check');
    await tester.pump();
    expect(find.text('/work/ochello'), findsOneWidget);
    expect(
      find.text('Workspace · /home/dee/.openclaw/workspace'),
      findsOneWidget,
    );

    // An engine that works in the pane's folder has no workspace to show.
    await tester.enterText(field, 'Checkout retries');
    await tester.pump();
    expect(find.text('/work/ochello'), findsOneWidget);
    expect(find.textContaining('Workspace ·'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
