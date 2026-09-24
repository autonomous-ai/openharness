import 'package:harness/terminal/terminal_binary.dart';

import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shared/theme/harness_background.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/harness_customize_pane.dart';
import 'package:xterm/xterm.dart';

import 'support/real_fonts.dart';

import 'package:harness/shared/theme/prompt_style.dart';
import 'package:harness/widgets/prompt_context.dart';
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/widgets/status_line.dart';

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

      await focus('prompt-style-robbyrussell');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(store.value.prompt.statusStyle, StatusLineStyle.robbyrussell);
      await focus('prompt-branch');
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pumpAndSettle();
      expect(store.value.prompt.branch, isFalse);
      expect(
        tester
            .widget<StatusLine>(find.byKey(const ValueKey('prompt-preview')))
            .parts
            .text,
        isNot(contains('main')),
      );
      final reopened = AppearancePrefsStore(storage: storage);
      addTearDown(reopened.dispose);
      await reopened.load();
      expect(reopened.value.prompt, store.value.prompt);
      expect(tester.takeException(), isNull);
    },
  );

  for (final entry in ['command search', 'native menu', 'Settings']) {
    testWidgets(
      '$entry opens customization beside the visible terminal and Escape returns typing',
      (tester) async {
        const channel = MethodChannel('harness/swarm_tabs');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (_) async => true,
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final app = createApp();
        addTearDown(app.dispose);
        final input = <TerminalBinaryFrame>[];
        final pane = app.adoptSessionForTest(terminal('a0', input));
        await mount(tester, app, nativeTabs: entry == 'native menu');
        final before = tester.getRect(find.byKey(pane.cellKey));
        if (entry == 'native menu') {
          tester.binding.defaultBinaryMessenger.handlePlatformMessage(
            channel.name,
            const StandardMethodCodec().encodeMethodCall(
              const MethodCall('customize'),
            ),
            (_) {},
          );
        } else if (entry == 'Settings') {
          await chord(tester, LogicalKeyboardKey.comma);
          await tester.pumpAndSettle();
          expect(find.byType(SettingsScreen), findsOneWidget);
          await tester.tap(find.text('Customize'));
        } else {
          await chord(tester, LogicalKeyboardKey.keyP, shift: true);
          await tester.enterText(
            find.byKey(const ValueKey('swarm-search-input')),
            '> customize',
          );
          await tester.pump();
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        }
        await tester.pumpAndSettle();
        expect(find.byType(SettingsScreen), findsNothing);
        expect(find.byType(HarnessCustomizePane), findsOneWidget);
        expect(find.byType(StatusLine), findsWidgets);
        expect(tester.getRect(find.byKey(pane.cellKey)), before);
        final panel = tester.getRect(find.byType(HarnessCustomizePane));
        expect(panel.right, 1280);
        expect(panel.width, 440);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.byType(SettingsScreen), findsNothing);
        expect(find.byType(HarnessCustomizePane), findsNothing);
        expect(tester.getRect(find.byKey(pane.cellKey)), before);
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
        await tester.pump();
        expect(input.single.bytes, [27, 91, 68]);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'customization updates both live terminal renderers without closing the panel',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 800);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final appearance = appearancePrefsStore.value;
      final font = terminalFontStore.value;
      final scheme = terminalThemeStore.value;
      final palette = grid.AppTheme.palette.value;
      addTearDown(() {
        appearancePrefsStore.value = appearance;
        terminalFontStore.value = font;
        terminalThemeStore.value = scheme;
        grid.AppTheme.palette.value = palette;
      });
      appearancePrefsStore.value = const AppearancePrefs();
      terminalThemeStore.value = TerminalThemeChoice.matchApp;
      final app = createApp()..status = AppStatus.authenticated;
      addTearDown(app.dispose);
      final input = <TerminalBinaryFrame>[];
      final sessions = [terminal('a0', input), terminal('a1', input)];
      for (final session in sessions) {
        session.terminal.write('Keep this output');
      }
      final panes = [
        for (final session in sessions) app.adoptSessionForTest(session),
      ];
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: ProviderScope(
            overrides: [appStateProvider.overrideWithValue(app)],
            child: HarnessApp(
              authenticatedScreen: (app) => SwarmScreen(notifier: app),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final views = [
        for (final session in sessions)
          find.byWidgetPredicate(
            (widget) =>
                widget is TerminalView &&
                identical(widget.terminal, session.terminal),
          ),
      ];
      final states = [
        for (final view in views) tester.state<TerminalViewState>(view),
      ];
      final columns = [for (final session in sessions) session.cols];
      final lineHeights = [
        for (final state in states) state.renderTerminal.lineHeight,
      ];
      await chord(tester, LogicalKeyboardKey.keyP, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> customize',
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      // Publish the same preference notifications as the controls without
      // persisting this test's choices into the developer's saved preferences.
      appearancePrefsStore.value = appearancePrefsStore.value.copyWith(
        prompt: const PromptPrefs(statusStyle: StatusLineStyle.pure),
      );
      await tester.pumpAndSettle();
      final status = tester.widget<StatusLine>(
        find.descendant(
          of: find.byKey(const ValueKey('workspace-pane-context')),
          matching: find.byType(StatusLine),
        ),
      );
      expect(status.parts.text, contains('Test host'));
      expect(
        find.descendant(
          of: find.byKey(panes.first.cellKey),
          matching: find.byType(PromptContextView),
        ),
        findsNothing,
      );
      await _capture(tester, boundary, 'live-panes-customization');
      await tester.tap(find.byKey(const ValueKey('customize-appearance')));
      await tester.pumpAndSettle();
      appearancePrefsStore.value = appearancePrefsStore.value.copyWith(
        palette: HarnessPalette.midnight,
      );
      await tester.pumpAndSettle();
      for (final state in states) {
        expect(
          state.widget.theme.background,
          HarnessPalette.midnight.background,
        );
      }
      expect(find.byType(HarnessCustomizePane), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('customize-terminal')));
      await tester.pumpAndSettle();
      terminalThemeStore.value = TerminalThemeChoice.tango;
      terminalFontStore.value = font.copyWith(fontSize: font.fontSize + 2);
      await tester.pumpAndSettle();
      for (var i = 0; i < sessions.length; i++) {
        expect(tester.state(views[i]), same(states[i]));
        expect(states[i].widget.theme, same(tangoTerminalTheme));
        expect(states[i].widget.textStyle.fontSize, font.fontSize + 2);
        expect(
          states[i].renderTerminal.lineHeight,
          greaterThan(lineHeights[i]),
        );
        expect(sessions[i].cols, lessThan(columns[i]));
        expect(
          sessions[i].terminal.buffer.getText(),
          contains('Keep this output'),
        );
      }
      expect(find.byType(HarnessCustomizePane), findsOneWidget);
      expect(input, isEmpty);
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
      for (final style in StatusLineStyle.values) {
        appearancePrefsStore.value = appearancePrefsStore.value.copyWith(
          prompt: PromptPrefs(statusStyle: style),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await _capture(
          tester,
          boundary,
          '${width.toInt()}-prompt-${style.name}',
        );
      }
      await tester.tap(find.byKey(const ValueKey('customize-appearance')));
      await tester.pumpAndSettle();
      expect(find.text('Color palette'), findsOneWidget);
      expect(find.byKey(const ValueKey('palette-graphite')), findsOneWidget);
      expect(find.byKey(const Key('appearance-ui-size-field')), findsNothing);
      expect(tester.takeException(), isNull);
      await _capture(tester, boundary, '${width.toInt()}-appearance');

      final wallpaperTab = find.byKey(const ValueKey('customize-wallpaper'));
      await tester.ensureVisible(wallpaperTab);
      await tester.tap(wallpaperTab);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('wallpaper-plain')), findsOneWidget);
      expect(tester.takeException(), isNull);
      if (Platform.environment['HARNESS_CUSTOMIZE_CAPTURE_DIR'] != null) {
        await tester.runAsync(() async {
          for (final choice in HarnessBackground.gallery) {
            if (choice.asset case final asset?) {
              await precacheImage(
                ResizeImage(AssetImage(asset), width: 360),
                tester.element(wallpaperTab),
              );
            }
          }
        });
        await tester.pumpAndSettle();
      }
      await _capture(tester, boundary, '${width.toInt()}-wallpaper');

      final terminalTab = find.byKey(const ValueKey('customize-terminal'));
      await tester.ensureVisible(terminalTab);
      await tester.tap(terminalTab);
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
