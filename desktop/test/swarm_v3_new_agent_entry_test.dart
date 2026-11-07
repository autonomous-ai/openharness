import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'keymap_host_test.dart' show MemoryKeymap;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

// Task #4196 (anh Dee, 11-07): + New agent in My agents opens the workspace's
// Cmd-N form, with every picker and one more choice, Member or Lead.
void main() {
  testWidgets('+ New agent opens Cmd-N as a Member', (tester) async {
    final oldEntry = newHarnessOpensInBox;
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = oldEntry);
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    final projects = SwarmProjectStore();
    addTearDown(projects.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1500, 900);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        builder: (context, child) =>
            KeymapProvider(keymap: map, child: child!),
        home: SwarmScreen(
          notifier: f.app,
          nativeTabs: false,
          projectStore: projects,
        ),
      ),
    );
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('super-new-agent-row'));
    await tester.ensureVisible(row);
    await tester.tap(row);
    await tester.pumpAndSettle();

    final form = find.byType(NewHarnessForm);
    expect(form, findsOneWidget);
    final kind = find.byKey(const ValueKey('new-harness-field-agent-kind'));
    expect(find.descendant(of: kind, matching: find.text('Member')),
        findsOneWidget);
    for (final picker in ['agent', 'machine', 'project']) {
      expect(find.byKey(ValueKey('new-harness-field-$picker')), findsOneWidget);
    }
    expect(tester.widget<NewHarnessForm>(form).controller.agentKind, 'member');
    expect(find.text('Create agent'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
  });
}
