import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/instructions_panel.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _document =
    '## Roles\n\n### PM\n'
    '- Talks with people in the project chat and finds out what they want.\n';
const _editor = ValueKey('super-instructions-editor');

void main() {
  Future<(ConversationServer, SuperTabController)> mount(
    WidgetTester tester, {
    String account = 'owner',
    bool instructions = true,
    List<Map<String, dynamic>> messages = const [],
  }) async {
    final server = ConversationServer();
    server.messages.addAll(messages);
    if (messages.isNotEmpty) {
      (server.state['conversations'] as List)
              .cast<Map<String, dynamic>>()
              .firstWhere((g) => g['id'] == 'lead')['lastMessageSequence'] =
          messages.length;
    }
    server.state['projects'] = [
      {
        ...projectFixture('lead', 'Pilot', 'lead'),
        if (instructions) ...{
          'coordinatorName': 'Product Manager',
          'instructionsRevision': 3,
        },
      },
    ];
    (server.state['people'] as List).addAll([
      {'id': 'peer', 'email': 'peer@example.com', 'role': 'collaborator'},
      {'id': 'viewer', 'email': 'viewer@example.com', 'role': 'viewer'},
    ]);
    server.instructions['lead'] = {
      'projectId': 'lead',
      'revision': 3,
      'hash': 'hash-lead-3',
      'text': _document,
      'template': false,
      'coordinatorName': 'Product Manager',
      'notesRevision': 0,
      'notes': <dynamic>[],
    };
    final controller = server.controller(account: account);
    await controller.refresh();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (server, controller);
  }

  Finder menuItem(String label) => find.widgetWithText(AppMenuItem, label);

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
  }

  testWidgets('an older Swarm shows no Instructions', (tester) async {
    final (server, controller) = await mount(tester, instructions: false);
    await openMenu(tester);
    expect(menuItem('Project settings…'), findsOneWidget);
    expect(menuItem('Instructions'), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    server.instructionsRoute = false;
    unawaited(
      showSuperTabInstructions(
        tester.element(find.byType(SuperTabView)),
        controller,
        'lead',
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.text('This Swarm has no project instructions yet.'),
      findsOneWidget,
    );
    expect(find.byKey(_editor), findsNothing);
    expect(find.text('Try again'), findsNothing);
  });

  group('history and notes', () {
  });

  testWidgets('the fixture refuses what the backend refuses', (tester) async {
    final (server, _) = await mount(tester);
    var n = 0;
    // Straight to the server as the account, past the controller's own guards.
    Future<Object?> save(String account, Map<String, dynamic> over) async {
      final c = server.controller(account: account);
      addTearDown(c.dispose);
      try {
        return await c.request(
          'POST',
          '/api/super-tabs/tab/commands',
          body: {
            'operationId': 'fixture-check-${n++}',
            'command': {
              'type': 'instructions.save',
              'projectId': 'lead',
              'baseRevision': 3,
              'text': 'New text',
              'summary': 'Why',
              ...over,
            },
          },
        );
      } on SuperTabFailure catch (failure) {
        return failure.code;
      }
    }

    expect(await save('viewer', {}), 'READ_ONLY');
    for (final over in [
      {'text': ''},
      {'text': 'a' * 65537},
      {'text': 'é' * 32769},
      {'summary': ''},
      {'summary': 'a\nb'},
      {'summary': 'a' * 201},
    ]) {
      expect(await save('owner', over), 'VALIDATION_ERROR', reason: '$over');
    }
    expect(server.instructions['lead']!['revision'], 3);
    final same = await save('owner', {'text': _document}) as Map;
    expect((same['result'] as Map)['unchanged'], isTrue);
    expect(server.instructions['lead']!['revision'], 3);
    await save('owner', {'text': 'a' * 65536});
    expect(server.instructions['lead']!['revision'], 4);
  });
}
