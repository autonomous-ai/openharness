import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/layout_palette.dart';

import 'support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);
  for (final (count, scale) in [
    for (final count in [2, 3, 4, 5, 6, 7, 8, 9, 12, 16, 32, 64]) (count, 1.0),
    (5, 2.0),
  ]) {
    testWidgets(
      '$count-pane Layout choices fit the minimum window at text scale $scale',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(880, 560);
        addTearDown(tester.view.reset);
        final app = AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          configStore: null,
        );
        for (var i = 0; i < count; i++) {
          app.panes.add(TerminalPane(id: i, machineId: 'm', agentId: 'a$i'));
        }
        final capture = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: capture,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                backgroundColor: grid.AppPalette.swarmField,
                body: Builder(
                  builder: (context) => TextButton(
                    onPressed: () => showLayoutPalette(context, app),
                    child: const Text('Layout'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Layout'));
        await tester.pumpAndSettle();
        final output = Platform.environment['HARNESS_LAYOUT_CAPTURE_DIR'];
        if (output != null) {
          final boundary =
              capture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 1);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File('$output/layout-$count-880-$scale.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
        expect(tester.takeException(), isNull);
        final choices = PanePreset.forCount(count);
        Rect card(PanePreset preset) => tester.getRect(
          find.ancestor(
            of: find.text(preset.label),
            matching: find.byType(TextButton),
          ),
        );
        for (final preset in choices) {
          expect(find.text(preset.label).hitTestable(), findsOneWidget);
          expect(
            tester
                .renderObject<RenderParagraph>(find.text(preset.label))
                .didExceedMaxLines,
            isFalse,
          );
        }
        final first = card(choices.first);
        final below = choices.where((preset) {
          final rect = card(preset);
          return rect.top > first.top && (rect.left - first.left).abs() < 1;
        }).firstOrNull;
        // Start explicitly at the first option so legacy automatic geometry
        // does not choose a different initial card for this keyboard check.
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        app.setPreset(count, choices.first);
        await tester.tap(find.text('Layout'));
        await tester.pumpAndSettle();
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(
          app.presetFor(count),
          below ?? choices.first,
          reason: 'Down follows the row actually drawn below',
        );
        expect(find.byType(Dialog), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }
}
