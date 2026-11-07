import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart' show SuperTabProject;
import 'package:harness/super_tabs/project_sidebar.dart';

import 'support/stack.dart';

/// The Swarm itself as a person on a Mac goes through it: its left pane,
/// Projects, Decisions and a project's settings, against the real backend and
/// daemon (task #4651).
void main() {
  if (cliRoot == null) {
    test('Swarm flows', () {}, skip: skipReason);
    return;
  }
  late SwarmStack stack;
  setUpAll(() async => stack = await SwarmStack.start());
  tearDownAll(() => stack.stop());

  Finder key(String k) => find.byKey(ValueKey(k));
  Finder inPane(Finder matching) =>
      find.descendant(of: find.byType(ProjectSidebar), matching: matching);

  /// The Swarm's projects as the backend holds them: what the app shows is
  /// checked against this, not against its own state.
  Future<List<Map<String, dynamic>>> backendProjects(
    WidgetTester tester,
    String tabId,
  ) async {
    final parts = (await tester.runAsync(
      () => stack.api('/api/super-tabs/$tabId/parts'),
    ))!;
    final head = ((parts['data'] as Map)['head'] as Map)['data'] as Map;
    return [
      for (final project in head['projects'] as List)
        (project as Map).cast<String, dynamic>(),
    ];
  }

  /// A new Swarm, opened in the app.
  Future<(String, FlowApp)> openSwarm(WidgetTester tester) async {
    // Setup: the person made this Swarm before (New Swarm is not under test).
    final tabId = (await tester.runAsync(() => stack.newSwarm('Company')))!;
    final flow = await FlowApp.open(tester, stack);
    flow.app.openSuperTab(tabId, 'Company');
    await flow.see(key('super-new-agent-row'), what: 'the Swarm\'s left pane');
    return (tabId, flow);
  }

  /// New project from the Projects page, as the person does it; the new
  /// project's id once its Product Manager runs.
  Future<String> newProject(
    WidgetTester tester,
    FlowApp flow,
    String tabId,
    String task,
  ) async {
    await flow.tap(key('super-projects'), what: 'Projects in the left pane');
    await flow.tap(
      find.widgetWithText(FilledButton, 'New project'),
      what: 'the Projects page\'s New project',
    );
    await flow.type(key('new-harness-task'), task);
    await tester.testTextInput.receiveAction(TextInputAction.send);
    String? created;
    await flow.until('the new project\'s Product Manager to run', () {
      flow.refuse('no longer available');
      final snapshot = flow.swarm(tabId)?.snapshot;
      created = snapshot?.projects
          .where((p) => p.id != 'lead' && snapshot.leadOf(p.id) != null)
          .firstOrNull
          ?.id;
      return created != null;
    }, timeout: const Duration(seconds: 60));
    return created!;
  }

  /// A project's Board, from Projects, once the person's Buddy chat it opens
  /// beside it is open.
  Future<void> openBoard(
    FlowApp flow,
    String tabId,
    SuperTabProject project,
  ) async {
    await flow.tap(key('super-projects'), what: 'Projects in the left pane');
    await flow.tap(
      key('super-group-${project.leadConversationId}'),
      what: 'the project\'s card on the Projects page',
    );
    await flow.see(
      find.descendant(
        of: key('super-board-header'),
        matching: find.text(project.name),
      ),
      what: 'the project\'s Board',
    );
    await flow.until('the Buddy chat beside the Board to open', () {
      final c = flow.swarm(tabId)!;
      return c.selected?.isBuddyChat == true &&
          !c.saving &&
          !c.hasPendingAction;
    });
  }

  flowTest('The left pane lists Decisions, Projects, My agents and Humans, '
      'and opens a project\'s Board and chat and an agent\'s chat', (
    tester,
  ) async {
    final (tabId, flow) = await openSwarm(tester);
    double top(String k) => tester.getTopLeft(key(k)).dy;
    expect(top('super-decisions'), lessThan(top('super-projects')));
    expect(top('super-projects'), lessThan(top('project-sidebar-agents')));
    expect(
      top('project-sidebar-agents'),
      lessThan(top('project-sidebar-humans')),
    );
    await flow.see(
      find.descendant(
        of: key('project-sidebar-humans').hitTestable(),
        matching: find.text('Humans'),
      ),
    );
    // Empty means empty (anh Dee 11-07): no decision waits, so Decisions has
    // no count, and nothing in the pane says there is nothing.
    expect(
      find.descendant(
        of: key('super-decisions'),
        matching: find.textContaining(RegExp(r'\d')),
      ),
      findsNothing,
      reason: 'Decisions with none waiting has no count',
    );
    expect(inPane(find.textContaining(RegExp(r'^No |nothing'))), findsNothing);

    // A project in Projects opens its Board, with the person's Buddy chat
    // beside it; its Chat tab, its chat.
    final project = flow.swarm(tabId)!.snapshot!.projects.single;
    await openBoard(flow, tabId, project);
    await flow.tap(key('super-board-tab-chat'), what: 'the Board\'s Chat tab');
    await flow.until(
      'the project\'s chat to open',
      () =>
          flow.swarm(tabId)?.selectedId == project.leadConversationId &&
          key('super-project-menu').evaluate().isNotEmpty,
    );

    // An agent in My agents opens its chat. Setup: the person brought it with
    // + New agent (its own flow is new_agent_flow_test.dart).
    await flow.tap(key('super-new-agent-row'), what: 'My agents\' New agent');
    await flow.type(key('new-harness-task'), 'Say hello.');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await flow.until('the new agent\'s chat to open', () {
      flow.refuse('no longer available');
      return flow.swarm(tabId)?.selected?.kind == 'agent-chat';
    }, timeout: const Duration(seconds: 60));
    final chatId = flow.swarm(tabId)!.selectedId;
    final agentId = flow.swarm(tabId)!.selected!.agentIds.single;
    // Away from it, then back through its row.
    await flow.tap(key('super-projects'), what: 'Projects in the left pane');
    await flow.until(
      'the Projects page',
      () => find
          .widgetWithText(FilledButton, 'New project')
          .evaluate()
          .isNotEmpty,
    );
    await flow.tap(key('super-agent-$agentId'), what: 'the agent\'s row');
    await flow.until(
      'the agent\'s chat to open from its row',
      () =>
          flow.swarm(tabId)?.selectedId == chatId &&
          key('super-middle-chat').evaluate().isNotEmpty,
    );
    await flow.see(find.text('Say hello.'), what: 'its first task in its chat');
    await flow.close();
  });

  flowTest('New project from the Projects page shows in the left pane, on '
      'Projects and on the server', (tester) async {
    final (tabId, flow) = await openSwarm(tester);
    final id = await newProject(tester, flow, tabId, 'Build a lamp app.');
    // Named once its Product Manager is placed (launch.dart project.rename).
    await flow.until('the new project to be named', () {
      final name = flow.swarm(tabId)?.snapshot?.projectById(id)?.name;
      return name != null && name != 'New project';
    });
    final snapshot = flow.swarm(tabId)!.snapshot!;
    final project = snapshot.projectById(id)!;
    final pm = snapshot.leadOf(id)!;

    // The left pane: its Product Manager in My agents, naming the project.
    await flow.see(
      find.descendant(
        of: key('super-agent-${pm.id}'),
        matching: find.text(project.name),
      ),
      what: 'its Product Manager in My agents, naming ${project.name}',
    );
    // Projects: its card.
    await flow.tap(key('super-projects'), what: 'Projects in the left pane');
    await flow.see(
      find.descendant(
        of: key('super-group-${project.leadConversationId}'),
        matching: find.text(project.name),
      ),
      what: 'its card on the Projects page',
    );
    // The server has it, under that name, with its Product Manager.
    final held = (await backendProjects(
      tester,
      tabId,
    )).where((p) => p['id'] == id).toList();
    expect(held, hasLength(1), reason: 'the backend holds the new project');
    expect(held.single['name'], project.name);
    await flow.close();
  });

  flowTest('A decision the Product Manager asks shows under Decisions, and '
      'picking an option answers it', (tester) async {
    final (tabId, flow) = await openSwarm(tester);
    // Setup: a project with its Product Manager, made as the person makes one.
    final projectId = await newProject(tester, flow, tabId, 'Plan a lamp.');
    final project = flow.swarm(tabId)!.snapshot!.projectById(projectId)!;
    final pm = flow.swarm(tabId)!.snapshot!.leadOf(projectId)!;
    // The Product Manager asks, as an agent does (`harness super-tab command`).
    await tester.runAsync(
      () => stack.asAgent(tabId, pm.id, [
        'command',
        'flow-ask-${DateTime.now().microsecondsSinceEpoch}',
        jsonEncode({
          'type': 'decision.ask',
          'conversationId': project.leadConversationId,
          'personId': stack.owner['id'],
          'questions': [
            {
              'question': 'Which color should the lamp be?',
              'options': ['Warm white', 'Daylight'],
              'recommended': 1,
              'unblocks': 'The first build',
            },
          ],
        }),
      ]),
    );

    // Decisions counts it in the left pane.
    await flow.see(
      find.descendant(of: key('super-decisions'), matching: find.text('1')),
      what: 'Decisions counting the one waiting',
    );
    await flow.tap(key('super-decisions'), what: 'Decisions in the left pane');
    await flow.see(
      find.text('Which color should the lamp be?'),
      what: 'the question on Decisions',
    );
    await flow.see(
      find.widgetWithText(OutlinedButton, 'Warm white'),
      what: 'its first option',
    );
    expect(
      find.widgetWithText(FilledButton, 'Daylight · Recommended'),
      findsOneWidget,
      reason: 'the recommended option',
    );
    await flow.tap(find.widgetWithText(OutlinedButton, 'Warm white'));

    // Answered in the app: it leaves Decisions and the count goes.
    await flow.until('the decision to leave Decisions', () {
      flow.refuse('Could not send'); // SuperTabDecisions.sendFailed starts so.
      return find.text('Which color should the lamp be?').evaluate().isEmpty &&
          find
              .descendant(of: key('super-decisions'), matching: find.text('1'))
              .evaluate()
              .isEmpty;
    });
    // Answered on the server, with the option picked.
    final answered = (await tester.runAsync(
      () => stack.api('/api/super-tabs/$tabId/decisions?state=answered'),
    ))!;
    final rows = [
      for (final row in (answered['data'] as Map)['decisions'] as List)
        (row as Map).cast<String, dynamic>(),
    ].where((d) => d['question'] == 'Which color should the lamp be?');
    expect(rows, hasLength(1), reason: 'the backend has it answered');
    expect(rows.single['choice'], 0, reason: 'Warm white');
    await flow.close();
  });

  flowTest('Renaming a project in Project settings renames it in the app and '
      'on the server', (tester) async {
    final (tabId, flow) = await openSwarm(tester);
    final project = flow.swarm(tabId)!.snapshot!.projects.single;
    // Its chat, from Projects and its Board, where its menu is. The Board
    // opens the person's Buddy chat beside it on the server (buddy.chat);
    // the person goes on once it shows (see the skipped flow below).
    await openBoard(flow, tabId, project);
    await flow.tap(key('super-board-tab-chat'), what: 'the Board\'s Chat tab');
    await flow.tap(key('super-project-menu'), what: 'the project\'s menu');
    await flow.tap(find.text('Project settings…'));
    await flow.tap(
      key('super-project-setting-Rename project'),
      what: 'Project settings\' Rename project',
    );
    await flow.type(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.byType(TextFormField),
      ),
      'Lamp OS',
    );
    await flow.tap(find.widgetWithText(FilledButton, 'Save'));

    await flow.until(
      'the rename dialog to close',
      () => find.byType(AlertDialog).evaluate().isEmpty,
    );
    // Its chat's header, `# name`.
    await flow.see(find.text('# Lamp OS'), what: 'the chat\'s header renamed');
    await flow.tap(key('super-projects'), what: 'Projects in the left pane');
    await flow.see(
      find.descendant(
        of: key('super-group-${project.leadConversationId}'),
        matching: find.text('Lamp OS'),
      ),
      what: 'its card on Projects renamed',
    );
    final held = (await backendProjects(
      tester,
      tabId,
    )).singleWhere((p) => p['id'] == project.id);
    expect(held['name'], 'Lamp OS', reason: 'the backend has the new name');
    await flow.close();
  });

  flowTest(
    'The Board\'s Chat tab keeps the project\'s chat while its Buddy chat opens',
    (tester) async {
      final (tabId, flow) = await openSwarm(tester);
      final project = flow.swarm(tabId)!.snapshot!.projects.single;
      await flow.tap(key('super-projects'), what: 'Projects in the left pane');
      await flow.tap(key('super-group-${project.leadConversationId}'));
      // At once, before the Buddy chat the Board opens is back from the server.
      await flow.tap(
        key('super-board-tab-chat'),
        what: 'the Board\'s Chat tab',
      );
      await flow.until('the Buddy chat\'s open to finish', () {
        final c = flow.swarm(tabId)!;
        return !c.saving && !c.hasPendingAction;
      });
      expect(
        flow.swarm(tabId)!.selectedId,
        project.leadConversationId,
        reason: 'the project\'s chat the person chose stays open',
      );
      expect(key('super-project-menu'), findsOneWidget);
      await flow.close();
    },
  );
}
