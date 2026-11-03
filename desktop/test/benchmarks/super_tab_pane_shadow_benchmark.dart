// Run explicitly: flutter test test/benchmarks/super_tab_pane_shadow_benchmark.dart --reporter expanded
// Headless measurements of the Swarm view with a thread open on the right,
// where the right pane shades the chat along its left edge (#2424): CPU per frame while
// the thread's divider is dragged (every frame lays out and repaints the
// panes), and software rasterization of the whole window, with real shadows
// (the composer's among them).
// Neither is display latency; compare heads measured the same way.
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import '../support/super_tab_fixture.dart';
import 'swarm_benchmark.dart' show distribution;

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('Swarm view with a thread open: divider drag and raster '
        '(${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = ConversationServer()..threads = true;
      server.append('Should we do thread replies?');
      for (var i = 1; i <= 20; i++) {
        server.append('Reply $i: the reconnect keeps every edit in order.');
        server.messages.last
          ..['thread'] = 'message-1'
          ..['replyTo'] = 'message-1';
      }
      for (var i = 1; i <= 40; i++) {
        server.append('Update $i: pushed the branch; the checks are running.');
      }
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      // The real, blurred shadow, not flutter_test's hard-edged stand-in.
      debugDisableShadows = false;
      addTearDown(() => debugDisableShadows = true);
      await tester.binding.setSurfaceSize(const Size(1400, 800));
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
      await tester.pumpAndSettle();
      c.openThread('message-1');
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-thread-panel')), findsOne);

      final drag = await tester.startGesture(
        tester.getCenter(find.byKey(const ValueKey('super-resize-right'))),
      );
      // Past the drag slop first, so every measured frame resizes the panes.
      await drag.moveBy(const Offset(-40, 0));
      await tester.pump();
      final right = find.byKey(const ValueKey('super-right-pane'));
      var step = 0;
      Future<int> frame() async {
        final watch = Stopwatch()..start();
        await drag.moveBy(Offset((step++).isEven ? -8 : 8, 0));
        await tester.pump();
        return watch.elapsedMicroseconds;
      }

      final before = tester.getSize(right).width;
      await frame();
      expect(tester.getSize(right).width, isNot(before), reason: 'resized');
      for (var i = 0; i < 20; i++) {
        await frame();
      }
      final frames = [for (var i = 0; i < 200; i++) await frame()];
      await drag.up();
      await tester.pumpAndSettle();

      final boundary =
          picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final rasters = (await tester.runAsync(() async {
        Future<int> raster() async {
          final watch = Stopwatch()..start();
          final image = await boundary.toImage();
          await image.toByteData(format: ui.ImageByteFormat.rawRgba);
          final elapsed = watch.elapsedMicroseconds;
          image.dispose();
          return elapsed;
        }

        for (var i = 0; i < 5; i++) {
          await raster();
        }
        return [for (var i = 0; i < 40; i++) await raster()];
      }))!;

      // ignore: avoid_print
      print(
        jsonEncode({
          'benchmark': 'super_tab_pane_shadow',
          'brightness': brightness.name,
          'dividerDragFrame': distribution(frames),
          'windowRaster': distribution(rasters),
        }),
      );
      // flutter_test checks its debug flags before tear-downs run.
      debugDisableShadows = true;
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
      await c.flush();
    });
  }
}
