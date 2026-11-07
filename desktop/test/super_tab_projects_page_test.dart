import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart' show SuperTabProject;
import 'package:harness/super_tabs/projects_page.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// The Desktop's Projects grid (task #4466, anh Dee 11-07): the left pane's Projects opens every project in the middle,
/// as repositories under a GitHub org, most recent first.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  /// web-project (lead `lead`, quiet), api (busiest) and docs (private, in between).
  void projects(ConversationServer server) {
    final groups = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>();
    groups.firstWhere((g) => g['id'] == 'lead')['lastMessageSequence'] = 3;
    (server.state['projects'] as List)
      ..first['repository'] = {
        'repositoryUrl': 'https://github.com/autonomous-ai/openharness.git',
      }
      ..addAll([
        projectFixture('api', 'api', 'api-lead'),
        projectFixture('docs', 'docs', 'docs-lead', visibility: 'private'),
      ]);
    groups.addAll([
      {
        ...conversationFixture('api-lead', 'api'),
        'projectId': 'api',
        'lastMessageSequence': 1,
      },
      {
        ...conversationFixture('api-task', 'A task'),
        'projectId': 'api',
        'lastMessageSequence': 90,
      },
      {
        ...conversationFixture('docs-lead', 'docs'),
        'projectId': 'docs',
        'lastMessageSequence': 40,
      },
    ]);
  }

  Future<SuperTabController> show(
    WidgetTester tester, {
    void Function(ConversationServer server)? setup,
    List<SuperTabProject>? opened,
    VoidCallback? onNewProject,
    Brightness brightness = Brightness.light,
  }) async {
    final server = swarm();
    setup?.call(server);
    final c = server.controller(account: 'owner');
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    await tester.binding.setSurfaceSize(const Size(1000, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabProjectsPage(
            controller: c,
            onOpen: (project) => opened?.add(project),
            onNewProject: onNewProject,
          ),
        ),
      ),
    );
    await tester.pump();
    addTearDown(() => tester.pumpWidget(const SizedBox()));
    return c;
  }

  testWidgets('every project is a card, most recent first', (tester) async {
    await show(tester, setup: projects);
    final cards = [
      'super-group-api-lead',
      'super-group-docs-lead',
      'super-group-lead',
    ];
    for (final card in cards) {
      expect(key(card), findsOneWidget, reason: card);
    }
    // Reading order: left to right, then down.
    Offset at(String k) => tester.getTopLeft(key(k));
    for (var i = 1; i < cards.length; i++) {
      final before = at(cards[i - 1]), after = at(cards[i]);
      expect(
        before.dy < after.dy || (before.dy == after.dy && before.dx < after.dx),
        isTrue,
        reason: cards[i],
      );
    }
  });

  testWidgets('a card has its name and one quiet line: the repository, or '
      'Private', (tester) async {
    await show(tester, setup: projects);
    final name = tester
        .widget<Text>(
          find.descendant(
            of: key('super-group-lead'),
            matching: find.text('web-project'),
          ),
        )
        .style!;
    expect(name.fontSize, 13);
    expect(name.fontWeight, grid.AppFont.semibold);
    expect(name.color, grid.AppPalette.textPrimary);
    final repository = tester
        .widget<Text>(
          find.descendant(
            of: key('super-group-lead'),
            matching: find.text('autonomous-ai/openharness'),
          ),
        )
        .style!;
    expect(repository.fontSize, 12);
    expect(repository.color, grid.AppPalette.textFaint);
    expect(
      find.descendant(
        of: key('super-group-docs-lead'),
        matching: find.text('Private'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: key('super-group-api-lead'),
        matching: find.byType(Text),
      ),
      findsOneWidget,
    );
  });

  testWidgets('a card opens its project\'s Board', (tester) async {
    final opened = <SuperTabProject>[];
    await show(tester, setup: projects, opened: opened);
    await tester.tap(key('super-group-docs-lead'));
    expect([for (final p in opened) p.id], ['docs']);
  });

  testWidgets('New project is the one blue button, and opens its form', (
    tester,
  ) async {
    var created = 0;
    await show(tester, setup: projects, onNewProject: () => created++);
    expect(find.byType(FilledButton), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'New project'));
    expect(created, 1);
  });

  testWidgets('a reader who may not make one has no New project', (
    tester,
  ) async {
    await show(tester, setup: projects);
    expect(find.text('New project'), findsNothing);
  });

  testWidgets('a Swarm with no projects says so', (tester) async {
    await show(
      tester,
      setup: (server) => server.state['projects'] = <Map<String, dynamic>>[],
    );
    expect(find.text('No projects yet'), findsOneWidget);
  });

  testWidgets('it fills 880 and wide windows, light and dark, without '
      'overflow', (tester) async {
    for (final brightness in Brightness.values) {
      for (final width in [880.0 - 300, 1440.0 - 300]) {
        await show(tester, setup: projects, brightness: brightness);
        await tester.binding.setSurfaceSize(Size(width, 700));
        await tester.pump();
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      }
    }
  });
}
