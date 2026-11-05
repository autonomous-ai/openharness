import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/buddy_rows.dart' show SuperTabCountBadge;
import 'package:harness/super_tabs/places.dart';
import 'package:harness/super_tabs/project_sidebar.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm, unreadThread;
import 'swarm_state_test.dart' show createApp;

/// The sidebar of task #2996 (anh Dee, 11-05): Decisions, Mentions and
/// Threads under the Swarm, each one thing; Buddy first under Projects; the
/// back and forward arrows at the top.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  Finder inRow(String row, Finder what) =>
      find.descendant(of: key(row), matching: what);

  Future<({SuperTabActivity activity, List<SuperTabPage> opened})> show(
    WidgetTester tester, {
    SuperTabPage? page,
  }) async {
    final server = swarm()..state['swarmBuddy'] = true;
    server.ask(['Ship it?']);
    server.tag('message-1');
    server.tag('message-2');
    server.followedThreads = {
      'unread': [unreadThread('message-1')],
      'read': [],
      'more': false,
    };
    final activity = (await tester.runAsync(() => load(server)))!;
    final c = activity.controller;
    final AppNotifier app = createApp();
    addTearDown(app.dispose);
    final opened = <SuperTabPage>[];
    await tester.binding.setSurfaceSize(const Size(280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: ProjectSidebar(
            controller: c,
            app: app,
            onSelect: c.select,
            onNewSwarm: () {},
            onNewProject: () {},
            onPage: opened.add,
            page: page,
            activity: activity,
            attention: activity.attention,
            places: SuperTabPlaces.of(c),
            onManage: () {},
          ),
        ),
      ),
    );
    await tester.pump();
    addTearDown(() => tester.pumpWidget(const SizedBox()));
    return (activity: activity, opened: opened);
  }

  double top(WidgetTester tester, String k) => tester.getTopLeft(key(k)).dy;

  testWidgets('Decisions, Mentions, Threads under the Swarm, then Projects '
      'with Buddy first; no Activity', (tester) async {
    await show(tester);
    final order = [
      'super-back',
      'super-swarm-switcher',
      'super-decisions',
      'super-mentions',
      'super-threads',
      'project-sidebar-projects',
      'super-swarm-buddy',
      'super-project-lead',
      'super-manage',
    ];
    for (var i = 1; i < order.length; i++) {
      expect(
        top(tester, order[i - 1]),
        lessThan(top(tester, order[i])),
        reason: '${order[i - 1]} over ${order[i]}',
      );
    }
    expect(key('super-activity'), findsNothing);
    expect(find.text('Activity'), findsNothing);
    expect(inRow('super-decisions', find.text('Decisions')), findsOneWidget);
    expect(inRow('super-mentions', find.text('Mentions')), findsOneWidget);
    expect(inRow('super-threads', find.text('Threads')), findsOneWidget);
  });

  testWidgets('Decisions and Mentions have red counts; Threads is bold with '
      'a plain count, never red', (tester) async {
    await show(tester);
    SuperTabCountBadge badge(String row) => tester.widget<SuperTabCountBadge>(
      inRow(row, find.byType(SuperTabCountBadge)),
    );
    expect(badge('super-decisions').count, 1);
    expect(badge('super-mentions').count, 2);
    expect(inRow('super-threads', find.byType(SuperTabCountBadge)), findsNothing);
    expect(inRow('super-threads', find.text('1')), findsOneWidget);
    final label = tester.widget<Text>(inRow('super-threads', find.text('Threads')));
    expect(label.style?.fontWeight, grid.AppFont.semibold);
  });

  testWidgets('each row opens its page, and the open one is selected', (
    tester,
  ) async {
    final shown = await show(tester, page: SuperTabPage.mentions);
    await tester.tap(key('super-decisions'));
    await tester.tap(key('super-mentions'));
    await tester.tap(key('super-threads'));
    expect(shown.opened, [
      SuperTabPage.decisions,
      SuperTabPage.mentions,
      SuperTabPage.threads,
    ]);
    expect(
      tester
          .getSemantics(key('super-mentions'))
          .flagsCollection
          .isSelected,
      isTrue,
    );
  });

  testWidgets('Projects has no collapse chevron and keeps its filter and +', (
    tester,
  ) async {
    await show(tester);
    final heading = key('project-sidebar-projects');
    expect(
      find.descendant(of: heading, matching: find.byIcon(AppIcons.chevronDown)),
      findsNothing,
    );
    expect(
      find.descendant(of: heading, matching: find.byIcon(AppIcons.chevronRight)),
      findsNothing,
    );
    expect(key('super-unread-only'), findsOneWidget);
    expect(find.byTooltip('New project'), findsOneWidget);
  });

  testWidgets('the arrows wait for a place to go, and step there', (
    tester,
  ) async {
    final shown = await show(tester);
    final places = SuperTabPlaces.of(shown.activity.controller);
    IconButton arrow(String k) =>
        tester.widget<IconButton>(inRow(k, find.byType(IconButton)));
    expect(arrow('super-back').onPressed, isNull);
    expect(arrow('super-forward').onPressed, isNull);

    places
      ..record(const SuperTabPlace.page(SuperTabPage.threads))
      ..record(const SuperTabPlace.chat('lead'));
    await tester.pump();
    expect(arrow('super-back').onPressed, isNotNull);
    await tester.tap(key('super-back'));
    expect(
      places.takeStep(),
      const SuperTabPlace.page(SuperTabPage.threads),
    );
  });
}
