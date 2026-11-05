import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/buddy_rows.dart' show SuperTabCountBadge;
import 'package:harness/super_tabs/places.dart';
import 'package:harness/super_tabs/project_sidebar.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm, unreadThread;
import 'support/capture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's before and after pictures there.
final shots = Platform.environment['SUPER_TAB_SIDEBAR_SHOTS'];

/// The sidebar of task #2996 (anh Dee, 11-05): Decisions, Mentions and
/// Threads under the Swarm, each one thing; Buddy first under Projects; the
/// back and forward arrows at the top.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));
  Finder inRow(String row, Finder what) =>
      find.descendant(of: key(row), matching: what);

  Future<({SuperTabActivity activity, List<SwarmPage> opened})> show(
    WidgetTester tester, {
    SwarmPage? page,
    bool waiting = true,
    GlobalKey? picture,
  }) async {
    final server = swarm()..state['swarmBuddy'] = true;
    if (waiting) {
      server.ask(['Ship it?']);
      server.tag('message-1');
      server.tag('message-2');
    }
    server.followedThreads = {
      'unread': [if (waiting) unreadThread('message-1')],
      'read': [],
      'more': false,
    };
    final activity = (await tester.runAsync(() => load(server)))!;
    final c = activity.controller;
    final AppNotifier app = createApp();
    addTearDown(app.dispose);
    final opened = <SwarmPage>[];
    await tester.binding.setSurfaceSize(const Size(280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: RepaintBoundary(
          key: picture,
          child: Scaffold(
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

  // Anh Dee, 11-05, task #3128: each page row is bold at full strength while
  // something waits and grey when nothing does; no number, no red circle.
  FontWeight? weight(WidgetTester tester, String row, String label) =>
      tester.widget<Text>(inRow(row, find.text(label))).style?.fontWeight;
  Color? ink(WidgetTester tester, String row, String label) =>
      tester.widget<Text>(inRow(row, find.text(label))).style?.color;
  const rows = [
    ('super-decisions', 'Decisions'),
    ('super-mentions', 'Mentions'),
    ('super-threads', 'Threads'),
  ];

  testWidgets('Decisions, Mentions and Threads are grey and regular with '
      'nothing waiting', (tester) async {
    await show(tester, waiting: false);
    for (final (row, label) in rows) {
      expect(ink(tester, row, label), grid.SidebarInk.inkMuted, reason: row);
      expect(weight(tester, row, label), isNot(grid.AppFont.semibold));
    }
  });

  testWidgets('Decisions, Mentions and Threads are bold at full strength '
      'while something waits', (tester) async {
    await show(tester);
    expect(grid.SidebarInk.ink, isNot(grid.SidebarInk.inkMuted));
    for (final (row, label) in rows) {
      expect(ink(tester, row, label), grid.SidebarInk.ink, reason: row);
      expect(weight(tester, row, label), grid.AppFont.semibold, reason: row);
    }
  });

  testWidgets('no page row carries a number or a red circle, waiting or not', (
    tester,
  ) async {
    for (final waiting in [true, false]) {
      await show(tester, waiting: waiting);
      for (final (row, _) in rows) {
        expect(
          inRow(row, find.byType(SuperTabCountBadge)),
          findsNothing,
          reason: '$row, waiting: $waiting',
        );
        expect(
          inRow(
            row,
            find.byWidgetPredicate(
              (w) => w is Text && RegExp(r'^\d+$').hasMatch(w.data ?? ''),
            ),
          ),
          findsNothing,
          reason: '$row, waiting: $waiting',
        );
      }
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets('a selected row stays at full strength with nothing waiting', (
    tester,
  ) async {
    await show(tester, page: SwarmPage.decisions, waiting: false);
    expect(ink(tester, 'super-decisions', 'Decisions'), grid.SidebarInk.ink);
    expect(ink(tester, 'super-mentions', 'Mentions'), grid.SidebarInk.inkMuted);
  });

  testWidgets('the Swarm switcher is set apart from the three rows by a '
      'spacing token, the other rows keeping their gap', (tester) async {
    await show(tester);
    double bottom(String k) => tester.getBottomLeft(key(k)).dy;
    final gap = top(tester, 'super-decisions') - bottom('super-swarm-switcher');
    final rowGap = top(tester, 'super-mentions') - bottom('super-decisions');
    expect(gap - rowGap, DesktopChrome.controlGap);
  });

  testWidgets('each row opens its page, and the open one is selected', (
    tester,
  ) async {
    final shown = await show(tester, page: SwarmPage.mentions);
    await tester.tap(key('super-decisions'));
    await tester.tap(key('super-mentions'));
    await tester.tap(key('super-threads'));
    expect(shown.opened, [
      SwarmPage.decisions,
      SwarmPage.mentions,
      SwarmPage.threads,
    ]);
    Color? fill(String row) => tester
        .widget<Material>(
          find.ancestor(of: key(row), matching: find.byType(Material)).first,
        )
        .color;
    expect(fill('super-mentions'), grid.AppSurface.selectedFill);
    expect(fill('super-threads'), Colors.transparent);
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
      find.descendant(
        of: heading,
        matching: find.byIcon(AppIcons.chevronRight),
      ),
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
      ..record(const SuperTabPlace.page(SwarmPage.threads))
      ..record(const SuperTabPlace.chat('lead'));
    await tester.pump();
    expect(arrow('super-back').onPressed, isNotNull);
    await tester.tap(key('super-back'));
    expect(places.takeStep(), const SuperTabPlace.page(SwarmPage.threads));
  });

  // The PR's picture (task #3128): the sidebar with nothing waiting and with
  // something waiting. Writes nothing unless SUPER_TAB_SIDEBAR_SHOTS is set.
  for (final waiting in [false, true]) {
    testWidgets('picture of the sidebar, ${waiting ? 'something' : 'nothing'} '
        'waiting', (tester) async {
      if (shots == null) return;
      tester.view.devicePixelRatio = 2;
      final picture = GlobalKey();
      await show(tester, waiting: waiting, picture: picture);
      await captureBoundary(
        tester,
        picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
        shots,
        'sidebar-${waiting ? 'waiting' : 'nothing-waiting'}',
      );
    });
  }
}
