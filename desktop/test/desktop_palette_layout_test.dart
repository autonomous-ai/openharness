import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/layout_palette.dart';
import 'package:harness/widgets/move_pane_palette.dart';
import 'package:harness/widgets/swarm_dialogs.dart';

import 'support/real_fonts.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
    if (Platform.isMacOS &&
        Platform.environment['HARNESS_PALETTE_CAPTURE_DIR'] != null) {
      final font = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
        await (FontLoader(family)..addFont(Future.value(font))).load();
      }
    }
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.7]) {
      for (final surface in ['layout', 'move', 'rename']) {
        final move = surface == 'move';
        final rename = surface == 'rename';
        testWidgets(
          '$surface is readable and reachable in ${brightness.name} at $scale',
          (tester) async {
            final size = scale == 1
                ? const Size(860, 620)
                : const Size(420, 460);
            tester.view.devicePixelRatio = 1;
            tester.view.physicalSize = size;
            addTearDown(tester.view.reset);
            grid.AppTheme.brightness.value = brightness;
            addTearDown(() => grid.AppTheme.brightness.value = Brightness.dark);
            final app = createApp();
            final source = app.activeSwarmId;
            app.panes.addAll([
              for (var i = 0; i < 4; i++)
                TerminalPane(id: i, machineId: 'm', agentId: 'a$i'),
            ]);
            for (var i = 0; i < 16; i++) {
              app.newSwarm(name: 'Project ${i + 1} · workspace review');
            }
            app.selectSwarm(source);
            app.focusPane(0);
            final key = GlobalKey();
            await tester.pumpWidget(
              RepaintBoundary(
                key: key,
                child: MaterialApp(
                  debugShowCheckedModeBanner: false,
                  theme: grid.buildAppTheme(brightness: brightness),
                  builder: (context, child) => MediaQuery(
                    data: MediaQuery.of(context).copyWith(
                      textScaler: TextScaler.linear(scale),
                      disableAnimations: true,
                    ),
                    child: child!,
                  ),
                  home: Scaffold(
                    body: Builder(
                      builder: (context) => TextButton(
                        onPressed: () => rename
                            ? showSwarmRenameDialog(context, 'Desktop')
                            : move
                            ? showMovePanePalette(context, app)
                            : showLayoutPalette(context, app),
                        child: const Text('Open'),
                      ),
                    ),
                  ),
                ),
              ),
            );
            await tester.tap(find.text('Open'));
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
            if (move) {
              // Wrapping the keyboard selection must reveal an offscreen row.
              await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
              await tester.pumpAndSettle();
              final last = tester.getRect(find.text('New Tab'));
              expect(last.top, greaterThan(0));
              expect(last.bottom, lessThan(size.height));
            }
            final dismiss = rename
                ? find.text('Cancel')
                : find.byTooltip('Close');
            final close = tester.getRect(dismiss);
            expect(close.top, greaterThanOrEqualTo(24));
            expect(close.bottom, lessThan(size.height - 24));
            final directory =
                Platform.environment['HARNESS_PALETTE_CAPTURE_DIR'];
            if (directory != null) {
              final previousShadows = debugDisableShadows;
              debugDisableShadows = false;
              final boundary =
                  key.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary;
              void repaint(RenderObject object) {
                object.markNeedsPaint();
                object.visitChildren(repaint);
              }

              repaint(boundary);
              await tester.pump();
              await tester.runAsync(() async {
                final image = await boundary.toImage(pixelRatio: 1);
                final bytes = await image.toByteData(
                  format: ui.ImageByteFormat.png,
                );
                await Directory(directory).create(recursive: true);
                await File('$directory/$surface-${brightness.name}-$scale.png')
                    .writeAsBytes(bytes!.buffer.asUint8List());
                image.dispose();
              });
              debugDisableShadows = previousShadows;
              repaint(boundary);
              await tester.pump();
            }
            await tester.tap(dismiss);
            await tester.pumpAndSettle();
            expect(app.activeSwarmId, source);
            expect(
              app.panes.length,
              4,
              reason: 'Reviewing must not change the workspace',
            );
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
            app.dispose();
          },
        );
      }
    }
  }
}
