import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/widgets/task_palette.dart';

import 'support/real_fonts.dart';

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  final routed = <String>[];
  final sent = <(String, String, String)>[];
  final reply = Completer<RouteAnswer?>();
  @override
  Future<RouteAnswer?> routeTask(String text) {
    routed.add(text);
    return reply.future;
  }

  @override
  Future<String?> sendRoutedTask(
    String agentId,
    String machineId,
    String text,
  ) async {
    sent.add((agentId, machineId, text));
    return null;
  }
}

RouteAnswer choices() => RouteAnswer(
  agentId: 'a0',
  machineId: 'm0',
  name: 'Desktop design',
  confidence: .6,
  reason: 'Several agents are working on this project.',
  weighed: 8,
  machines: 2,
  candidates: [
    for (var i = 0; i < 8; i++)
      RouteCandidate(
        agentId: 'a$i',
        machineId: 'm${i % 2}',
        name: 'Desktop design ${i + 1}',
        machine: i.isEven ? 'This Mac' : 'Studio',
        recent: 'Polishing the welcome experience',
        engine: i.isEven ? 'codex' : 'claude',
        confidence: i == 0 ? .6 : .4,
      ),
  ],
);

void main() {
  setUpAll(loadRealFonts);
  for (final choosing in [false, true]) {
    for (final key in [LogicalKeyboardKey.enter, LogicalKeyboardKey.escape]) {
      testWidgets(
        'composition owns ${key.keyLabel} while ${choosing ? 'choosing an agent' : 'typing a task'}',
        (tester) async {
          final app = _App();
          try {
            await tester.pumpWidget(
              MaterialApp(
                theme: grid.buildAppTheme(brightness: Brightness.dark),
                home: Builder(
                  builder: (context) => TextButton(
                    onPressed: () => showTaskPalette(context, app),
                    child: const Text('Open'),
                  ),
                ),
              ),
            );
            await tester.tap(find.text('Open'));
            await tester.pumpAndSettle();
            final field = find.byType(TextField);
            if (choosing) {
              await tester.enterText(field, 'Review the desktop');
              await tester.sendKeyEvent(LogicalKeyboardKey.enter);
              app.reply.complete(choices());
              await tester.pumpAndSettle();
            }
            const composing = TextEditingValue(
              text: 'しごと',
              selection: TextSelection.collapsed(offset: 3),
              composing: TextRange(start: 0, end: 3),
            );
            tester.testTextInput.updateEditingValue(composing);
            await tester.pump();
            await tester.sendKeyEvent(key);
            await tester.pump();
            expect(app.routed, choosing ? ['Review the desktop'] : isEmpty);
            expect(app.sent, isEmpty);
            expect(field, findsOneWidget);
            expect(
              tester.widget<TextField>(field).controller!.value,
              composing,
            );

            tester.testTextInput.updateEditingValue(
              composing.copyWith(composing: TextRange.empty),
            );
            await tester.pump();
            await tester.sendKeyEvent(key);
            await tester.pump();
            if (key == LogicalKeyboardKey.escape) {
              await tester.pumpAndSettle();
              expect(field, findsNothing);
            } else if (choosing) {
              expect(app.sent, [('a0', 'm0', 'しごと')]);
            } else {
              expect(app.routed, ['しごと']);
              app.reply.complete(choices());
              await tester.pumpAndSettle();
            }
          } finally {
            await tester.pumpWidget(const SizedBox());
            await tester.pump(const Duration(seconds: 1));
            app.dispose();
          }
        },
      );
    }
  }
  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.7]) {
      testWidgets(
        'task routing fits ${brightness.name} at $scale and keeps selection in view',
        (tester) async {
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = scale == 1
              ? const Size(900, 700)
              : const Size(420, 480);
          addTearDown(tester.view.reset);
          final previous = grid.AppTheme.brightness.value;
          grid.AppTheme.brightness.value = brightness;
          addTearDown(() => grid.AppTheme.brightness.value = previous);
          final app = _App();
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
                      onPressed: () => showTaskPalette(context, app),
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
          expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
          await tester.enterText(field, 'Polish the desktop');
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pump();
          expect(app.routed, ['Polish the desktop']);
          expect(app.sent, isEmpty);
          app.reply.complete(choices());
          await tester.pumpAndSettle();
          expect(find.byType(EngineMark), findsNWidgets(8));
          expect(find.byType(DesktopDialogSurface), findsOneWidget);
          expect(tester.takeException(), isNull);
          final directory = Platform.environment['HARNESS_TASK_CAPTURE_DIR'];
          if (directory != null) {
            final previousShadows = debugDisableShadows;
            debugDisableShadows = false;
            final boundary =
                picture.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            void repaint(RenderObject object) {
              object.markNeedsPaint();
              object.visitChildren(repaint);
            }

            repaint(boundary);
            await tester.pump();
            await tester.runAsync(() async {
              final image = await boundary.toImage();
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await Directory(directory).create(recursive: true);
              await File('$directory/task-${brightness.name}-$scale.png')
                  .writeAsBytes(bytes!.buffer.asUint8List());
              image.dispose();
            });
            debugDisableShadows = previousShadows;
          }
          for (var i = 0; i < 7; i++) {
            await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
            await tester.pumpAndSettle();
          }
          expect(find.text('Desktop design 8').hitTestable(), findsOneWidget);
          expect(tester.takeException(), isNull);
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await tester.pumpAndSettle();
          expect(field, findsNothing);
          expect(app.sent, isEmpty);
          await tester.pumpWidget(const SizedBox());
          app.dispose();
        },
      );
    }
  }
}
