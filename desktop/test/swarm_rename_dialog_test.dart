import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/swarm_dialogs.dart';

import 'support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);
  for (final (brightness, scale) in [
    (Brightness.dark, 1.0),
    (Brightness.dark, 2.0),
    (Brightness.light, 1.0),
    (Brightness.light, 2.0),
  ]) {
    testWidgets(
      'rename keeps keyboard ownership and rejects blank names in ${brightness.name} at $scale',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(640, 540);
        addTearDown(tester.view.reset);
        final oldBrightness = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
        final boundaryKey = GlobalKey();
        String? result;
        var completions = 0;
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundaryKey,
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
                    onPressed: () async {
                      result = await showSwarmRenameDialog(context, 'app v2');
                      completions++;
                    },
                    child: const Text('Open'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        final field = find.byType(TextField);
        final editor = tester.widget<TextField>(field);
        expect(editor.focusNode!.hasPrimaryFocus, isTrue);
        expect(
          editor.controller!.selection,
          const TextSelection(baseOffset: 0, extentOffset: 6),
        );

        final output = Platform.environment['HARNESS_RENAME_CAPTURE_DIR'];
        if (output != null) {
          final boundary =
              boundaryKey.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 1);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File('$output/rename-${brightness.name}-$scale.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }

        await tester.enterText(field, '   ');
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pump();
        expect(find.byType(Dialog), findsOneWidget);
        expect(completions, 0);
        expect(find.text('Name cannot be empty'), findsOneWidget);
        expect(editor.focusNode!.hasPrimaryFocus, isTrue);
        await tester.enterText(field, '  Search polish  ');
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();
        expect(result, 'Search polish');
        expect(completions, 1);
        expect(find.byType(Dialog), findsNothing);

        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), 'Unsaved name');
        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
        expect(result, isNull);
        expect(completions, 2);
        expect(find.byType(Dialog), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );
  }
}
