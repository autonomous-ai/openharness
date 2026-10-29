import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/pm_chat_rows.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// The sidebar's rows: a direct message click highlights only that row; a
/// project's name opens its chat and only the chevron at its right end shows
/// or hides its conversations (Dee, 2026-10-28); a machine click expands it,
/// and its details are in the right-click menu.
void main() {
  final dm = find.byKey(const ValueKey('super-pm-chat-lead'));
  final project = find.byKey(const ValueKey('super-group-lead'));
  final workgroup = find.byKey(const ValueKey('super-group-offline'));
  final machine = find.byKey(const ValueKey('super-machine-studio'));
  final toggle = find.byKey(const ValueKey('super-project-toggle-lead'));
  final more = find.byKey(const ValueKey('super-project-more-lead'));

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

  testWidgets(
    'a direct message click highlights only that row and leaves projects collapsed',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      // Its chat exists already: opening it again is a plain selection.
      await controller.openPmChat('lead');
      await controller.select('lead');
      controller.expandedProjects.clear();
      await tester.pumpAndSettle();

      await tester.tap(dm);
      await tester.pumpAndSettle();
      expect(controller.selectedId, controller.pmChat('lead')!.id);
      expect(controller.expandedProjects, isEmpty);
      expect(workgroup, findsNothing);
      expect(tester.widget<SuperTabPmChatRow>(dm).selected, isTrue);
      await close(tester, controller);
    },
  );

  testWidgets(
    'a direct message opened for the first time leaves projects collapsed',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      controller.expandedProjects.clear();
      await tester.pumpAndSettle();
      await tester.tap(dm);
      await tester.pumpAndSettle();
      expect(controller.selectedId, controller.pmChat('lead')!.id);
      expect(controller.expandedProjects, isEmpty);
      await close(tester, controller);
    },
  );

  testWidgets(
    'a project name click opens its chat and leaves its list as it was',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      await controller.openPmChat('lead');
      controller.expandedProjects.clear();
      await tester.pumpAndSettle();

      await tester.tap(find.text('Pilot'));
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'lead');
      expect(controller.expandedProjects, isEmpty);
      expect(workgroup, findsNothing);

      // Open, and the chat left for a direct message: the name comes back to
      // it without closing the list.
      await tester.tap(toggle);
      await tester.tap(dm);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Pilot'));
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'lead');
      expect(controller.expandedProjects, {'lead'});
      expect(workgroup, findsOneWidget);
      await close(tester, controller);
    },
  );

  testWidgets(
    'the chevron at the far right of a project toggles its list and leaves the chat open',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      await controller.openPmChat('lead');
      controller.expandedProjects.clear();
      await tester.tap(dm);
      await tester.pumpAndSettle();
      final chat = controller.selectedId;
      Icon chevron() => tester.widget<Icon>(chevronIn(toggle));
      expect(chevron().icon, AppIcons.chevronRight);
      expect(
        tester.getCenter(toggle).dx,
        greaterThan(tester.getRect(project).right),
      );

      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(controller.expandedProjects, {'lead'});
      expect(workgroup, findsOneWidget);
      expect(chevron().icon, AppIcons.chevronDown);
      expect(controller.selectedId, chat);

      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(controller.expandedProjects, isEmpty);
      expect(workgroup, findsNothing);
      expect(controller.selectedId, chat);
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
    'an unread project and workgroup show their names in bold, with no dot',
    (tester) async {
      // Not "Offline editing": it waits for a person, which shows "?" there.
      final server = humansSwarm();
      addNumberedWorkgroups(server, 1);
      final controller = await show(tester, server);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      final g1 = find.byKey(const ValueKey('super-group-g1'));
      final name = tester
          .widget<RichText>(
            find.descendant(of: g1, matching: find.byType(RichText)).first,
          )
          .text
          .toPlainText();
      // Read: the project open (medium), the workgroup in ordinary weight.
      expect(weightOf(tester, project, 'Pilot'), isNot(grid.AppFont.semibold));
      expect(weightOf(tester, g1, name), grid.AppFont.regular);

      server.append('New work', conversationId: 'g1');
      await controller.select('offline');
      await controller.refresh();
      await tester.pumpAndSettle();
      expect(weightOf(tester, project, 'Pilot'), grid.AppFont.semibold);
      expect(weightOf(tester, g1, name), grid.AppFont.semibold);
      expect(unreadDot(project), findsNothing);
      expect(unreadDot(g1), findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets(
    'a screen reader hears an unread row as unread, and a read one not',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final server = humansSwarm();
      addNumberedWorkgroups(server, 2);
      final controller = await show(tester, server);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      final g1 = find.byKey(const ValueKey('super-group-g1'));
      final g2 = find.byKey(const ValueKey('super-group-g2'));
      expect(spoken(tester, project), isNot(contains('Unread messages')));
      expect(spoken(tester, g1), isNot(contains('Unread messages')));

      server.append('New work', conversationId: 'g1');
      await controller.select('offline');
      await controller.refresh();
      await tester.pumpAndSettle();
      expect(spoken(tester, project), contains('Unread messages'));
      expect(spoken(tester, g1), contains('Unread messages'));
      expect(spoken(tester, g2), isNot(contains('Unread messages')));
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
          body: SuperTabPmChatRow(
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

  testWidgets(
    'projects start collapsed, and each account keeps its own choice',
    (tester) async {
      final server = humansSwarm();
      var controller = await show(tester, server);
      expect(controller.expandedProjects, isEmpty);
      expect(workgroup, findsNothing);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      await close(tester, controller);

      Future<SuperTabController> reopen(String account) async {
        final next = server.controller(account: account, initial: server.saved);
        await next.refresh();
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SuperTabView(
                controller: next,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Studio',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        return next;
      }

      controller = await reopen('peer');
      expect(workgroup, findsOneWidget);
      expect(tester.widget<Icon>(chevronIn(toggle)).icon, AppIcons.chevronDown);
      await close(tester, controller);

      controller = await reopen('owner');
      expect(workgroup, findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets(
    'an open project lists its 8 newest conversations, and "… N more" shows the rest',
    (tester) async {
      final server = humansSwarm();
      addNumberedWorkgroups(server, 11);
      final controller = await show(tester, server);
      await tester.tap(toggle);
      await tester.pumpAndSettle();

      Finder row(String id) => find.byKey(ValueKey('super-group-$id'));
      final shown = [for (var n = 11; n >= 4; n--) row('g$n')];
      for (final finder in shown) {
        expect(finder, findsOneWidget);
      }
      for (var i = 1; i < shown.length; i++) {
        expect(
          tester.getTopLeft(shown[i]).dy,
          greaterThan(tester.getTopLeft(shown[i - 1]).dy),
        );
      }
      // #3, #2, #1 and the unnumbered "Offline editing" wait behind the row.
      expect(row('g3'), findsNothing);
      expect(workgroup, findsNothing);
      expect(more, findsOneWidget);
      expect(find.text('… 4 more'), findsOneWidget);
      expect(
        tester.getTopLeft(more).dy,
        greaterThan(tester.getTopLeft(row('g4')).dy),
      );

      await tester.tap(more);
      await tester.pumpAndSettle();
      expect(more, findsNothing);
      for (final id in ['g3', 'g2', 'g1', 'offline']) {
        expect(row(id), findsOneWidget);
      }
      expect(
        tester.getTopLeft(workgroup).dy,
        greaterThan(tester.getTopLeft(row('g1')).dy),
      );
      await close(tester, controller);
    },
  );

  testWidgets('an older conversation that is open stays listed', (
    tester,
  ) async {
    final server = humansSwarm();
    addNumberedWorkgroups(server, 11);
    final controller = await show(tester, server);
    await controller.select('g1');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-group-g1')), findsOneWidget);
    expect(find.byKey(const ValueKey('super-group-g2')), findsNothing);
    expect(find.text('… 3 more'), findsOneWidget);
    await close(tester, controller);
  });

  testWidgets(
    'unread and waiting conversations older than the 8 newest stay listed',
    (tester) async {
      final server = humansSwarm();
      addNumberedWorkgroups(server, 11);
      // #2 waits for a person to answer its Engineer.
      (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((g) => g['id'] == 'g2')
        ..['agentIds'] = ['lead-agent']
        ..['assignment'] = {'agentId': 'lead-agent', 'status': 'needs_human'};
      final controller = await show(tester, server);
      server.append('New work', conversationId: 'g1');
      await controller.refresh();
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-group-g1')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-group-g2')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-group-g3')), findsNothing);
      expect(find.text('… 2 more'), findsOneWidget);
      await close(tester, controller);
    },
  );

  testWidgets(
    'a collapsed project holding the open conversation shows as selected',
    (tester) async {
      final server = humansSwarm();
      addNumberedWorkgroups(server, 1);
      final controller = await show(tester, server);
      Color? projectFill() => tester
          .widget<Material>(
            find.ancestor(of: project, matching: find.byType(Material)).first,
          )
          .color;
      await controller.select('g1');
      await tester.pumpAndSettle();
      expect(projectFill(), Colors.transparent);

      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'g1');
      expect(projectFill(), grid.AppSurface.selectedFill);

      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(projectFill(), Colors.transparent);
      await close(tester, controller);
    },
  );

  testWidgets('an arrow a project name cannot use moves focus as usual', (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(controller.expandedProjects, {'lead'});
    Focus.of(tester.element(find.text('Pilot'))).requestFocus();
    await tester.pumpAndSettle();

    // Already open: → goes on to the chevron beside the name.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pumpAndSettle();
    expect(controller.expandedProjects, {'lead'});
    expect(
      primaryFocus?.context?.findAncestorWidgetOfExactType<InkWell>()?.key,
      const ValueKey('super-project-toggle-lead'),
    );
    await close(tester, controller);
  });

  testWidgets(
    'Enter on a project name opens it; → and ← show and hide its conversations',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      await controller.openPmChat('lead');
      controller.expandedProjects.clear();
      await tester.tap(dm);
      await tester.pumpAndSettle();
      Future<void> focusName() async {
        Focus.of(tester.element(find.text('Pilot'))).requestFocus();
        await tester.pumpAndSettle();
      }

      await focusName();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'lead');
      expect(controller.expandedProjects, isEmpty);

      // Opening the chat moved focus into it.
      await focusName();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pumpAndSettle();
      expect(controller.expandedProjects, {'lead'});
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pumpAndSettle();
      expect(controller.expandedProjects, isEmpty);
      expect(controller.selectedId, 'lead');
      await close(tester, controller);
    },
  );

  testWidgets('the focused chevron toggles with Enter and with Space', (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    controller.expandedProjects.clear();
    await tester.pumpAndSettle();
    Focus.of(tester.element(chevronIn(toggle))).requestFocus();
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(controller.expandedProjects, {'lead'});
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pumpAndSettle();
    expect(controller.expandedProjects, isEmpty);
    await close(tester, controller);
  });

  testWidgets(
    'a machine click expands and collapses it; Details is in its right-click menu',
    (tester) async {
      final controller = await show(tester, humansSwarm());
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
