import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/desktop_search_panel.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/ws/ws_conn.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show createApp;

class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final requests = <(String, Map<String, dynamic>)>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add((type, payload));
    if (type == 'engines_probe') {
      return {
        'engines': [
          {'engine': 'codex', 'installed': true},
          {'engine': 'claude', 'installed': true},
        ],
      };
    }
    if (type == 'git_project_info') {
      return {
        'isGit': true,
        'branch': 'main',
        'branches': [
          {'ref': 'refs/heads/main', 'name': 'main'},
          {'ref': 'refs/heads/feature', 'name': 'feature'},
        ],
      };
    }
    if (type == 'fs_list_dir') return {'path': '/work', 'entries': []};
    if (type == 'agent_create') {
      return {
        'creationId': payload['creationId'],
        'state': 'failed',
        'error': 'Fixture stops at the launch boundary',
      };
    }
    return {};
  }
}

void main() {
  final renderDir = Platform.environment['FRIENDLY_UI_RENDER_DIR'];
  setUpAll(() async {
    if (renderDir != null) await loadPreviewFonts();
  });
  final picture = GlobalKey();

  AppNotifier fixture(_Daemon daemon) {
    final app = createApp(connectionForTest: (_) => daemon);
    seedMixedAgents(app);
    app.machineStates['m']!.engines.replace(const [
      EngineAvailability(engine: 'codex', installed: true),
      EngineAvailability(engine: 'claude', installed: true),
    ]);
    addTearDown(app.dispose);
    return app;
  }

  Future<void> host(
    WidgetTester tester,
    Widget child,
    MemoryKeymap map, {
    Size size = const Size(1200, 800),
    Brightness brightness = Brightness.dark,
    double scale = 1,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final oldBrightness = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: KeymapProvider(
          keymap: map,
          child: KeymapHost(
            keymap: map,
            enabled: () => true,
            actions: const {},
            child: RepaintBoundary(
              key: picture,
              child: Scaffold(
                backgroundColor: grid.AppPalette.windowBg,
                body: Padding(padding: const EdgeInsets.all(24), child: child),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> capture(WidgetTester tester, String name) async {
    if (renderDir == null) return;
    await tester.runAsync(() async {
      final boundary =
          picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1.5);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      final directory = Directory(renderDir)..createSync(recursive: true);
      await File('${directory.path}/$name.png')
          .writeAsBytes(data!.buffer.asUint8List());
      image.dispose();
    });
  }

  Future<(NewHarnessController, _Daemon, MemoryKeymap)> composer(
    WidgetTester tester, {
    Size size = const Size(1200, 800),
    Brightness brightness = Brightness.dark,
    double scale = 1,
    VoidCallback? close,
  }) async {
    final daemon = _Daemon();
    final app = fixture(daemon);
    final controller = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/openharness',
    );
    final map = MemoryKeymap();
    addTearDown(controller.dispose);
    addTearDown(map.dispose);
    await host(
      tester,
      NewHarnessForm(
        controller: controller,
        desktop: true,
        onClose: close ?? () {},
        onCreated: () {},
      ),
      map,
      size: size,
      brightness: brightness,
      scale: scale,
    );
    return (controller, daemon, map);
  }

  testWidgets('task survives project and agent choices without launching', (
    tester,
  ) async {
    final (box, daemon, _) = await composer(tester);
    const task =
        'Make keyboard navigation feel natural.\nKeep the terminal fast.';
    final field = find.byKey(const ValueKey('new-harness-task'));
    await tester.enterText(field, task);
    await tester.pump();
    await capture(tester, 'new-harness-dark');
    await tester.tap(find.byKey(const ValueKey('new-harness-field-project')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('new-harness-query')),
      'robotics',
    );
    await tester.pumpAndSettle();
    expect(box.task, task);
    await capture(tester, 'new-harness-project-chooser');
    await key(tester, LogicalKeyboardKey.escape);
    expect(tester.widget<TextField>(field).controller!.text, task);
    await tester.tap(find.byKey(const ValueKey('new-harness-field-agent')));
    await tester.pumpAndSettle();
    await capture(tester, 'new-harness-agent-chooser');
    await tester.tap(find.byKey(const ValueKey('new-harness-option-claude')));
    await tester.pumpAndSettle();
    expect(box.engine, 'claude');
    expect(box.task, task);
    expect(
      daemon.requests.where((request) => request.$1 == 'agent_create'),
      isEmpty,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Shift-Enter edits, remapped start submits once, IME never submits',
    (tester) async {
      final (box, daemon, map) = await composer(tester);
      final field = find.byKey(const ValueKey('new-harness-task'));
      await tester.enterText(field, 'Review the release');
      await key(tester, LogicalKeyboardKey.enter, shift: true);
      expect(
        daemon.requests.where((request) => request.$1 == 'agent_create'),
        isEmpty,
      );
      final editor = tester.widget<TextField>(field).controller!;
      editor.value = const TextEditingValue(
        text: '日本語',
        composing: TextRange(start: 0, end: 3),
        selection: TextSelection.collapsed(offset: 3),
      );
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      expect(
        daemon.requests.where((request) => request.$1 == 'agent_create'),
        isEmpty,
      );
      editor.value = const TextEditingValue(
        text: 'Review the release',
        selection: TextSelection.collapsed(offset: 18),
      );
      box.setTask(editor.text);
      map.apply(
        '{"bindings":[{"keys":"cmd+shift+enter","command":"picker.add_here","when":"picker"},{"keys":"cmd+enter","command":null,"when":"picker"}]}',
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      expect(
        daemon.requests.where((request) => request.$1 == 'agent_create'),
        isEmpty,
      );
      expect(box.requiredChoice, isNull);
      await key(tester, LogicalKeyboardKey.enter, cmd: true, shift: true);
      await tester.pumpAndSettle();
      expect(
        daemon.requests.where((request) => request.$1 == 'agent_create'),
        hasLength(1),
      );
    },
  );

  testWidgets('default Cmd-Enter sends the task and selected configuration', (
    tester,
  ) async {
    final (box, daemon, _) = await composer(tester);
    await tester.enterText(
      find.byKey(const ValueKey('new-harness-task')),
      'Review the release',
    );
    await key(tester, LogicalKeyboardKey.enter, cmd: true);
    await tester.pumpAndSettle();
    final starts = daemon.requests.where(
      (request) => request.$1 == 'agent_create',
    );
    expect(starts, hasLength(1));
    expect(starts.single.$2['prompt'], 'Review the release');
    expect(starts.single.$2['engine'], 'codex');
    expect(box.busy, isFalse);
    expect(box.task, 'Review the release');
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'composer and chooser fit narrow ${brightness.name} with enlarged text',
      (tester) async {
        final (box, _, _) = await composer(
          tester,
          size: const Size(470, 820),
          brightness: brightness,
          scale: 1.5,
        );
        const task =
            'A long project brief that stays editable when the window is narrow.';
        await tester.enterText(
          find.byKey(const ValueKey('new-harness-task')),
          task,
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await capture(tester, 'new-harness-narrow-${brightness.name}');
        await tester.ensureVisible(
          find.byKey(const ValueKey('new-harness-field-project')),
        );
        await tester.tap(
          find.byKey(const ValueKey('new-harness-field-project')),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await capture(tester, 'new-harness-chooser-narrow-${brightness.name}');
        await key(tester, LogicalKeyboardKey.escape);
        expect(box.task, task);
      },
    );
  }

  testWidgets(
    'palette filters keep query, arrows select, Enter opens exactly once',
    (tester) async {
      final app = fixture(_Daemon());
      final search = SwarmSearchController(
        app,
        [],
        adding: true,
        activityFirst: true,
        selectOnEmptyQuery: false,
        offersHarnessCreate: false,
      );
      final editing = TextEditingController();
      final focus = FocusNode();
      final map = MemoryKeymap();
      final chosen = <SwarmSearchSelection>[];
      void sync() {
        if (editing.text != search.query) {
          editing.value = TextEditingValue(
            text: search.query,
            selection: TextSelection.collapsed(offset: search.query.length),
          );
        }
      }

      search.addListener(sync);
      addTearDown(search.dispose);
      addTearDown(editing.dispose);
      addTearDown(focus.dispose);
      addTearDown(map.dispose);
      await host(
        tester,
        Center(
          child: SizedBox(
            width: 960,
            height: 570,
            child: SwarmSearchKeys(
              search: search,
              editing: editing,
              onChoose: chosen.add,
              onClose: () {},
              onRefocus: focus.requestFocus,
              child: DesktopSearchPanel(
                search: search,
                editing: editing,
                focusNode: focus,
                onChoose: chosen.add,
                onClose: () {},
                onRefocus: focus.requestFocus,
                previewBuilder: () => const Text('Resource details'),
              ),
            ),
          ),
        ),
        map,
      );
      final input = find.byKey(const ValueKey('swarm-search-input'));
      expect(search.showsTypeHints, isTrue);
      expect(find.text('Resource details'), findsNothing);
      await tester.enterText(input, 'login');
      await tester.pumpAndSettle();
      expect(find.text('Resource details'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('search-toggle-preview')));
      await tester.pumpAndSettle();
      expect(search.previewVisible, isFalse);
      await capture(tester, 'command-palette-dark');
      await tester.tap(find.byKey(const ValueKey('search-category-Projects')));
      await tester.pumpAndSettle();
      expect(search.isProjectMode, isTrue);
      expect(editing.text, '# login');
      expect(chosen, isEmpty);
      await tester.tap(find.byKey(const ValueKey('search-category-Harnesses')));
      await tester.pumpAndSettle();
      expect(editing.text, 'login');
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(search.selected, isNotNull);
      await key(tester, LogicalKeyboardKey.enter);
      expect(chosen, hasLength(1));
      // The pointer's tooltip exit delay is unrelated to search completion.
      await tester.pump(const Duration(milliseconds: 350));
      expect(tester.takeException(), isNull);
    },
  );
}
