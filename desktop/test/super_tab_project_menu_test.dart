import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

// 20:33 on this computer, whatever its zone.
final reported = DateTime(2026, 11, 2, 20, 33);

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
Finder item(String label) => find.widgetWithText(MenuItemButton, label);

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
                matching: find.byWidgetPredicate(
                  (w) => w is MenuItemButton || w is SubmenuButton,
                ),
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

  testWidgets('with no report, Status is there and opens nothing', (
    tester,
  ) async {
    await showView(tester, swarm(status: false));
    await open(tester);
    expect(tester.widget<MenuItemButton>(item('Status')).onPressed, isNull);
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
