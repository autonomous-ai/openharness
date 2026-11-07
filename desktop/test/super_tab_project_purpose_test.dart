import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_options.dart';

import 'support/super_tab_fixture.dart';

/// What a project is (task #4541, spec 2026-11-07-members-and-leads section 1): one plain line, at most 80 characters,
/// set in Project settings by the project's owner; the Cmd-N and Join project lists show it.
void main() {
  Future<(SuperTabController, List<Map<String, dynamic>>)> open(
    WidgetTester tester, {
    String accountId = 'owner',
    String? about,
  }) async {
    final server = ConversationServer();
    server.state['projects'] = [
      {...projectFixture('lead', 'lamp', 'lead'), 'about': ?about},
    ];
    final sent = <Map<String, dynamic>>[];
    final c = SuperTabController(
      tabId: 'tab',
      accountId: accountId,
      request: (method, path, {body}) async {
        if (body?['command'] case final Map<String, dynamic> command) {
          sent.add(command);
        }
        return server.request(method, path, body: body);
      },
      save: server.save,
      upload: server.upload,
      initial: const {},
      pollInterval: Duration.zero,
    );
    addTearDown(c.dispose);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showProjectAction(
                context,
                c,
                c.snapshot!.projects.first,
                'about',
              ),
              child: const Text('Open purpose'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open purpose'));
    await tester.pumpAndSettle();
    return (c, sent);
  }

  testWidgets('the project reads its purpose from the Swarm', (tester) async {
    final (c, _) = await open(tester, about: 'lampOS, the voice lamp');
    expect(c.snapshot!.projects.first.about, 'lampOS, the voice lamp');
  });

  testWidgets('its owner sets one line, at most 80, saved with its own '
      'command', (tester) async {
    final (_, sent) = await open(tester, about: 'Old line');
    expect(find.text('Purpose'), findsOneWidget);
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.maxLength, 80);
    expect(field.maxLines, 1);
    await tester.enterText(find.byType(TextField), '  lampOS, the voice lamp ');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(sent.where((c) => c['type'] == 'project.about'), [
      {
        'type': 'project.about',
        'projectId': 'lead',
        'about': 'lampOS, the voice lamp',
      },
    ]);
  });

  testWidgets('an empty line clears it', (tester) async {
    final (_, sent) = await open(tester, about: 'Old line');
    await tester.enterText(find.byType(TextField), '');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(sent.singleWhere((c) => c['type'] == 'project.about')['about'], '');
  });

  testWidgets('someone who does not own it cannot save', (tester) async {
    final (_, sent) = await open(tester, accountId: 'tuan');
    final save = find.widgetWithText(FilledButton, 'Save');
    // No dialog at all, or one whose Save is off.
    if (save.evaluate().isNotEmpty) {
      expect(tester.widget<FilledButton>(save).onPressed, isNull);
    }
    expect(sent.where((c) => c['type'] == 'project.about'), isEmpty);
  });
}
