import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/humans_fixture.dart';

/// Set to a folder to write the project rows' pictures there: a project
/// collapsed and expanded, in both themes.
final shots = Platform.environment['SUPER_TAB_SIDEBAR_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('project rows in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2000, 1400);
      addTearDown(tester.view.reset);
      final server = humansSwarm();
      addNumberedWorkgroups(server, 11);
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
      Future<void> take(String name) async {
        await tester.pumpAndSettle();
        await captureBoundary(
          tester,
          picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
          shots,
          'project-rows-$name-${brightness.name}',
        );
      }

      controller.expandedProjects.clear();
      await take('collapsed');
      controller.toggleProject('lead');
      await take('expanded');
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }
}
