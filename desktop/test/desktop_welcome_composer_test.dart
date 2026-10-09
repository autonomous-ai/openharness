import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/prompt_style.dart';
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/widgets/status_line.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/harness_customize_pane.dart';
import 'package:harness/shared/widgets/app_dialog.dart';
import 'package:harness/ws/ws_conn.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' show mount, native, nativeChannel;
import 'support/mixed_agents.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show MemoryStore, createApp;

class _DelayedPreferences extends MemoryStore {
  final loaded = Completer<String?>();

  @override
  Future<String?> read(String key) =>
      key == 'new_agent_engine' ? loaded.future : super.read(key);
}

class _Connection extends WsConn {
  _Connection(String machine)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machine,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final starts = <Map<String, dynamic>>[];
  final sessions = <Map<String, dynamic>>[];
  Completer<Map<String, dynamic>>? pending;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => switch (type) {
    'engines_probe' => {
      'engines': [
        {'engine': 'codex', 'installed': true},
        {'engine': 'claude', 'installed': true},
      ],
    },
    'dsh_list' => {'dsh': []},
    'session_search' => {
      'hits': sessions,
      'indexed': sessions.length,
      'pending': 0,
    },
    'fs_list_dir' => {'path': payload['path'] ?? '/work', 'entries': []},
    'agent_create' => _create(payload),
    _ => {},
  };
  Future<Map<String, dynamic>> _create(Map<String, dynamic> payload) {
    starts.add(Map.of(payload));
    pending = Completer<Map<String, dynamic>>();
    return pending!.future;
  }

  void complete() => pending!.complete({
    'creationId': starts.last['creationId'],
    'state': 'created',
    'agent': {
      'id': 'created',
      'name': 'Created harness',
      'engine': 'codex',
      'project': {'cwd': '/work/openharness'},
    },
  });
}

