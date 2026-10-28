import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/roles_editor.dart';

import 'support/super_tab_fixture.dart';
import 'support/capture.dart';

class _RolesServer extends ConversationServer {
  final texts = <String, String>{};
  final textReads = <String>[];

  Map<String, dynamic> get project =>
      (state['projects'] as List).cast<Map<String, dynamic>>().single;

  void seedRoles() {
    project['skillSet'] = 'custom';
    project['skillMode'] = 'default';
    project['roles'] = [
      {
        'id': 'lead',
        'name': 'Product Manager',
        'kind': 'lead',
        'version': 'v1',
      },
      {'id': 'dev', 'name': 'Engineer', 'kind': 'builder', 'version': 'v1'},
      {'id': 'review', 'name': 'Reviewer', 'kind': 'reviewer', 'version': 'v1'},
    ];
    texts.addAll({
      'lead': '# Lead',
      'dev': '# Engineer',
      'review': '# Reviewer',
    });
  }

  @override
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (method == 'GET' && path.contains('/projects/lead/roles/')) {
      textReads.add(path);
      final id = Uri.parse(path).pathSegments.last;
      return {'version': 'v1', 'text': texts[id]};
    }
    if (method == 'POST' && body?['command'] is Map && refuse == null) {
      final command = (body!['command'] as Map).cast<String, dynamic>();
      final roles = (project['roles'] as List?)
          ?.map((entry) => Map<String, dynamic>.from(entry as Map))
          .toList();
      switch (command['type']) {
        case 'project.roles.create' || 'project.roles.reset':
          project['roles'] = [
            for (final raw in command['roles'] as List)
              {
                'id': raw['id'],
                'name': raw['name'],
                'kind': raw['kind'],
                'version': 'v1',
              },
          ];
          texts
            ..clear()
            ..addEntries(
              (command['roles'] as List).map(
                (raw) => MapEntry(raw['id'] as String, raw['text'] as String),
              ),
            );
          revision++;
        case 'project.role.set':
          final role = (command['role'] as Map).cast<String, dynamic>();
          roles!.removeWhere((entry) => entry['id'] == role['id']);
          roles.add({
            'id': role['id'],
            'name': role['name'],
            'kind': role['kind'],
            'version': 'v2',
          });
          project['roles'] = roles;
          texts[role['id'] as String] = role['text'] as String;
          revision++;
        case 'project.role.remove':
          roles!.removeWhere((entry) => entry['id'] == command['roleId']);
          project['roles'] = roles;
          texts.remove(command['roleId']);
          revision++;
        case 'project.skills':
          project['skillSet'] = command['mode'];
          project['skillMode'] = command['mode'] == 'custom'
              ? 'default'
              : command['mode'];
          revision++;
      }
    }
    return super.request(method, path, body: body);
  }
}

