import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/sharing/shared_harness_bar.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/workspace_learning.dart';
import 'package:harness/widgets/workspace_quick_start.dart';
import 'package:harness/widgets/workspace_start_guide.dart';

import 'keymap_host_test.dart' show MemoryKeymap;
import 'support/real_fonts.dart';

void main() {
  setUpAll(() async {
    await loadRealFonts();
    if (Platform.isMacOS &&
        Platform.environment['GUIDANCE_RENDER_DIR'] != null) {
      final font = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
        await (FontLoader(family)..addFont(Future.value(font))).load();
      }
      // The widget engine has no CoreText fallback for keyboard symbols.
      final symbols = ByteData.sublistView(
        await File('/System/Library/Fonts/Apple Symbols.ttf').readAsBytes(),
      );
      for (final family in ['Arial', 'Courier New']) {
        await (FontLoader(family)..addFont(Future.value(symbols))).load();
      }
    }
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  Future<void> capture(WidgetTester tester, String name) async {
    final directory = Platform.environment['GUIDANCE_RENDER_DIR'];
    if (directory == null) return;
    final boundary = tester.renderObject<RenderRepaintBoundary>(
      find.byKey(const ValueKey('guidance-preview')),
    );
    await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(directory).create(recursive: true);
      await File('$directory/$name.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  Future<void> mount(
    WidgetTester tester,
    Widget child, {
    required Brightness brightness,
    required Size size,
    required double scale,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final oldBrightness = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        debugShowCheckedModeBanner: false,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: RepaintBoundary(
          key: const ValueKey('guidance-preview'),
          child: Scaffold(body: child),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  for (final brightness in Brightness.values) {
    for (final layout in [
      (size: const Size(1200, 760), scale: 1.0),
      (size: const Size(390, 620), scale: 2.0),
    ]) {
      final name = '${brightness.name}-${layout.size.width.toInt()}';
      testWidgets('observer header $name fits and preserves actions', (
        tester,
      ) async {
        final calls = <String>[];
        var comments = false, viewer = false;
        await mount(
          tester,
          StatefulBuilder(
            builder: (context, setState) => SharedHarnessBar(
              name: 'Climate dashboard — onboarding review',
              detail: 'Morgan · MacBook Pro',
              status: SharedPaneStatus.ended,
              commentsSelected: comments,
              viewerSelected: viewer,
              onSelectViewer: (value) => setState(() {
                viewer = value;
                calls.add('viewer:$value');
              }),
              onToggleComments: () => setState(() {
                comments = !comments;
                calls.add('comments:$comments');
              }),
              onRetry: () => calls.add('retry'),
              onClose: () => calls.add('close'),
            ),
          ),
          brightness: brightness,
          size: layout.size,
          scale: layout.scale,
        );
        expect(calls, isEmpty);
        expect(tester.takeException(), isNull);
        await capture(tester, 'observer-$name');
        await tester.tap(find.text('Retry'));
        await tester.tap(find.text('Viewer'));
        await tester.tap(find.text('Comments'));
        await tester.pumpAndSettle();
        expect(find.text('Watch'), findsOneWidget);
        Focus.of(tester.element(find.text('Watch'))).requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.space);
        await tester.pumpAndSettle();
        expect(find.text('Comments'), findsOneWidget);
        await tester.tap(find.byTooltip('Close shared harness'));
        expect(calls, [
          'retry',
          'viewer:true',
          'comments:true',
          'comments:false',
          'close',
        ]);
        expect(tester.takeException(), isNull);
      });

      testWidgets('quick start $name keeps steps and keyboard activation', (
        tester,
      ) async {
        final map = MemoryKeymap()
          ..apply(
            '{"bindings":[{"keys":"cmd+t","command":null},{"keys":"cmd+y","command":"swarm.new"}]}',
          );
        final learning = WorkspaceLearning()..start();
        addTearDown(map.dispose);
        addTearDown(learning.dispose);
        final calls = <String>[];
        await mount(
          tester,
          KeymapProvider(
            keymap: map,
            child: ListenableBuilder(
              listenable: learning,
              builder: (context, _) => WorkspaceQuickStart(
                learning: learning,
                onCommand: calls.add,
                onPractice: () => calls.add('practice'),
              ),
            ),
          ),
          brightness: brightness,
          size: layout.size,
          scale: layout.scale,
        );
        final action = find.byKey(const ValueKey('quick-start-action'));
        expect(calls, isEmpty);
        expect(find.text('⌘Y  Try it'), findsOneWidget);
        await capture(tester, 'tour-$name');
        await tester.tap(action);
        expect(learning.completed, isEmpty);
        learning.observe(agents: 1, zoomed: false);
        await tester.pumpAndSettle();
        await tester.tap(action);
        learning.observe(agents: 2, zoomed: false);
        await tester.pumpAndSettle();
        await tester.tap(action);
        learning.observe(agents: 2, zoomed: true);
        await tester.pumpAndSettle();
        await tester.tap(action);
        learning.commandSearchOpened();
        await tester.pumpAndSettle();
        expect(find.text('Quick start · Complete'), findsOneWidget);
        Focus.of(tester.element(find.text('Keyboard practice'))).requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.space);
        await tester.pumpAndSettle();
        expect(calls, [
          'swarm.new',
          'agent.open',
          'pane.zoom',
          'navigation.commands',
          'practice',
        ]);
        await tester.tap(find.byKey(const ValueKey('quick-start-pause')));
        expect(learning.active, isFalse);
        expect(learning.finished, isTrue);
        expect(tester.takeException(), isNull);
      });

      testWidgets('guide $name keeps annotations and scrollable shortcuts', (
        tester,
      ) async {
        var opened = 0;
        await mount(
          tester,
          WorkspaceStartGuide(onShortcuts: () => opened++),
          brightness: brightness,
          size: layout.size,
          scale: layout.scale,
        );
        expect(opened, 0);
        expect(tester.takeException(), isNull);
        await capture(tester, 'guide-$name');
        final shortcuts = find.byKey(const ValueKey('workspace-all-shortcuts'));
        await tester.ensureVisible(shortcuts);
        await tester.pumpAndSettle();
        await capture(tester, 'guide-actions-$name');
        await tester.tap(shortcuts);
        expect(opened, 1);
        expect(tester.takeException(), isNull);
      });
    }
  }
}
