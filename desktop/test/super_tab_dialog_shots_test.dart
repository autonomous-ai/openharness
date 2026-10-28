// The six Swarm dialogs Ken asked to polish (2026-10-28), photographed light and dark for review: machine details,
// person profile, Project details, Team at a glance, Share Swarm and Add machine, over in-memory Swarms only.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/project_options.dart';
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/super_tabs/sharing.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/engine_identity.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'swarm_sharing_test.dart' show SwarmSharingServer;
import 'support/capture.dart';
import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the screenshots there.
final shots = Platform.environment['SUPER_TAB_DIALOG_SHOTS'];

int _in(Duration d) => DateTime.now().add(d).millisecondsSinceEpoch;

Future<void> _pump(
  WidgetTester tester,
  Brightness brightness,
  Widget home, {
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
      home: Scaffold(body: home),
    ),
  );
  await tester.pumpAndSettle();
}

/// A Swarm like Ken's: a MacBook Pro with both allowances, a Mac Studio gone offline with many busy agents, and
/// people to share with.
ConversationServer _swarm() {
  final server = ConversationServer();
  server.state['people'] = [
    {'id': 'owner', 'email': 'ken@example.com', 'role': 'owner'},
    for (final name in ['diego', 'huy', 'tony', 'scholes', 'dee'])
      {'id': name, 'email': '$name@example.com', 'role': 'collaborator'},
  ];
  final studio = [
    'Milo',
    'Kai',
    'Iris',
    'Ellis',
    'Nova',
    'Echo',
    'Rowan',
    'Juno',
    'Lark',
    'Avery',
    'Remy',
    'Quinn', //
  ];
  server.state['agents'] = [
    {
      'id': 'river',
      'name': 'Lead',
      'displayName': 'River',
      'machineId': 'mbp',
      'harnessId': 'h-river',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude', 'model': 'opus', 'effort': 'high'},
    },
    for (final name in ['Robin', 'Sage'])
      {
        'id': name.toLowerCase(),
        'name': 'Builder',
        'displayName': name,
        'machineId': 'mbp',
        'harnessId': 'h-$name',
        'contributorId': 'owner',
        'configuration': {
          'engine': 'claude',
          'model': 'opus',
          'effort': 'xhigh',
        },
      },
    for (final name in studio)
      {
        'id': name.toLowerCase(),
        'name': 'Builder',
        'displayName': name,
        'machineId': 'studio',
        'harnessId': 'h-$name',
        'contributorId': 'owner',
        'configuration': {
          'engine': 'claude',
          'model': 'opus',
          'effort': 'high',
        },
      },
  ];
  server.state['starts'] = [
    for (final name in ['Robin', 'Sage'])
      {
        'id': 'start-$name',
        'harnessId': 'h-$name',
        'request': {
          'machineId': 'mbp',
          'engine': 'claude',
          'model': 'opus',
          'effort': 'high',
          'name': name,
        },
      },
  ];
  final conversations = server.state['conversations'] as List;
  conversations[0]
    ..['leadId'] = 'river'
    ..['agentIds'] = ['river'];
  for (final name in studio) {
    conversations.add({
      ...conversationFixture('task-$name', 'Task of $name'),
      'leadId': 'river',
      'agentIds': ['river', name.toLowerCase()],
      'assignment': {
        'id': 'as-$name',
        'agentId': name.toLowerCase(),
        'status': 'working',
      },
    });
  }
  server.state['machines'] = [
    {
      'machineId': 'mbp',
      'name': 'MacbookPro.local',
      'contributorId': 'owner',
      'engines': ['claude', 'codex'],
      'maxAgents': 16,
      'availableSlots': 14,
      'cwd': '/Users/ken/.harness/cli/data/swarm-projects/tab',
      'observation': {
        'receivedAt': DateTime.now().millisecondsSinceEpoch,
        'resources': {
          'deviceType': 'MacBook Pro',
          'chip': 'Apple M2 Max',
          'os': 'macOS',
          'cpuPercent': 14,
          'gpuPercent': 8,
          'memoryTotalBytes': 34000000000,
          'memoryUsedBytes': 25000000000,
          'diskTotalBytes': 995000000000,
          'diskFreeBytes': 156000000000,
        },
        'quotas': [
          {
            'engine': 'claude',
            'known': true,
            'windows': [
              {
                'name': 'Session',
                'usedPercent': 43,
                'resetsAt': _in(const Duration(hours: 2, minutes: 1)),
              },
              {
                'name': 'Weekly',
                'usedPercent': 35,
                'resetsAt': _in(const Duration(days: 6, hours: 2)),
              },
            ],
          },
          {
            'engine': 'codex',
            'known': true,
            'windows': [
              {
                'name': 'Weekly',
                'usedPercent': 5,
                'resetsAt': _in(const Duration(days: 6, hours: 22)),
              },
            ],
          },
        ],
      },
    },
    {
      'machineId': 'studio',
      'name': 'MACs-Mac-Studio.local',
      'contributorId': 'owner',
      'engines': ['claude', 'codex'],
      'maxAgents': 32,
      'availableSlots': 11,
      'observation': {
        'receivedAt': DateTime.now().millisecondsSinceEpoch - 10 * 60 * 1000,
      },
    },
  ];
  return server;
}

