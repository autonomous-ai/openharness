import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/add_computers.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/widgets/link_another_machine_dialog.dart'
    show kHarnessDownloadUrl;

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';

/// Set to a folder to write the PR's pictures there.
final shots = Platform.environment['SUPER_TAB_ADD_COMPUTERS_SHOTS'];

/// Add your computers (Dee, 10-29): the box that adds the reader's other
/// computers to a Swarm in one step.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

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

  /// This computer's row: only the name its person gave it (Dee, 10-29).
  String thisMac(SuperTabLaunchFixture f) =>
      f.app.stateOf('m')!.machine.displayName;

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
    Future<MachineResources?> Function(String id)? readResources,
    Brightness brightness = Brightness.dark,
    Size size = const Size(900, 1000),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = Brightness.dark);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showAddComputers(
                context,
                c,
                app,
                readResources: readResources ?? (_) async => null,
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
        computer(f, 'studio', 'Studio');
        computer(f, 'air', 'MacBook Air', online: false);
        computer(f, 'twin', 'Studio');
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
      // Less is better (Dee, 10-29): the title, the rows and the buttons.
      expect(find.textContaining('Teammates'), findsNothing);
      expect(find.textContaining('Not listed'), findsNothing);
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
      expect(find.text('Studio'), findsNWidgets(2));
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
        computer(f, 'studio', 'Studio');
        computer(f, 'air', 'MacBook Air', online: false);
        computer(f, 'old', 'Old iMac', needsLink: true);
        computer(f, 'rig', '2x 4090 Rig');
        f.connection.server.state['machines'] = [
          {'machineId': 'rig', 'name': '2x 4090 Rig', 'contributorId': 'owner'},
        ];
      });
      await openBox(tester, c, f.app);

      expect(box(tester, 'm').value, isTrue);
      expect(box(tester, 'studio').value, isTrue);
      // A status word only when needed: none for one that can be added.
      expect(inRow('studio', 'online'), findsNothing);
      expect(find.textContaining('This Mac'), findsNothing);
      expect(box(tester, 'air').value, isFalse);
      expect(box(tester, 'air').onChanged, isNull);
      expect(inRow('air', 'offline'), findsOneWidget);
      expect(find.byTooltip('Turn it on to add it.'), findsOneWidget);
      expect(box(tester, 'old').onChanged, isNull);
      expect(inRow('old', 'not linked'), findsOneWidget);
      expect(find.byTooltip('Link it in Machines to add it.'), findsOneWidget);
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
        computer(f, 'studio', 'Studio');
        computer(f, 'laptop', 'Laptop');
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
      expect(commands.last['name'], 'Studio');
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
        computer(f, 'studio', 'Studio');
      });
      await openBox(tester, c, f.app);
      // This Mac is first; the server refuses it, and only it.
      f.connection.server.refuseContributions['m'] =
          'This machine is no longer linked to this Swarm.';
      await tester.tap(find.text('Add 2'));
      await settle(tester);

      expect(find.text('Add your computers'), findsOneWidget);
      expect(inRow('m', 'couldn’t add'), findsOneWidget);
      expect(
        find.byTooltip('This machine is no longer linked to this Swarm.'),
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
    'Get Harness on another computer opens the download page, and a computer that signs in meanwhile shows up ticked',
    (tester) async {
      final (:f, :c) = await swarm((_) {});
      final opened = <Uri>[];
      await openBox(tester, c, f.app, openDownload: opened.add);
      await tester.tap(find.text('Get Harness on another computer'));
      await tester.pumpAndSettle();
      expect(opened, [kHarnessDownloadUrl]);
      expect(find.text('Add 1'), findsOneWidget);

      computer(f, 'studio', 'Studio');
      // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
      f.app.notifyListeners();
      await tester.pumpAndSettle();
      expect(box(tester, 'studio').value, isTrue);
      expect(find.text('Add 2'), findsOneWidget);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'where the Swarm has no Team accounts nothing is marked Team account only',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        f.connection.server.state['teamAccounts'] = false;
      });
      await openBox(tester, c, f.app);
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
        computer(f, 'studio', 'Studio');
        computer(f, 'air', 'MacBook Air');
        f.connection.server.state['machines'] = [
          {
            'machineId': 'studio',
            'name': 'Studio',
            'contributorId': 'owner',
            'teamWork': {'allowed': false, 'code': 'TEAM_ACCOUNT_REQUIRED'},
          },
          {
            'machineId': 'air',
            'name': 'MacBook Air',
            'contributorId': 'owner',
            'teamWork': {'allowed': false, 'code': 'PRIVACY_CHECK_FAILED'},
          },
        ];
      });
      await openBox(tester, c, f.app);
      // A word or two on the row, the whole reason on hover.
      expect(inRow('studio', 'added · not set up'), findsOneWidget);
      expect(
        find.byTooltip('No Team account yet, so only your projects run here.'),
        findsOneWidget,
      );
      expect(inRow('air', 'added · check failed'), findsOneWidget);
      expect(
        find.byTooltip(
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
      expect(inRow('m', 'added · setup failed'), findsOneWidget);
      expect(
        find.byTooltip(
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
        computer(f, 'studio', 'Studio');
      });
      await openBox(tester, c, f.app);
      final people = f.connection.server.state['people'] as List;
      (people.first as Map)['role'] = 'viewer';
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Add your computers'), findsNothing);
      expect(find.text('Studio'), findsNothing);
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
          computer(f, 'studio', 'Studio');
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
        computer(f, 'studio', 'Studio');
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

  testWidgets(
    'a Mac\'s Harness Team account in the Swarm is part of its Mac\'s row, never one of its own',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        computer(f, 'm-team', 'This Mac · Team');
        f.connection.server.state['machines'] = [
          {'machineId': 'm', 'contributorId': 'owner'},
          {
            'machineId': 'm-team',
            'contributorId': 'owner',
            'hostMachineId': 'm',
          },
        ];
      });
      await openBox(tester, c, f.app);
      expect(row('m'), findsOneWidget);
      expect(inRow('m', 'added'), findsOneWidget);
      expect(row('m-team'), findsNothing);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'a Lead running on this Mac does not make it added: only the Swarm\'s Machines list does',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        f.connection.server.state['agents'] = [
          {
            'id': 'lead-agent',
            'name': 'Lead',
            'machineId': 'm',
            'harnessId': 'native-lead',
            'contributorId': 'owner',
            'configuration': {'engine': 'codex'},
          },
        ];
      });
      await openBox(tester, c, f.app);
      expect(box(tester, 'm').value, isTrue);
      expect(inRow('m', 'added'), findsNothing);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'a computer that goes offline while the box is open is unticked and not added',
    (tester) async {
      final (:f, :c) = await swarm((f) {
        computer(f, 'studio', 'Studio');
      });
      await openBox(tester, c, f.app);
      expect(find.text('Add 2'), findsOneWidget);
      f.app.machineStates['studio']!.nodeOnline = false;
      // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
      f.app.notifyListeners();
      await tester.pumpAndSettle();
      expect(box(tester, 'studio').value, isFalse);
      expect(box(tester, 'studio').onChanged, isNull);
      await tester.tap(find.text('Add 1'));
      await settle(tester);
      expect(added(f), ['m']);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'each computer is added with the agent count its own memory suggests',
    (tester) async {
      final (:f, :c) = await swarm((_) {});
      // 16 GiB total suggests four agents, whatever is free.
      await openBox(
        tester,
        c,
        f.app,
        readResources: (_) async => const MachineResources(
          memoryTotalBytes: 16 * 1024 * 1024 * 1024,
          memoryUsedBytes: 8 * 1024 * 1024 * 1024,
        ),
      );
      await tester.tap(find.text('Add 1'));
      await settle(tester);
      expect(
        (f.connection.server.posts.single['command'] as Map)['maxAgents'],
        4,
      );
      await close(tester, f, c);
    },
  );

  testWidgets(
    'a reply lost after the server added the computer: the box finds it in the Swarm, with no error and no second add',
    (tester) async {
      final (:f, :c) = await swarm((_) {});
      await openBox(tester, c, f.app);
      f.connection.server.loseReply = true;
      await tester.tap(find.text('Add 1'));
      await settle(tester);
      expect(find.text('couldn’t add'), findsNothing);
      expect(find.text('Add your computers'), findsNothing);
      // The lost add is settled through the controller, under its own
      // receipt: nothing is left pending to block what comes next.
      expect(c.hasPendingAction, isFalse);
      expect(
        f.connection.server.posts.map((p) => p['operationId']).toSet(),
        hasLength(1),
      );
      final conversationId = c.snapshot!.conversations.first.id;
      final later = await c.command({
        'type': 'message.send',
        'conversationId': conversationId,
        'text': 'Added my Mac.',
      });
      expect(later, isNotNull);
      expect(c.hasPendingAction, isFalse);
      expect(
        (f.connection.server.state['machines'] as List).where(
          (m) => (m as Map)['machineId'] == 'm',
        ),
        hasLength(1),
      );
      await close(tester, f, c);
    },
  );

  testWidgets('a tick moves with Tab and Space, and each row says its name', (
    tester,
  ) async {
    final (:f, :c) = await swarm((f) {
      computer(f, 'studio', 'Studio');
    });
    await openBox(tester, c, f.app);
    final handle = tester.ensureSemantics();
    expect(
      tester.getSemantics(
        find.descendant(of: row('studio'), matching: find.byType(Checkbox)),
      ),
      matchesSemantics(
        label: 'Studio',
        isChecked: true,
        hasCheckedState: true,
        isEnabled: true,
        hasEnabledState: true,
        isFocusable: true,
        hasTapAction: true,
        hasFocusAction: true,
      ),
    );
    handle.dispose();
    for (var i = 0; i < 6; i++) {
      final focused = FocusManager.instance.primaryFocus?.context?.widget;
      final inStudio =
          FocusManager.instance.primaryFocus?.context != null &&
          find
              .descendant(of: row('studio'), matching: find.byType(Checkbox))
              .evaluate()
              .any(
                (e) =>
                    FocusManager.instance.primaryFocus!.context!
                        .findAncestorWidgetOfExactType<Checkbox>() ==
                    e.widget,
              );
      if (inStudio || focused == null) break;
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pumpAndSettle();
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pumpAndSettle();
    expect(box(tester, 'studio').value, isFalse);
    expect(find.text('Add 1'), findsOneWidget);
    await close(tester, f, c);
  });

  for (final brightness in Brightness.values) {
    testWidgets('long names and notes fit at 2x text in ${brightness.name}', (
      tester,
    ) async {
      final (:f, :c) = await swarm((f) {
        computer(
          f,
          'studio',
          'Design Studio’s MacBook Pro with a long custom machine name',
        );
        computer(
          f,
          'air',
          'autonomous-code-vm-01.c.autonomous-code.internal',
          online: false,
        );
        computer(f, 'rig', '2x 4090 Rig');
        f.connection.server.state['machines'] = [
          {
            'machineId': 'rig',
            'contributorId': 'owner',
            'teamWork': {'allowed': false, 'code': 'PRIVACY_CHECK_STALE'},
          },
        ];
      });
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await openBox(
        tester,
        c,
        f.app,
        brightness: brightness,
        size: const Size(700, 900),
      );
      expect(find.text('Add your computers'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await close(tester, f, c);
    });
  }

  // The PR's pictures, light and dark, over in-memory Swarms only: the first
  // box with this Mac not added, several computers, all added, offline rows,
  // Team account setup failed, Dee's Swarm with six computers, and a row
  // that could not be added.
  Map<String, dynamic> pool(String id, String name, [String? teamCode]) => {
    'machineId': id,
    'name': name,
    'contributorId': 'owner',
    if (teamCode != null) 'teamWork': {'allowed': false, 'code': teamCode},
  };
  final scenes = <(String, void Function(SuperTabLaunchFixture f))>[
    (
      '1-first-this-mac-not-added',
      (f) {
        computer(f, 'studio', 'Studio');
      },
    ),
    (
      '2-several-computers',
      (f) {
        computer(f, 'studio', 'Studio');
        computer(f, 'mini', 'Mac mini');
        computer(f, 'air', 'MacBook Air', online: false);
        computer(f, 'rig', '2x 4090 Rig');
        f.connection.server.state['machines'] = [
          pool('m', 'tropic'),
          pool('rig', '2x 4090 Rig'),
        ];
      },
    ),
    (
      '3-all-added',
      (f) {
        computer(f, 'studio', 'Studio');
        computer(f, 'rig', '2x 4090 Rig');
        f.connection.server.state['machines'] = [
          pool('m', 'tropic'),
          pool('studio', 'Studio'),
          pool('rig', '2x 4090 Rig'),
        ];
      },
    ),
    (
      '4-offline-rows',
      (f) {
        computer(f, 'air', 'MacBook Air', online: false);
        computer(f, 'old', 'Old iMac', needsLink: true);
        f.connection.server.state['machines'] = [pool('m', 'tropic')];
      },
    ),
    (
      '5-team-account-setup-failed',
      (f) {
        f.app.teamAccountHereForTest = true;
        f.connection.teamSetup = {
          'state': 'failed',
          'detail': 'dscl exited 64',
        };
        computer(f, 'studio', 'Studio');
        computer(f, 'mini', 'Mac mini');
        f.connection.server.state['machines'] = [
          pool('m', 'tropic', 'TEAM_ACCOUNT_REQUIRED'),
          pool('studio', 'Studio', 'PRIVACY_CHECK_FAILED'),
        ];
      },
    ),
    (
      '6-dee-swarm-six-computers',
      (f) {
        computer(f, 'studio', 'Studio');
        computer(f, 'air', 'MacBook Air', online: false);
        computer(f, 'rig', '2x 4090 Rig');
        computer(f, 'mini', 'Mac mini');
        computer(f, 'ubuntu', 'ubuntu-desk');
        f.connection.server.state['machines'] = [
          pool('m', 'tropic'),
          pool('rig', '2x 4090 Rig'),
          pool('mini', 'Mac mini', 'TEAM_ACCOUNT_REQUIRED'),
        ];
      },
    ),
  ];
  for (final brightness in Brightness.values) {
    for (final (name, arrange) in scenes) {
      testWidgets('picture $name (${brightness.name})', (tester) async {
        debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
        final (:f, :c) = await swarm((f) {
          f.app.machineStates['m']!.machine = f.app.machineStates['m']!.machine
              .copyWith(name: 'tropic');
          arrange(f);
        });
        await openBox(
          tester,
          c,
          f.app,
          brightness: brightness,
          size: const Size(720, 760),
        );
        await captureWindow(tester, shots, '$name-${brightness.name}');
        await close(tester, f, c);
        debugDefaultTargetPlatformOverride = null;
      }, skip: shots == null);
    }
    testWidgets('picture 7-a-row-could-not-be-added (${brightness.name})', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      final (:f, :c) = await swarm((f) {
        f.app.machineStates['m']!.machine = f.app.machineStates['m']!.machine
            .copyWith(name: 'tropic');
        computer(f, 'studio', 'Studio');
        computer(f, 'rig', '2x 4090 Rig');
        f.connection.server.refuseContributions['studio'] =
            'Install Claude Code or Codex on this machine, then try again.';
      });
      await openBox(
        tester,
        c,
        f.app,
        brightness: brightness,
        size: const Size(720, 760),
      );
      await tester.tap(find.text('Add 3'));
      await settle(tester);
      await captureWindow(
        tester,
        shots,
        '7-a-row-could-not-be-added-${brightness.name}',
      );
      await close(tester, f, c);
      debugDefaultTargetPlatformOverride = null;
    }, skip: shots == null);
  }
}
