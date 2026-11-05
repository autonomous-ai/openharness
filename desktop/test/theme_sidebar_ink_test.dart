// Task #3006 (Dee, 11-05): Plum is a light theme with one dark surface, the
// Swarm sidebar, in plum with white text. Every word and mark there must read
// on it, and the same widgets elsewhere keep the page's ink.
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/section_heading.dart';

import 'support/super_tab_fixture.dart';

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

/// Every text color drawn under [of], blended over [ground].
Map<String, Color> _inks(WidgetTester tester, Finder of, Color ground) {
  final inks = <String, Color>{};
  for (final element
      in find.descendant(of: of, matching: find.byType(RichText)).evaluate()) {
    final paragraph = element.renderObject! as RenderParagraph;
    paragraph.text.visitChildren((span) {
      if (span is TextSpan) {
        final color = span.style?.color ?? paragraph.text.style?.color;
        final text = span.toPlainText().trim();
        if (color != null && text.isNotEmpty) {
          inks[text] = Color.alphaBlend(color, ground);
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
      inks['icon ${icon.icon?.codePoint}'] = Color.alphaBlend(color, ground);
    }
  }
  return inks;
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
    final inks = _inks(tester, sidebar, ground);
    expect(inks, isNotEmpty);
    for (final MapEntry(key: what, value: ink) in inks.entries) {
      expect(
        _contrast(ink, ground),
        greaterThanOrEqualTo(what.startsWith('icon') ? 3 : 4.5),
        reason: '"$what" on the plum sidebar',
      );
    }

    // Hovering a row keeps it readable.
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(find.text('lampos')));
    await tester.pumpAndSettle();
    for (final MapEntry(key: what, value: ink) in _inks(
      tester,
      sidebar,
      HarnessPalette.plum.sidebarHover,
    ).entries) {
      expect(
        _contrast(ink, HarnessPalette.plum.sidebarHover),
        greaterThanOrEqualTo(what.startsWith('icon') ? 3 : 4.5),
        reason: '"$what" on a hovered row',
      );
    }

    // The same heading outside the sidebar keeps the page's near-black.
    final outside = tester.renderObject<RenderParagraph>(
      find.text('Outside the sidebar'),
    );
    expect(
      _contrast(outside.text.style!.color!, HarnessPalette.plum.background),
      greaterThanOrEqualTo(7),
    );
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
    for (final MapEntry(key: what, value: ink) in _inks(
      tester,
      sidebar,
      ground,
    ).entries) {
      expect(
        _contrast(ink, ground),
        greaterThanOrEqualTo(what.startsWith('icon') ? 3 : 4.5),
        reason: '"$what" on Cloud\'s sidebar',
      );
    }
  });
}
