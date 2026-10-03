import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/api_connections_controller.dart';
import 'package:harness/models/model_search_catalog.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/desktop_search_panel.dart';
import 'package:harness/widgets/api_picker_form.dart';
import 'package:harness/widgets/machine_picker_form.dart';
import 'package:harness/widgets/session_tail_view.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/terminal_text_action.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'resource_picker_test.dart' as resources;
import 'session_search_rendering_test.dart' show TailConnection;
import 'support/open_harness.dart';
import 'support/mixed_agents.dart';
import 'support/model_manager.dart';
import 'swarm_state_test.dart' show createApp;

class _Palette {
  _Palette({AppNotifier? app, ModelSearchCatalog? models})
    : app = app ?? createApp() {
    if (app == null) seedMixedAgents(this.app);
    search = SwarmSearchController(
      this.app,
      const [],
      adding: true,
      activityFirst: true,
      models: models,
      offersCreate: models != null,
      commands: () => [
        SwarmDestination(
          id: 'command:agent.new',
          title: 'New harness',
          detail: 'Start a new harness',
          commandId: 'agent.new',
          shortcut: '⌘N',
          swarmId: null,
          current: false,
        ),
      ],
      selectOnEmptyQuery: false,
      offersHarnessCreate: false,
    );
    search.addListener(sync);
  }

  final AppNotifier app;
  late final SwarmSearchController search;
  final editor = TextEditingController();
  final focus = FocusNode(debugLabel: 'Search fixture');
  final map = MemoryKeymap();
  final controls = SearchPreviewControls();
  final chosen = <SwarmSearchSelection>[];
  final picture = GlobalKey();
  var closed = 0;

  void sync() {
    if (editor.text == search.query) return;
    editor.value = TextEditingValue(
      text: search.query,
      selection: TextSelection.collapsed(offset: search.query.length),
    );
  }

  void dispose() {
    controls.dispose();
    search.removeListener(sync);
    search.dispose();
    editor.dispose();
    focus.dispose();
    map.dispose();
    app.dispose();
  }

