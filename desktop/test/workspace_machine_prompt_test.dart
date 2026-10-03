import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/workspace_machine_prompt.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/real_fonts.dart';

void main() {
  final output = Platform.environment['WELCOME_MACHINE_RENDER_DIR'];
  setUpAll(() async {
    await loadRealFonts();
    if (output != null) await loadPreviewFonts();
  });

  Future<GlobalKey> mount(
    WidgetTester tester, {
    required Brightness brightness,
    required double scale,
    required ValueNotifier<bool> loading,
    required VoidCallback onChoose,
    ValueNotifier<bool>? preparing,
    FocusNode? workspaceFocus,
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
          theme: grid
              .buildAppTheme(brightness: brightness)
              .copyWith(platform: TargetPlatform.macOS),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
              disableAnimations: true,
            ),
            child: child!,
          ),
          home: Scaffold(
            backgroundColor: grid.AppPalette.windowBg,
            body: Center(
              child: SizedBox(
                width: 680,
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(24),
                  child: Focus(
                    focusNode: workspaceFocus,
                    canRequestFocus: workspaceFocus != null,
                    skipTraversal: true,
                    child: ListenableBuilder(
                      listenable: Listenable.merge([loading, ?preparing]),
                      builder: (context, _) => WorkspaceMachinePrompt(
                        loading: loading.value,
                        preparing: preparing?.value ?? false,
                        onChoose: onChoose,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return picture;
  }

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      for (final pending in [true, false]) {
        testWidgets(
          'machine prompt remains actionable ${brightness.name} $scale '
          '${pending ? "loading" : "empty"}',
          (tester) async {
            final loading = ValueNotifier(pending);
            addTearDown(loading.dispose);
            var choices = 0;
            final picture = await mount(
              tester,
              brightness: brightness,
              scale: scale,
              loading: loading,
              onChoose: () => choices++,
            );
            expect(tester.takeException(), isNull);
            final heading = find.text('Harness anything');
            final explanation = find.text(
              pending
                  ? 'Finding your machines…'
                  : 'Choose a machine to start a new harness.',
            );
            final action = find.widgetWithText(
              FilledButton,
              'Choose a machine',
            );
            final button = tester.getRect(action);
            expect(action.hitTestable(), findsOneWidget);
            expect(choices, 0);
            expect(button.width, lessThan(400));
            expect(button.bottom, lessThanOrEqualTo(536));
            expect(
              tester.getRect(heading).bottom,
              lessThan(tester.getRect(explanation).top),
            );
            expect(tester.getRect(explanation).bottom, lessThan(button.top));
            final label = tester.getRect(find.text('Choose a machine'));
            expect(label.top - button.top, greaterThanOrEqualTo(6));
            expect(button.bottom - label.bottom, greaterThanOrEqualTo(6));
            for (final paragraph
                in tester.allRenderObjects.whereType<RenderParagraph>()) {
              expect(paragraph.didExceedMaxLines, isFalse);
            }
            if (output != null) {
              await tester.runAsync(() async {
                final image =
                    await (picture.currentContext!.findRenderObject()!
                            as RenderRepaintBoundary)
                        .toImage();
                final bytes = await image.toByteData(
                  format: ui.ImageByteFormat.png,
                );
                await Directory(output).create(recursive: true);
                await File(
                  '$output/machine-${pending ? "loading" : "empty"}-'
                  '${brightness.name}-$scale.png',
                ).writeAsBytes(bytes!.buffer.asUint8List());
                image.dispose();
              });
            }
            await tester.tap(action);
            await tester.pump();
            expect(choices, 1);
            await tester.sendKeyEvent(LogicalKeyboardKey.tab);
            await tester.pump();
            expect(
              Focus.of(tester.element(find.text('Choose a machine'))).hasFocus,
              isTrue,
            );
            await tester.sendKeyEvent(LogicalKeyboardKey.enter);
            await tester.pump();
            expect(choices, 2);
            expect(tester.takeException(), isNull);
          },
        );
      }
    }
  }

  testWidgets('inventory completion preserves the active action', (
    tester,
  ) async {
    final loading = ValueNotifier(true);
    addTearDown(loading.dispose);
    var choices = 0;
    await mount(
      tester,
      brightness: Brightness.dark,
      scale: 2,
      loading: loading,
      onChoose: () => choices++,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    final action = find.widgetWithText(FilledButton, 'Choose a machine');
    final control = tester.element(action);
    final focus = Focus.of(tester.element(find.text('Choose a machine')));
    expect(focus.hasFocus, isTrue);
    loading.value = false;
    await tester.pumpAndSettle();
    expect(find.text('Finding your machines…'), findsNothing);
    expect(
      find.text('Choose a machine to start a new harness.'),
      findsOneWidget,
    );
    expect(tester.element(action), same(control));
    expect(focus.hasFocus, isTrue);
    expect(choices, 0);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(choices, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('preparing handoff leaves focus with the workspace', (
    tester,
  ) async {
    final loading = ValueNotifier(true);
    final preparing = ValueNotifier(true);
    final workspaceFocus = FocusNode();
    addTearDown(loading.dispose);
    addTearDown(preparing.dispose);
    addTearDown(workspaceFocus.dispose);
    var choices = 0;
    await mount(
      tester,
      brightness: Brightness.dark,
      scale: 2,
      loading: loading,
      preparing: preparing,
      workspaceFocus: workspaceFocus,
      onChoose: () => choices++,
    );
    workspaceFocus.requestFocus();
    await tester.pump();
    expect(workspaceFocus.hasPrimaryFocus, isTrue);
    expect(find.text('Harness anything'), findsOneWidget);
    expect(find.text('Preparing your harness…'), findsOneWidget);
    expect(find.text('Finding your machines…'), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
    preparing.value = false;
    await tester.pumpAndSettle();
    expect(find.text('Preparing your harness…'), findsNothing);
    expect(find.text('Finding your machines…'), findsOneWidget);
    expect(find.byType(FilledButton).hitTestable(), findsOneWidget);
    expect(workspaceFocus.hasPrimaryFocus, isTrue);
    preparing.value = true;
    await tester.pumpAndSettle();
    expect(find.byType(FilledButton), findsNothing);
    expect(workspaceFocus.hasPrimaryFocus, isTrue);
    expect(choices, 0);
    expect(tester.takeException(), isNull);
  });
}
