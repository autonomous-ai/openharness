import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/join/bring_agent.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'swarm_state_test.dart' show createApp;

/// Join's Bring agent is the same Cmd-N form with the project list (task #4541, spec 2026-11-07-members-and-leads
/// section 1): the agent becomes a Member of the project picked.
void main() {
  testWidgets('Bring agent shows the project list and sends the pick', (
    tester,
  ) async {
    final server = swarm()
      ..projectList = {
        'projects': [
          {
            'id': 'lead',
            'name': 'web-project',
            'about': 'The web app',
            'lead': {'agentId': 'river', 'name': 'River'},
            'waiting': 2,
          },
          {'id': 'lamp', 'name': 'lamp', 'lead': null, 'waiting': 5},
        ],
        'pick': 'lamp',
      }
      // This computer is already in the Swarm: the start needs no setup.
      ..state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'name': 'This Mac'},
      ];
    final c = server.controller(account: 'owner');
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    final app = createApp()
      ..status = AppStatus.authenticated
      ..currentUser = const CurrentUserProfile(
        id: 'owner',
        email: 'owner@example.com',
      );
    app.machineStates['m']!.localOnly = true;
    addTearDown(app.dispose);
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    late BuildContext context;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (c) {
            context = c;
            return const SizedBox();
          },
        ),
      ),
    );
    var open = true;
    addTearDown(() => open = false);
    final result = showBringAgentForm(
      context,
      controller: c,
      app: app,
      isCurrent: () => open,
    );
    for (var i = 0; i < 5; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(server.projectListReads, hasLength(1));
    await tester.tap(
      find.byKey(const ValueKey('new-harness-field-main-project')),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('new-harness-main-project-lead')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('new-harness-field-start')));
    for (var i = 0; i < 5; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump(const Duration(milliseconds: 100));
    }
    final start = server.posts
        .map((p) => p['command'] as Map)
        .singleWhere((c) => c['type'] == 'buddy.create');
    expect(start, containsPair('mainProjectId', 'lead'));
    open = false;
    await tester.pumpWidget(const SizedBox());
    await result;
  });

  // Mainproj, #4540: a Buddy never leads. Join's New project lists the computer, then starts the Lead with its name.
  testWidgets('New project from Join starts a Lead with the project\'s name, '
      'not a Buddy', (tester) async {
    final server = swarm()
      ..projectList = {'projects': <dynamic>[], 'pick': null}
      ..state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'name': 'This Mac'},
      ];
    final c = server.controller(account: 'owner');
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    final app = createApp()
      ..status = AppStatus.authenticated
      ..currentUser = const CurrentUserProfile(
        id: 'owner',
        email: 'owner@example.com',
      );
    app.machineStates['m']!.localOnly = true;
    addTearDown(app.dispose);
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    late BuildContext context;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (c) {
            context = c;
            return const SizedBox();
          },
        ),
      ),
    );
    var open = true;
    addTearDown(() => open = false);
    final result = showBringAgentForm(
      context,
      controller: c,
      app: app,
      isCurrent: () => open,
    );
    Future<void> settle() async {
      for (var i = 0; i < 5; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    await settle();
    await tester.enterText(
      find.byKey(const ValueKey('new-harness-new-project-name')),
      'radio',
    );
    await tester.tap(find.byKey(const ValueKey('new-harness-field-start')));
    await settle();
    final types = server.posts.map((p) => (p['command'] as Map)['type']);
    expect(types, isNot(contains('buddy.create')));
    final start = server.posts
        .map((p) => p['command'] as Map)
        .singleWhere((c) => c['type'] == 'agent.new');
    expect(start, containsPair('kind', 'pm'));
    expect(start, containsPair('projectName', 'radio'));
    expect(start, containsPair('machineId', 'm'));
    open = false;
    await tester.pumpWidget(const SizedBox());
    await result;
  });
}
