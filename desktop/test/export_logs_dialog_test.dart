import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/log_export.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/desktop_prompt_surface.dart';
import 'package:harness/widgets/export_logs_dialog.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/real_fonts.dart';

const _error =
    'Could not create the log archive.\nThe destination folder is not writable:\n'
    '/Users/review/Library/Application Support/Harness/Diagnostic Reports\n'
    'Choose a writable destination, check available disk space, and try again.';
const _missingPath =
    '/private/tmp/does-not-exist-harness-review/harness-logs-2026-09-29T16-18-43-924Z.zip';

void main() {
  final output = Platform.environment['SECONDARY_DIALOG_RENDER_DIR'];
  setUpAll(() async {
    await loadRealFonts();
    if (output != null) await loadPreviewFonts();
  });

  Future<GlobalKey> open(
    WidgetTester tester, {
    required Future<LogExportResult> Function() export,
    Brightness brightness = Brightness.dark,
    double scale = 1,
  }) async {
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
                onPressed: () => showExportLogsDialog(context, export: export),
                child: const Text('Export fixture'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Export fixture'));
    await tester.pump();
    return picture;
  }

  Future<void> capture(
    WidgetTester tester,
    GlobalKey picture,
    String name,
  ) async {
    if (output == null) return;
    final previous = debugDisableShadows;
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
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(output).create(recursive: true);
        await File('$output/$name.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
    } finally {
      debugDisableShadows = previous;
    }
  }

  testWidgets('pending export runs once and keeps its existing close guard', (
    tester,
  ) async {
    final pending = Completer<LogExportResult>();
    var calls = 0;
    final picture = await open(
      tester,
      export: () {
        calls++;
        return pending.future;
      },
    );
    expect(find.text('Exporting logs…'), findsOneWidget);
    expect(find.textContaining('Secrets are stripped first.'), findsOneWidget);
    expect(find.text('Close'), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.tapAt(const Offset(10, 10));
    await tester.pump();
    expect(calls, 1);
    expect(find.byType(DesktopPromptSurface), findsOneWidget);
    await capture(tester, picture, 'export-pending');
    pending.complete(const LogExportResult(error: 'The CLI did not answer.'));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.byType(DesktopPromptSurface), findsNothing);
    expect(calls, 1);
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'export failure keeps Close visible ${brightness.name} $scale',
        (tester) async {
          final picture = await open(
            tester,
            export: () async => const LogExportResult(error: _error),
            brightness: brightness,
            scale: scale,
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          expect(
            tester.widget<SelectableText>(find.byType(SelectableText)).data,
            _error,
          );
          final close = find.widgetWithText(FilledButton, 'Close');
          expect(close.hitTestable(), findsOneWidget);
          final before = tester.getRect(close);
          expect(before.bottom, lessThanOrEqualTo(540));
          final scrollbar = tester.widget<Scrollbar>(
            find
                .descendant(
                  of: find.byType(DesktopPromptScrollBody),
                  matching: find.byType(Scrollbar),
                )
                .first,
          );
          expect(scrollbar.thumbVisibility, isTrue);
          await capture(
            tester,
            picture,
            'export-error-${brightness.name}-$scale',
          );
          if (scale == 2) {
            expect(
              scrollbar.controller!.position.maxScrollExtent,
              greaterThan(0),
            );
            await tester.drag(
              find.byType(DesktopPromptScrollBody),
              const Offset(0, -260),
            );
            await tester.pumpAndSettle();
            expect(scrollbar.controller!.offset, greaterThan(0));
            expect(tester.getRect(close), before);
            await capture(
              tester,
              picture,
              'export-error-${brightness.name}-$scale-scrolled',
            );
          }
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pumpAndSettle();
          expect(find.byType(DesktopPromptSurface), findsNothing);
        },
      );

      testWidgets(
        'export success actions grow and traverse ${brightness.name} $scale',
        (tester) async {
          expect(
            File(_missingPath).existsSync(),
            isFalse,
            reason: 'Never reveal a real file from this fixture.',
          );
          final picture = await open(
            tester,
            export: () async => const LogExportResult(path: _missingPath),
            brightness: brightness,
            scale: scale,
          );
          await tester.pumpAndSettle();
          expect(find.text('Logs exported'), findsOneWidget);
          expect(
            find.textContaining('It holds no credentials.'),
            findsOneWidget,
          );
          final close = find.widgetWithText(FilledButton, 'Close');
          final reveal = find.widgetWithText(TextButton, 'Show in Finder');
          for (final (button, text) in [
            (close, 'Close'),
            (reveal, 'Show in Finder'),
          ]) {
            expect(button.hitTestable(), findsOneWidget);
            final label = tester.getRect(find.text(text));
            final bounds = tester.getRect(button);
            expect(label.top - bounds.top, greaterThanOrEqualTo(6));
            expect(bounds.bottom - label.bottom, greaterThanOrEqualTo(6));
          }
          await capture(
            tester,
            picture,
            'export-success-${brightness.name}-$scale',
          );
          await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
          await tester.sendKeyEvent(LogicalKeyboardKey.tab);
          await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
          await tester.pump();
          expect(
            Focus.of(tester.element(find.text('Show in Finder'))).hasFocus,
            isTrue,
          );
          await tester.sendKeyEvent(LogicalKeyboardKey.tab);
          await tester.pump();
          expect(Focus.of(tester.element(find.text('Close'))).hasFocus, isTrue);
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pumpAndSettle();
          expect(find.byType(DesktopPromptSurface), findsNothing);
          expect(tester.takeException(), isNull);
        },
      );
    }
  }
}
