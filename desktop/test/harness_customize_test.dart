import 'package:harness/terminal/terminal_binary.dart';

import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shared/theme/harness_background.dart';
import 'package:harness/widgets/harness_customize_pane.dart';

import 'support/real_fonts.dart';

import 'package:harness/shared/theme/prompt_style.dart';
import 'package:harness/widgets/prompt_context.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _Storage implements LocalKeyValueStore {
  final values = <String, String>{};
  Completer<void>? gate;
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> delete(String key) async => values.remove(key);
  @override
  Future<void> write(String key, String value) async {
    await gate?.future;
    values[key] = value;
  }
}

Future<void> _capture(WidgetTester tester, GlobalKey key, String name) async {
  final directory = Platform.environment['HARNESS_CUSTOMIZE_CAPTURE_DIR'];
  if (directory == null) return;
  await tester.runAsync(() async {
    final boundary =
        key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(directory).create(recursive: true);
    await File('$directory/$name.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide300')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
          ),
        ))
        .load();
  });

  test('rapid prompt edits persist together and malformed prompt leaves appearance intact', () async {
    final storage = _Storage()..gate = Completer<void>();
    final store = AppearancePrefsStore(storage: storage);
    addTearDown(store.dispose);
    final saving = store.setPrompt(const PromptPrefs(style: PromptStyle.plain));
    store.setPrompt(store.value.prompt.copyWith(branch: false));
    store.setPrompt(
      store.value.prompt.copyWith(style: PromptStyle.powerline, color: false),
    );
    storage.gate!.complete();
    await saving;
    final reopened = AppearancePrefsStore(storage: storage);
    addTearDown(reopened.dispose);
    await reopened.load();
    expect(
      reopened.value.prompt,
      const PromptPrefs(
        style: PromptStyle.powerline,
        branch: false,
        color: false,
      ),
    );
    await store.setPalette(HarnessPalette.forest);
    storage.values['workspace_prompt_v1'] = '{broken';
    await reopened.load();
    expect(reopened.value.prompt, const PromptPrefs());
    expect(reopened.value.palette, HarnessPalette.forest);
    await store.reset();
    await reopened.load();
    expect(reopened.value, const AppearancePrefs());
  });

  testWidgets(
    'prompt choices preview, accept keyboard input and survive reopening',
    (tester) async {
      final storage = _Storage();
      final store = AppearancePrefsStore(storage: storage);
      addTearDown(store.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SizedBox(
              width: 440,
              child: HarnessCustomizePane(store: store, onClose: () {}),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> focus(String key) async {
        final label = find
            .descendant(
              of: find.byKey(ValueKey(key)),
              matching: find.byType(Text),
            )
            .first;
        for (
          var i = 0;
          i < 20 && !Focus.of(tester.element(label)).hasFocus;
          i++
        ) {
          await tester.sendKeyEvent(LogicalKeyboardKey.tab);
          await tester.pump();
        }
        expect(Focus.of(tester.element(label)).hasFocus, isTrue);
      }

      await focus('prompt-style-powerline');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(store.value.prompt.style, PromptStyle.powerline);
      await focus('prompt-branch');
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pumpAndSettle();
      expect(store.value.prompt.branch, isFalse);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('prompt-preview')),
          matching: find.text('main'),
        ),
        findsNothing,
      );
      final reopened = AppearancePrefsStore(storage: storage);
      addTearDown(reopened.dispose);
      await reopened.load();
      expect(reopened.value.prompt, store.value.prompt);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'command search opens customization and Escape returns typing to the terminal',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      final input = <TerminalBinaryFrame>[];
      final pane = app.adoptSessionForTest(terminal('a0', input));
      await mount(tester, app);
      final before = tester.getRect(find.byKey(pane.cellKey));
      await chord(tester, LogicalKeyboardKey.keyP, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> customize',
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byType(HarnessCustomizePane), findsOneWidget);
      expect(find.byType(PromptContextView), findsWidgets);
      expect(tester.getRect(find.byKey(pane.cellKey)), before);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(HarnessCustomizePane), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump();
      expect(input.single.bytes, [27, 91, 68]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  test(
    'background persists without replacing palette or type choices',
    () async {
      final storage = _Storage()..gate = Completer<void>();
      final store = AppearancePrefsStore(storage: storage);
      addTearDown(store.dispose);
      store.value = const AppearancePrefs(
        palette: HarnessPalette.forest,
        uiFamily: 'Menlo',
        uiSize: 16,
      );
      final saving = store.setBackground(HarnessBackground.lake);
      store.setBackground(HarnessBackground.threads);
      expect(store.value.palette, HarnessPalette.forest);
      expect(store.value.uiFamily, 'Menlo');
      expect(store.value.uiSize, 16);
      storage.gate!.complete();
      await saving;
      final restored = AppearancePrefsStore(storage: storage);
      addTearDown(restored.dispose);
      await restored.load();
      expect(restored.value.background, HarnessBackground.threads);
      storage.values['harness_start_background'] = 'unknown-background';
      await restored.load();
      expect(restored.value.background, HarnessBackground.plain);
      await restored.setBackground(HarnessBackground.silk);
      await restored.reset();
      expect(storage.values.containsKey('harness_start_background'), isFalse);
    },
  );

  testWidgets(
    'background choices support keyboard selection and survive reopening',
    (tester) async {
      final storage = _Storage();
      final store = AppearancePrefsStore(storage: storage);
      addTearDown(store.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SizedBox(
              width: 420,
              child: HarnessCustomizePane(store: store, onClose: () {}),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('customize-background')));
      await tester.pumpAndSettle();
      final choice = find.byKey(const ValueKey('background-lake'));
      await tester.ensureVisible(choice);
      await tester.tap(choice);
      await tester.pumpAndSettle();
      expect(store.value.background, HarnessBackground.lake);
      final silk = find.descendant(
        of: find.byKey(const ValueKey('background-silk')),
        matching: find.text('Silk'),
      );
      for (var i = 0; i < 10 && !Focus.of(tester.element(silk)).hasFocus; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
      }
      expect(Focus.of(tester.element(silk)).hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(store.value.background, HarnessBackground.silk);
      final reopened = AppearancePrefsStore(storage: storage);
      addTearDown(reopened.dispose);
      await reopened.load();
      expect(reopened.value.background, HarnessBackground.silk);
      expect(tester.takeException(), isNull);
    },
  );

  for (final (width, height, scale) in [
    (1280.0, 800.0, 1.0),
    (880.0, 560.0, 1.0),
    (600.0, 680.0, 1.7),
  ]) {
    testWidgets('customization fits $width at $scale and returns to the page', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, height);
      addTearDown(tester.view.reset);
      final previous = appearancePrefsStore.value;
      addTearDown(() => appearancePrefsStore.value = previous);
      appearancePrefsStore.value = const AppearancePrefs();
      final app = createApp();
      addTearDown(app.dispose);
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            builder: (context, child) => grid.BrightnessScope(
              child: MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
            ),
            home: SwarmScreen(notifier: app, nativeTabs: false),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final start = find.byKey(const ValueKey('harness-start-search'));
      final background = find.byKey(const ValueKey('harness-start-background'));
      final fill = find.descendant(
        of: background,
        matching: find.byType(ColoredBox),
      );
      expect(tester.widget<ColoredBox>(fill).color, grid.AppPalette.swarmField);
      expect(
        find.byKey(const ValueKey('harness-customize-pane')),
        findsNothing,
      );
      await _capture(tester, boundary, '${width.toInt()}-default');

      await tester.enterText(start, 'Keep my query');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('harness-customize-button')));
      await tester.pumpAndSettle();
      final pane = find.byKey(const ValueKey('harness-customize-pane'));
      expect(pane, findsOneWidget);
      expect(tester.getRect(pane).right, width);
      expect(find.byKey(const ValueKey('harness-start-results')), findsNothing);
      expect(tester.widget<TextField>(start).controller!.text, 'Keep my query');
      expect(tester.takeException(), isNull);
      for (final style in PromptStyle.values) {
        appearancePrefsStore.value = appearancePrefsStore.value.copyWith(
          prompt: PromptPrefs(style: style),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await _capture(
          tester,
          boundary,
          '${width.toInt()}-prompt-${style.name}',
        );
      }
      await tester.tap(find.byKey(const ValueKey('customize-background')));
      await tester.pumpAndSettle();
      await _capture(tester, boundary, '${width.toInt()}-background');

      await tester.tap(find.byKey(const ValueKey('customize-appearance')));
      await tester.pumpAndSettle();
      expect(find.text('Color palette'), findsOneWidget);
      expect(find.byKey(const ValueKey('palette-graphite')), findsOneWidget);
      expect(find.byKey(const Key('appearance-ui-size-field')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _capture(tester, boundary, '${width.toInt()}-appearance');

      await tester.tap(find.byKey(const ValueKey('customize-terminal')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('terminal-font-family-dropdown')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('terminal-colour-scheme-dropdown')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await _capture(tester, boundary, '${width.toInt()}-terminal');
      final schemes = find.byKey(const Key('terminal-colour-scheme-dropdown'));
      await tester.ensureVisible(schemes);
      await tester.tap(schemes);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(pane, findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(pane, findsNothing);
      final button = tester.widget<FilledButton>(
        find.byKey(const ValueKey('harness-customize-button')),
      );
      expect(button.focusNode!.hasFocus, isTrue);
      expect(tester.widget<TextField>(start).controller!.text, 'Keep my query');
      expect(app.panes, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }
}
