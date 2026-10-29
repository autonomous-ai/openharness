import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/buddies.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';

/// Add a Buddy for a person with no machine in the Swarm (Scholes, 10-29): the
/// dialog offers this computer through the Add machine flow instead of ending.
/// Set to a folder to write the PR's pictures there.
final shots = Platform.environment['SUPER_TAB_BUDDY_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Future<({SuperTabLaunchFixture f, SuperTabController c})> open(
    WidgetTester tester, {
    Brightness brightness = Brightness.light,
    void Function(SuperTabLaunchFixture f)? prepare,
  }) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final server = f.connection.server;
    server.state['buddies'] = true;
    server.state['machines'] = <dynamic>[];
    server.state['project'] = {
      'machineId': 'm',
      'cwd': '/work/project',
      'scope': 'swarm',
      'repositoryUrl': null,
    };
    prepare?.call(f);
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showAddBuddy(context, c, app: f.app),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    return (f: f, c: c);
  }

  Future<void> close(
    WidgetTester tester,
    SuperTabLaunchFixture f,
    SuperTabController c,
  ) async {
    debugDefaultTargetPlatformOverride = null;
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  }

  final addThisMac = find.widgetWithText(TextButton, 'Add this Mac');
  final submit = find.widgetWithText(FilledButton, 'Add Buddy');

  testWidgets(
    'with no machine of theirs in the Swarm, it offers to add this Mac',
    (tester) async {
      final (:f, :c) = await open(tester);

      expect(
        find.text('None of your machines is in this Swarm yet.'),
        findsOneWidget,
      );
      expect(addThisMac, findsOneWidget);
      expect(
        find.textContaining('Add one of yours to this Swarm first'),
        findsNothing,
      );
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      await close(tester, f, c);
    },
  );

  testWidgets('adding this Mac returns to Add a Buddy with it selected', (
    tester,
  ) async {
    final (:f, :c) = await open(tester);
    final name = f.app.stateOf('m')!.machine.displayName;

    await tester.tap(addThisMac);
    await tester.pumpAndSettle();
    expect(find.text('Add machine'), findsWidgets);
    await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    await tester.pumpAndSettle();

    expect(find.text('Add a Buddy'), findsOneWidget);
    expect(find.text('Add machine'), findsNothing);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('super-buddy-machine')),
        matching: find.text(superTabMachineName(name)),
      ),
      findsOneWidget,
    );
    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
    expect(addThisMac, findsNothing);
    await close(tester, f, c);
  });

  testWidgets('a computer that cannot be added shows the flow\'s own reason', (
    tester,
  ) async {
    final (:f, :c) = await open(
      tester,
      prepare: (f) => f.app.machineStates['m']!.nodeOnline = false,
    );

    expect(
      find.text('Offline. Open Harness on this computer to add it.'),
      findsOneWidget,
    );
    expect(tester.widget<TextButton>(addThisMac).onPressed, isNull);
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await close(tester, f, c);
  });

  for (final brightness in Brightness.values) {
    testWidgets('pictures in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      final (:f, :c) = await open(tester, brightness: brightness);
      await captureWindow(tester, shots, 'buddy-no-machine-${brightness.name}');
      await tester.tap(addThisMac);
      await tester.pumpAndSettle();
      await captureWindow(
        tester,
        shots,
        'buddy-add-machine-${brightness.name}',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(seconds: 1));
      }
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'buddy-added-${brightness.name}');
      await close(tester, f, c);
    });
  }
}
