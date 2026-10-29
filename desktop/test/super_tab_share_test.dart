// Sharing your computers with a Swarm (Dee, 2026-10-29): the first-time "Share this Mac", the checklist for someone
// with several computers, the computer that isn't listed yet, and the Shared switch and quiet lines in Machines.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/detail_dialog.dart';
import 'package:harness/super_tabs/identity.dart' show superTabMachineName;
import 'package:harness/super_tabs/machines.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// A fixture whose Mac can make its Harness Team account, as a real Mac can.
SuperTabLaunchFixture _fixture() {
  final f = SuperTabLaunchFixture();
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
  f.app.macOSForTest = true;
  f.connection.server.state['project'] = {
    'machineId': 'm',
    'cwd': '/work/project',
    'scope': 'swarm',
    'repositoryUrl': null,
  };
  return f;
}

/// The person's own other computer, [online] or not.
void _addComputer(
  SuperTabLaunchFixture f,
  String id,
  String name, {
  bool online = true,
  bool linked = true,
}) {
  final machine = Machine(
    machineId: id,
    authMode: MachineAuthMode.remote,
    name: name,
  );
  f.app.machines = [...f.app.machines, machine];
  f.app.machineStates[id] = MachineState(machine)
    ..nodeOnline = online
    ..needsLink = !linked
    ..connectionStatus = online
        ? ConnectionStatus.connected
        : ConnectionStatus.disconnected
    ..agentLoadStatus = AgentLoadStatus.loaded;
}

/// What the machine's own Claude Code and Codex are signed in to.
void _signedIn(
  SuperTabLaunchFixture f,
  String id, {
  bool claude = false,
  bool codex = false,
}) {
  f.app.machineStates[id]!.engines.replace([
    EngineAvailability(engine: 'claude', installed: true, signedIn: claude),
    EngineAvailability(engine: 'codex', installed: true, signedIn: codex),
  ]);
}

Future<dynamic> _mount(WidgetTester tester, SuperTabLaunchFixture f) async {
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 320,
          height: 500,
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
  return c;
}

Future<void> _openShare(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Add machine'));
  await tester.pumpAndSettle();
}

/// Preparation answers `preparing` first and is ready a second later, as the daemon does.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
  }
}

Future<void> _done(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  dynamic c,
) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  f.app.superTabs.dispose();
  await tester.pump();
}

List<Map<String, dynamic>> _contributions(SuperTabLaunchFixture f) => [
  for (final post in f.connection.server.posts)
    if (post['command']?['type'] == 'machine.contribute')
      Map<String, dynamic>.from(post['command'] as Map),
];

Iterable<Map<String, dynamic>> _calls(SuperTabLaunchFixture f, String action) =>
    f.connection.calls
        .where((call) => call.$1 == 'super_tabs' && call.$2['action'] == action)
        .map((call) => call.$2);

const _promise =
    'When it’s free, your teammates’ agents can work here. They run in a separate account on this Mac '
    'and can’t see your files, mail or logins.';

