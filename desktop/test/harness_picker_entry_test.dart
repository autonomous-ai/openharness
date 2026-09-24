import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_search_preview_test.dart' show seedPreviews;
import 'swarm_state_test.dart' show createApp;
import 'support/real_fonts.dart';

void main() {
  setUp(() => newHarnessOpensInBox = true);
  tearDown(() => newHarnessOpensInBox = false);
  setUpAll(() async {
    await loadRealFonts();
    for (final (name, asset) in [
      ('MaterialIcons', 'fonts/MaterialIcons-Regular.otf'),
      (
        'packages/lucide_icons_flutter/Lucide',
        'packages/lucide_icons_flutter/assets/lucide.ttf',
      ),
      (
        'packages/lucide_icons_flutter/Lucide300',
        'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
      ),
    ]) {
      await (FontLoader(name)..addFont(rootBundle.load(asset))).load();
    }
  });
  for (final (size, scale) in [
    (const Size(1280, 900), 1.0),
    (const Size(760, 760), 1.0),
    (const Size(600, 680), 2.0),
  ]) {
    testWidgets(
      'Open Harness shows results separately from New Harness at $size, $scale',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = size;
        addTearDown(tester.view.reset);
        final app = createApp();
        await seedPreviews(app);
        final frames = <TerminalBinaryFrame>[];
        app.adoptSessionForTest(terminal('a69', frames));
        final pane = app.focusedPane;
        final keymap = AppKeymap();
        final boundaryKey = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundaryKey,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: KeymapProvider(keymap: keymap, child: child!),
              ),
              home: SwarmScreen(notifier: app, nativeTabs: false),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 100));
        final field = find.byKey(const ValueKey('swarm-search-input'));
        await chord(tester, LogicalKeyboardKey.keyP);
        expect(field, findsOneWidget);
        expect(find.byType(SwarmSearchResults), findsOneWidget);
        expect(
          find.byKey(const ValueKey('swarm-search-preview')),
          findsNothing,
        );
        expect(find.byKey(const ValueKey('harness-picker-open')), findsNothing);
        expect(
          tester.widget<TextField>(field).decoration!.hintText,
          kHarnessPickerHint,
        );
        expect(find.text(kHarnessPickerHint), findsOneWidget);
        expect(find.byKey(const ValueKey('create-agent-submit')), findsNothing);
        final before = tester.getRect(field);
        final controller = tester.widget<TextField>(field).controller;
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);

        Future<void> capture(String state) async {
          final output = Platform.environment['HARNESS_PICKER_CAPTURE_DIR'];
          if (output == null) return;
          await tester.runAsync(() async {
            await precacheImage(
              const AssetImage('assets/engine-icons/codex.png'),
              boundaryKey.currentContext!,
            );
          });
          await tester.pumpAndSettle();
          final boundary =
              boundaryKey.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 1);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File('$output/${size.width.toInt()}-$scale-$state.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }

        await capture('initial');
        expect(app.focusedPane, same(pane));
        await tester.enterText(field, 'idempotency');
        await tester.pump();
        expect(
          tester.getRect(field),
          rectMoreOrLessEquals(before, epsilon: .001),
        );
        expect(tester.widget<TextField>(field).controller, same(controller));
        expect(
          find.textContaining('Payment retries now reuse'),
          findsOneWidget,
        );
        await capture('results');
        await chord(tester, LogicalKeyboardKey.keyN);
        await tester.pumpAndSettle();
        expect(field, findsNothing);
        expect(find.byType(SwarmSearchResults), findsNothing);
        expect(find.byType(NewHarnessForm), findsOneWidget);
        expect(
          find.byKey(const ValueKey('new-harness-field-project')),
          findsOneWidget,
        );
        await capture('creation');
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        await capture('creation-options');
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.byType(NewHarnessForm), findsNothing);
        expect(app.focusedPane, same(pane));
        expect(frames, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        keymap.dispose();
      },
    );
  }
}
