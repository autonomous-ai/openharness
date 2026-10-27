import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_visibility.dart';

import 'support/super_tab_fixture.dart';

ConversationServer projectsServer() {
  final server = ConversationServer();
  server.state['name'] = 'Company';
  server.state['projects'] = [
    projectFixture('lead', 'Lamp OS', 'lead'),
    projectFixture('design', 'Design', 'design-lead', visibility: 'private'),
  ];
  (server.state['conversations'] as List).add({
    ...conversationFixture('design-lead', 'Lead'),
    'projectId': 'design',
  });
  (server.state['conversations'] as List)[1]['number'] = 12;
  return server;
}

void main() {
  Future<void> mount(
    WidgetTester tester,
    SuperTabController c, {
    VoidCallback? onNewProject,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1200, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            onNewProject: onNewProject,
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> unmount(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  testWidgets('project rows open lead chats and reveal numbered workgroups', (
    tester,
  ) async {
    final server = projectsServer(), c = server.controller();
    var creations = 0;
    await mount(tester, c, onNewProject: () => creations++);
    expect(find.byKey(const ValueKey('super-group-offline')), findsNothing);
    expect(find.byIcon(AppIcons.lock), findsOneWidget);
    expect(
      find.byKey(const ValueKey('super-group-design-lead')),
      findsOneWidget,
    );
    expect(find.text('Leads'), findsNothing);
    expect(find.text('Projects'), findsOneWidget);
    expect(find.text('Humans'), findsOneWidget);
    expect(find.text('Agents'), findsOneWidget);
    final create = find.byTooltip('New project');
    final project = find.byKey(const ValueKey('super-group-lead'));
    expect(
      tester.getBottomLeft(create).dy,
      lessThan(tester.getTopLeft(project).dy),
    );
    await tester.tap(find.byKey(const ValueKey('super-group-lead')));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'lead');
    expect(find.text('12  Offline editing'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('super-group-offline')));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'offline');
    await tester.tap(find.byKey(const ValueKey('super-group-design-lead')));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'design-lead');
    expect(c.expandedProjects, {'lead', 'design'});
    await tester.tap(find.byKey(const ValueKey('super-group-lead')));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'lead');
    await tester.tap(find.byTooltip('New project'));
    expect(creations, 1);
    expect(server.posts, isEmpty);
    expect(tester.takeException(), isNull);
    await unmount(tester, c);
  });

  testWidgets(
    'project and workgroup rows align, and a project row works from the keyboard',
    (tester) async {
      final server = projectsServer(), c = server.controller();
      await mount(tester, c);
      final project = find.byKey(const ValueKey('super-group-lead'));
      final projectName = find.descendant(
        of: project,
        matching: find.text('Lamp OS'),
      );
      // Enter on the open project shows its workgroups.
      Focus.of(tester.element(projectName)).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.expandedProjects, {'lead'});
      expect(c.selectedId, 'lead');

      final workgroup = find.byKey(const ValueKey('super-group-offline'));
      final projectBounds = tester.getRect(project);
      final workgroupBounds = tester.getRect(workgroup);
      expect(workgroupBounds.left, projectBounds.left);
      expect(workgroupBounds.right, projectBounds.right);
      // Workgroups share the project name column in the compact sidebar.
      expect(
        tester.getTopLeft(find.text('12  Offline editing')).dx,
        tester.getTopLeft(projectName).dx,
      );

      // A child row's formerly empty inset is part of its one click target.
      await tester.tapAt(workgroupBounds.centerLeft + const Offset(8, 0));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'offline');
      // From a workgroup, the project row opens the project's chat and keeps
      // its workgroups shown; once more, Space hides them.
      Focus.of(tester.element(projectName)).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      expect(c.expandedProjects, {'lead'});
      Focus.of(tester.element(projectName)).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      expect(c.expandedProjects, isEmpty);
      expect(server.posts, isEmpty);
      await unmount(tester, c);
    },
  );

  testWidgets('project pull requests include its workgroups and stay scoped', (
    tester,
  ) async {
    final server = projectsServer(), c = server.controller();
    server.append(
      'Ready: https://github.com/example/lamp/pull/12',
      conversationId: 'offline',
    );
    server.append(
      'Design: https://github.com/example/design/pull/8',
      conversationId: 'design-lead',
    );
    await mount(tester, c);
    await tester.tap(find.byTooltip('Pull requests'));
    await tester.pumpAndSettle();
    expect(find.text('example/lamp #12'), findsOneWidget);
    expect(find.text('example/design #8'), findsNothing);
    expect(find.text('This project'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('super-group-design-lead')));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Pull requests'));
    await tester.pumpAndSettle();
    expect(find.text('example/design #8'), findsOneWidget);
    expect(find.text('example/lamp #12'), findsNothing);
    await unmount(tester, c);
  });

  testWidgets('a collapsed project keeps its workgroup attention visible', (
    tester,
  ) async {
    final server = projectsServer(), c = server.controller();
    server.state['agents'] = [
      {
        'id': 'worker',
        'name': 'Builder',
        'machineId': 'm',
        'harnessId': 'native',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
    ];
    final group = (server.state['conversations'] as List)[1] as Map;
    group['agentIds'] = ['worker'];
    group['assignment'] = {'status': 'needs_human', 'agentId': 'worker'};
    await mount(tester, c);
    expect(find.byKey(const ValueKey('super-group-offline')), findsNothing);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('super-group-lead')),
        matching: find.byTooltip('Needs a human'),
      ),
      findsOneWidget,
    );
    await unmount(tester, c);
  });

  testWidgets('compact project menu changes cadence for only that project', (
    tester,
  ) async {
    final server = projectsServer(), c = server.controller();
    await mount(tester, c);
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
    expect(find.byIcon(AppIcons.ellipsisVertical), findsOneWidget);
    await tester.tap(find.text('Update cadence'));
    await tester.pumpAndSettle();
    expect(find.text('Every 5 minutes'), findsOneWidget);
    await tester.tap(find.byType(DropdownButton<int>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Every 15 minutes').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(server.posts.single['command'], {
      'type': 'project.cadence',
      'projectId': 'lead',
      'minutes': 15,
    });
    expect(c.snapshot!.projectFor('lead')!.updateMinutes, 15);
    expect(c.snapshot!.projectFor('design-lead')!.updateMinutes, 5);
    await unmount(tester, c);
  });

  testWidgets(
    'public means swarm members and private is an explicit project choice',
    (tester) async {
      var visibility = 'public';
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) => ProjectVisibility(
                value: visibility,
                onChanged: (value) => setState(() => visibility = value),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Public'));
      await tester.pumpAndSettle();
      expect(find.text('Everyone in this swarm'), findsOneWidget);
      expect(
        find.text('Only people you invite to this project'),
        findsOneWidget,
      );
      await tester.tap(find.text('Private'));
      await tester.pumpAndSettle();
      expect(visibility, 'private');
      expect(find.text('Private'), findsOneWidget);
      expect(find.byIcon(AppIcons.lock), findsOneWidget);
      expect(
        find.byKey(const ValueKey('super-group-design-lead')),
        findsNothing,
      );
    },
  );

  test('project revocation removes cached text, drafts, terminals and expanded state', () async {
    final server = projectsServer(), c = server.controller();
    server.append('Private design', conversationId: 'design-lead');
    await c.refresh();
    await c.loadMessages('design-lead');
    c.select('design-lead');
    c.setDraft('design-lead', 'Private response');
    c.toggleProject('design');
    expect(c.messages('design-lead'), hasLength(1));
    (server.state['projects'] as List).removeLast();
    (server.state['conversations'] as List).removeLast();
    server.revision++;
    await c.refresh();
    await c.flush();
    expect(c.selectedId, 'lead');
    expect(c.messages('design-lead'), isEmpty);
    expect(c.draft('design-lead'), isEmpty);
    expect(c.expandedProjects, isNot(contains('design')));
    expect(
      (server.saved!['drafts'] as Map).containsKey('design-lead'),
      isFalse,
    );
    c.dispose();
  });

  test('internal consolidation requests do not appear as chat posts', () async {
    final server = projectsServer(), c = server.controller();
    server.append('Internal scheduled request');
    server.messages.last['source'] = {'kind': 'update-request'};
    server.append('Verification passed. Review is next.');
    server.messages.last['source'] = {'kind': 'project-report'};
    await c.refresh();
    expect(c.messages('lead').map((m) => m.text), [
      'Verification passed. Review is next.',
    ]);
    await c.flush();
    c.dispose();
  });
}
