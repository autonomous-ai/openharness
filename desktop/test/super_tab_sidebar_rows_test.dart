import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/pm_chat_rows.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// The sidebar's rows without chevrons (Dee, 2026-10-27): a direct message
/// click highlights only that row; a project click opens its chat and shows
/// its workgroups, and a second click hides them; a machine click expands it,
/// and its details are in the right-click menu.
void main() {
  final dm = find.byKey(const ValueKey('super-pm-chat-lead'));
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
    'a project click opens its chat and shows its workgroups; a second click hides them',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      await controller.openPmChat('lead');
      controller.expandedProjects.clear();
      await tester.pumpAndSettle();
      expect(chevronIn(project), findsNothing);

      await tester.tap(project);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'lead');
      expect(controller.expandedProjects, {'lead'});
      expect(workgroup, findsOneWidget);

      await tester.tap(project);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'lead');
      expect(controller.expandedProjects, isEmpty);
      expect(workgroup, findsNothing);
      await close(tester, controller);
    },
  );

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
