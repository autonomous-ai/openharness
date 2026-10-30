import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final capture = Platform.environment['HARNESS_SWARM_COMPOSER_CAPTURE'];
  final field = find.byKey(const ValueKey('super-message-composer'));
  final surface = find.byKey(const ValueKey('super-message-composer-surface'));
  setUpAll(() async {
    if (capture == null || !Platform.isMacOS) return;
    final bytes = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('composer text centers in ${brightness.name} at ${scale}x', (
        tester,
      ) async {
        final previousBrightness = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() {
          grid.AppTheme.brightness.value = previousBrightness;
        });
        await tester.binding.setSurfaceSize(const Size(1100, 720));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final server = ConversationServer();
        final controller = server.controller();
        await controller.refresh();
        addTearDown(controller.dispose);
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                body: SuperTabView(
                  controller: controller,
                  onInvite: () {},
                  onAddAgent: (_) {},
                  onOpenTerminal: (_) {},
                  machineName: (_) => 'Team Mac',
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final measurements = <String, Object>{};
        Future<void> record(String name) async {
          final editor = tester
              .state<EditableTextState>(
                find.descendant(of: field, matching: find.byType(EditableText)),
              )
              .renderEditable;
          final rect = tester.getRect(surface);
          final caret = editor
              .getLocalRectForCaret(const TextPosition(offset: 0))
              .shift(editor.localToGlobal(Offset.zero));
          final editableRect = editor.localToGlobal(Offset.zero) & editor.size;
          final hint = find.descendant(
            of: field,
            matching: find.text('Message #Pilot'),
          );
          measurements[name] = {
            'surfaceHeight': rect.height,
            'surfaceCenter': rect.center.dy,
            'editableCenter': editableRect.center.dy,
            'caretCenter': caret.center.dy,
            if (hint.evaluate().isNotEmpty)
              'hintCenter': tester.getRect(hint).center.dy,
          };
          if (capture != null) {
            await tester.runAsync(() async {
              final image =
                  await (boundary.currentContext!.findRenderObject()!
                          as RenderRepaintBoundary)
                      .toImage(pixelRatio: 2);
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              final path = '$capture/${brightness.name}-${scale}x-$name';
              await Directory(capture).create(recursive: true);
              await File('$path.png').writeAsBytes(bytes!.buffer.asUint8List());
              await File('$path.json').writeAsString(
                const JsonEncoder.withIndent('  ').convert(measurements),
              );
              image.dispose();
            });
          }
          debugPrint('Composer $name: ${measurements[name]}');
          expect(editableRect.center.dy, closeTo(rect.center.dy, .75));
          expect(caret.center.dy, closeTo(rect.center.dy, .75));
          if (name == 'empty') {
            expect(
              tester.getRect(hint).center.dy,
              closeTo(rect.center.dy, .75),
            );
          }
        }

        await record('empty');
        final singleHeight = tester.getSize(surface).height;
        final focus = tester.widget<TextField>(field).focusNode!;
        focus.unfocus();
        await tester.pump();
        await tester.tapAt(
          tester.getRect(surface).topLeft + const Offset(40, 10),
        );
        await tester.pump();
        expect(focus.hasFocus, isTrue);
        await tester.enterText(field, 'Keep me up to date.');
        await tester.pumpAndSettle();
        await record('typed');
        expect(tester.getSize(surface).height, singleHeight);
        await tester.enterText(field, 'First line\nSecond line\nThird line');
        await tester.pumpAndSettle();
        expect(tester.getSize(surface).height, greaterThan(singleHeight));
        expect(tester.takeException(), isNull);
        await tester.enterText(field, 'Back to one line');
        await tester.pumpAndSettle();
        await record('collapsed');
        expect(tester.getSize(surface).height, singleHeight);
        await tester.pump(const Duration(milliseconds: 250));
        await tester.pumpWidget(const SizedBox());
      }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
    }
  }
}
