import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  testWidgets(
    'flat sidebar keeps local actions in its footer without repeating the app tab name',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1100, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer();
      final controller = server.controller();
      await controller.refresh();
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
      expect(find.text('Pilot'), findsNothing);
      expect(find.text('CHATS'), findsNothing);
      expect(find.byKey(const ValueKey('super-group-lead')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-group-offline')), findsOneWidget);
      expect(
        tester.getCenter(find.text('New group')).dy,
        greaterThan(
          tester
              .getCenter(find.byKey(const ValueKey('super-group-offline')))
              .dy,
        ),
      );
      expect(
        tester.getCenter(find.text('Invite')).dx,
        greaterThan(tester.getCenter(find.text('New group')).dx),
      );
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );

  testWidgets(
    '20 people remain a count and Add agent targets the selected group',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1100, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer();
      (server.state['people'] as List).addAll(
        List.generate(
          19,
          (i) => {
            'id': 'person-${i + 1}',
            'email': 'person${i + 1}@example.com',
            'role': 'collaborator',
          },
        ),
      );
      server.state['agents'] = List.generate(
        3,
        (i) => {
          'id': 'agent-$i',
          'name': 'Worker $i',
          'machineId': 'host-$i',
          'harnessId': 'session-$i',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      );
      (server.state['conversations'] as List)[1]['agentIds'] = [
        'agent-0',
        'agent-1',
        'agent-2',
      ];
      final controller = server.controller();
      await controller.refresh();
      controller.select('offline');
      SuperTabConversation? target;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabView(
              controller: controller,
              onInvite: () {},
              onAddAgent: (group) => target = group,
              onOpenTerminal: (_) {},
              machineName: (_) => 'Test Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('3 agents · 20 people'), findsOneWidget);
      expect(find.text('Worker 0'), findsNothing);
      await tester.tap(find.text('3 agents · 20 people'));
      await tester.pumpAndSettle();
      final search = find.descendant(
        of: find.byType(Dialog),
        matching: find.byType(TextField),
      );
      await tester.enterText(search, 'person19');
      await tester.pumpAndSettle();
      expect(find.text('person19@example.com'), findsOneWidget);
      expect(find.text('person1@example.com'), findsNothing);
      await tester.tap(find.text('Add agent'));
      await tester.pumpAndSettle();
      expect(target?.id, 'offline');
      expect(controller.snapshot!.conversations, hasLength(2));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );

  testWidgets(
    'a native terminal sits beside the conversation and uses a return action when narrow',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1100, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer()..append('Review this result.');
      final controller = server.controller();
      await controller.refresh();
      var closed = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabView(
              controller: controller,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Test Mac',
              terminal: const Center(child: Text('Native terminal fixture')),
              onCloseTerminal: () => closed = true,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getCenter(find.text('Native terminal fixture')).dx,
        greaterThan(tester.getCenter(find.text('Review this result.')).dx),
      );
      await tester.binding.setSurfaceSize(const Size(580, 700));
      await tester.pumpAndSettle();
      expect(find.text('Back to conversation'), findsOneWidget);
      expect(find.text('Review this result.'), findsNothing);
      await tester.tap(find.text('Back to conversation'));
      expect(closed, isTrue);
      expect(
        server.posts,
        isEmpty,
        reason: 'Hiding a terminal never sends a process-stop command.',
      );
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );

  testWidgets(
    'Enter respects IME composition and sends into the selected conversation',
    (tester) async {
      final server = ConversationServer();
      final controller = server.controller();
      await controller.refresh();
      controller.select('offline');
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
      final field = find.byKey(const ValueKey('super-message-composer'));
      await tester.tap(field);
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'Draft',
          selection: TextSelection.collapsed(offset: 5),
          composing: TextRange(start: 0, end: 5),
        ),
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(server.posts, isEmpty);
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'Draft',
          selection: TextSelection.collapsed(offset: 5),
        ),
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
      expect(
        (server.posts.single['command'] as Map)['conversationId'],
        'offline',
      );
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );
}
