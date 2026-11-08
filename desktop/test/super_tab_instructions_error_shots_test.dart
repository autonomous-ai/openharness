// Task #3652 (Hoai, 11-06): a refused instructions save, for the PR's pictures, light and dark: the panel saying
// why, then the chat after it closes with no error in its Reply box. Writes nothing unless HARNESS_SUPER_TAB_CAPTURE
// names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('a refused instructions save in ${brightness.name}', (
      tester,
    ) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2400, 1600);
      addTearDown(tester.view.reset);

      final server = ConversationServer();
      server.state['projects'] = [
        {
          ...projectFixture('lead', 'Pilot', 'lead'),
          'coordinatorName': 'Product Manager',
          'instructionsRevision': 3,
        },
      ];
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'role': 'collaborator',
      });
      server.instructions['lead'] = {
        'projectId': 'lead',
        'revision': 3,
        'hash': 'hash-lead-3',
        'text':
            '## Roles\n\n### PM\n- Talks with people in the project chat.\n',
        'template': false,
        'coordinatorName': 'Product Manager',
        'notesRevision': 0,
        'notes': <dynamic>[],
      };
      server.append('Morning. The release is out.');
      final c = server.controller(account: 'peer');
      await c.refresh();
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        c.dispose();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Test Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Project options'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(AppMenuItem, 'Instructions'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('super-instructions-editor')),
        '## Roles\n\n### PM\n- Talks with people in the project chat.\n'
        '- A long new rule.\n',
      );
      await tester.enterText(
        find.byKey(const ValueKey('super-instructions-summary')),
        'A new rule',
      );
      await tester.pump();
      server.refuse = {
        'code': 'INSTRUCTIONS_BUDGET',
        'message': 'Not saved: Core over budget.',
      };
      server.refuseStatus = 400;
      await tester.tap(find.byKey(const ValueKey('super-instructions-save')));
      await tester.pumpAndSettle();
      server.refuse = null;
      await captureWindow(
        tester,
        shots,
        'instructions-refused-${brightness.name}',
      );

      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Discard'));
      await tester.pumpAndSettle();
      await captureWindow(
        tester,
        shots,
        'instructions-refused-closed-${brightness.name}',
      );
    });
  }
}
