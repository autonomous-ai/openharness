import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/search_result_text.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/open_harness.dart';
import 'support/real_fonts.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

final _input = find.byKey(const ValueKey('swarm-search-input'));
final _panel = find.byKey(const ValueKey('swarm-search-results'));
final _preview = find.byKey(const ValueKey('swarm-search-preview'));

Future<void> _mount(
  WidgetTester tester,
  AppNotifier app,
  MemoryKeymap map,
) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final projects = SwarmProjectStore();
  addTearDown(projects.dispose);
  app.machineStates['m']!.nodeOnline = true;
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
}

void main() {
  setUpAll(
    Platform.environment['HARNESS_COMMAND_CAPTURE_DIR'] == null
        ? loadRealFonts
        : loadPreviewFonts,
  );

  testWidgets(
    'commands retain the Cmd-P terminal grid, editor and live appearance',
    (tester) async {
      final originalFont = terminalFontStore.value;
      final originalPalette = grid.AppTheme.palette.value;
      final originalTheme = terminalThemeStore.value;
      addTearDown(() {
        terminalFontStore.value = originalFont;
        grid.AppTheme.palette.value = originalPalette;
        terminalThemeStore.value = originalTheme;
      });
      final app = createApp();
      final map = MemoryKeymap();
      addTearDown(app.dispose);
      addTearDown(map.dispose);
      final frames = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', frames));
      await _mount(tester, app, map);
      await openHarnessPicker(tester);
      final bounds = tester.getRect(_panel);
      final inputBounds = tester.getRect(_input);
      final editor = tester.state<EditableTextState>(
        find.descendant(of: _input, matching: find.byType(EditableText)),
      );
      final controller = tester.widget<TextField>(_input).controller!;
      final terminalBuffer = tester
          .widget<TerminalView>(find.byType(TerminalView))
          .terminal;

      // Typing a prefix and using the launch shortcut reach the same surface.
      await tester.enterText(_input, '>');
      await tester.pumpAndSettle();
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      expect(search.isCommandMode, isTrue);
      expect(search.hasPreview, isTrue);
      expect(tester.getRect(_panel), bounds);
      expect(tester.getRect(_input), inputBounds);
      expect(
        tester.state<EditableTextState>(
          find.descendant(of: _input, matching: find.byType(EditableText)),
        ),
        same(editor),
      );
      expect(find.byType(SwarmSearchHints), findsNothing);
      expect(find.byType(SwarmSearchCount), findsNothing);
      expect(
        find.descendant(of: _panel, matching: find.byType(Icon)),
        findsNothing,
      );
      expect(
        find.descendant(of: _panel, matching: find.byType(ListTile)),
        findsNothing,
      );

      await tester.enterText(_input, '> new harness');
      await tester.pumpAndSettle();
      final selected = search.selected!;
      expect(selected.commandId, 'agent.new');
      final editing = controller.value;

      void checkAppearance() {
        final field = tester.widget<TextField>(_input);
        final pane = tester.widget<TerminalView>(find.byType(TerminalView));
        final cell = terminalCellSizeOf(tester.element(_input));
        final line = find.byKey(ValueKey('swarm-search-line:${selected.id}'));
        expect(tester.getSize(line).height, closeTo(cell.height, .01));
        expect(tester.widget<Container>(line).color, pane.theme.selection);
        expect(tester.widget<Material>(_panel).color, pane.theme.background);
        expect(field.cursorWidth, 2);
        expect(field.cursorColor, pane.theme.cursor);
        final title = find.descendant(
          of: line,
          matching: find.byType(SearchResultText),
        );
        expect(
          tester.getTopLeft(title).dx,
          closeTo(tester.getTopLeft(_input).dx, .01),
        );
        final shortcut = find.byKey(
          ValueKey('swarm-search-shortcut:${selected.id}'),
        );
        expect(tester.widget<Text>(shortcut).data, selected.shortcut);
        final previewText = tester.widgetList<Text>(
          find.descendant(of: _preview, matching: find.byType(Text)),
        );
        expect(previewText.map((text) => text.data), [
          selected.title,
          selected.detail,
          selected.shortcut,
        ]);
        for (final style in [
          field.style!,
          tester.widget<SearchResultText>(title).style,
          tester.widget<Text>(shortcut).style!,
          ...previewText.map((text) => text.style!),
        ]) {
          expect(style.fontFamily, pane.textStyle.fontFamily);
          expect(style.fontFamilyFallback, pane.textStyle.fontFamilyFallback);
          expect(style.fontSize, pane.textStyle.fontSize);
          expect(style.fontWeight, pane.textStyle.toTextStyle().fontWeight);
          expect(style.height, pane.textStyle.height);
          expect(style.letterSpacing, 0);
          expect(style.wordSpacing, 0);
        }
        expect(field.controller, same(controller));
        expect(controller.value, editing);
        expect(field.focusNode!.hasFocus, isTrue);
        expect(search.selected!.id, selected.id);
        expect(pane.terminal, same(terminalBuffer));
        expect(frames, isEmpty);
        expect(tester.takeException(), isNull);
      }

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

      // Empty results never show a stale command preview or execute it.
      await tester.enterText(_input, '> no-such-command-923');
      await tester.pumpAndSettle();
      expect(search.selected, isNull);
      expect(find.text('No matching commands'), findsOneWidget);
      expect(
        find.descendant(of: _preview, matching: find.byType(Text)),
        findsNothing,
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(_input, findsOneWidget);
      await tester.enterText(_input, '');
      await tester.pumpAndSettle();
      expect(search.isCommandMode, isFalse);
      expect(tester.getRect(_panel), bounds);
      expect(controller.text, isEmpty);
      expect(
        find.byKey(const ValueKey('swarm-search-type-hints')),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.escape);
      final linux = defaultTargetPlatform == TargetPlatform.linux;
      await key(
        tester,
        LogicalKeyboardKey.keyP,
        cmd: !linux,
        ctrl: linux,
        shift: true,
      );
      expect(tester.widget<TextField>(_input).controller!.text, '>');
      expect(
        tester.widget<SwarmSearchResults>(find.byType(SwarmSearchResults)).bios,
        isTrue,
      );
      expect(tester.getRect(_panel), bounds);
      expect(frames, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
    variant: TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  for (final size in [const Size(1280, 800), const Size(400, 600)]) {
    testWidgets('commands page and preview on the terminal grid at $size', (
      tester,
    ) async {
      final originalFont = terminalFontStore.value;
      addTearDown(() => terminalFontStore.value = originalFont);
      if (size.width < 800) {
        terminalFontStore.value = const TerminalStyle(
          fontSize: 22,
          fontFamily: 'Menlo',
          height: 1.4,
        );
      }
      final app = createApp();
      final map = MemoryKeymap();
      addTearDown(app.dispose);
      addTearDown(map.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      await _mount(tester, app, map);
      tester.view.physicalSize = size;
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      final field = tester.widget<TextField>(_input);
      final value = field.controller!.value;
      final first = search.cursor;
      await key(tester, LogicalKeyboardKey.pageDown);
      expect(search.cursor, greaterThan(first + 1));
      await key(tester, LogicalKeyboardKey.pageUp);
      expect(search.cursor, first);
      await key(tester, LogicalKeyboardKey.tab);
      expect(search.cursor, first);
      expect(field.focusNode!.hasFocus, isTrue);
      expect(
        find.byKey(const ValueKey('swarm-search-resource-actions')),
        findsNothing,
      );
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(search.cursor, first + 1);
      expect(field.controller!.value, value);
      expect(field.focusNode!.hasFocus, isTrue);
      final list = find.byKey(const ValueKey('swarm-search-result-list'));
      expect(
        size.width > 800
            ? tester.getRect(_preview).left > tester.getRect(list).right
            : tester.getRect(_preview).top > tester.getRect(list).bottom,
        isTrue,
      );
      await tester.enterText(_input, '> new harness');
      await tester.pumpAndSettle();
      map.apply('''{"bindings":[
        {"keys":"cmd+n","command":null},
        {"keys":"ctrl+shift+alt+x ctrl+shift+alt+y","command":"agent.new"}
      ]}''');
      await tester.pumpAndSettle();
      final shortcut = map.hint('agent.new');
      expect(search.selected!.shortcut, shortcut);
      expect(
        find.descendant(of: _preview, matching: find.text(shortcut!)),
        findsOneWidget,
      );
      expect(field.controller!.text, '> new harness');
      expect(tester.takeException(), isNull);
      map.apply('{"bindings":[]}');
      await tester.enterText(_input, '?');
      await tester.pumpAndSettle();
      expect(search.hasPreview, isTrue);
      expect(find.text('No recent session text available.'), findsNothing);
      expect(
        tester.widget<TextField>(_input).controller,
        same(field.controller),
      );
      await tester.enterText(_input, '> new');
      await tester.pumpAndSettle();
      final directory = Platform.environment['HARNESS_COMMAND_CAPTURE_DIR'];
      if (directory != null) {
        final layer =
            tester.binding.renderViews.first.debugLayer! as OffsetLayer;
        final rect = tester.getRect(_panel);
        await tester.runAsync(() async {
          final image = await layer.toImage(rect);
          final data = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(directory).create(recursive: true);
          await File('$directory/commands-${size.width.toInt()}.png')
              .writeAsBytes(data!.buffer.asUint8List());
          image.dispose();
        });
      }
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }
}
