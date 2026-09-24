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
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/pane_header_actions.dart';
import 'package:harness/widgets/swarm_dialogs.dart';
import 'package:harness/widgets/swarm_search_preview.dart';
import 'package:harness/widgets/search_result_text.dart';
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

  final ramp = <double>{
    grid.AppType.displaySize,
    grid.AppType.titleSize,
    grid.AppType.headingSize,
    grid.AppType.bodySize,
    grid.AppType.monoLabelSize,
    grid.AppType.captionSize,
  };

  /// General UI keeps its fixed scale; workspace chrome follows the terminal.
  /// Return general UI sizes for comparisons across a terminal zoom.
  Map<String, double> checkText(WidgetTester tester, {int atLeast = 4}) {
    final sizes = <String, double>{};
    var checked = 0;
    void check(InlineSpan span, TextStyle inherited, {bool terminal = false}) {
      final style = inherited.merge(span.style);
      if (span is TextSpan) {
        final text = span.text?.trim();
        if (text?.isNotEmpty == true &&
            ![
              'MaterialIcons',
              'lucide',
              'LucideIcons',
            ].any((icon) => style.fontFamily?.contains(icon) == true)) {
          checked++;
          if (terminal) {
            expect(style.fontSize, terminalFontStore.size, reason: text);
            expect(
              style.fontFamily,
              terminalFontStore.value.fontFamily,
              reason: text,
            );
          } else {
            expect(ramp, contains(style.fontSize), reason: text);
            expect(
              [grid.AppType.sansFamily, grid.AppType.monoFamily],
              contains(style.fontFamily),
              reason: text,
            );
            sizes[text!] = style.fontSize!;
          }
        }
        for (final child in span.children ?? <InlineSpan>[]) {
          check(child, style, terminal: terminal);
        }
      }
    }

    // The welcome page stands where a terminal will and is set like one, so
    // it follows the terminal's size instead; see [checkWelcome].
    final welcome = find.byType(WorkspaceWelcome);
    final setup = find.byWidgetPredicate(
      (widget) =>
          widget is NewHarnessForm ||
          widget.key == const ValueKey('swarm-search-results'),
    );
    for (final element in find.byType(RichText).evaluate()) {
      if (find
              .descendant(of: welcome, matching: find.byWidget(element.widget))
              .evaluate()
              .isNotEmpty ||
          find
              .descendant(of: setup, matching: find.byWidget(element.widget))
              .evaluate()
              .isNotEmpty) {
        continue;
      }
      check(
        (element.widget as RichText).text,
        const TextStyle(),
        terminal: find
            .descendant(
              of: find.byWidgetPredicate(
                (widget) =>
                    widget.key == const ValueKey('workspace-status-bar') ||
                    widget.key == const ValueKey('terminal-pane-title') ||
                    widget.key == const ValueKey('viewer-pane-title') ||
                    widget is PaneHeaderActions,
              ),
              matching: find.byWidget(element.widget),
            )
            .evaluate()
            .isNotEmpty,
      );
    }
    for (final widget in tester.widgetList<EditableText>(
      find.byType(EditableText),
    )) {
      // A field is on the scale, or it types into the terminal and follows it.
      expect({
        ...ramp,
        terminalFontStore.size,
      }, contains(widget.style.fontSize));
    }
    expect(checked, greaterThanOrEqualTo(atLeast));
    expect(tester.takeException(), isNull);
    return sizes;
  }

  /// The welcome page is terminal text: the terminal's face at its size.
  void checkWelcome(WidgetTester tester) {
    final tagline = find.byKey(const ValueKey('welcome-tagline'));
    final line = tester.widget<Text>(tagline);
    final style = DefaultTextStyle.of(tester.element(tagline)).style
        .merge(line.style);
    expect(style.fontSize, terminalFontStore.size);
    expect(style.fontFamily, terminalFontStore.value.fontFamily);
  }

  /// Zooming the terminal leaves every UI text where it was.
  void expectSameSizes(Map<String, double> before, Map<String, double> after) {
    for (final entry in after.entries) {
      if (before.containsKey(entry.key)) {
        expect(entry.value, before[entry.key], reason: entry.key);
      }
    }
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

  test('the theme keeps its scale whatever the terminal size', () {
    for (final size in [9.0, 13.0, 18.0, 22.0]) {
      selectFont(size);
      final theme = grid.buildAppTheme(brightness: Brightness.dark);
      final t = theme.textTheme;
      final mono = grid.AppType.monoFamily;
      final sans = grid.AppType.sansFamily;
      // Headings, labels and what the user types are mono; prose is sans.
      final expected = {
        t.displayLarge: (grid.AppType.displaySize, mono),
        t.headlineSmall: (grid.AppType.titleSize, mono),
        t.titleLarge: (grid.AppType.titleSize, mono),
        t.titleMedium: (grid.AppType.headingSize, mono),
        t.titleSmall: (grid.AppType.bodySize, mono),
        t.labelLarge: (grid.AppType.bodySize, mono),
        t.labelSmall: (grid.AppType.monoMetaSize, mono),
        t.bodyLarge: (grid.AppType.bodySize, sans),
        t.bodyMedium: (grid.AppType.bodySize, sans),
        t.bodySmall: (grid.AppType.bodySize, sans),
        grid.kFieldTextStyle: (grid.AppType.monoSize, mono),
        theme.dialogTheme.titleTextStyle: (grid.AppType.headingSize, mono),
        theme.dialogTheme.contentTextStyle: (grid.AppType.bodySize, sans),
        theme.tooltipTheme.textStyle: (grid.AppType.captionSize, sans),
      };
      for (final entry in expected.entries) {
        expect(entry.key!.fontSize, entry.value.$1);
        expect(entry.key!.fontFamily, entry.value.$2);
      }
      expect(grid.AppControl.heightFieldScaled, 36);
      expect(grid.AppControl.heightScaled, 32);
    }
  });

  test('mono takes the terminal face but not its size', () {
    selectFont(22);
    for (final (style, size) in [
      (grid.AppType.heading(), grid.AppType.headingSize),
      (grid.AppType.label(), grid.AppType.bodySize),
      (grid.AppType.mono(), grid.AppType.monoSize),
      (grid.AppType.monoLabel(), grid.AppType.monoLabelSize),
      (grid.AppType.monoMeta(), grid.AppType.monoMetaSize),
      (grid.AppFont.codeStyle(), grid.AppType.monoSize),
    ]) {
      expect(style.fontFamily, 'Menlo');
      expect(style.fontSize, size);
    }
    expect(terminalTextStyle().fontSize, 22);
  });

  testWidgets(
    'tabs, welcome, and setup screens follow terminal zoom while general UI keeps its scale',
    (tester) async {
      final app = createApp();
      final map = MemoryKeymap();
      addTearDown(app.dispose);
      addTearDown(map.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      selectFont(13);
      await mount(tester, app, map);
      final before = checkText(tester);
      selectFont(18, TerminalFontChoice.monaco);
      await tester.pumpAndSettle();
      expectSameSizes(before, checkText(tester));

      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      expect(find.byType(WorkspaceWelcome), findsOneWidget);
      // Only the tab chrome is UI text here; the page itself is checked below.
      checkText(tester, atLeast: 1);
      checkWelcome(tester);
      selectFont(22);
      await tester.pumpAndSettle();
      checkWelcome(tester);
      selectFont(18, TerminalFontChoice.monaco);
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      expect(find.byType(NewHarnessForm), findsOneWidget);
      final box = checkText(tester, atLeast: 1);
      expect(
        tester.widget<Text>(find.text('[ New Harness ]')).style!.fontSize,
        18,
      );
      selectFont(22);
      await tester.pumpAndSettle();
      expectSameSizes(box, checkText(tester, atLeast: 1));
      expect(
        tester.widget<Text>(find.text('[ New Harness ]')).style!.fontSize,
        22,
      );
      await key(tester, LogicalKeyboardKey.escape);
      for (final shortcut in [
        LogicalKeyboardKey.keyO,
        LogicalKeyboardKey.keyO,
      ]) {
        await key(tester, shortcut, cmd: true);
        final input = find.byKey(const ValueKey('swarm-search-input'));
        await tester.enterText(input, 'Agent');
        await key(tester, LogicalKeyboardKey.arrowDown);
        await tester.pumpAndSettle();
        expect(find.byType(SwarmSearchPreview), findsOneWidget);
        final search = checkText(tester, atLeast: 1);
        selectFont(
          shortcut == LogicalKeyboardKey.keyO ? 9 : 18,
          TerminalFontChoice.monaco,
        );
        await tester.pumpAndSettle();
        expect(tester.widget<TextField>(input).controller!.text, 'Agent');
        expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
        expectSameSizes(search, checkText(tester, atLeast: 1));
        expect(
          tester.widget<TextField>(input).style!.fontSize,
          terminalFontStore.size,
        );
        for (final text in tester.widgetList<SearchResultText>(
          find.byType(SearchResultText),
        )) {
          expect(text.style.fontFamily, terminalFontStore.value.fontFamily);
          expect(text.style.fontSize, terminalFontStore.size);
          expect(text.style.height, terminalFontStore.value.height);
          expect(text.style.letterSpacing, 0);
        }
        await key(tester, LogicalKeyboardKey.escape);
      }
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('rename and stop forms keep the scale while the terminal zooms', (
    tester,
  ) async {
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
    final rename = checkText(tester);
    selectFont(22, TerminalFontChoice.monaco);
    await tester.pumpAndSettle();
    expectSameSizes(rename, checkText(tester));
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
    final stop = checkText(tester);
    selectFont(9);
    await tester.pumpAndSettle();
    expectSameSizes(stop, checkText(tester));
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'native tabs receive the same live font and size as the terminal',
    (tester) async {
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
      expect(updates.last['terminalStyle'], containsPair('family', 'Monaco'));
      expect(updates.last['terminalStyle'], containsPair('size', 22.0));
      selectFont(14, TerminalFontChoice.sfMono);
      await tester.pumpAndSettle();
      expect(
        updates.last['terminalStyle'],
        containsPair('family', terminalFontStore.value.fontFamily),
      );
      expect(updates.last['terminalStyle'], containsPair('size', 14.0));
      expect(updates.last.containsKey('fontFallbacks'), isFalse);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
