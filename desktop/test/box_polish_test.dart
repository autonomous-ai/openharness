import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'support/launch_menu.dart';
import 'support/mixed_agents.dart';
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  setUp(() => newHarnessOpensInBox = true);
  tearDown(() => newHarnessOpensInBox = false);

  testWidgets(
    'setup errors remain visible and are live accessibility regions',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      app.machineStates['m']!.localOnly = true;
      app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
      await app.agentPreference.remember('codex');
      await app.projectHistory.select('m', '/work/openharness');
      app.adoptSessionForTest(terminal('a0', []));
      addTearDown(app.dispose);
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyN);
      final box = tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller;
      box.warn('The selected folder is unavailable.');
      await tester.pump();
      final status = find.byKey(const ValueKey('new-harness-status'));
      expect(find.text('The selected folder is unavailable.'), findsOneWidget);
      expect(status.hitTestable(), findsOneWidget);
      final semantics = tester.widget<Semantics>(
        find.ancestor(of: status, matching: find.byType(Semantics)).first,
      );
      expect(semantics.properties.liveRegion, isTrue);
      await openLaunchRow(tester, 'agent');
      await typeHarnessQuery(tester, 'Codex');
      expect(find.text('The selected folder is unavailable.'), findsNothing);
      box.warn('The selected folder is unavailable.');
      await tester.pump();
      expect(status, findsOneWidget);
      tester.view.physicalSize = const Size(600, 680);
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pump();
      expect(status.hitTestable(), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      // Clearing the filter clears its warning. Check the field view too.
      box.warn('The selected folder is unavailable.');
      await tester.pump();
      expect(status.hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
