import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/widgets/desktop_prompt_surface.dart';
import 'package:harness/widgets/delete_agent_dialog.dart';
import 'package:harness/widgets/delete_harness_dialog.dart';

import 'super_tab_launch_test.dart'
    show SuperTabFixtureConnection, SuperTabLaunchFixture, tabId;
import 'swarm_screen_test.dart' show mount, terminal;

class _CloseFixtureConnection extends SuperTabFixtureConnection {
  _CloseFixtureConnection(super.store);

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'agent_close') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    calls.add((type, Map.of(payload)));
    if (payload['mode'] == 'inspect') return {'activity': 'working'};
    await event('agent_deleted', {'agentId': payload['agentId']});
    return {'closed': true};
  }
}

void main() {
  for (final action in ['stop', 'stop terminal', 'delete']) {
    testWidgets('$action is disabled for a project Product Manager', (
      tester,
    ) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['agents'] = [
        {
          'id': 'pm',
          'name': 'Quinn',
          'machineId': 'm',
          'harnessId': 'native-pm',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ];
      (f.connection.server.state['conversations'] as List)[0]['leadId'] = 'pm';
      f.app.machineStates['m']!.agents = [
        Agent(
          id: 'native-pm',
          name: 'Quinn',
          engine: action == 'stop terminal' ? 'terminal' : 'claude',
        ),
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => action == 'delete'
                    ? confirmDeleteHarness(
                        context,
                        f.app,
                        'm',
                        'native-pm',
                        'Quinn',
                      )
                    : confirmDeleteAgent(
                        context,
                        f.app,
                        'm',
                        'native-pm',
                        'Quinn',
                        engine: action == 'stop terminal'
                            ? 'terminal'
                            : 'claude',
                      ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Quinn is the Product Manager of project Pilot. Delete the project first.',
        ),
        findsOneWidget,
      );
      if (action == 'delete') {
        expect(find.textContaining('To keep the conversation'), findsNothing);
      } else {
        expect(
          find.textContaining('Its panes close across tabs'),
          findsNothing,
        );
      }
      final confirm = find.byKey(
        Key(action == 'delete' ? 'agent-delete-confirm' : 'agent-stop-confirm'),
      );
      expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_delete'),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
    });
  }

  testWidgets('ordinary Swarm agent keeps Stop and Delete available', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.server.state['agents'] = [
      {
        'id': 'worker',
        'name': 'Sage',
        'machineId': 'm',
        'harnessId': 'native-worker',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      },
    ];
    f.app.machineStates['m']!.agents = [
      const Agent(id: 'native-worker', name: 'Sage', engine: 'claude'),
    ];
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    Future<void> mount(bool delete) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => delete
                    ? confirmDeleteHarness(
                        context,
                        f.app,
                        'm',
                        'native-worker',
                        'Sage',
                      )
                    : confirmDeleteAgent(
                        context,
                        f.app,
                        'm',
                        'native-worker',
                        'Sage',
                        engine: 'claude',
                      ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      final button = find.byKey(
        Key(delete ? 'agent-delete-confirm' : 'agent-stop-confirm'),
      );
      expect(tester.widget<FilledButton>(button).onPressed, isNotNull);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
    }

    await mount(false);
    await mount(true);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
  });

  testWidgets('a closed Swarm view still protects its Product Manager', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    final swarmId = f.app.activeSwarmId;
    f.app.bindSuperTab(swarmId, tabId, 'Pilot');
    f.connection.server.state['agents'] = [
      {
        'id': 'pm',
        'name': 'Quinn',
        'machineId': 'm',
        'harnessId': 'native-pm',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      },
    ];
    (f.connection.server.state['conversations'] as List)[0]['leadId'] = 'pm';
    f.app.machineStates['m']!.agents = [
      const Agent(id: 'native-pm', name: 'Quinn', engine: 'claude'),
    ];
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await f.app.requestCloseSwarm(swarmId);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => confirmDeleteAgent(
                context,
                f.app,
                'm',
                'native-pm',
                'Quinn',
                engine: 'claude',
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Product Manager of project Pilot'),
      findsOneWidget,
    );
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('agent-stop-confirm')))
          .onPressed,
      isNull,
    );
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
  });

  testWidgets(
    'closing an ordinary pane keeps a Swarm Product Manager running',
    (tester) async {
      final f = SuperTabLaunchFixture();
      final swarmId = f.app.activeSwarmId;
      f.app.bindSuperTab(swarmId, tabId, 'Pilot');
      f.connection.server.state['agents'] = [
        {
          'id': 'pm',
          'name': 'Quinn',
          'machineId': 'm',
          'harnessId': 'native-pm',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ];
      (f.connection.server.state['conversations'] as List)[0]['leadId'] = 'pm';
      f.app.machineStates['m']!.agents = [
        Agent(
          id: 'native-pm',
          name: 'Quinn',
          engine: 'claude',
          sessionId: 'saved',
          closeSupported: true,
          terminalAvailable: true,
        ),
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await f.app.requestCloseSwarm(swarmId);
      final pane = f.app.adoptSessionForTest(terminal('native-pm', []));
      await mount(tester, f.app);
      unawaited(f.app.requestClosePane(pane.id));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-close-now')), findsNothing);
      expect(f.app.allPanes, isEmpty);
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_close'),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
    },
  );

  testWidgets(
    'closing a mixed tab stops its Engineer but keeps its Product Manager',
    (tester) async {
      final f = SuperTabLaunchFixture(
        connectionFactory: (store) => _CloseFixtureConnection(store),
      );
      final swarmId = f.app.activeSwarmId;
      f.app.bindSuperTab(swarmId, tabId, 'Pilot');
      f.connection.server.state['agents'] = [
        {
          'id': 'pm',
          'name': 'Quinn',
          'machineId': 'm',
          'harnessId': 'native-pm',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
        {
          'id': 'worker',
          'name': 'Sage',
          'machineId': 'm',
          'harnessId': 'native-worker',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ];
      (f.connection.server.state['conversations'] as List)[0]['leadId'] = 'pm';
      Agent closeable(String id, String name) => Agent(
        id: id,
        name: name,
        engine: 'claude',
        createdAt: DateTime.utc(2026, 9, 30, 12),
        sessionId: 'saved-$id',
        closeSupported: true,
        terminalAvailable: true,
      );
      f.app.machineStates['m']!.agents = [
        closeable('native-pm', 'Quinn'),
        closeable('native-worker', 'Sage'),
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await f.app.requestCloseSwarm(swarmId);
      f.app.adoptSessionForTest(terminal('native-pm', []));
      f.app.adoptSessionForTest(terminal('native-worker', []));
      final ordinaryTab = f.app.activeSwarm;
      await mount(tester, f.app);

      unawaited(f.app.requestCloseSwarm(ordinaryTab.id));
      await tester.pumpAndSettle();
      final closePrompt = find.byType(DesktopPromptSurface);
      final stop = find.descendant(
        of: closePrompt,
        matching: find.widgetWithText(FilledButton, 'Stop'),
      );
      expect(stop, findsOneWidget);
      expect(tester.widget<FilledButton>(stop).onPressed, isNotNull);
      expect(
        find.descendant(of: closePrompt, matching: find.text('Sage')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: closePrompt, matching: find.text('Quinn')),
        findsNothing,
      );
      await tester.tap(stop);
      await tester.pumpAndSettle();

      final closes = f.connection.calls
          .where((call) => call.$1 == 'agent_close')
          .map((call) => call.$2)
          .toList();
      expect(closes.map((call) => call['agentId']), [
        'native-worker',
        'native-worker',
      ]);
      expect(closes.map((call) => call['mode']), ['inspect', 'now']);
      expect(f.app.swarms, isNot(contains(ordinaryTab)));
      expect(
        f.app.machineStates['m']!.agents.any((a) => a.id == 'native-pm'),
        isTrue,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
    },
  );
  testWidgets('Stop becomes disabled if its agent becomes Product Manager', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.server.state['agents'] = [
      {
        'id': 'worker',
        'name': 'Sage',
        'machineId': 'm',
        'harnessId': 'native-worker',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      },
    ];
    f.app.machineStates['m']!.agents = [
      const Agent(id: 'native-worker', name: 'Sage', engine: 'claude'),
    ];
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => confirmDeleteAgent(
                context,
                f.app,
                'm',
                'native-worker',
                'Sage',
                engine: 'claude',
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('agent-stop-confirm')))
          .onPressed,
      isNotNull,
    );
    (f.connection.server.state['conversations'] as List)[0]['leadId'] =
        'worker';
    await c.refresh();
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Product Manager of project Pilot'),
      findsOneWidget,
    );
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('agent-stop-confirm')))
          .onPressed,
      isNull,
    );
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
  });
}
