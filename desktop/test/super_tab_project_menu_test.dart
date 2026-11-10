import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_menu.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

// 20:33 today on this computer, so the label shows the time and no date
// whatever the day this runs.
final reported = DateTime(
  DateTime.now().year,
  DateTime.now().month,
  DateTime.now().day,
  20,
  33,
);

ConversationServer swarm({bool status = true, String owner = 'owner'}) {
  final server = ConversationServer();
  server.state['projects'] = [
    {
      ...projectFixture('lead', 'openharness', 'lead'),
      'ownerId': owner,
      'coordinatorName': 'Product Manager',
      if (status)
        'status': {
          'text': 'Three fixes are on main tonight.',
          'at': reported.toUtc().toIso8601String(),
          'by': 'kai',
        },
    },
  ];
  return server;
}

Finder get menu => find.byTooltip('Project options');
Finder item(String label) => find.widgetWithText(AppMenuItem, label);

Future<void> open(WidgetTester tester) async {
  await tester.tap(menu);
  await tester.pumpAndSettle();
}

Future<void> openSettings(WidgetTester tester) async {
  await open(tester);
  await tester.tap(item('Project settings…'));
  await tester.pumpAndSettle();
}

void main() {
  // Task #3194 (Diego, 11-05): the same dialog and rows, each with its value,
  // the project and Swarm under the title, and Delete set apart.
  group('Project settings shows each row\'s current value', () {
    Finder row(String label) =>
        find.byKey(ValueKey('super-project-setting-$label'));
    Finder valueOf(String label, String value) =>
        find.descendant(of: row(label), matching: find.text(value));

    testWidgets('the title names the project and its Swarm; Rename shows the '
        'name and Project details Not set', (tester) async {
      final c = await showView(tester, swarm());
      await openSettings(tester);
      expect(find.text('openharness · ${c.snapshot!.name}'), findsOneWidget);
      expect(valueOf('Rename project', 'openharness'), findsOneWidget);
      expect(valueOf('Project details', 'Not set'), findsOneWidget);
    });

    testWidgets('Project details shows the repository, else the folder', (
      tester,
    ) async {
      final server = swarm();
      final project = (server.state['projects'] as List).first as Map;
      project['repository'] = {
        'repositoryUrl': 'https://github.com/acme/openharness',
        'cwd': '/w/openharness',
      };
      await showView(tester, server);
      await openSettings(tester);
      expect(
        valueOf('Project details', 'https://github.com/acme/openharness'),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();

      project['repository'] = {'cwd': '/w/openharness'};
      final folder = swarm();
      ((folder.state['projects'] as List).first as Map)['repository'] = {
        'cwd': '/w/openharness',
      };
      await showView(tester, folder);
      await openSettings(tester);
      expect(valueOf('Project details', '/w/openharness'), findsOneWidget);
    });

    testWidgets('a row not offered shows no value', (tester) async {
      await showView(tester, swarm(owner: 'someone-else'));
      await openSettings(tester);
      expect(row('Rename project'), findsNothing);
      expect(row('Delete Project'), findsNothing);
      expect(valueOf('Project details', 'Not set'), findsOneWidget);
    });

    testWidgets(
      'Delete Project is drawn in the destructive ink, below a rule',
      (tester) async {
        await showView(tester, swarm());
        await openSettings(tester);
        final context = tester.element(row('Delete Project'));
        final label = tester.widget<Text>(
          find.descendant(
            of: row('Delete Project'),
            matching: find.text('Delete Project'),
          ),
        );
        expect(label.style?.color, Theme.of(context).colorScheme.error);
        for (final other in ['Rename project', 'Project details']) {
          final text = tester.widget<Text>(
            find.descendant(of: row(other), matching: find.text(other)),
          );
          expect(
            text.style?.color,
            isNot(Theme.of(context).colorScheme.error),
            reason: other,
          );
        }
        final rule = find.byKey(
          const ValueKey('super-project-setting-danger-rule'),
        );
        expect(rule, findsOneWidget);
        expect(
          tester.getTopLeft(rule).dy,
          lessThan(tester.getTopLeft(row('Delete Project')).dy),
        );
        expect(
          tester.getTopLeft(rule).dy,
          greaterThan(tester.getTopLeft(row('Project details')).dy),
        );
        // Still a plain row: it closes the dialog and does its work.
        await tester.tap(row('Delete Project'));
        await tester.pumpAndSettle();
        expect(find.text('Project settings'), findsNothing);
      },
    );
  });

  // Task #4705: the dialog worked out its rows once, so a save under way when it opened hid Rename until reopened.
  testWidgets('Rename project shows once a save under way finishes', (
    tester,
  ) async {
    final server = swarm();
    final c = await showView(tester, server);
    final hold = server.holdCommands = Completer<void>();
    unawaited(
      c.command({'type': 'project.about', 'projectId': 'lead', 'about': 'x'}),
    );
    await tester.pump();
    expect(c.saving, isTrue);
    await openSettings(tester);
    expect(find.text('Rename project'), findsNothing);
    expect(find.text('Project details'), findsOneWidget);
    hold.complete();
    server.holdCommands = null;
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pumpAndSettle();
    expect(c.saving, isFalse);
    expect(find.text('Rename project'), findsOneWidget);
    await tester.tap(find.text('Rename project'));
    await tester.pumpAndSettle();
    expect(find.text('Project settings'), findsNothing);
  });

  testWidgets('a settings row closes the dialog and does its work', (
    tester,
  ) async {
    await showView(tester, swarm());
    await openSettings(tester);
    await tester.tap(find.text('Delete Project'));
    await tester.pumpAndSettle();
    expect(find.text('Project settings'), findsNothing);
    expect(find.textContaining('Delete'), findsWidgets);
  });

  testWidgets('someone else\'s project offers them no owner\'s rows', (
    tester,
  ) async {
    await showView(tester, swarm(owner: 'someone-else'));
    await open(tester);
    expect(find.text('Sharing'), findsNothing);
    await tester.tap(item('Project settings…'));
    await tester.pumpAndSettle();
    expect(find.text('Rename project'), findsNothing);
    expect(find.text('Delete Project'), findsNothing);
    expect(find.text('Project details'), findsOneWidget);
  });

  // Swarm v4: a task chat from before has no pull-request page (S6).
  testWidgets('another conversation\'s header has its chat and options, and '
      'no pull-request page', (tester) async {
    final server = swarm();
    (server.state['conversations'] as List).add(
      conversationFixture('group-1', 'Offline drafts'),
    );
    final c = await showView(tester, server);
    await c.select('group-1');
    await tester.pumpAndSettle();
    expect(c.selectedId, 'group-1');
    expect(find.byKey(const ValueKey('super-chat')), findsOneWidget);
    expect(find.byKey(const ValueKey('super-pull-requests')), findsNothing);
    expect(find.byKey(const ValueKey('super-group-options')), findsOneWidget);
    expect(menu, findsNothing);
    await c.flush();
    await tester.pump(const Duration(seconds: 5));
  });
}
