import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/repository_clone.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/new_agent.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'super_tab_new_agent_words_test.dart'
    show mountSwarm, tapNewAgent, unmountSwarm;

/// anh Dee, 2026-11-10: "as soon as i hit new project or new agent, just get me back to my main screen so i can continue
/// doing work. show the agent/project on the left sidebar. grey out or something with loading status. when it's done i can
/// go in and use it. NEVER block users for minutes." Its folder is what takes minutes here, as a clone of a big repository
/// does: it is made only when the test says so.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  final form = find.byType(NewHarnessForm);
  final starts = find.byWidgetPredicate(
    (widget) =>
        widget.key is ValueKey<String> &&
        (widget.key! as ValueKey<String>).value.startsWith('super-start-'),
  );
  Finder inStart(String text) =>
      find.descendant(of: starts, matching: find.text(text));

  List<Map> commands(SuperTabLaunchFixture f) => [
    for (final post in f.connection.server.posts)
      if (post['command'] case final Map command) command,
  ];

  /// Pumps frames until [done], at most [limit]: a start never lets the frames settle.
  Future<void> until(
    WidgetTester tester,
    bool Function() done, {
    int limit = 200,
  }) async {
    for (var i = 0; i < limit && !done(); i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  Future<void> end(WidgetTester tester, SuperTabLaunchFixture f) async {
    await unmountSwarm(tester, f);
    f.dispose();
    await tester.pump();
  }

  /// Your Team's +, Claude Code, a request and New agent, as a person clicks them.
  Future<void> startAgent(WidgetTester tester) async {
    await tapNewAgent(tester);
    await tester.tap(key('new-harness-field-agent'));
    await tester.pumpAndSettle();
    await tester.tap(key('new-harness-option-claude'));
    await tester.pumpAndSettle();
    await tester.enterText(key('new-harness-task'), 'Tidy the docs.');
    await tester.pump();
    await tester.tap(key('new-harness-field-start'));
  }

  testWidgets('New agent: the form closes at once and Your Team shows it greyed, starting; once it runs it is its own row, which opens '
      'its chat, and nothing moved its person meanwhile', (tester) async {
    final folder = Completer<String>();
    final f = await mountSwarm(tester, prepareFolder: (_) => folder.future);
    f.connection.journaled = false;
    final c = f.app.superTabs.peek(tabId)!;
    final before = c.selectedId;
    await startAgent(tester);
    await until(tester, () => form.evaluate().isEmpty);

    // Back on the screen they were on, the folder still being made.
    expect(form, findsNothing);
    expect(c.selectedId, before);
    expect(
      f.connection.calls.where((call) => call.$1 == 'agent_create'),
      isEmpty,
    );
    final name =
        commands(f).singleWhere((c) => c['type'] == 'agent.new')['name']
            as String;
    expect(starts, findsOneWidget);
    expect(inStart(name), findsOneWidget);
    expect(inStart('starting'), findsOneWidget);
    // Greyed: its face is an offline one's, and it opens nothing yet.
    expect(
      find.descendant(of: starts, matching: key('super-face-offline')),
      findsOneWidget,
    );
    await tester.tap(starts);
    await tester.pump();
    expect(c.selectedId, before);
    expect(form, findsNothing);

    folder.complete('/work/new-agent');
    await until(
      tester,
      () => f.connection.joins.isNotEmpty && starts.evaluate().isEmpty,
    );
    expect(starts, findsNothing);
    final agent = c.snapshot!.agents.singleWhere(
      (a) => (a.displayName ?? a.name) == name,
    );
    expect(key('super-agent-${agent.id}'), findsOneWidget);
    expect(c.selectedId, before);

    // Its person goes in when they choose to.
    final chat =
        (f.connection.joins.single['command'] as Map)['conversationId'];
    await tester.tap(key('super-agent-${agent.id}'));
    await until(tester, () => c.selectedId == chat);
    expect(c.selectedId, chat);
    expect(tester.takeException(), isNull);
    await end(tester, f);
  });

  testWidgets(
    'New project: the form closes at once and Projects shows it starting, in place of its own row; once its Product Manager '
    'runs it is the project\'s row, and nothing moved its person meanwhile',
    (tester) async {
      final folder = Completer<String>();
      final f = await mountSwarm(tester, prepareFolder: (_) => folder.future);
      final c = f.app.superTabs.peek(tabId)!;
      final before = c.selectedId;
      final add = key('project-sidebar-projects-add');
      await tester.ensureVisible(add);
      await tester.tap(add);
      await tester.pumpAndSettle();
      expect(form, findsOneWidget);
      await tester.enterText(key('new-harness-task'), 'A home for the docs.');
      await tester.pump();
      await tester.tap(key('new-harness-field-start'));
      await until(tester, () => form.evaluate().isEmpty);

      expect(form, findsNothing);
      expect(c.selectedId, before);
      // The project is made in a moment; only its own row is not drawn while it starts, the start's is.
      final made = commands(f).where((c) => c['type'] == 'project.create');
      expect(made, hasLength(1));
      // The Swarm, read again while it starts, has the project: its own row waits, the start's stands in.
      await c.refresh();
      await tester.pump();
      final project = (f.connection.server.state['projects'] as List)
          .cast<Map>()
          .last;
      expect(c.snapshot!.projects.map((p) => p.id), contains(project['id']));
      expect(key('super-project-${project['id']}'), findsNothing);
      expect(starts, findsOneWidget);
      expect(inStart('starting'), findsOneWidget);

      folder.complete('/work/docs-home');
      await until(
        tester,
        () => f.connection.joins.isNotEmpty && starts.evaluate().isEmpty,
      );
      expect(starts, findsNothing);
      expect(key('super-project-${project['id']}'), findsOneWidget);
      expect(c.selectedId, before);
      expect(tester.takeException(), isNull);
      await end(tester, f);
    },
  );

  test('a second press while it still checks keeps the start that goes on without its form', () async {
    final f = SuperTabLaunchFixture()..connection.journaled = false;
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    // Its project's Git is read slowly: the first press waits there, busy.
    final git = Completer<Map<String, dynamic>>();
    f.app.gitProjectReaderForTest = (_, _) => git.future;
    final box = NewHarnessController(
      f.app,
      machineId: 'm',
      engine: 'claude',
      folder: '/work/project',
      task: 'Tidy the docs.',
      integration: swarmNewAgent(f.app, f.app.activeSwarm, wait: (_) async {}),
    );
    addTearDown(box.dispose);
    final first = box.create();
    expect(box.busy, isTrue);
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(box.running, same(first));
    git.complete({'isGit': false, 'refreshed': true});
    expect(await first, NewHarnessOutcome.created, reason: box.error);
  });

  testWidgets(
    'a start that fails says so on its row, in red, and a click on it opens its form again with why',
    (tester) async {
      final f = await mountSwarm(
        tester,
        prepareFolder: (_) async =>
            throw const RepositoryCloneException('The network went away.'),
      );
      f.connection.journaled = false;
      await startAgent(tester);
      await until(tester, () => inStart('failed').evaluate().isNotEmpty);
      expect(form, findsNothing);
      expect(inStart('failed'), findsOneWidget);
      expect(
        tester.widget<Text>(inStart('failed')).style?.color,
        Theme.of(tester.element(starts)).colorScheme.error,
      );

      await tester.tap(starts);
      await tester.pumpAndSettle();
      expect(form, findsOneWidget);
      expect(find.textContaining('The network went away.'), findsWidgets);
      // The form has it now: the row goes, and Try again is the form's.
      expect(starts, findsNothing);
      expect(tester.takeException(), isNull);
      await end(tester, f);
    },
  );
}
