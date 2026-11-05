// Task #3006 (Dee, 11-05): Plum is a light theme with one dark surface, the
// Swarm sidebar, in plum with white text. Every word and mark there must read
// on it, and the same widgets elsewhere keep the page's ink.
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/places.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/section_heading.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm, unreadThread;
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

double _contrast(Color a, Color b) {
  final x = a.computeLuminance() + .05;
  final y = b.computeLuminance() + .05;
  return x > y ? x / y : y / x;
}

void _wear(HarnessPalette palette) {
  final previous = grid.AppTheme.palette.value;
  final brightness = grid.AppTheme.brightness.value;
  grid.AppTheme.palette.value = palette;
  grid.AppTheme.brightness.value = palette.brightness;
  addTearDown(() {
    grid.AppTheme.palette.value = previous;
    grid.AppTheme.brightness.value = brightness;
  });
}

Future<void> _mountSidebar(WidgetTester tester) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(900, 1000);
  addTearDown(tester.view.reset);
  final now = DateTime.now().millisecondsSinceEpoch;
  final server = ConversationServer();
  final conversations = server.state['conversations'] as List;
  final projects = <Map<String, dynamic>>[];
  for (final name in ['garage-pod', 'lampos', 'openharness']) {
    projects.add(projectFixture(name, name, 'chat-$name'));
    conversations.add({
      ...conversationFixture('chat-$name', name),
      'projectId': name,
    });
  }
  server.state['projects'] = projects;
  for (final (number, status) in [(2419, 'working'), (2394, 'needs_human')]) {
    conversations.add({
      ...conversationFixture('t$number', 'Task $number'),
      'projectId': 'openharness',
      'number': number,
      'agentIds': ['lead'],
      'assignment': {
        'id': 'a$number',
        'agentId': 'lead',
        'status': status,
        'result': status == 'needs_human' ? 'Which machine?' : null,
        'progressAt': now - 60000,
      },
    });
    server.append(
      'Pushed the next commit.',
      conversationId: 't$number',
      agent: true,
    );
  }
  server.append('Can you check this?', conversationId: 'chat-lampos');
  final c = server.controller(
    initial: {
      'tabId': 'tab',
      'accountId': 'owner',
      'expandedProjects': ['openharness'],
      'selectedId': 'chat-openharness',
    },
  );
  addTearDown(c.dispose);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: grid.AppTheme.brightness.value),
      home: Scaffold(
        body: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 300,
              child: ProjectSidebar(controller: c, onSelect: c.select),
            ),
            const Expanded(
              child: SuperTabSectionHeading('Outside the sidebar'),
            ),
          ],
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// The fill right behind [element]: the nearest opaque box or material
/// under the sidebar (a badge, an avatar's disc, a selected row), else
/// [ground].
Color _behind(Element element, Color ground) {
  Color? found;
  element.visitAncestorElements((ancestor) {
    final widget = ancestor.widget;
    if (widget is ProjectSidebar) return false;
    final fill = switch (widget) {
      DecoratedBox(decoration: BoxDecoration(:final color?)) => color,
      Material(:final color?) => color,
      ColoredBox(:final color) => color,
      _ => null,
    };
    if (fill != null && fill.a > .5) {
      found = fill;
      return false;
    }
    return true;
  });
  return found ?? ground;
}

/// Every text and icon color drawn under [of], each with the fill behind it.
List<(String, Color, Color)> _inks(
  WidgetTester tester,
  Finder of,
  Color ground,
) {
  // A list, not a map: the same words (a count of 1) may appear twice.
  final inks = <(String, Color, Color)>[];
  // An avatar is drawn on its own disc, whatever the theme.
  final avatars = find
      .descendant(
        of: find.byType(SuperTabAvatar),
        matching: find.byType(RichText),
      )
      .evaluate()
      .toSet();
  for (final element
      in find
          .descendant(of: of, matching: find.byType(RichText))
          .evaluate()
          .where((element) => !avatars.contains(element))) {
    final paragraph = element.renderObject! as RenderParagraph;
    final behind = _behind(element, ground);
    paragraph.text.visitChildren((span) {
      if (span is TextSpan) {
        final color = span.style?.color ?? paragraph.text.style?.color;
        final text = span.toPlainText().trim();
        if (color != null && text.isNotEmpty) {
          inks.add((text, Color.alphaBlend(color, behind), behind));
        }
      }
      return true;
    });
  }
  for (final element
      in find.descendant(of: of, matching: find.byType(Icon)).evaluate()) {
    final icon = element.widget as Icon;
    final color = icon.color ?? IconTheme.of(element).color;
    if (color != null) {
      final behind = _behind(element, ground);
      inks.add((
        'icon ${icon.icon?.codePoint}',
        Color.alphaBlend(color, behind),
        behind,
      ));
    }
  }
  return inks;
}

