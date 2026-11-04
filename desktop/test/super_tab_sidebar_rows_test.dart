import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// The sidebar's rows: a Buddy chat click highlights only that row; a
/// project's row opens its chat, every click, and lists no tasks (task
/// #2569: they are in the project's Tasks view); in Manage, a machine click
/// expands it, and its details are in the right-click menu.
void main() {
  final dm = find.byKey(const ValueKey('super-buddy-lead'));
  final project = find.byKey(const ValueKey('super-group-lead'));
  final workgroup = find.byKey(const ValueKey('super-group-offline'));
  final machine = find.byKey(const ValueKey('super-machine-studio'));

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1300, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller(
      account: 'peer',
      initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
    );
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Studio',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController controller) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }

  Finder chevronIn(Finder row) => find.descendant(
    of: row,
    matching: find.byWidgetPredicate(
      (w) =>
          w is Icon &&
          (w.icon == AppIcons.chevronRight || w.icon == AppIcons.chevronDown),
    ),
  );

  testWidgets('a Buddy chat click highlights only that row', (tester) async {
    final controller = await show(tester, humansSwarm());
    // Its chat exists already: opening it again is a plain selection.
    await controller.openBuddyChat('lead');
    await controller.select('lead');
    await tester.pumpAndSettle();

    await tester.tap(dm);
    await tester.pumpAndSettle();
    expect(controller.selectedId, controller.buddyChat('lead')!.id);
    expect(workgroup, findsNothing);
    expect(tester.widget<SuperTabBuddyRow>(dm).selected, isTrue);
    await close(tester, controller);
  });

  testWidgets('a Buddy chat opened for the first time is selected', (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    await tester.tap(dm);
    await tester.pumpAndSettle();
    expect(controller.selectedId, controller.buddyChat('lead')!.id);
    expect(workgroup, findsNothing);
    await close(tester, controller);
  });

  testWidgets('a project name click opens its chat, and comes back to it', (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    await controller.openBuddyChat('lead');
    await tester.pumpAndSettle();

    await tester.tap(find.text('Pilot'));
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'lead');
    expect(workgroup, findsNothing);

    // The chat left for the Buddy chat: the name comes back to it.
    await tester.tap(dm);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pilot'));
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'lead');
    expect(workgroup, findsNothing);
    await close(tester, controller);
  });

  testWidgets(
    'a second click on the open project leaves its chat open and lists no '
    'tasks',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      await controller.openBuddyChat('lead');
      await tester.tap(dm);
      await tester.pumpAndSettle();
      expect(chevronIn(project), findsNothing);

      await tester.tap(project);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'lead');

      await tester.tap(project);
      await tester.pumpAndSettle();
      expect(workgroup, findsNothing);
      expect(controller.selectedId, 'lead');
      await close(tester, controller);
    },
  );

  // Unread is a bold name and nothing else drawn (Dee, 2026-10-29): no dot
  // beside it, so nothing in the status column to line up.
  Finder unreadDot(Finder row) => find.descendant(
    of: row,
    matching: find.byWidgetPredicate(
      (w) =>
          w is Container &&
          w.decoration is BoxDecoration &&
          (w.decoration! as BoxDecoration).shape == BoxShape.circle &&
          // A dot holds nothing; an avatar holds its initial.
          w.child == null,
    ),
  );
  // What a screen reader says for the row, its children merged into it.
  String spoken(WidgetTester tester, Finder row) =>
      tester.getSemantics(row).getSemanticsData().label;
  FontWeight? weightOf(WidgetTester tester, Finder row, String text) => tester
      .widget<RichText>(
        find
            .descendant(
              of: row,
              matching: find.byWidgetPredicate(
                (w) => w is RichText && w.text.toPlainText() == text,
              ),
            )
            .first,
      )
      .text
      .style
      ?.fontWeight;

  testWidgets(
    'a project with an unread task shows its name in bold, with no dot',
    (tester) async {
      // Not "Offline editing": it waits for a person.
      final server = humansSwarm();
      addNumberedWorkgroups(server, 1);
      final controller = await show(tester, server);
      expect(weightOf(tester, project, 'Pilot'), isNot(grid.AppFont.semibold));

      server.append('New work', conversationId: 'g1');
      await controller.select('offline');
      await controller.refresh();
      await tester.pumpAndSettle();
      // Bold for what its tasks hold.
      expect(weightOf(tester, project, 'Pilot'), grid.AppFont.semibold);
      expect(unreadDot(project), findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets(
    'a screen reader hears a project with an unread task as unread, and a '
    'read one not',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final server = humansSwarm();
      addNumberedWorkgroups(server, 2);
      final controller = await show(tester, server);
      expect(spoken(tester, project), isNot(contains('Unread messages')));

      server.append('New work', conversationId: 'g1');
      await controller.select('offline');
      await controller.refresh();
      await tester.pumpAndSettle();
      expect(spoken(tester, project), contains('Unread messages'));
      semantics.dispose();
      await close(tester, controller);
    },
  );

  testWidgets('an unread Buddy row is bold with no dot, and heard as unread', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    Future<void> row({required bool unread}) => tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabBuddyRow(
            key: const ValueKey('pm'),
            agentId: null,
            name: 'Buddy',
            tooltip: 'Your Buddy · Pilot',
            unread: unread,
            onTap: () {},
          ),
        ),
      ),
    );
    final pm = find.byKey(const ValueKey('pm'));
    final tappable = find.descendant(of: pm, matching: find.byType(InkWell));
    await row(unread: false);
    expect(weightOf(tester, pm, 'Buddy'), grid.AppFont.regular);
    expect(spoken(tester, tappable), isNot(contains('Unread messages')));
    await row(unread: true);
    expect(weightOf(tester, pm, 'Buddy'), grid.AppFont.semibold);
    expect(unreadDot(pm), findsNothing);
    expect(spoken(tester, tappable), contains('Unread messages'));
    semantics.dispose();
  });

  testWidgets('a project holding the open conversation shows as selected', (
    tester,
  ) async {
    final server = humansSwarm();
    addNumberedWorkgroups(server, 1);
    final controller = await show(tester, server);
    await controller.openBuddyChat('lead');
    Color? projectFill() => tester
        .widget<Material>(
          find.ancestor(of: project, matching: find.byType(Material)).first,
        )
        .color;
    await tester.tap(dm);
    await tester.pumpAndSettle();
    expect(projectFill(), Colors.transparent);

    await controller.select('g1');
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'g1');
    expect(projectFill(), grid.AppSurface.selectedFill);
    await close(tester, controller);
  });

  testWidgets('an arrow a project name cannot use moves focus as usual', (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    Focus.of(tester.element(find.text('Pilot'))).requestFocus();
    await tester.pumpAndSettle();

    final name = primaryFocus;
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pumpAndSettle();
    expect(primaryFocus, isNot(same(name)));
    expect(workgroup, findsNothing);
    await close(tester, controller);
  });

  testWidgets('Enter on a project name opens its chat', (tester) async {
    final controller = await show(tester, humansSwarm());
    await controller.openBuddyChat('lead');
    await tester.tap(dm);
    await tester.pumpAndSettle();
    Focus.of(tester.element(find.text('Pilot'))).requestFocus();
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'lead');
    expect(workgroup, findsNothing);
    await close(tester, controller);
  });

  testWidgets(
    'a machine click expands and collapses it; Details is in its right-click menu',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      await tester.tap(find.byKey(const ValueKey('super-manage')));
      await tester.pumpAndSettle();
      expect(chevronIn(machine), findsNothing);
      expect(controller.isMachineExpanded('studio'), isFalse);

      await tester.tap(machine);
      await tester.pumpAndSettle();
      expect(controller.isMachineExpanded('studio'), isTrue);
      expect(find.byType(Dialog), findsNothing);
      await tester.tap(machine);
      await tester.pumpAndSettle();
      expect(controller.isMachineExpanded('studio'), isFalse);

      await tester.tap(machine, buttons: kSecondaryButton);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Details'));
      await tester.pumpAndSettle();
      expect(find.byType(Dialog), findsOneWidget);
      await close(tester, controller);
    },
  );
}
