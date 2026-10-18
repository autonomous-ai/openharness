import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  testWidgets(
    'native observations keep their agent author and show source and truncation clearly',
    (tester) async {
      final server = ConversationServer();
      server.append('Adjust the native implementation.');
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'builder',
        'name': 'Builder',
      };
      server.messages.last['source'] = {
        'kind': 'native',
        'phase': 'prompt',
        'operator': {'name': 'peer@example.com'},
        'truncated': true,
      };
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
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Builder'), findsOneWidget);
      expect(
        find.text('Terminal input · session opened by peer@example.com'),
        findsOneWidget,
      );
      expect(
        find.text('Excerpt · open the terminal for the full response'),
        findsOneWidget,
      );
      expect(find.text('Adjust the native implementation.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );
  testWidgets('archived conversations remain searchable and can be reopened', (
    tester,
  ) async {
    final server = ConversationServer();
    (server.state['conversations'] as List)[1]['archived'] = true;
    server.append('Verified the offline result.', conversationId: 'offline');
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
    expect(find.byKey(const ValueKey('super-group-offline')), findsNothing);
    await tester.tap(find.byTooltip('Conversation options'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Archived conversations'));
    await tester.pumpAndSettle();
    final search = find.descendant(
      of: find.byType(Dialog),
      matching: find.byType(TextField),
    );
    await tester.enterText(search, 'offline');
    await tester.pumpAndSettle();
    await tester.tap(find.text('Offline editing'));
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'offline');
    expect(find.text('Verified the offline result.'), findsOneWidget);
    expect(
      tester
          .widget<TextField>(
            find.byKey(const ValueKey('super-message-composer')),
          )
          .enabled,
      isFalse,
    );
    await tester.tap(find.byTooltip('Conversation options'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reopen conversation'));
    await tester.pumpAndSettle();
    expect(server.posts.single['command'], {
      'type': 'conversation.archive',
      'conversationId': 'offline',
      'archived': false,
    });
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  });

  testWidgets(
    'large text and a short window preserve navigation and creation',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(800, 480));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = Brightness.light;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      final server = ConversationServer();
      (server.state['conversations'] as List)[1]['title'] =
          'Offline editing across mobile and desktop';
      final controller = server.controller();
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
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
      expect(tester.takeException(), isNull);
      if (find.byTooltip('Conversations').evaluate().isNotEmpty) {
        await tester.tap(find.byTooltip('Conversations'));
        await tester.pumpAndSettle();
      }
      await tester.tap(find.text('New group'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Create'))
            .onPressed,
        isNull,
      );
      final name = find.descendant(
        of: find.byType(Dialog),
        matching: find.byType(TextField),
      );
      await tester.enterText(name, 'Device testing');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Create'));
      await tester.pumpAndSettle();
      expect(controller.selected?.title, 'Device testing');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );

  testWidgets(
    'the narrow sidebar owns keyboard focus and Escape returns to the draft',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(600, 520));
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
      final composer = find.byKey(const ValueKey('super-message-composer'));
      await tester.enterText(composer, 'Keep this draft');
      await tester.tap(find.byTooltip('Conversations'));
      await tester.pumpAndSettle();
      final field = tester.widget<TextField>(composer);
      expect(field.focusNode!.hasFocus, isFalse);
      for (var step = 0; step < 8; step++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        expect(field.focusNode!.hasFocus, isFalse);
      }
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-group-offline')), findsNothing);
      expect(field.focusNode!.hasFocus, isTrue);
      expect(field.controller!.text, 'Keep this draft');
      expect(server.posts, isEmpty);
      await tester.tap(find.byTooltip('Conversations'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-group-offline')));
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'offline');
      expect(field.focusNode!.hasFocus, isTrue);
      expect(controller.draft('lead'), 'Keep this draft');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );

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
      final invite = tester.getCenter(find.text('Invite'));
      final create = tester.getCenter(find.text('New group'));
      expect(invite.dy >= create.dy, isTrue);
      if (invite.dy == create.dy) expect(invite.dx, greaterThan(create.dx));
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );

  for (final rename in [false, true]) {
    testWidgets(
      '${rename ? 'Rename' : 'New group'} clears its form when account access ends',
      (tester) async {
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
        if (rename) {
          await tester.tap(find.byTooltip('Conversation options'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('Rename'));
        } else {
          await tester.tap(find.text('New group'));
        }
        await tester.pumpAndSettle();
        final field = find.descendant(
          of: find.byType(Dialog),
          matching: find.byType(TextField),
        );
        await tester.enterText(field, 'Private draft for previous account');
        controller.revokeAccess('Account changed.');
        await tester.pumpAndSettle();
        expect(find.text('Private draft for previous account'), findsNothing);
        expect(find.text(rename ? 'Save' : 'Create'), findsNothing);
        expect(server.posts, isEmpty);
        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
        await controller.flush();
        controller.dispose();
      },
    );
  }

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
      await tester.binding.setSurfaceSize(const Size(800, 700));
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
