import 'support/open_harness.dart';

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/api_connections_controller.dart';
import 'package:harness/models/api_connections_panel.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/search_result_text.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'support/model_manager.dart';
import 'support/real_fonts.dart';
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_search_preview_test.dart' show seedPreviews;

final field = find.byKey(const ValueKey('swarm-search-input'));
SwarmSearchController search(WidgetTester tester) =>
    tester.widget<SwarmSearchResults>(find.byType(SwarmSearchResults)).search;

Future<ModelManagerTestApp> fixture() async {
  final app = ModelManagerTestApp(ModelManagerConnection());
  await seedPreviews(app);
  app.adoptSessionForTest(terminal('a69', []));
  app.machineStates['m']!.dsh.replace(const [
    DshEntry(
      id: 'blender',
      name: 'Blender',
      engine: 'codex',
      category: '3D',
      description: 'Create scenes, models, and animation.',
    ),
    DshEntry(
      id: 'marimo',
      name: 'Marimo',
      engine: 'codex',
      category: 'Data',
      description: 'Explore data in a Python notebook.',
    ),
  ]);
  await app.modelManager.refresh();
  app.modelManager.apis
    ..connections = [
      const ApiConnection({
        'id': 'deepseek-api',
        'provider': 'custom',
        'name': 'DeepSeek API',
        'baseUrl': 'https://api.deepseek.com',
        'keyEnv': 'DEEPSEEK_API_KEY',
      }),
    ]
    ..loaded = true;
  return app;
}