void main() {
  final captureDir = Platform.environment['HARNESS_CUSTOM_ROLES_CAPTURE'];
  setUpAll(() => loadCaptureFonts(captureDir));

  test(
    'custom set starts with the shipped Default skill texts byte for byte',
    () {
      final source = File('../cli/src/lib/swarmSkills.ts').readAsStringSync();
      final sections = source.split(
        RegExp(r'const defaults: Record<.*?, string> = \{'),
      );
      expect(sections, hasLength(2));
      final defaults = sections.last;
      final roles = {
        for (final role in defaultProjectRoles()) role['id']!: role['text']!,
      };
      for (final id in ['lead', 'dev', 'review']) {
        final match = RegExp(
          '  $id: '
          r'`([\s\S]*?)`,',
        ).firstMatch(defaults);
        expect(match, isNotNull, reason: 'CLI Default $id text is missing');
        expect(
          roles[id],
          match!.group(1),
          reason: '$id differs from CLI Default',
        );
      }
    },
  );

  Future<_RolesServer> mount(
    WidgetTester tester, {
    String account = 'owner',
    String? skillMode,
    bool custom = false,
  }) async {
    final server = _RolesServer();
    final project = projectFixture('lead', 'Pilot', 'lead');
    if (skillMode != null) project['skillMode'] = skillMode;
    server.state['projects'] = [project];
    if (custom) server.seedRoles();
    if (account != 'owner') {
      (server.state['people'] as List).add({
        'id': account,
        'email': '$account@example.com',
        'role': 'collaborator',
      });
    }
    final controller = server.controller(account: account);
    await controller.refresh();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return server;
  }

  Future<void> openInstructions(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(MenuItemButton, 'Instructions'));
    await tester.pumpAndSettle();
  }

  testWidgets('owner changes a legacy project from orchestration to Default', (
    tester,
  ) async {
    final server = await mount(tester);
    await openInstructions(tester);
    expect(find.text('Instructions for this project'), findsOneWidget);
    expect(find.text('Instructions'), findsOneWidget);
    expect(
      find.textContaining(RegExp('skill', caseSensitive: false)),
      findsNothing,
    );
    expect(
      find.text(
        'Default — the team process; agents otherwise work their usual way',
      ),
      findsOneWidget,
    );
    expect(
      find.text(
        'Harness orchestration — adds Harness practices: plans, test-first, review rounds',
      ),
      findsOneWidget,
    );
    expect(
      tester
          .widget<RadioGroup<String>>(find.byType(RadioGroup<String>))
          .groupValue,
      'orchestration',
    );
    await tester.tap(
      find.text(
        'Default — the team process; agents otherwise work their usual way',
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(server.posts.single['command'], {
      'type': 'project.skills',
      'projectId': 'lead',
      'mode': 'default',
    });
  });

  testWidgets(
    'owner sees Default selected for a project already in that mode',
    (tester) async {
      final server = await mount(tester, skillMode: 'default');
      await openInstructions(tester);
      expect(
        tester
            .widget<RadioGroup<String>>(find.byType(RadioGroup<String>))
            .groupValue,
        'default',
      );
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(server.posts, isEmpty);
    },
  );

  testWidgets('collaborator does not see Instructions in the project menu', (
    tester,
  ) async {
    final server = await mount(tester, account: 'peer');
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(MenuItemButton, 'Instructions'), findsNothing);
    expect(server.posts, isEmpty);
  });

  test('project reads the custom set and stable role ids', () {
    final project = SuperTabProject.fromJson({
      ...projectFixture('lead', 'Pilot', 'lead'),
      'skillSet': 'custom',
      'skillMode': 'default',
      'roles': [
        {
          'id': 'lead',
          'name': 'Coordinator',
          'kind': 'lead',
          'version': 'abcd',
        },
      ],
    });
    expect((project as dynamic).skillSet, 'custom');
    expect((project as dynamic).roles.single.name, 'Coordinator');
  });

  testWidgets('owner creates a custom set before Custom can be selected', (
    tester,
  ) async {
    final server = await mount(tester, skillMode: 'default');
    await openInstructions(tester);
    expect(
      tester
          .widget<RadioListTile<String>>(
            find.widgetWithText(RadioListTile<String>, 'Custom'),
          )
          .enabled,
      isFalse,
    );
    await tester.tap(find.text('Create custom set'));
    await tester.pumpAndSettle();
    final create = server.posts.single['command'] as Map;
    expect(create['type'], 'project.roles.create');
    expect((create['roles'] as List).map((role) => role['id']), [
      'lead',
      'dev',
      'review',
    ]);
    expect((create['roles'] as List).map((role) => role['kind']), [
      'lead',
      'builder',
      'reviewer',
    ]);
    for (final role in create['roles'] as List) {
      expect((role['text'] as String).length, greaterThan(500));
    }
    expect(
      tester
          .widget<RadioListTile<String>>(
            find.widgetWithText(RadioListTile<String>, 'Custom'),
          )
          .enabled,
      isTrue,
    );
    await tester.tap(find.text('Custom'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(server.posts.last['command'], {
      'type': 'project.skills',
      'projectId': 'lead',
      'mode': 'custom',
    });
  });

  testWidgets('owner opens role editor; the lead role cannot be deleted', (
    tester,
  ) async {
    if (captureDir != null) {
      tester.view.physicalSize = const Size(1440, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
    }
    final server = await mount(tester, custom: true);
    await openInstructions(tester);
    await captureWindow(tester, captureDir, 'custom-skills');
    await tester.tap(find.text('Edit custom roles'));
    await tester.pumpAndSettle();
    await captureWindow(tester, captureDir, 'custom-roles-editor');
    expect(find.text('Custom roles'), findsOneWidget);
    expect(find.text('Product Manager'), findsWidgets);
    expect(find.text('Engineer'), findsWidgets);
    expect(find.text('Reviewer'), findsWidgets);
    expect(
      server.textReads,
      contains('/api/super-tabs/tab/projects/lead/roles/lead'),
    );
    expect(find.text('# Lead'), findsOneWidget);
    expect(find.byKey(const ValueKey('role-delete-lead')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('role-edit-lead')));
    await tester.pumpAndSettle();
    expect(find.text('Product Manager instructions'), findsOneWidget);
    expect(
      find.textContaining(RegExp('skill', caseSensitive: false)),
      findsNothing,
    );
    await captureWindow(tester, captureDir, 'custom-role-instructions');
  });

  testWidgets('backend refusal is shown when removing a role in use', (
    tester,
  ) async {
    final server = await mount(tester, custom: true);
    await openInstructions(tester);
    await tester.tap(find.text('Edit custom roles'));
    await tester.pumpAndSettle();
    server.refuse = {
      'code': 'ROLE_IN_USE',
      'message': 'Stop or reassign the 2 agents with this role first.',
    };
    await tester.tap(find.byKey(const ValueKey('role-delete-dev')));
    await tester.pumpAndSettle();
    expect(
      find.text('Stop or reassign the 2 agents with this role first.'),
      findsWidgets,
    );
  });

  testWidgets('owner edits a role name and Markdown text', (tester) async {
    final server = await mount(tester, custom: true);
    await openInstructions(tester);
    await tester.tap(find.text('Edit custom roles'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('role-edit-dev')));
    await tester.pumpAndSettle();
    expect(find.text('Engineer instructions'), findsOneWidget);
    await tester.enterText(
      find.byKey(const ValueKey('role-name')),
      'Research Engineer',
    );
    await tester.pump();
    expect(find.text('Research Engineer instructions'), findsOneWidget);
    await tester.enterText(
      find.byKey(const ValueKey('role-text')),
      '# Research work',
    );
    await tester.pump();
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Save role'))
          .onPressed,
      isNotNull,
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Save role'));
    await tester.pumpAndSettle();
    expect(server.posts.last['command'], {
      'type': 'project.role.set',
      'projectId': 'lead',
      'role': {
        'id': 'dev',
        'name': 'Research Engineer',
        'kind': 'builder',
        'text': '# Research work',
      },
    });
    expect(find.text('Research Engineer'), findsOneWidget);
  });

  testWidgets('owner adds a named reviewer role with a stable id', (
    tester,
  ) async {
    final server = await mount(tester, custom: true);
    await openInstructions(tester);
    await tester.tap(find.text('Edit custom roles'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add role'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('role-text')))
          .decoration
          ?.labelText,
      'Instructions',
    );
    await tester.enterText(
      find.byKey(const ValueKey('role-name')),
      'Security Reviewer',
    );
    await tester.pump();
    expect(find.text('Security Reviewer instructions'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('role-kind')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reviewer').last);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('role-text')),
      '# Review security',
    );
    await tester.pump();
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Save role'))
          .onPressed,
      isNotNull,
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Save role'));
    await tester.pumpAndSettle();
    final command = server.posts.last['command'] as Map;
    expect(command['type'], 'project.role.set');
    expect((command['role'] as Map)['id'], matches(RegExp(r'^[0-9a-f]{12}$')));
    expect((command['role'] as Map)['kind'], 'reviewer');
    expect((command['role'] as Map)['text'], '# Review security');
  });

  testWidgets('Reset to Default confirms before replacing all custom roles', (
    tester,
  ) async {
    final server = await mount(tester, custom: true);
    await openInstructions(tester);
    await tester.tap(find.text('Edit custom roles'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reset to Default'));
    await tester.pumpAndSettle();
    expect(find.text('Reset custom roles to Default?'), findsOneWidget);
    expect(
      find.text(
        'This replaces every custom role and its instructions. Agents using removed roles may need to stop or be reassigned first.',
      ),
      findsOneWidget,
    );
    expect(server.posts, isEmpty);
    await tester.tap(find.widgetWithText(FilledButton, 'Reset'));
    await tester.pumpAndSettle();
    final command = server.posts.single['command'] as Map;
    expect(command['type'], 'project.roles.reset');
    expect((command['roles'] as List).map((role) => role['id']), [
      'lead',
      'dev',
      'review',
    ]);
    expect((command['roles'] as List).map((role) => role['name']), [
      'Product Manager',
      'Engineer',
      'Reviewer',
    ]);
  });
}
