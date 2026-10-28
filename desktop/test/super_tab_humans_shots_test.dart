import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/humans_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_HUMANS_SHOTS'];

/// The Swarm's Humans section and sidebar as the PR shows them: the right
/// pane with everyone's week, the leaderboard column where one still exists,
/// the sidebar after a direct message is opened from collapsed projects, and
/// a project and a machine opened by a click on their rows.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = humansSwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.select('lead');
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1500, 860));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) =>
              RepaintBoundary(key: picture, child: child),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      c.expandedProjects.clear();
      if (!c.projectsGroupOpen) c.toggleProjectsGroup();
      await tester.pumpAndSettle();

      Future<void> shot(String name) => tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1.5);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/humans-$name-${brightness.name}.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });

      await shot('humans');
      final trophy = find.byKey(const ValueKey('super-leaderboard'));
      if (trophy.evaluate().isNotEmpty) {
        await tester.tap(trophy);
        await tester.pumpAndSettle();
        await shot('leaderboard');
        await tester.tap(trophy);
        await tester.pumpAndSettle();
      }
      await tester.tap(find.byKey(const ValueKey('super-pm-chat-lead')));
      await tester.pumpAndSettle();
      await shot('dm');
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-machine-studio')));
      await tester.pumpAndSettle();
      await shot('project');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    }, skip: shots == null);
  }
}