void _expectReadable(List<(String, Color, Color)> inks, String where) {
  expect(inks, isNotEmpty);
  for (final (what, ink, behind) in inks) {
    expect(
      _contrast(ink, behind),
      greaterThanOrEqualTo(what.startsWith('icon') ? 3 : 4.5),
      reason: '"$what" ${what.codeUnits} on $where',
    );
  }
}

void main() {
  testWidgets('Plum\'s sidebar is plum and everything on it reads', (
    tester,
  ) async {
    _wear(HarnessPalette.plum);
    await _mountSidebar(tester);
    final sidebar = find.byType(ProjectSidebar);
    expect(
      find.descendant(
        of: sidebar,
        matching: find.byWidgetPredicate(
          (w) => w is Material && w.color == const Color(0xff3f0e40),
        ),
      ),
      findsWidgets,
    );
    final ground = HarnessPalette.plum.sidebar;
    _expectReadable(_inks(tester, sidebar, ground), 'the plum sidebar');

    // Hovering a row keeps it readable.
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(find.text('lampos')));
    await tester.pumpAndSettle();
    // Under the pointer the row darkens to the hover fill; what sat on the
    // sidebar itself must read there too.
    final hover = HarnessPalette.plum.sidebarHover;
    _expectReadable([
      for (final (what, ink, behind) in _inks(tester, sidebar, ground))
        (what, ink, behind == ground ? hover : behind),
    ], 'a hovered plum row');

    // The same heading outside the sidebar keeps the page's gray.
    final outside = tester.renderObject<RenderParagraph>(
      find.text('Outside the sidebar'),
    );
    expect(outside.text.style!.color, HarnessPalette.plum.muted);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a theme without a sidebar of its own keeps the page ink', (
    tester,
  ) async {
    _wear(HarnessPalette.cloud);
    await _mountSidebar(tester);
    final sidebar = find.byType(ProjectSidebar);
    expect(
      find.descendant(
        of: sidebar,
        matching: find.byWidgetPredicate(
          (w) => w is Material && w.color == HarnessPalette.cloud.sidebar,
        ),
      ),
      findsWidgets,
    );
    final ground = HarnessPalette.cloud.sidebar;
    _expectReadable(_inks(tester, sidebar, ground), 'Cloud\'s sidebar');
  });

  testWidgets('on Plum, Threads, Mentions and Decisions read too, counts '
      'and arrows included', (tester) async {
    _wear(HarnessPalette.plum);
    final server = swarm()..state['swarmBuddy'] = true;
    server.ask(['Ship it?']);
    server.tag('message-1');
    server.followedThreads = {
      'unread': [unreadThread('message-1')],
      'read': [],
      'more': false,
    };
    final activity = (await tester.runAsync(() => load(server)))!;
    final c = activity.controller;
    final AppNotifier app = createApp();
    addTearDown(app.dispose);
    await tester.binding.setSurfaceSize(const Size(280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: ProjectSidebar(
            controller: c,
            app: app,
            onSelect: c.select,
            onNewSwarm: () {},
            onNewProject: () {},
            onPage: (_) {},
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
    final threads = find.byKey(const ValueKey('super-threads'));
    expect(
      find.descendant(of: threads, matching: find.text('1')),
      findsOneWidget,
    );
    _expectReadable(
      _inks(tester, find.byType(ProjectSidebar), HarnessPalette.plum.sidebar),
      'the plum sidebar with Threads, Mentions and Decisions',
    );
  });
}
