import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_menu.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's pictures of Project settings (task
/// #3194) there, in light and dark.
final _shots = Platform.environment['PROJECT_SETTINGS_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  for (final brightness in Brightness.values) {
    testWidgets('pictures of Project settings with each row\'s value, in '
        '${brightness.name}', (tester) async {
      if (_shots == null) return;
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      final server = ConversationServer();
      server.state['projects'] = [
        {
          ...projectFixture('lead', 'openharness', 'lead'),
          'repository': {
            'repositoryUrl': 'https://github.com/autonomous-ai/openharness',
          },
        },
      ];
      (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
        for (var i = 0; i < 3; i++)
          {
            ...conversationFixture('old-$i', 'Old work $i'),
            'archived': true,
            'projectId': 'lead',
          },
      ]);
      final c = await showView(tester, server, brightness: brightness);
      await tester.runAsync(() => c.loadDormant('lead'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Project options'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(AppMenuItem, 'Project settings…'));
      await tester.pumpAndSettle();
      await captureWindow(
        tester,
        _shots,
        'project-settings-${brightness.name}',
      );
      await c.flush();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }
}