  Widget widget({
    Brightness brightness = Brightness.dark,
    double scale = 1,
    SearchPreviewControls? previewControls,
    Key? resourceKey,
  }) => MaterialApp(
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
            body: Padding(
              padding: const EdgeInsets.all(20),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxWidth: DesktopSearchPanel.maxWidth,
                    maxHeight: DesktopSearchPanel.maxHeight,
                  ),
                  child: SwarmSearchKeys(
                    desktop: true,
                    search: search,
                    editing: editor,
                    previewControls: previewControls ?? controls,
                    onChoose: chosen.add,
                    onClose: () => closed++,
                    onRefocus: focus.requestFocus,
                    child: DesktopSearchPanel(
                      search: search,
                      editing: editor,
                      focusNode: focus,
                      onChoose: chosen.add,
                      onClose: () => closed++,
                      onRefocus: focus.requestFocus,
                      previewBuilder: () => SwarmResourcePreview(
                        key: resourceKey,
                        search: search,
                        controls: previewControls ?? controls,
                        onChoose: chosen.add,
                        onRefocus: focus.requestFocus,
                        onModalChanged: (_) {},
                        onCommands: () => search.setQuery('>'),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class _ReviewSubscriptions extends ModelsMenuController {
  @override
  List<Map<String, Object?>> get rows => const [
    {
      'engine': 'codex',
      'title': 'OpenAI',
      'status': '71% remaining',
      'remainingPercent': 71.0,
      'details': ['Weekly usage · resets Friday'],
    },
    {
      'engine': 'claude',
      'title': 'Anthropic',
      'status': 'Not signed in',
      'details': ['Sign in to Claude on this computer.'],
    },
  ];
}

class _InventoryApp extends ModelManagerTestApp {
  _InventoryApp() : super(ModelManagerConnection()) {
    machines = [];
    machineStates.clear();
  }

  @override
  String? machineListError;

  @override
  bool get machinesRefreshing => _retry != null;

  Completer<void>? _retry;
  int retryCalls = 0;

  @override
  Future<void> retryMachines() async {
    if (_retry != null) return _retry!.future;
    retryCalls++;
    final pending = _retry = Completer<void>();
    notifyListeners();
    await pending.future;
    _retry = null;
    machineListError = null;
    notifyListeners();
  }

  void finishRetry() => _retry!.complete();
}

void main() {
  final renderDir = Platform.environment['DESKTOP_SEARCH_RENDER_DIR'];
  setUpAll(() async {
    if (renderDir != null) await loadPreviewFonts();
  });
  const inputKey = ValueKey('swarm-search-input');
  final input = find.byKey(inputKey);

  Future<_Palette> mount(
    WidgetTester tester, {
    Size size = const Size(1120, 740),
    Brightness brightness = Brightness.dark,
    double scale = 1,
    AppNotifier? app,
    ModelSearchCatalog? models,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    final fixture = _Palette(app: app, models: models);
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      fixture.widget(brightness: brightness, scale: scale),
    );
    await tester.pumpAndSettle();
    return fixture;
  }

  Future<_Palette> mountModels(
    WidgetTester tester, {
    Size size = const Size(1440, 940),
    Brightness brightness = Brightness.dark,
    double scale = 1,
    int modelCount = 3,
  }) async {
    final app = ModelManagerTestApp(ModelManagerConnection());
    app.machineStates.clear();
    seedMixedAgents(app);
    app.machineStates['m']!.localOnly = true;
    app.localInventory = {
      'models': [
        for (var i = 0; i < modelCount; i++)
          {
            'id': 'review-model-$i',
            'name': i == 0 ? 'Qwen3.8-27B' : 'Gemma 4 ${i + 1}',
            'state': i == 0 ? 'running' : 'downloaded',
            'canStart': i != 0,
            'canStop': i == 0,
          },
      ],
    };
    app.inventory = const GridModels(
      gridName: 'home',
      models: [],
      grids: [
        GridSection(
          name: 'Design team',
          own: false,
          models: [GridModel(id: 'Shared Qwen3.8', node: 'Studio')],
        ),
      ],
    );
    app.modelManager.apis
      ..connections = [
        const ApiConnection({
          'id': 'review-api',
          'provider': 'custom',
          'name': 'OpenRouter',
          'baseUrl': 'https://openrouter.ai/api/v1',
          'keyEnv': 'OPENROUTER_API_KEY',
        }),
      ]
      ..loaded = true;
    await app.modelManager.refresh();
    final subscriptions = _ReviewSubscriptions();
    final models = ModelSearchCatalog(
      app.modelManager,
      subscriptions,
      pollHosts: false,
    );
    final palette = await mount(
      tester,
      app: app,
      models: models,
      size: size,
      brightness: brightness,
      scale: scale,
    );
    addTearDown(() {
      models.dispose();
      subscriptions.dispose();
    });
    return palette;
  }

  Future<void> capture(
    WidgetTester tester,
    _Palette palette,
    String name,
  ) async {
    if (renderDir == null) return;
    final previousShadows = debugDisableShadows;
    debugDisableShadows = false;
    final boundary =
        palette.picture.currentContext!.findRenderObject()!
            as RenderRepaintBoundary;
    final images = tester.widgetList<Image>(
      find.descendant(
        of: find.byKey(palette.picture),
        matching: find.byType(Image),
      ),
    );
    await tester.runAsync(() async {
      await Future.wait([
        for (final image in images)
          precacheImage(image.image, palette.picture.currentContext!),
      ]);
    });
    void repaint(RenderObject object) {
      object.markNeedsPaint();
      object.visitChildren(repaint);
    }

    repaint(boundary);
    await tester.pump();
    await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: 1.5);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      final directory = Directory(renderDir)..createSync(recursive: true);
      await File('${directory.path}/$name.png')
          .writeAsBytes(data!.buffer.asUint8List());
      image.dispose();
    });
    debugDisableShadows = previousShadows;
    repaint(boundary);
    await tester.pump();
  }

  test('preview activity says now below one minute and retains older ages', () {
    final now = DateTime(2026, 9, 29, 12);
    expect(sessionPreviewAge(now, now), 'now');
    expect(
      sessionPreviewAge(now.subtract(const Duration(seconds: 59)), now),
      'now',
    );
    expect(
      sessionPreviewAge(now.subtract(const Duration(minutes: 1)), now),
      '1m ago',
    );
    expect(
      sessionPreviewAge(now.subtract(const Duration(hours: 2)), now),
      '2h ago',
    );
  });

  testWidgets('inventory loading settles without changing the empty catalog', (
    tester,
  ) async {
    final app = _InventoryApp()..machinesLoading = true;
    final palette = await mount(tester, app: app);
    expect(palette.search.rows, isEmpty);
    expect(find.text('Loading harnesses…'), findsOneWidget);
    expect(find.textContaining('No harnesses yet'), findsNothing);
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.chosen, isEmpty);

    for (final (query, resource) in [('@', 'machines'), ('#', 'projects')]) {
      palette.search.setQuery(query);
      await tester.pumpAndSettle();
      expect(find.text('Loading $resource…'), findsOneWidget);
      expect(find.text('No matching $resource'), findsNothing);
    }
    palette.search.setQuery('>nothing matches');
    await tester.pumpAndSettle();
    expect(find.text('No matching commands'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('swarm-search-inventory-state')),
      findsNothing,
    );

    palette.search.setQuery('');
    await tester.pumpAndSettle();
    app.machinesLoading = false;
    app.notifyListeners();
    await tester.pumpAndSettle();
    expect(find.text('Loading harnesses…'), findsNothing);
    expect(find.textContaining('No harnesses yet'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      '${brightness.name} empty inventory failure retries once from the keyboard',
      (tester) async {
        final app = _InventoryApp();
        final palette = await mount(
          tester,
          app: app,
          brightness: brightness,
          size: const Size(390, 520),
          scale: 1.6,
        );
        const error =
            'The machine inventory could not be reached. Your existing '
            'harnesses will appear after the connection is restored.';
        app.machineListError = error;
        app.notifyListeners();
        await tester.pumpAndSettle();
        expect(find.text('Couldn’t load your harnesses'), findsOneWidget);
        expect(find.text(error), findsOneWidget);
        expect(find.textContaining('No harnesses yet'), findsNothing);
        await capture(tester, palette, 'inventory-error-${brightness.name}');
        final retry = find.byKey(
          const ValueKey('swarm-search-inventory-retry'),
        );
        await tester.ensureVisible(retry);
        final button = find.descendant(
          of: retry,
          matching: find.byType(TextButton),
        );
        Focus.of(tester.element(find.text('Retry'))).requestFocus();
        await tester.pumpAndSettle();
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(app.retryCalls, 1);
        expect(find.text('Loading harnesses…'), findsOneWidget);
        expect(tester.widget<TextButton>(button).onPressed, isNull);
        await key(tester, LogicalKeyboardKey.enter);
        expect(app.retryCalls, 1);
        expect(palette.chosen, isEmpty);
        app.finishRetry();
        await tester.pumpAndSettle();
        expect(find.textContaining('No harnesses yet'), findsOneWidget);
        expect(find.text(error), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('loaded harnesses remain visible during inventory recovery', (
    tester,
  ) async {
    final app = _InventoryApp();
    seedMixedAgents(app);
    final palette = await mount(tester, app: app);
    final before = palette.search.rows.map((row) => row.id).toList();
    expect(before, isNotEmpty);
    app.machinesLoading = true;
    app.machineListError = 'Inventory temporarily unavailable';
    app.notifyListeners();
    await tester.pumpAndSettle();
    expect(palette.search.rows.map((row) => row.id), before);
    expect(
      find.byKey(const ValueKey('swarm-search-result-list')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('swarm-search-inventory-state')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  for (final brightness in Brightness.values) {
    for (final enlarged in [false, true]) {
      testWidgets(
        'transcript preview is readable ${brightness.name} ${enlarged ? 'enlarged' : 'wide'}',
        (tester) async {
          const answer =
              'The account switcher now saves the current draft before changing profiles. '
              'Returning to the previous account restores the same tab, cursor position, '
              'and unsent text, so a quick identity check does not interrupt the task.\n\n'
              'I verified keyboard selection, reconnect recovery, and two browser sessions '
              'using the same project. The stale request is ignored after an account change, '
              'and a failed refresh keeps the last confirmed project visible.\n\n'
              'Changed: AccountSwitcher.tsx, draftStore.ts\n'
              'verify: pnpm test account-switcher\n'
              'Result: 18 checks passed; no duplicate draft writes.';
          final now = DateTime.now();
          final connection = TailConnection(
            const {},
            tail: (_) => {
              'rows': [
                {
                  'turn': 0,
                  'at': now.millisecondsSinceEpoch,
                  'ask': 'Preserve every draft when switching accounts.',
                  'answer': answer,
                  'tools': '',
                },
              ],
              'hasMore': false,
              'total': 1,
              'lastAsk': {
                'turn': 0,
                'at': now.millisecondsSinceEpoch,
                'ask': 'Preserve every draft when switching accounts.',
              },
            },
          );
          final app = createApp(
            connected: true,
            connectionForTest: (_) => connection,
          );
          app.machineStates['m']!.agents = [
            Agent(
              id: 'account-switcher',
              sessionId: 'account-switcher-session',
              name: 'Account switcher draft recovery',
              engine: 'codex',
              terminalAvailable: true,
              lastActivityAt: now,
              project: const AgentProject(
                name: 'frontend-platform',
                cwd: '/work/frontend-platform',
                branch: 'feature/account-switcher',
              ),
            ),
          ];
          final palette = await mount(
            tester,
            app: app,
            brightness: brightness,
            size: const Size(1440, 940),
            scale: enlarged ? 1.6 : 1,
          );
          await tester.enterText(input, 'Account switcher');
          await tester.pump(const Duration(milliseconds: 200));
          await tester.pumpAndSettle();
          final tail = find.byKey(
            const ValueKey('session-tail:m:account-switcher-session'),
          );
          final text = find.text(answer, findRichText: true);
          final viewport = tester.getRect(tail);
          final answerRect = tester.getRect(text);
          expect(viewport.width, greaterThan(600));
          expect(answerRect.bottom, lessThanOrEqualTo(viewport.bottom));
          if (!enlarged) {
            expect(answerRect.top, greaterThanOrEqualTo(viewport.top));
            final rendered = tester.widget<RichText>(text);
            final measure = TextPainter(
              text: rendered.text,
              textScaler: rendered.textScaler,
              textDirection: TextDirection.ltr,
            )..layout(maxWidth: answerRect.width);
            final currentLines = measure.computeLineMetrics().length;
            measure.layout(maxWidth: (880 - 1) * .45 - 36);
            final previousLines = measure.computeLineMetrics().length;
            measure.dispose();
            expect(currentLines, lessThan(previousLines));
            if (renderDir != null) {
              debugPrint(
                'Transcript review: ${answerRect.width.toStringAsFixed(0)}pt '
                'reading width, $currentLines lines; old panel360pt, '
                '$previousLines lines.',
              );
            }
          }
          expect(
            find.descendant(
              of: find.byType(SwarmResourcePreview),
              matching: find.text('now'),
            ),
            findsOneWidget,
          );
          expect(find.textContaining('0m ago'), findsNothing);
          expect(tester.takeException(), isNull);
          await capture(
            tester,
            palette,
            'transcript-${brightness.name}-${enlarged ? 'enlarged' : 'wide'}',
          );
        },
      );
    }
  }

  testWidgets('roomy palette gives the selected preview most of the width', (
    tester,
  ) async {
    final palette = await mount(tester, size: const Size(1440, 940));
    final panel = find.byKey(const ValueKey('swarm-search-results'));
    final original = tester.getRect(panel);
    final editor = tester.element(input);
    expect(original.size, const Size(1120, 680));
    await tester.enterText(input, 'login');
    await tester.pumpAndSettle();
    final preview = tester.getRect(find.byType(SwarmResourcePreview));
    final results = tester.getRect(
      find.byKey(const ValueKey('swarm-search-result-list')),
    );
    expect(preview.width, greaterThan(600));
    expect(preview.width / (preview.width + results.width), closeTo(.56, .01));
    for (final query in [
      '@ M2',
      '# openharness',
      '* Robot',
      '> new',
      'no-result',
    ]) {
      await tester.enterText(input, query);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();
      expect(tester.getRect(panel), original);
      expect(tester.element(input), same(editor));
    }
    expect(palette.chosen, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('model headings and group gaps are smaller than result rows', (
    tester,
  ) async {
    final palette = await mountModels(tester);
    await tester.enterText(input, ':');
    await tester.pumpAndSettle();
    final first = palette.search.rows.first;
    final second = palette.search.rows[1];
    final firstRect = tester.getRect(find.byKey(ValueKey(first.id)));
    final secondRect = tester.getRect(find.byKey(ValueKey(second.id)));
    final subscriptions = tester.getRect(
      find.byKey(const ValueKey('model-section:Subscriptions')),
    );
    final apis = tester.getRect(
      find.byKey(const ValueKey('model-section:APIs')),
    );
    expect(subscriptions.height, lessThan(firstRect.height));
    expect(apis.top - secondRect.bottom, inInclusiveRange(8, 12));
    expect(secondRect.top - firstRect.bottom, closeTo(4, .01));
    final headingText = tester.getRect(
      find.descendant(
        of: find.byKey(const ValueKey('model-section:Subscriptions')),
        matching: find.byType(Text),
      ),
    );
    expect(headingText.left, closeTo(firstRect.left + 14, .01));
    expect(tester.takeException(), isNull);
  });

  testWidgets('mixed model heights keep keyboard selections fully visible', (
    tester,
  ) async {
    final palette = await mountModels(
      tester,
      size: const Size(1000, 720),
      scale: 1.6,
      modelCount: 24,
    );
    await tester.enterText(input, ':');
    await tester.pumpAndSettle();
    void expectSelectionVisible() {
      final viewport = tester.getRect(
        find.byKey(const ValueKey('swarm-search-result-list')),
      );
      final selected = tester.getRect(
        find.byKey(ValueKey(palette.search.selected!.id)),
      );
      expect(selected.top, greaterThanOrEqualTo(viewport.top - .01));
      expect(selected.bottom, lessThanOrEqualTo(viewport.bottom + .01));
    }

    for (var page = 0; page < 8; page++) {
      await key(tester, LogicalKeyboardKey.pageDown);
      await tester.pumpAndSettle();
      expectSelectionVisible();
    }
    expect(palette.search.cursor, palette.search.rows.length - 1);
    for (var page = 0; page < 8; page++) {
      await key(tester, LogicalKeyboardKey.pageUp);
      await tester.pumpAndSettle();
      expectSelectionVisible();
    }
    expect(palette.search.cursor, 0);
    expect(palette.focus.hasFocus, isTrue);
    expect(palette.chosen, isEmpty);
    expect((palette.app as ModelManagerTestApp).actions, isEmpty);
    expect(tester.takeException(), isNull);
  });

  for (final brightness in Brightness.values) {
    for (final layout in [
      (name: 'wide', size: const Size(1440, 940), scale: 1.0),
      (name: 'enlarged', size: const Size(1200, 900), scale: 1.6),
      (name: 'narrow', size: const Size(440, 780), scale: 1.6),
    ]) {
      testWidgets('every search scope fits ${brightness.name} ${layout.name}', (
        tester,
      ) async {
        final palette = await mountModels(
          tester,
          brightness: brightness,
          size: layout.size,
          scale: layout.scale,
        );
        final panel = find.byKey(const ValueKey('swarm-search-results'));
        final original = tester.getRect(panel);
        final editor = tester.element(input);
        for (final (name, query) in [
          ('harnesses', 'login'),
          ('machines', '@'),
          ('projects', '#'),
          ('models', ':'),
          ('store', '*'),
          ('commands', '> new'),
        ]) {
          await tester.enterText(input, query);
          await tester.pumpAndSettle();
          expect(palette.search.rows, isNotEmpty, reason: name);
          expect(tester.getRect(panel), original, reason: name);
          expect(tester.element(input), same(editor), reason: name);
          expect(tester.takeException(), isNull, reason: name);
          await capture(
            tester,
            palette,
            'scope-$name-${brightness.name}-${layout.name}',
          );
          if (name == 'models') {
            final preview = find.byType(SwarmResourcePreview);
            expect(
              find.descendant(of: preview, matching: find.text('Machine')),
              findsNothing,
              reason: 'A subscription is not a machine',
            );
            final local = palette.search.rows.indexWhere(
              (row) => row.modelId == 'model:local:review-model-0',
            );
            expect(local, greaterThanOrEqualTo(0));
            palette.search.move(local - palette.search.cursor);
            await tester.pumpAndSettle();
            final machineLabel = find.descendant(
              of: preview,
              matching: find.text('Machine'),
            );
            await tester.scrollUntilVisible(
              machineLabel,
              100,
              scrollable: find
                  .descendant(of: preview, matching: find.byType(Scrollable))
                  .first,
            );
            await tester.pumpAndSettle();
            final labelRect = tester.getRect(machineLabel);
            final machineValue = tester.getRect(
              find.descendant(
                of: preview,
                matching: find.text(
                  '${thisComputerName()[0].toUpperCase()}${thisComputerName().substring(1)}',
                ),
              ),
            );
            expect(labelRect.height, lessThan(12 * layout.scale * 1.6));
            if (layout.name == 'narrow') {
              expect(labelRect.bottom, lessThan(machineValue.top));
            } else {
              expect(labelRect.top, closeTo(machineValue.top, .01));
              expect(labelRect.right, lessThanOrEqualTo(machineValue.left));
            }
            expect(tester.takeException(), isNull);
            await capture(
              tester,
              palette,
              'scope-model-detail-${brightness.name}-${layout.name}',
            );
          }
        }
        expect(palette.chosen, isEmpty);
        expect((palette.app as ModelManagerTestApp).actions, isEmpty);
      });
    }
  }

  testWidgets(
    'native scopes put machines first and keep typed words and focus',
    (tester) async {
      final palette = await mount(tester);
      expect(find.byType(DesktopPill), findsNWidgets(7));
      expect(
        find.byKey(const ValueKey('search-category-Agents')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('search-category-Harnesses')),
        findsOneWidget,
      );
      expect(palette.search.hint, 'Search harnesses');
      await tester.enterText(input, 'login');
      for (final (label, prefix) in DesktopSearchPanel.categories) {
        await tester.tap(find.byKey(ValueKey('search-category-$label')));
        await tester.pumpAndSettle();
        final exception = tester.takeException();
        expect(exception, isNull, reason: 'Scope $label');
        expect(palette.editor.text, prefix.isEmpty ? 'login' : '$prefix login');
        expect(palette.focus.hasFocus, isTrue);
        expect(palette.chosen, isEmpty);
        expect(palette.closed, 0);
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('clear search returns to the unselected root without closing', (
    tester,
  ) async {
    final palette = await mount(tester);
    expect(find.byKey(const ValueKey('search-clear-query')), findsNothing);
    await tester.enterText(input, '@ M2');
    await tester.pumpAndSettle();
    expect(palette.search.selected, isNotNull);
    await tester.tap(find.byKey(const ValueKey('search-clear-query')));
    await tester.pumpAndSettle();
    expect(palette.editor.text, isEmpty);
    expect(palette.search.query, isEmpty);
    expect(palette.search.selected, isNull);
    expect(palette.search.showsTypeHints, isTrue);
    expect(palette.focus.hasFocus, isTrue);
    expect(palette.closed, 0);
    expect(palette.chosen, isEmpty);
    expect(find.byKey(const ValueKey('search-clear-query')), findsNothing);
  });

  testWidgets('empty Enter is inert and keyboard selection opens once', (
    tester,
  ) async {
    final palette = await mount(tester);
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.chosen, isEmpty);
    await key(tester, LogicalKeyboardKey.arrowDown);
    final chosenId = palette.search.selected!.id;
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.chosen, hasLength(1));
    expect(palette.search.selected!.id, chosenId);
    expect(palette.closed, 0);
  });

  testWidgets('composition owns arrows Enter and Escape', (tester) async {
    final palette = await mount(tester);
    await tester.enterText(input, 'login');
    await tester.pumpAndSettle();
    final selected = palette.search.selected!.id;
    for (final logicalKey in [
      LogicalKeyboardKey.arrowDown,
      LogicalKeyboardKey.enter,
      LogicalKeyboardKey.escape,
    ]) {
      // Flutter's fake input can commit preedit while processing a key. Each
      // key starts with the active range that a platform IME would report.
      palette.editor.value = const TextEditingValue(
        text: 'login',
        selection: TextSelection.collapsed(offset: 5),
        composing: TextRange(start: 0, end: 5),
      );
      await key(tester, logicalKey);
      expect(palette.search.selected!.id, selected);
      expect(palette.chosen, isEmpty);
      expect(palette.closed, 0);
      expect(palette.editor.text, 'login');
    }
  });

  testWidgets('machine controls keep the resource fixed and Escape returns', (
    tester,
  ) async {
    final palette = await mount(tester);
    await tester.enterText(input, '@ M2');
    await tester.pumpAndSettle();
    final selected = palette.search.selected!.id;
    expect(find.byType(TerminalTextAction), findsNothing);
    expect(
      find.byKey(const ValueKey('resource-action:picker.resource_rename')),
      findsOneWidget,
    );
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.search.managing, isTrue);
    await key(tester, LogicalKeyboardKey.arrowDown);
    expect(palette.search.selected!.id, selected);
    expect(palette.search.managing, isTrue);
    await key(tester, LogicalKeyboardKey.escape);
    expect(palette.search.managing, isFalse);
    expect(palette.focus.hasFocus, isTrue);
    expect(palette.editor.text, '@ M2');
    expect(palette.closed, 0);
    expect(palette.chosen, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('offline harnesses remain inspectable and cannot launch', (
    tester,
  ) async {
    final palette = await mount(tester);
    await tester.enterText(input, 'build-box');
    await tester.pumpAndSettle();
    final offline = palette.search.rows.indexWhere(
      (row) => row.machineId == 'build' && row.agentId == 'login',
    );
    expect(offline, greaterThanOrEqualTo(0));
    palette.search.move(offline - palette.search.cursor);
    await tester.pumpAndSettle();
    expect(palette.search.selected, isNotNull);
    expect(
      palette.search.sessionUnavailable(palette.search.selected),
      'Offline',
    );
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.chosen, isEmpty);
    expect(palette.closed, 0);
    expect(find.textContaining('Offline'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('preview toggle and commands preserve the same text editor', (
    tester,
  ) async {
    final palette = await mount(tester);
    final editorElement = tester.element(input);
    await tester.enterText(input, 'login');
    await tester.pumpAndSettle();
    for (var i = 0; i < 2; i++) {
      await tester.tap(find.byKey(const ValueKey('search-toggle-preview')));
      await tester.pumpAndSettle();
      expect(tester.element(input), same(editorElement));
      expect(palette.focus.hasFocus, isTrue);
      expect(palette.editor.text, 'login');
    }
    await tester.enterText(input, '> new');
    await tester.pumpAndSettle();
    expect(tester.element(input), same(editorElement));
    expect(find.bySemanticsLabel('Command preview'), findsOneWidget);
    expect(palette.chosen, isEmpty);
  });

  testWidgets('Return activates focused toolbar controls instead of a result', (
    tester,
  ) async {
    final palette = await mount(tester);
    await tester.enterText(input, 'login');
    await tester.pumpAndSettle();
    Future<void> focusButton(Key keyValue) async {
      // Walk actual focus traversal instead of injecting a private FocusNode.
      palette.focus.requestFocus();
      for (var step = 0; step < 30; step++) {
        await key(tester, LogicalKeyboardKey.tab);
        final button = FocusManager.instance.primaryFocus?.context
            ?.findAncestorWidgetOfExactType<IconButton>();
        if (button?.key == keyValue) return;
      }
      fail('Toolbar control $keyValue was not keyboard reachable');
    }

    await focusButton(const ValueKey('search-toggle-preview'));
    final visible = palette.search.previewVisible;
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.search.previewVisible, !visible);
    expect(palette.chosen, isEmpty);
    expect(palette.closed, 0);
    await focusButton(const ValueKey('search-clear-query'));
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.editor.text, isEmpty);
    expect(palette.chosen, isEmpty);
    await focusButton(const ValueKey('search-close'));
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.closed, 1);
    expect(palette.chosen, isEmpty);
  });

  testWidgets('focused scopes use arrows and Return returns to search', (
    tester,
  ) async {
    final palette = await mount(tester);
    var focusedScope = false;
    for (var step = 0; step < 30; step++) {
      await key(tester, LogicalKeyboardKey.tab);
      focusedScope = tester
          .widget<Focus>(find.byKey(const ValueKey('search-scopes')))
          .focusNode!
          .hasFocus;
      if (focusedScope) break;
    }
    expect(focusedScope, isTrue);
    await key(tester, LogicalKeyboardKey.arrowDown);
    expect(palette.search.isMachineMode, isTrue);
    await key(tester, LogicalKeyboardKey.arrowDown);
    expect(palette.search.isProjectMode, isTrue);
    await key(tester, LogicalKeyboardKey.arrowUp);
    expect(palette.search.isMachineMode, isTrue);
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.focus.hasFocus, isTrue);
    expect(palette.search.isMachineMode, isTrue);
    expect(palette.chosen, isEmpty);
    expect(palette.closed, 0);
  });

  testWidgets('standalone palette toolbar keeps normal keyboard traversal', (
    tester,
  ) async {
    final palette = _Palette();
    addTearDown(palette.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SwarmSearchKeys(
            desktop: true,
            search: palette.search,
            editing: palette.editor,
            onChoose: palette.chosen.add,
            onClose: () => palette.closed++,
            onRefocus: palette.focus.requestFocus,
            child: DesktopSearchPanel(
              search: palette.search,
              editing: palette.editor,
              focusNode: palette.focus,
              onChoose: palette.chosen.add,
              onClose: () => palette.closed++,
              onRefocus: palette.focus.requestFocus,
              previewBuilder: () => const SizedBox(),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(input, 'login');
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.tab);
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.editor.text, isEmpty);
    expect(palette.focus.hasFocus, isTrue);
    expect(palette.chosen, isEmpty);
    await key(tester, LogicalKeyboardKey.tab);
    await key(tester, LogicalKeyboardKey.tab);
    await key(tester, LogicalKeyboardKey.tab, shift: true);
    final visible = palette.search.previewVisible;
    await key(tester, LogicalKeyboardKey.enter);
    expect(palette.search.previewVisible, !visible);
    expect(palette.closed, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'enlarged narrow preview keeps the latest turn under a long header',
    (tester) async {
      final connection = TailConnection(
        const {},
        tail: (_) => {
          'rows': [
            {
              'turn': 0,
              'at': DateTime.now().millisecondsSinceEpoch,
              'ask': 'Verify the release',
              'answer': 'Newest verified answer',
              'tools': '',
            },
          ],
          'hasMore': false,
          'total': 1,
        },
      );
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'long-tail',
          sessionId: 'long-tail-session',
          name: 'Release investigation with a very long descriptive task name that wraps across several lines in a narrow window',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'a-project-with-a-long-directory-name',
            cwd: '/work/projects/a-project-with-a-long-directory-name',
            branch: 'feature/keep-the-latest-session-answer-visible',
          ),
        ),
      ];
      final palette = await mount(
        tester,
        app: app,
        size: const Size(440, 780),
        scale: 1.6,
      );
      await tester.enterText(input, 'Release investigation');
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();
      final tail = find.byKey(
        const ValueKey('session-tail:m:long-tail-session'),
      );
      expect(tail, findsOneWidget);
      expect(tester.getSize(tail).height, greaterThan(45));
      final answer = find.textContaining(
        'Newest verified answer',
        findRichText: true,
      );
      expect(answer, findsOneWidget);
      expect(tester.getRect(tail).overlaps(tester.getRect(answer)), isTrue);
      expect(palette.focus.hasFocus, isTrue);
      expect(tester.takeException(), isNull);
      await capture(tester, palette, 'latest-tail-narrow-enlarged');
    },
  );

  for (final brightness in Brightness.values) {
    for (final narrow in [false, true]) {
      testWidgets(
        '${brightness.name} ${narrow ? 'narrow enlarged' : 'regular'} palette fits long names and empty matches',
        (tester) async {
          final palette = await mount(
            tester,
            brightness: brightness,
            size: narrow ? const Size(440, 780) : const Size(1120, 740),
            scale: narrow ? 1.6 : 1,
          );
          final machine = palette.app.machineStates['m']!;
          machine.agents = [
            const Agent(
              id: 'very-long',
              name: 'Fix 日本語 👩🏽‍💻 account switching and preserve every unsaved document while reconnecting the remote machine',
              engine: 'codex',
              terminalAvailable: true,
              project: AgentProject(
                name: 'a-project-with-a-very-long-name',
                cwd: '/work/projects/a-project-with-a-very-long-name',
                branch: 'feature/preserve-every-unsaved-document',
              ),
            ),
          ];
          palette.app.notifyListeners();
          await tester.enterText(input, 'unsaved');
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await capture(
            tester,
            palette,
            'search-${brightness.name}-${narrow ? 'narrow' : 'regular'}',
          );
          await tester.enterText(input, '@ M2');
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await capture(
            tester,
            palette,
            'machines-${brightness.name}-${narrow ? 'narrow' : 'regular'}',
          );
          await tester.enterText(input, 'no-such-result-999999');
          await tester.pump(const Duration(milliseconds: 350));
          await tester.pumpAndSettle();
          expect(palette.search.rows, isEmpty);
          expect(find.text('No matching harnesses'), findsOneWidget);
          expect(tester.takeException(), isNull);
          await key(tester, LogicalKeyboardKey.enter);
          expect(palette.chosen, isEmpty);
        },
      );
    }
  }

  testWidgets('replacement resource controls release the old dispatcher', (
    tester,
  ) async {
    final palette = await mount(tester);
    await tester.enterText(input, '@ M2');
    await tester.pumpAndSettle();
    final replacement = SearchPreviewControls();
    addTearDown(replacement.dispose);
    await tester.pumpWidget(palette.widget(previewControls: replacement));
    await tester.pumpAndSettle();
    expect(palette.controls.dispatch, isNull);
    expect(palette.controls.commands, isNull);
    expect(replacement.dispatch, isNotNull);
    expect(replacement.invoke('picker.focus_actions'), isTrue);
    await tester.pumpAndSettle();
    expect(palette.search.managing, isTrue);
    expect(palette.closed, 0);
  });

  testWidgets('disposing an old preview preserves the new keyboard owner', (
    tester,
  ) async {
    final palette = await mount(tester);
    await tester.enterText(input, '@ M2');
    await tester.pumpAndSettle();
    await tester.pumpWidget(
      palette.widget(resourceKey: const ValueKey('new-preview')),
    );
    await tester.pumpAndSettle();
    expect(palette.controls.commands, isNotNull);
    expect(palette.controls.invoke('picker.focus_actions'), isTrue);
    await tester.pumpAndSettle();
    expect(palette.search.managing, isTrue);
    expect(palette.closed, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'reopened workspace palettes retain controls and Escape hierarchy',
    (tester) async {
      final app = await resources.fixture();
      final map = MemoryKeymap();
      var disposed = false;
      addTearDown(() {
        if (!disposed) app.dispose();
      });
      addTearDown(map.dispose);
      await configured.mount(tester, app, map);
      for (var cycle = 0; cycle < 3; cycle++) {
        await openHarnessPicker(tester);
        await tester.enterText(input, '@This Mac');
        await tester.pumpAndSettle();
        final search = resources.search(tester);
        await key(tester, LogicalKeyboardKey.enter);
        expect(search.managing, isTrue);
        await key(tester, LogicalKeyboardKey.arrowRight);
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.byType(MachinePickerForm), findsOneWidget);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.byType(MachinePickerForm), findsNothing);
        expect(search.managing, isTrue);
        await key(tester, LogicalKeyboardKey.escape);
        expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
        expect(search.managing, isFalse);

        await tester.enterText(input, ':deepseek');
        await tester.pumpAndSettle();
        final api = search.rows.indexWhere(
          (row) => row.modelId == 'model:api:deepseek-api',
        );
        expect(api, greaterThanOrEqualTo(0));
        search.move(api - search.cursor);
        await tester.pumpAndSettle();
        await resources.tabTo(
          tester,
          find.byKey(
            const ValueKey('resource-action:picker.resource_settings'),
          ),
        );
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.byType(ApiPickerForm), findsOneWidget);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.byType(ApiPickerForm), findsNothing);
        expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);

        await tester.enterText(input, 'Checkout retries');
        await tester.pumpAndSettle();
        expect(search.selected!.agentId, 'a0');
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(input, findsNothing);
        expect(app.actions, isEmpty);
        expect(tester.takeException(), isNull);
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      disposed = true;
    },
  );

  testWidgets(
    'replacement result controllers own paging and reveal selection',
    (tester) async {
      final app = createApp(connected: true);
      final first = SwarmSearchController(app, const [], adding: true);
      final second = SwarmSearchController(app, const [], adding: true);
      addTearDown(app.dispose);
      addTearDown(first.dispose);
      addTearDown(second.dispose);
      Future<void> show(SwarmSearchController search) => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DesktopChrome(
              child: SizedBox(
                width: 600,
                height: 300,
                child: SwarmSearchResults(
                  search: search,
                  showPreview: false,
                  onChoose: (_) {},
                  onRefocus: () {},
                ),
              ),
            ),
          ),
        ),
      );
      await show(first);
      await tester.pumpAndSettle();
      await show(second);
      await tester.pumpAndSettle();
      final starting = second.cursor;
      second.pageResults(1);
      await tester.pumpAndSettle();
      expect(second.cursor, greaterThan(starting));
      final selected = second.cursor;
      first.pageResults(1);
      await tester.pumpAndSettle();
      expect(second.cursor, selected);
      expect(tester.takeException(), isNull);
    },
  );
}
