import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/profile_sheet.dart';
import 'package:harness/super_tabs/ship_row.dart';
import 'package:window_manager/window_manager.dart';

import '../test/super_tab_delight_shots_test.dart' show delightApp, office;
import 'flutter_test_config.dart';

/// The avatars-and-delight PR's screenshots on a real macOS surface, where
/// color emoji draw: the in-memory Swarm of the widget capture, never a
/// backend, account or the live app. Writes to SUPER_TAB_DELIGHT_SHOTS.
void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  ensureNativeTestBinding();
  final folder = Platform.environment['SUPER_TAB_DELIGHT_SHOTS'];
  final boundary = GlobalKey();

  Future<void> shot(String name) async {
    if (folder == null) return;
    final render =
        boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await render.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(folder).create(recursive: true);
    await File('$folder/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  }

  testWidgets('avatars, status, reactions and a ship moment', (tester) async {
    expect(defaultTargetPlatform, TargetPlatform.macOS);
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1280, 860));
    await windowManager.setTitle('Swarm delight — test data');
    await windowManager.setAlwaysOnTop(true);
    addTearDown(() => windowManager.setAlwaysOnTop(false));
    await windowManager.show();
    for (final (brightness, reduceMotion, name) in [
      (Brightness.dark, false, 'dark'),
      (Brightness.light, true, 'light-reduced-motion'),
    ]) {
      SuperTabShipRow.resetPlayed();
      grid.AppTheme.brightness.value = brightness;
      final c = office().controller();
      await c.refresh();
      await tester.pumpWidget(
        delightApp(
          c,
          brightness: brightness,
          reduceMotion: reduceMotion,
          boundary: boundary,
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 650));
      await tester.runAsync(() => shot('office-$name'));
      await tester.pumpAndSettle();
      await tester.runAsync(() => shot('office-$name-settled'));
      final context = tester.element(find.byType(Scaffold).first);
      showSuperTabProfile(context, c);
      await tester.pumpAndSettle();
      await tester.runAsync(() => shot('profile-$name'));
      Navigator.of(context, rootNavigator: true).pop();
      await tester.pumpAndSettle();
      showSuperTabProfile(context, c, agentId: 'kai');
      await tester.pumpAndSettle();
      await tester.runAsync(() => shot('agent-avatar-$name'));
      Navigator.of(context, rootNavigator: true).pop();
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    }
    grid.AppTheme.brightness.value = Brightness.dark;
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
}
