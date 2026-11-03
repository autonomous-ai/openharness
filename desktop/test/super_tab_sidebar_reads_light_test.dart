// Task #2427 (Huy, 11-03): the Swarm sidebar reads light like Slack. A task row is bold only for what is for a person: a
// person's new message, a mention of the reader, or the task waiting on a person. Agents' progress messages leave it in
// regular weight and grey, as every read row is.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:flutter/gestures.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/swarm_type.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

void main() {
  final project = find.byKey(const ValueKey('super-group-lead'));
  final g1 = find.byKey(const ValueKey('super-group-g1'));

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
    controller.toggleProject('lead');
    await tester.pumpAndSettle();
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController controller) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }

  /// The title's style in [row]: the RichText that holds "Workgroup 1".
  TextStyle titleStyle(WidgetTester tester, Finder row, String title) {
    final text = tester.widget<RichText>(
      find
          .descendant(
            of: row,
            matching: find.byWidgetPredicate(
              (w) => w is RichText && w.text.toPlainText().contains(title),
            ),
          )
          .first,
    );
    TextStyle? found;
    text.text.visitChildren((span) {
      if (span is TextSpan && (span.text ?? '').contains(title))
        found = span.style;
      return found == null;
    });
    return (found ?? text.text.style!).merge(null);
  }

  Future<void> news(WidgetTester tester, SuperTabController controller) async {
    await controller.select('offline');
    await controller.refresh();
    await tester.pumpAndSettle();
  }

  testWidgets('a task with only agents\' new messages reads regular and grey', (
    tester,
  ) async {
    final server = humansSwarm();
    addNumberedWorkgroups(server, 1);
    final controller = await show(tester, server);
    server.append('Working on it.', conversationId: 'g1', agent: true);
    server.append(
      'Pushed the first commit.',
      conversationId: 'g1',
      agent: true,
    );
    await news(tester, controller);
    final style = titleStyle(tester, g1, 'Workgroup 1');
    expect(style.fontWeight, isNot(grid.AppFont.semibold));
    expect(style.color, DesktopChrome.muted);
    // Collapsed, the project is not bold for agents' messages either.
    controller.toggleProject('lead');
    await tester.pumpAndSettle();
    expect(
      titleStyle(tester, project, 'Pilot').fontWeight,
      isNot(grid.AppFont.semibold),
    );
    await close(tester, controller);
  });

  testWidgets(
    'a person\'s new message makes a task bold, and its collapsed project',
    (tester) async {
      final server = humansSwarm();
      addNumberedWorkgroups(server, 1);
      final controller = await show(tester, server);
      server.append('Can you check this?', conversationId: 'g1');
      await news(tester, controller);
      final style = titleStyle(tester, g1, 'Workgroup 1');
      expect(style.fontWeight, grid.AppFont.semibold);
      expect(style.color, DesktopChrome.foreground);
      controller.toggleProject('lead');
      await tester.pumpAndSettle();
      expect(
        titleStyle(tester, project, 'Pilot').fontWeight,
        grid.AppFont.semibold,
      );
      await close(tester, controller);
    },
  );

  testWidgets(
    'a mention of the reader makes a task bold, though an agent wrote it',
    (tester) async {
      final server = humansSwarm();
      addNumberedWorkgroups(server, 1);
      final controller = await show(tester, server);
      server.tag('tag-1', conversationId: 'g1');
      await news(tester, controller);
      expect(
        titleStyle(tester, g1, 'Workgroup 1').fontWeight,
        grid.AppFont.semibold,
      );
      await close(tester, controller);
    },
  );

  testWidgets('the open task is regular weight, carried by its highlight', (
    tester,
  ) async {
    final server = humansSwarm();
    addNumberedWorkgroups(server, 1);
    final controller = await show(tester, server);
    await controller.select('g1');
    await tester.pumpAndSettle();
    final style = titleStyle(tester, g1, 'Workgroup 1');
    expect(style.fontWeight, isNot(grid.AppFont.semibold));
    expect(style.fontWeight, isNot(grid.AppFont.medium));
    expect(style.color, DesktopChrome.foreground);
    await close(tester, controller);
  });

  /// Workgroup 1 at work: an agent on it, its last progress a minute ago.
  void working(ConversationServer server) {
    final groups = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>();
    groups.firstWhere((g) => g['id'] == 'g1')['assignment'] = {
      'id': 'a1',
      'agentId': 'lead',
      'status': 'working',
      'progressAt': DateTime.now()
          .subtract(const Duration(minutes: 1))
          .millisecondsSinceEpoch,
    };
  }

  testWidgets(
    'a task row is one line, its state a mark at the right, still said to a screen reader',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final server = humansSwarm();
      addNumberedWorkgroups(server, 1);
      working(server);
      final controller = await show(tester, server);
      expect(find.byKey(const ValueKey('super-task-line-g1')), findsNothing);
      expect(find.byKey(const ValueKey('super-task-mark-g1')), findsOneWidget);
      // One line: the row is a sidebar row's height, as a project's is.
      expect(tester.getSize(g1).height, tester.getSize(project).height);
      expect(
        tester.getSize(g1).height,
        lessThanOrEqualTo(SwarmType.sidebarRowHeight(compact: false) + 1),
      );
      expect(
        tester.getSemantics(g1).getSemanticsData().label,
        contains('Working'),
      );
      semantics.dispose();
      await close(tester, controller);
    },
  );

  testWidgets('the task number is smaller and fainter than its title', (
    tester,
  ) async {
    final server = humansSwarm();
    addNumberedWorkgroups(server, 1);
    final controller = await show(tester, server);
    final title = titleStyle(tester, g1, 'Workgroup 1');
    final number = titleStyle(tester, g1, '1  ');
    expect(number.fontSize, lessThan(title.fontSize!));
    expect(number.color, grid.AppPalette.textFaint);
    await close(tester, controller);
  });

  testWidgets('the tooltip opens beside the list, not over the rows below', (
    tester,
  ) async {
    final server = humansSwarm();
    addNumberedWorkgroups(server, 1);
    working(server);
    final controller = await show(tester, server);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(g1));
    await tester.pumpAndSettle(const Duration(seconds: 2));
    final tip = find.textContaining('Workgroup 1\n');
    expect(tip, findsOneWidget);
    final row = tester.getRect(g1), box = tester.getRect(tip);
    expect(box.left, greaterThanOrEqualTo(row.right));
    // Level with its row, not hanging below it.
    expect(box.center.dy, closeTo(row.center.dy, row.height));
    await mouse.moveTo(Offset.zero);
    await tester.pumpAndSettle(const Duration(seconds: 2));
    await close(tester, controller);
  });
}