void main() {
  group('first time, with this Mac alone', () {
    testWidgets(
      'asks to share this Mac, says what it means, and starts nothing until Share',
      (tester) async {
        final f = _fixture();
        _signedIn(f, 'm', claude: true);
        final c = await _mount(tester, f);
        await _openShare(tester);

        expect(find.text('Share this Mac with your team?'), findsOneWidget);
        expect(find.text(_promise), findsOneWidget);
        // Sharing a paid subscription is a visible choice, never a side effect (Lead, 2026-10-29).
        expect(
          find.text('Their agents use your Claude subscription on this Mac.'),
          findsOneWidget,
        );
        expect(
          find.text('macOS will ask for your password once.'),
          findsOneWidget,
        );
        expect(find.widgetWithText(TextButton, 'Not now'), findsOneWidget);
        expect(
          find.widgetWithText(FilledButton, 'Share this Mac'),
          findsOneWidget,
        );
        // No slots anywhere: the limit is in the machine's settings.
        expect(find.byKey(const ValueKey('agent-limit-value')), findsNothing);
        expect(_calls(f, 'prepareContribution'), isEmpty);
        expect(_calls(f, 'teamSetup'), isEmpty);
        await _done(tester, f, c);
      },
    );

    testWidgets(
      'names both subscriptions when both are signed in, and none when neither is',
      (tester) async {
        final f = _fixture();
        _signedIn(f, 'm', claude: true, codex: true);
        var c = await _mount(tester, f);
        await _openShare(tester);
        expect(
          find.text(
            'Their agents use your Claude and Codex subscriptions on this Mac.',
          ),
          findsOneWidget,
        );
        await _done(tester, f, c);

        final g = _fixture();
        _signedIn(g, 'm');
        c = await _mount(tester, g);
        await _openShare(tester);
        expect(find.textContaining('subscription'), findsNothing);
        await _done(tester, g, c);
      },
    );

    testWidgets(
      'Share this Mac adds it as memory allows, sets up its Team account, then confirms',
      (tester) async {
        final f = _fixture();
        final c = await _mount(tester, f);
        await _openShare(tester);
        await tester.tap(find.widgetWithText(FilledButton, 'Share this Mac'));
        await _settle(tester);

        expect(_contributions(f).single, {
          'type': 'machine.contribute',
          'machineId': 'm',
          'name': f.app.stateOf('m')!.machine.displayName,
          'cwd': '/work/project',
          'scope': 'swarm',
          // Installed engines only, of the two a Swarm runs.
          'engines': ['claude', 'codex'],
          // As many as memory allows: setup's own maximum.
          'maxAgents': 16,
        });
        expect(_calls(f, 'teamSetup').single, {
          'action': 'teamSetup',
          'reason': 'manual',
        });
        expect(
          find.text('This Mac is shared. You can stop anytime in Machines.'),
          findsOneWidget,
        );
        expect(find.textContaining('osascript'), findsOneWidget);
        await tester.tap(find.widgetWithText(FilledButton, 'Done'));
        await tester.pumpAndSettle();
        expect(find.byType(SuperTabDetailDialog), findsNothing);
        expect(tester.takeException(), isNull);
        await _done(tester, f, c);
      },
    );

    testWidgets(
      'Not now shares nothing and leaves an empty Swarm a way to share later',
      (tester) async {
        final f = _fixture();
        final c = await _mount(tester, f);
        expect(
          find.text(
            'No computers yet. Share this Mac so your team’s agents can run.',
          ),
          findsOneWidget,
        );
        await _openShare(tester);
        await tester.tap(find.widgetWithText(TextButton, 'Not now'));
        await tester.pumpAndSettle();
        expect(find.byType(SuperTabDetailDialog), findsNothing);
        expect(f.connection.server.posts, isEmpty);
        expect(_calls(f, 'teamSetup'), isEmpty);

        // The empty Swarm's own Share asks again, the same way.
        await tester.tap(find.widgetWithText(TextButton, 'Share'));
        await tester.pumpAndSettle();
        expect(find.text('Share this Mac with your team?'), findsOneWidget);
        await _done(tester, f, c);
      },
    );

    testWidgets(
      'with other machines in the Swarm, this Mac is a quiet row with Share',
      (tester) async {
        final f = _fixture();
        f.connection.server.state['machines'] = [
          {
            'machineId': 'studio',
            'name': 'Studio',
            'contributorId': 'teammate',
          },
        ];
        final c = await _mount(tester, f);
        expect(find.text('This Mac · not shared'), findsOneWidget);
        await tester.tap(find.widgetWithText(TextButton, 'Share'));
        await tester.pumpAndSettle();
        expect(find.text('Share this Mac with your team?'), findsOneWidget);
        await _done(tester, f, c);
      },
    );

    testWidgets('an unconfirmed share is checked first, then finished', (
      tester,
    ) async {
      final f = _fixture();
      final c = await _mount(tester, f);
      await _openShare(tester);
      f.connection.server.loseReply = true;
      await tester.tap(find.widgetWithText(FilledButton, 'Share this Mac'));
      await _settle(tester);
      expect(find.text('Share this Mac with your team?'), findsOneWidget);
      expect(_contributions(f), hasLength(1));
      expect(_calls(f, 'teamSetup'), isEmpty);

      await tester.tap(find.widgetWithText(FilledButton, 'Share this Mac'));
      await _settle(tester);
      // The same attempt again, confirmed, and then the Team account.
      expect(_contributions(f), hasLength(2));
      expect(_contributions(f).last, _contributions(f).first);
      expect(_calls(f, 'teamSetup'), hasLength(1));
      expect(
        find.text('This Mac is shared. You can stop anytime in Machines.'),
        findsOneWidget,
      );
      await _done(tester, f, c);
    });
  });

  testWidgets(
    'a check of an earlier attempt that fails says why that attempt is unclear',
    (tester) async {
      final f = _fixture();
      final c = await _mount(tester, f);
      await _openShare(tester);
      f.connection.server.loseReply = true;
      await tester.tap(find.widgetWithText(FilledButton, 'Share this Mac'));
      await _settle(tester);
      f.connection.server.refuse = {
        'code': 'MACHINE_NOT_FOUND',
        'message': 'This machine is no longer linked to this Swarm.',
      };
      await tester.tap(find.widgetWithText(FilledButton, 'Share this Mac'));
      await _settle(tester);
      expect(
        find.text('This machine is no longer linked to this Swarm.'),
        findsOneWidget,
      );
      // The check re-sent the attempt it was holding, untouched, and nothing new followed it.
      expect(_contributions(f), hasLength(2));
      expect(_contributions(f).last, _contributions(f).first);
      expect(_calls(f, 'teamSetup'), isEmpty);
      await _done(tester, f, c);
    },
  );

  testWidgets('a Mac running the lead but not shared yet is still offered', (
    tester,
  ) async {
    final f = _fixture();
    f.connection.server.state['agents'] = [
      {
        'id': 'lead-agent',
        'name': 'Lead',
        'machineId': 'm',
        'harnessId': 'h-lead',
        'contributorId': 'owner',
        'machineOwnerId': 'owner',
        'configuration': <String, dynamic>{'engine': 'claude'},
      },
    ];
    final c = await _mount(tester, f);
    await _openShare(tester);
    expect(find.text('Share this Mac with your team?'), findsOneWidget);
    await _done(tester, f, c);
  });

  group('two or more computers', () {
    testWidgets(
      'lists your computers ticked, this Mac first, offline and unlinked ones unticked with why',
      (tester) async {
        final f = _fixture();
        _addComputer(f, 'm2', 'Studio');
        _addComputer(f, 'm3', 'Old laptop', online: false);
        _addComputer(f, 'm4', 'Lab box', linked: false);
        _signedIn(f, 'm', claude: true);
        final c = await _mount(tester, f);
        await _openShare(tester);

        expect(find.text('Share your computers with Pilot'), findsOneWidget);
        // The same promise, for several computers.
        expect(
          find.text(
            'When they’re free, your teammates’ agents can work on them. They run in a separate account and '
            'can’t see your files, mail or logins.',
          ),
          findsOneWidget,
        );
        final rows = tester
            .widgetList<Text>(find.byKey(const ValueKey('share-computer-name')))
            .map((t) => t.data)
            .toList();
        expect(
          rows.first,
          'This Mac (${f.app.stateOf('m')!.machine.displayName})',
        );
        expect(rows, containsAll(['Studio', 'Old laptop', 'Lab box']));
        bool? ticked(String id) => tester
            .widget<Checkbox>(find.byKey(ValueKey('share-computer-$id')))
            .value;
        expect(ticked('m'), isTrue);
        expect(ticked('m2'), isTrue);
        expect(ticked('m3'), isFalse);
        expect(ticked('m4'), isFalse);
        expect(find.text('Share when it’s on'), findsOneWidget);
        expect(
          find.text('Not linked. Link this computer from Machines.'),
          findsOneWidget,
        );
        // Whose subscription each computer would use, on its own row.
        expect(find.text('Uses your Claude subscription'), findsOneWidget);
        expect(
          find.widgetWithText(FilledButton, 'Share 2 computers'),
          findsOneWidget,
        );

        await tester.tap(find.byKey(const ValueKey('share-computer-m2')));
        await tester.pumpAndSettle();
        expect(
          find.widgetWithText(FilledButton, 'Share 1 computer'),
          findsOneWidget,
        );
        await _done(tester, f, c);
      },
    );

    testWidgets(
      'only your own computers, each once, and none already in this Swarm',
      (tester) async {
        final f = _fixture();
        _addComputer(f, 'm2', 'Studio');
        _addComputer(f, 'm-team', 'Studio · Team');
        const theirs = Machine(
          machineId: 'x',
          authMode: MachineAuthMode.remote,
          name: 'Their laptop',
          isShared: true,
          ownerName: 'Ada',
        );
        f.app.machines = [...f.app.machines, theirs];
        f.app.machineStates['x'] = MachineState(theirs)..nodeOnline = true;
        _addComputer(f, 'm5', 'Shared already');
        f.connection.server.state['machines'] = [
          {'machineId': 'm5', 'contributorId': 'owner'},
          // A Mac's Harness Team account goes with its Mac, never on its own.
          {
            'machineId': 'm-team',
            'contributorId': 'owner',
            'hostMachineId': 'm2',
          },
        ];
        final c = await _mount(tester, f);
        await _openShare(tester);

        expect(find.byKey(const ValueKey('share-computer-m')), findsOneWidget);
        expect(find.byKey(const ValueKey('share-computer-m2')), findsOneWidget);
        expect(
          find.byKey(const ValueKey('share-computer-m-team')),
          findsNothing,
        );
        expect(find.byKey(const ValueKey('share-computer-x')), findsNothing);
        expect(find.byKey(const ValueKey('share-computer-m5')), findsNothing);
        await _done(tester, f, c);
      },
    );

    testWidgets(
      'Share shares each ticked computer; this Mac asks for its password, another finishes there',
      (tester) async {
        final f = _fixture();
        _addComputer(f, 'm2', 'Studio');
        final c = await _mount(tester, f);
        await _openShare(tester);
        await tester.tap(
          find.widgetWithText(FilledButton, 'Share 2 computers'),
        );
        await _settle(tester);

        expect(_contributions(f).map((c) => c['machineId']), ['m', 'm2']);
        expect(_contributions(f).every((c) => c['maxAgents'] == 16), isTrue);
        // Only this Mac's Team account is set up from here; nobody may be at the other one.
        expect(_calls(f, 'teamSetup'), hasLength(1));
        expect(find.textContaining('osascript'), findsOneWidget);
        expect(
          find.text('Finish on that computer: Harness there asks once.'),
          findsOneWidget,
        );
        expect(find.widgetWithText(FilledButton, 'Done'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _done(tester, f, c);
      },
    );

    testWidgets(
      'a computer that goes offline while the list is open is left out',
      (tester) async {
        final f = _fixture();
        _addComputer(f, 'm2', 'Studio');
        final c = await _mount(tester, f);
        await _openShare(tester);
        f.app.machineStates['m2']!.nodeOnline = false;
        // Any change to the app repaints the list.
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<Checkbox>(find.byKey(const ValueKey('share-computer-m2')))
              .value,
          isFalse,
        );
        expect(
          find.widgetWithText(FilledButton, 'Share 1 computer'),
          findsOneWidget,
        );
        await _done(tester, f, c);
      },
    );

    testWidgets(
      'a computer that is not listed yet: how to install Harness there and sign in',
      (tester) async {
        final f = _fixture();
        _addComputer(f, 'm2', 'Studio');
        final c = await _mount(tester, f);
        await _openShare(tester);
        await tester.tap(find.text('Add a computer that isn’t listed…'));
        await tester.pumpAndSettle();

        expect(
          find.widgetWithText(OutlinedButton, 'Download for Mac or Windows'),
          findsOneWidget,
        );
        expect(
          find.text(
            'curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | bash',
          ),
          findsOneWidget,
        );
        expect(find.byTooltip('Copy command'), findsOneWidget);
        expect(find.textContaining('owner@example.com'), findsOneWidget);
        expect(find.textContaining('scan'), findsOneWidget);
        await _done(tester, f, c);
      },
    );
  });

  group('in Machines', () {
    testWidgets(
      'your shared computers have a Shared switch; off asks before removing',
      (tester) async {
        final f = _fixture();
        f.connection.server.state['machines'] = [
          {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 8},
          {
            'machineId': 'studio',
            'name': 'Studio',
            'contributorId': 'teammate',
          },
        ];
        final c = await _mount(tester, f);
        // In each computer's expanded part, so rows keep their compact height.
        await tester.tap(find.byKey(const ValueKey('super-machine-m')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-machine-studio')));
        await tester.pumpAndSettle();
        final mine = find.byKey(const ValueKey('super-machine-shared-m'));
        expect(tester.widget<Switch>(mine).value, isTrue);
        // Someone else's computer is theirs to share.
        expect(
          find.byKey(const ValueKey('super-machine-shared-studio')),
          findsNothing,
        );

        await tester.tap(mine);
        await tester.pumpAndSettle();
        final name = superTabMachineName(
          f.app.stateOf('m')!.machine.displayName,
        );
        expect(find.text('Remove $name from this Swarm?'), findsOneWidget);
        expect(f.connection.server.posts, isEmpty);
        await _done(tester, f, c);
      },
    );

    testWidgets('your computer that is not shared yet gets one quiet line', (
      tester,
    ) async {
      final f = _fixture();
      _addComputer(f, 'm2', 'Studio');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 8},
      ];
      final c = await _mount(tester, f);
      expect(find.text('Your Studio isn’t shared yet'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Share'));
      await tester.pumpAndSettle();
      // The list, with just that computer.
      expect(find.byKey(const ValueKey('share-computer-m2')), findsOneWidget);
      expect(find.byKey(const ValueKey('share-computer-m')), findsNothing);
      await tester.tap(find.widgetWithText(FilledButton, 'Share 1 computer'));
      await _settle(tester);
      expect(_contributions(f).single['machineId'], 'm2');
      expect(_calls(f, 'teamSetup'), isEmpty);
      await _done(tester, f, c);
    });
  });

  testWidgets('creating or joining a Swarm asks to share your computers', (
    tester,
  ) async {
    final f = _fixture();
    final asked = <String>[];
    final listening = f.app.swarmShareAsks.listen(asked.add);
    addTearDown(listening.cancel);
    f.app.askToShareComputers(tabId);
    await tester.pump();
    expect(asked, [tabId]);
  });
}
