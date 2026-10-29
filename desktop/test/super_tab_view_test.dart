import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/shared/widgets/app_icon_button.dart';

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
  testWidgets(
    'older archived conversations stay reachable behind newer closed ones',
    (tester) async {
      final server = ConversationServer()..parts.dormantPage = 1;
      (server.state['conversations'] as List)[1]['archived'] = true;
      // Finished later and quiet: closed, not archived, and newer.
      (server.state['conversations'] as List).add({
        ...conversationFixture('finished', 'Finished work'),
        'dormant': true,
      });
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
      Future<void> openList() async {
        await tester.tap(find.byTooltip('Project options'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Archived conversations'));
        await tester.pumpAndSettle();
      }

      final earlier = find.byKey(const ValueKey('super-archived-earlier'));
      await openList();
      // The first page holds only the newer closed group: nothing archived
      // shows, and paging is still there, whatever the search.
      expect(find.text('Offline editing'), findsNothing);
      await tester.enterText(
        find.descendant(
          of: find.byType(Dialog),
          matching: find.byType(TextField),
        ),
        'offline',
      );
      await tester.pumpAndSettle();
      expect(earlier, findsOneWidget);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      // Another page exists: the menu keeps the list.
      await openList();
      await tester.tap(earlier);
      await tester.pumpAndSettle();
      expect(find.text('Offline editing'), findsOneWidget);
      expect(earlier, findsNothing);
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
    await tester.tap(find.byTooltip('Project options'));
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
    expect(find.byKey(const ValueKey('super-message-composer')), findsNothing);
    await tester.tap(find.byTooltip('Workgroup options'));
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

  testWidgets('large text and a short window preserve group navigation', (
    tester,
  ) async {
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
    await tester.tap(find.byKey(const ValueKey('super-project-toggle-lead')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('super-group-offline')));
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'offline');
    expect(find.text('New group'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  });

  testWidgets(
    'on a phone the roster drawer leaves 30% of the screen to tap closed',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 720));
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
      await tester.tap(find.byTooltip('Members and machines'));
      await tester.pumpAndSettle();
      final roster = find.byType(SuperTabRoster);
      expect(tester.getSize(roster).width, 360 * 0.7);
      await tester.tapAt(const Offset(40, 360));
      await tester.pumpAndSettle();
      expect(roster, findsNothing);
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
      await tester.tap(find.byKey(const ValueKey('super-project-toggle-lead')));
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

  testWidgets('projects stay collapsed and creation remains in the sidebar', (
    tester,
  ) async {
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
            onNewProject: () {},
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Pilot'), findsOneWidget);
    expect(find.text('# Pilot'), findsOneWidget);
    expect(find.text('CHATS'), findsNothing);
    expect(find.byKey(const ValueKey('super-group-lead')), findsOneWidget);
    expect(find.byKey(const ValueKey('super-group-offline')), findsNothing);
    expect(find.text('New group'), findsNothing);
    expect(find.byTooltip('New project'), findsOneWidget);
    expect(find.byTooltip('Invite people'), findsOneWidget);
    expect(
      tester.getCenter(find.byTooltip('Invite people')).dx,
      greaterThan(800),
    );
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  });

  for (final rename in [true]) {
    testWidgets(
      '${rename ? 'Rename' : 'New group'} clears its form when account access ends',
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
        if (rename) {
          await tester.tap(find.byTooltip('Workgroup options'));
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
    'global roster stays scrollable with 20 people and opens agent details',
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
      SuperTabAgent? target;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabView(
              controller: controller,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (agent) => target = agent,
              machineName: (_) => 'Test Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('People'), findsOneWidget);
      final member = find.byKey(const ValueKey('super-member-agent-0'));
      await tester.scrollUntilVisible(
        member,
        150,
        scrollable: find
            .descendant(
              of: find.byType(SuperTabRoster),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(member);
      await tester.pumpAndSettle();
      await tester.tap(member);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Open terminal'));
      await tester.pumpAndSettle();
      expect(target?.id, 'agent-0');
      expect(find.byType(Dialog), findsNothing);
      expect(controller.snapshot!.conversations, hasLength(2));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );

  testWidgets(
    'native terminals fill the middle, preserve both sidebars, and return to chat',
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
      expect(find.text('Native terminal fixture'), findsOneWidget);
      expect(find.text('Review this result.'), findsNothing);
      expect(find.byKey(const ValueKey('super-group-lead')), findsOneWidget);
      expect(find.byType(SuperTabRoster), findsOneWidget);
      expect(
        tester
            .widget<AppIconButton>(
              find.byKey(const ValueKey('super-terminals')),
            )
            .selected,
        isTrue,
      );
      expect(
        tester
            .widget<AppIconButton>(find.byKey(const ValueKey('super-chat')))
            .selected,
        isFalse,
      );
      expect(
        tester
            .widget<AppIconButton>(
              find.byKey(const ValueKey('super-pull-requests')),
            )
            .selected,
        isFalse,
      );
      expect(find.byTooltip('Conversation options'), findsNothing);
      await tester.binding.setSurfaceSize(const Size(800, 700));
      await tester.pumpAndSettle();
      expect(find.text('Native terminal fixture'), findsOneWidget);
      await tester.tap(find.byTooltip('Chat'));
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
