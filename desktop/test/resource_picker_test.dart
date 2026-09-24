import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/models/api_connections_controller.dart';
import 'package:harness/models/api_connections_panel.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';
import 'package:harness/widgets/swarm_search_input.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'support/model_manager.dart';
import 'support/real_fonts.dart';
import 'swarm_interactions_test.dart' show chord;
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
        await key(tester, LogicalKeyboardKey.keyP, cmd: mac, ctrl: !mac);
        expect(field, findsOneWidget);
        final hints = find.byKey(const ValueKey('swarm-search-type-hints'));
        expect(hints, findsOneWidget);
        expect(search(tester).isCommandMode, isFalse);
        await tester.enterText(field, ':qwen');
        await tester.pump();
        expect(hints, findsNothing);
        expect(search(tester).isModelMode, isTrue);
        await key(tester, LogicalKeyboardKey.escape);
        expect(field, findsNothing);
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
        await key(tester, LogicalKeyboardKey.keyO, cmd: mac, ctrl: !mac);
        expect(field, findsNothing);
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

  testWidgets('type hints keep the input and results fixed while typing', (
    tester,
  ) async {
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
    await chord(tester, LogicalKeyboardKey.keyP);
    final hints = find.byKey(const ValueKey('swarm-search-type-hints'));
    final input = tester.widget<TextField>(field);
    final inputPosition = tester.getTopLeft(field);
    final createPosition = tester.getTopLeft(find.text('New Harness'));
    const fullHint =
        '> harnesses   @ machines   # projects   : models   * store';
    expect(tester.widget<Text>(hints).data, fullHint);
    expect(tester.getTopLeft(hints).dx, closeTo(inputPosition.dx, .01));
    expect(
      tester.getTopLeft(hints).dy - inputPosition.dy,
      closeTo(terminalCellSizeOf(tester.element(field)).height, 1),
      reason: 'The hint sits one terminal row below the input.',
    );
    await capture(tester, 'empty-type-hints');

    await tester.enterText(field, 'search');
    await tester.pump();
    expect(hints, findsNothing);
    expect(tester.getTopLeft(field), inputPosition);
    expect(tester.getTopLeft(find.text('New Harness')), createPosition);
    expect(tester.widget<TextField>(field).controller, same(input.controller));
    expect(input.focusNode!.hasFocus, isTrue);
    for (final prefix in ['@', '#', ':', '*']) {
      await tester.enterText(field, prefix);
      await tester.pump();
      expect(hints, findsNothing);
      await key(tester, LogicalKeyboardKey.backspace);
      expect(hints, findsOneWidget);
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
    expect(compact.data, '>   @   #   :   *');
    expect(compact.semanticsLabel, fullHint);
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
  });

  for (final withKeymap in [false, true]) {
    testWidgets(
      'prefix changes prompt and creation without leaking into query ($withKeymap)',
      (tester) async {
        final app = await fixture();
        if (withKeymap) {
          await configured.mount(tester, app, MemoryKeymap());
        } else {
          await mount(tester, app);
        }
        await chord(tester, LogicalKeyboardKey.keyP);
        final reads = app.localReads;
        for (final (prefix, label) in [
          ('@', 'New Machine'),
          ('#', 'New Project'),
          (':', 'New Model'),
        ]) {
          await tester.enterText(field, prefix);
          await tester.pump();
          expect(search(tester).selected!.title, label);
          expect(
            tester
                .widget<SwarmSearchInput>(find.byType(SwarmSearchInput))
                .prompt,
            prefix,
          );
          expect(tester.widget<TextField>(field).controller!.text, '');
          await tester.enterText(field, 'missing');
          expect(search(tester).scopePrefix, prefix);
          await tester.enterText(field, '');
          await key(tester, LogicalKeyboardKey.backspace);
          expect(search(tester).scopePrefix, '');
        }
        await tester.enterText(field, '*blender');
        await tester.pump();
        expect(search(tester).selected!.storeId, 'blender');
        expect(tester.widget<TextField>(field).controller!.text, 'blender');
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
      await chord(tester, LogicalKeyboardKey.keyP);
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
    'machine Enter always opens its sessions, even before connection',
    (tester) async {
      final app = await fixture();
      await configured.mount(tester, app, MemoryKeymap());
      await chord(tester, LogicalKeyboardKey.keyP);
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
        await key(tester, LogicalKeyboardKey.enter);
        expect(search(tester), same(origin));
        expect(origin.canGoBack, isTrue);
        expect(origin.scopedMachineId, 'm');
        expect(find.byType(TextField), findsOneWidget);
        expect(app.actions, isEmpty);
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
      await key(tester, LogicalKeyboardKey.keyP, cmd: mac, ctrl: !mac);
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
    await chord(tester, LogicalKeyboardKey.keyP);
    await tester.enterText(field, '@');
    await tester.pump();
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
      await chord(tester, LogicalKeyboardKey.keyP);
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
    final app = await fixture();
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyP);
    for (final (query, kind) in [
      ('Checkout', 'harnesses'),
      ('@', 'machines'),
      ('#', 'projects'),
      (':', 'models'),
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
      expect(find.byType(SwarmResourcePreview), findsOneWidget);
      expect(tester.takeException(), isNull);
      await capture(tester, kind);
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
}
