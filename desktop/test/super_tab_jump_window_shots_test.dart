import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write task #2911's screenshots there: the chat's Jump to
/// menu on a busy chat, and where Last week lands, lit, in light and dark.
final shots = Platform.environment['SUPER_TAB_JUMP_SHOTS'];

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final before = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = before);
      await tester.binding.setSurfaceSize(const Size(1000, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final now = DateTime.now();
      final server = ConversationServer();
      const updates = [
        'Reading the offline queue before the reconnect.',
        'The reconnect keeps every queued edit in order.',
        'Two devices editing at once settle on the newest edit.',
        'Pushed the branch; the checks are running.',
      ];
      // Two weeks, 3,000 updates: about one every seven minutes.
      const count = 3000;
      final start = now.subtract(const Duration(days: 14));
      final step = const Duration(days: 14).inSeconds ~/ count;
      for (var i = 0; i < count; i++) {
        server.append(updates[i % updates.length]);
        server.messages.last
          ..['author'] = {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'}
          ..['createdAt'] = start
              .add(Duration(seconds: step * i))
              .toUtc()
              .toIso8601String();
      }
      server.markReadElsewhere('lead', count);
      final c = server.controller();
      await c.refresh();
      final picture = GlobalKey();
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
      addTearDown(c.dispose);
      Future<void> shoot(String name) async {
        if (shots == null) return;
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/$name.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }

      const list = PageStorageKey('super-messages-tab-lead');
      debugDisableShadows = false;
      try {
        await tester.drag(find.byKey(list), const Offset(0, 300));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-day-pill')));
        await tester.pumpAndSettle();
        await shoot('jump-menu-${brightness.name}');
        await tester.tap(find.text('Last week'));
        for (var i = 0; i < 6; i++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        await shoot('jump-landed-${brightness.name}');
        await tester.pumpAndSettle(const Duration(seconds: 3));
        expect(c.messages('lead').length, lessThanOrEqualTo(200));
      } finally {
        // Back before the test ends, which checks it was.
        debugDisableShadows = true;
      }
    });
  }
}
