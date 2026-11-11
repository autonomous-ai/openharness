import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Adds a project named [name] whose chat is `other-chat`.
void _secondProject(ConversationServer server, String name) {
  server.state['projects'] = [
    ...(server.state['projects'] as List?) ??
        [projectFixture('lead', server.state['name'] as String, 'lead')],
    projectFixture('other', name, 'other-chat'),
  ];
  (server.state['conversations'] as List).add({
    ...conversationFixture('other-chat', 'Lead'),
    'projectId': 'other',
  });
}

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
        'phase': 'answer',
        'truncated': true,
      };
      final controller = server.controller();
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabView(
              controller: controller,
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Builder'), findsOneWidget);
      expect(find.text('Terminal answer'), findsOneWidget);
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
    // A second project with a long name: the sidebar lists projects, not
    // tasks (task #2569).
    _secondProject(server, 'Offline editing across mobile and desktop');
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
    await tester.tap(find.byKey(const ValueKey('super-group-other-chat')));
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'other-chat');
    await controller.select('offline');
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'offline');
    expect(find.text('New group'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  });

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
