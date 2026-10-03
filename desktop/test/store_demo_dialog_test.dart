import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/store/store_demo_dialog.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/real_fonts.dart';

void main() {
  final output = Platform.environment['SECONDARY_DIALOG_RENDER_DIR'];
  setUpAll(() async {
    await loadRealFonts();
    if (output != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('recording shares the modal veil ${brightness.name} $scale', (
        tester,
      ) async {
        expect(
          WebViewPlatform.instance,
          isNull,
          reason: 'This fixture never loads media or starts a native player.',
        );
        tester.view.physicalSize = const Size(880, 560);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final picture = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: picture,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                body: Builder(
                  builder: (context) => TextButton(
                    onPressed: () => showStoreDemo(
                      context,
                      entry: const DshEntry(
                        id: 'review/blender',
                        name: 'Blender',
                        engine: 'claude',
                      ),
                      example: const StoreExample(
                        prompt: 'Synthetic review only',
                        video: 'https://fixture.invalid/recording.mp4',
                        caption:
                            'Real Blender session · shape a ribbon lamp '
                            'and keep named design variants',
                      ),
                    ),
                    child: const Text('Watch fixture'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Watch fixture'));
        await tester.pump();
        final dialog = find.byType(StoreDemoDialog);
        final route = ModalRoute.of(tester.element(dialog))!;
        expect(route.animation!.isCompleted, isTrue);
        expect(
          find.byWidgetPredicate(
            (widget) =>
                widget is ColoredBox &&
                widget.color == grid.AppDesktop.veil(brightness),
          ),
          findsOneWidget,
        );
        expect(route.barrierColor, Colors.transparent);
        expect(find.text('Blender · Recorded run'), findsOneWidget);
        expect(find.text('Open recording').hitTestable(), findsOneWidget);
        expect(
          find.byKey(const ValueKey('store-demo-browser')).hitTestable(),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('store-demo-close')).hitTestable(),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        if (output != null) {
          final previousShadows = debugDisableShadows;
          debugDisableShadows = false;
          try {
            for (final render in tester.allRenderObjects) {
              render.markNeedsPaint();
            }
            await tester.pump();
            await tester.runAsync(() async {
              final image =
                  await (picture.currentContext!.findRenderObject()!
                          as RenderRepaintBoundary)
                      .toImage(pixelRatio: 1);
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await Directory(output).create(recursive: true);
              await File(
                '$output/store-recording-${brightness.name}-$scale.png',
              ).writeAsBytes(bytes!.buffer.asUint8List());
              image.dispose();
            });
          } finally {
            debugDisableShadows = previousShadows;
          }
        }
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(dialog, findsNothing);
        await tester.tap(find.text('Watch fixture'));
        await tester.pump();
        await tester.tapAt(const Offset(4, 4));
        await tester.pumpAndSettle();
        expect(dialog, findsNothing);
        expect(tester.takeException(), isNull);
      });
    }
  }
}
