import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

Map<String, dynamic> agent(String id, String name) => {
  'id': id,
  'projectId': 'web',
  'name': name,
  'machineId': 'm',
  'harnessId': id,
  'contributorId': 'owner',
  'configuration': {'engine': 'claude'},
};

/// A Swarm of three people with one public project, 'web', whose Lead 'pm'
/// and Builder 'atlas' work in the group 'work'.
ConversationServer swarm() {
  final server = ConversationServer();
  server.state['leadsConversationId'] = 'lead';
  server.state['projects'] = [projectFixture('web', 'Web', 'web-lead')];
  server.state['people'] = [
    {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    {'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'},
    {'id': 'kai', 'email': 'kai@example.com', 'role': 'viewer'},
  ];
  server.state['agents'] = <dynamic>[
    agent('pm', 'River'),
    agent('atlas', 'Atlas'),
  ];
  server.state['conversations'] = [
    {...conversationFixture('lead', 'Lead'), 'kind': 'leads'},
    {
      ...conversationFixture('web-lead', 'Web'),
      'projectId': 'web',
      'leadId': 'pm',
      'agentIds': ['pm'],
    },
    {
      ...conversationFixture('work', 'Sidebar glance'),
      'projectId': 'web',
      'number': 3,
      'agentIds': ['pm', 'atlas'],
    },
  ];
  return server;
}

List<String> readers(SuperTabController c, String id) => [
  for (final person in c.snapshot!.readersOf(c.snapshot!.conversation(id)!))
    person.id,
];

void main() {
  final composer = find.byKey(const ValueKey('super-message-composer'));
  final picker = find.byKey(const ValueKey('super-composer-completions'));

  test('a conversation is read by its private chat people, a private project\'s members and owner, or everyone; '
      'the Product Managers\' conversation names no person', () async {
    final server = swarm();
    final conversations = server.state['conversations'] as List;
    conversations.add({
      ...conversationFixture('chat', 'dee'),
      'projectId': 'web',
      'audience': {
        'people': [
          {'id': 'dee', 'generation': 'g1'},
        ],
      },
    });
    // Dee reads her own private chat; nobody else sees it.
    final c = server.controller(account: 'dee');
    addTearDown(c.dispose);
    await c.refresh();
    expect(readers(c, 'work'), ['owner', 'dee', 'kai']);
    expect(readers(c, 'chat'), ['dee']);
    expect(readers(c, 'lead'), isEmpty);

    server.state['projects'] = [
      {
        ...projectFixture('web', 'Web', 'web-lead', visibility: 'private'),
        'members': [
          {'id': 'kai', 'generation': 'g1'},
        ],
      },
    ];
    await c.refresh();
    expect(readers(c, 'work'), ['owner', 'kai']);
  });

  Future<(ConversationServer, SuperTabController)> show(
    WidgetTester tester,
  ) async {
    // The picker takes a third of the window's height: room for four rows.
    tester.view
      ..physicalSize = const Size(1200, 900)
      ..devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final server = swarm();
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    c.select('work');
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (server, c);
  }

  testWidgets(
    '@ suggests the agents, then the people who read it but not the writer; '
    'a person goes as a mention, an agent as a recipient',
    (tester) async {
      final (server, c) = await show(tester);
      await tester.enterText(composer, '@');
      await tester.pump();
      expect(
        find.descendant(of: picker, matching: find.text('River')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: picker, matching: find.text('Atlas')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: picker, matching: find.text('dee')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: picker, matching: find.text('kai')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: picker, matching: find.text('owner')),
        findsNothing,
      );
      final top = tester.getTopLeft;
      expect(
        top(find.descendant(of: picker, matching: find.text('Atlas'))).dy,
        lessThan(
          top(find.descendant(of: picker, matching: find.text('dee'))).dy,
        ),
      );

      await tester.enterText(composer, 'Can you check the copy @dee');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.draft('work'), 'Can you check the copy @dee ');
      await tester.enterText(composer, 'Can you check the copy @dee and @At');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      final sent = server.posts.single['command'] as Map;
      expect(sent['text'], 'Can you check the copy @dee and @Atlas');
      expect(sent['recipientIds'], ['atlas']);
      expect(sent['mentions'], ['dee']);
      // The draft saves 200 ms after its last change.
      await tester.pump(const Duration(milliseconds: 250));
    },
  );

  testWidgets('six agents still leave the readers reachable by keyboard', (
    tester,
  ) async {
    final (server, c) = await show(tester);
    for (var i = 1; i <= 5; i++) {
      (server.state['agents'] as List).add(agent('helper-$i', 'Helper $i'));
      final work = (server.state['conversations'] as List).last as Map;
      work['agentIds'] = [...work['agentIds'] as List, 'helper-$i'];
    }
    await c.refresh();
    await tester.pumpAndSettle();
    await tester.enterText(composer, '@');
    await tester.pump();
    // Six agents, then dee and kai: the eighth row is kai.
    for (var i = 0; i < 7; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump();
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(c.draft('work'), '@kai ');
    await tester.pump(const Duration(milliseconds: 250));
  });

  testWidgets('a mention the server refuses shows its reason', (tester) async {
    final (server, c) = await show(tester);
    await tester.enterText(composer, '@ka');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    server.refuse = {
      'code': 'INVALID_MENTION',
      'message': 'kai@example.com cannot read this conversation.',
    };
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect((server.posts.single['command'] as Map)['mentions'], ['kai']);
    expect(
      find.text('kai@example.com cannot read this conversation.'),
      findsOneWidget,
    );
    expect(c.draft('work'), '@kai ');
  });
}