Future<void> capture(WidgetTester tester, String name) async {
  final directory = Platform.environment['RESOURCE_PICKER_CAPTURE_DIR'];
  if (directory == null) return;
  final view = tester.binding.renderViews.first;
  final layer = view.debugLayer! as OffsetLayer;
  await tester.runAsync(() async {
    final image = await layer.toImage(Offset.zero & view.size);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('$directory/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide')..addFont(
          rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
        ))
        .load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide300')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
          ),
        ))
        .load();
  });

  testWidgets(
    'platform picker and command shortcuts',
    (tester) async {
      final app = await fixture();
      final keymap = MemoryKeymap();
      try {
        await configured.mount(tester, app, keymap);
        final mac = defaultTargetPlatform == TargetPlatform.macOS;
        await key(tester, LogicalKeyboardKey.keyO, cmd: mac, ctrl: !mac);
        expect(field, findsOneWidget);
        expect(search(tester).scopePrefix, '#');
        final editor = tester.widget<TextField>(field).controller!;
        expect(editor.text, '#');
        expect(editor.selection, const TextSelection.collapsed(offset: 1));
        await key(tester, LogicalKeyboardKey.backspace);
        expect(editor.text, isEmpty);
        expect(search(tester).scopePrefix, '');
        expect(search(tester).hint, 'Search harnesses');
        expect(search(tester).rows.any((row) => row.isCreate), isFalse);
        await key(tester, LogicalKeyboardKey.escape);
        await key(tester, LogicalKeyboardKey.keyP, cmd: mac, ctrl: !mac);
        expect(search(tester).scopePrefix, '');
        expect(tester.widget<TextField>(field).controller!.text, isEmpty);
        expect(tester.widget<TextField>(field).cursorWidth, 2);
        expect(find.byKey(const ValueKey('swarm-search-prompt')), findsNothing);
        final hints = find.byKey(const ValueKey('swarm-search-type-hints'));
        expect(hints, findsOneWidget);
        expect(search(tester).selected, isNull);
        await key(tester, LogicalKeyboardKey.enter);
        expect(field, findsOneWidget);
        expect(search(tester).selected, isNull);
        expect(search(tester).isCommandMode, isFalse);
        expect(search(tester).rows.any((row) => row.agentId != null), isTrue);
        await tester.enterText(field, ':qwen');
        await tester.pump();
        expect(hints, findsNothing);
        expect(search(tester).isModelMode, isTrue);
        await key(tester, LogicalKeyboardKey.escape);
        await key(
          tester,
          LogicalKeyboardKey.keyP,
          cmd: mac,
          ctrl: !mac,
          shift: true,
        );
        expect(search(tester).isCommandMode, isTrue);
        expect(hints, findsNothing);
        await key(tester, LogicalKeyboardKey.escape);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        keymap.dispose();
      }
    },
    variant: const TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  testWidgets(
    'empty search shows hints in the preview until a result is selected',
    (tester) async {
      final app = await fixture();
      final originalFont = terminalFontStore.value;
      final originalPalette = grid.AppTheme.palette.value;
      final originalTheme = terminalThemeStore.value;
      addTearDown(() {
        terminalFontStore.value = originalFont;
        grid.AppTheme.palette.value = originalPalette;
        terminalThemeStore.value = originalTheme;
      });
      await mount(tester, app);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      final hints = find.byKey(const ValueKey('swarm-search-type-hints'));
      final input = tester.widget<TextField>(field);
      final inputPosition = tester.getTopLeft(field);
      final listPosition = tester.getTopLeft(
        find.byKey(const ValueKey('swarm-search-result-list')),
      );
      const fullHint =
          '   harnesses\n@  machines\n#  projects\n:  models\n*  store\n>  commands';
      expect(tester.widget<Text>(hints).data, fullHint);
      final controller = search(tester);
      expect(controller.selected, isNull);
      expect(controller.rows.any((row) => row.isCreate), isFalse);
      expect(find.text('New Harness'), findsNothing);
      expect(
        tester.getRect(hints).left,
        greaterThanOrEqualTo(
          tester
              .getRect(find.byKey(const ValueKey('swarm-search-result-list')))
              .right,
        ),
      );
      for (final row in controller.rows) {
        final line = find.byKey(ValueKey('swarm-search-line:${row.id}'));
        if (line.evaluate().isNotEmpty) {
          expect(tester.widget<Container>(line).color, Colors.transparent);
        }
      }
      app.machineStates['m']!.agents.add(
        const Agent(
          id: 'late-result',
          name: 'Discovered session',
          terminalAvailable: true,
        ),
      );
      app.notifyListeners();
      await tester.pump();
      expect(controller.selected, isNull);
      await capture(tester, 'empty-type-hints');

      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(controller.selected, controller.rows.first);
      expect(hints, findsNothing);
      await key(tester, LogicalKeyboardKey.tab);
      expect(controller.selected, controller.rows[1]);

      await tester.enterText(field, 'search');
      await tester.pump();
      expect(hints, findsNothing);
      expect(controller.selected!.isCreate, isFalse);
      expect(
        controller.selected,
        controller.rows.firstWhere((row) => !row.isCreate),
      );
      expect(tester.getTopLeft(field), inputPosition);
      expect(
        tester.getTopLeft(
          find.byKey(const ValueKey('swarm-search-result-list')),
        ),
        listPosition,
      );
      expect(
        tester.widget<TextField>(field).controller,
        same(input.controller),
      );
      expect(input.focusNode!.hasFocus, isTrue);
      await capture(tester, 'selected-search');
      await tester.enterText(field, '');
      await tester.pump();
      expect(controller.selected, isNull);
      expect(hints, findsOneWidget);
      await key(tester, LogicalKeyboardKey.arrowUp);
      expect(controller.selected, controller.rows.last);
      for (final prefix in ['@', '#', ':', '*']) {
        await tester.enterText(field, prefix);
        await tester.pump();
        expect(hints, findsNothing);
        expect(controller.selected!.isCreate, isFalse);
        await key(tester, LogicalKeyboardKey.backspace);
        expect(hints, findsOneWidget);
        expect(controller.selected, isNull);
      }

      grid.AppTheme.palette.value = HarnessPalette.slate;
      terminalThemeStore.value = TerminalThemeChoice.tango;
      terminalFontStore.value = const TerminalStyle(
        fontSize: 18,
        fontFamily: 'Menlo',
      );
      tester.view.physicalSize = const Size(480, 600);
      await tester.pumpAndSettle();
      final compact = tester.widget<Text>(hints);
      expect(compact.data, fullHint);
      expect(compact.style!.fontSize, 18);
      expect(
        compact.style!.color,
        terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        ).foreground.withValues(alpha: .54),
      );
      expect(tester.takeException(), isNull);
      await capture(tester, 'narrow-type-hints');
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  for (final native in [false, true]) {
    testWidgets(
      'harness search keeps Cmd-P and leaves commands on Shift-P (native=$native)',
      (tester) async {
        final app = await fixture();
        final keymap = MemoryKeymap();
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(
          configured.nativeChannel,
          (_) async => null,
        );
        addTearDown(
          () => messenger.setMockMethodCallHandler(
            configured.nativeChannel,
            null,
          ),
        );
        Future<void> harnesses() async {
          if (native) {
            final done = configured.native(tester, 'sessions');
            await tester.pump();
            await tester.pump();
            await done;
          } else {
            await key(tester, LogicalKeyboardKey.keyP, cmd: true);
          }
        }

        try {
          await configured.mount(tester, app, keymap, native: native);
          await key(tester, LogicalKeyboardKey.keyO, cmd: true);
          expect(search(tester).scopePrefix, '#');
          await harnesses();
          expect(search(tester).scopePrefix, '');
          expect(search(tester).setupLayout, isTrue);
          expect(search(tester).rows.any((row) => row.agentId != null), isTrue);
          final original = search(tester);
          await tester.enterText(field, 'a69');
          await tester.pump();
          final selected = original.selected?.id;
          await harnesses();
          expect(search(tester), same(original));
          expect(search(tester).query, 'a69');
          expect(search(tester).selected?.id, selected);
          expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
          await key(tester, LogicalKeyboardKey.escape);
          await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
          expect(search(tester).isCommandMode, isTrue);
          await harnesses();
          expect(search(tester).isCommandMode, isFalse);
          expect(search(tester).setupLayout, isTrue);
          expect(search(tester).query, isEmpty);
          await tester.enterText(field, '#');
          await tester.pump();
          final project = search(tester).rows
              .firstWhere((row) => row.isProject);
          search(tester).submit(project);
          await tester.pump();
          expect(search(tester).canGoBack, isTrue);
          await harnesses();
          expect(search(tester).canGoBack, isFalse);
          expect(search(tester).scopePrefix, '');
        } finally {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          keymap.dispose();
        }
      },
      variant: const TargetPlatformVariant({TargetPlatform.macOS}),
    );
  }

  testWidgets('prefix editing preserves the full query and IME composition', (
    tester,
  ) async {
    final app = await fixture();
    final keymap = MemoryKeymap();
    await configured.mount(tester, app, keymap);
    await openHarnessPicker(tester);
    final editor = tester.widget<TextField>(field).controller!;
    final editable = find.descendant(
      of: field,
      matching: find.byType(EditableText),
    );
    final originalEditor = tester.state<EditableTextState>(editable);

    await tester.enterText(field, '#openharness');
    await tester.pump();
    expect(editor.text, '#openharness');
    expect(search(tester).isProjectMode, isTrue);
    editor.selection = const TextSelection(baseOffset: 0, extentOffset: 1);
    await key(tester, LogicalKeyboardKey.backspace);
    expect(editor.text, 'openharness');
    expect(search(tester).query, 'openharness');
    expect(search(tester).scopePrefix, '');

    await tester.enterText(field, '  # openharness');
    await tester.pump();
    expect(editor.text, '  # openharness');
    expect(search(tester).isProjectMode, isTrue);
    await tester.enterText(field, '>');
    await tester.pump();
    expect(search(tester).isCommandMode, isTrue);
    expect(tester.state<EditableTextState>(editable), same(originalEditor));
    await key(tester, LogicalKeyboardKey.backspace);
    expect(editor.text, isEmpty);
    expect(search(tester).isCommandMode, isFalse);
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    expect(tester.state<EditableTextState>(editable), same(originalEditor));

    const composing = TextEditingValue(
      text: '#日本',
      selection: TextSelection.collapsed(offset: 3),
      composing: TextRange(start: 1, end: 3),
    );
    tester.testTextInput.updateEditingValue(composing);
    await tester.pump();
    app.notifyListeners();
    await tester.pump();
    expect(editor.value, composing);
    expect(search(tester).query, '#日本');
    expect(search(tester).isProjectMode, isTrue);
    tester.testTextInput.updateEditingValue(
      composing.copyWith(composing: TextRange.empty),
    );
    await tester.pump();
    expect(editor.text, '#日本');
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    keymap.dispose();
  });

  for (final withKeymap in [false, true]) {
    testWidgets(
      'editable prefixes change scope and backspace returns to harnesses ($withKeymap)',
      (tester) async {
        final app = await fixture();
        if (withKeymap) {
          await configured.mount(tester, app, MemoryKeymap());
        } else {
          await mount(tester, app);
        }
        await openHarnessPicker(tester);
        final reads = app.localReads;
        for (final (prefix, label) in [
          ('@', 'New Machine'),
          (':', 'New Model'),
        ]) {
          await tester.enterText(field, prefix);
          await tester.pump();
          expect(search(tester).rows.first.title, label);
          expect(search(tester).selected!.isCreate, isFalse);
          expect(tester.widget<TextField>(field).controller!.text, prefix);
          await tester.enterText(field, '${prefix}missing');
          expect(search(tester).scopePrefix, prefix);
          await tester.enterText(field, prefix);
          await key(tester, LogicalKeyboardKey.backspace);
          expect(search(tester).scopePrefix, '');
        }
        await tester.enterText(field, '#');
        await tester.pump();
        expect(search(tester).rows.any((row) => row.isCreate), isFalse);
        await tester.enterText(field, '#missing-project');
        await tester.pump();
        expect(search(tester).rows, isEmpty);
        expect(search(tester).canAccept, isFalse);
        await tester.enterText(field, '*blender');
        await tester.pump();
        expect(search(tester).selected!.storeId, 'blender');
        expect(tester.widget<TextField>(field).controller!.text, '*blender');
        expect(find.byKey(const ValueKey('search-action-list')), findsNothing);
        expect(
          app.localReads,
          reads,
          reason: 'Typing filters the cached inventory',
        );
        expect(app.actions, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );

    testWidgets('named model actions return to the same query ($withKeymap)', (
      tester,
    ) async {
      final app = await fixture();
      if (withKeymap) {
        await configured.mount(tester, app, MemoryKeymap());
      } else {
        await mount(tester, app);
      }
      await openHarnessPicker(tester);
      await tester.enterText(field, ':qwen');
      await tester.pump();
      final controller = search(tester);
      final index = controller.rows.indexWhere(
        (row) => row.modelId == 'model:local:qwen',
      );
      controller.move(index - controller.cursor);
      await tester.pump();
      expect(app.actions, isEmpty);
      expect(find.text('ctrl-S'), findsNothing);
      expect(find.byKey(const ValueKey('picker-keyboard-hints')), findsNothing);
      await tester.pumpAndSettle();
      await capture(tester, 'model-actions');
      await key(tester, LogicalKeyboardKey.slash, ctrl: true);
      expect(controller.hasPreview, isFalse);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      final commandField = find.byKey(const ValueKey('resource-command-input'));
      await tester.enterText(commandField, 'download');
      await tester.pump();
      expect(find.textContaining('Download and start “'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(app.actions, [(machine: 'm', model: 'qwen', start: true)]);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(controller.isModelMode, isTrue);
      await key(tester, LogicalKeyboardKey.escape);
      expect(field, findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }

  testWidgets(
    'resource previews scroll by line and empty searches stay inert',
    (tester) async {
      final app = await fixture();
      app.machineStates['m']!.dsh.replace([
        DshEntry(
          id: 'blender',
          name: 'Blender',
          engine: 'codex',
          description: List.generate(
            90,
            (i) => 'Product description line $i.',
          ).join('\n'),
        ),
      ]);
      app.modelManager.apis.connections = [
        ApiConnection({
          'id': 'deepseek-api',
          'provider': 'custom',
          'name': 'DeepSeek API',
          'baseUrl':
              'https://example.test/${List.filled(500, 'endpoint/').join()}',
          'keyEnv': 'TEST_API_KEY',
        }),
      ];
      final originalFont = terminalFontStore.value;
      addTearDown(() => terminalFontStore.value = originalFont);
      await configured.mount(tester, app, MemoryKeymap());
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      final controller = search(tester);
      ScrollPosition position() => tester
          .widget<ListView>(
            find.descendant(
              of: find.byType(SwarmResourcePreview),
              matching: find.byType(ListView),
            ),
          )
          .controller!
          .position;
      for (final query in ['*blender', ':deepseek']) {
        await tester.enterText(field, query);
        await tester.pumpAndSettle();
        final selected = controller.selected!.id;
        expect(position().pixels, 0);
        expect(position().maxScrollExtent, greaterThan(0));
        final editing = tester.widget<TextField>(field).controller!.value;
        await key(tester, LogicalKeyboardKey.arrowDown, shift: true);
        expect(
          position().pixels,
          closeTo(terminalCellSizeOf(tester.element(field)).height, .01),
        );
        await key(tester, LogicalKeyboardKey.arrowUp, shift: true);
        await key(tester, LogicalKeyboardKey.arrowUp, shift: true);
        expect(position().pixels, 0);
        terminalFontStore.value = const TerminalStyle(
          fontSize: 20,
          fontFamily: 'Menlo',
          height: 1.5,
        );
        await tester.pumpAndSettle();
        await key(tester, LogicalKeyboardKey.arrowDown, shift: true);
        expect(
          position().pixels,
          closeTo(terminalCellSizeOf(tester.element(field)).height, .01),
        );
        controller.scrollPreview(10000);
        await tester.pumpAndSettle();
        expect(position().pixels, position().maxScrollExtent);
        await key(tester, LogicalKeyboardKey.arrowDown, shift: true);
        expect(position().pixels, position().maxScrollExtent);
        expect(controller.selected!.id, selected);
        expect(tester.widget<TextField>(field).controller!.value, editing);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      }
      await tester.enterText(field, '*no-such-product');
      await tester.pumpAndSettle();
      expect(controller.rows, isEmpty);
      expect(controller.selected, isNull);
      for (final button in [
        LogicalKeyboardKey.arrowUp,
        LogicalKeyboardKey.arrowDown,
        LogicalKeyboardKey.pageUp,
        LogicalKeyboardKey.pageDown,
        LogicalKeyboardKey.enter,
      ]) {
        await key(tester, button);
      }
      await key(tester, LogicalKeyboardKey.arrowDown, shift: true);
      expect(controller.selected, isNull);
      expect(field, findsOneWidget);
      expect(app.actions, isEmpty);
      // A pending scroll cannot act on a later selection or a disposed view.
      controller.setQuery('*blender');
      controller.scrollPreview(1);
      controller.setQuery('');
      await tester.pump();
      expect(controller.selected, isNull);
      expect(
        find.byKey(const ValueKey('swarm-search-type-hints')),
        findsOneWidget,
      );
      controller.setQuery('*blender');
      controller.scrollPreview(1);
      await tester.pumpWidget(const SizedBox());
      expect(tester.takeException(), isNull);
      app.dispose();
    },
  );

  testWidgets(
    'machine Enter always opens its sessions, even before connection',
    (tester) async {
      final app = await fixture();
      await configured.mount(tester, app, MemoryKeymap());
      await openHarnessPicker(tester);
      for (final online in [false, true]) {
        app.stateOf('m')!
          ..nodeOnline = online
          ..needsLink = true;
        app.notifyListeners();
        await tester.enterText(field, '@');
        await tester.pump();
        final origin = search(tester);
        origin.move(
          origin.rows.indexWhere((row) => row.id == 'machine:m') -
              origin.cursor,
        );
        await tester.pump();
        final inputPosition = tester.getTopLeft(field);
        await key(tester, LogicalKeyboardKey.enter);
        expect(search(tester), same(origin));
        expect(origin.canGoBack, isTrue);
        expect(origin.scopedMachineId, 'm');
        expect(tester.getTopLeft(field), inputPosition);
        expect(find.text(origin.title), findsNothing);
        expect(find.byType(TextField), findsOneWidget);
        expect(app.actions, isEmpty);
        await capture(tester, 'machine-sessions');
        await key(tester, LogicalKeyboardKey.escape);
        expect(origin.isMachineMode, isTrue);
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'action cancellation preserves search and stale targets cannot run',
    (tester) async {
      final app = await fixture();
      final keymap = MemoryKeymap();
      await configured.mount(tester, app, keymap);
      final mac = defaultTargetPlatform == TargetPlatform.macOS;
      await openHarnessPicker(tester);
      await tester.enterText(field, ':qwen');
      await tester.pump();
      final origin = search(tester);
      origin.move(
        origin.rows.indexWhere((row) => row.modelId == 'model:local:qwen') -
            origin.cursor,
      );
      await tester.pump();
      final selected = origin.selected!.id;
      final query = origin.query;
      await key(
        tester,
        LogicalKeyboardKey.keyP,
        cmd: mac,
        ctrl: !mac,
        shift: true,
      );
      final commands = find.byKey(const ValueKey('resource-command-input'));
      await tester.enterText(commands, 'download');
      await tester.pump();
      expect(search(tester).rows, hasLength(1));
      await key(tester, LogicalKeyboardKey.escape);
      expect(origin.selected!.id, selected);
      expect(origin.query, query);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(app.actions, isEmpty);
      await key(
        tester,
        LogicalKeyboardKey.keyP,
        cmd: mac,
        ctrl: !mac,
        shift: true,
      );
      await tester.enterText(commands, 'download');
      await tester.pump();
      origin.move(1);
      await tester.pump();
      expect(search(tester).rows, isEmpty);
      await key(tester, LogicalKeyboardKey.enter);
      expect(app.actions, isEmpty);
      await key(tester, LogicalKeyboardKey.escape);
      expect(field, findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      keymap.dispose();
    },
    variant: const TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  testWidgets('machine setup and API editor return to the same picker', (
    tester,
  ) async {
    final app = await fixture();
    await configured.mount(tester, app, MemoryKeymap());
    await openHarnessPicker(tester);
    await tester.enterText(field, '@');
    await tester.pump();
    await key(tester, LogicalKeyboardKey.arrowUp);
    await key(tester, LogicalKeyboardKey.enter);
    expect(find.text('Link another machine'), findsWidgets);
    await key(tester, LogicalKeyboardKey.escape);
    expect(search(tester).isMachineMode, isTrue);
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    await tester.enterText(field, ':deepseek');
    await tester.pump();
    final controller = search(tester);
    controller.move(
      controller.rows.indexWhere((row) => row.isModel) - controller.cursor,
    );
    await tester.pump();
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.byType(ApiConnectionsPanel), findsOneWidget);
    expect(find.text('https://api.deepseek.com'), findsWidgets);
    Navigator.of(tester.element(find.byType(ApiConnectionsPanel))).pop();
    await tester.pumpAndSettle();
    expect(search(tester).selected!.modelId, 'model:api:deepseek-api');
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'resource previews and commands preserve state through live appearance changes',
    (tester) async {
      final originalPalette = grid.AppTheme.palette.value;
      final originalTheme = terminalThemeStore.value;
      final originalFont = terminalFontStore.value;
      addTearDown(() {
        grid.AppTheme.palette.value = originalPalette;
        terminalThemeStore.value = originalTheme;
        terminalFontStore.value = originalFont;
      });
      final app = await fixture();
      await mount(tester, app);
      await openHarnessPicker(tester);
      await tester.enterText(field, ':qwen');
      await tester.pump();
      final controller = search(tester);
      controller.move(
        controller.rows.indexWhere((row) => row.modelId == 'model:local:qwen') -
            controller.cursor,
      );
      await tester.pumpAndSettle();
      final selected = controller.selected!.id;
      final editor = tester.widget<TextField>(field).controller!;
      final editing = editor.value;

      grid.AppTheme.palette.value = HarnessPalette.slate;
      terminalThemeStore.value = TerminalThemeChoice.tango;
      terminalFontStore.value = const TerminalStyle(
        fontSize: 18,
        fontFamily: 'Menlo',
        fontFamilyFallback: ['monospace'],
        height: 1.4,
      );
      await tester.pumpAndSettle();
      final theme = terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      );
      final previewText = tester.widgetList<Text>(
        find.descendant(
          of: find.byType(SwarmResourcePreview),
          matching: find.byType(Text),
        ),
      );
      expect(previewText, isNotEmpty);
      for (final text in previewText) {
        expect(text.style!.fontSize, 18);
        expect(text.style!.height, 1.4);
        expect(
          text.style!.color,
          isIn([theme.foreground, theme.foreground.withValues(alpha: .54)]),
        );
      }
      expect(controller.selected!.id, selected);
      expect(tester.widget<TextField>(field).controller, same(editor));
      expect(editor.value, editing);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      await capture(tester, 'models-tango-large');

      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      final commandField = find.byKey(const ValueKey('resource-command-input'));
      await tester.enterText(commandField, 'start');
      await tester.pumpAndSettle();
      final commandSearch = search(tester);
      final commandId = commandSearch.selected!.id;
      final commandEditor = tester.widget<TextField>(commandField).controller!;
      terminalThemeStore.value = TerminalThemeChoice.matchApp;
      grid.AppTheme.palette.value = HarnessPalette.midnight;
      terminalFontStore.value = originalFont;
      await tester.pumpAndSettle();
      final commandTheme = terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      );
      final line = find.byKey(ValueKey('swarm-search-line:$commandId'));
      final cell = terminalCellSizeOf(tester.element(commandField));
      expect(tester.getSize(line).height, closeTo(cell.height, .01));
      expect(tester.widget<Container>(line).color, commandTheme.selection);
      expect(
        tester
            .widget<Dialog>(
              find.byKey(const ValueKey('resource-command-picker')),
            )
            .backgroundColor,
        commandTheme.background,
      );
      expect(commandSearch.selected!.id, commandId);
      expect(
        tester.widget<TextField>(commandField).controller,
        same(commandEditor),
      );
      expect(commandEditor.text, 'start');
      expect(
        tester.widget<TextField>(commandField).focusNode!.hasFocus,
        isTrue,
      );
      await capture(tester, 'commands-midnight');
      tester.view.physicalSize = const Size(400, 600);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await capture(tester, 'commands-narrow');
      await key(tester, LogicalKeyboardKey.escape);
      expect(controller.selected!.id, selected);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(app.actions, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('live store inventory updates and every resource renders', (
    tester,
  ) async {
    final originalFont = terminalFontStore.value;
    final originalTheme = terminalThemeStore.value;
    addTearDown(() {
      terminalFontStore.value = originalFont;
      terminalThemeStore.value = originalTheme;
    });
    final app = await fixture();
    await mount(tester, app);
    await openHarnessPicker(tester);
    for (final narrow in [false, true]) {
      if (narrow) {
        tester.view.physicalSize = const Size(480, 600);
        terminalFontStore.value = const TerminalStyle(
          fontSize: 18,
          fontFamily: 'Menlo',
          height: 1.4,
        );
        terminalThemeStore.value = TerminalThemeChoice.tango;
      }
      for (final (query, kind) in [
        ('Checkout', 'harnesses'),
        ('@', 'machines'),
        ('#', 'projects'),
        (':', 'models'),
        (':deepseek', 'api'),
        ('*', 'store'),
      ]) {
        await tester.enterText(field, query);
        await tester.pump();
        final controller = search(tester);
        final index = controller.rows.indexWhere(
          (row) => switch (kind) {
            'machines' => row.id == 'machine:m',
            'models' => row.modelId == 'model:local:qwen',
            _ => !row.isCreate,
          },
        );
        controller.move(index - controller.cursor);
        await tester.pump(const Duration(milliseconds: 200));
        final preview = find.byType(SwarmResourcePreview);
        expect(preview, findsOneWidget);
        expect(
          find.descendant(
            of: preview,
            matching: find.text(controller.selected!.title),
          ),
          findsWidgets,
        );
        final cell = terminalCellSizeOf(tester.element(field));
        final visibleRows = [
          for (final row in controller.rows)
            if (find.byKey(ValueKey(row.id)).evaluate().isNotEmpty) row,
        ];
        for (final row in visibleRows) {
          final result = find.byKey(ValueKey(row.id));
          expect(tester.getSize(result).height, closeTo(cell.height, .01));
          expect(
            tester
                .widgetList<SearchResultText>(
                  find.descendant(
                    of: result,
                    matching: find.byType(SearchResultText),
                  ),
                )
                .map((text) => text.text),
            row.isCreate ? isEmpty : [row.title],
          );
        }
        for (var i = 1; i < visibleRows.length; i++) {
          expect(
            tester.getTopLeft(find.byKey(ValueKey(visibleRows[i].id))).dy -
                tester
                    .getTopLeft(find.byKey(ValueKey(visibleRows[i - 1].id)))
                    .dy,
            closeTo(cell.height, .01),
          );
        }
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        expect(tester.takeException(), isNull);
        await capture(tester, '$kind-single-line${narrow ? '-narrow' : ''}');
        final createIndex = controller.rows.indexWhere((row) => row.isCreate);
        if (createIndex >= 0) {
          controller.move(createIndex - controller.cursor);
          await tester.pump();
          expect(
            find.descendant(
              of: preview,
              matching: find.text(controller.createDescription),
            ),
            findsOneWidget,
          );
        }
      }
    }
    app.machineStates['m']!.dsh.replace(const [
      DshEntry(id: 'excalidraw', name: 'Excalidraw', engine: 'codex'),
    ]);
    app.notifyListeners();
    await tester.pump();
    expect(search(tester).rows.single.storeId, 'excalidraw');
    for (final size in [const Size(760, 650), const Size(400, 600)]) {
      tester.view.physicalSize = size;
      await tester.enterText(field, ':qwen');
      await tester.pump();
      search(tester).move(1);
      await tester.pump();
      expect(find.byKey(const ValueKey('search-action-list')), findsNothing);
      expect(tester.takeException(), isNull);
    }
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'a single-session group keeps its name and count in the preview',
    (tester) async {
      final app = await fixture();
      final machine = app.machineStates['other']!;
      machine.agents = [app.machineStates['m']!.agents.first];
      await mount(tester, app);
      await openHarnessPicker(tester);
      for (final (query, name) in [
        ('@Other computer', 'Other computer'),
        ('#storefront', 'storefront'),
      ]) {
        // The project is only present on one machine in this case.
        if (query.startsWith('#')) {
          machine.agents = [];
          app.notifyListeners();
        }
        await tester.enterText(field, query);
        await tester.pumpAndSettle();
        final selected = search(tester).selected!;
        expect(selected.members, hasLength(1));
        final preview = find.byType(SwarmResourcePreview);
        expect(
          find.descendant(of: preview, matching: find.text(name)),
          findsOneWidget,
        );
        expect(
          find.descendant(of: preview, matching: find.text(selected.detail)),
          findsOneWidget,
        );
        expect(
          find.descendant(of: preview, matching: find.text('Checkout retries')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
