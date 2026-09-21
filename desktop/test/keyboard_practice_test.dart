import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keyboard_practice.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/state/workspace_learning.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/workspace_quick_start.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;
import 'workspace_learning_test.dart' show LearningMemoryStore;
import 'support/real_fonts.dart';

void main() {
  final filter = find.byKey(const ValueKey('practice-filter'));

  Future<void> openLesson(WidgetTester tester, String query) async {
    await tester.enterText(filter, query);
    await tester.pump();
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pump();
  }

  Future<void> command(WidgetTester tester, String query) async {
    await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '> $query',
    );
    await tester.pump();
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
  }

  Future<void> capture(
    WidgetTester tester,
    GlobalKey boundary,
    String name,
  ) async {
    final path = Platform.environment['HARNESS_LEARNING_CAPTURE_DIR'];
    if (path == null) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()
                  as RenderRepaintBoundary)
              .toImage();
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      Directory(path).createSync(recursive: true);
      File('$path/$name.png').writeAsBytesSync(data!.buffer.asUint8List());
      image.dispose();
    });
  }

  test(
    'the practice catalog covers all stable app bindings and local overrides',
    () {
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      map.apply(
        '''{"bindings":[{"keys":"ctrl+x ctrl+t","command":"swarm.new","when":"terminal"}]}''',
      );
      final lessons = keyboardLessons(map);
      for (final context in KeymapContext.values) {
        for (final binding in map.current.bindingsFor(context)) {
          if (binding.command == 'navigation.command_bar' ||
              binding.command == 'app.debug' ||
              harnessCommandById[binding.command]?.hidden == true) {
            continue;
          }
          expect(
            lessons.any(
              (l) =>
                  l.command == binding.command &&
                  l.bindings.any((b) => b.sequence == binding.sequence),
            ),
            isTrue,
            reason: '${context.name}: ${binding.command} ${binding.sequence}',
          );
        }
      }
      expect(
        lessons.any((l) => l.command == 'agent.stop' && l.bindings.isEmpty),
        isTrue,
      );
      expect(
        lessons.any((l) => l.command == 'navigation.command_bar'),
        isFalse,
      );
    },
  );

  testWidgets(
    'practice captures workspace and destructive actions, then restores terminal input',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      final input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', input));
      final original = app.activeSwarm;
      final panes = original.panes.toList();
      await configured.mount(tester, app, map);
      await command(tester, 'Keyboard practice');
      expect(filter, findsOneWidget);
      await openLesson(tester, 'New Tab');
      await key(tester, LogicalKeyboardKey.keyW, cmd: true);
      expect(find.textContaining('That is Close Tab'), findsOneWidget);
      expect(app.swarms, [original]);
      expect(original.panes, panes);
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      expect(find.text('[x] New Tab'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await openLesson(tester, 'Stop Agent');
      await tester.enterText(
        find.byKey(const ValueKey('practice-command')),
        'Stop Agent',
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(find.text('[x] Stop Agent'), findsOneWidget);
      expect(app.swarms, [original]);
      expect(original.panes, panes);
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.escape);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(KeyboardPractice), findsNothing);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      expect(input.single.bytes, [27, 91, 68]);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 200));
    },
  );

  testWidgets('practice follows remaps, sequences and live unbindings', (
    tester,
  ) async {
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    map.apply(
      '''{"bindings":[{"keys":"cmd+t","command":null},{"keys":"ctrl+x ctrl+t","command":"swarm.new"}]}''',
    );
    await tester.pumpWidget(MaterialApp(home: KeyboardPractice(keymap: map)));
    await openLesson(tester, 'New Tab');
    expect(find.text('Press ctrl-X ctrl-T'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.keyT, cmd: true);
    expect(find.text('[x] New Tab'), findsNothing);
    await key(tester, LogicalKeyboardKey.keyX, ctrl: true);
    await key(tester, LogicalKeyboardKey.keyT, ctrl: true);
    expect(find.text('[x] New Tab'), findsOneWidget);
    map.apply('''{"bindings":[{"keys":"cmd+t","command":null}]}''');
    await tester.pump();
    expect(find.byKey(const ValueKey('practice-command')), findsOneWidget);
    await tester.enterText(
      find.byKey(const ValueKey('practice-command')),
      'New Tab',
    );
    await key(tester, LogicalKeyboardKey.enter);
    expect(find.text('[x] New Tab'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Escape can be practiced before it returns to the lesson list', (
    tester,
  ) async {
    await tester.pumpWidget(const MaterialApp(home: KeyboardPractice()));
    await openLesson(tester, 'Close search');
    await key(tester, LogicalKeyboardKey.escape);
    expect(find.text('[x] Close search'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    expect(filter, findsOneWidget);
    await openLesson(tester, 'Erase the previous word');
    await key(tester, LogicalKeyboardKey.keyW, ctrl: true);
    expect(find.text('[x] Erase the previous word'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'practice retains progress completed during a slow preference read',
    (tester) async {
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      final earlier = keyboardLessons(map)
          .firstWhere((l) => l.command == 'pane.zoom');
      final storage = LearningMemoryStore()..pending = Completer<String?>();
      await tester.pumpWidget(
        MaterialApp(
          home: KeyboardPractice(keymap: map, storage: storage),
        ),
      );
      await openLesson(tester, 'New Tab');
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      storage.pending!.complete(jsonEncode([earlier.id]));
      await tester.pumpAndSettle();
      final saved = jsonDecode(storage.values.values.single) as List;
      expect(saved, contains(earlier.id));
      expect(
        saved.whereType<String>().any((id) => id.contains('swarm.new')),
        isTrue,
      );
      expect(
        find.text('2/${keyboardLessons(map).length} practiced'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'practice buttons activate from the keyboard in both lesson contexts',
    (tester) async {
      await tester.pumpWidget(const MaterialApp(home: KeyboardPractice()));
      for (final query in ['New Tab', 'Next result']) {
        await openLesson(tester, query);
        final buttonText = find.descendant(
          of: find.byKey(const ValueKey('practice-back')),
          matching: find.byType(Text),
        );
        Focus.of(tester.element(buttonText)).requestFocus();
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        expect(filter, findsOneWidget);
      }
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'quick start advances on real pane changes without capturing typing',
    (tester) async {
      final app = createApp();
      final learning = WorkspaceLearning();
      final map = MemoryKeymap();
      addTearDown(app.dispose);
      addTearDown(learning.dispose);
      addTearDown(map.dispose);
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: KeymapProvider(
            keymap: map,
            child: SwarmScreen(
              notifier: app,
              nativeTabs: false,
              learning: learning,
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      expect(
        find.byKey(const ValueKey('harness-start-quick-start')),
        findsOneWidget,
      );
      await command(tester, 'Quick start');
      expect(find.byType(WorkspaceQuickStart), findsOneWidget);
      expect(learning.next, WorkspaceLesson.agent);
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      await key(tester, LogicalKeyboardKey.escape);
      expect(
        learning.next,
        WorkspaceLesson.agent,
        reason: 'Cancelling an empty chooser is not opening an agent',
      );
      final input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', []));
      app.renameSwarm(app.activeSwarmId, 'First agent');
      await tester.pump(const Duration(milliseconds: 120));
      expect(learning.next, WorkspaceLesson.pane);
      app.adoptSessionForTest(terminal('a1', input));
      app.renameSwarm(app.activeSwarmId, 'Two agents');
      await tester.pump(const Duration(milliseconds: 120));
      expect(learning.next, WorkspaceLesson.zoom);
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      expect(learning.next, WorkspaceLesson.commands);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      expect(learning.finished, isTrue);
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('swarm-search-input')))
            .focusNode!
            .hasFocus,
        isTrue,
      );
      await key(tester, LogicalKeyboardKey.escape);
      await command(tester, 'Pause quick start');
      expect(find.byType(WorkspaceQuickStart), findsNothing);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      expect(input.last.bytes, [27, 91, 68]);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 200));
    },
  );

  for (final (size, scale) in [
    (const Size(1000, 800), 1.0),
    (const Size(480, 420), 1.7),
  ]) {
    testWidgets('practice stays readable at $size and $scale text', (
      tester,
    ) async {
      await tester.runAsync(loadRealFonts);
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final boundary = GlobalKey();
      final storage = LearningMemoryStore();
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: RepaintBoundary(
            key: boundary,
            child: KeyboardPractice(storage: storage),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      Future<void> snap(String name) =>
          capture(tester, boundary, '$name-${size.width.toInt()}');

      await snap('practice-list');
      await openLesson(tester, 'New Tab');
      await snap('practice-key');
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await snap('practice-result');
      if (size.width < 500) {
        final details = tester.widget<SingleChildScrollView>(
          find.byType(SingleChildScrollView),
        );
        final scrolling = details.controller!;
        expect(scrolling.position.maxScrollExtent, greaterThan(0));
        await key(tester, LogicalKeyboardKey.pageDown);
        expect(scrolling.offset, greaterThan(0));
        await snap('practice-read');
        await key(tester, LogicalKeyboardKey.pageUp);
        expect(scrolling.offset, 0);
        await key(tester, LogicalKeyboardKey.pageDown);
        await key(tester, LogicalKeyboardKey.escape);
        await openLesson(tester, 'New Pane');
        expect(scrolling.offset, 0);
      }
      expect(storage.values.values.any((v) => v.contains('swarm.new')), isTrue);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets(
    'quick start wraps beside a narrow workspace with enlarged text',
    (tester) async {
      await tester.runAsync(loadRealFonts);
      final app = createApp();
      final learning = WorkspaceLearning()..start();
      final boundary = GlobalKey();
      addTearDown(app.dispose);
      addTearDown(learning.dispose);
      tester.view.physicalSize = const Size(480, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(1.7)),
            child: child!,
          ),
          home: RepaintBoundary(
            key: boundary,
            child: SwarmScreen(
              notifier: app,
              nativeTabs: false,
              learning: learning,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await capture(tester, boundary, 'quick-start-480');
      expect(find.byKey(const ValueKey('quick-start-action')), findsOneWidget);
      expect(find.byKey(const ValueKey('quick-start-pause')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
