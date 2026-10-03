import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/companions/coding_memory_library.dart';
import 'package:harness/companions/coding_memory_view.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';

import '../test/support/coding_memory_fixture.dart';

// Synthetic owner replies only. No CLI, real conversations, provider or memory database.
// This exercises Flutter's native renderer and key handling, not physical AppKit IME/VoiceOver.
void main() {
  if (!kUnderTest) throw StateError('Memory fixtures require FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy =
      LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(860, 900));
    await windowManager.show();
  });

  for (final brightness in [Brightness.dark, Brightness.light]) {
    testWidgets(
      'native memory ${brightness.name} rates recall and explains stalled learning',
      (tester) async {
        final connection = MemoryFixture()..recalls.add(syntheticRecall());
        final library = CodingMemoryLibrary(connection);
        final boundary = GlobalKey();
        await library.refresh();
        final oldPalette = AppTheme.palette.value,
            oldBrightness = AppTheme.brightness.value;
        AppTheme.palette.value = brightness == Brightness.dark
            ? HarnessPalette.graphite
            : HarnessPalette.paper;
        AppTheme.brightness.value = brightness;
        addTearDown(() {
          library.dispose();
          AppTheme.palette.value = oldPalette;
          AppTheme.brightness.value = oldBrightness;
        });
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildAppTheme(brightness: brightness),
              home: Scaffold(
                body: SingleChildScrollView(
                  padding: const EdgeInsets.all(24),
                  child: CodingMemoryView(library: library),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Helping now'));
        await tester.pumpAndSettle();
        expect(
          find.text('Sent by Harness · Delivery not confirmed'),
          findsOneWidget,
        );
        await tester.ensureVisible(find.text('Helpful'));
        final helpful = tester
            .widgetList<DesktopPill>(find.byType(DesktopPill))
            .singleWhere((p) => p.label == 'Helpful');
        helpful.focusNode!.requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(
          connection.calls.where((p) => p['action'] == 'apply'),
          hasLength(1),
        );
        expect(
          (connection.recalls.single['feedback'] as Map)['value'],
          'helpful',
        );
        expect(helpful.focusNode!.hasFocus, isTrue);
        final directory =
            Platform.environment['HARNESS_MEMORY_NATIVE_CAPTURE_DIR'];
        if (directory != null) {
          final shot =
              await (boundary.currentContext!.findRenderObject()
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 1);
          try {
            final bytes = await shot.toByteData(format: ui.ImageByteFormat.png);
            final output = File(
              '$directory/activity-native-${brightness.name}.png',
            );
            await output.parent.create(recursive: true);
            await output.writeAsBytes(bytes!.buffer.asUint8List());
          } finally {
            shot.dispose();
          }
        }
        connection.handle = (p) async => p['action'] == 'activity'
            ? syntheticActivity(connection.record, empty: true)
            : connection.respond(p);
        await library.refresh();
        await tester.pumpAndSettle();
        expect(find.text(connection.record['claim'] as String), findsNothing);
        expect(
          find.text('No memories were selected for the last recorded request.'),
          findsOneWidget,
        );
        connection.runtime = {
          'state': 'ready',
          'learning': {'state': 'waiting_for_model'},
          'capture': {'state': 'unavailable', 'reason': 'memory_backlog_full'},
        };
        await library.refresh();
        await tester.pumpAndSettle();
        expect(find.text('Learning needs attention'), findsOneWidget);
        final review = find.text('Review learning');
        await tester.ensureVisible(review);
        Focus.of(tester.element(review)).requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.text('Learn from coding sessions'), findsOneWidget);
        expect(find.textContaining('queue is full'), findsOneWidget);
        expect(
          connection.calls.where((p) => p['action'] == 'apply'),
          hasLength(1),
        );
        if (directory != null) {
          final shot =
              await (boundary.currentContext!.findRenderObject()
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 1);
          try {
            final bytes = await shot.toByteData(format: ui.ImageByteFormat.png);
            await File('$directory/learning-native-${brightness.name}.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
          } finally {
            shot.dispose();
          }
        }
        connection.runtime = {
          'state': 'ready',
          'learning': {
            'state': 'waiting_for_model',
            'reason': 'inference_provider_restricted',
          },
        };
        await library.refresh();
        await tester.pumpAndSettle();
        expect(
          find.textContaining('provider declined background learning'),
          findsOneWidget,
        );
        expect(find.textContaining('Choose another model'), findsOneWidget);
        expect(connection.learn, isTrue);
        expect(connection.recall, isTrue);
        expect(
          connection.calls.where((p) => p['action'] == 'apply'),
          hasLength(1),
        );
        if (directory != null) {
          final shot =
              await (boundary.currentContext!.findRenderObject()
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 1);
          try {
            final bytes = await shot.toByteData(format: ui.ImageByteFormat.png);
            await File(
              '$directory/provider-refusal-native-${brightness.name}.png',
            ).writeAsBytes(bytes!.buffer.asUint8List());
          } finally {
            shot.dispose();
          }
        }
        expect(tester.takeException(), isNull);
      },
    );
  }
}
