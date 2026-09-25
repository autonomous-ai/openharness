import 'support/open_harness.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/search_result_text.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/widgets/prompt_context.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' show mount;
import 'support/launch_menu.dart' show openLaunchRow;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_search_preview_test.dart' show seedPreviews;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets(
    'terminal dialogs follow the live pane theme without losing focus',
    (tester) async {
      final originalPalette = grid.AppTheme.palette.value;
      final originalTheme = terminalThemeStore.value;
      final originalFont = terminalFontStore.value;
      final originalEntry = newHarnessOpensInBox;
      newHarnessOpensInBox = true;
      addTearDown(() {
        grid.AppTheme.palette.value = originalPalette;
        terminalThemeStore.value = originalTheme;
        terminalFontStore.value = originalFont;
        newHarnessOpensInBox = originalEntry;
      });
      final app = createApp();
      final map = MemoryKeymap();
      final projects = SwarmProjectStore();
      addTearDown(map.dispose);
      addTearDown(projects.dispose);
      await seedPreviews(app);
      app.adoptSessionForTest(terminal('a69', []));
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 800);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (_, child) => grid.BrightnessScope(
            child: KeymapProvider(keymap: map, child: child!),
          ),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await openHarnessPicker(tester);
      final input = find.byKey(const ValueKey('swarm-search-input'));
      await tester.enterText(input, 'Test host');
      await tester.pumpAndSettle();
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      final selectedId = search.selected!.id;
      final controller = tester.widget<TextField>(input).controller!;
      final editing = controller.value;
      final terminalBuffer = tester
          .widget<TerminalView>(find.byType(TerminalView))
          .terminal;

      void checkAppearance() {
        final pane = tester.widget<TerminalView>(find.byType(TerminalView));
        final field = tester.widget<TextField>(input);
        final editor = tester.widget<EditableText>(
          find.descendant(of: input, matching: find.byType(EditableText)),
        );
        final panel = tester.widget<Material>(
          find.byKey(const ValueKey('swarm-search-results')),
        );
        expect(panel.color, pane.theme.background);
        expect(field.style!.color, pane.theme.foreground);
        expect(field.cursorColor, pane.theme.cursor);
        expect(editor.selectionColor, pane.theme.selection);
        final row = find.byKey(
          ValueKey('swarm-search-line:${search.selected!.id}'),
        );
        expect(tester.widget<Container>(row).color, pane.theme.selection);
        final cell = terminalCellSizeOf(tester.element(input));
        expect(tester.getSize(row).height, closeTo(cell.height, .01));
        expect(
          tester.getSize(find.byKey(ValueKey(search.selected!.id))).height,
          closeTo(cell.height, .01),
        );
        expect(field.cursorWidth, 2);
        final rowTitles = tester.widgetList<SearchResultText>(
          find.byWidgetPredicate(
            (widget) =>
                widget is SearchResultText &&
                search.rows.any((row) => row.title == widget.text),
          ),
        );
        expect(rowTitles, isNotEmpty);
        for (final title in rowTitles) {
          final row = search.rows.firstWhere((row) => row.title == title.text);
          expect(
            title.style.color,
            search.canSubmit(row)
                ? pane.theme.foreground
                : pane.theme.foreground.withValues(alpha: .28),
          );
        }
        final previewText = tester.widgetList<Text>(
          find.descendant(
            of: find.byKey(const ValueKey('swarm-search-preview')),
            matching: find.byType(Text),
          ),
        );
        expect(previewText, isNotEmpty);
        for (final style in [
          field.style!,
          ...rowTitles.map((text) => text.style),
          ...previewText.map((text) => text.style!),
        ]) {
          expect(style.fontFamily, pane.textStyle.fontFamily);
          expect(style.fontFamilyFallback, pane.textStyle.fontFamilyFallback);
          expect(style.fontSize, pane.textStyle.fontSize);
          expect(style.height, pane.textStyle.height);
          expect(style.letterSpacing, 0);
          expect(style.wordSpacing, 0);
        }
        expect(search.selected!.id, selectedId);
        expect(field.controller, same(controller));
        expect(controller.value, editing);
        expect(field.focusNode!.hasFocus, isTrue);
        expect(pane.terminal, same(terminalBuffer));
        expect(tester.takeException(), isNull);
      }

      // All app palettes, then an independent terminal scheme and a live zoom.
      // Each change happens with the same input, cached rows and preview open.
      terminalThemeStore.value = TerminalThemeChoice.matchApp;
      for (final palette in HarnessPalette.values) {
        grid.AppTheme.palette.value = palette;
        await tester.pumpAndSettle();
        checkAppearance();
      }
      terminalThemeStore.value = TerminalThemeChoice.tango;
      terminalFontStore.value = const TerminalStyle(
        fontSize: 18,
        fontFamily: 'Menlo',
        fontFamilyFallback: ['monospace'],
        height: 1.4,
      );
      await tester.pumpAndSettle();
      checkAppearance();
      await tester.enterText(input, 'safe-retries');
      await tester.pumpAndSettle();
      expect(search.selected!.agentId, 'a0');
      final preview = find.byKey(const ValueKey('swarm-search-preview'));
      final title = find.descendant(
        of: preview,
        matching: find.text('Checkout retries'),
      );
      final context = find.text('Test host:storefront  (feat/safe-retries)');
      expect(context, findsOneWidget);
      expect(find.descendant(of: preview, matching: context), findsOneWidget);
      final cell = terminalCellSizeOf(tester.element(input));
      expect(
        tester.getTopLeft(context).dy - tester.getTopLeft(title).dy,
        closeTo(cell.height, .01),
      );
      expect(
        tester
            .widgetList<SearchResultText>(
              find.descendant(
                of: find.byKey(ValueKey(search.selected!.id)),
                matching: find.byType(SearchResultText),
              ),
            )
            .map((text) => text.text),
        ['Checkout retries'],
      );
      expect(find.text('git: feat/safe-retries'), findsNothing);
      await tester.enterText(input, 'Workspace sync');
      await tester.pumpAndSettle();
      final waiting = tester.widget<Text>(find.text('Needs your input'));
      expect(waiting.style!.fontSize, 18);
      expect(waiting.style!.height, 1.4);
      expect(
        waiting.style!.color,
        tester.widget<TerminalView>(find.byType(TerminalView)).theme.yellow,
      );
      await key(tester, LogicalKeyboardKey.escape);
      expect(find.byKey(const ValueKey('swarm-search-results')), findsNothing);

      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      await openLaunchRow(tester, 'project');
      final setup = find.byType(NewHarnessForm);
      final box = tester.widget<NewHarnessForm>(setup).controller;
      final setupInput = find.byKey(const ValueKey('new-harness-query'));
      await tester.enterText(setupInput, 'store');
      await tester.pumpAndSettle();
      final setupController = tester.widget<TextField>(setupInput).controller!;
      final setupEditing = setupController.value;
      final selectedOption = box.selected?.id;

      void checkSetupAppearance() {
        final pane = tester.widget<TerminalView>(find.byType(TerminalView));
        final field = tester.widget<TextField>(setupInput);
        final editor = tester.widget<EditableText>(
          find.descendant(of: setupInput, matching: find.byType(EditableText)),
        );
        expect(
          tester
              .widget<Material>(
                find.byKey(const ValueKey('new-harness-surface')),
              )
              .color,
          pane.theme.background,
        );
        expect(field.style!.color, pane.theme.foreground);
        expect(field.cursorColor, pane.theme.cursor);
        expect(editor.selectionColor, pane.theme.selection);
        expect(
          tester
              .widgetList<Container>(
                find.descendant(of: setup, matching: find.byType(Container)),
              )
              .where((container) => container.color == pane.theme.selection),
          hasLength(1),
        );
        for (final style in [
          field.style!,
          ...tester
              .widgetList<Text>(
                find.descendant(of: setup, matching: find.byType(Text)),
              )
              .map((text) => text.style!),
        ]) {
          expect(style.fontFamily, pane.textStyle.fontFamily);
          expect(style.fontFamilyFallback, pane.textStyle.fontFamilyFallback);
          expect(style.fontSize, pane.textStyle.fontSize);
          expect(style.height, pane.textStyle.height);
          expect(style.letterSpacing, 0);
          expect(style.wordSpacing, 0);
        }
        expect(box.selected?.id, selectedOption);
        expect(field.controller, same(setupController));
        expect(setupController.value, setupEditing);
        expect(field.focusNode!.hasFocus, isTrue);
        expect(pane.terminal, same(terminalBuffer));
        expect(tester.takeException(), isNull);
      }

      terminalThemeStore.value = TerminalThemeChoice.matchApp;
      for (final palette in HarnessPalette.values) {
        grid.AppTheme.palette.value = palette;
        await tester.pumpAndSettle();
        checkSetupAppearance();
      }
      terminalThemeStore.value = TerminalThemeChoice.tango;
      terminalFontStore.value = const TerminalStyle(
        fontSize: 14,
        fontFamily: 'Monaco',
        fontFamilyFallback: ['Menlo'],
        height: 1.3,
      );
      await tester.pumpAndSettle();
      checkSetupAppearance();
      box.warn('The selected machine is offline.');
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('new-harness-status')))
            .style!
            .color,
        tester.widget<TerminalView>(find.byType(TerminalView)).theme.red,
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('Open Harness builds a small window and Tab reaches later rows', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    app.adoptSessionForTest(terminal('a0', []));
    final map = MemoryKeymap();
    await mount(tester, app, map);
    await openHarnessPicker(tester);
    final results = find.byType(SwarmSearchResults);
    final search = tester.widget<SwarmSearchResults>(results).search;
    final rowIds = search.rows.map((row) => row.id).toSet();
    final rows = find.descendant(
      of: results,
      matching: find.byWidgetPredicate(
        (widget) =>
            widget is InkWell &&
            widget.key is ValueKey<String> &&
            rowIds.contains((widget.key! as ValueKey<String>).value),
      ),
    );
    final input = find.byKey(const ValueKey('swarm-search-input'));
    final cell = terminalCellSizeOf(tester.element(input));
    for (final row in rows.evaluate()) {
      final id = (row.widget.key! as ValueKey<String>).value;
      final line = find.byKey(ValueKey('swarm-search-line:$id'));
      expect(
        tester.getSize(line).height,
        closeTo(cell.height, .01),
        reason: 'Selection occupies exactly one terminal line.',
      );
      expect(
        tester.getSize(find.byKey(ValueKey(id))).height,
        closeTo(cell.height, .01),
        reason: 'The entire result occupies one line, with no spacer row.',
      );
      final title = find
          .descendant(of: line, matching: find.byType(Text))
          .first;
      expect(
        tester.getTopLeft(title).dx,
        closeTo(tester.getTopLeft(input).dx, .01),
      );
    }
    final first = find.byKey(ValueKey(search.rows[0].id));
    final second = find.byKey(ValueKey(search.rows[1].id));
    expect(
      tester.getTopLeft(second).dy - tester.getTopLeft(first).dy,
      closeTo(cell.height, .01),
    );
    for (final type in [ListTile, Icon, Image, EngineMark, PromptContextView]) {
      expect(
        find.descendant(of: results, matching: find.byType(type)),
        findsNothing,
      );
    }
    expect(search.rows.length, greaterThan(50));
    final list = find.byKey(const ValueKey('swarm-search-result-list'));
    final capacity = (tester.getSize(list).height / cell.height).ceil();
    expect(rows.evaluate().length, lessThanOrEqualTo(capacity + 2));
    expect(rows.evaluate().length, lessThan(search.rows.length));
    final visited = <String>{};
    for (var step = 0; step < 35; step++) {
      await key(tester, LogicalKeyboardKey.tab);
      await tester.pumpAndSettle();
      final selected = search.selected;
      if (selected != null) {
        visited.add(selected.id);
        expect(find.byKey(ValueKey(selected.id)).hitTestable(), findsOneWidget);
        expect(
          tester
              .widget<TextField>(
                find.byKey(const ValueKey('swarm-search-input')),
              )
              .focusNode!
              .hasFocus,
          isTrue,
        );
      }
    }
    // Focus crosses the initial viewport repeatedly as new rows are built.
    expect(visited.length, greaterThan(15));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    map.dispose();
  });
}