/// The Swarm's controller, answering the project's GitHub access as covered.
SuperTabController _controller(ConversationServer server) => SuperTabController(
  tabId: 'tab',
  accountId: 'owner',
  request: (method, path, {body}) async {
    if (path.contains('/github')) {
      return {'state': 'covered', 'repository': 'autonomous-ai/openharness'};
    }
    return server.request(method, path, body: body);
  },
  save: server.save,
  upload: server.upload,
  initial: const {},
  pollInterval: Duration.zero,
);

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    final theme = brightness.name;

    testWidgets('machine details ($theme)', (tester) async {
      final server = _swarm();
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      await _pump(
        tester,
        brightness,
        Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: 280,
            child: SuperTabMachines(
              controller: c,
              embedded: true,
              onAddAgent: (_) {},
            ),
          ),
        ),
      );
      final row = find.byKey(const ValueKey('super-machine-mbp'));
      await tester.longPress(row);
      await tester.pumpAndSettle();
      // Codex's mark is a picture decoded off the frame: wait for it before photographing, as the app shows it.
      await tester.runAsync(
        () => precacheImage(
          AssetImage(engineIdentity('codex').asset!),
          tester.element(find.byType(EngineMark).first),
        ).timeout(const Duration(seconds: 10)),
      );
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, '1-machine-details-$theme');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    }, skip: shots == null);

    testWidgets('person profile ($theme)', (tester) async {
      final swarm = humansSwarm();
      final dee = (swarm.leaderboard!['people'] as List).first as Map;
      (dee['details'] as Map)['shipped'] = [
        for (final title in [
          'Bug: machine last-seen time has not been written since Oct 14',
          'Stability 2.3: remove the expensive loops — terminal long-poll, 5 s socket re-checks, skip paging',
          "Bug: viewing another person's agent terminal in a Swarm is unreliable",
          'Main is red: 48 team-session tests fail after the GitHub approvals change',
          'Stability 2.2 + 2.6: per-pod Swarm cache keyed by version',
          'Hotfix: prod DB at 100% CPU, message deliveries read scans the whole Swarm',
          'Stability 2.4: deliver work over the daemon socket, poll only as a 30 s fallback',
          'Web app reconnect loop: one user reconnects ~3,250 times an hour',
        ])
          {
            'title': title,
            'prUrl': 'https://github.com/autonomous-ai/openharness/pull/1',
          },
      ];
      final c = swarm.controller(
        account: 'peer',
        initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
      );
      addTearDown(c.dispose);
      await c.refresh();
      await _pump(
        tester,
        brightness,
        SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Mac Studio',
        ),
        size: const Size(1300, 1000),
      );
      await tester.tap(find.byKey(const ValueKey('super-person-peer')));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, '2-person-profile-$theme');
      await tester.pumpWidget(const SizedBox());
    }, skip: shots == null);

    testWidgets('project details ($theme)', (tester) async {
      final server = _swarm();
      server.state['project'] = {
        'repositoryUrl': 'https://github.com/autonomous-ai/openharness',
      };
      final c = _controller(server);
      addTearDown(c.dispose);
      await c.refresh();
      final project = c.snapshot!.projects.first;
      await _pump(
        tester,
        brightness,
        Builder(
          builder: (context) => TextButton(
            onPressed: () => showProjectAction(context, c, project, 'details'),
            child: const Text('open'),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, '3-project-details-$theme');
    }, skip: shots == null);

    testWidgets('team at a glance ($theme)', (tester) async {
      final server = _swarm();
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      await _pump(
        tester,
        brightness,
        SuperTabRoster(
          controller: c,
          onInvite: () {},
          onOpenAgent: (_) {},
          onAddAgent: (_) {},
          onAnswer: (_) {},
        ),
      );
      await tester.tap(find.byTooltip('Team at a glance'));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, '4-team-at-a-glance-$theme');
      await tester.pumpWidget(const SizedBox());
    }, skip: shots == null);

    testWidgets('share swarm ($theme)', (tester) async {
      final server = SwarmSharingServer();
      server.state['people'] = _swarm().state['people'];
      server.state['agents'] = _swarm().state['agents'];
      (server.state['conversations'] as List)[0]['leadId'] = 'river';
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      await _pump(
        tester,
        brightness,
        Builder(
          builder: (context) => TextButton(
            onPressed: () => showSuperTabSharing(context, c),
            child: const Text('open'),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('swarm-sharing-people')));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, '5-share-swarm-$theme');
    }, skip: shots == null);

    testWidgets('add machine ($theme)', (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.app.machineStates['m']!.machine = f.app.machineStates['m']!.machine
          .copyWith(name: 'autonomous-code-vm-01.c.autonomous-code.internal');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _pump(
        tester,
        brightness,
        SizedBox(
          width: 300,
          height: 400,
          child: SuperTabMachines(
            controller: c,
            app: f.app,
            onAddAgent: (_) {},
          ),
        ),
      );
      await tester.tap(find.byTooltip('Add machine'));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, '6-add-machine-$theme');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }, skip: shots == null);
  }
}
