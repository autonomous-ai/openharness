import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/buddies.dart';
import 'package:harness/super_tabs/buddy_machines.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';

/// The Buddy picker offers the Mac running Harness (Dee, 10-29): when it is
/// the reader's own and not in the Swarm yet, Start adds it and then starts the
/// Buddy there, in one click.
/// Set to a folder to write the PR's pictures there.
final shots = Platform.environment['SUPER_TAB_BUDDY_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  const notInSwarm = 'Not in this Swarm yet: Start adds it';
  const notInSwarmDialog = 'Not in this Swarm yet: Add Buddy adds it';

  /// Another machine of the reader's, already in the Swarm.
  Map<String, dynamic> rig() => {
    'machineId': 'rig',
    'name': '2x 4090 Rig',
    'contributorId': 'owner',
    'scope': 'swarm',
    'engines': <dynamic>['claude'],
    'maxAgents': 4,
    'availableSlots': 4,
  };

  Future<({SuperTabLaunchFixture f, SuperTabController c, String mac})> open(
    WidgetTester tester, {
    List<Map<String, dynamic>> machines = const [],
    bool bar = true,
    Brightness brightness = Brightness.light,
    void Function(SuperTabLaunchFixture f)? prepare,

    /// Changes the Mac once the Swarm is open, as the account's machine list
    /// does while the app runs.
    void Function(SuperTabLaunchFixture f)? afterOpen,
  }) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final server = f.connection.server;
    server.state['buddies'] = true;
    server.state['machines'] = <dynamic>[...machines];
    prepare?.call(f);
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: bar
              ? SuperTabView(
                  controller: c,
                  app: f.app,
                  onInvite: () {},
                  onAddAgent: (_) {},
                  onOpenTerminal: (_) {},
                  machineName: (_) => 'Team Mac',
                )
              : Builder(
                  builder: (context) => TextButton(
                    onPressed: () => showAddBuddy(context, c, app: f.app),
                    child: const Text('Open'),
                  ),
                ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    if (bar) {
      expect(await c.openCurrentBuddyChat(), isTrue);
    } else {
      await tester.tap(find.text('Open'));
    }
    await tester.pumpAndSettle();
    if (afterOpen != null) {
      afterOpen(f);
      await c.refresh();
      await tester.pumpAndSettle();
    }
    return (
      f: f,
      c: c,
      mac: superTabMachineName(f.app.stateOf('m')!.machine.displayName),
    );
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

  /// Lets the Add machine setup poll (it waits a second between asks) finish.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    await tester.pumpAndSettle();
  }

  List<String> sent(SuperTabLaunchFixture f) => [
    for (final post in f.connection.server.posts)
      if ((post['command'] as Map)['type'] case final String type
          when type == 'machine.contribute' || type == 'buddy.create')
        '$type ${(post['command'] as Map)['machineId']}',
  ];

  final barMachine = find.byKey(const ValueKey('super-buddy-start-machine'));
  final dialogMachine = find.byKey(const ValueKey('super-buddy-machine'));
  final start = find.widgetWithText(FilledButton, 'Start');
  final addBuddy = find.widgetWithText(FilledButton, 'Add Buddy');

  /// The open menu's rows, top to bottom.
  List<String> menuRows(WidgetTester tester, List<String> names) =>
      (names.where((n) => find.text(n).evaluate().isNotEmpty).toList()..sort(
        (a, b) => tester
            .getTopLeft(find.text(a).last)
            .dy
            .compareTo(tester.getTopLeft(find.text(b).last).dy),
      ));

  group('the Start bar', () {
    testWidgets('lists this Mac first, picked, with what Start does', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);

      expect(
        find.descendant(of: barMachine, matching: find.text('This Mac · $mac')),
        findsOneWidget,
      );
      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      // Beside the Mac's row in the menu, as well as under the bar.
      expect(find.text(notInSwarm), findsNWidgets(2));
      expect(menuRows(tester, ['This Mac · $mac', '2x 4090 Rig']), [
        'This Mac · $mac',
        '2x 4090 Rig',
      ]);
      await close(tester, f, c);
    });

    testWidgets('says Start adds this Mac before the menu is opened', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);

      expect(find.text(notInSwarm), findsOneWidget);
      // Under the bar's row, not inside the field.
      expect(
        tester.getTopLeft(find.text(notInSwarm)).dy,
        greaterThan(tester.getBottomLeft(barMachine).dy),
      );
      await close(tester, f, c);
    });

    testWidgets(
      'says nothing when the picked machine is already in the Swarm',
      (tester) async {
        final (:f, :c, :mac) = await open(tester, machines: [rig()]);

        await tester.tap(barMachine);
        await tester.pumpAndSettle();
        await tester.tap(find.text('2x 4090 Rig').last);
        await tester.pumpAndSettle();

        expect(find.text(notInSwarm), findsNothing);
        await close(tester, f, c);
      },
    );

    testWidgets('a retry while setup is still running joins that setup', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);
      f.connection.keepPreparing = true;
      List<Object?> setups() => [
        for (final call in f.connection.calls)
          if (call.$2['action'] == 'prepareContribution')
            call.$2['operationId'],
      ];

      await tester.tap(start);
      await settle(tester);
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(seconds: 60));
      }
      await tester.pumpAndSettle();
      expect(find.textContaining('still running'), findsOneWidget);
      final first = setups().toSet();
      expect(first, hasLength(1));

      f.connection.keepPreparing = false;
      await tester.tap(start);
      await settle(tester);

      // The same setup was asked again, not a second one started.
      expect(setups().toSet(), first);
      expect(sent(f), ['machine.contribute m', 'buddy.create m']);
      await close(tester, f, c);
    });

    testWidgets('Start adds this Mac, then starts the Buddy on it', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);

      await tester.tap(start);
      await settle(tester);

      expect(sent(f), ['machine.contribute m', 'buddy.create m']);
      expect(c.buddy('lead'), isNotNull);
      await close(tester, f, c);
    });

    testWidgets('with no other machine, this Mac is the one to start on', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester);

      expect(
        find.text('None of your machines is in this Swarm yet.'),
        findsNothing,
      );
      await tester.tap(start);
      await settle(tester);

      expect(sent(f), ['machine.contribute m', 'buddy.create m']);
      await close(tester, f, c);
    });

    testWidgets('another machine picked starts there and adds nothing', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);

      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      await tester.tap(find.text('2x 4090 Rig').last);
      await tester.pumpAndSettle();
      await tester.tap(start);
      await settle(tester);

      expect(sent(f), ['buddy.create rig']);
      await close(tester, f, c);
    });

    testWidgets('an add that fails shows its error and starts nothing', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);
      f.connection.server.reject = true;

      await tester.tap(start);
      await settle(tester);

      expect(sent(f).where((s) => s.startsWith('buddy.create')), isEmpty);
      expect(
        find.byKey(const ValueKey('super-buddy-start-error')),
        findsOneWidget,
      );
      // Still there to try again, and still this Mac.
      expect(tester.widget<FilledButton>(start).onPressed, isNotNull);
      expect(
        find.descendant(of: barMachine, matching: find.text('This Mac · $mac')),
        findsOneWidget,
      );
      await close(tester, f, c);
    });

    testWidgets('a second click while it adds sends one add', (tester) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);

      await tester.tap(start);
      await tester.pump();
      expect(tester.widget<FilledButton>(start).onPressed, isNull);
      await settle(tester);

      expect(sent(f), ['machine.contribute m', 'buddy.create m']);
      await close(tester, f, c);
    });

    testWidgets(
      'access revoked while it adds adds nothing and starts nothing',
      (tester) async {
        final (:f, :c, :mac) = await open(tester, machines: [rig()]);

        await tester.tap(start);
        await tester.pump();
        for (final person in f.connection.server.state['people'] as List) {
          if ((person as Map)['id'] == 'owner') person['role'] = 'viewer';
        }
        await c.refresh();
        await settle(tester);

        expect(c.canWrite, isFalse);
        expect(sent(f), isEmpty);
        await close(tester, f, c);
      },
    );

    testWidgets(
      'a Mac already in the Swarm is listed first by name, the rest follow',
      (tester) async {
        final (:f, :c, :mac) = await open(
          tester,
          machines: [
            rig(),
            {
              'machineId': 'm',
              'name': 'Office.local',
              'contributorId': 'owner',
              'scope': 'swarm',
              'engines': <dynamic>['claude'],
              'maxAgents': 4,
              'availableSlots': 4,
            },
          ],
        );

        expect(
          find.descendant(of: barMachine, matching: find.text('Office')),
          findsOneWidget,
        );
        await tester.tap(barMachine);
        await tester.pumpAndSettle();
        expect(find.textContaining('This Mac'), findsNothing);
        expect(find.text(notInSwarm), findsNothing);
        expect(menuRows(tester, ['Office', '2x 4090 Rig']), [
          'Office',
          '2x 4090 Rig',
        ]);
        await close(tester, f, c);
      },
    );

    testWidgets('a Mac that cannot be added now is not offered', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(
        tester,
        machines: [rig()],
        prepare: (f) => f.app.machineStates['m']!.nodeOnline = false,
      );

      expect(
        find.descendant(of: barMachine, matching: find.text('2x 4090 Rig')),
        findsOneWidget,
      );
      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      expect(find.textContaining('This Mac'), findsNothing);
      await close(tester, f, c);
    });

    testWidgets('a Mac someone else already added is not offered again', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(
        tester,
        machines: [
          rig(),
          {
            ...rig(),
            'machineId': 'm',
            'name': 'Office.local',
            'contributorId': 'other',
          },
        ],
      );

      expect(
        find.descendant(of: barMachine, matching: find.text('2x 4090 Rig')),
        findsOneWidget,
      );
      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      expect(find.textContaining('This Mac'), findsNothing);
      expect(find.text('Office'), findsNothing);
      expect(find.text(notInSwarm), findsNothing);
      await close(tester, f, c);
    });

    testWidgets("a Mac signed in to another account is never offered", (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(
        tester,
        machines: [rig()],
        afterOpen: (f) {
          final own = f.app.machineStates['m']!;
          own.machine = Machine(
            machineId: 'm',
            authMode: own.machine.authMode,
            name: own.machine.name,
            isShared: true,
          );
        },
      );

      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      expect(find.textContaining('This Mac'), findsNothing);
      await close(tester, f, c);
    });

    testWidgets('the machine field is as wide as its names, not the row', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);

      final field = tester.getSize(barMachine).width;
      final bar = tester.getSize(
        find.byKey(const ValueKey('super-buddy-start')),
      );
      expect(field, lessThan(bar.width / 2));
      // And wide enough to read the longest name whole.
      expect(
        tester.getSize(find.text('This Mac · $mac').last).width,
        lessThan(field),
      );
      await close(tester, f, c);
    });
  });

  testWidgets('the field fits its longest name at large text', (tester) async {
    final (:f, :c, :mac) = await open(tester, machines: [rig()]);
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpAndSettle();

    final text = tester.widget<Text>(
      find.descendant(of: barMachine, matching: find.text('This Mac · $mac')),
    );
    final painter = TextPainter(
      text: TextSpan(text: text.data, style: text.style),
      textDirection: TextDirection.ltr,
      textScaler: const TextScaler.linear(2),
    )..layout();
    // Whole, not cut to an ellipsis.
    expect(
      tester.getSize(find.text('This Mac · $mac').last).width,
      closeTo(painter.width, 1),
    );
    await close(tester, f, c);
  });

  group('Add a Buddy', () {
    testWidgets('says Add Buddy adds this Mac before the menu is opened', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()], bar: false);

      expect(find.text(notInSwarmDialog), findsOneWidget);
      expect(find.text(notInSwarm), findsNothing);
      await tester.tap(dialogMachine);
      await tester.pumpAndSettle();
      await tester.tap(find.text('2x 4090 Rig').last);
      await tester.pumpAndSettle();
      expect(find.text(notInSwarmDialog), findsNothing);
      await close(tester, f, c);
    });

    testWidgets('write access lost while it adds says so and adds nothing', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()], bar: false);

      await tester.tap(addBuddy);
      await tester.pump();
      for (final person in f.connection.server.state['people'] as List) {
        if ((person as Map)['id'] == 'owner') person['role'] = 'viewer';
      }
      await c.refresh();
      await settle(tester);

      // The dialog's scope swaps the form for its own message, so the person
      // is not left looking at Adding….
      expect(sent(f), isEmpty);
      expect(find.text('This action is no longer available.'), findsOneWidget);
      expect(find.text('Adding…'), findsNothing);
      await close(tester, f, c);
    });

    testWidgets('an add that loses write access gives the reason', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);
      for (final person in f.connection.server.state['people'] as List) {
        if ((person as Map)['id'] == 'owner') person['role'] = 'viewer';
      }
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.canWrite, isFalse);

      final (:id, :error) = await BuddyMachineAdder(
        c,
        f.app,
      ).resolve(buddyMachines(c, app: f.app).first, alive: () => true);

      expect(id, isNull);
      expect(error, kBuddyAccessLost);
      expect(sent(f), isEmpty);
      await close(tester, f, c);
    });

    testWidgets('lists this Mac first and picked', (tester) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()], bar: false);

      expect(
        find.descendant(
          of: dialogMachine,
          matching: find.text('This Mac · $mac'),
        ),
        findsOneWidget,
      );
      expect(tester.widget<FilledButton>(addBuddy).onPressed, isNotNull);
      await tester.tap(dialogMachine);
      await tester.pumpAndSettle();
      expect(find.text(notInSwarmDialog), findsNWidgets(2));
      await close(tester, f, c);
    });

    testWidgets('Add Buddy adds this Mac, then starts the Buddy on it', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, bar: false);

      await tester.tap(addBuddy);
      await settle(tester);

      expect(sent(f), ['machine.contribute m', 'buddy.create m']);
      expect(find.text('Add a Buddy'), findsNothing);
      await close(tester, f, c);
    });

    testWidgets('an add that fails keeps the dialog open with its error', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, bar: false);
      f.connection.server.reject = true;

      await tester.tap(addBuddy);
      await settle(tester);

      expect(sent(f).where((s) => s.startsWith('buddy.create')), isEmpty);
      expect(find.text('Add a Buddy'), findsOneWidget);
      expect(find.byKey(const ValueKey('super-buddy-error')), findsOneWidget);
      await close(tester, f, c);
    });
  });

  group('a Mac that cannot be added, and no other machine', () {
    Future<({SuperTabLaunchFixture f, SuperTabController c, String mac})>
    offline(WidgetTester tester, {required bool bar}) => open(
      tester,
      bar: bar,
      prepare: (f) => f.app.machineStates['m']!.nodeOnline = false,
    );
    const reason = 'Offline. Open Harness on this computer to add it.';

    testWidgets('the Start bar says why and offers no Start', (tester) async {
      final (:f, :c, :mac) = await offline(tester, bar: true);

      expect(
        find.text('None of your machines is in this Swarm yet.'),
        findsOneWidget,
      );
      expect(find.text(reason), findsOneWidget);
      expect(start, findsNothing);
      await close(tester, f, c);
    });

    testWidgets('Add a Buddy says why and cannot be submitted', (tester) async {
      final (:f, :c, :mac) = await offline(tester, bar: false);

      expect(find.text(reason), findsOneWidget);
      expect(tester.widget<FilledButton>(addBuddy).onPressed, isNull);
      await close(tester, f, c);
    });
  });

  for (final brightness in Brightness.values) {
    testWidgets('pictures in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      var (:f, :c, :mac) = await open(
        tester,
        machines: [rig()],
        brightness: brightness,
      );
      await captureWindow(tester, shots, 'buddy-start-${brightness.name}');
      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'buddy-start-menu-${brightness.name}');
      await close(tester, f, c);

      (:f, :c, :mac) = await open(
        tester,
        machines: [rig()],
        bar: false,
        brightness: brightness,
      );
      await captureWindow(tester, shots, 'buddy-add-${brightness.name}');
      await tester.tap(dialogMachine);
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'buddy-add-menu-${brightness.name}');
      await close(tester, f, c);
    });
  }
}
