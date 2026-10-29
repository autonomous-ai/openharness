import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/model_search_catalog.dart' show thisComputerName;
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/add_computers.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/widgets/link_another_machine_dialog.dart'
    show kHarnessDownloadUrl;

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// Add your computers (Dee, 10-29): the box that adds the reader's other
/// computers to a Swarm in one step.
void main() {
  const separate =
      "Teammates' agents use them when they're free, in a separate account "
      "that can't see your files.";
  const signedInAsYou =
      "Teammates' agents use them when they're free, signed in as you.";

  /// One of the reader's own computers, as the app lists it.
  void computer(
    SuperTabLaunchFixture f,
    String id,
    String name, {
    bool online = true,
    bool needsLink = false,
    bool shared = false,
    String? sessionKind,
  }) {
    final machine = Machine(
      machineId: id,
      authMode: MachineAuthMode.remote,
      name: name,
      isShared: shared,
      sessionKind: sessionKind,
    );
    f.app.machines = [...f.app.machines, machine];
    f.app.machineStates[id] = MachineState(machine)
      ..nodeOnline = online
      ..needsLink = needsLink
      ..connectionStatus = online
          ? ConnectionStatus.connected
          : ConnectionStatus.disconnected;
  }

  /// This computer's row, named as on its system: This Mac on a Mac.
  String thisMac(SuperTabLaunchFixture f) {
    final label = thisComputerName();
    return '${label[0].toUpperCase()}${label.substring(1)} · '
        '${f.app.stateOf('m')!.machine.displayName}';
  }

  Future<({SuperTabLaunchFixture f, SuperTabController c})> swarm(
    void Function(SuperTabLaunchFixture f) arrange,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.server.state['project'] = {
      'machineId': 'm',
      'cwd': '/work/project',
      'scope': 'swarm',
      'repositoryUrl': null,
    };
    arrange(f);
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    return (f: f, c: c);
  }

  Future<void> openBox(
    WidgetTester tester,
    SuperTabController c,
    AppNotifier app, {
    void Function(Uri url)? openDownload,
  }) async {
    await tester.binding.setSurfaceSize(const Size(900, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showAddComputers(
                context,
                c,
                app,
                readResources: (_) async => null,
                openDownload: openDownload,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  /// The preparation polls wait a second between asks.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
    }
  }

  Future<void> close(
    WidgetTester tester,
    SuperTabLaunchFixture f,
    SuperTabController c,
  ) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  }

  Finder row(String id) => find.byKey(ValueKey('add-computer-$id'));
  Checkbox box(WidgetTester tester, String id) => tester.widget<Checkbox>(
    find.descendant(of: row(id), matching: find.byType(Checkbox)),
  );
  FilledButton addButton(WidgetTester tester) =>
      tester.widget<FilledButton>(find.byKey(const ValueKey('add-computers')));
  Finder inRow(String id, String text) =>
      find.descendant(of: row(id), matching: find.text(text));

  /// The machine of each command posted, in order.
  List<Object?> added(SuperTabLaunchFixture f) => [
    for (final post in f.connection.server.posts)
      if ((post['command'] as Map)['type'] == 'machine.contribute')
        (post['command'] as Map)['machineId'],
  ];

  testWidgets(
    'rows are only the reader\'s own computers, this Mac first while it is not added',
    (tester) async {
      final s = await swarm((f) {
        computer(f, 'studio', 'Studio · dee');
        computer(f, 'air', 'MacBook Air · dee', online: false);
        computer(f, 'twin', 'Studio · dee');
        computer(f, 'rig', '2x 4090 Rig');
        computer(f, 'old', 'Old iMac', needsLink: true);
        // Another account's harness and whole computer, and a Mac's Harness
        // Team account: never rows of their own.
        computer(f, 'theirs', 'Diego’s harness', shared: true);
        computer(f, 'team', 'Studio · Team', sessionKind: 'team');
        f.connection.server.state['machines'] = [
          {'machineId': 'rig', 'name': '2x 4090 Rig', 'contributorId': 'owner'},
          // A teammate's machine in the Swarm is theirs to add, not a row.
          {
            'machineId': 'tony-mac',
            'name': 'Tony Mac',
            'contributorId': 'tony',
          },
        ];
      });
      final (:f, :c) = s;
      await openBox(tester, c, f.app);

      expect(find.text('Add your computers'), findsOneWidget);
      expect(find.text(separate), findsOneWidget);
      final rows = tester
          .widgetList<KeyedSubtree>(
            find.byWidgetPredicate(
              (w) =>
                  w is KeyedSubtree &&
                  w.key is ValueKey<String> &&
                  (w.key! as ValueKey<String>).value.startsWith(
                    'add-computer-',
                  ),
            ),
          )
          .map((w) => (w.key! as ValueKey<String>).value.substring(13))
          .toList();
      // This Mac first; then the online ones, the ones that cannot be added
      // yet, and those already added. Two computers of one name are two rows.
      expect(rows, ['m', 'studio', 'twin', 'air', 'old', 'rig']);
      expect(inRow('m', thisMac(f)), findsOneWidget);
      expect(find.text('Studio · dee'), findsNWidgets(2));
      expect(find.textContaining('Diego'), findsNothing);
      expect(find.text('Studio · Team'), findsNothing);
      expect(row('team'), findsNothing);
      expect(find.text('Tony Mac'), findsNothing);
      expect(tester.takeException(), isNull);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'online computers come ticked; offline, unlinked and added ones cannot be ticked',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        computer(f, 'studio', 'Studio · dee');
        computer(f, 'air', 'MacBook Air · dee', online: false);
        computer(f, 'old', 'Old iMac', needsLink: true);
        computer(f, 'rig', '2x 4090 Rig');
        f.connection.server.state['machines'] = [
          {'machineId': 'rig', 'name': '2x 4090 Rig', 'contributorId': 'owner'},
        ];
      });
      await openBox(tester, c, f.app);

      expect(box(tester, 'm').value, isTrue);
      expect(box(tester, 'studio').value, isTrue);
      expect(inRow('studio', 'online'), findsOneWidget);
      expect(box(tester, 'air').value, isFalse);
      expect(box(tester, 'air').onChanged, isNull);
      expect(inRow('air', 'offline · turn it on to add'), findsOneWidget);
      expect(box(tester, 'old').onChanged, isNull);
      expect(inRow('old', 'not linked · link it in Machines'), findsOneWidget);
      expect(
        find.descendant(of: row('rig'), matching: find.byType(Checkbox)),
        findsNothing,
      );
      expect(inRow('rig', 'added'), findsOneWidget);
      expect(find.text('Add 2'), findsOneWidget);

      await tester.tap(row('studio'));
      await tester.pumpAndSettle();
      expect(box(tester, 'studio').value, isFalse);
      expect(find.text('Add 1'), findsOneWidget);
      await tester.tap(row('air'));
      await tester.pumpAndSettle();
      expect(box(tester, 'air').value, isFalse);
      expect(f.connection.server.posts, isEmpty);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'Add N adds exactly the ticked computers, one at a time, with today\'s defaults and the Team account rule',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        computer(f, 'studio', 'Studio · dee');
        computer(f, 'laptop', 'Laptop · dee');
      });
      await openBox(tester, c, f.app);
      await tester.tap(row('laptop'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add 2'));
      await settle(tester);

      expect(added(f), ['m', 'studio']);
      final commands = [
        for (final post in f.connection.server.posts) post['command'] as Map,
      ];
      expect(commands.first, {
        'type': 'machine.contribute',
        'machineId': 'm',
        'name': f.app.stateOf('m')!.machine.displayName,
        'cwd': '/work/project',
        'scope': 'swarm',
        'engines': ['claude', 'codex'],
        'maxAgents': 8,
        'teamAccountOnly': true,
      });
      expect(commands.last['name'], 'Studio · dee');
      expect(commands.last['teamAccountOnly'], isTrue);
      // One at a time: the second computer's setup starts only after the first
      // one was added.
      final steps = [
        for (final call in f.connection.calls)
          if (call.$1 == 'super_tabs' &&
              call.$2['action'] == 'prepareContribution')
            'prepare:${call.$2['operationId']}'
          else if (call.$1 == 'super_tabs' && call.$2['method'] == 'POST')
            'add',
      ];
      final firstAdd = steps.indexOf('add');
      final setups = steps.where((s) => s != 'add').toSet().toList();
      expect(setups, hasLength(2));
      expect(steps.indexOf(setups.last), greaterThan(firstAdd));
      // All added: the box is done.
      expect(find.text('Add your computers'), findsNothing);
      expect(tester.takeException(), isNull);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'a computer that fails keeps its reason and its tick, and the others are still added',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        computer(f, 'studio', 'Studio · dee');
      });
      await openBox(tester, c, f.app);
      // This Mac is first; the server refuses it, and only it.
      f.connection.server.refuseContributions['m'] =
          'This machine is no longer linked to this Swarm.';
      await tester.tap(find.text('Add 2'));
      await settle(tester);

      expect(find.text('Add your computers'), findsOneWidget);
      expect(
        inRow(
          'm',
          'Couldn’t add: This machine is no longer linked to this Swarm.',
        ),
        findsOneWidget,
      );
      expect(inRow('studio', 'added'), findsOneWidget);
      expect(box(tester, 'm').value, isTrue);
      expect(find.text('Add 1'), findsOneWidget);
      expect(addButton(tester).onPressed, isNotNull);

      // Trying again adds the one left, and the box closes.
      f.connection.server.refuseContributions.clear();
      await tester.tap(find.text('Add 1'));
      await settle(tester);
      expect(added(f).where((id) => id == 'studio'), hasLength(1));
      expect(added(f).last, 'm');
      expect(find.text('Add your computers'), findsNothing);
      expect(tester.takeException(), isNull);
      await close(tester, f, c);
    },
  );

  testWidgets('no folder, agent count or product manager text in the box', (
    tester,
  ) async {
    final (:f, :c) = await swarm((_) {});
    await openBox(tester, c, f.app);
    expect(find.text('Add your computers'), findsOneWidget);
    expect(find.textContaining('product manager'), findsNothing);
    expect(find.textContaining('~/harnesses'), findsNothing);
    expect(find.textContaining('folder'), findsNothing);
    expect(find.textContaining('Agent slots'), findsNothing);
    expect(find.text('Agents'), findsNothing);
    expect(find.byType(TextField), findsNothing);
    await close(tester, f, c);
  });

  testWidgets(
    'Not listed? Get Harness opens the download page, and a computer that signs in meanwhile shows up ticked',
    (tester) async {
      final (:f, :c) = await swarm((_) {});
      final opened = <Uri>[];
      await openBox(tester, c, f.app, openDownload: opened.add);
      expect(
        find.text(
          'Not listed? Install Harness on it and sign in as you. '
          'It shows up here.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Get Harness'));
      await tester.pumpAndSettle();
      expect(opened, [kHarnessDownloadUrl]);
      expect(find.text('Add 1'), findsOneWidget);

      computer(f, 'studio', 'Studio · dee');
      // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
      f.app.notifyListeners();
      await tester.pumpAndSettle();
      expect(box(tester, 'studio').value, isTrue);
      expect(find.text('Add 2'), findsOneWidget);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'where the Swarm has no Team accounts the line says so, and nothing is marked Team account only',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        f.connection.server.state['teamAccounts'] = false;
      });
      await openBox(tester, c, f.app);
      expect(find.text(signedInAsYou), findsOneWidget);
      expect(find.text(separate), findsNothing);
      await tester.tap(find.text('Add 1'));
      await settle(tester);
      final command = f.connection.server.posts.single['command'] as Map;
      expect(command.containsKey('teamAccountOnly'), isFalse);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'an added computer without a working Team account says only your projects run there',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        computer(f, 'studio', 'Studio · dee');
        computer(f, 'air', 'MacBook Air · dee');
        f.connection.server.state['machines'] = [
          {
            'machineId': 'studio',
            'name': 'Studio · dee',
            'contributorId': 'owner',
            'teamWork': {'allowed': false, 'code': 'TEAM_ACCOUNT_REQUIRED'},
          },
          {
            'machineId': 'air',
            'name': 'MacBook Air · dee',
            'contributorId': 'owner',
            'teamWork': {'allowed': false, 'code': 'PRIVACY_CHECK_FAILED'},
          },
        ];
      });
      await openBox(tester, c, f.app);
      expect(
        inRow('studio', 'No Team account yet, so only your projects run here.'),
        findsOneWidget,
      );
      expect(
        inRow(
          'air',
          'Its Team account failed the privacy check, so only your projects run here.',
        ),
        findsOneWidget,
      );
      await close(tester, f, c);
    },
  );

  testWidgets(
    'this Mac\'s failed Team account setup is said in plain words on its row',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        f.app.teamAccountHereForTest = true;
        f.connection.teamSetup = {
          'state': 'failed',
          'detail': 'dscl exited 64',
        };
        f.connection.server.state['machines'] = [
          {
            'machineId': 'm',
            'name': f.app.stateOf('m')!.machine.displayName,
            'contributorId': 'owner',
            'teamWork': {'allowed': false, 'code': 'TEAM_ACCOUNT_REQUIRED'},
          },
        ];
      });
      await openBox(tester, c, f.app);
      expect(
        inRow(
          'm',
          'Team account setup failed, so only your projects run here.',
        ),
        findsOneWidget,
      );
      expect(find.textContaining('dscl'), findsNothing);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'losing write access while the box is open takes its rows away and says why',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        computer(f, 'studio', 'Studio · dee');
      });
      await openBox(tester, c, f.app);
      final people = f.connection.server.state['people'] as List;
      (people.first as Map)['role'] = 'viewer';
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Add your computers'), findsNothing);
      expect(find.text('Studio · dee'), findsNothing);
      expect(find.text('This action is no longer available.'), findsOneWidget);
      expect(f.connection.server.posts, isEmpty);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'access removed or another account signed in: the box closes and adds nothing',
    (tester) async {
      for (final change in ['revoked', 'account']) {
        final (:f, :c) = await swarm((f) {
          computer(f, 'studio', 'Studio · dee');
        });
        await openBox(tester, c, f.app);
        // The first computer's setup is still running when access changes.
        f.connection.keepPreparing = true;
        await tester.tap(find.text('Add 2'));
        await tester.pump();
        if (change == 'revoked') {
          c.revokeAccess('Access removed.');
        } else {
          f.app.currentUser = const CurrentUserProfile(
            id: 'different',
            email: 'different@example.com',
          );
          // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
          f.app.notifyListeners();
        }
        await settle(tester);
        expect(find.text('Add your computers'), findsNothing, reason: change);
        expect(f.connection.server.posts, isEmpty, reason: change);
        await close(tester, f, c);
      }
    },
  );

  testWidgets(
    'closing the box while a computer is being set up adds nothing more',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        computer(f, 'studio', 'Studio · dee');
      });
      await openBox(tester, c, f.app);
      f.connection.keepPreparing = true;
      await tester.tap(find.text('Add 2'));
      await tester.pump();
      expect(find.text('Adding…'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      f.connection.keepPreparing = false;
      await settle(tester);
      expect(f.connection.server.posts, isEmpty);
      await close(tester, f, c);
    },
  );

  testWidgets('Machines + opens Add your computers', (tester) async {
    final (:f, :c) = await swarm((_) {});
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 300,
            height: 400,
            child: SuperTabMachines(
              controller: c,
              app: f.app,
              onAddAgent: (_) {},
              readLocal: (_) async => null,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Add machine'));
    await tester.pumpAndSettle();
    expect(find.text('Add your computers'), findsOneWidget);
    expect(find.byKey(const ValueKey('add-computer-m')), findsOneWidget);
    await close(tester, f, c);
  });
}
