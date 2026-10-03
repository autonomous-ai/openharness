import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/pane_resize_handle.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;
import 'support/real_fonts.dart';

Future<void> mountWide(WidgetTester tester, AppNotifier app) async {
  await mount(tester, app);
  tester.view.physicalSize = const Size(2000, 1200);
  await tester.pump();
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    if (Platform.isMacOS) {
      final font = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      for (final family in [grid.AppType.sansFamily, 'SF Pro Text', 'Roboto']) {
        await (FontLoader(family)..addFont(Future.value(font))).load();
      }
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
      testWidgets('resize help fits ${brightness.name} at $scale', (
        tester,
      ) async {
        final size = scale == 1 ? const Size(1000, 640) : const Size(480, 360);
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = size;
        addTearDown(tester.view.reset);
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        final frames = <TerminalBinaryFrame>[];
        final left = app.adoptSessionForTest(terminal('a0', frames));
        app.adoptSessionForTest(terminal('a1', frames));
        final picture = GlobalKey();
        try {
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
                home: SwarmScreen(notifier: app, nativeTabs: false),
              ),
            ),
          );
          await tester.pump(const Duration(milliseconds: 100));
          final before = tester.getSize(find.byKey(left.cellKey)).width;
          app.beginPaneResize();
          await tester.pump();
          final hint = find.byKey(const ValueKey('pane-resize-hint'));
          expect(hint, findsOneWidget);
          expect(find.text('resize >'), findsNothing);
          final bounds = tester.getRect(hint);
          expect(bounds.left, greaterThanOrEqualTo(24));
          expect(bounds.right, lessThanOrEqualTo(size.width - 24));
          expect(bounds.top, greaterThanOrEqualTo(0));
          expect(bounds.bottom, lessThanOrEqualTo(size.height - 24));
          for (final label
              in find
                  .descendant(of: hint, matching: find.byType(Text))
                  .evaluate()) {
            final text = label.widget as Text;
            expect(text.style!.fontFamily, grid.AppType.sansFamily);
            final rect = tester.getRect(find.byWidget(text));
            expect(bounds.contains(rect.topLeft), isTrue);
            expect(bounds.contains(rect.bottomRight), isTrue);
          }
          expect(tester.takeException(), isNull);
          await _captureResizeHelp(
            tester,
            picture,
            '${brightness.name}-$scale',
          );
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
          await tester.pump();
          expect(
            tester.getSize(find.byKey(left.cellKey)).width,
            scale == 1 ? greaterThan(before) : greaterThanOrEqualTo(before),
            reason: 'At minimum pane widths, resize remains clamped and owns the key.',
          );
          expect(frames, isEmpty);
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await tester.pump();
          expect(hint, findsNothing);
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
          await tester.pump(const Duration(milliseconds: 10));
          expect(frames.single.bytes, [27, 91, 65]);
        } finally {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          grid.AppTheme.brightness.value = previous;
        }
      });
    }
  }

  testWidgets(
    'dragged proportions retain terminals, survive save/reopen and reset with the same preset',
    (tester) async {
      final store = MemoryStore();
      final app = createApp(store: store);
      app.machineStates['m']!.nodeOnline = true;
      final frames = <TerminalBinaryFrame>[];
      final left = app.adoptSessionForTest(terminal('a0', frames));
      app.adoptSessionForTest(terminal('a1', frames));
      await mountWide(tester, app);
      final pane = find.byKey(left.cellKey);
      final retained = tester.element(
        find.descendant(of: pane, matching: find.byType(TerminalView)),
      );
      final before = tester.getSize(pane).width;
      final focus = app.focusedPaneId;
      await tester.drag(find.byType(PaneResizeHandle), const Offset(130, 0));
      await tester.pump(const Duration(milliseconds: 50));
      expect(tester.getSize(pane).width, greaterThan(before + 100));
      expect(
        tester.element(
          find.descendant(of: pane, matching: find.byType(TerminalView)),
        ),
        same(retained),
      );
      expect(app.focusedPaneId, focus);
      expect(frames, isEmpty);
      await app.flushPaneLayout();
      final saved = jsonDecode(store.values['swarm_layout_v1']!) as Map;
      expect((saved['swarms'] as List).first['paneSizes'], isNotEmpty);
      final sizes = app.activeSwarm.paneSizes.values.single.toJson();
      final restored = createApp(store: store);
      await restored.restorePaneLayoutForTest();
      expect(restored.activeSwarm.paneSizes.values.single.toJson(), sizes);
      expect(restored.panes.every((pane) => pane.session == null), isTrue);
      restored.dispose();
      final originalId = app.activeSwarmId;
      app.newSwarm();
      await app.addAgentToSwarm('m', 'a0');
      // Keep one real fixture session shared during close/reopen.
      app.selectSwarm(originalId);
      await app.closeSwarm(originalId);
      app.reopenClosedSwarm();
      await tester.pump();
      expect(app.activeSwarm.paneSizes.values.single.toJson(), sizes);
      final current = app.presetFor(2)!;
      app.setPreset(2, current);
      await tester.pump();
      expect(app.activeSwarm.paneSizes, isEmpty);
      expect(
        tester.getSize(find.byKey(app.panes.first.cellKey)).width,
        closeTo(before, .1),
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'Escape cancels a pointer resize and returns the next key to the agent',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final frames = <TerminalBinaryFrame>[];
      final left = app.adoptSessionForTest(terminal('a0', frames));
      final right = app.adoptSessionForTest(terminal('a1', frames));
      await mountWide(tester, app);
      final initial = tester.getSize(find.byKey(left.cellKey));
      final gesture = await tester.startGesture(
        tester.getCenter(find.byType(PaneResizeHandle)),
      );
      await gesture.moveBy(const Offset(120, 0));
      await tester.pump();
      expect(
        tester.getSize(find.byKey(left.cellKey)).width,
        greaterThan(initial.width),
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await gesture.up();
      await tester.pump(const Duration(milliseconds: 50));
      expect(tester.getSize(find.byKey(left.cellKey)), initial);
      expect(app.focusedPaneId, right.id);
      expect(frames, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(frames.single.bytes, [27, 91, 68]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'search opens keyboard resizing without taking Command movement keys',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final frames = <TerminalBinaryFrame>[];
      final left = app.adoptSessionForTest(terminal('a0', frames));
      app.adoptSessionForTest(terminal('a1', frames));
      await mountWide(tester, app);
      final before = tester.getSize(find.byKey(left.cellKey)).width;
      await chord(tester, LogicalKeyboardKey.keyP, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> resize panes',
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(find.byKey(const ValueKey('pane-resize-hint')), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pump();
      expect(
        tester.getSize(find.byKey(left.cellKey)).width,
        greaterThan(before),
      );
      expect(frames, isEmpty);
      final resized = tester.getSize(find.byKey(left.cellKey)).width;
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pump();
      expect(
        tester.getSize(find.byKey(left.cellKey)).width,
        greaterThan(resized),
        reason: 'Relayout keeps subsequent arrow keys on the resize handle',
      );
      expect(frames, isEmpty);
      await chord(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump();
      expect(app.focusedPaneId, left.id);
      expect(frames, isEmpty);
      expect(find.byKey(const ValueKey('pane-resize-hint')), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.pump(const Duration(milliseconds: 10));
      expect(frames.single.bytes, [27, 91, 65]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}

Future<void> _captureResizeHelp(
  WidgetTester tester,
  GlobalKey picture,
  String name,
) async {
  final directory = Platform.environment['HARNESS_RESIZE_CAPTURE_DIR'];
  if (directory == null) return;
  final previousShadows = debugDisableShadows;
  try {
    debugDisableShadows = false;
    for (final render in tester.allRenderObjects) {
      render.markNeedsPaint();
    }
    await tester.pump();
    await tester.runAsync(() async {
      final image =
          await (picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary)
              .toImage();
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(directory).create(recursive: true);
      await File('$directory/resize-$name.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  } finally {
    debugDisableShadows = previousShadows;
    for (final render in tester.allRenderObjects) {
      render.markNeedsPaint();
    }
    await tester.pump();
  }
}
