import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/buddies.dart';
import 'package:harness/super_tabs/buddy_machines.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';

/// The Buddy pickers list every machine of the reader's own (Dee, 10-29: "I
/// just wanted to create my buddy. I don't want to add my machine to the
/// swarm."): this Mac first and picked, offline ones listed but not pickable.
/// A Buddy on one outside the Swarm sends its prepared setup, and nothing ever
/// adds the machine to the Swarm.
/// Set to a folder to write the PR's pictures there.
final shots = Platform.environment['SUPER_TAB_BUDDY_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  /// Machines of the reader's account outside the Swarm: online, offline,
  /// shared with them by someone else, and a Harness Team account.
  void accountMachines(SuperTabLaunchFixture f) {
    MachineState remote(
      String id,
      String name, {
      bool online = true,
      bool shared = false,
      String? kind,
    }) => MachineState(
      Machine(
        machineId: id,
        authMode: MachineAuthMode.remote,
        name: name,
        status: online ? 'online' : 'offline',
        isShared: shared,
        sessionKind: kind,
      ),
    )..nodeOnline = online;
    f.app.machineStates
      ..['studio'] = remote('studio', 'Studio')
      ..['air'] = remote('air', 'MacBook Air', online: false)
      ..['lent'] = remote('lent', 'Lent Mac', shared: true)
      ..['team'] = remote('team', 'Team account', kind: 'team');
  }

  /// Another machine of the reader's, already in the Swarm.
  Map<String, dynamic> rig() => {
    'machineId': 'rig',
    'name': '2x 4090 Rig',
    'contributorId': 'owner',
    'scope': 'swarm',
    'engines': <dynamic>['claude'],
    'maxAgents': 4,
    'availableSlots': 4,
    // Reporting now: it is in no account list here, so only this says it is
    // there (buddyMachines).
    'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
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

  /// What reached the server: a Buddy's start, and whether it carried a
  /// setup; any machine add, which must never happen.
  List<String> sent(SuperTabLaunchFixture f) => [
    for (final post in f.connection.server.posts)
      if ((post['command'] as Map)['type'] case final String type
          when type == 'machine.contribute' || type == 'buddy.create')
        '$type ${(post['command'] as Map)['machineId']}'
            '${(post['command'] as Map)['setup'] != null ? ' +setup' : ''}',
  ];
  Map<String, dynamic>? setupSent(SuperTabLaunchFixture f) =>
      (f.connection.server.posts.lastWhere(
                (p) => (p['command'] as Map)['type'] == 'buddy.create',
              )['command']
              as Map)['setup']
          as Map<String, dynamic>?;

  /// The machines preparation was asked on, in order.
  List<Object?> prepares(SuperTabLaunchFixture f) => [
    for (final call in f.connection.calls)
      if (call.$2['action'] == 'prepareContribution') call.$2['operationId'],
  ];

  final barMachine = find.byKey(const ValueKey('super-buddy-start-machine'));
  final dialogMachine = find.byKey(const ValueKey('super-buddy-machine'));
  final start = find.widgetWithText(FilledButton, 'Start');
  final addBuddy = find.widgetWithText(FilledButton, 'Add Buddy');
  Finder option(String id) =>
      find.byKey(ValueKey('super-buddy-machine-option-$id'));

  /// The open menu's rows, top to bottom.
  List<String> menuRows(WidgetTester tester, List<String> names) =>
      (names.where((n) => find.text(n).evaluate().isNotEmpty).toList()..sort(
        (a, b) => tester
            .getTopLeft(find.text(a).last)
            .dy
            .compareTo(tester.getTopLeft(find.text(b).last).dy),
      ));

  group('the Start bar', () {
    testWidgets(
      'lists this Mac first and picked, then the online, then the offline: '
      'never a machine shared with them or a Team account',
      (tester) async {
        final (:f, :c, :mac) = await open(
          tester,
          machines: [rig()],
          prepare: accountMachines,
        );

        expect(
          find.descendant(of: barMachine, matching: find.text(mac)),
          findsOneWidget,
        );
        await tester.tap(barMachine);
        await tester.pumpAndSettle();
        expect(find.text(kBuddyOwnMachines), findsOneWidget);
        expect(
          menuRows(tester, [mac, '2x 4090 Rig', 'Studio', 'MacBook Air']),
          [mac, '2x 4090 Rig', 'Studio', 'MacBook Air'],
        );
        expect(find.text('Lent Mac'), findsNothing);
        expect(find.text('Team account'), findsNothing);
        expect(find.textContaining('Swarm'), findsNothing);
        expect(
          find.descendant(
            of: option('air'),
            matching: find.text(kBuddyMachineOffline),
          ),
          findsOneWidget,
        );
        await close(tester, f, c);
      },
    );

    // Review of #2240: a Swarm row no account record confirms read as online.
    testWidgets('a Swarm machine in no account list and not reporting is '
        'offline, never picked by default', (tester) async {
      final (:f, :c, :mac) = await open(
        tester,
        machines: [
          {...rig(), 'observation': null},
        ],
        prepare: (f) => f.app.machineStates['m']!.nodeOnline = false,
      );

      expect(tester.widget<FilledButton>(start).onPressed, isNull);
      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: option('rig'),
          matching: find.text(kBuddyMachineOffline),
        ),
        findsOneWidget,
      );
      await close(tester, f, c);
    });

    testWidgets('an offline machine cannot be picked', (tester) async {
      final (:f, :c, :mac) = await open(tester, prepare: accountMachines);

      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      expect(tester.widget<MenuItemButton>(option('air')).onPressed, isNull);
      await tester.tap(find.text('MacBook Air').last, warnIfMissed: false);
      await tester.pumpAndSettle();
      // The tap picked nothing, so the menu is still open: close it to read the field.
      expect(find.text(kBuddyOwnMachines), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: barMachine, matching: find.text(mac)),
        findsOneWidget,
      );
      await close(tester, f, c);
    });

    testWidgets(
      'Start on this Mac prepares it and starts the Buddy with its setup, '
      'adding nothing to the Swarm',
      (tester) async {
        final (:f, :c, :mac) = await open(tester, machines: [rig()]);

        await tester.tap(start);
        await settle(tester);

        expect(sent(f), ['buddy.create m +setup']);
        expect(setupSent(f), {
          'name': f.app.stateOf('m')!.machine.displayName,
          'cwd': '/work/project',
          'engines': ['claude', 'codex'],
        });
        expect(c.buddy('lead'), isNotNull);
        // Named by the account, though no Swarm list has it.
        expect(find.textContaining('another machine'), findsNothing);
        expect(find.textContaining('on $mac'), findsWidgets);
        await close(tester, f, c);
      },
    );

    testWidgets('another own machine outside the Swarm starts the same way', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, prepare: accountMachines);

      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Studio').last);
      await tester.pumpAndSettle();
      await tester.tap(start);
      await settle(tester);

      expect(sent(f), ['buddy.create studio +setup']);
      expect(setupSent(f)!['name'], 'Studio');
      await close(tester, f, c);
    });

    testWidgets('a machine already in the Swarm starts with no setup', (
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
      expect(prepares(f), isEmpty);
      await close(tester, f, c);
    });

    testWidgets('a retry while setup is still running joins that setup', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);
      f.connection.keepPreparing = true;

      await tester.tap(start);
      await settle(tester);
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(seconds: 60));
      }
      await tester.pumpAndSettle();
      expect(find.textContaining('still running'), findsOneWidget);
      final first = prepares(f).toSet();
      expect(first, hasLength(1));

      f.connection.keepPreparing = false;
      await tester.tap(start);
      await settle(tester);

      expect(prepares(f).toSet(), first);
      expect(sent(f), ['buddy.create m +setup']);
      await close(tester, f, c);
    });

    testWidgets('a refused start shows its error and stays to try again', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);
      f.connection.server.reject = true;

      await tester.tap(start);
      await settle(tester);

      expect(c.buddy('lead'), isNull);
      expect(tester.widget<FilledButton>(start).onPressed, isNotNull);
      expect(
        find.descendant(of: barMachine, matching: find.text(mac)),
        findsOneWidget,
      );
      await close(tester, f, c);
    });

    testWidgets('a second click while it prepares sends one start', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);

      await tester.tap(start);
      await tester.pump();
      expect(tester.widget<FilledButton>(start).onPressed, isNull);
      await settle(tester);

      expect(sent(f), ['buddy.create m +setup']);
      await close(tester, f, c);
    });

    testWidgets('access revoked while it prepares starts nothing', (
      tester,
    ) async {
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
    });

    testWidgets(
      'a Mac already in the Swarm comes first by the name its person gave it, and starts with no setup',
      (tester) async {
        final (:f, :c, :mac) = await open(
          tester,
          machines: [
            rig(),
            {...rig(), 'machineId': 'm', 'name': 'Office.local'},
          ],
        );

        expect(
          find.descendant(of: barMachine, matching: find.text(mac)),
          findsOneWidget,
        );
        await tester.tap(start);
        await settle(tester);
        expect(sent(f), ['buddy.create m']);
        await close(tester, f, c);
      },
    );

    testWidgets('a Mac signed in to another account is never offered', (
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
      expect(option('m'), findsNothing);
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
      expect(tester.getSize(find.text(mac).last).width, lessThan(field));
      await close(tester, f, c);
    });
  });

  // Dee, 10-29: a teammate's Swarm Mac, where the Buddy runs in its Team
  // account and reads only its own chat (backend chatOnlyBuddy).
  group('team machines', () {
    /// Ken's Mac in the Swarm, with its Team account reporting [teamAt].
    void kensMac(SuperTabLaunchFixture f, {int? teamAt, bool team = true}) {
      final now = DateTime.now().millisecondsSinceEpoch;
      (f.connection.server.state['people'] as List).add({
        'id': 'ken',
        'email': 'ken@example.com',
        'role': 'collaborator',
      });
      (f.connection.server.state['machines'] as List).addAll([
        {
          'machineId': 'ken-studio',
          'name': 'Mac Studio',
          'contributorId': 'ken',
          'scope': 'swarm',
          'observation': {'receivedAt': now},
        },
        if (team)
          {
            'machineId': 'ken-team',
            'name': 'Mac Studio',
            'contributorId': 'ken',
            'hostMachineId': 'ken-studio',
            'scope': 'swarm',
            'observation': {'receivedAt': teamAt ?? now},
          },
      ]);
    }

    testWidgets('lists a teammate\'s Mac with a Team account under its own '
        'heading, by name with its owner, after your machines', (tester) async {
      final (:f, :c, :mac) = await open(tester, prepare: kensMac);

      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      expect(
        menuRows(tester, [
          kBuddyOwnMachines,
          mac,
          kBuddyTeamMachines,
          'Mac Studio',
        ]),
        [kBuddyOwnMachines, mac, kBuddyTeamMachines, 'Mac Studio'],
      );
      expect(
        find.descendant(
          of: option('ken-studio'),
          matching: find.byType(SuperTabAvatar),
        ),
        findsOneWidget,
      );
      // Never its Team account as a machine of its own.
      expect(option('ken-team'), findsNothing);
      await close(tester, f, c);
    });

    testWidgets('leaves out a teammate\'s Mac with no Team account, and shows '
        'one whose Team account is silent as offline', (tester) async {
      final (:f, :c, :mac) = await open(
        tester,
        prepare: (f) => kensMac(f, team: false),
      );
      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      expect(option('ken-studio'), findsNothing);
      expect(find.text(kBuddyTeamMachines), findsNothing);
      await close(tester, f, c);

      final (f: f2, c: c2, mac: _) = await open(
        tester,
        prepare: (f) => kensMac(
          f,
          teamAt: DateTime.now()
              .subtract(const Duration(minutes: 5))
              .millisecondsSinceEpoch,
        ),
      );
      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: option('ken-studio'),
          matching: find.text(kBuddyMachineOffline),
        ),
        findsOneWidget,
      );
      expect(
        tester.widget<MenuItemButton>(option('ken-studio')).onPressed,
        isNull,
      );
      await close(tester, f2, c2);
    });

    testWidgets(
      'picked, says who can read the chat there, and starts the Buddy '
      'on the Mac with no setup',
      (tester) async {
        final (:f, :c, :mac) = await open(tester, prepare: kensMac);

        expect(find.text(kBuddyTeamReaders), findsNothing);
        await tester.tap(barMachine);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Mac Studio').last);
        await tester.pumpAndSettle();
        expect(find.text(kBuddyTeamReaders), findsOneWidget);
        await tester.tap(start);
        await settle(tester);

        expect(sent(f), ['buddy.create ken-studio']);
        expect(prepares(f), isEmpty);
        await close(tester, f, c);
      },
    );
  });

  group('Add a Buddy', () {
    testWidgets('lists this Mac first and picked, under its heading alone', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(
        tester,
        machines: [rig()],
        bar: false,
        prepare: accountMachines,
      );

      expect(
        find.descendant(of: dialogMachine, matching: find.text(mac)),
        findsOneWidget,
      );
      expect(tester.widget<FilledButton>(addBuddy).onPressed, isNotNull);
      await tester.tap(dialogMachine);
      await tester.pumpAndSettle();
      expect(find.text(kBuddyOwnMachines), findsOneWidget);
      // No note: the picker has only its headings, names and state (Dee).
      expect(find.textContaining("read the chat"), findsNothing);
      expect(find.textContaining('Swarm'), findsNothing);
      await close(tester, f, c);
    });

    testWidgets('Add Buddy starts the Buddy on this Mac with its setup', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, bar: false);

      await tester.tap(addBuddy);
      await settle(tester);

      expect(sent(f), ['buddy.create m +setup']);
      expect(find.text('Add a Buddy'), findsNothing);
      await close(tester, f, c);
    });

    testWidgets('write access lost while it prepares sends nothing', (
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

      expect(sent(f), isEmpty);
      expect(find.text('This action is no longer available.'), findsOneWidget);
      expect(find.text('Adding…'), findsNothing);
      await close(tester, f, c);
    });

    testWidgets('a setup that loses write access gives the reason', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, machines: [rig()]);
      for (final person in f.connection.server.state['people'] as List) {
        if ((person as Map)['id'] == 'owner') person['role'] = 'viewer';
      }
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.canWrite, isFalse);

      final (:id, :setup, :error) = await BuddyMachineAdder(
        c,
        f.app,
      ).resolve(buddyMachines(c, app: f.app).first, alive: () => true);

      expect([id, setup, error], [null, null, kBuddyAccessLost]);
      expect(sent(f), isEmpty);
      await close(tester, f, c);
    });

    testWidgets('a refused start keeps the dialog open with its error', (
      tester,
    ) async {
      final (:f, :c, :mac) = await open(tester, bar: false);
      f.connection.server.reject = true;

      await tester.tap(addBuddy);
      await settle(tester);

      expect(find.text('Add a Buddy'), findsOneWidget);
      expect(find.byKey(const ValueKey('super-buddy-error')), findsOneWidget);
      await close(tester, f, c);
    });
  });

  group('every machine offline', () {
    Future<({SuperTabLaunchFixture f, SuperTabController c, String mac})>
    offline(WidgetTester tester, {required bool bar}) => open(
      tester,
      bar: bar,
      prepare: (f) => f.app.machineStates['m']!.nodeOnline = false,
    );

    testWidgets('the Start bar lists them, says why, and cannot start', (
      tester,
    ) async {
      final (:f, :c, :mac) = await offline(tester, bar: true);

      expect(find.text(kBuddyAllOffline), findsOneWidget);
      expect(tester.widget<FilledButton>(start).onPressed, isNull);
      await tester.tap(barMachine);
      await tester.pumpAndSettle();
      expect(find.text(mac), findsOneWidget);
      await close(tester, f, c);
    });

    testWidgets('Add a Buddy says why and cannot be submitted', (tester) async {
      final (:f, :c, :mac) = await offline(tester, bar: false);

      expect(find.text(kBuddyAllOffline), findsOneWidget);
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
        prepare: accountMachines,
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
        prepare: accountMachines,
      );
      await captureWindow(tester, shots, 'buddy-add-${brightness.name}');
      await tester.tap(dialogMachine);
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'buddy-add-menu-${brightness.name}');
      // A phone-width window (375 points): the dialog and its menu still fit.
      await tester.binding.setSurfaceSize(const Size(375, 760));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'buddy-add-375-${brightness.name}');
      await close(tester, f, c);
    });
  }
}
