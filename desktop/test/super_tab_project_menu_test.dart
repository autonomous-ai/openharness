import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/super_tabs/project_status.dart';

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
  testWidgets('a project\'s header is its name, its menu and the terminal', (
    tester,
  ) async {
    await showView(tester, swarm());
    expect(find.text('# openharness'), findsOneWidget);
    expect(
      find.descendant(of: menu, matching: find.byIcon(AppIcons.chevronDown)),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('super-terminals')), findsOneWidget);
    // Nothing else sits at rest: the views and the old ⋮ moved to the menu.
    expect(find.byKey(const ValueKey('super-chat')), findsNothing);
    expect(find.byKey(const ValueKey('super-pull-requests')), findsNothing);
    expect(find.byKey(const ValueKey('super-group-options')), findsNothing);
  });

  testWidgets('the menu says what the design draws, in its order', (
    tester,
  ) async {
    await showView(tester, swarm());
    await open(tester);
    final labels = [
      'Status',
      'Pull requests',
      'Instructions',
      'Sharing',
      'Notifications',
      'Project settings…',
    ];
    final tops = [
      for (final label in labels)
        tester
            .getTopLeft(
              find.ancestor(
                of: find.text(label),
                matching: find.byWidgetPredicate((w) => w is AppMenuItem),
              ),
            )
            .dy,
    ];
    expect(tops, [...tops]..sort());
    for (final gone in [
      'Rename project',
      'Project details',
      'Switch PM…',
      'Archived conversations',
      'Delete Project',
    ]) {
      expect(find.text(gone), findsNothing, reason: gone);
    }
  });

  testWidgets('Status opens the report with its time, and closes', (
    tester,
  ) async {
    await showView(tester, swarm());
    await open(tester);
    await tester.tap(item('Status'));
    await tester.pumpAndSettle();
    expect(find.text('Status · updated 8:33 PM'), findsOneWidget);
    expect(find.text('Three fixes are on main tonight.'), findsOneWidget);
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    expect(find.text('Three fixes are on main tonight.'), findsNothing);
  });

  testWidgets('Status shows the time alone on any day it runs', (tester) async {
    final day = DateTime.now();
    final late = DateTime(day.year, day.month, day.day, 23, 30);
    final c = swarm().controller();
    addTearDown(c.dispose);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showSuperTabProjectStatusWith(
                context,
                c,
                'lead',
                now: () => late,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(
      find.text('Status · updated 8:33 PM'),
      findsOneWidget,
      reason: 'today, so no date, whatever the day',
    );
    expect(find.text('Three fixes are on main tonight.'), findsOneWidget);
  });

  testWidgets('with no report, Status is there and opens nothing', (
    tester,
  ) async {
    await showView(tester, swarm(status: false));
    await open(tester);
    expect(tester.widget<AppMenuItem>(item('Status')).onPressed, isNull);
  });

  testWidgets('Pull requests opens the view, and the chat button comes back', (
    tester,
  ) async {
    await showView(tester, swarm());
    await open(tester);
    await tester.tap(item('Pull requests'));
    await tester.pumpAndSettle();
    final chat = find.byKey(const ValueKey('super-chat'));
    expect(chat, findsOneWidget);
    await tester.tap(chat);
    await tester.pumpAndSettle();
    expect(chat, findsNothing);
  });

  testWidgets('Project settings… holds rename, switch PM, archived, delete', (
    tester,
  ) async {
    final server = swarm();
    (server.state['conversations'] as List).add({
      ...conversationFixture('old', 'Old work'),
      'archived': true,
      'projectId': 'lead',
    });
    await showView(tester, server);
    await openSettings(tester);
    for (final label in [
      'Rename project',
      'Project details',
      'Archived conversations',
      'Delete Project',
    ]) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
  });

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

    testWidgets('Archived counts its conversations only once they are read to '
        'the end, and starts no read', (tester) async {
      final server = swarm();
      (server.state['conversations'] as List).addAll([
        {
          ...conversationFixture('old', 'Old work'),
          'archived': true,
          'projectId': 'lead',
        },
        {
          ...conversationFixture('older', 'Older work'),
          'archived': true,
          'projectId': 'lead',
        },
      ]);
      final c = await showView(tester, server);
      await openSettings(tester);
      expect(row('Archived conversations'), findsOneWidget);
      expect(
        find.descendant(
          of: row('Archived conversations'),
          matching: find.textContaining('conversation'),
        ),
        findsOneWidget, // the label alone
      );
      expect(c.dormantLoaded('lead'), isFalse);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();

      await c.loadDormant('lead');
      await tester.pumpAndSettle();
      await openSettings(tester);
      expect(
        valueOf('Archived conversations', '2 conversations'),
        findsOneWidget,
      );
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

  testWidgets('another conversation\'s header is unchanged', (tester) async {
    final server = swarm();
    (server.state['conversations'] as List).add(
      conversationFixture('group-1', 'Offline drafts'),
    );
    final c = await showView(tester, server);
    await c.select('group-1');
    await tester.pumpAndSettle();
    expect(c.selectedId, 'group-1');
    expect(find.byKey(const ValueKey('super-chat')), findsOneWidget);
    expect(find.byKey(const ValueKey('super-pull-requests')), findsOneWidget);
    expect(find.byKey(const ValueKey('super-group-options')), findsOneWidget);
    expect(menu, findsNothing);
    await c.flush();
    await tester.pump(const Duration(seconds: 5));
  });
}
