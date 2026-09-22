import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/widgets/delete_agent_dialog.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/widgets/swarm_dialogs.dart';
import 'package:harness/widgets/swarm_search_preview.dart';
import 'package:harness/widgets/workspace_welcome.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  late TerminalStyle original;
  setUp(() {
    original = terminalFontStore.value;
    newHarnessOpensInBox = true;
    PackageInfo.setMockInitialValues(
      appName: 'Harness',
      packageName: 'ai.autonomous.harness',
      version: '1.1.25',
      buildNumber: '25',
      buildSignature: '',
    );
  });
  tearDown(() {
    terminalFontStore.value = original;
    newHarnessOpensInBox = false;
  });

  void selectFont(
    double size, [
    TerminalFontChoice choice = TerminalFontChoice.menlo,
  ]) {
    // In memory only: tests never alter the user's persisted preferences.
    terminalFontStore.value = TerminalStyle(
      fontSize: size,
      fontFamily: choice.fontFamily,
      fontFamilyFallback: choice.fontFamilyFallback,
    );
  }

  void checkText(WidgetTester tester) {
    var count = 0;
    void check(InlineSpan span, TextStyle inherited) {
      final style = inherited.merge(span.style);
      if (span is TextSpan) {
        if (span.text?.trim().isNotEmpty == true &&
            ![
              'MaterialIcons',
              'lucide',
              'LucideIcons',
            ].any((icon) => style.fontFamily?.contains(icon) == true)) {
          expect(style.fontSize, terminalFontStore.size, reason: span.text);
          expect(
            style.fontFamily,
            terminalFontStore.value.fontFamily,
            reason: span.text,
          );
          count++;
        }
        for (final child in span.children ?? <InlineSpan>[]) {
          check(child, style);
        }
      }
    }

    for (final widget in tester.widgetList<RichText>(find.byType(RichText))) {
      check(widget.text, const TextStyle());
    }
    for (final widget in tester.widgetList<EditableText>(
      find.byType(EditableText),
    )) {
      expect(widget.style.fontSize, terminalFontStore.size);
      expect(widget.style.fontFamily, terminalFontStore.value.fontFamily);
    }
    expect(count, greaterThan(3));
    expect(tester.takeException(), isNull);
  }

  Future<void> mount(
    WidgetTester tester,
    AppNotifier app,
    MemoryKeymap map, {
    bool native = false,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);
    final projects = SwarmProjectStore();
    addTearDown(projects.dispose);
    await tester.pumpWidget(
      ListenableBuilder(
        listenable: terminalFontStore,
        builder: (context, _) => MaterialApp(
          debugShowCheckedModeBanner: false,
          themeAnimationDuration: Duration.zero,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (_, child) => MediaQuery.withNoTextScaling(
            child: grid.BrightnessScope(
              child: KeymapProvider(keymap: map, child: child!),
            ),
          ),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: native,
            projectStore: projects,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  test('all theme roles and control styles use the selected terminal font', () {
    for (final size in [9.0, 13.0, 18.0, 22.0]) {
      selectFont(size);
      final theme = grid.buildAppTheme(brightness: Brightness.dark);
      final t = theme.textTheme;
      for (final style in [
        t.displayLarge,
        t.displayMedium,
        t.displaySmall,
        t.headlineLarge,
        t.headlineMedium,
        t.headlineSmall,
        t.titleLarge,
        t.titleMedium,
        t.titleSmall,
        t.bodyLarge,
        t.bodyMedium,
        t.bodySmall,
        t.labelLarge,
        t.labelMedium,
        t.labelSmall,
        grid.kFieldTextStyle,
        grid.AppFont.codeStyle(),
      ]) {
        expect(style!.fontSize, size);
        expect(style.fontFamily, 'Menlo');
      }
      expect(
        theme.inputDecorationTheme.contentPadding!
            .resolve(TextDirection.ltr)
            .vertical,
        isNonNegative,
      );
      expect(grid.AppControl.heightFieldScaled, closeTo(36 * size / 13, .001));
    }
  });

  testWidgets(
    'tabs, panes, welcome, Cmd-N, Cmd-O and Cmd-P update while open',
    (tester) async {
      final app = createApp();
      final map = MemoryKeymap();
      addTearDown(app.dispose);
      addTearDown(map.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      selectFont(13);
      await mount(tester, app, map);
      checkText(tester);
      selectFont(18, TerminalFontChoice.monaco);
      await tester.pumpAndSettle();
      checkText(tester);

      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      expect(find.byType(WorkspaceWelcome), findsOneWidget);
      checkText(tester);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      expect(find.byType(NewHarnessBox), findsOneWidget);
      checkText(tester);
      selectFont(22);
      await tester.pumpAndSettle();
      checkText(tester);
      await key(tester, LogicalKeyboardKey.escape);
      for (final shortcut in [
        LogicalKeyboardKey.keyO,
        LogicalKeyboardKey.keyO,
      ]) {
        await key(tester, shortcut, cmd: true);
        final input = find.byKey(const ValueKey('swarm-search-input'));
        await tester.enterText(input, 'Agent');
        await key(tester, LogicalKeyboardKey.arrowUp);
        await tester.pumpAndSettle();
        expect(find.byType(SwarmSearchPreview), findsOneWidget);
        checkText(tester);
        selectFont(
          shortcut == LogicalKeyboardKey.keyO ? 9 : 18,
          TerminalFontChoice.monaco,
        );
        await tester.pumpAndSettle();
        expect(tester.widget<TextField>(input).controller!.text, 'Agent');
        expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
        checkText(tester);
        await key(tester, LogicalKeyboardKey.escape);
      }
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'rename and stop forms follow family and size without reopening',
    (tester) async {
      final app = createApp();
      final map = MemoryKeymap();
      addTearDown(app.dispose);
      addTearDown(map.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      selectFont(13);
      await mount(tester, app, map);
      final context = tester.element(find.byType(SwarmScreen));
      unawaited(showSwarmRenameDialog(context, 'My project', keymap: map));
      await tester.pumpAndSettle();
      checkText(tester);
      selectFont(22, TerminalFontChoice.monaco);
      await tester.pumpAndSettle();
      checkText(tester);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('tab-rename-input')))
            .controller!
            .text,
        'My project',
      );
      await key(tester, LogicalKeyboardKey.escape);
      unawaited(
        confirmDeleteAgent(
          context,
          app,
          'm',
          'a0',
          'My project',
          engine: 'codex',
          keymap: map,
        ),
      );
      await tester.pumpAndSettle();
      checkText(tester);
      selectFont(9);
      await tester.pumpAndSettle();
      checkText(tester);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('native tab payload follows the same font live', (tester) async {
    final updates = <Map<dynamic, dynamic>>[];
    const channel = MethodChannel('harness/swarm_tabs');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'update') updates.add(call.arguments as Map);
      return true;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    final app = createApp();
    final map = MemoryKeymap();
    addTearDown(app.dispose);
    addTearDown(map.dispose);
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app, map, native: true);
    selectFont(22, TerminalFontChoice.monaco);
    await tester.pumpAndSettle();
    expect(updates.last['fontFamily'], 'Monaco');
    expect(updates.last['fontSize'], 22);
    await tester.pumpWidget(const SizedBox());
  });
}
