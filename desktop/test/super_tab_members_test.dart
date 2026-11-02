import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Quiet Swarm, screens 4 and 5 (Dee, 2026-11-02): the right column opens
/// only from Members, its rows are one line each, and a click opens a card.
void main() {
  Future<SuperTabController> mountView(
    WidgetTester tester,
    ConversationServer server, {
    Size size = const Size(1440, 900),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller();
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
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
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    });
    return controller;
  }

  final members = find.byKey(const ValueKey('super-members-button'));
  final close = find.byKey(const ValueKey('super-members-close'));

  group('the right column', () {
    testWidgets('is closed at rest in a wide window', (tester) async {
      await mountView(tester, ConversationServer());
      expect(find.byType(SuperTabRoster), findsNothing);
      expect(members, findsOneWidget);
      expect(find.byTooltip('Members'), findsOneWidget);
    });

    testWidgets('Members opens it beside the chat and its close shuts it', (
      tester,
    ) async {
      await mountView(tester, ConversationServer());
      await tester.tap(members);
      await tester.pumpAndSettle();
      final roster = find.byType(SuperTabRoster);
      expect(roster, findsOneWidget);
      // Docked at the right, not a drawer over the chat.
      expect(tester.getTopRight(roster).dx, 1440);
      expect(
        find.byKey(const ValueKey('super-message-composer')),
        findsOneWidget,
      );
      await tester.tap(close);
      await tester.pumpAndSettle();
      expect(roster, findsNothing);
      // Members again opens it again.
      await tester.tap(members);
      await tester.pumpAndSettle();
      expect(roster, findsOneWidget);
      await tester.tap(members);
      await tester.pumpAndSettle();
      expect(roster, findsNothing);
    });

    testWidgets('Members takes the right side from an open thread', (
      tester,
    ) async {
      final server = ConversationServer()..append('Root of a thread');
      final controller = await mountView(tester, server);
      controller.openThread(server.messages.last['id'] as String);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-thread-panel')), findsOneWidget);
      await tester.tap(members);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-thread-panel')), findsNothing);
      expect(find.byType(SuperTabRoster), findsOneWidget);
      // And a thread opened again takes it back.
      controller.openThread(server.messages.last['id'] as String);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-thread-panel')), findsOneWidget);
      expect(find.byType(SuperTabRoster), findsNothing);
      controller.closeThread();
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabRoster), findsNothing);
    });

    testWidgets('a narrow window opens it as a drawer with the same close', (
      tester,
    ) async {
      await mountView(tester, ConversationServer(), size: const Size(900, 700));
      expect(find.byType(SuperTabRoster), findsNothing);
      await tester.tap(members);
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabRoster), findsOneWidget);
      await tester.tap(close);
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabRoster), findsNothing);
    });
  });
}
