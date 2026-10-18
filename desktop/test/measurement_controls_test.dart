import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/measurement/setup_usage_choice.dart';
import 'package:harness/measurement/task_feedback.dart';
import 'package:harness/shared/widgets/product_feedback.dart';

import 'support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);
  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.8]) {
      testWidgets('measurement controls ${brightness.name} scale $scale', (
        tester,
      ) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(390, 844);
        addTearDown(tester.view.reset);
        final usage = ProductMeasurement(
          surface: 'desktop',
          automatic: false,
          sendSetup: (_) async => {},
        );
        addTearDown(usage.dispose);
        final sent = <String>[];
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                body: SafeArea(
                  child: SingleChildScrollView(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        children: [
                          SetupUsageChoice(measurement: usage),
                          ProductFeedback(
                            outcome: true,
                            send: (answer, _) async => sent.add(answer),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(usage.signedOutSharing, isTrue);
        expect(sent, isEmpty);
        final output = Platform.environment['HARNESS_MEASUREMENT_CAPTURE_DIR'];
        if (output != null) {
          final render =
              boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final picture = await render.toImage(pixelRatio: 1);
            final bytes = await picture.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File('$output/controls-${brightness.name}-$scale.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            picture.dispose();
          });
        }
        await tester.tap(find.byType(Switch));
        await tester.pumpAndSettle();
        expect(usage.signedOutSharing, isFalse);
        await tester.ensureVisible(find.text('Partly completed'));
        await tester.tap(find.text('Partly completed'));
        await tester.pumpAndSettle();
        expect(sent, ['partly_completed']);
        expect(tester.takeException(), isNull);
      });
    }
  }
  testWidgets(
    'task feedback honors off and does not expose preference errors',
    (tester) async {
      final sent = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showTaskFeedback(
                  context,
                  choice: () async => {'enabled': false},
                  send: (answer, _) async => sent.add(answer),
                ),
                child: const Text('Feedback'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Feedback'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Product usage sharing is off'),
        findsOneWidget,
      );
      expect(find.text('Completed'), findsNothing);
      expect(sent, isEmpty);
    },
  );
}