void main() {
  late AppNotifier app;
  late MemoryKeymap map;
  late _Connection connection;
  final updates = <Map<dynamic, dynamic>>[];
  final picture = GlobalKey();
  setUpAll(loadPreviewFonts);
  final form = find.byType(NewHarnessForm);
  final task = find.byKey(const ValueKey('new-harness-task'));
  NewHarnessController box(WidgetTester tester) =>
      tester.widget<NewHarnessForm>(form).controller;

  Future<void> capture(WidgetTester tester, String name) async {
    final directory = Platform.environment['WELCOME_COMPOSER_RENDER_DIR'];
    if (directory == null) return;
    await tester.runAsync(() async {
      final boundary =
          picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage();
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(directory).create(recursive: true);
      await File('$directory/$name.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  Future<void> setup(
    WidgetTester tester, {
    bool withPane = false,
    bool mac = false,
    MemoryStore? storage,
  }) async {
    final old = newHarnessOpensInBox;
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = old);
    connection = _Connection('m');
    final connections = {'m': connection};
    app = createApp(
      store: storage,
      connectionForTest: (id) =>
          connections.putIfAbsent(id, () => _Connection(id)),
    );
    map = MemoryKeymap();
    seedMixedAgents(app);
    app.machineStates['m']!.localOnly = true;
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    if (storage is! _DelayedPreferences) {
      await app.agentPreference.remember('codex');
    }
    await app.projectHistory.select('m', '/work/openharness');
    if (withPane) app.adoptSessionForTest(terminal('a0', []));
    if (mac) {
      updates.clear();
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        nativeChannel,
        (call) async {
          if (call.method == 'update') updates.add(call.arguments as Map);
          return null;
        },
      );
    }
    await mount(tester, app, map, native: mac);
    await tester.pumpAndSettle();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      map.dispose();
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        nativeChannel,
        null,
      );
    });
  }

  testWidgets(
    'empty tab embeds the shared composer and typing keeps its numbers',
    (tester) async {
      await setup(tester);
      expect(tester.widget<NewHarnessForm>(form).embedded, isTrue);
      expect(find.byKey(const ValueKey('welcome-sessions')), findsNothing);
      // An empty tab still exposes live sessions running elsewhere in the account.
      expect(
        find.byKey(const ValueKey('workspace-harness-monitor')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('new-harness-close')), findsNothing);
      expect(find.byKey(const ValueKey('new-harness-dismiss')), findsNothing);
      expect(tester.widget<TextField>(task).focusNode!.hasFocus, isTrue);
      final original = box(tester);
      await tester.enterText(task, '123 work on this');
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      await tester.pumpAndSettle();
      expect(box(tester), same(original));
      expect(box(tester).task, '123 work on this');
      expect(connection.starts, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.tapAt(const Offset(50, 180));
      await tester.pumpAndSettle();
      expect(form, findsOneWidget);
      expect(box(tester).task, '123 work on this');
    },
  );

  testWidgets('Cmd-P round trip opens a fresh form with successful defaults', (
    tester,
  ) async {
    await setup(tester);
    await tester.enterText(task, 'Keep my page draft');
    box(tester).setFolder('/work/selected');
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    await tester.pumpAndSettle();
    expect(form, findsNothing);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      'different search',
    );
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    await tester.pumpAndSettle();
    expect(box(tester).task, isEmpty);
    expect(box(tester).projectFolderRequest!.isGenerated, isTrue);
    expect(app.projectHistory.selected('m'), '/work/openharness');
    expect(tester.widget<TextField>(task).focusNode!.hasFocus, isTrue);
    expect(connection.starts, isEmpty);
  });

  testWidgets('switching new tabs discards ordinary edits without starting', (
    tester,
  ) async {
    await setup(tester);
    final first = app.activeSwarmId;
    await tester.enterText(task, 'First draft');
    await key(tester, LogicalKeyboardKey.keyT, cmd: true);
    await tester.pumpAndSettle();
    final second = app.activeSwarmId;
    expect(second, isNot(first));
    expect(box(tester).task, isEmpty);
    await tester.enterText(task, 'Second draft');
    app.selectSwarm(first);
    await tester.pumpAndSettle();
    expect(box(tester).task, isEmpty);
    app.selectSwarm(second);
    await tester.pumpAndSettle();
    expect(box(tester).task, isEmpty);
    expect(connection.starts, isEmpty);
  });

  testWidgets('switching tabs while defaults load still opens the new page', (
    tester,
  ) async {
    final storage = _DelayedPreferences();
    await setup(tester, storage: storage);
    expect(form, findsNothing);
    expect(find.text('Harness anything'), findsOneWidget);
    expect(find.text('Preparing your harness…'), findsOneWidget);
    expect(find.text('Choose a machine'), findsNothing);
    app.newSwarm(name: 'Second draft');
    await tester.pumpAndSettle();
    final target = app.activeSwarmId;
    storage.loaded.complete('codex');
    await tester.pumpAndSettle();
    expect(form, findsOneWidget);
    expect(find.text('Preparing your harness…'), findsNothing);
    expect(box(tester).swarmId, target);
    expect(tester.widget<TextField>(task).focusNode!.hasFocus, isTrue);
    expect(connection.starts, isEmpty);
  });

  testWidgets(
    'page launches once into its own tab and blocks another start while pending',
    (tester) async {
      await setup(tester);
      final tab = app.activeSwarmId;
      final tabs = app.swarms.length;
      box(tester).setFolder('/work/openharness');
      await tester.pumpAndSettle();
      await tester.enterText(task, 'Build the page');
      expect(tester.widget<TextField>(task).focusNode!.hasFocus, isTrue);
      expect(box(tester).requiredChoice, isNull);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 100));
      expect(box(tester).error, isNull);
      expect(connection.starts, hasLength(1));
      expect(connection.starts.single['prompt'], 'Build the page');
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.activeSwarmId, tab);
      expect(connection.starts, hasLength(1));
      connection.complete();
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.activeSwarmId, tab);
      expect(app.swarms, hasLength(tabs));
      expect(app.panes.single.agentId, 'created');
      expect(form, findsNothing);
    },
  );

  testWidgets('Escape from search opens the embedded form with an empty task', (
    tester,
  ) async {
    await setup(tester);
    await tester.enterText(task, 'Back from search');
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(box(tester).task, isEmpty);
  });

  for (final brightness in Brightness.values) {
    for (final (size, scale) in [
      (const Size(1280, 800), 1.0),
      (const Size(640, 540), 1.6),
    ]) {
      testWidgets('welcome with recents fits $brightness at $size and $scale', (
        tester,
      ) async {
        await setup(tester);
        final oldAppearance = appearancePrefsStore.value;
        addTearDown(() => appearancePrefsStore.value = oldAppearance);
        appearancePrefsStore.value = oldAppearance.copyWith(
          prompt: const PromptPrefs(statusStyle: StatusLineStyle.spaceship),
        );
        app.machineStates['m']!.agents = [
          for (final (index, name) in [
            'Polish the desktop composer',
            'Explore the machine picker',
            'Improve notifications',
            'Build a shader preview',
            'Continue the research',
            'Review the release notes',
            'Older session seven',
            'Older session eight',
            'Older session nine',
          ].indexed)
            Agent(
              id: 'recent-$index',
              name: name,
              engine: index.isEven ? 'codex' : 'claude',
              terminalAvailable: true,
              lastOpenedAt: DateTime.now().subtract(
                Duration(minutes: index * 23),
              ),
              lastActivityAt: DateTime.now().subtract(
                Duration(minutes: index * 23),
              ),
              project: const AgentProject(
                name: 'openharness',
                cwd: '/work/openharness',
                branch: 'experiment/friendly-desktop',
              ),
            ),
        ];
        connection.sessions.add({
          'agentId': '',
          'sessionId': 'claude-conversation',
          'engine': 'claude',
          'field': 'ask',
          'snippet': '',
          'score': .5,
          'lastAt': DateTime.now()
              .subtract(const Duration(minutes: 10))
              .millisecondsSinceEpoch,
          'external': {
            'title': 'Pane connection losses',
            'cwd': '/work/openharness',
            'origin': 'terminal',
            'open': true,
            'openIn': 'terminal',
          },
        });
        tester.view.physicalSize = size;
        final previous = grid.AppTheme.brightness.value;
        final previousPalette = grid.AppTheme.palette.value;
        grid.AppTheme.palette.value = grid.AppTheme.paletteFor(brightness);
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() {
          grid.AppTheme.brightness.value = previous;
          grid.AppTheme.palette.value = previousPalette;
        });
        final preview = MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => KeymapProvider(
            keymap: map,
            child: MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: RepaintBoundary(key: picture, child: child!),
            ),
          ),
          home: SwarmScreen(
            key: const ValueKey('welcome-render'),
            notifier: app,
            nativeTabs: false,
          ),
        );
        await tester.pumpWidget(preview);
        await tester.pumpAndSettle();
        final tabInk = tester.widget<Text>(find.text('New Tab')).style!.color!;
        final tabContrast =
            (tabInk.computeLuminance() + .05) /
            (grid.AppPalette.swarmWelcome.computeLuminance() + .05);
        expect(
          tabContrast >= 1 ? tabContrast : 1 / tabContrast,
          greaterThanOrEqualTo(4.5),
          reason: 'Tab names remain readable beside either app appearance.',
        );
        expect(find.text('Recent harnesses'), findsOneWidget);
        final recent = find.byKey(const ValueKey('welcome-sessions'));
        expect(
          find.descendant(of: recent, matching: find.byType(EngineMark)),
          findsNWidgets(6),
        );
        expect(
          find.descendant(of: recent, matching: find.byType(ColorFiltered)),
          findsNothing,
        );
        expect(find.text('Older session seven'), findsNothing);
        expect(find.text('Pane connection losses'), findsOneWidget);
        final contextLines = tester
            .widgetList<StatusLine>(
              find.descendant(of: recent, matching: find.byType(StatusLine)),
            )
            .toList();
        expect(contextLines, hasLength(6));
        expect(contextLines[1].parts.text, 'M2 in openharness');
        final paragraphs = find
            .descendant(of: recent, matching: find.byType(StatusLine))
            .evaluate()
            .map(
              (element) => tester.renderObject<RenderParagraph>(
                find.descendant(
                  of: find.byWidget(element.widget),
                  matching: find.byType(RichText),
                ),
              ),
            )
            .toList();
        expect(
          paragraphs[1].text.style?.fontFamily,
          paragraphs.first.text.style?.fontFamily,
        );
        expect(
          paragraphs[1].text.style?.fontSize,
          paragraphs.first.text.style?.fontSize,
        );
        expect(find.textContaining('not in Harness'), findsNothing);
        expect(find.textContaining('terminal'), findsNothing);
        expect(find.text('now'), findsOneWidget);
        expect(find.text('0m'), findsNothing);
        expect(
          tester.getRect(recent).top,
          greaterThanOrEqualTo(
            tester
                    .getRect(
                      find.byKey(const ValueKey('new-harness-field-approvals')),
                    )
                    .bottom +
                56,
          ),
        );
        final surface = tester.getRect(
          find.byKey(const ValueKey('new-harness-surface')),
        );
        expect(surface.width, lessThanOrEqualTo(680));
        expect(surface.center.dx, closeTo(size.width / 2, 1));
        expect(tester.takeException(), isNull);
        await capture(
          tester,
          'welcome-${brightness.name}-${size.width.toInt()}',
        );
        await tester.ensureVisible(find.text('Continue the research'));
        expect(
          find.text('Continue the research').hitTestable(),
          findsOneWidget,
        );
        await tester.ensureVisible(
          find.byKey(const ValueKey('new-harness-field-project')),
        );
        await tester.tap(
          find.byKey(const ValueKey('new-harness-field-project')),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('new-harness-chooser-surface')),
          findsOneWidget,
        );
        await tester.tapAt(Offset(2, size.height / 2));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('new-harness-chooser-surface')),
          findsNothing,
        );
        expect(connection.starts, isEmpty);
        if (scale == 1) {
          connection.sessions.clear();
          for (final machine in app.machineStates.values) {
            machine.agents = [];
          }
          app.machineStates.removeWhere((id, _) => id != 'm');
          app.machines = [app.machineStates['m']!.machine];
          app.modelManager
            ..loaded = true
            ..inventoryAvailable = true;
          await tester.pumpWidget(const SizedBox());
          await tester.pumpWidget(preview);
          await tester.pumpAndSettle();
          expect(find.byKey(const ValueKey('welcome-sessions')), findsNothing);
          expect(
            find.byKey(const ValueKey('workspace-status-bar')),
            findsOneWidget,
          );
          for (final control in [
            'workspace-harness-monitor',
            'workspace-machines',
            'workspace-models',
          ]) {
            expect(find.byKey(ValueKey(control)).hitTestable(), findsOneWidget);
          }
          expect(
            find.byKey(const ValueKey('workspace-pane-context')),
            findsNothing,
          );
          expect(tester.widget<TextField>(task).focusNode!.hasFocus, isTrue);
          await capture(tester, 'welcome-empty-${brightness.name}');
        }
      });
    }
  }

  testWidgets(
    'native footer keeps zero inventory visible on the empty welcome screen',
    (tester) async {
      await setup(tester, mac: true);
      expect(updates.last['footerCovered'], isFalse);
      expect(updates.last['harnessMonitor']['text'], startsWith('Harnesses 2'));
      expect(updates.last['focusedContext'], isNull);
      for (final machine in app.machineStates.values) {
        machine.agents = [];
      }
      app.machineStates.removeWhere((id, _) => id != 'm');
      app.machines = [app.machineStates['m']!.machine];
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(updates.last['footerCovered'], isFalse);
      expect(updates.last['harnessMonitor']['text'], 'Harnesses 0');
      expect(updates.last['footerMachines']['text'], 'Machines 1');
      expect(updates.last['footerModels']['text'], 'Models —');
      expect(updates.last['focusedContext'], isNull);
      app.modelManager
        ..loaded = true
        ..inventoryAvailable = true;
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(updates.last['footerModels']['text'], 'Models 0');
      expect(updates.last['footerCovered'], isFalse);
      app.adoptSessionForTest(terminal('a0', []));
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(updates.last['footerCovered'], isFalse);
      expect(
        find.byKey(const ValueKey('workspace-status-bar')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'recent context keeps customized fields and wording in one neutral ink',
    (tester) async {
      await setup(tester, withPane: true);
      final prefs = appearancePrefsStore.value;
      addTearDown(() => appearancePrefsStore.value = prefs);
      app.newSwarm();
      await tester.pumpAndSettle();
      appearancePrefsStore.value = prefs.copyWith(
        prompt: const PromptPrefs(statusStyle: StatusLineStyle.spaceship),
      );
      await tester.pumpAndSettle();
      final recent = find.byKey(const ValueKey('welcome-sessions'));
      final line = find.descendant(
        of: recent,
        matching: find.byType(StatusLine),
      );
      expect(line, findsOneWidget);
      expect(
        tester.widget<StatusLine>(line).parts.text,
        'M2 in openharness on feature/login-redirect',
      );
      for (final style in StatusLineStyle.values) {
        appearancePrefsStore.value = prefs.copyWith(
          prompt: PromptPrefs(statusStyle: style, color: true),
        );
        await tester.pumpAndSettle();
        final paragraph = tester.renderObject<RenderParagraph>(
          find.descendant(of: line, matching: find.byType(RichText)),
        );
        expect(paragraph.text.toPlainText(), contains('openharness'));
        paragraph.text.visitChildren((span) {
          if (span is TextSpan && (span.text?.isNotEmpty ?? false)) {
            expect(span.style?.color, DesktopChrome.muted);
            expect(span.style?.backgroundColor, isNull);
          }
          return true;
        });
        expect(tester.takeException(), isNull);
      }
      appearancePrefsStore.value = prefs.copyWith(
        prompt: const PromptPrefs(
          statusStyle: StatusLineStyle.pastelPowerline,
          color: false,
          machine: false,
          branch: false,
        ),
      );
      await tester.pumpAndSettle();
      final configured = tester.widget<StatusLine>(line);
      expect(configured.parts.style, StatusLineStyle.pastelPowerline);
      expect(configured.color, isFalse);
      expect(configured.parts.text, 'openharness');
      expect(connection.starts, isEmpty);
    },
  );

  testWidgets('native footer is covered for popup and restored on close', (
    tester,
  ) async {
    await setup(tester, withPane: true, mac: true);
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    await tester.pumpAndSettle();
    expect(tester.widget<NewHarnessForm>(form).embedded, isFalse);
    final creationVeil = tester
        .widget<ColoredBox>(
          find.descendant(
            of: find.byType(DesktopDialogBackdrop),
            matching: find.byType(ColoredBox),
          ),
        )
        .color;
    expect(creationVeil, grid.AppDesktop.darkVeil);
    expect(updates.last['footerCovered'], isTrue);
    await tester.tap(find.byKey(const ValueKey('new-harness-close')));
    await tester.pumpAndSettle();
    expect(updates.last['footerCovered'], isFalse);
    expect(form, findsNothing);
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    await tester.pumpAndSettle();
    expect(updates.last['footerCovered'], isTrue);
    expect(
      tester
          .widget<ColoredBox>(
            find.descendant(
              of: find.byType(DesktopDialogBackdrop),
              matching: find.byType(ColoredBox),
            ),
          )
          .color,
      creationVeil,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(updates.last['footerCovered'], isFalse);
  });

  testWidgets('customization previews a passive footer only while current', (
    tester,
  ) async {
    await setup(tester, withPane: true, mac: true);
    final opening = native(tester, 'customize');
    await tester.pumpAndSettle();
    expect(find.byType(HarnessCustomizePane), findsOneWidget);
    expect(updates.last['footerCovered'], isFalse);
    expect(updates.last['footerPassive'], isTrue);
    expect(updates.last['enabled'], isFalse);

    unawaited(
      showAppDialog<void>(
        context: tester.element(find.byType(HarnessCustomizePane)),
        builder: (context) => AlertDialog(
          title: const Text('Nested task'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close nested task'),
            ),
          ],
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(updates.last['footerCovered'], isTrue);
    expect(updates.last['footerPassive'], isFalse);
    expect(updates.last['enabled'], isFalse);
    await tester.tap(find.text('Close nested task'));
    await tester.pumpAndSettle();
    expect(updates.last['footerCovered'], isFalse);
    expect(updates.last['footerPassive'], isTrue);

    await tester.tap(find.byKey(const ValueKey('harness-customize-close')));
    await tester.pumpAndSettle();
    await opening;
    expect(updates.last['footerCovered'], isFalse);
    expect(updates.last['footerPassive'], isFalse);
    expect(updates.last['enabled'], isTrue);
    expect(connection.starts, isEmpty);
  });
}
