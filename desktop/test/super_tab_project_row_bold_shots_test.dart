import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the pictures of task #2638 there, in both themes:
/// # lamp, its chat read and a task under it unread, beside # pilot, whose
/// chat is unread, with # notes open (Huy, 11-04).
final shots = Platform.environment['SUPER_TAB_SIDEBAR_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('project rows bold for their own chat in ${brightness.name}', (
      tester,
    ) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(1600, 900);
      addTearDown(tester.view.reset);
      final server = humansSwarm();
      server.state['projects'] = [
        projectFixture('lead', 'lamp', 'lead'),
        projectFixture('pilot', 'pilot', 'pilot-lead'),
        projectFixture('notes', 'notes', 'notes-lead'),
      ];
      (server.state['conversations'] as List)
        ..add({
          ...conversationFixture('pilot-lead', 'pilot'),
          'projectId': 'pilot',
        })
        ..add({
          ...conversationFixture('notes-lead', 'notes'),
          'projectId': 'notes',
        });
      addNumberedWorkgroups(server, 1);
      final controller = server.controller(
        account: 'peer',
        initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
      );
      await controller.refresh();
      final picture = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: RepaintBoundary(
            key: picture,
            child: Scaffold(
              body: SuperTabView(
                controller: controller,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Studio',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // # lamp's chat read on screen, a person's message in a task under it
      // unread; # pilot's chat unread; # notes open, so no row is selected.
      server.append('Is the lamp wired yet?', conversationId: 'lead');
      server.append('Can you check this?', conversationId: 'g1');
      server.append('A question for everyone', conversationId: 'pilot-lead');
      await controller.refresh();
      await tester.pumpAndSettle();
      await controller.select('lead');
      await tester.pumpAndSettle();
      await controller.select('notes-lead');
      await controller.refresh();
      await tester.pumpAndSettle();
      await captureBoundary(
        tester,
        picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
        shots,
        'project-row-bold-${Platform.environment['SHOT_LABEL'] ?? 'after'}-${brightness.name}',
      );
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }
}
